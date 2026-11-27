import { ThinkingLevel } from '@google/genai';
import type { GenAI } from '../../src/server/gemini';
import { createArtist, buildArtistPrompt, ARTIST_TIMEOUT_MS, ARTIST_EXAMPLES, ARTIST_CACHE_MAX, ARTIST_SCHEMA } from '../../src/server/artist';
import { parseFigure, type SketchOrder } from '../../src/shared/script';

type Res = { text?: string; candidates?: { finishReason?: string }[]; promptFeedback?: { blockReason?: string }; usageMetadata?: Record<string, number> };
type Reply = Res | Error | 'hang';

const GOOD = {
  kind: 'figure', id: '아무거나', size: 'small', ink: 'black',
  strokes: [
    { d: 'M30 50 C30 39 39 30 50 30 C61 30 70 39 70 50 C70 61 61 70 50 70 C39 70 30 61 30 50 Z', ink: 'brown', fill: false },
    { d: 'M40 45 L42 45', ink: 'black', fill: false },
  ],
  labels: [{ x: 50, y: 92, text: '얼굴', ink: 'black' }],
};

const textReply = (text: string, finish = 'STOP'): Res => ({ text, candidates: [{ finishReason: finish }] });
const BLOCKED: Res = { promptFeedback: { blockReason: 'SAFETY' } };

function fakeClient(replies: Reply[]) {
  const calls: { params: Record<string, any> }[] = [];
  const client = {
    models: {
      generateContent(params: Record<string, any>) {
        calls.push({ params });
        const r = replies[Math.min(calls.length - 1, replies.length - 1)];
        const signal: AbortSignal | undefined = params.config?.abortSignal;
        if (r === 'hang') {
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve(r);
      },
      generateContentStream() { throw new Error('not used'); },
    },
  };
  return { client: client as unknown as GenAI, calls };
}

const sig = () => new AbortController().signal;
const order = (describe = '병사', size: 'small' | 'wide' = 'small'): SketchOrder => ({ id: '병사', size, describe });

afterEach(() => {
  delete process.env.ARTIST_MODEL;
});

test('정상 응답 → FigureOp(id는 주문 id)', async () => {
  const { client } = fakeClient([textReply(JSON.stringify(GOOD))]);
  const artist = createArtist({ client });
  const fig = await artist(order(), sig());
  expect(fig).toMatchObject({ kind: 'figure', id: '병사', size: 'small' });
  expect(fig!.strokes).toHaveLength(2);
});

test('요청 파라미터', async () => {
  const { client, calls } = fakeClient([textReply(JSON.stringify(GOOD))]);
  await createArtist({ client })(order('투구 쓴 병사', 'wide'), sig());
  expect(calls).toHaveLength(1);
  const { params } = calls[0];
  expect(params.model).toBe('gemini-3.8-flash');
  expect(params.config).toMatchObject({
    systemInstruction: buildArtistPrompt(),
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    maxOutputTokens: 8000,
    responseMimeType: 'application/json',
    responseJsonSchema: ARTIST_SCHEMA,
  });
  expect(params.config.abortSignal).toBeInstanceOf(AbortSignal);
  expect(params.contents).toHaveLength(1);
  expect(params.contents[0].role).toBe('user');
  expect(params.contents[0].parts[0].text).toContain('wide');
  expect(params.contents[0].parts[0].text).toContain('투구 쓴 병사');
});

test('ARTIST_MODEL 환경 변수/옵션이 model을 바꾼다', async () => {
  process.env.ARTIST_MODEL = 'gemini-4-hydrogen';
  const a = fakeClient([textReply(JSON.stringify(GOOD))]);
  await createArtist({ client: a.client })(order(), sig());
  expect(a.calls[0].params.model).toBe('gemini-4-hydrogen');

  const b = fakeClient([textReply(JSON.stringify(GOOD))]);
  await createArtist({ client: b.client, model: 'gemini-3.5-flash-lite' })(order(), sig());
  expect(b.calls[0].params.model).toBe('gemini-3.5-flash-lite');
});

const failures: [string, Reply][] = [
  ['잘못된 JSON', textReply('{"kind":"figure", 망가짐')],
  ['검증 실패 JSON', textReply(JSON.stringify({ ...GOOD, strokes: [{ d: 'M0 0 A5 5 0 0 1 10 10', ink: 'red', fill: false }] }))],
  ['안전 정책으로 막힘', BLOCKED],
  ['길이 한도에서 잘림', textReply(JSON.stringify(GOOD), 'MAX_TOKENS')],
  ['네트워크 오류', new Error('ECONNRESET')],
  ['시간 초과', 'hang'],
];
test.each(failures)('%s → null', async (_name, reply) => {
  const { client } = fakeClient([reply]);
  const errors: unknown[] = [];
  const artist = createArtist({ client, timeoutMs: 30, onError: (o, err) => errors.push([o.id, err]) });
  await expect(artist(order(), sig())).resolves.toBeNull();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toEqual(['병사', expect.anything()]);
});

test('onError에는 이유만(요청·키 없음)', async () => {
  const seen: unknown[] = [];
  const { client } = fakeClient([BLOCKED]);
  await createArtist({ client, onError: (_o, err) => seen.push(err) })(order(), sig());
  expect(seen).toHaveLength(1);
  expect(String(seen[0])).toContain('blocked');
  expect(JSON.stringify(seen[0])).not.toContain('contents');
});

test('성공하면 onError를 부르지 않음', async () => {
  const onError = vi.fn();
  const { client } = fakeClient([textReply(JSON.stringify(GOOD))]);
  await createArtist({ client, onError })(order(), sig());
  expect(onError).not.toHaveBeenCalled();
});

test('onUsage로 토큰 사용량(캐시 읽기 포함)을 알린다', async () => {
  const usage = { promptTokenCount: 6000, candidatesTokenCount: 900, cachedContentTokenCount: 5000, thoughtsTokenCount: 300 };
  const { client } = fakeClient([{ ...textReply(JSON.stringify(GOOD)), usageMetadata: usage }]);
  const seen: unknown[] = [];
  await createArtist({ client, onUsage: (o, u) => seen.push([o.id, u]) })(order(), sig());
  expect(seen).toEqual([['병사', usage]]);
});

test('답이 안전 정책으로 막히면 text가 있어도 null', async () => {
  const { client } = fakeClient([textReply(JSON.stringify(GOOD), 'SAFETY')]);
  await expect(createArtist({ client })(order(), sig())).resolves.toBeNull();
});

test('호출자 signal이 끊기면 null, 실패로 알리지 않음(수업이 멈춘 것)', async () => {
  const { client } = fakeClient(['hang']);
  const onError = vi.fn();
  const ac = new AbortController();
  const p = createArtist({ client, timeoutMs: 60_000, onError })(order(), ac.signal);
  ac.abort();
  await expect(p).resolves.toBeNull();
  expect(onError).not.toHaveBeenCalled();
});

test('시간 초과는 실패로 알린다(호출자 signal은 살아 있음)', async () => {
  const { client } = fakeClient(['hang']);
  const onError = vi.fn();
  await expect(createArtist({ client, timeoutMs: 20, onError })(order(), sig())).resolves.toBeNull();
  expect(onError).toHaveBeenCalledTimes(1);
});

test('모델이 준 id·size는 주문 것으로 바꾼 뒤 검증한다(빈 id, 다른 size도 통과)', async () => {
  const { id: _id, ...noId } = GOOD;
  for (const raw of [{ ...GOOD, id: '', size: 'wide' }, { ...noId, size: 'huge' }, { ...GOOD, id: 'x'.repeat(200) }]) {
    const { client } = fakeClient([textReply(JSON.stringify(raw))]);
    const onError = vi.fn();
    const fig = await createArtist({ client, onError })({ id: '병사', size: 'small', describe: '병사' }, sig());
    expect(fig).toMatchObject({ kind: 'figure', id: '병사', size: 'small' });
    expect(onError).not.toHaveBeenCalled();
  }
});

test('같은 주문은 캐시(호출 1번)', async () => {
  const { client, calls } = fakeClient([textReply(JSON.stringify(GOOD))]);
  const artist = createArtist({ client });
  const [a, b] = await Promise.all([artist(order('병사'), sig()), artist({ id: '다른id', size: 'small', describe: '병사' }, sig())]);
  expect(calls).toHaveLength(1);
  expect(a!.id).toBe('병사');
  expect(b!.id).toBe('다른id'); // 캐시를 써도 id는 그 주문의 것
  await artist(order('병사', 'wide'), sig()); // size가 다르면 다른 주문
  expect(calls).toHaveLength(2);
});

test(`캐시는 최대 ${200}개(가장 오래된 것부터 버림)`, async () => {
  expect(ARTIST_CACHE_MAX).toBe(200);
  const { client, calls } = fakeClient([textReply(JSON.stringify(GOOD))]);
  const artist = createArtist({ client });
  for (let i = 0; i <= ARTIST_CACHE_MAX; i++) await artist(order(`그림${i}`), sig()); // 201개
  expect(calls).toHaveLength(ARTIST_CACHE_MAX + 1);
  await artist(order(`그림${ARTIST_CACHE_MAX}`), sig()); // 최근 것은 캐시
  expect(calls).toHaveLength(ARTIST_CACHE_MAX + 1);
  await artist(order('그림0'), sig()); // 가장 오래된 것은 버려졌다
  expect(calls).toHaveLength(ARTIST_CACHE_MAX + 2);
});

test('null은 캐시하지 않음', async () => {
  const { client, calls } = fakeClient([new Error('일시 오류'), textReply(JSON.stringify(GOOD))]);
  const artist = createArtist({ client });
  expect(await artist(order(), sig())).toBeNull();
  expect(await artist(order(), sig())).not.toBeNull();
  expect(calls).toHaveLength(2);
});

test('시간 제한 기본값은 20초', () => {
  expect(ARTIST_TIMEOUT_MS).toBe(20_000);
});

test('프롬프트 예시 그림은 모두 parseFigure 통과', () => {
  expect(ARTIST_EXAMPLES.length).toBeGreaterThanOrEqual(3);
  const p = buildArtistPrompt();
  for (const ex of ARTIST_EXAMPLES) {
    const fig = parseFigure(ex.figure);
    expect(fig, ex.describe).not.toBeNull();
    // 꾸밈 없는 설명 그림: 너무 적지도(알아볼 수 있게), 너무 많지도(빨리 나오게) 않게
    expect(fig!.strokes.length).toBeGreaterThanOrEqual(6);
    expect(fig!.strokes.length).toBeLessThanOrEqual(20);
    expect(ex.figure.labels).not.toEqual([]); // 핵심 낱말 이름표가 있다
    const colors = new Set(fig!.strokes.map((s) => (typeof s === 'string' ? fig!.ink : s.ink ?? fig!.ink)));
    expect(colors.size).toBeGreaterThanOrEqual(3);
    expect(p).toContain(JSON.stringify(ex.figure));
    expect(p).toContain(ex.describe);
  }
});

test('프롬프트에 핵심 규칙', () => {
  const p = buildArtistPrompt();
  for (const k of ['설명 그림', '화살표', '나란히 비교', '순서', 'fill', '획은 40개 이하', '죽은 몸', '무서운 표정']) expect(p).toContain(k);
});

// QA 2026-11-22: 같은 주문을 함께 기다리던 다른 수업이, 먼저 부른 수업이 끊기면(끼어들기) 함께 null을 받았다.
// 고친 뒤: 작업은 기다리는 호출자가 한 명이라도 남으면 계속 그리고(다시 부르지 않음), 모두 끊기면 그때 끊는다.
function deferredClient() {
  const calls: AbortSignal[] = [];
  let answer!: (r: Res) => void;
  const client = {
    models: {
      generateContent(params: Record<string, any>) {
        const signal: AbortSignal = params.config.abortSignal;
        calls.push(signal);
        return new Promise((res, rej) => {
          answer = res;
          signal.addEventListener('abort', () => rej(new Error('aborted')));
        });
      },
      generateContentStream() { throw new Error('not used'); },
    },
  };
  return { client: client as unknown as GenAI, calls, answer: (r: Res) => answer(r) };
}
test('같은 주문을 함께 기다리던 호출자는, 먼저 부른 호출자가 끊겨도 그 그림을 받는다(다시 부르지 않음)', async () => {
  const { client, calls, answer } = deferredClient();
  const onError = vi.fn();
  const artist = createArtist({ client, timeoutMs: 60_000, onError });
  const first = new AbortController();
  const p1 = artist(order('병사'), first.signal);
  const p2 = artist({ id: '두번째', size: 'small', describe: '병사' }, sig());
  first.abort();
  await expect(p1).resolves.toBeNull();
  expect(calls[0].aborted).toBe(false); // 두 번째가 기다리니 그리기는 계속
  answer(textReply(JSON.stringify(GOOD)));
  await expect(p2).resolves.toMatchObject({ id: '두번째' });
  expect(calls).toHaveLength(1);
  expect(onError).not.toHaveBeenCalled();
});
test('함께 기다리던 호출자가 모두 끊기면 그리기를 끊고, 다음 호출은 새로 그린다', async () => {
  const { client, calls } = fakeClient(['hang', textReply(JSON.stringify(GOOD))]);
  const onError = vi.fn();
  const artist = createArtist({ client, timeoutMs: 60_000, onError });
  const a = new AbortController(), b = new AbortController();
  const p1 = artist(order('병사'), a.signal);
  const p2 = artist(order('병사'), b.signal);
  a.abort();
  expect(calls[0].params.config.abortSignal.aborted).toBe(false);
  b.abort();
  expect(calls[0].params.config.abortSignal.aborted).toBe(true); // 아무도 안 기다리면 비용을 멈춘다
  await expect(p1).resolves.toBeNull();
  await expect(p2).resolves.toBeNull();
  expect(calls).toHaveLength(1);
  expect(onError).not.toHaveBeenCalled();
  await expect(artist(order('병사'), sig())).resolves.toMatchObject({ id: '병사' }); // 끊긴 작업에 붙지 않는다
  expect(calls).toHaveLength(2);
});
test('이미 끊긴 signal로 부르면 모델을 부르지 않는다', async () => {
  const { client, calls } = fakeClient([textReply(JSON.stringify(GOOD))]);
  const ac = new AbortController();
  ac.abort();
  await expect(createArtist({ client })(order(), ac.signal)).resolves.toBeNull();
  expect(calls).toHaveLength(0);
});
test('캐시된 그림을 받은 뒤 그 호출자 signal이 끊겨도 캐시는 남는다', async () => {
  const { client, calls } = fakeClient([textReply(JSON.stringify(GOOD))]);
  const artist = createArtist({ client });
  const ac = new AbortController();
  await artist(order(), ac.signal);
  ac.abort();
  await artist(order(), sig());
  expect(calls).toHaveLength(1);
});

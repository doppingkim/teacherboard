import { ThinkingLevel } from '@google/genai';
import type { GenAI } from '../../src/server/gemini';
import { geminiAsk, classifyUtterance, quickVerdict, resemblingSpoken, type ClassifyInput } from '../../src/server/classify';

const inp = (text: string, over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  text, profile: 'kid', lessonActive: false, recentSpoken: [], ...over,
});

function clientWith(res: unknown, calls: Record<string, any>[] = []): GenAI {
  return { models: { generateContent: async (p: Record<string, unknown>) => { calls.push(p); return res; }, generateContentStream: async () => { throw new Error('not used'); } } } as unknown as GenAI;
}
const textRes = (text: string, finish = 'STOP') => ({ text, candidates: [{ finishReason: finish }] });
const sig = () => new AbortController().signal;

test.each(['우와!', '대박', 'ㅋㅋㅋㅋ', '와아', 'ㅎㅎ', '멋지다', '우와아', 'ㅋㅋㅎㅎ', '음...', '헐', '오', '네'])('%s → exclaim 거절', (t) => {
  expect(quickVerdict(inp(t))).toMatchObject({ accept: false, reason: 'exclaim', complete: true });
});
test.each(['왜?', '뭐?', '다시'])('%s → 모델로 넘김(null)', (t) => expect(quickVerdict(inp(t))).toBeNull());
test('다른 문장은 메아리가 아니다', () =>
  expect(quickVerdict(inp('달은 왜 따라와?', { recentSpoken: ['태양은 아주 뜨거운 가스 덩어리야.'] }))).toBeNull());
test('빈 말', () => expect(quickVerdict(inp(' . '))).toMatchObject({ accept: false, reason: 'empty', complete: true }));
test('선생님 말 메아리', () =>
  expect(quickVerdict(inp('달은 너무 멀어서 거의 안 움직이는 것처럼 보여', { recentSpoken: ['달은 너무너무 멀어서, 거의 안 움직이는 것처럼 보여.'] }))).toMatchObject({ accept: false, reason: 'echo', complete: true }));
test('규칙에 안 걸리면 null', () => expect(quickVerdict(inp('근데 왜?'))).toBeNull());

describe('메아리 규칙(선생님 말과 비슷한가)', () => {
  const teacher = '달이 지구 주위를 돌아요';
  test('선생님 말에 질문을 붙인 것은 메아리가 아니다 → 모델로', () => {
    expect(quickVerdict(inp('왜 달이 지구 주위를 돌아?', { recentSpoken: [teacher] }))).toBeNull();
    expect(resemblingSpoken(inp('왜 달이 지구 주위를 돌아?', { recentSpoken: [teacher] }))).toBe(teacher);
  });
  test('거의 같은 말(Dice ≥ 0.85)은 메아리', () =>
    expect(quickVerdict(inp('달이 지구 주위를 돌아요.', { recentSpoken: [teacher] }))).toMatchObject({ accept: false, reason: 'echo', complete: true }));
  test('선생님 말 안에 들어 있는 조각(4자 이상)은 메아리', () =>
    expect(quickVerdict(inp('지구 주위를', { recentSpoken: [teacher] }))).toMatchObject({ reason: 'echo', complete: true }));
  test('3자 이하 조각은 포함 규칙으로 거르지 않는다', () =>
    expect(quickVerdict(inp('돌아?', { recentSpoken: [teacher] }))).toBeNull());
  test('어느 정도 비슷하면(0.6~0.85) 모델에게 선생님 말을 함께 보낸다', async () => {
    const seen: ClassifyInput[] = [];
    const v = await classifyUtterance(inp('달이 지구 주위를 빨리 돌아', { recentSpoken: ['안녕', teacher] }), async (i) => {
      seen.push(i);
      return { isQuestion: false, question: '' };
    });
    expect(v.reason).toBe('model');
    expect(seen[0].resembles).toBe(teacher);
  });
  test('비슷하지 않으면 resembles 없이 모델로', async () => {
    const seen: ClassifyInput[] = [];
    await classifyUtterance(inp('하늘은 왜 파래?', { recentSpoken: [teacher] }), async (i) => {
      seen.push(i);
      return { isQuestion: true, question: 'x' };
    });
    expect(seen[0].resembles).toBeUndefined();
  });
  test('채움 문장(FILLER_TEXTS)도 메아리 비교에 넣는다', () => {
    expect(quickVerdict(inp('좋은 질문이야'))).toMatchObject({ reason: 'echo', complete: true });
    expect(quickVerdict(inp('오 그거 궁금했구나'))).toMatchObject({ reason: 'echo', complete: true });
  });
});

describe('모델 실패 시(수업 밖) 질문·요청처럼 보일 때만 받는다', () => {
  const bad = async () => { throw new Error('boom'); };
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());
  test.each(['하늘은 왜 파래', '공룡 그림 그려 줘', '화산 설명해 줄래', '별 보여 줘', '달은 무엇으로 돼 있어', '바다는 얼마나 깊어', '지구 궁금해', '이거 알려', '달 따라와?'])('%s → 수락', async (t) =>
    expect(await classifyUtterance(inp(t), bad)).toMatchObject({ accept: true, reason: 'fallback', complete: true }));
  test.each(['저리 가', '형 나빠', '밥 먹자'])('%s → 거절', async (t) =>
    expect(await classifyUtterance(inp(t), bad)).toEqual({ accept: false, question: '', reason: 'fallback', complete: true }));
});

test('geminiAsk: resembles가 있으면 <teacher>로 감싸 함께 보낸다', async () => {
  const calls: Record<string, unknown>[] = [];
  const client = clientWith(textRes('{"isQuestion":false,"question":""}'), calls);
  await geminiAsk(client)({ ...inp('달이 지구 주위를 빨리 돌아', { recentSpoken: ['달이 지구 주위를 돌아요'] }), resembles: '달이 지구 주위를 돌아요' }, new AbortController().signal);
  const content = JSON.stringify(calls[0].contents);
  expect(content).toContain('<teacher>달이 지구 주위를 돌아요</teacher>');
  await geminiAsk(client)(inp('근데 왜?'), new AbortController().signal);
  expect(JSON.stringify(calls[1].contents)).not.toContain('<teacher>');
});
test('모델 결과 사용', async () =>
  expect(await classifyUtterance(inp('근데 왜?'), async () => ({ isQuestion: true, question: '근데 왜?' }))).toEqual({ accept: true, question: '근데 왜?', reason: 'model', complete: true }));
test('모델이 아니라고 하면 거절', async () =>
  expect(await classifyUtterance(inp('저리 가'), async () => ({ isQuestion: false, question: '' }))).toMatchObject({ accept: false, reason: 'model', complete: true }));
test('규칙에서 걸리면 모델을 부르지 않는다', async () => {
  let called = false;
  const v = await classifyUtterance(inp('우와'), async () => { called = true; return { isQuestion: true, question: 'x' }; });
  expect(v.reason).toBe('exclaim');
  expect(called).toBe(false);
});
test('모델 실패: 수업 중이면 거절, 아니면 수락', async () => {
  const bad = async () => { throw new Error('boom'); };
  expect(await classifyUtterance(inp('근데 왜?', { lessonActive: true }), bad)).toEqual({ accept: false, question: '', reason: 'fallback', complete: true });
  expect(await classifyUtterance(inp('근데 왜?'), bad)).toEqual({ accept: true, question: '근데 왜?', reason: 'fallback', complete: true });
});
test('시간 초과도 fallback', async () => {
  const hang = (_i: ClassifyInput, signal: AbortSignal) => new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  expect(await classifyUtterance(inp('근데 왜?'), hang, 20)).toMatchObject({ accept: true, reason: 'fallback', complete: true });
});
test('시간 초과: 신호를 받지 않는 ask도 끝난다', async () => {
  expect(await classifyUtterance(inp('근데 왜?', { lessonActive: true }), () => new Promise(() => {}), 20)).toMatchObject({ accept: false, reason: 'fallback', complete: true });
});
test('바깥 signal이 abort되면 모델 호출도 abort되고 곧바로 끝난다(신호를 무시하는 ask라도)', async () => {
  const ac = new AbortController();
  let seen: AbortSignal | undefined;
  const p = classifyUtterance(inp('근데 왜?', { lessonActive: true }), (_i, s) => { seen = s; return new Promise(() => {}); }, 60_000, ac.signal);
  ac.abort();
  expect(await p).toEqual({ accept: false, question: '', reason: 'fallback', complete: true });
  expect(seen?.aborted).toBe(true);
});
test('이미 abort된 signal이면 모델을 부르지 않는다', async () => {
  const ac = new AbortController();
  ac.abort();
  const ask = vi.fn(async () => ({ isQuestion: true, question: 'x' }));
  expect(await classifyUtterance(inp('근데 왜?', { lessonActive: true }), ask, 6000, ac.signal)).toMatchObject({ reason: 'fallback', complete: true });
  expect(ask).not.toHaveBeenCalled();
});

test('geminiAsk 요청 모양', async () => {
  const calls: Record<string, any>[] = [];
  const client = clientWith(textRes('{"isQuestion":true,"question":"달은 왜 따라와?"}'), calls);
  const signal = new AbortController().signal;
  const out = await geminiAsk(client)(inp('달은 왜 따라와', { lessonActive: true, recentSpoken: ['안녕'] }), signal);
  expect(out).toEqual({ isQuestion: true, question: '달은 왜 따라와?', complete: true }); // complete가 빠지면 끝난 말
  const p = calls[0];
  expect(p.config.responseJsonSchema.required).toEqual(['isQuestion', 'question', 'complete']);
  // 소리가 비슷한 오인식을 고쳐 적고, 덜 끝난 말을 알려 달라고 한다
  expect(String(p.config.systemInstruction)).toContain('허리디스크');
  expect(String(p.config.systemInstruction)).toContain('complete');
  expect(p.model).toBe('gemini-3.5-flash-lite');
  expect(p.config).toMatchObject({ thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, maxOutputTokens: 1024, responseMimeType: 'application/json', abortSignal: signal });
});

test.each([
  ['깨진 JSON', textRes('{oops')],
  ['필드 없음', textRes('{"isQuestion":true}')],
  ['타입 틀림', textRes('{"isQuestion":"yes","question":"x"}')],
  ['안전 정책으로 막힘', textRes('{"isQuestion":true,"question":"x"}', 'SAFETY')],
  ['잘림', textRes('{"isQuestion":true,"questi', 'MAX_TOKENS')],
])('geminiAsk %s → 던지고 classify는 fallback', async (_n, res) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ask = geminiAsk(clientWith(res));
  await expect(ask(inp('근데 왜?'), sig())).rejects.toThrow();
  expect(await classifyUtterance(inp('근데 왜?', { lessonActive: true }), ask)).toEqual({ accept: false, question: '', reason: 'fallback', complete: true });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).not.toContain('근데');
  warn.mockRestore();
});

test('geminiAsk: complete false를 그대로 넘긴다', async () => {
  const ask = geminiAsk(clientWith(textRes('{"isQuestion":false,"question":"허리디스크가 왜","complete":false}')));
  expect(await ask(inp('퀄리디스크가 왜'), sig())).toEqual({ isQuestion: false, question: '허리디스크가 왜', complete: false });
});

test('모델이 덜 끝났다고 하면 complete false(판정은 지금까지 들은 말로)', async () => {
  expect(await classifyUtterance(inp('그런데 공룡은'), async () => ({ isQuestion: false, question: '', complete: false }))).toEqual({
    accept: false, question: '', reason: 'model', complete: false,
  });
  expect(await classifyUtterance(inp('퀄리디스크가 뭐야'), async () => ({ isQuestion: true, question: '허리디스크가 뭐야', complete: true }))).toEqual({
    accept: true, question: '허리디스크가 뭐야', reason: 'model', complete: true,
  });
});

test('isQuestion true + 빈 question → 원문', async () =>
  expect(await classifyUtterance(inp('  근데 왜?  '), async () => ({ isQuestion: true, question: '' }))).toEqual({ accept: true, question: '근데 왜?', reason: 'model', complete: true }));

test('시간 초과 후 signal이 abort된다', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let seen: AbortSignal | undefined;
  await classifyUtterance(inp('근데 왜?'), (_i, s) => { seen = s; return new Promise(() => {}); }, 20);
  expect(seen?.aborted).toBe(true);
  warn.mockRestore();
});

test('기본 모델과 CLASSIFY_MODEL·CLASSIFY_THINKING 덮어쓰기', async () => {
  const calls: Record<string, any>[] = [];
  const ask = geminiAsk(clientWith(textRes('{"isQuestion":true,"question":"a"}'), calls));
  await ask(inp('근데 왜?'), sig());
  process.env.CLASSIFY_MODEL = 'test-model';
  process.env.CLASSIFY_THINKING = 'minimal';
  await ask(inp('근데 왜?'), sig());
  delete process.env.CLASSIFY_MODEL;
  delete process.env.CLASSIFY_THINKING;
  expect(calls[0].model).toBe('gemini-3.5-flash-lite');
  expect(calls[1].model).toBe('test-model');
  expect(calls[1].config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
  expect(JSON.stringify(calls[0].contents)).toContain('<heard>근데 왜?</heard>');
});

test('기본 timeout은 6000ms', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const p = classifyUtterance(inp('근데 왜?'), () => new Promise(() => {}));
  let done = false;
  void p.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(5999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect((await p).reason).toBe('fallback');
  vi.useRealTimers();
  warn.mockRestore();
});

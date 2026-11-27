// 기기 쪽 계측(H1 오류 보고·G1 체감 시간): 묶어 보내기, 같은 오류 폭주 묶기, 크기 한도, 개인정보 없음, 대리 객체.
import { CLIENT_LOG_MAX_BYTES, CLIENT_LOG_MAX_EVENTS, questionKey } from '../../src/shared/clientLog';
import { CLIENT_LOG_PER_SEC } from '../../src/server/telemetry';
import { streamLesson } from '../../src/web/player/lessonClient';
import {
  ClientReporter,
  describeError,
  FLUSH_MS,
  installErrorReporting,
  LessonTimer,
  MAX_ERROR_REPORTS,
  MAX_SENDS_PER_FLUSH,
  REPEAT_MS,
  tapMethod,
  tapStreamError,
  uaSummary,
} from '../../src/web/telemetry';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(over: { state?: () => string } = {}) {
  const sent: { events: Record<string, unknown>[] }[] = [];
  const bodies: string[] = [];
  const r = new ClientReporter({
    send: (b) => { bodies.push(b); sent.push(JSON.parse(b)); },
    now: () => Date.now(),
    ua: 'iPad Safari 18',
    ...over,
  });
  return { r, sent, bodies };
}

test('uaSummary: 기기·브라우저·주 버전만(iPadOS의 Mac UA도 iPad로)', () => {
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';
  expect(uaSummary(ipad, 5)).toBe('iPad Safari 18');
  expect(uaSummary(ipad, 0)).toBe('Mac Safari 18');
  expect(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe('Windows Chrome 140');
  expect(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/139.0 Mobile/15E148 Safari/604.1')).toBe('iPhone Chrome 139');
  expect(uaSummary('weird')).toBe('Other Other');
});

test('오류는 FLUSH_MS 동안 모아 한 번에, 같은 오류는 count로 묶는다(화면 상태·UA 요약 포함)', async () => {
  const { r, sent } = setup({ state: () => 'lesson' });
  const e = new TypeError('x is undefined');
  for (let i = 0; i < 50; i++) r.error('error', e);
  r.error('rejection', 'Load failed');
  expect(sent).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(FLUSH_MS);
  expect(sent).toHaveLength(1);
  expect(sent[0].events).toEqual([
    expect.objectContaining({ kind: 'error', message: 'TypeError: x is undefined', count: 50, state: 'lesson', ua: 'iPad Safari 18', stack: expect.any(String) }),
    { kind: 'rejection', message: 'Load failed', count: 1, state: 'lesson', ua: 'iPad Safari 18' },
  ]);
});

test('같은 오류는 REPEAT_MS에 한 번만 보내고, 그 사이 난 것은 다음 번에 count로', async () => {
  const { r, sent } = setup();
  r.error('app', 'listen link error', 'listen');
  await vi.advanceTimersByTimeAsync(FLUSH_MS);
  for (let i = 0; i < 7; i++) r.error('app', 'listen link error', 'listen');
  await vi.advanceTimersByTimeAsync(REPEAT_MS / 2);
  expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(REPEAT_MS);
  expect(sent).toHaveLength(2);
  expect(sent[1].events).toEqual([expect.objectContaining({ kind: 'app', where: 'listen', message: 'listen link error', count: 7 })]);
});

test('끝없이 나는 서로 다른 오류도 한 페이지에서 MAX_ERROR_REPORTS건까지만', async () => {
  const { r, sent } = setup();
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 40; i++) r.error('error', `boom ${round}-${i}`);
    await vi.advanceTimersByTimeAsync(REPEAT_MS + FLUSH_MS);
  }
  const total = sent.reduce((n, b) => n + b.events.length, 0);
  expect(total).toBeLessThanOrEqual(MAX_ERROR_REPORTS);
  for (const b of sent) expect(b.events.length).toBeLessThanOrEqual(CLIENT_LOG_MAX_EVENTS);
});

test('본문은 CLIENT_LOG_MAX_BYTES를 넘지 않는다(긴 한글 문구·스택)', async () => {
  const { r, bodies } = setup();
  for (let i = 0; i < 8; i++) {
    const e = new Error(`${i}가`.repeat(150));
    e.stack = `Error\n${'    at 함수 (main.ts:1:2)\n'.repeat(60)}`;
    r.error('error', e);
  }
  await vi.advanceTimersByTimeAsync(FLUSH_MS);
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) expect(new TextEncoder().encode(b).length).toBeLessThanOrEqual(CLIENT_LOG_MAX_BYTES);
  expect(bodies.reduce((n, b) => n + JSON.parse(b).events.length, 0)).toBe(8);
});

test('LessonTimer: 물어본 때부터 첫 소리·첫 획·끝(ms). 질문은 글자 수와 맞춤 열쇠만', () => {
  let now = 1000;
  const t = new LessonTimer('  달은 왜 나를 따라와?  ', 'quick', true, () => now);
  now = 3200;
  t.sound();
  now = 3500;
  t.stroke();
  now = 4000;
  t.sound();
  t.stroke();
  now = 21000;
  const ev = t.finish('done');
  expect(ev).toEqual({
    kind: 'lesson', qKey: questionKey('달은 왜 나를 따라와?'), qChars: 12, mode: 'quick', spoken: true,
    firstSoundMs: 2200, firstStrokeMs: 2500, endMs: 20000, result: 'done',
  });
  expect(JSON.stringify(ev)).not.toContain('달');
  expect(t.finish('done')).toBeNull();
  const silent = new LessonTimer('q', 'deep', false, () => now);
  expect(silent.finish('aborted')).toMatchObject({ firstSoundMs: null, firstStrokeMs: null, endMs: 0, result: 'aborted' });
});

test('한꺼번에 많이 모여도 한 번에 MAX_SENDS_PER_FLUSH 묶음까지만 보내고 나머지는 1초 뒤에(서버 초당 한도 안)', async () => {
  const { r, sent } = setup();
  for (let i = 0; i < 49; i++) r.error('error', `boom ${i}`);
  for (let i = 0; i < 30; i++) r.lesson(new LessonTimer(`q${i}`, 'quick', false, () => 0).finish('done')!);
  await vi.advanceTimersByTimeAsync(FLUSH_MS);
  expect(sent).toHaveLength(MAX_SENDS_PER_FLUSH);
  expect(MAX_SENDS_PER_FLUSH).toBeLessThan(CLIENT_LOG_PER_SEC);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent).toHaveLength(MAX_SENDS_PER_FLUSH * 2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(sent.reduce((n, b) => n + b.events.length, 0)).toBe(79); // 하나도 잃지 않는다
});

test('계측이 고장 나도(시계가 던짐) lesson()·error()는 던지지 않는다 — 수업 끝 화면을 막지 않게', () => {
  let boom = false;
  const r = new ClientReporter({ send: () => {}, now: () => { if (boom) throw new Error('clock'); return 0; } });
  const ev = new LessonTimer('q', 'quick', false, () => 0).finish('done')!;
  boom = true;
  expect(() => r.lesson(ev)).not.toThrow();
  expect(() => r.error('app', new Error('x'), 'lesson')).not.toThrow();
});

test('수업 체감 시간도 묶어 보낸다', async () => {
  const { r, sent } = setup();
  const t = new LessonTimer('q', 'quick', false, () => 0);
  r.lesson(t.finish('error')!);
  await vi.advanceTimersByTimeAsync(FLUSH_MS);
  expect(sent[0].events).toEqual([expect.objectContaining({ kind: 'lesson', result: 'error', ua: 'iPad Safari 18' })]);
});

test('tapMethod: 고른 메서드 직전에만 알리고, this·반환값·다른 메서드는 원래 객체 그대로', async () => {
  class Board {
    drawn = 0;
    async draw(n: number) { this.drawn += n; return 'ok'; }
    clear() { this.drawn = 0; }
  }
  const b = new Board();
  const hits: string[] = [];
  const t = tapMethod(b, 'draw', () => hits.push('draw'));
  expect(await t.draw(2)).toBe('ok');
  t.clear();
  await t.draw(3);
  expect(hits).toEqual(['draw', 'draw']);
  expect(b.drawn).toBe(3);
  const boom = tapMethod(b, 'draw', () => { throw new Error('x'); });
  await expect(boom.draw(1)).resolves.toBe('ok'); // 계측 오류는 삼킨다
});

test('tapStreamError: 흘리면서 던진 오류를 알리고 다시 던진다', async () => {
  async function* src() { yield 1; throw new TypeError('Load failed'); }
  const seen: unknown[] = [];
  const out: number[] = [];
  await expect((async () => { for await (const v of tapStreamError(src(), (e) => seen.push(e))) out.push(v); })()).rejects.toThrow('Load failed');
  expect(out).toEqual([1]);
  expect(seen).toEqual([expect.any(TypeError)]);
});

test('installErrorReporting: window error·unhandledrejection을 받고, 숨겨지면 바로 보낸다', async () => {
  const { r, sent } = setup();
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  installErrorReporting(win, doc, r);
  win.dispatchEvent(Object.assign(new Event('error'), { error: new RangeError('bad'), message: 'bad' }));
  win.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.', filename: 'https://x.app/a.js?token=abc', lineno: 3, colno: 4 }));
  win.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: { message: 'no' } }));
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(sent).toHaveLength(1);
  expect(sent[0].events.map((e) => [e.kind, e.message])).toEqual([
    ['error', 'RangeError: bad'],
    ['error', 'Script error. (https://x.app/a.js:3:4)'],
    ['rejection', 'no'],
  ]);
});

test('describeError: Error는 이름·문구·스택, 그 밖은 문자열로', () => {
  expect(describeError(new Error('a'))).toMatchObject({ message: 'Error: a', stack: expect.any(String) });
  expect(describeError(42)).toEqual({ message: '[object Number]' });
});

describe('수업 id 잇기(x-lesson-id)', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('streamLesson: 응답 머리글 x-lesson-id를 onLessonId로 알린다(없거나 실패 응답이면 부르지 않는다)', async () => {
    vi.useRealTimers();
    const body = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"done"}\n')); c.close(); } });
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body(), { status: 200, headers: { 'x-lesson-id': 'Ab3_-xYz' } })));
    for await (const _m of streamLesson('q', 'kid', new AbortController().signal, undefined, undefined, 'quick', undefined, (id) => ids.push(id)));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body(), { status: 200 })));
    for await (const _m of streamLesson('q', 'kid', new AbortController().signal, undefined, undefined, 'quick', undefined, (id) => ids.push(id)));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body(), { status: 200, headers: { 'x-lesson-id': 'Ab3_-xYz' } })));
    for await (const _m of streamLesson('q', 'kid', new AbortController().signal, undefined, undefined, 'quick', undefined, () => { throw new Error('x'); })); // 콜백 오류는 수업을 깨지 않는다
    expect(ids).toEqual(['Ab3_-xYz']);
  });

  test('LessonTimer: 서버가 준 수업 id를 알면 사건에 싣는다(qKey는 대비용으로 함께)', () => {
    const t = new LessonTimer('q', 'quick', false, () => 0);
    t.lessonId('Ab3_-xYz');
    expect(t.finish('done')).toMatchObject({ lessonId: 'Ab3_-xYz', qKey: questionKey('q') });
    const u = new LessonTimer('q', 'quick', false, () => 0);
    u.lessonId('not valid!');
    expect(u.finish('done')).not.toHaveProperty('lessonId');
  });
});

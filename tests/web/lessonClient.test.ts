import { afterEach, describe, test, expect, vi } from 'vitest';
import { readNdjson, streamLesson, watchServerError } from '../../src/web/player/lessonClient';
import type { LessonMessage } from '../../src/shared/lesson';

const enc = new TextEncoder();
const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } });

describe('readNdjson', () => {
  test('조각난 NDJSON을 객체로', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('{"type":"pa')); c.enqueue(enc.encode('ge"}\n{"type":"done"}\n')); c.close(); } });
    const out = []; for await (const m of readNdjson(body)) out.push(m);
    expect(out).toEqual([{ type: 'page' }, { type: 'done' }]);
  });

  test('마지막 줄에 줄바꿈이 없어도, 빈 줄·CRLF·깨진 줄이 섞여도 읽는다', async () => {
    const out: unknown[] = [];
    for await (const m of readNdjson(streamOf('{"a":1}\r\n\n{broken\n', '{"b":"한글"}'))) out.push(m);
    expect(out).toEqual([{ a: 1 }, { b: '한글' }]);
  });

  test('여러 바이트 글자가 조각 경계에서 잘려도 깨지지 않는다', async () => {
    const bytes = enc.encode('{"t":"달"}\n');
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, 7)); c.enqueue(bytes.slice(7)); c.close(); } });
    const out: unknown[] = [];
    for await (const m of readNdjson(body)) out.push(m);
    expect(out).toEqual([{ t: '달' }]);
  });
});

describe('streamLesson', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('질문과 프로필을 POST하고 메시지를 차례로 내보낸다', async () => {
    const fetchMock = vi.fn(async () => new Response(streamOf('{"type":"page"}\n{"type":"done"}\n'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out: unknown[] = [];
    for await (const m of streamLesson('달은 왜 나를 따라와?', 'kid', new AbortController().signal)) out.push(m);
    expect(out).toEqual([{ type: 'page' }, { type: 'done' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lesson');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ question: '달은 왜 나를 따라와?', profile: 'kid', mode: 'quick' });
  });

  test('끼어들기 문맥이 있으면 context로 함께 보낸다', async () => {
    const fetchMock = vi.fn(async () => new Response(streamOf('{"type":"done"}\n'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const context = { previousQuestion: '달은 왜 나를 따라와?', spoken: ['달은 아주 멀리 있어요.'] };
    for await (const _ of streamLesson('그럼 해는?', 'kid', new AbortController().signal, context)) { /* 흘려보내기 */ }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ question: '그럼 해는?', profile: 'kid', mode: 'quick', context });
  });

  test('heard(말로 물음)는 있을 때만 보낸다', async () => {
    const f = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', f);
    for await (const _ of streamLesson('허리디스크가 뭐야?', 'kid', new AbortController().signal, undefined, '퀄리디스크가 뭐야')) { /* 흘려보내기 */ }
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ question: '허리디스크가 뭐야?', profile: 'kid', mode: 'quick', heard: '퀄리디스크가 뭐야' });
    vi.unstubAllGlobals();
  });

  test('문맥이 없으면 context 키 자체를 보내지 않는다(null이면 서버가 400)', async () => {
    const fetchMock = vi.fn(async () => new Response(streamOf('{"type":"done"}\n'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for await (const _ of streamLesson('질문', 'kid', new AbortController().signal, undefined)) { /* 흘려보내기 */ }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(['question', 'profile', 'mode']);
  });

  test('요청은 읽기 전에 바로 시작한다', () => {
    const fetchMock = vi.fn(async () => new Response(streamOf(''), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    streamLesson('질문', 'adult', new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('응답이 실패면 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', { status: 400 })));
    const it = streamLesson('', 'kid', new AbortController().signal)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow();
  });
});

describe('watchServerError', () => {
  async function* src(...m: LessonMessage[]) { for (const x of m) yield x; }
  test('메시지를 그대로 흘리면서 서버 error 문구를 알린다', async () => {
    const seen: string[] = [];
    const out: LessonMessage[] = [];
    for await (const m of watchServerError(src({ type: 'page' }, { type: 'error', message: '이 질문은 수업으로 만들 수 없어요.' }), (t) => seen.push(t))) out.push(m);
    expect(out).toEqual([{ type: 'page' }, { type: 'error', message: '이 질문은 수업으로 만들 수 없어요.' }]);
    expect(seen).toEqual(['이 질문은 수업으로 만들 수 없어요.']);
  });
  test('빈 문구나 문자열이 아닌 문구는 알리지 않는다', async () => {
    const seen: string[] = [];
    const bad = [{ type: 'error', message: '  ' }, { type: 'error', message: 3 }, { type: 'error' }] as unknown as LessonMessage[];
    for await (const _ of watchServerError(src(...bad), (t) => seen.push(t))) { /* 흘려보내기 */ }
    expect(seen).toEqual([]);
  });
});

test('신중한 선생님(deep)이면 mode: deep으로 보낸다', async () => {
  const f = vi.fn(async () => new Response('{"type":"done"}\n', { status: 200 }));
  vi.stubGlobal('fetch', f);
  for await (const _ of streamLesson('번개는 왜 쳐?', 'adult', new AbortController().signal, undefined, undefined, 'deep')) { /* 다 읽기 */ }
  const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({ question: '번개는 왜 쳐?', profile: 'adult', mode: 'deep' });
});

test('설명 수준을 주면 level로 보낸다', async () => {
  const f = vi.fn(async () => new Response('{"type":"done"}'+String.fromCharCode(10), { status: 200 }));
  vi.stubGlobal('fetch', f);
  for await (const _ of streamLesson('q', 'kid', new AbortController().signal, undefined, undefined, 'quick', 'middle')) { /* 다 읽기 */ }
  const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({ question: 'q', profile: 'kid', mode: 'quick', level: 'middle' });
});

describe('streamLesson 멈춤 감시', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  /** 브라우저처럼: 요청 신호가 끊기면 fetch는 거부하고, 이미 받은 본문은 오류로 끝난다. */
  const abortable = (chunks: string[] | null) =>
    vi.fn((_url: string, init: RequestInit) => {
      const sig = init.signal!;
      if (chunks === null) {
        return new Promise<Response>((_, rej) => sig.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const s of chunks) c.enqueue(enc.encode(s));
          sig.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

  test('서버가 응답 머리도 안 보내고 멈추면 LESSON_IDLE_MS 뒤 오류로 끝난다(생각 중 카드가 끝없이 남지 않게)', async () => {
    const { LESSON_IDLE_MS } = await import('../../src/web/player/lessonClient');
    vi.useFakeTimers();
    const f = abortable(null);
    vi.stubGlobal('fetch', f);
    const it = streamLesson('q', 'kid', new AbortController().signal)[Symbol.asyncIterator]();
    const next = it.next();
    let settled = false;
    next.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(LESSON_IDLE_MS - 1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(next).rejects.toThrow();
  });

  test('수업 도중 스트림이 멈추면(다음 줄이 안 옴) 받은 것까지 내보낸 뒤 오류로 끝난다', async () => {
    const { LESSON_IDLE_MS } = await import('../../src/web/player/lessonClient');
    vi.useFakeTimers();
    vi.stubGlobal('fetch', abortable(['{"type":"page"}\n']));
    const it = streamLesson('q', 'kid', new AbortController().signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: 'page' });
    const next = it.next();
    next.catch(() => {});
    await vi.advanceTimersByTimeAsync(LESSON_IDLE_MS + 10);
    await expect(next).rejects.toThrow();
  });

  test('바깥 신호(새 질문)로 취소하면 요청도 취소된다', async () => {
    const f = abortable(null);
    vi.stubGlobal('fetch', f);
    const ac = new AbortController();
    const it = streamLesson('q', 'kid', ac.signal)[Symbol.asyncIterator]();
    const next = it.next();
    ac.abort();
    await expect(next).rejects.toThrow();
    expect((f.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
  });

  test('줄이 꾸준히 오면(간격 < LESSON_IDLE_MS) 멈춤으로 보지 않는다', async () => {
    const { LESSON_IDLE_MS } = await import('../../src/web/player/lessonClient');
    vi.useFakeTimers();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }), { status: 200 })));
    const out: unknown[] = [];
    const reading = (async () => { for await (const m of streamLesson('q', 'kid', new AbortController().signal)) out.push(m); })();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(LESSON_IDLE_MS - 5000);
      ctl.enqueue(enc.encode('{"type":"page"}\n'));
    }
    ctl.enqueue(enc.encode('{"type":"done"}\n'));
    ctl.close();
    await reading;
    expect(out).toHaveLength(4);
  });
});

describe('서버가 바쁨(429 busy)', () => {
  afterEach(() => vi.unstubAllGlobals());
  test('일반 오류 대신 "잠깐 뒤에 다시" 안내를 error 메시지로 내보낸다(자막에 그대로 뜬다)', async () => {
    const { BUSY_MESSAGE } = await import('../../src/web/player/lessonClient');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"busy"}', { status: 429, headers: { 'retry-after': '5' } })));
    const seen: string[] = [];
    const out: LessonMessage[] = [];
    for await (const m of watchServerError(streamLesson('q', 'kid', new AbortController().signal), (t) => seen.push(t))) out.push(m);
    expect(out).toEqual([{ type: 'error', message: BUSY_MESSAGE }]);
    expect(seen).toEqual([BUSY_MESSAGE]);
    expect(BUSY_MESSAGE).toMatch(/잠깐/);
  });
  test('본문이 없는 429여도 같은 안내', async () => {
    const { BUSY_MESSAGE } = await import('../../src/web/player/lessonClient');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 429 })));
    const out: LessonMessage[] = [];
    for await (const m of streamLesson('q', 'kid', new AbortController().signal)) out.push(m);
    expect(out).toEqual([{ type: 'error', message: BUSY_MESSAGE }]);
  });
});

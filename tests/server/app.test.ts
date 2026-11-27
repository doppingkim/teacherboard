import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, isAllowedHost, MAX_CONCURRENT_LESSONS, type AppDeps } from '../../src/server/app';
import { MAX_CONTEXT_SPOKEN, MAX_QUESTION_CHARS, MAX_SPOKEN_CHARS, type Speech } from '../../src/shared/lesson';
import type { FigureOp, SketchOrder } from '../../src/shared/script';

const sp = (t: string): Speech => ({ audioBase64: t, mime: 'audio/mpeg', timing: { chars: [...t], startMs: [], endMs: [] }, durationMs: 100 });
async function* lines(...xs: string[]) { for (const x of xs) yield x + '\n'; }
const SAY = (t: string) => JSON.stringify({ say: t });
const DRAW = JSON.stringify({ draw: { kind: 'text', role: 'title', text: '제목', ink: 'black' } });
const rowsOf = (body: string) => body.trim().split('\n').map((l) => JSON.parse(l));

let dir: string;
let app: FastifyInstance | undefined;
const make = (over: Partial<AppDeps> = {}) =>
  (app = buildApp({
    scriptText: () => lines(SAY('하나'), DRAW, SAY('둘')),
    speak: async (t) => sp(t),
    drawSketch: async () => null,
    voice: { kid: 'vk', adult: 'va' },
    fillerDir: dir,
    staticDir: join(dir, 'no-dist'),
    logLesson: () => {},
    ...over,
  }));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-app-')); });
afterEach(async () => { await app?.close(); app = undefined; await rm(dir, { recursive: true, force: true }); });

test('POST /api/lesson → 200 NDJSON, 마지막 줄은 done', async () => {
  const seen: unknown[] = [];
  const logLesson = vi.fn();
  make({
    scriptText: (q, p, s) => { seen.push(q, p, s instanceof AbortSignal); return lines(SAY('하나'), DRAW, SAY('둘')); },
    speak: async (t, p) => { seen.push(`speak:${p}`); return sp(t); },
    logLesson,
  });
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '  무지개는 왜 생겨?  ', profile: 'kid' } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('application/x-ndjson');
  const rows = rowsOf(res.body);
  expect(rows.map((r) => r.type)).toEqual(['say', 'draw', 'say', 'done']);
  expect(res.body.endsWith('{"type":"done"}\n')).toBe(true);
  expect(rows[0]).toMatchObject({ id: 1, text: '하나', speech: { audioBase64: '하나' } });
  expect(seen.slice(0, 3)).toEqual(['무지개는 왜 생겨?', 'kid', true]);
  expect(seen).toContain('speak:kid');
  expect(logLesson).toHaveBeenCalledWith(expect.objectContaining({
    question: '무지개는 왜 생겨?', says: 2, droppedLines: 0, firstSayMs: expect.any(Number), totalMs: expect.any(Number),
  }));
});

test('수업이 끝나면 AbortController를 중단해 Gemini·TTS를 정리한다', async () => {
  let signal: AbortSignal | undefined;
  make({ scriptText: (_q, _p, s) => { signal = s; return lines(SAY('하나')); } });
  await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'adult' } });
  expect(signal?.aborted).toBe(true);
});

test('클라이언트가 연결을 끊으면 Gemini·TTS 신호가 중단된다 (실제 소켓)', async () => {
  let signal: AbortSignal | undefined;
  let ttsSignal: AbortSignal | undefined;
  const logLesson = vi.fn();
  async function* hang(s: AbortSignal) {
    yield SAY('하나') + '\n';
    yield SAY('둘') + '\n';
    await new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('aborted'))));
  }
  make({
    scriptText: (_q, _p, s) => { signal = s; return hang(s); },
    speak: async (t, _p, s) => {
      if (t === '둘') { ttsSignal = s; await new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('aborted')))); }
      return sp(t);
    },
    logLesson,
  });
  const url = new URL(await app!.listen({ port: 0, host: '127.0.0.1' }));
  // fetch(undici)는 요청 없는 예비 소켓을 열어 app.close()를 붙잡으므로 node:http로 소켓 하나만 쓴다.
  const first = await new Promise<{ text: string; req: ClientRequest }>((ok, fail) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: '/api/lesson', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.once('data', (d: Buffer) => ok({ text: d.toString('utf8'), req }));
    });
    req.on('error', () => {});
    req.once('error', fail);
    req.end(JSON.stringify({ question: 'q', profile: 'kid' }));
  });
  expect(first.text).toContain('"type":"say"');
  first.req.destroy();
  await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 2000 });
  expect(ttsSignal?.aborted).toBe(true);
  await vi.waitFor(() => expect(logLesson).toHaveBeenCalledTimes(1), { timeout: 2000 });
});

test('대본 오류 → 마지막 줄 error', async () => {
  async function* bad() { yield SAY('하나') + '\n'; throw new Error('boom'); }
  make({ scriptText: () => bad() });
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  expect(res.statusCode).toBe(200);
  expect(rowsOf(res.body).at(-1)).toMatchObject({ type: 'error' });
});

test.each([
  ['빈 질문', { question: '   ', profile: 'kid' }],
  ['질문 없음', { profile: 'kid' }],
  ['문자열 아님', { question: 3, profile: 'kid' }],
  ['너무 긴 질문', { question: 'a'.repeat(501), profile: 'kid' }],
  ['모르는 프로필', { question: 'q', profile: 'teen' }],
  ['프로필 없음', { question: 'q' }],
])('POST /api/lesson 잘못된 본문(%s) → 400', async (_n, payload) => {
  const scriptText = vi.fn(() => lines());
  make({ scriptText });
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload });
  expect(res.statusCode).toBe(400);
  expect(scriptText).not.toHaveBeenCalled();
});

test('POST /api/lesson JSON이 아닌 본문 → 400', async () => {
  make();
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', headers: { 'content-type': 'application/json' }, payload: '{nope' });
  expect(res.statusCode).toBe(400);
});

test('GET /api/filler/:profile → Speech[] (임시 디렉터리에 캐시)', async () => {
  const speak = vi.fn(async (t: string, _p: string, _s: AbortSignal) => sp(t));
  make({ speak });
  const res = await app!.inject({ method: 'GET', url: '/api/filler/kid' });
  expect(res.statusCode).toBe(200);
  const body = res.json() as Speech[];
  expect(body.map((s) => s.audioBase64)).toEqual(['음~ 좋은 질문이야!', '오, 그거 궁금했구나!', '자, 그려 볼까?']);
  expect(speak.mock.calls.every((c) => c[1] === 'kid')).toBe(true);
  await app!.inject({ method: 'GET', url: '/api/filler/kid' });
  expect(speak).toHaveBeenCalledTimes(3);
  expect(await readFile(join(dir, 'kid-0.json'), 'utf8')).toContain('"voiceId":"vk"');
});

test('GET /api/filler/모르는프로필 → 400', async () => {
  make();
  const res = await app!.inject({ method: 'GET', url: '/api/filler/teen' });
  expect(res.statusCode).toBe(400);
});

test('채움 음성 TTS가 전부 실패하면 502', async () => {
  make({ speak: async () => { throw new Error('down'); } });
  const res = await app!.inject({ method: 'GET', url: '/api/filler/adult' });
  expect(res.statusCode).toBe(502);
});

test('dist가 있으면 정적 파일을 서빙하고, 없으면 404', async () => {
  make();
  expect((await app!.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  await app!.close();
  const dist = join(dir, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><p>hi</p>');
  make({ staticDir: dist });
  const res = await app!.inject({ method: 'GET', url: '/' });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<p>hi</p>');
});

test('수업 로그에 ttsFailures와 첫 TTS 오류(상태·메시지)가 남는다', async () => {
  const { TtsError } = await import('../../src/server/tts');
  const logLesson = vi.fn();
  make({
    speak: async (t) => { if (t === '하나') throw new TtsError(401, 'ElevenLabs 401: invalid api key'); return sp(t); },
    logLesson,
  });
  await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  const entry = logLesson.mock.calls[0][0];
  expect(entry).toMatchObject({ says: 2, ttsFailures: 1 });
  expect(entry.ttsError).toBe('TtsError 401: ElevenLabs 401: invalid api key');
});
test('TTS가 모두 성공하면 로그의 ttsFailures는 0이고 ttsError는 없다', async () => {
  const logLesson = vi.fn();
  make({ logLesson });
  await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  expect(logLesson.mock.calls[0][0]).toMatchObject({ ttsFailures: 0 });
  expect(logLesson.mock.calls[0][0]).not.toHaveProperty('ttsError');
});

test('POST /api/lesson context가 scriptText로 전달된다', async () => {
  const seen: unknown[] = [];
  make({ scriptText: (_q, _p, _s, ctx) => { seen.push(ctx); return lines(SAY('하나')); } });
  const context = { previousQuestion: '무지개는 왜 생겨?', spoken: ['햇빛이 물방울에 들어가면'] };
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '근데 왜?', profile: 'kid', context } });
  expect(res.statusCode).toBe(200);
  expect(seen).toEqual([context]);
});

test('POST /api/lesson context가 없으면 undefined로 전달된다', async () => {
  const seen: unknown[] = [];
  make({ scriptText: (_q, _p, _s, ctx) => { seen.push(ctx); return lines(SAY('하나')); } });
  await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  expect(seen).toEqual([undefined]);
});

test.each([
  ['null', null],
  ['spoken 25개', { previousQuestion: 'q', spoken: Array(25).fill('a') }],
  ['spoken 201자', { previousQuestion: 'q', spoken: ['a'.repeat(201)] }],
  ['질문 없음', { spoken: [] }],
])('POST /api/lesson 잘못된 context(%s) → 400', async (_n, context) => {
  const scriptText = vi.fn(() => lines());
  make({ scriptText });
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid', context } });
  expect(res.statusCode).toBe(400);
  expect(scriptText).not.toHaveBeenCalled();
});

test('POST /api/lesson heard(말로 물음)가 scriptText로 전달된다, 없으면 undefined', async () => {
  const seen: unknown[] = [];
  make({ scriptText: (_q, _p, _s, _c, heard) => { seen.push(heard); return lines(SAY('하나')); } });
  const ok = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '허리디스크가 뭐야?', profile: 'kid', heard: '퀄리디스크가 뭐야' } });
  expect(ok.statusCode).toBe(200);
  await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  expect(seen).toEqual(['퀄리디스크가 뭐야', undefined]);
});

test.each([
  ['숫자', 3],
  ['null', null],
  ['501자', 'a'.repeat(501)],
])('POST /api/lesson 잘못된 heard(%s) → 400', async (_n, heard) => {
  const scriptText = vi.fn(() => lines());
  make({ scriptText });
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid', heard } });
  expect(res.statusCode).toBe(400);
  expect(scriptText).not.toHaveBeenCalled();
});

describe('Host 허용 목록(DNS rebinding 막기)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const lesson = (host: string | undefined, origin?: string) =>
    app!.inject({
      method: 'POST',
      url: '/api/lesson',
      headers: { ...(host === undefined ? {} : { host }), ...(origin ? { origin } : {}) },
      payload: { question: 'q', profile: 'kid' },
    });

  test('rebinding: 공격자 도메인 Host+Origin → 403, 대본을 만들지 않는다', async () => {
    const scriptText = vi.fn(() => lines(SAY('하나')));
    make({ scriptText });
    const res = await lesson('evil.example:8787', 'http://evil.example:8787');
    expect(res.statusCode).toBe(403);
    expect(scriptText).not.toHaveBeenCalled();
  });

  test.each(['evil.example', 'localhost.evil.example', 'ts.net', 'evilts.net:8787', '127.0.0.1.nip.io', '[evil]:80', 'localhost:abc'])('Host %s → 403', async (host) => {
    make();
    expect((await lesson(host)).statusCode).toBe(403);
  });

  test('Host가 없거나 비면 거절(inject는 빈 Host를 기본값으로 채우므로 함수로 확인)', () => {
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
    expect(isAllowedHost('  ')).toBe(false);
  });

  test('filler·정적 파일도 같은 규칙', async () => {
    make();
    expect((await app!.inject({ method: 'GET', url: '/api/filler/kid', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  });

  test.each(['localhost:8787', 'LOCALHOST:8787', 'localhost', '127.0.0.1:8787', '[::1]:8787', '[::1]', '192.168.0.5:8787', '10.0.0.2', 'mypc.tail1234.ts.net', 'MyPC.Tail1234.TS.NET:443'])(
    'Host %s → 허용',
    async (host) => {
      make();
      expect((await lesson(host)).statusCode).toBe(200);
    },
  );

  test('ALLOWED_HOSTS(쉼표로 구분, 요청 때 읽음)로 더 허용한다', async () => {
    make();
    expect((await lesson('teacher.home:8787')).statusCode).toBe(403);
    vi.stubEnv('ALLOWED_HOSTS', ' other.lan , Teacher.Home ');
    expect((await lesson('teacher.home:8787')).statusCode).toBe(200);
    expect((await lesson('other.lan')).statusCode).toBe(200);
    expect((await lesson('evil.example')).statusCode).toBe(403);
  });

  test('ngrok 고정 도메인: ALLOWED_HOSTS 없으면 403, 적으면 허용(다른 ngrok 이름은 여전히 403)', async () => {
    make();
    expect((await lesson('fam.ngrok-free.app', 'https://fam.ngrok-free.app')).statusCode).toBe(403);
    vi.stubEnv('ALLOWED_HOSTS', 'fam.ngrok-free.app');
    expect((await lesson('fam.ngrok-free.app', 'https://fam.ngrok-free.app')).statusCode).not.toBe(403);
    expect((await lesson('evil.ngrok-free.app')).statusCode).toBe(403);
  });
});

const ORDER = (id: string) => JSON.stringify({ sketch: { id, size: 'small', describe: `${id} 그림` } });
const FIG = (id: string): FigureOp => ({ kind: 'figure', id, size: 'small', ink: 'black', strokes: ['M0 0 L10 10'] });

test('app: drawSketch 의존성이 lesson에 연결되고 로그에 sketches/sketchFailures/sketchMs', async () => {
  const logLesson = vi.fn();
  const orders: SketchOrder[] = [];
  const signals: AbortSignal[] = [];
  make({
    scriptText: () => lines(SAY('하나'), ORDER('병사'), ORDER('성'), SAY('둘')),
    drawSketch: async (o, s) => { orders.push(o); signals.push(s); return o.id === '병사' ? FIG('병사') : null; },
    logLesson,
  });
  const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  const rows = rowsOf(res.body);
  expect(rows).toContainEqual({ type: 'sketch', id: '병사', figure: FIG('병사') });
  expect(rows).toContainEqual({ type: 'sketch', id: '성', figure: null });
  expect(rows.at(-1)).toEqual({ type: 'done' });
  expect(orders.map((o) => o.id)).toEqual(['병사', '성']);
  expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  const entry = logLesson.mock.calls[0][0];
  expect(entry).toMatchObject({ sketches: 2, sketchFailures: 1, sketchMs: [expect.any(Number), expect.any(Number)] });
});

test('drawSketch 없이도 app을 만들 수 있다(주문은 figure:null, 수업은 끝까지)', async () => {
  const logLesson = vi.fn();
  const { drawSketch: _omit, ...rest } = {
    scriptText: () => lines(SAY('하나'), ORDER('병사'), SAY('둘')),
    speak: async (t: string) => sp(t),
    drawSketch: async () => null,
    voice: { kid: 'vk', adult: 'va' },
    fillerDir: dir,
    staticDir: join(dir, 'no-dist'),
    logLesson,
  } satisfies AppDeps;
  const deps: AppDeps = rest; // drawSketch는 선택
  app = buildApp(deps);
  const res = await app.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  const rows = rowsOf(res.body);
  expect(rows).toContainEqual({ type: 'sketch', id: '병사', figure: null });
  expect(rows.at(-1)).toEqual({ type: 'done' });
  expect(logLesson.mock.calls[0][0]).toMatchObject({ sketches: 1, sketchFailures: 1 });
});

test('그림 주문이 없으면 로그는 sketches 0, sketchMs []', async () => {
  const logLesson = vi.fn();
  make({ logLesson });
  await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
  expect(logLesson.mock.calls[0][0]).toMatchObject({ sketches: 0, sketchFailures: 0, sketchMs: [] });
});

test('클라이언트가 연결을 끊으면 화가 signal도 중단된다 (실제 소켓)', async () => {
  let sketchSignal: AbortSignal | undefined;
  async function* hang(s: AbortSignal) {
    yield SAY('하나') + '\n';
    yield ORDER('병사') + '\n';
    await new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('aborted'))));
  }
  make({
    scriptText: (_q, _p, s) => hang(s),
    drawSketch: (_o, s) => { sketchSignal = s; return new Promise(() => {}); },
  });
  const url = new URL(await app!.listen({ port: 0, host: '127.0.0.1' }));
  const req = await new Promise<ClientRequest>((ok, fail) => {
    const r = httpRequest({ host: url.hostname, port: url.port, path: '/api/lesson', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.once('data', () => ok(r));
    });
    r.on('error', () => {});
    r.once('error', fail);
    r.end(JSON.stringify({ question: 'q', profile: 'kid' }));
  });
  await vi.waitFor(() => expect(sketchSignal).toBeDefined(), { timeout: 2000 });
  expect(sketchSignal!.aborted).toBe(false);
  req.destroy();
  await vi.waitFor(() => expect(sketchSignal!.aborted).toBe(true), { timeout: 2000 });
});

test('POST /api/lesson mode: 없으면 quick, deep은 그대로 넘기고, 다른 값은 400', async () => {
  const modes: unknown[] = [];
  make({ scriptText: (_q, _p, _s, _c, _h, m) => { modes.push(m); return lines(SAY('하나')); } });
  expect((await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } })).statusCode).toBe(200);
  expect((await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid', mode: 'deep' } })).statusCode).toBe(200);
  expect((await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid', mode: 'turbo' } })).statusCode).toBe(400);
  expect(modes).toEqual(['quick', 'deep']);
});

test('POST /api/lesson level: 없으면 프로필 기본(아이 → 초등, 어른 → 성인), 고르면 그대로, 다른 값은 400', async () => {
  const levels: unknown[] = [];
  make({ scriptText: (_q, _p, _s, _c, _h, _m, l) => { levels.push(l); return lines(SAY('하나')); } });
  const post = (payload: Record<string, unknown>) => app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', ...payload } });
  expect((await post({ profile: 'kid' })).statusCode).toBe(200);
  expect((await post({ profile: 'adult' })).statusCode).toBe(200);
  expect((await post({ profile: 'kid', level: 'middle' })).statusCode).toBe(200);
  expect((await post({ profile: 'kid', level: 'phd' })).statusCode).toBe(400);
  expect(levels).toEqual(['elementary', 'adult', 'middle']);
});

describe('보안 QA(2026-11-22)', () => {
  test('한도를 꽉 채운 한글 본문(질문·heard·문맥 모두 최대, 약 19KB)도 받는다 — 413이 아니다', async () => {
    make();
    const ko = (n: number) => '가'.repeat(n);
    const payload = {
      question: ko(MAX_QUESTION_CHARS), profile: 'kid', heard: ko(MAX_QUESTION_CHARS), mode: 'deep', level: 'middle',
      context: { previousQuestion: ko(MAX_QUESTION_CHARS), spoken: Array(MAX_CONTEXT_SPOKEN).fill(ko(MAX_SPOKEN_CHARS)), interrupted: true },
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(16 * 1024);
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload });
    expect(res.statusCode).toBe(200);
  });

  test('그래도 거대한 본문(1MB)은 413, 대본을 만들지 않는다', async () => {
    const scriptText = vi.fn(() => lines());
    make({ scriptText });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'a'.repeat(1_000_000), profile: 'kid' } });
    expect(res.statusCode).toBe(413);
    expect(scriptText).not.toHaveBeenCalled();
  });

  test.each([
    ['제어 문자뿐', '\u0000\u0007\u001b'],
    ['폭 없는 공백뿐', '​​⁠'],
    ['방향 표시뿐', '‮‏'],
  ])('보이는 글자가 없는 질문(%s) → 400, 모델을 부르지 않는다', async (_n, question) => {
    const scriptText = vi.fn(() => lines());
    make({ scriptText });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question, profile: 'kid' } });
    expect(res.statusCode).toBe(400);
    expect(scriptText).not.toHaveBeenCalled();
  });

  test('이모지·한글이 섞인 질문은 그대로 받는다', async () => {
    make();
    expect((await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '🌈 무지개?', profile: 'kid' } })).statusCode).toBe(200);
    expect((await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '😀', profile: 'kid' } })).statusCode).toBe(200);
  });

  test(`동시 수업은 ${MAX_CONCURRENT_LESSONS}개까지: 넘으면 429(모델을 부르지 않는다), 끝나면 다시 받는다`, async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let started = 0;
    make({ scriptText: () => (async function* () { started++; await hold; yield SAY('하나') + '\n'; })() });
    const post = () => app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
    const running = Array.from({ length: MAX_CONCURRENT_LESSONS }, post);
    await vi.waitFor(() => expect(started).toBe(MAX_CONCURRENT_LESSONS));
    const extra = await post();
    expect(extra.statusCode).toBe(429);
    expect(extra.json()).toMatchObject({ error: 'busy' });
    expect(extra.headers['retry-after']).toBeDefined();
    expect(started).toBe(MAX_CONCURRENT_LESSONS);
    release();
    expect((await Promise.all(running)).map((r) => r.statusCode)).toEqual(Array(MAX_CONCURRENT_LESSONS).fill(200));
    // 다 끝났으니 자리가 비었다
    const again = await Promise.all(Array.from({ length: MAX_CONCURRENT_LESSONS }, post));
    expect(again.every((r) => r.statusCode === 200)).toBe(true);
  });

  test('연결이 끊긴 수업은 자리를 돌려준다(실제 소켓)', async () => {
    // 'hang' 질문만 연결이 끊길 때까지 붙잡는다. 자리가 비었는지 보는 마지막 요청은 바로 끝나야 한다
    // (inject는 연결 끊김을 흉내 내지 않아, 붙잡는 수업이면 영영 기다린다 — 예전 시험이 실패한 까닭).
    const signals: AbortSignal[] = [];
    make({
      scriptText: (q, _p, s) => (async function* () {
        yield SAY('하나') + '\n';
        if (q !== 'hang') return;
        signals.push(s);
        await new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('aborted'))));
      })(),
    });
    const url = new URL(await app!.listen({ port: 0, host: '127.0.0.1' }));
    const open = () => new Promise<ClientRequest>((ok, fail) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: '/api/lesson', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => ok(req));
      });
      req.on('error', () => {});
      req.once('error', fail);
      req.end(JSON.stringify({ question: 'hang', profile: 'kid' }));
    });
    const reqs = await Promise.all(Array.from({ length: MAX_CONCURRENT_LESSONS }, open));
    const post = () => app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
    expect((await post()).statusCode).toBe(429);
    for (const r of reqs) r.destroy();
    // 소켓이 닫히는 때는 정해져 있지 않으니 시간이 아니라 상태(모든 수업의 신호가 끊겼다)를 기다린다.
    // 신호 끊기와 자리 반납은 같은 동기 처리(abort)라, 신호가 끊겼으면 자리도 비었다.
    await vi.waitFor(() => expect(signals.filter((s) => s.aborted)).toHaveLength(MAX_CONCURRENT_LESSONS), { timeout: 5000 });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(rowsOf(res.body).at(-1)).toMatchObject({ type: 'done' });
  });

  test('처리기가 돌기 전에 이미 끊긴 연결은 자리를 차지하지 않고 대본도 만들지 않는다(실제 소켓)', async () => {
    let started = 0;
    make({ scriptText: () => (async function* () { started++; yield SAY('하나') + '\n'; })() });
    // 본문은 다 받았지만 처리기 전에 연결이 닫힌 상황을 확실히 만든다: 처리기 직전에 서버 쪽 소켓을 직접 닫고
    // 'close'가 지나갈 때까지 기다린다. 손님 쪽이 언제 끊는지(병렬 부하에서 들쭉날쭉)에 기대지 않는다.
    app!.addHook('preHandler', async (request) => {
      if (request.headers['x-hold'] !== '1') return;
      const sock = request.raw.socket;
      const closed = new Promise((r) => sock.once('close', r));
      sock.destroy();
      await closed;
    });
    // 처리기가 응답을 내보내려 한 수(고치기 전엔 수업 스트림, 고친 뒤엔 499). 시간 대신 이 상태를 기다린다.
    const handled = new Set<string>();
    app!.addHook('onSend', async (request, _reply, payload) => {
      if (request.headers['x-hold'] === '1') handled.add(request.id);
      return payload;
    });
    const url = new URL(await app!.listen({ port: 0, host: '127.0.0.1' }));
    const body = JSON.stringify({ question: 'q', profile: 'kid' });
    const n = MAX_CONCURRENT_LESSONS + 2;
    for (let i = 0; i < n; i++) {
      const s = connect(Number(url.port), '127.0.0.1');
      s.on('error', () => {});
      s.write(`POST /api/lesson HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Hold: 1\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
    await vi.waitFor(() => expect(handled.size).toBe(n), { timeout: 10_000 });
    expect(started).toBe(0);
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } });
    expect(res.statusCode).toBe(200);
    expect(started).toBe(1);
  }, 20_000);

  test('보안 머리글: 정적 파일·API·오류 응답 모두에 nosniff·프레임 금지·referrer 제한', async () => {
    const dist = join(dir, 'dist');
    await mkdir(dist);
    await writeFile(join(dist, 'index.html'), '<!doctype html><p>hi</p>');
    make({ staticDir: dist });
    for (const req of [
      { method: 'GET' as const, url: '/' },
      { method: 'POST' as const, url: '/api/lesson', payload: { question: 'q', profile: 'kid' } },
      { method: 'POST' as const, url: '/api/lesson', payload: { question: '' } },
      { method: 'GET' as const, url: '/api/nope' },
    ]) {
      const res = await app!.inject(req);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(res.headers['referrer-policy']).toBe('same-origin');
    }
    // Host 거절(403)에도
    const bad = await app!.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } });
    expect(bad.statusCode).toBe(403);
    expect(bad.headers['x-frame-options']).toBe('DENY');
  });

  test('dist 안의 점 파일(.env 등)은 내주지 않는다', async () => {
    const dist = join(dir, 'dist');
    await mkdir(dist);
    await writeFile(join(dist, 'index.html'), '<p>hi</p>');
    await writeFile(join(dist, '.env'), 'SECRET=1');
    make({ staticDir: dist });
    const res = await app!.inject({ method: 'GET', url: '/.env' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('SECRET');
    expect((await app!.inject({ method: 'GET', url: '/%2e%65nv' })).body).not.toContain('SECRET');
  });

  test.each(['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/%2e%2e%5c%2e%2e%5cpackage.json', '/....//package.json'])(
    '정적 파일 경로 조작(%s) → dist 밖을 읽지 않는다',
    async (url) => {
      const dist = join(dir, 'dist');
      await mkdir(dist);
      await writeFile(join(dist, 'index.html'), '<p>hi</p>');
      await writeFile(join(dir, 'package.json'), 'OUTSIDE');
      make({ staticDir: dist });
      const res = await app!.inject({ method: 'GET', url });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain('OUTSIDE');
    },
  );

  test.each([
    ['x-forwarded-for', '203.0.113.9'],
    ['x-forwarded-host', 'fam.ngrok-free.app'],
    ['x-forwarded-proto', 'https'],
    ['forwarded', 'for=203.0.113.9'],
  ])('FAMILY_PIN이 없으면 터널을 거친 요청(%s) → 403, 모델을 부르지 않는다', async (name, value) => {
    const scriptText = vi.fn(() => lines(SAY('하나')));
    make({ scriptText });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', headers: { [name]: value }, payload: { question: 'q', profile: 'kid' } });
    expect(res.statusCode).toBe(403);
    expect(scriptText).not.toHaveBeenCalled();
    expect((await app!.inject({ method: 'GET', url: '/api/filler/kid', headers: { [name]: value } })).statusCode).toBe(403);
  });

  test('FAMILY_PIN이 없어도 터널 머리글이 없는 이 컴퓨터의 요청은 그대로 받는다', async () => {
    make();
    expect((await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid' } })).statusCode).toBe(200);
  });

  test.each([
    ['null', 'null'],
    ['배열', '[{"question":"q","profile":"kid"}]'],
    ['문자열', '"q"'],
    ['숫자', '42'],
    ['__proto__ 오염', '{"question":"q","profile":"kid","__proto__":{"polluted":1}}'],
    ['constructor.prototype 오염', '{"question":"q","profile":"kid","constructor":{"prototype":{"polluted":1}}}'],
  ])('본문 모양이 이상하면(%s) 4xx, 모델을 부르지 않고 오염도 없다', async (_n, raw) => {
    const scriptText = vi.fn(() => lines(SAY('하나')));
    make({ scriptText });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', headers: { 'content-type': 'application/json' }, payload: raw });
    expect(res.statusCode).toBe(400);
    expect(scriptText).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test.each([
    ['text/plain', 'text/plain', '{"question":"q","profile":"kid"}'],
    ['폼', 'application/x-www-form-urlencoded', 'question=q&profile=kid'],
    ['multipart', 'multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="question"\r\n\r\nq\r\n--x--'],
  ])('남의 페이지가 보낼 수 있는 단순 요청(%s)은 4xx(text/plain은 문자열 본문이라 400, 나머지는 415) — CSRF로 수업을 시키지 못한다', async (_n, type, payload) => {
    const scriptText = vi.fn(() => lines(SAY('하나')));
    make({ scriptText });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', headers: { 'content-type': type }, payload });
    expect([400, 415]).toContain(res.statusCode);
    expect(scriptText).not.toHaveBeenCalled();
  });

  test.each([
    ['mode null', { mode: null }],
    ['mode 대문자', { mode: 'Quick' }],
    ['mode __proto__', { mode: '__proto__' }],
    ['mode 숫자', { mode: 1 }],
    ['level null', { level: null }],
    ['level toString', { level: 'toString' }],
    ['level 배열', { level: ['adult'] }],
    ['profile __proto__', { profile: '__proto__' }],
  ])('mode/level/profile 이상값(%s) → 400', async (_n, over) => {
    const scriptText = vi.fn(() => lines(SAY('하나')));
    make({ scriptText });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'q', profile: 'kid', ...over } });
    expect(res.statusCode).toBe(400);
    expect(scriptText).not.toHaveBeenCalled();
  });

  test('GET /api/filler/__proto__ 같은 이상한 프로필 → 400, TTS를 부르지 않는다', async () => {
    const speak = vi.fn(async (t: string) => sp(t));
    make({ speak });
    for (const p of ['__proto__', 'constructor', 'KID', '%00kid']) {
      expect((await app!.inject({ method: 'GET', url: `/api/filler/${p}` })).statusCode).toBe(400);
    }
    expect(speak).not.toHaveBeenCalled();
  });

  test('질문 경계값: 앞뒤 공백을 빼고 정확히 한도면 받고, 한 글자 넘으면 400(공백은 세지 않는다)', async () => {
    make();
    const post = (question: string) => app!.inject({ method: 'POST', url: '/api/lesson', payload: { question, profile: 'kid' } });
    expect((await post('가'.repeat(MAX_QUESTION_CHARS))).statusCode).toBe(200);
    expect((await post(`  ${'가'.repeat(MAX_QUESTION_CHARS)}\n `)).statusCode).toBe(200);
    expect((await post('가'.repeat(MAX_QUESTION_CHARS + 1))).statusCode).toBe(400);
    expect((await post('a')).statusCode).toBe(200);
  });

  test('오류 응답에 스택·파일 경로가 실리지 않는다', async () => {
    make({ speak: async () => { throw new Error(`boom at ${dir}`); } });
    for (const req of [
      { method: 'POST' as const, url: '/api/lesson', headers: { 'content-type': 'application/json' }, payload: '{"question":' },
      { method: 'GET' as const, url: '/api/filler/adult' },
      { method: 'GET' as const, url: '/api/filler/teen' },
      { method: 'PUT' as const, url: '/api/lesson', payload: {} },
    ]) {
      const res = await app!.inject(req);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toMatch(/\bat .*\.(ts|js):\d+|node_modules|[A-Z]:\\|\/tmp\/|tb-app-/);
    }
  });
});

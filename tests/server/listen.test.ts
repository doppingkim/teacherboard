import type { FastifyInstance } from 'fastify';
import WebSocketClient, { type WebSocket } from 'ws';
import { buildApp, LISTEN_AUDIO_BURST_BYTES, LISTEN_MAX_SOCKETS, type AppDeps, type ListenLog } from '../../src/server/app';
import { MAX_QUESTION_CHARS } from '../../src/shared/lesson';
import type { ClassifyInput, Verdict } from '../../src/server/classify';
import { SttError, type SttEvents } from '../../src/server/stt';

/** 가짜 STT: 호출 기록과 이벤트 발사 손잡이. */
function fakeStt() {
  const calls: string[] = [];
  const audio: Uint8Array[] = [];
  let ev: SttEvents | undefined;
  const session = {
    start: vi.fn((e: SttEvents) => { ev = e; calls.push('start'); }),
    sendAudio: vi.fn((b: Uint8Array) => { audio.push(b); calls.push('audio'); }),
    commit: vi.fn(() => { calls.push('commit'); }),
    keepAlive: vi.fn(() => { calls.push('keepAlive'); }),
    close: vi.fn(() => { calls.push('close'); }),
  };
  return { session, calls, audio, events: () => ev! };
}

let app: FastifyInstance | undefined;
let clients: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients) c.terminate();
  clients = [];
  await app?.close();
  app = undefined;
});

function make(over: { classify?: (i: ClassifyInput, signal?: AbortSignal) => Promise<Verdict>; logListen?: (e: ListenLog) => void } = {}) {
  const stt = fakeStt();
  const classify = vi.fn(over.classify ?? (async (i: ClassifyInput, _s?: AbortSignal): Promise<Verdict> => ({ accept: true, question: i.text, reason: 'model', complete: true })));
  const logListen = vi.fn(over.logListen ?? (() => {}));
  const openStt = vi.fn(() => stt.session);
  const deps: AppDeps = {
    scriptText: async function* () {},
    speak: async () => { throw new Error('unused'); },
    voice: { kid: 'vk', adult: 'va' },
    staticDir: 'no-such-dist-dir',
    logLesson: () => {},
    logListen,
    listen: { openStt, classify },
  };
  app = buildApp(deps);
  return { stt, classify, logListen, openStt };
}

/** 소켓을 열고, 열리기 전부터 받은 메시지·닫힘을 모은다. */
async function connect(path = '/api/listen?profile=kid', headers: Record<string, string> = {}) {
  await app!.ready();
  const msgs: any[] = [];
  const closed: { code?: number } = {};
  // injectWS는 Host를 붙이지 않으므로 허용된 Host를 기본으로 넣는다.
  const ws = await app!.injectWS(path, { headers: { host: 'localhost:8787', ...headers } }, {
    onInit: (w) => {
      w.on('message', (d, isBinary) => { if (!isBinary) msgs.push(JSON.parse(d.toString())); });
      w.on('close', (code) => { closed.code = code; });
    },
  });
  clients.push(ws);
  return { ws, msgs, closed };
}

/** Scribe 세션은 첫 소리에서 열린다: 소리 한 덩어리를 보내 세션을 연다. */
async function openSession(ws: WebSocket, stt: ReturnType<typeof fakeStt>) {
  const before = stt.session.start.mock.calls.length;
  ws.send(Buffer.from([0, 0]));
  await vi.waitFor(() => expect(stt.session.start.mock.calls.length).toBe(before + 1));
}

test('연결 → ready(STT는 아직 안 엶), 첫 바이너리 → STT 열고 sendAudio, end → commit', async () => {
  const { stt, openStt } = make();
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  expect(openStt).not.toHaveBeenCalled();
  expect(stt.session.start).not.toHaveBeenCalled();
  ws.send(Buffer.from([1, 2, 3, 4]));
  ws.send(JSON.stringify({ type: 'end' }));
  await vi.waitFor(() => expect(stt.calls).toEqual(['start', 'audio', 'commit']));
  expect(Array.from(stt.audio[0])).toEqual([1, 2, 3, 4]);
  expect(stt.audio[0]).toBeInstanceOf(Uint8Array);
});

test('partial 전달', async () => {
  const { stt } = make();
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onPartial('근데');
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'partial', text: '근데' }));
});

test('final → classify(state 반영) → utterance', async () => {
  const logListen = vi.fn();
  const { stt, classify } = make({ logListen });
  const { ws, msgs } = await connect('/api/listen?profile=adult');
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  ws.send(JSON.stringify({ type: 'state', lessonActive: true, recentSpoken: ['a'] }));
  // state가 서버에 닿은 뒤 final을 쏘도록 ping 왕복으로 순서를 맞춘다.
  ws.send(JSON.stringify({ type: 'ping' }));
  await vi.waitFor(() => expect(stt.session.keepAlive).toHaveBeenCalled());
  stt.events().onFinal('근데 왜?');
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'utterance', text: '근데 왜?', accept: true, question: '근데 왜?' }));
  expect(classify).toHaveBeenCalledWith({ text: '근데 왜?', profile: 'adult', lessonActive: true, recentSpoken: ['a'] }, expect.any(AbortSignal));
  expect(logListen).toHaveBeenCalledWith({ text: '근데 왜?', accept: true, reason: 'model', ms: expect.any(Number), sttMs: expect.any(Number) });
});

test('판정은 들은 순서대로 나간다(느린 판정이 먼저여도)', async () => {
  const { stt } = make({
    classify: async (i) => {
      await new Promise((r) => setTimeout(r, i.text === '첫째' ? 50 : 0));
      return { accept: false, question: '', reason: 'exclaim', complete: true };
    },
  });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onFinal('첫째');
  stt.events().onFinal('둘째');
  await vi.waitFor(() => expect(msgs.filter((m) => m.type === 'utterance')).toHaveLength(2));
  expect(msgs.filter((m) => m.type === 'utterance').map((m) => m.text)).toEqual(['첫째', '둘째']);
});

test('덜 끝난 말은 다음 말과 이어 다시 판정한다(partial에도 앞 말을 붙인다)', async () => {
  const logListen = vi.fn();
  const { stt, classify } = make({
    logListen,
    classify: async (i) =>
      i.text === '퀄리디스크가'
        ? { accept: false, question: '', reason: 'model', complete: false }
        : { accept: true, question: '허리디스크가 왜 생겨?', reason: 'model', complete: true },
  });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  ws.send(JSON.stringify({ type: 'end' }));
  await vi.waitFor(() => expect(stt.session.commit).toHaveBeenCalledTimes(1));
  stt.events().onFinal('퀄리디스크가');
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(msgs.filter((m) => m.type === 'utterance')).toEqual([]); // 기다린다
  ws.send(Buffer.from([0, 0])); // 다시 말하기 시작
  await vi.waitFor(() => expect(stt.audio.length).toBe(2));
  stt.events().onPartial('왜 생겨');
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'partial', text: '퀄리디스크가 왜 생겨' }));
  ws.send(JSON.stringify({ type: 'end' }));
  await vi.waitFor(() => expect(stt.session.commit).toHaveBeenCalledTimes(2));
  stt.events().onFinal('왜 생겨?');
  await vi.waitFor(() => expect(msgs.filter((m) => m.type === 'utterance')).toHaveLength(2));
  expect(msgs.filter((m) => m.type === 'utterance')).toEqual([
    { type: 'utterance', text: '퀄리디스크가', accept: false, question: '' },
    { type: 'utterance', text: '퀄리디스크가 왜 생겨?', accept: true, question: '허리디스크가 왜 생겨?' },
  ]);
  expect(classify.mock.calls.map(([i]) => i.text)).toEqual(['퀄리디스크가', '퀄리디스크가 왜 생겨?']);
  expect(logListen.mock.calls.map(([e]) => e.reason)).toEqual(['joined', 'model']);
});

test('판정이 던지면 거절로 보낸다', async () => {
  const { stt } = make({ classify: async () => { throw new Error('boom'); } });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onFinal('뭐야');
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'utterance', text: '뭐야', accept: false, question: '' }));
});

test('잘못된 state·모르는 메시지는 무시한다', async () => {
  const { stt, classify } = make();
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  ws.send(JSON.stringify({ type: 'state', lessonActive: 'yes', recentSpoken: ['x'] }));
  ws.send('{not json');
  ws.send(JSON.stringify({ type: 'dance' }));
  ws.send(JSON.stringify({ type: 'ping' }));
  await vi.waitFor(() => expect(stt.session.keepAlive).toHaveBeenCalled());
  stt.events().onFinal('하늘은 왜 파래?');
  await vi.waitFor(() => expect(classify).toHaveBeenCalled());
  expect(classify.mock.calls[0][0]).toMatchObject({ lessonActive: false, recentSpoken: [] });
});

test('recentSpoken은 최근 8개, 각 200자로 자른다', async () => {
  const { stt, classify } = make();
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  const many = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(i === 9 ? 300 : 1));
  ws.send(JSON.stringify({ type: 'state', lessonActive: true, recentSpoken: many }));
  ws.send(JSON.stringify({ type: 'ping' }));
  await vi.waitFor(() => expect(stt.session.keepAlive).toHaveBeenCalled());
  stt.events().onFinal('왜?');
  await vi.waitFor(() => expect(classify).toHaveBeenCalled());
  const rs = classify.mock.calls[0][0].recentSpoken;
  expect(rs).toHaveLength(8);
  expect(rs[0]).toBe('2');
  expect(rs[7]).toHaveLength(200);
});

test('ping → keepAlive', async () => {
  const { stt } = make();
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  ws.send(JSON.stringify({ type: 'ping' }));
  await vi.waitFor(() => expect(stt.session.keepAlive).toHaveBeenCalledTimes(1));
});

test('STT 오류 → error 메시지 후 닫힘, 키 문자열 없음', async () => {
  const { stt } = make();
  const { ws, msgs, closed } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onError(new SttError('auth_error', 'invalid xi-api-key sk_live_SECRET123'));
  await vi.waitFor(() => expect(closed.code).toBeDefined());
  expect(msgs).toContainEqual({ type: 'error', message: '음성 인식에 문제가 생겼어요' });
  const raw = JSON.stringify(msgs);
  expect(raw).not.toContain('SECRET');
  expect(raw).not.toContain('xi-api-key');
  expect(raw).not.toContain('auth_error');
  expect(stt.session.close).toHaveBeenCalled();
});

test('첫 소리에서 STT 시작이 던지면 error 후 1011로 닫힘(업스트림 문구 없음)', async () => {
  const { stt } = make();
  stt.session.start.mockImplementation(() => { throw new Error('bad url xi-api-key'); });
  const { ws, msgs, closed } = await connect();
  await vi.waitFor(() => expect(msgs).toEqual([{ type: 'ready' }]));
  ws.send(Buffer.from([1, 2]));
  await vi.waitFor(() => expect(closed.code).toBe(1011));
  expect(msgs).toEqual([{ type: 'ready' }, { type: 'error', message: '음성 인식에 문제가 생겼어요' }]);
  expect(stt.session.close).toHaveBeenCalled();
  expect(stt.session.sendAudio).not.toHaveBeenCalled();
});

test('commit_throttled 같은 경고는 치명적이지 않다: 로그만 남기고 계속 듣는다', async () => {
  const { stt } = make();
  const { ws, msgs, closed } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onWarning!(new SttError('commit_throttled', 'too many commits'));
  stt.events().onPartial('아직 듣는 중');
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'partial', text: '아직 듣는 중' }));
  expect(closed.code).toBeUndefined();
  expect(msgs.some((m) => m.type === 'error')).toBe(false);
  expect(stt.session.close).not.toHaveBeenCalled();
});

test('Scribe가 먼저 끊으면 error 후 닫힘', async () => {
  const { stt } = make();
  const { ws, msgs, closed } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onClose();
  await vi.waitFor(() => expect(closed.code).toBeDefined());
  expect(msgs).toContainEqual({ type: 'error', message: '음성 인식에 문제가 생겼어요' });
});

test('끊기면 STT close', async () => {
  const { stt } = make();
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  // injectWS의 메모리 스트림에서는 close() 핸드셰이크가 TCP 종료까지 가지 않으므로 끊김을 terminate로 흉내 낸다.
  ws.terminate();
  await vi.waitFor(() => expect(stt.session.close).toHaveBeenCalledTimes(1));
});

test('실제 소켓에서 브라우저가 정상 종료(close)해도 STT close', async () => {
  const { stt } = make();
  const url = new URL(await app!.listen({ port: 0, host: '127.0.0.1' }));
  const ws = new WebSocketClient(`ws://${url.host}/api/listen?profile=kid`);
  clients.push(ws);
  const ready = new Promise<void>((ok) => ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'ready') ok(); }));
  await ready;
  ws.send(Buffer.from([0, 0]));
  await vi.waitFor(() => expect(stt.session.start).toHaveBeenCalledTimes(1), { timeout: 2000 });
  ws.close(1000);
  await vi.waitFor(() => expect(stt.session.close).toHaveBeenCalledTimes(1), { timeout: 2000 });
});

test.each([
  ['없음', '/api/listen'],
  ['모르는 값', '/api/listen?profile=teen'],
])('잘못된 profile(%s) → 1008, STT를 열지 않는다', async (_n, path) => {
  const { stt } = make();
  const { msgs, closed } = await connect(path);
  await vi.waitFor(() => expect(closed.code).toBe(1008));
  expect(stt.session.start).not.toHaveBeenCalled();
  expect(msgs).toEqual([]);
});

test('listen 의존성이 없으면 /api/listen 라우트가 없다', async () => {
  app = buildApp({
    scriptText: async function* () {},
    speak: async () => { throw new Error('unused'); },
    voice: { kid: 'vk', adult: 'va' },
    staticDir: 'no-such-dist-dir',
    logLesson: () => {},
  });
  const res = await app.inject({ method: 'GET', url: '/api/listen?profile=kid' });
  expect(res.statusCode).toBe(404);
});

describe('Origin 검사(다른 사이트가 키로 소리를 흘려보내지 못하게)', () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => vi.stubEnv('ALLOWED_HOSTS', 'mypc.local'));

  test.each([
    ['다른 사이트', { host: 'localhost:8788', origin: 'https://evil.example' }],
    ['같은 이름 다른 포트', { host: '192.168.0.5:8788', origin: 'http://192.168.0.5:9999' }],
    ['null', { host: 'localhost:8788', origin: 'null' }],
    ['기본 vite 포트가 아님', { host: 'localhost:8788', origin: 'http://localhost:5173' }],
    ['http인 ALLOWED_HOSTS 이름', { host: 'localhost:8787', origin: 'http://mypc.local' }],
    ['ALLOWED_HOSTS에 없는 이름', { host: 'localhost:8787', origin: 'https://other.example' }],
    ['목록에 없는 남의 ts.net', { host: 'localhost:8787', origin: 'https://evil.other.ts.net' }],
    ['ts.net처럼 보이는 이름', { host: 'localhost:8787', origin: 'https://evilts.net' }],
    ['ts.net인데 ALLOWED_HOSTS 없음/목록 밖', { host: 'localhost:8787', origin: 'https://pc.tail123.ts.net' }],
  ])('%s → 1008, STT를 열지 않는다', async (_n, headers) => {
    vi.stubEnv('PW_PORT', '5174');
    const { openStt } = make();
    const { msgs, closed } = await connect('/api/listen?profile=kid', headers);
    await vi.waitFor(() => expect(closed.code).toBe(1008));
    expect(openStt).not.toHaveBeenCalled();
    expect(msgs).toEqual([]);
  });

  test.each([
    ['Origin 없음(브라우저 아님)', {}],
    ['같은 호스트', { host: '192.168.0.5:8788', origin: 'http://192.168.0.5:8788' }],
    ['vite 개발 서버 localhost', { host: 'localhost:8788', origin: 'http://localhost:5174' }],
    ['vite 개발 서버 127.0.0.1', { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5174' }],
    ['ALLOWED_HOSTS 이름 Origin', { host: 'localhost:8787', origin: 'https://mypc.local' }],
  ])('%s → ready, 소리가 오면 STT를 연다', async (_n, headers) => {
    vi.stubEnv('PW_PORT', '5174');
    const { openStt } = make();
    const { ws, msgs } = await connect('/api/listen?profile=kid', headers);
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
    ws.send(Buffer.from([0, 0]));
    await vi.waitFor(() => expect(openStt).toHaveBeenCalledTimes(1));
  });

  test('tailscale serve: Host는 localhost, Origin이 ALLOWED_HOSTS의 https ts.net 이름이면 허용', async () => {
    vi.stubEnv('ALLOWED_HOSTS', 'mypc.local, pc.tail123.ts.net');
    make();
    const { msgs } = await connect('/api/listen?profile=kid', { host: 'localhost:8787', origin: 'https://pc.tail123.ts.net' });
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  });

  test('ALLOWED_HOSTS가 비어 있으면 ts.net Origin도 거절', async () => {
    vi.stubEnv('ALLOWED_HOSTS', '');
    const { openStt } = make();
    const { closed } = await connect('/api/listen?profile=kid', { host: 'localhost:8787', origin: 'https://pc.tail123.ts.net' });
    await vi.waitFor(() => expect(closed.code).toBe(1008));
    expect(openStt).not.toHaveBeenCalled();
  });

  test('ngrok: ALLOWED_HOSTS 없으면 그 Host는 /api/listen에서 403', async () => {
    vi.stubEnv('ALLOWED_HOSTS', '');
    const { openStt } = make();
    await app!.ready();
    const res = await app!.inject({ method: 'GET', url: '/api/listen?profile=kid', headers: { host: 'fam.ngrok-free.app', origin: 'https://fam.ngrok-free.app' } });
    expect(res.statusCode).toBe(403);
    expect(openStt).not.toHaveBeenCalled();
  });

  test('ngrok: ALLOWED_HOSTS에 적으면 Host·Origin이 그 도메인일 때 ready', async () => {
    vi.stubEnv('ALLOWED_HOSTS', 'fam.ngrok-free.app');
    make();
    const { msgs } = await connect('/api/listen?profile=kid', { host: 'fam.ngrok-free.app', origin: 'https://fam.ngrok-free.app' });
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  });

  test('ngrok: 다른 ngrok 이름의 Origin은 Host가 허용돼도 1008', async () => {
    vi.stubEnv('ALLOWED_HOSTS', 'fam.ngrok-free.app');
    const { openStt } = make();
    const { closed } = await connect('/api/listen?profile=kid', { host: 'fam.ngrok-free.app', origin: 'https://evil.ngrok-free.app' });
    await vi.waitFor(() => expect(closed.code).toBe(1008));
    expect(openStt).not.toHaveBeenCalled();
  });

  test('vite 개발 서버 [::1]도 허용', async () => {
    vi.stubEnv('PW_PORT', '5174');
    make();
    const { msgs } = await connect('/api/listen?profile=kid', { host: '[::1]:8788', origin: 'http://[::1]:5174' });
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  });

  test('vite 개발 서버 Origin [::1]은 Host가 달라도 허용(localhost와 같은 규칙)', async () => {
    vi.stubEnv('PW_PORT', '5174');
    make();
    const { msgs } = await connect('/api/listen?profile=kid', { host: 'localhost:8788', origin: 'http://[::1]:5174' });
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  });

  test('DNS rebinding: 공격자 도메인 Host+Origin → 핸드셰이크 전에 403, STT를 열지 않는다', async () => {
    const { openStt } = make();
    await app!.ready();
    await expect(
      app!.injectWS('/api/listen?profile=kid', { headers: { host: 'evil.example:8787', origin: 'http://evil.example:8787' } }),
    ).rejects.toThrow(/403/);
    expect(openStt).not.toHaveBeenCalled();
  });

  test('Host 없음 → 403', async () => {
    const { openStt } = make();
    await app!.ready();
    await expect(app!.injectWS('/api/listen?profile=kid', { headers: {} })).rejects.toThrow(/403/);
    expect(openStt).not.toHaveBeenCalled();
  });

  test('PW_PORT가 없으면 vite 기본 5173을 허용', async () => {
    vi.stubEnv('PW_PORT', undefined);
    make();
    const { msgs } = await connect('/api/listen?profile=kid', { host: 'localhost:8787', origin: 'http://localhost:5173' });
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  });
});

test('홀수 길이 바이너리는 끝 바이트를 버린다(PCM16 정렬), 1바이트는 보내지 않는다', async () => {
  const { stt } = make();
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  ws.send(Buffer.from([7]));
  ws.send(Buffer.from([1, 2, 3]));
  await vi.waitFor(() => expect(stt.session.sendAudio).toHaveBeenCalledTimes(1));
  expect(Array.from(stt.audio[0])).toEqual([1, 2]);
});

describe('서버 쪽 keepAlive', () => {
  afterEach(() => vi.useRealTimers());

  // vi.waitFor는 가짜 타이머를 스스로 앞당기므로, 여기서는 setImmediate로만 기다린다.
  async function until(cond: () => boolean) {
    for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond()).toBe(true);
  }

  test('세션이 열려 있을 때만: 10초 동안 소리·ping을 안 올리면 keepAlive, 올리면 다시 10초, 끊기면 멈춘다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { stt } = make();
    const { ws, msgs } = await connect();
    await until(() => msgs.some((m) => m.type === 'ready'));
    // 아직 소리가 없어 세션이 없다: keepAlive도 없다(ping도 STT로 가지 않는다)
    vi.advanceTimersByTime(10_000);
    ws.send(JSON.stringify({ type: 'ping' }));
    await new Promise((r) => setImmediate(r));
    expect(stt.session.keepAlive).not.toHaveBeenCalled();

    ws.send(Buffer.from([1, 2]));
    await until(() => stt.session.sendAudio.mock.calls.length === 1);
    vi.advanceTimersByTime(9_999);
    expect(stt.session.keepAlive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stt.session.keepAlive).toHaveBeenCalledTimes(1);

    ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => stt.session.keepAlive.mock.calls.length === 2);
    vi.advanceTimersByTime(9_999);
    expect(stt.session.keepAlive).toHaveBeenCalledTimes(2);

    ws.terminate();
    await until(() => stt.session.close.mock.calls.length > 0);
    vi.advanceTimersByTime(60_000);
    expect(stt.session.keepAlive).toHaveBeenCalledTimes(2);
  });

  test('30초 동안 소리가 없으면 STT 세션만 닫고(ping은 세지 않음), 다음 소리에서 다시 연다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { stt, openStt } = make();
    const { ws, msgs, closed } = await connect();
    await until(() => msgs.some((m) => m.type === 'ready'));
    ws.send(Buffer.from([1, 2]));
    await until(() => stt.session.sendAudio.mock.calls.length === 1);
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(10_000);
      ws.send(JSON.stringify({ type: 'ping' })); // 브라우저는 살아 있다
      await new Promise((r) => setImmediate(r));
    }
    vi.advanceTimersByTime(9_999);
    expect(stt.session.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stt.session.close).toHaveBeenCalledTimes(1);
    expect(closed.code).toBeUndefined(); // 브라우저 연결은 그대로

    // 세션이 없을 때 end·ping은 STT로 가지 않고, 닫힌 뒤엔 keepAlive도 없다
    const ka = stt.session.keepAlive.mock.calls.length;
    ws.send(JSON.stringify({ type: 'end' }));
    ws.send(JSON.stringify({ type: 'ping' }));
    await new Promise((r) => setImmediate(r));
    vi.advanceTimersByTime(10_000);
    expect(stt.session.commit).not.toHaveBeenCalled();
    expect(stt.session.keepAlive.mock.calls.length).toBe(ka);

    ws.send(Buffer.from([3, 4]));
    await until(() => stt.session.sendAudio.mock.calls.length === 2);
    expect(openStt).toHaveBeenCalledTimes(2);
    expect(stt.session.start).toHaveBeenCalledTimes(2);
    expect(Array.from(stt.audio[1])).toEqual([3, 4]);
  });

  test('브라우저가 45초 동안 아무것도 안 보내면 1001로 닫고 STT도 닫는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { stt } = make();
    const { ws, msgs, closed } = await connect();
    await until(() => msgs.some((m) => m.type === 'ready'));
    ws.send(Buffer.from([1, 2]));
    await until(() => stt.session.sendAudio.mock.calls.length === 1);
    vi.advanceTimersByTime(44_999);
    ws.send(JSON.stringify({ type: 'state', lessonActive: false, recentSpoken: [] })); // 어떤 메시지든 살아 있다는 뜻
    await new Promise((r) => setImmediate(r));
    vi.advanceTimersByTime(44_999);
    expect(closed.code).toBeUndefined();
    vi.advanceTimersByTime(1);
    // 메모리 스트림에서는 닫힘 핸드셰이크 마무리가 ws의 타이머에 걸려 있어 가짜 시간을 조금씩 앞당기며 기다린다.
    for (let i = 0; i < 200 && closed.code === undefined; i++) {
      vi.advanceTimersByTime(1_000);
      await new Promise((r) => setImmediate(r));
    }
    expect(closed.code).toBe(1001);
    expect(stt.session.close).toHaveBeenCalled();
  });
});

test('로그의 ms는 판정에 걸린 시간이다(앞 판정을 기다린 시간 제외)', async () => {
  const logListen = vi.fn();
  const { stt } = make({
    logListen,
    classify: async (i) => {
      if (i.text === '느림') await new Promise((r) => setTimeout(r, 150));
      return { accept: false, question: '', reason: 'model', complete: true };
    },
  });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onFinal('느림');
  stt.events().onFinal('빠름');
  await vi.waitFor(() => expect(logListen).toHaveBeenCalledTimes(2));
  const byText = Object.fromEntries(logListen.mock.calls.map(([e]) => [e.text, e.ms]));
  expect(byText['느림']).toBeGreaterThanOrEqual(140);
  expect(byText['빠름']).toBeLessThan(100);
});

test('끊기면 진행 중인 판정을 abort한다', async () => {
  let seen: AbortSignal | undefined;
  const { stt, classify } = make({
    classify: (_i, signal) => {
      seen = signal;
      return new Promise(() => {});
    },
  });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onFinal('근데 왜?');
  await vi.waitFor(() => expect(classify).toHaveBeenCalled());
  expect(seen).toBeInstanceOf(AbortSignal);
  expect(seen!.aborted).toBe(false);
  ws.terminate();
  await vi.waitFor(() => expect(seen!.aborted).toBe(true));
});

describe('폭주 막기(요금)', () => {
  test(`소리는 한꺼번에 ${LISTEN_AUDIO_BURST_BYTES}바이트(10초분)까지, 그 뒤로는 실시간의 2배까지만 STT로 보낸다`, async () => {
    const { stt } = make();
    const { ws, msgs } = await connect();
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
    for (let i = 0; i < 20; i++) ws.send(Buffer.alloc(64 * 1024)); // 1.3MB를 한꺼번에(실시간 40초분)
    ws.send(JSON.stringify({ type: 'end' }));
    await vi.waitFor(() => expect(stt.session.commit).toHaveBeenCalled());
    const sent = stt.audio.reduce((n, a) => n + a.length, 0);
    expect(sent).toBeLessThanOrEqual(LISTEN_AUDIO_BURST_BYTES + 64 * 1024);
    expect(sent).toBeGreaterThanOrEqual(LISTEN_AUDIO_BURST_BYTES - 64 * 1024);
  });

  test('보통 말(20ms 프레임)은 하나도 버리지 않는다', async () => {
    const { stt } = make();
    const { ws, msgs } = await connect();
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
    for (let i = 0; i < 25; i++) ws.send(Buffer.alloc(640)); // pre-roll 500ms
    for (let i = 0; i < 100; i++) ws.send(Buffer.alloc(640));
    ws.send(JSON.stringify({ type: 'end' }));
    await vi.waitFor(() => expect(stt.session.commit).toHaveBeenCalled());
    expect(stt.audio).toHaveLength(125);
  });

  test('ping을 퍼부어도 keepAlive(무음)는 같은 예산 안에서만', async () => {
    const { stt } = make();
    const { ws, msgs } = await connect();
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
    await openSession(ws, stt);
    for (let i = 0; i < 2000; i++) ws.send('{"type":"ping"}');
    ws.send(JSON.stringify({ type: 'end' }));
    await vi.waitFor(() => expect(stt.session.commit).toHaveBeenCalled());
    // 무음 하나는 3200바이트: 10초분 예산이면 100개 남짓
    expect(stt.session.keepAlive.mock.calls.length).toBeGreaterThan(0);
    expect(stt.session.keepAlive.mock.calls.length).toBeLessThanOrEqual(LISTEN_AUDIO_BURST_BYTES / 3200 + 5);
  });

  test(`듣기 연결은 동시에 ${LISTEN_MAX_SOCKETS}개까지, 넘치면 1013(나중에 다시)으로 닫고 하나가 끝나면 다시 받는다`, async () => {
    const { openStt } = make();
    const open: Awaited<ReturnType<typeof connect>>[] = [];
    for (let i = 0; i < LISTEN_MAX_SOCKETS; i++) {
      const c = await connect();
      await vi.waitFor(() => expect(c.msgs).toContainEqual({ type: 'ready' }));
      open.push(c);
    }
    const extra = await connect();
    await vi.waitFor(() => expect(extra.closed.code).toBe(1013));
    expect(extra.msgs).toEqual([]);
    extra.ws.send(Buffer.from([0, 0]));
    open[0].ws.terminate();
    await new Promise((r) => setTimeout(r, 20));
    const again = await connect();
    await vi.waitFor(() => expect(again.msgs).toContainEqual({ type: 'ready' }));
    expect(openStt).not.toHaveBeenCalled();
  });
});

test(`받아들인 질문은 ${MAX_QUESTION_CHARS}자로 자른다(수업 요청이 400으로 거절되지 않게)`, async () => {
  const { stt } = make({ classify: async () => ({ accept: true, question: '공'.repeat(MAX_QUESTION_CHARS + 300), reason: 'model', complete: true }) });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onFinal('공룡 얘기 해 줘');
  await vi.waitFor(() => expect(msgs.some((m) => m.type === 'utterance')).toBe(true));
  expect(msgs.find((m) => m.type === 'utterance').question).toHaveLength(MAX_QUESTION_CHARS);
});

// E7(2026-11-23): 받아 적었지만 질문이 아니라고 거절했거나(모델 판정) 받아쓰기가 비었으면 miss: true를 붙여,
// 브라우저가 연달아 못 알아들을 때 "다시 말해 줄래?"를 띄울 수 있게 한다. 감탄사·에코·이어 붙이기·판정 오류는 miss가 아니다.
test.each([
  ['질문이 아님(모델 거절)', { accept: false, question: '', reason: 'model', complete: true }, '음 그거 있잖아', true],
  // QA 2026-11-23: 빈 받아쓰기는 잡음(TV·청소기·소리 지름)이라 못 알아들은 말로 세지 않는다.
  ['받아쓰기가 빔(잡음)', { accept: false, question: '', reason: 'empty', complete: true }, '', false],
  ['감탄사', { accept: false, question: '', reason: 'exclaim', complete: true }, '우와', false],
  ['선생님 목소리(에코)', { accept: false, question: '', reason: 'echo', complete: true }, '달은 멀리 있어', false],
  ['받아들임', { accept: true, question: '달은 왜?', reason: 'model', complete: true }, '달은 왜', false],
] as const)('utterance miss 표시: %s', async (_n, verdict, text, miss) => {
  const { stt } = make({ classify: async () => ({ ...verdict }) });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onFinal(text);
  await vi.waitFor(() => expect(msgs.filter((m) => m.type === 'utterance')).toHaveLength(1));
  const u = msgs.find((m) => m.type === 'utterance');
  if (miss) expect(u.miss).toBe(true);
  else expect(u).not.toHaveProperty('miss');
});
test('판정 오류(던짐)는 miss가 아니다(못 들은 게 아니라 서버 문제)', async () => {
  const { stt } = make({ classify: async () => { throw new Error('boom'); } });
  const { ws, msgs } = await connect();
  await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
  await openSession(ws, stt);
  stt.events().onFinal('뭐야');
  await vi.waitFor(() => expect(msgs.filter((m) => m.type === 'utterance')).toHaveLength(1));
  expect(msgs.find((m) => m.type === 'utterance')).not.toHaveProperty('miss');
});

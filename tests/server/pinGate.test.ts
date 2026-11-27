// 가족 비밀번호 관문을 단 서버: /api/* HTTP와 /api/listen 업그레이드는 쿠키가 있어야, 정적 파일은 그대로.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/server/app';
import { PIN_COOKIE, PIN_COOKIE_MAX_AGE_S, PIN_GLOBAL_MAX_FAILS, PIN_LOCK_MS, PIN_MAX_FAILS } from '../../src/server/pin';
import type { Speech } from '../../src/shared/lesson';

const PIN = '864209';
const sp = (t: string): Speech => ({ audioBase64: t, mime: 'audio/mpeg', timing: { chars: [...t], startMs: [], endMs: [] }, durationMs: 100 });
async function* lines(...xs: string[]) { for (const x of xs) yield x + '\n'; }

let dir: string;
let app: FastifyInstance | undefined;
let logs: string[];
const openStt = vi.fn();
const speak = vi.fn(async (t: string) => sp(t));

function make(over: Partial<AppDeps> = {}) {
  logs = [];
  app = buildApp({
    scriptText: () => lines(JSON.stringify({ say: '하나' })),
    speak,
    voice: { kid: 'vk', adult: 'va' },
    fillerDir: dir,
    staticDir: join(dir, 'dist'),
    logLesson: () => {},
    logger: { level: 'debug', stream: { write: (s: string) => void logs.push(s) } },
    familyPin: PIN,
    listen: {
      openStt: openStt.mockImplementation(() => ({ start() {}, sendAudio() {}, commit() {}, keepAlive() {}, close() {} })),
      classify: async () => ({ accept: false, question: '', reason: 'model' as const, complete: true }),
    },
    ...over,
  });
  return app;
}

const HOST = { host: 'localhost:8787' };
const postPin = (pin: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app!.inject({ method: 'POST', url: '/api/pin', payload: { pin }, headers: { ...HOST, ...headers }, ...(remoteAddress ? { remoteAddress } : {}) });

/** 맞는 PIN을 넣고 받은 Cookie 머리글 값('tb_pin=...'). */
async function loginCookie(): Promise<string> {
  const res = await postPin(PIN);
  expect(res.statusCode).toBe(204);
  const set = String(res.headers['set-cookie']);
  return set.split(';')[0];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tb-pin-'));
  await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'dist')));
  await writeFile(join(dir, 'dist', 'index.html'), '<!doctype html><p>hi</p>');
  openStt.mockClear();
  speak.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

const lessonReq = { method: 'POST' as const, url: '/api/lesson', payload: { question: '하늘은 왜 파래?', profile: 'kid' } };

describe('쿠키가 없으면', () => {
  test.each([
    ['POST /api/lesson', lessonReq],
    ['GET /api/filler/kid', { method: 'GET' as const, url: '/api/filler/kid' }],
    ['GET /api/pin(확인용)', { method: 'GET' as const, url: '/api/pin' }],
    ['GET /api/없는길', { method: 'GET' as const, url: '/api/nope' }],
  ])('%s → 401', async (_n, req) => {
    make();
    const res = await app!.inject({ ...req, headers: HOST });
    expect(res.statusCode).toBe(401);
    expect(speak).not.toHaveBeenCalled();
  });

  test('/api/listen 업그레이드 거절(STT를 열지 않는다)', async () => {
    make();
    await app!.ready();
    await expect(app!.injectWS('/api/listen?profile=kid', { headers: HOST })).rejects.toThrow(/401/);
    expect(openStt).not.toHaveBeenCalled();
  });

  test('정적 파일은 그대로 열린다(PIN 화면을 보여야 하니까)', async () => {
    make();
    const res = await app!.inject({ method: 'GET', url: '/', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hi');
  });

  test('고친 쿠키도 401', async () => {
    make();
    const cookie = await loginCookie();
    // 마지막 글자는 base64의 남는 비트일 수 있어(바꿔도 같은 값) 가운데 글자를 바꾼다.
    const i = Math.floor(cookie.length * 0.75);
    const bad = cookie.slice(0, i) + (cookie[i] === 'A' ? 'B' : 'A') + cookie.slice(i + 1);
    const res = await app!.inject({ ...lessonReq, headers: { ...HOST, cookie: bad } });
    expect(res.statusCode).toBe(401);
  });
});

describe('쿠키가 있으면', () => {
  test('수업·채움 음성·확인이 통과한다', async () => {
    make();
    const cookie = await loginCookie();
    const lesson = await app!.inject({ ...lessonReq, headers: { ...HOST, cookie } });
    expect(lesson.statusCode).toBe(200);
    expect(lesson.body).toContain('"type":"done"');
    const filler = await app!.inject({ method: 'GET', url: '/api/filler/kid', headers: { ...HOST, cookie } });
    expect(filler.statusCode).toBe(200);
    const check = await app!.inject({ method: 'GET', url: '/api/pin', headers: { ...HOST, cookie } });
    expect(check.statusCode).toBe(204);
  });

  test('/api/listen 연결 → ready', async () => {
    make();
    const cookie = await loginCookie();
    await app!.ready();
    const msgs: unknown[] = [];
    const ws = await app!.injectWS('/api/listen?profile=kid', { headers: { ...HOST, cookie } }, {
      onInit: (w) => w.on('message', (d) => msgs.push(JSON.parse(d.toString()))),
    });
    await vi.waitFor(() => expect(msgs).toContainEqual({ type: 'ready' }));
    ws.terminate();
  });

  test('PIN을 바꿔 다시 띄우면(같은 PIN_SECRET) 예전 쿠키는 401', async () => {
    make({ pinSecret: 'keep' });
    const cookie = await loginCookie();
    await app!.close();
    make({ pinSecret: 'keep' });
    expect((await app!.inject({ method: 'GET', url: '/api/pin', headers: { ...HOST, cookie } })).statusCode).toBe(204);
    await app!.close();
    make({ pinSecret: 'keep', familyPin: '111222' });
    expect((await app!.inject({ method: 'GET', url: '/api/pin', headers: { ...HOST, cookie } })).statusCode).toBe(401);
  });
});

describe('POST /api/pin', () => {
  test('맞으면 204 + HttpOnly·SameSite=Lax·1년 쿠키(http면 Secure 없음)', async () => {
    make();
    const res = await postPin(PIN);
    expect(res.statusCode).toBe(204);
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(new RegExp(`^${PIN_COOKIE}=[^;]+; Path=/; Max-Age=${PIN_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax$`));
    expect(set).not.toContain(PIN);
  });

  test('TRUST_PROXY + loopback(ngrok)에서 X-Forwarded-Proto: https면 Secure', async () => {
    make({ trustProxy: true });
    const res = await postPin(PIN, { 'x-forwarded-proto': 'https' });
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure$/);
  });

  test('TRUST_PROXY가 없으면 loopback에서 온 X-Forwarded-Proto도 믿지 않는다', async () => {
    make();
    const res = await postPin(PIN, { 'x-forwarded-proto': 'https' });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).not.toContain('Secure');
  });

  test('TRUST_PROXY여도 loopback이 아닌 곳에서 온 X-Forwarded-Proto는 믿지 않는다', async () => {
    make({ trustProxy: true });
    const res = await postPin(PIN, { 'x-forwarded-proto': 'https' }, '192.168.0.9');
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).not.toContain('Secure');
  });

  test('틀리면 401, 모양이 이상하면 400', async () => {
    make();
    expect((await postPin('000000')).statusCode).toBe(401);
    expect((await postPin(864209)).statusCode).toBe(400);
    expect((await app!.inject({ method: 'POST', url: '/api/pin', payload: {}, headers: HOST })).statusCode).toBe(400);
  });

  test('5번 틀리면 429 + 남은 초, 10분 뒤 풀린다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    make();
    for (let i = 0; i < PIN_MAX_FAILS - 1; i++) expect((await postPin('000000')).statusCode).toBe(401);
    const locked = await postPin('000000');
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: 'locked', retryAfterSec: PIN_LOCK_MS / 1000 });
    expect(locked.headers['retry-after']).toBe(String(PIN_LOCK_MS / 1000));
    vi.advanceTimersByTime(60_000);
    const still = await postPin(PIN);
    expect(still.statusCode).toBe(429);
    expect(still.json().retryAfterSec).toBe(PIN_LOCK_MS / 1000 - 60);
    expect(still.headers['set-cookie']).toBeUndefined();
    vi.advanceTimersByTime(PIN_LOCK_MS);
    expect((await postPin(PIN)).statusCode).toBe(204);
  });

  test('잠금은 곳마다: TRUST_PROXY + loopback(ngrok) 뒤 X-Forwarded-For가 다르면 다른 곳', async () => {
    make({ trustProxy: true });
    const stranger = { 'x-forwarded-for': '203.0.113.9' };
    const family = { 'x-forwarded-for': '198.51.100.20' };
    for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('000000', stranger);
    expect((await postPin(PIN, stranger)).statusCode).toBe(429);
    expect((await postPin(PIN, family)).statusCode).toBe(204);
  });

  test('X-Forwarded-For는 마지막(우리 터널이 붙인) 주소만 본다: 앞쪽을 바꿔도 같은 곳', async () => {
    make({ trustProxy: true });
    for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('000000', { 'x-forwarded-for': `10.9.9.${i}, 203.0.113.9` });
    expect((await postPin(PIN, { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })).statusCode).toBe(429);
  });

  test('TRUST_PROXY가 없으면 loopback에서 와도 X-Forwarded-For는 무시한다(소켓 주소로 센다)', async () => {
    make();
    for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('000000', { 'x-forwarded-for': `10.0.0.${i}` });
    expect((await postPin(PIN, { 'x-forwarded-for': '198.51.100.20' })).statusCode).toBe(429);
    expect((await postPin(PIN, {}, '192.168.0.10')).statusCode).toBe(204);
  });

  test('TRUST_PROXY여도 loopback이 아닌 곳에서 온 X-Forwarded-For는 무시한다(소켓 주소로 센다)', async () => {
    make({ trustProxy: true });
    for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('000000', { 'x-forwarded-for': `10.0.0.${i}` }, '192.168.0.9');
    expect((await postPin(PIN, { 'x-forwarded-for': '10.0.0.99' }, '192.168.0.9')).statusCode).toBe(429);
    expect((await postPin(PIN, {}, '192.168.0.10')).statusCode).toBe(204);
  });

  test('여러 곳을 합친 한도를 넘으면 처음 오는 곳도 429', async () => {
    make({ trustProxy: true });
    for (let n = 0; n < PIN_GLOBAL_MAX_FAILS; n++) {
      await postPin('000000', { 'x-forwarded-for': `10.1.${Math.floor(n / (PIN_MAX_FAILS - 1))}.1` });
    }
    expect((await postPin(PIN, { 'x-forwarded-for': '198.51.100.20' })).statusCode).toBe(429);
  });

  test('잠겨도 이미 쿠키가 있는 기기는 그대로 쓴다', async () => {
    make({ trustProxy: true });
    const cookie = await loginCookie();
    for (let n = 0; n < PIN_GLOBAL_MAX_FAILS; n++) await postPin('000000', { 'x-forwarded-for': `10.2.${n}.1` });
    expect((await postPin(PIN)).statusCode).toBe(429); // 전체 잠금
    expect((await app!.inject({ ...lessonReq, headers: { ...HOST, cookie } })).statusCode).toBe(200);
  });

  test('성공·실패·잠금을 로그에 남기되 PIN 값은 절대 남기지 않는다', async () => {
    make();
    await postPin('123123');
    await postPin(PIN);
    for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('123123');
    const all = logs.join('\n');
    expect(all).toMatch(/pin ok/);
    expect(all).toMatch(/pin wrong/);
    expect(all).toMatch(/pin locked/);
    expect(all).not.toContain(PIN);
    expect(all).not.toContain('123123');
  });
});

describe('FAMILY_PIN이 비면 관문을 끈다', () => {
  test('쿠키 없이도 모든 기능이 열린다', async () => {
    make({ familyPin: '' });
    expect((await app!.inject({ ...lessonReq, headers: HOST })).statusCode).toBe(200);
    expect((await app!.inject({ method: 'GET', url: '/api/filler/kid', headers: HOST })).statusCode).toBe(200);
    expect((await app!.inject({ method: 'GET', url: '/api/pin', headers: HOST })).statusCode).toBe(204);
    expect((await postPin('whatever')).statusCode).toBe(204);
    await app!.ready();
    const ws = await app!.injectWS('/api/listen?profile=kid', { headers: HOST });
    ws.terminate();
  });

  test('familyPin을 안 주면(undefined) 꺼진 것과 같다', async () => {
    make({ familyPin: undefined });
    expect((await app!.inject({ method: 'GET', url: '/api/pin', headers: HOST })).statusCode).toBe(204);
  });
});

describe('경로 장난으로 관문을 피하지 못한다(회귀)', () => {
  test.each([
    ['HEAD', { method: 'HEAD' as const, url: '/api/filler/kid' }],
    ['OPTIONS', { method: 'OPTIONS' as const, url: '/api/lesson' }],
    ['인코딩한 /%61pi', { method: 'GET' as const, url: '/%61pi/filler/kid' }],
    ['인코딩한 /api%2Ffiller', { method: 'GET' as const, url: '/api%2Ffiller/kid' }],
    ['끝 슬래시', { method: 'GET' as const, url: '/api/filler/kid/' }],
    ['두 슬래시', { method: 'GET' as const, url: '//api/filler/kid' }],
    ['대문자', { method: 'GET' as const, url: '/API/filler/kid' }],
    ['쿼리', { method: 'GET' as const, url: '/api/filler/kid?x=/static' }],
  ])('%s → 401, 서버 기능은 안 돈다', async (_n, req) => {
    make();
    const res = await app!.inject({ ...req, headers: HOST });
    expect(res.statusCode).toBe(401);
    expect(speak).not.toHaveBeenCalled();
  });

  test('absolute-form 요청줄(GET http://host/api/...) → 401', async () => {
    make();
    const url = new URL(await app!.listen({ port: 0, host: '127.0.0.1' }));
    const CRLF = '\r\n';
    const status = await new Promise<string>((ok, fail) => {
      const sock = netConnect(Number(url.port), '127.0.0.1', () => {
        sock.write(
          [`GET http://localhost:${url.port}/api/filler/kid HTTP/1.1`, `Host: localhost:${url.port}`, 'Connection: close', '', ''].join(CRLF),
        );
      });
      let buf = '';
      sock.on('data', (d) => (buf += d.toString()));
      sock.on('end', () => ok(buf.split(CRLF)[0]));
      sock.on('error', fail);
    });
    expect(status).toMatch(/^HTTP\/1\.1 401/);
    expect(speak).not.toHaveBeenCalled();
  });

  test.each([
    ['인코딩한 /%61pi/listen', '/%61pi/listen?profile=kid'],
    ['끝 슬래시', '/api/listen/?profile=kid'],
  ])('웹소켓 %s → 업그레이드 거절, STT 안 엶', async (_n, path) => {
    make();
    await app!.ready();
    await expect(app!.injectWS(path, { headers: HOST })).rejects.toThrow(/401/);
    expect(openStt).not.toHaveBeenCalled();
  });

  test('전체 잠금 중에는 맞는 PIN도 429', async () => {
    make({ trustProxy: true });
    for (let n = 0; n < PIN_GLOBAL_MAX_FAILS; n++) {
      await postPin('000000', { 'x-forwarded-for': `10.3.${Math.floor(n / (PIN_MAX_FAILS - 1))}.1` });
    }
    const res = await postPin(PIN, { 'x-forwarded-for': '198.51.100.20' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

test('같은 이름 쿠키가 여럿이어도 하나가 맞으면 통과', async () => {
  make();
  const cookie = await loginCookie();
  const res = await app!.inject({ method: 'GET', url: '/api/pin', headers: { ...HOST, cookie: `${PIN_COOKIE}=old.garbage; ${cookie}` } });
  expect(res.statusCode).toBe(204);
});

test('TRUST_PROXY + loopback: X-Forwarded-Proto는 맨 오른쪽 값만 본다', async () => {
  make({ trustProxy: true });
  expect(String((await postPin(PIN, { 'x-forwarded-proto': 'https, http' })).headers['set-cookie'])).not.toContain('Secure');
  expect(String((await postPin(PIN, { 'x-forwarded-proto': 'http, https' })).headers['set-cookie'])).toMatch(/; Secure$/);
});

test('TRUST_PROXY + loopback: IP가 아닌 X-Forwarded-For는 소켓 주소로 센다', async () => {
  make({ trustProxy: true });
  for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('000000', { 'x-forwarded-for': `junk-${i}` });
  expect((await postPin(PIN, { 'x-forwarded-for': 'junk-x' })).statusCode).toBe(429);
});

test('TRUST_PROXY + loopback: 같은 IPv6 /64는 한 곳으로 센다', async () => {
  make({ trustProxy: true });
  for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('000000', { 'x-forwarded-for': `2001:db8:5:6::${i + 1}` });
  expect((await postPin(PIN, { 'x-forwarded-for': '2001:db8:5:6:ffff::9' })).statusCode).toBe(429);
  expect((await postPin(PIN, { 'x-forwarded-for': '2001:db8:5:7::1' })).statusCode).toBe(204);
});

describe('보안 QA(2026-11-22)', () => {
  test('쿠키 없는 거대한 수업 본문(1MB)은 본문을 읽기 전에 401(413 아님), 모델을 부르지 않는다', async () => {
    const scriptText = vi.fn(() => lines(JSON.stringify({ say: '하나' })));
    make({ scriptText });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', headers: HOST, payload: { question: 'a'.repeat(1_000_000), profile: 'kid' } });
    expect(res.statusCode).toBe(401);
    expect(scriptText).not.toHaveBeenCalled();
  });

  test.each([
    ['null', null], ['배열', ['864209']], ['객체', { v: '864209' }], ['33자', '8'.repeat(33)], ['불리언', true],
  ])('모양이 틀린 pin(%s)은 400이고 틀린 횟수에 세지 않는다(잠그지 않는다)', async (_n, pin) => {
    make();
    for (let i = 0; i < PIN_MAX_FAILS * 2; i++) expect((await postPin(pin)).statusCode).toBe(400);
    expect((await postPin(PIN)).statusCode).toBe(204);
  });

  test.each([
    ['text/plain', 'text/plain', `{"pin":"${PIN}"}`],
    ['폼', 'application/x-www-form-urlencoded', `pin=${PIN}`],
  ])('남의 페이지 단순 요청(%s)으로는 PIN을 넣을 수 없다(쿠키를 심지 않는다)', async (_n, type, payload) => {
    make();
    const res = await app!.inject({ method: 'POST', url: '/api/pin', headers: { ...HOST, 'content-type': type }, payload });
    expect([400, 415]).toContain(res.statusCode);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('앞뒤 공백이 붙은 PIN·전각 숫자는 틀린 PIN(같은 PIN으로 보지 않는다)', async () => {
    make();
    expect((await postPin(` ${PIN}`)).statusCode).toBe(401);
    expect((await postPin(PIN.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))))).statusCode).toBe(401);
  });

  test('다른 비밀(PIN_SECRET)로 서명한 쿠키·앞날 발급 시각·0을 덧붙인 시각 위조는 모두 401', async () => {
    make({ pinSecret: 'a'.repeat(40) });
    const other = (await loginCookie()).split('=')[1];
    await app!.close();
    make({ pinSecret: 'b'.repeat(40) });
    const mine = (await loginCookie()).split('=')[1];
    const [issued, sig] = mine.split('.');
    const check = (v: string) => app!.inject({ method: 'GET', url: '/api/pin', headers: { ...HOST, cookie: `${PIN_COOKIE}=${v}` } });
    expect((await check(mine)).statusCode).toBe(204);
    expect((await check(other)).statusCode).toBe(401);
    expect((await check(`${Number(issued) + 86_400}.${sig}`)).statusCode).toBe(401);
    expect((await check(`${issued}.${sig}=`)).statusCode).toBe(401);
    expect((await check(`${issued}.${sig.slice(0, -1)}`)).statusCode).toBe(401);
  });

  test('관문의 401·잠금 429 응답에도 보안 머리글이 붙고, 쿠키 응답은 저장하지 않게(no-store)', async () => {
    make();
    const denied = await app!.inject({ ...lessonReq, headers: HOST });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['x-frame-options']).toBe('DENY');
    expect(denied.headers['x-content-type-options']).toBe('nosniff');
    const ok = await postPin(PIN);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['x-frame-options']).toBe('DENY');
  });

  test('잠긴 동안 맞는 PIN과 틀린 PIN의 응답이 같다(맞았는지 새지 않는다)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    make();
    for (let i = 0; i < PIN_MAX_FAILS; i++) await postPin('000000');
    const right = await postPin(PIN);
    const wrong = await postPin('000000');
    expect(right.statusCode).toBe(429);
    expect(right.body).toBe(wrong.body);
    expect(right.headers['set-cookie']).toBeUndefined();
  });
});

// 운영 계측(G1 속도·H1 기기 오류·H2 원가): 계량기, 기기 보고 검사·횟수 제한, 수업 로그 줄, /api/client-log.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps, type ClientLogEntry, type LessonLog } from '../../src/server/app';
import { createArtist } from '../../src/server/artist';
import type { GenAI } from '../../src/server/gemini';
import { runLesson } from '../../src/server/lesson';
import { streamScriptText } from '../../src/server/teacher';
import {
  CLIENT_LOG_PER_MIN,
  CLIENT_LOG_PER_SEC,
  createRateLimiter,
  LessonMeter,
  lessonLogWithoutText,
  listenLogWithoutText,
  parseClientLog,
  RecentLessons,
  scrubText,
  usageFrom,
} from '../../src/server/telemetry';
import { PIN_LENGTH } from '../../src/server/pin';
import { UtteranceJoiner } from '../../src/server/utteranceJoiner';
import { CLIENT_LOG_MAX_BYTES, questionKey } from '../../src/shared/clientLog';
import type { Speech } from '../../src/shared/lesson';
import type { FigureOp } from '../../src/shared/script';

const PIN = '864209';
const sp = (t: string): Speech => ({ audioBase64: t, mime: 'audio/mpeg', timing: { chars: [...t], startMs: [], endMs: [] }, durationMs: 100 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const SAY = (t: string) => JSON.stringify({ say: t });
const DRAW = JSON.stringify({ draw: { kind: 'text', role: 'title', text: '제목', ink: 'black' } });
const ORDER = (id: string) => JSON.stringify({ sketch: { id, size: 'small', describe: `${id} 그림` } });
const FIG = (id: string): FigureOp => ({ kind: 'figure', id, size: 'small', ink: 'black', strokes: [{ d: 'M10 10 L20 20', ink: 'black' }], labels: [] });

describe('계량기와 도우미', () => {
  test('usageFrom: usageMetadata → 입력·출력·생각·캐시 토큰(없으면 null)', () => {
    expect(usageFrom(undefined, 'm')).toBeNull();
    expect(usageFrom({ promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 40, cachedContentTokenCount: 1000 }, 'gemini-3.8-flash')).toEqual({
      model: 'gemini-3.8-flash', input: 1200, output: 300, thoughts: 40, cached: 1000,
    });
    expect(usageFrom({ candidatesTokenCount: -3 }, 'm')).toEqual({ model: 'm', input: 0, output: 0, thoughts: 0, cached: 0 });
  });

  test('LessonMeter: 단계 시각은 처음 한 번만, 화가 호출·TTS 글자는 더한다', () => {
    let now = 100;
    const m = new LessonMeter('eleven_v4_turbo', 100, () => now);
    now = 350;
    m.mark('firstChunkMs');
    now = 900;
    m.mark('firstChunkMs');
    m.mark('firstLineMs');
    m.artistCall({ model: 'a', input: 10, output: 5, thoughts: 1, cached: 2 });
    m.artistCall(null);
    m.ttsCall(12);
    m.ttsCall(8);
    expect(m.stages()).toEqual({ firstChunkMs: 250, firstLineMs: 800, firstTtsMs: null, firstDrawMs: null, scriptEndMs: null });
    expect(m.usage()).toEqual({
      teacher: null,
      artist: { calls: 2, input: 10, output: 5, thoughts: 1, cached: 2, model: 'a' },
      tts: { model: 'eleven_v4_turbo', calls: 2, chars: 20 },
    });
  });

  test('RecentLessons: 같은 질문의 수업을 한 번만 잇고(물어본 때가 모르면 먼저 시작한 것부터), 오래되면 잊는다', () => {
    let now = 0;
    const r = new RecentLessons(3, 1000, () => now);
    r.add('L1', 'aaaa0000');
    r.add('L2', 'aaaa0000');
    r.add('L3', 'bbbb0000');
    expect(r.claim('aaaa0000')).toBe('L1');
    expect(r.claim('aaaa0000')).toBe('L2');
    expect(r.claim('aaaa0000')).toBeNull();
    now = 2000;
    expect(r.claim('bbbb0000')).toBeNull();
    for (const id of ['A', 'B', 'C', 'D']) r.add(id, 'cccc0000');
    expect([r.claim('cccc0000'), r.claim('cccc0000'), r.claim('cccc0000'), r.claim('cccc0000')]).toEqual(['B', 'C', 'D', null]);
  });

  test('RecentLessons: 같은 질문이 겹쳐도 보고의 물어본 때(받은 때 − endMs)에 가장 가까운 수업에 잇는다', () => {
    let now = 0;
    const r = new RecentLessons(64, 30 * 60_000, () => now);
    const k = questionKey('왜 하늘은 파래?');
    // 두 기기: A가 0초에 깊게(90초), B가 5초에 빠르게(20초). B가 먼저 끝나 먼저 보고한다(끝난 뒤 2초쯤 묶어 보냄).
    r.add('A', k);
    now = 5_000;
    r.add('B', k);
    now = 27_000;
    expect(r.claim(k, 20_000)).toBe('B');
    now = 92_000;
    expect(r.claim(k, 90_000)).toBe('A');
    // 한 기기에서 같은 질문을 1초 만에 다시 물음: 끊긴 첫 수업(1초)과 두 번째 수업의 보고가 차례로 온다.
    now = 100_000;
    r.add('R1', k);
    now = 101_000;
    r.add('R2', k);
    now = 103_000;
    expect(r.claim(k, 1_000)).toBe('R1');
    now = 125_000;
    expect(r.claim(k, 24_000)).toBe('R2');
  });

  test('RecentLessons: 물어본 때와 동떨어진 옛 수업에는 잇지 않는다(그 보고의 수업이 서버에 닿지 않았을 때)', () => {
    let now = 0;
    const r = new RecentLessons(64, 30 * 60_000, () => now);
    const k = questionKey('번개는 왜 쳐?');
    r.add('old', k); // 보고가 사라진 옛 수업
    now = 20 * 60_000;
    expect(r.claim(k, 15_000)).toBeNull(); // 20분 뒤의 15초짜리 수업 보고(그 수업은 400·429로 서버에 안 닿음)
    expect(r.claim(k)).toBe('old'); // 물어본 때를 모르면(endMs 없음) 예전처럼 잇는다
  });

  test('횟수 제한: 한 곳마다 초당·분당, 다른 곳은 따로', () => {
    let now = 0;
    const allow = createRateLimiter({ now: () => now });
    const burst = Array.from({ length: CLIENT_LOG_PER_SEC + 2 }, () => allow('a'));
    expect(burst.filter(Boolean)).toHaveLength(CLIENT_LOG_PER_SEC);
    expect(allow('b')).toBe(true);
    let ok = CLIENT_LOG_PER_SEC;
    for (let s = 1; s < 59; s++) {
      now = s * 1000;
      for (let i = 0; i < CLIENT_LOG_PER_SEC; i++) if (allow('a')) ok++;
    }
    expect(ok).toBe(CLIENT_LOG_PER_MIN);
    now = 61_000;
    expect(allow('a')).toBe(true);
  });

  test('scrubText: 주소 쿼리, 긴 토큰(키·쿠키 모양), 따로 떨어진 6자리 숫자를 지우고 자른다', () => {
    const s = scrubText(
      'boom at https://x.ngrok.app/api/lesson?pin=123456#frag key=' + 'AIza' + 'SyA1234567890abcdefghijklmnopqrstu' + ' pin 482915 at main.js:12:345678',
      400,
    );
    expect(s).not.toContain('pin=123456');
    expect(s).not.toContain('AIzaSy');
    expect(s).not.toContain('482915');
    expect(s).toContain('https://x.ngrok.app/api/lesson');
    expect(s).toContain('main.js:12:345678'); // 스택의 줄·칸 번호는 남긴다
    expect(scrubText('a'.repeat(10) + '\u0000b', 5)).toBe('aaaaa');
  });

  test('scrubText: 쌍점 뒤 PIN(pin:123456)도 지우고, 스택 줄·칸 번호·소수점 아래는 남긴다. PIN 길이는 PIN_LENGTH를 따른다', () => {
    const pin = '7'.repeat(PIN_LENGTH);
    expect(scrubText(`pin:${pin}`, 100)).toBe('pin:[n]');
    expect(scrubText(`code=${pin}.`, 100)).toBe('code=[n].');
    expect(scrubText('draw@https://h/assets/index.js:123456:7', 100)).toBe('draw@https://h/assets/index.js:123456:7');
    expect(scrubText('at f (https://h/assets/index-a1b2.js:1:234567)', 100)).toBe('at f (https://h/assets/index-a1b2.js:1:234567)');
    expect(scrubText('2026-11-23T09:12:34.123456Z', 100)).toBe('2026-11-23T09:12:34.123456Z');
    expect(scrubText('1234567 12345', 100)).toBe('1234567 12345'); // PIN 길이가 아닌 숫자
  });

  test('scrubText: 로그 보는 화면을 속이는 글자(C1 제어·CSI, 방향 바꿈, 줄·문단 구분자)도 지운다. 스택의 줄바꿈·탭은 남긴다', () => {
    const s = scrubText('a\u009b31mb\u001b[2Jc\u202ed\u2066e\u2028f\u2029g\u200fh\ni\tj\rk', 100);
    expect(s).toBe('a 31mb [2Jc d e f g h\ni\tj k');
  });

  test('withoutText: LOG_TEXT=0이면 수업 줄의 질문·듣기 줄의 들은 말을 빼고 글자 수만 남긴다', () => {
    const lesson = { question: '우리 집 주소는?', qChars: 9, lessonId: 'abc' };
    expect(lessonLogWithoutText(lesson)).toEqual({ qChars: 9, lessonId: 'abc' });
    expect(JSON.stringify(lessonLogWithoutText(lesson))).not.toContain('주소');
    const listen = { text: '엄마 이름은 김영희', accept: false, reason: 'model' as const, ms: 10, sttMs: 20 };
    expect(listenLogWithoutText(listen)).toEqual({ chars: 10, accept: false, reason: 'model', ms: 10, sttMs: 20 });
  });

  test('parseClientLog: 정해진 필드만 남기고, 틀린 사건은 그것만 버린다', () => {
    const evs = parseClientLog({
      events: [
        { kind: 'error', message: 'x is undefined', stack: 'at f (main.ts:1:2)', count: 3, state: 'lesson', ua: 'iPad Safari 18', question: '비밀 질문', cookie: 'tb_pin=zzz', where: 'Bad Where!' },
        { kind: 'app', message: 'lesson-error', where: 'lesson', count: 0 },
        { kind: 'nope', message: 'x' },
        { kind: 'lesson', qKey: 'deadbeef', qChars: 7, mode: 'deep', spoken: true, firstSoundMs: 1200, firstStrokeMs: null, endMs: 9000, result: 'done', text: '대사' },
        { kind: 'lesson', qKey: 'nothex!!', qChars: 7, mode: 'quick', spoken: false, firstSoundMs: 1, firstStrokeMs: 1, endMs: 1, result: 'done' },
        { kind: 'lesson', qKey: 'deadbeef', qChars: 7, mode: 'quick', spoken: false, firstSoundMs: -1, firstStrokeMs: 1, endMs: 1, result: 'done' },
      ],
    });
    expect(evs).toEqual([
      { kind: 'error', message: 'x is undefined', stack: 'at f (main.ts:1:2)', count: 3, state: 'lesson', ua: 'iPad Safari 18' },
      { kind: 'app', message: 'lesson-error', where: 'lesson', count: 1 },
      { kind: 'lesson', qKey: 'deadbeef', qChars: 7, mode: 'deep', spoken: true, firstSoundMs: 1200, firstStrokeMs: null, endMs: 9000, result: 'done' },
    ]);
    expect(parseClientLog({ events: [] })).toBeNull();
    expect(parseClientLog({ events: Array(9).fill({ kind: 'error', message: 'x' }) })).toBeNull();
    expect(parseClientLog('x')).toBeNull();
  });
});

describe('대본·화가·수업·받아쓰기의 계측 지점', () => {
  test('선생님: 스트림의 마지막 usageMetadata(누적)로 onUsage를 한 번 부른다', async () => {
    const chunks = [
      { text: '{"say":', usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 2 } },
      { text: '"안녕"}\n', usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 9, thoughtsTokenCount: 120, cachedContentTokenCount: 4096 } },
    ];
    const client = { models: { generateContentStream: async () => (async function* () { yield* chunks; })(), generateContent: async () => { throw new Error('x'); } } } as unknown as GenAI;
    const seen: unknown[] = [];
    for await (const _ of streamScriptText('q', 'kid', new AbortController().signal, client, undefined, undefined, 'quick', undefined, (u) => seen.push(u))) { /* 다 읽기 */ }
    expect(seen).toEqual([{ model: 'gemini-3.8-flash', input: 5000, output: 9, thoughts: 120, cached: 4096 }]);
  });

  test('화가: 실제 Gemini 호출만 meter로 센다(캐시·같은 주문을 기다리는 호출은 안 셈), 실패한 호출도 센다', async () => {
    const GOOD = { kind: 'figure', id: 'x', size: 'small', ink: 'black', strokes: [{ d: 'M10 10 L20 20', ink: 'black' }], labels: [] };
    let calls = 0;
    const client = {
      models: {
        generateContent: async (p: { contents: { parts: { text: string }[] }[] }) => {
          calls++;
          if (p.contents[0].parts[0].text.includes('실패')) throw new Error('boom');
          return { text: JSON.stringify(GOOD), candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 400 } };
        },
        generateContentStream: async () => { throw new Error('x'); },
      },
    } as unknown as GenAI;
    const artist = createArtist({ client, model: 'gemini-3.8-flash' });
    const sig = new AbortController().signal;
    const o = { id: 's1', size: 'small' as const, describe: '물방울' };
    const m1 = vi.fn();
    const m2 = vi.fn();
    const m3 = vi.fn();
    await Promise.all([artist(o, sig, m1), artist({ ...o, id: 's2' }, sig, m2)]); // 둘째는 같은 작업을 함께 기다림
    await artist({ ...o, id: 's3' }, sig, m3); // 캐시
    expect(calls).toBe(1);
    expect(m1).toHaveBeenCalledExactlyOnceWith({ model: 'gemini-3.8-flash', input: 6000, output: 400, thoughts: 0, cached: 0 });
    expect(m2).not.toHaveBeenCalled();
    expect(m3).not.toHaveBeenCalled();
    const mf = vi.fn();
    await artist({ id: 'f', size: 'small', describe: '실패' }, sig, mf);
    expect(mf).toHaveBeenCalledExactlyOnceWith(null);
  });

  test('수업: 첫 올바른 대본 줄에서 onFirstLine을 한 번(깨진 줄은 세지 않음)', async () => {
    const onFirstLine = vi.fn();
    async function* src() { yield 'not json\n'; yield SAY('하나') + '\n'; yield SAY('둘') + '\n'; }
    for await (const _ of runLesson({ scriptText: src(), speak: async (t) => sp(t), onFirstLine })) { /* 다 읽기 */ }
    expect(onFirstLine).toHaveBeenCalledTimes(1);
  });

  test('받아쓰기: end부터 확정(final)까지 걸린 시간을 sttMs로 알린다', async () => {
    let now = 0;
    const out: number[] = [];
    const j = new UtteranceJoiner({
      classify: async (text) => ({ accept: true, question: text, reason: 'model', complete: true }),
      emit: (_t, _v, _ms, sttMs) => out.push(sttMs),
      now: () => now,
    });
    j.audio();
    j.end();
    now = 700;
    j.final('달은 왜 따라와?');
    await vi.waitFor(() => expect(out).toEqual([700]));
  });
});

describe('서버: 수업 로그 줄과 /api/client-log', () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-tel-')); });
  afterEach(async () => { await app?.close(); app = undefined; await rm(dir, { recursive: true, force: true }); });

  const make = (over: Partial<AppDeps> = {}) =>
    (app = buildApp({
      scriptText: async function* () { yield SAY('하나') + '\n'; },
      speak: async (t) => sp(t),
      voice: { kid: 'vk', adult: 'va' },
      fillerDir: dir,
      staticDir: join(dir, 'no-dist'),
      logLesson: () => {},
      ...over,
    }));
  const HOST = { host: 'localhost:8787' };
  async function login(): Promise<string> {
    const res = await app!.inject({ method: 'POST', url: '/api/pin', payload: { pin: PIN }, headers: HOST });
    return String(res.headers['set-cookie']).split(';')[0];
  }

  test('수업 줄: lessonId·말로 물음·질문 글자 수·단계별 시간·토큰·화가 호출·TTS 글자 수(질문 맞춤 열쇠는 없음)', async () => {
    const logLesson = vi.fn<(e: LessonLog) => void>();
    make({
      scriptText: async function* (_q, _p, _s, _c, _h, _m, _l, onUsage) {
        await tick(5);
        yield SAY('안녕하세요') + '\n' + ORDER('물') + '\n';
        await tick(5);
        yield DRAW + '\n' + SAY('둘') + '\n';
        onUsage?.({ model: 'gemini-3.8-flash', input: 5000, output: 700, thoughts: 90, cached: 4000 });
      },
      speak: async (t) => { await tick(5); return sp(t); },
      drawSketch: async (o, _s, meter) => { meter?.({ model: 'gemini-3.8-flash', input: 6000, output: 400, thoughts: 10, cached: 0 }); return FIG(o.id); },
      logLesson,
    });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '  달은 왜 따라와?  ', profile: 'kid', heard: '달은 왜 따라와' } });
    expect(res.statusCode).toBe(200);
    const e = logLesson.mock.calls[0][0];
    expect(res.headers['x-lesson-id']).toBe(e.lessonId);
    expect(e.lessonId).toMatch(/^[\w-]{8}$/);
    expect(e).toMatchObject({ spoken: true, qChars: 9 });
    const st = e.stages;
    for (const k of ['firstChunkMs', 'firstLineMs', 'firstTtsMs', 'firstDrawMs', 'scriptEndMs'] as const) expect(st[k]).toEqual(expect.any(Number));
    expect(st.firstChunkMs!).toBeLessThanOrEqual(st.firstLineMs!);
    expect(st.firstLineMs!).toBeLessThanOrEqual(st.firstTtsMs!);
    expect(st.firstTtsMs!).toBeLessThanOrEqual(e.firstSayMs!);
    expect(e.firstSayMs!).toBeLessThanOrEqual(st.firstDrawMs!);
    expect(st.firstDrawMs!).toBeLessThanOrEqual(e.totalMs);
    expect(e.usage).toEqual({
      teacher: { model: 'gemini-3.8-flash', input: 5000, output: 700, thoughts: 90, cached: 4000 },
      artist: { calls: 1, input: 6000, output: 400, thoughts: 10, cached: 0, model: 'gemini-3.8-flash' },
      tts: { model: 'eleven_v4_turbo', calls: 2, chars: 6 },
    });
    expect(JSON.stringify(e)).not.toContain(questionKey('달은 왜 따라와?'));
  });

  test('글로 물은 수업: spoken false, 판서·토큰이 없으면 null', async () => {
    const logLesson = vi.fn<(e: LessonLog) => void>();
    make({ logLesson });
    await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '왜?', profile: 'adult' } });
    const e = logLesson.mock.calls[0][0];
    expect(e).toMatchObject({ spoken: false, qChars: 2, usage: { teacher: null, artist: { calls: 0 }, tts: { calls: 1, chars: 2 } } });
    expect(e.stages.firstDrawMs).toBeNull();
  });

  test('client-log: PIN 쿠키가 없으면 401, 있으면 204로 받아 정해진 필드만 남긴다', async () => {
    const seen: ClientLogEntry[] = [];
    make({ familyPin: PIN, logClient: (e) => seen.push(e) });
    const payload = { events: [{ kind: 'rejection', message: 'Load failed', count: 2, state: 'lesson', ua: 'iPad Safari 18', question: '비밀 질문' }] };
    const no = await app!.inject({ method: 'POST', url: '/api/client-log', payload, headers: HOST });
    expect(no.statusCode).toBe(401);
    expect(seen).toEqual([]);
    const cookie = await login();
    const ok = await app!.inject({ method: 'POST', url: '/api/client-log', payload, headers: { ...HOST, cookie } });
    expect(ok.statusCode).toBe(204);
    expect(seen).toEqual([{ kind: 'error', event: { kind: 'rejection', message: 'Load failed', count: 2, state: 'lesson', ua: 'iPad Safari 18' } }]);
  });

  test('client-log: 기본 로거 줄에는 질문 원문·쿠키·PIN이 없다', async () => {
    const logs: string[] = [];
    make({ familyPin: PIN, logger: { level: 'info', stream: { write: (s) => void logs.push(s) } } });
    const cookie = await login();
    await app!.inject({
      method: 'POST', url: '/api/client-log', headers: { ...HOST, cookie },
      payload: { events: [{ kind: 'error', message: `bad ${PIN}`, question: '우리 집 주소는' }] },
    });
    const line = logs.find((l) => l.includes('client error'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!).clientError).toEqual({ kind: 'error', message: 'bad [n]', count: 1 });
    const all = logs.join('\n');
    expect(all).not.toContain(PIN);
    expect(all).not.toContain('우리 집 주소는');
    expect(all).not.toContain(cookie.split('=')[1]);
  });

  test('client-log: 4KB를 넘으면 413, 모양이 틀리면 400', async () => {
    const seen: ClientLogEntry[] = [];
    make({ logClient: (e) => seen.push(e) });
    const big = await app!.inject({ method: 'POST', url: '/api/client-log', headers: HOST, payload: { events: [{ kind: 'error', message: 'x'.repeat(CLIENT_LOG_MAX_BYTES) }] } });
    expect(big.statusCode).toBe(413);
    const bad = await app!.inject({ method: 'POST', url: '/api/client-log', headers: HOST, payload: { nope: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  test('client-log: 한 곳에서 초당 한도를 넘으면 429(기록 없음)', async () => {
    const seen: ClientLogEntry[] = [];
    make({ logClient: (e) => seen.push(e) });
    const codes: number[] = [];
    for (let i = 0; i < CLIENT_LOG_PER_SEC + 3; i++) {
      const r = await app!.inject({ method: 'POST', url: '/api/client-log', headers: HOST, payload: { events: [{ kind: 'error', message: 'x' }] } });
      codes.push(r.statusCode);
    }
    // 같은 초 안이라고 단정할 수 없으니(느린 기계) 한도보다 많이 받지 않았는지만 본다.
    expect(codes.filter((c) => c === 204).length).toBeLessThanOrEqual(CLIENT_LOG_PER_SEC * 2);
    expect(codes).toContain(429);
    expect(seen.length).toBe(codes.filter((c) => c === 204).length);
  });

  test('client-log: 체감 시간은 같은 질문의 수업 id에 이어 남는다(qKey는 남기지 않음)', async () => {
    const logLesson = vi.fn<(e: LessonLog) => void>();
    const seen: ClientLogEntry[] = [];
    make({ logLesson, logClient: (e) => seen.push(e) });
    await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '번개는 왜 쳐?', profile: 'kid', mode: 'deep' } });
    const lessonId = logLesson.mock.calls[0][0].lessonId;
    const ev = { kind: 'lesson', qKey: questionKey(' 번개는 왜 쳐? '), qChars: 7, mode: 'deep', spoken: false, firstSoundMs: 2100, firstStrokeMs: 2400, endMs: 30000, result: 'done', ua: 'iPad Safari 18' };
    const r = await app!.inject({ method: 'POST', url: '/api/client-log', headers: HOST, payload: { events: [ev, { ...ev, qKey: '00000000' }] } });
    expect(r.statusCode).toBe(204);
    expect(seen).toEqual([
      { kind: 'lesson', event: { lessonId, qChars: 7, mode: 'deep', spoken: false, firstSoundMs: 2100, firstStrokeMs: 2400, endMs: 30000, result: 'done', ua: 'iPad Safari 18' } },
      { kind: 'lesson', event: { lessonId: null, qChars: 7, mode: 'deep', spoken: false, firstSoundMs: 2100, firstStrokeMs: 2400, endMs: 30000, result: 'done', ua: 'iPad Safari 18' } },
    ]);
  });

  test('client-log: 브라우저가 x-lesson-id를 실어 보내면 그 수업에 바로 잇는다 — 같은 질문을 곧바로 다시 물어도 뒤바뀌지 않는다', async () => {
    const logLesson = vi.fn<(e: LessonLog) => void>();
    const seen: ClientLogEntry[] = [];
    make({ logLesson, logClient: (e) => seen.push(e) });
    const r1 = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '달은 왜 따라와?', profile: 'kid' } });
    const r2 = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: '달은 왜 따라와?', profile: 'kid' } });
    const [id1, id2] = [String(r1.headers['x-lesson-id']), String(r2.headers['x-lesson-id'])];
    const ev = (lessonId: string | undefined, result: string) => ({
      kind: 'lesson', ...(lessonId ? { lessonId } : {}), qKey: questionKey('달은 왜 따라와?'), qChars: 8, mode: 'quick', spoken: false,
      firstSoundMs: null, firstStrokeMs: null, endMs: 500, result,
    });
    // 두 보고가 같은 순간 거꾸로 와도(취소된 첫 수업 보고가 뒤) 각자의 id에 붙는다.
    await app!.inject({ method: 'POST', url: '/api/client-log', headers: HOST, payload: { events: [ev(id2, 'done'), ev(id1, 'aborted')] } });
    expect(seen.map((e) => e.kind === 'lesson' && [e.event.lessonId, e.event.result])).toEqual([[id2, 'done'], [id1, 'aborted']]);
    // 이미 이어진 id·모르는 id는 다시 잇지 않는다(qKey로도 다른 수업에 붙지 않는다).
    seen.length = 0;
    await app!.inject({ method: 'POST', url: '/api/client-log', headers: HOST, payload: { events: [ev(id1, 'done'), ev('zzzzzzzz', 'done')] } });
    expect(seen.map((e) => e.kind === 'lesson' && e.event.lessonId)).toEqual([null, null]);
    expect(JSON.stringify(seen)).not.toContain('qKey');
  });
});

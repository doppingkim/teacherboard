import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isIP, isIPv6 } from 'node:net';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { LESSON_MODES, LEVELS, MAX_CONTEXT_SPOKEN, MAX_QUESTION_CHARS, MAX_SPOKEN_CHARS, defaultLevel, isLang, type Lang, type LessonContext, type LessonMode, type Level, type Speech } from '../shared/lesson';
import type { FigureOp, Profile, SketchOrder } from '../shared/script';
import { CLIENT_LOG_MAX_BYTES, charCount, questionKey, type ClientErrorEvent, type ClientLessonEvent } from '../shared/clientLog';
import type { ArtistMeter } from './artist';
import type { ClassifyInput, Verdict } from './classify';
import { getFillers } from './fillers';
import { runLesson } from './lesson';
import { parseLessonContext } from './lessonContext';
import { createPinGate, forwardedHttps, PIN_COOKIE, PIN_COOKIE_MAX_AGE_S, pinClientKey, type PinGate } from './pin';
import type { ScribeSession } from './stt';
import { UtteranceJoiner, type JoinedVerdict } from './utteranceJoiner';
import { createRateLimiter, LessonMeter, parseClientLog, RecentLessons, type LessonStages, type LessonUsage, type ModelUsage } from './telemetry';
import { describeTtsError, MODEL_ID as TTS_MODEL_ID } from './tts';

const FILLER_TTS_TIMEOUT_MS = 30_000;
/** 수업 요청 본문 한도. 질문·heard·문맥이 모두 한도를 꽉 채운 한글(UTF-8 3바이트)이면 약 19KB라 넉넉히 잡는다. 다른 요청은 16KB. */
const LESSON_BODY_LIMIT = 64 * 1024;
/** 한꺼번에 돌 수 있는 수업 수(모델·TTS 비용 폭주 막이). 가족 기기 몇 대가 동시에 물어도 남는다. 넘으면 429 busy. */
export const MAX_CONCURRENT_LESSONS = 6;
/**
 * 모든 응답에 붙이는 보안 머리글. 스크립트·폰트 출처는 막지 않는다(폰트 CDN 등) —
 * 남의 페이지에 끼워 넣기(클릭재킹), MIME 추측, <base> 바꿔치기, 주소 새기만 막는다.
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'referrer-policy': 'same-origin',
} as const;
/** 터널·프록시가 붙이는 머리글. 관문이 꺼져 있는데 이것이 오면 밖에서 온 요청이다. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'] as const;

export type LessonLog = {
  /** 질문 원문. 기본(LOG_TEXT 켜짐)은 남고, LOG_TEXT=0이면 index.ts가 빼고 qChars만 남긴다(telemetry.ts lessonLogWithoutText). */
  question: string;
  profile: Profile;
  mode: LessonMode;
  level: Level;
  /** 수업 언어(ko가 아니면만 남긴다). */
  lang?: Lang;
  firstSayMs: number | null;
  totalMs: number;
  says: number;
  droppedLines: number;
  /** 실패한 TTS 호출 수(그 문장은 소리 없이 자막만 나간다). */
  ttsFailures: number;
  /** 첫 TTS 실패 원인(예: "TtsError 429: ElevenLabs 429: ..."). 키는 담기지 않는다. */
  ttsError?: string;
  /** 그림 주문 수. */
  sketches: number;
  /** figure: null로 나간 주문 수(화가 실패·시간 초과). 연결 끊김으로 버린 것은 빼고. */
  sketchFailures: number;
  /** 결과가 나온 주문마다 걸린 ms(자리 대기 포함), 끝난 순서대로. 실패 이유는 화가 onError가 따로 남긴다. */
  sketchMs: number[];
  error?: string;
  /** 이 수업의 짧은 id. 브라우저 체감 시간 줄(client lesson)이 같은 id를 단다. */
  lessonId: string;
  /** 말로 물었나(heard가 있었나). 말로 물었으면 받아쓰기·판정 시간은 listen 줄에 따로 있다. */
  spoken: boolean;
  /** 질문 글자 수(원문을 끈 LOG_TEXT=0에서도 남는다). */
  qChars: number;
  /** 단계별 시간(요청을 받은 때부터 ms). */
  stages: LessonStages;
  /** 원가 재료: 토큰·호출 수·TTS 글자 수. */
  usage: LessonUsage;
};

/** 기기 보고(POST /api/client-log) 한 건의 서버 로그. 질문 맞춤 열쇠(qKey)는 빼고 수업 id로 바꿔 단다. */
export type ClientLogEntry =
  | { kind: 'error'; event: ClientErrorEvent }
  | { kind: 'lesson'; event: Omit<ClientLessonEvent, 'qKey' | 'kind' | 'lessonId'> & { lessonId: string | null } };

/** 들은 말 하나의 판정 기록(로컬 서버 로그용). text는 들은 말 원문 — LOG_TEXT=0이면 index.ts가 빼고 글자 수(chars)만 남긴다. */
/** reason joined: 덜 끝난 말이라 다음 말과 이어 붙였다(판정은 이은 글 쪽에 남는다). complete false: 덜 끝났지만 이을 말이 안 왔다. */
/** ms: 판정에 걸린 시간. sttMs: 말을 끝낸 뒤 받아쓰기가 확정되기까지 걸린 시간. */
export type ListenLog = { text: string; accept: boolean; reason: JoinedVerdict['reason']; ms: number; sttMs: number; complete?: false };

/** 음성 듣기(/api/listen) 의존성. 없으면 라우트를 등록하지 않는다. */
export type ListenDeps = {
  openStt(lang?: Lang): Pick<ScribeSession, 'start' | 'sendAudio' | 'commit' | 'keepAlive' | 'close'>;
  /** `signal`은 연결이 끊기면 abort된다(진행 중인 모델 호출을 멈추게). */
  classify(input: ClassifyInput, signal?: AbortSignal): Promise<Verdict>;
};

/** 브라우저로 가는 STT 오류 문구(고정). 업스트림 메시지는 절대 싣지 않는다. */
export const LISTEN_ERROR_MESSAGE = '음성 인식에 문제가 생겼어요';
const LISTEN_ERROR_MESSAGES: Record<Lang, string> = { ko: LISTEN_ERROR_MESSAGE, en: 'Something went wrong with speech recognition' };
/** 브라우저 한 프레임 최대 크기. 오디오 덩어리는 최대 1초(32KB)라 넉넉하다. */
const LISTEN_MAX_PAYLOAD = 256 * 1024;

/** 실제 구현(Gemini·ElevenLabs)은 index.ts가, 테스트는 가짜를 넣는다. */
export type AppDeps = {
  /**
   * heard: 말로 물었을 때 음성 인식이 받아 적은 그대로의 말(없으면 글로 물음).
   * onUsage(선택): 대본 모델의 토큰(원가 기록). 스트림이 끝날 때 한 번.
   */
  scriptText: (
    question: string, profile: Profile, signal: AbortSignal, context?: LessonContext, heard?: string, mode?: LessonMode, level?: Level,
    onUsage?: (u: ModelUsage) => void, lang?: Lang,
  ) => AsyncIterable<string>;
  /** lang(선택): 'en'이면 영어 목소리(설정돼 있으면). */
  speak: (text: string, profile: Profile, signal: AbortSignal, previousText?: string, lang?: Lang) => Promise<Speech>;
  /**
   * 그림 주문 → 화가 그림(실패는 null, 던지지 않음). signal은 수업이 끝나거나 연결이 끊기면 abort된다.
   * 선택: 없으면 주문은 모두 figure:null로 나가고 수업은 그대로 이어진다(runLesson이 처리).
   * meter(선택): 실제 Gemini 호출마다 토큰을 알린다(원가 기록, artist.ts의 ArtistMeter).
   */
  drawSketch?: (order: SketchOrder, signal: AbortSignal, meter?: ArtistMeter) => Promise<FigureOp | null>;
  /** 프로필별 목소리 ID. 채움 음성 캐시 무효화 키로만 쓰인다(브라우저로 보내지 않음). */
  voice: Record<Profile, string>;
  /** 영어 수업 목소리 ID(선택). 없으면 voice를 함께 쓴다. 채움 음성 캐시 키로만 쓰인다. */
  voiceEn?: Record<Profile, string>;
  /** 채움 음성 캐시 디렉터리. 기본 data/filler */
  fillerDir?: string;
  /** 운영 빌드 디렉터리. 있을 때만 정적 서빙. 기본 dist */
  staticDir?: string;
  /** Fastify 로거 사용 여부(또는 시험용 { level, stream }). 기본 false */
  logger?: boolean | { level?: string; stream: { write(msg: string): void } };
  /** 수업마다 한 번(지연 목표 확인용). 기본은 app.log.info */
  logLesson?: (entry: LessonLog) => void;
  /** 음성 듣기. 있을 때만 /api/listen WebSocket을 연다. */
  listen?: ListenDeps;
  /** 들은 말 판정마다 한 번. 기본은 app.log.info({ listen }) */
  logListen?: (entry: ListenLog) => void;
  /** 기기 보고(POST /api/client-log) 한 건마다. 기본은 오류 app.log.warn({ clientError }), 체감 시간 app.log.info({ clientLesson }) */
  logClient?: (entry: ClientLogEntry) => void;
  /** 가족 비밀번호(숫자 6자리). 비었거나 없으면 관문을 끈다. */
  familyPin?: string;
  /** 쿠키 서명 비밀(PIN_SECRET). 없으면 프로세스마다 무작위(재시작하면 기기가 PIN을 다시 넣는다). */
  pinSecret?: string;
  /**
   * TRUST_PROXY=1: 같은 컴퓨터(loopback)의 터널(ngrok 등)이 붙인 X-Forwarded-For·X-Forwarded-Proto를 믿는다.
   * 기본 false — 그 머리글은 무시하고 소켓 주소만 본다.
   */
  trustProxy?: boolean;
};

const isProfile = (v: unknown): v is Profile => v === 'kid' || v === 'adult';

/** Host 머리글에서 이름 부분만(포트 빼고, 소문자). '[::1]:8787' → '[::1]'. 모양이 이상하면 null. */
function hostnameOf(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    const rest = h.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return null;
    return h.slice(0, end + 1);
  }
  const parts = h.split(':');
  if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) return null;
  return parts[0].replace(/\.$/, '') || null;
}

/**
 * DNS rebinding 막기: 공격자 도메인이 127.0.0.1을 가리키게 해도 Host에는 그 도메인 이름이 실린다.
 * 그래서 도메인 이름 없이 오는 IP 주소(IPv4, [IPv6]), localhost, Tailscale(*.ts.net), ALLOWED_HOSTS(쉼표 구분)만 받는다.
 */
export function isAllowedHost(host: string | undefined, allowedHosts = process.env.ALLOWED_HOSTS ?? ''): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  if (!name) return false;
  if (name.startsWith('[')) return isIPv6(name.slice(1, -1));
  if (isIP(name) === 4 || name === 'localhost') return true;
  if (name.endsWith('.ts.net') && name.length > '.ts.net'.length) return true;
  return allowedHosts
    .split(',')
    .map((s) => hostnameOf(s))
    .some((allowed) => allowed !== null && allowed === name);
}

function parseLessonBody(body: unknown): { question: string; profile: Profile; context?: LessonContext; heard?: string; mode: LessonMode; level: Level; lang: Lang } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { question, profile, context: rawContext, heard, mode, level, lang } = body as Record<string, unknown>;
  // lang(선택): 'ko'(기본) | 'en'.
  if (lang !== undefined && !isLang(lang)) return null;
  // mode(선택): 'quick'(기본) | 'deep'. 그 밖의 값은 잘못된 요청.
  if (mode !== undefined && !LESSON_MODES.includes(mode as LessonMode)) return null;
  // level(선택): 'elementary' | 'middle' | 'adult'. 없으면 프로필 기본값.
  if (level !== undefined && !LEVELS.includes(level as Level)) return null;
  if (typeof question !== 'string' || !isProfile(profile)) return null;
  const q = question.trim();
  if (q.length === 0 || q.length > MAX_QUESTION_CHARS) return null;
  // 제어·서식 문자(폭 없는 공백, 방향 표시 등)뿐이면 물은 게 없다 — 모델을 부르지 않는다.
  if (!/[^\s\p{C}]/u.test(q)) return null;
  const context = parseLessonContext(rawContext);
  if (context === null) return null;
  // heard(선택): 말로 물었을 때 받아 적은 그대로의 말. 있으면 문자열·한도 안이어야 한다.
  if (heard !== undefined && (typeof heard !== 'string' || heard.length > MAX_QUESTION_CHARS)) return null;
  return {
    question: q, profile, context, mode: (mode as LessonMode | undefined) ?? 'quick', level: (level as Level | undefined) ?? defaultLevel(profile),
    lang: (lang as Lang | undefined) ?? 'ko',
    ...(typeof heard === 'string' ? { heard } : {}),
  };
}

/**
 * 이 요청이 https로 왔나. 직접 TLS이거나, TRUST_PROXY일 때 같은 컴퓨터의 터널(ngrok·tailscale serve)이 붙인
 * X-Forwarded-Proto의 맨 오른쪽 값이 https. 그 밖의 X-Forwarded-Proto는 아무나 붙일 수 있으니 믿지 않는다.
 */
function isHttps(request: FastifyRequest, trustProxy: boolean): boolean {
  if ((request.raw.socket as { encrypted?: boolean }).encrypted) return true;
  return forwardedHttps(request.raw.socket.remoteAddress, request.headers['x-forwarded-proto'], trustProxy);
}

/**
 * 관문이 볼 경로: 요청줄의 경로 부분(absolute-form이면 scheme·authority를 떼고), 퍼센트 인코딩을 풀고,
 * 겹친 슬래시를 하나로, 소문자로. 라우터가 어떻게 해석하든 /api로 읽힐 만한 것은 모두 /api로 본다.
 */
function gatePath(url: string): string {
  let p = url.split('?')[0].split('#')[0];
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(p);
  if (abs) p = p.slice(abs[0].length) || '/';
  for (let i = 0; i < 3 && p.includes('%'); i++) {
    try {
      p = decodeURIComponent(p);
    } catch {
      break;
    }
  }
  return p.replace(/[\\/]+/g, '/').toLowerCase();
}

/**
 * 가족 비밀번호: /api/* HTTP와 /api/listen 업그레이드는 유효한 쿠키가 있어야 한다(POST /api/pin만 예외). 정적 파일은 연다.
 * GET /api/pin은 "이 기기는 들어와 있나" 확인용(관문을 지나면 204). gate가 null이면 관문을 끈다.
 */
function registerPin(app: FastifyInstance, gate: PinGate | null, trustProxy: boolean) {
  if (gate) {
    app.addHook('onRequest', async (request, reply) => {
      // 풀어 본 실제 경로와 맞은 라우트 둘 중 하나라도 /api면 검사한다(정적 파일의 '/*'에 걸린 /api/… 도). 예외는 맞은 라우트로만 본다.
      const route = request.routeOptions.url;
      if (!gatePath(request.url).startsWith('/api') && !route?.startsWith('/api')) return;
      if (request.method === 'POST' && route === '/api/pin') return;
      if (gate.check(request.headers.cookie)) return;
      return reply.code(401).send({ error: 'pin' });
    });
  } else {
    // 관문이 꺼져 있으면(FAMILY_PIN 없음) 이 컴퓨터에서 바로 온 요청만 받는다. 터널(ngrok --host-header=rewrite,
    // tailscale serve 등)이 Host를 localhost로 바꿔 넘겨도 X-Forwarded-*는 남으니, 그런 요청은 거절한다.
    app.addHook('onRequest', async (request, reply) => {
      if (!FORWARDED_HEADERS.some((h) => request.headers[h] !== undefined)) return;
      request.log.warn('forwarded request rejected (no FAMILY_PIN)');
      return reply.code(403).send({ error: '터널(ngrok 등)을 거쳐 온 요청은 FAMILY_PIN을 정해야 받습니다' });
    });
  }

  app.get('/api/pin', async (_request, reply) => reply.code(204).send());

  app.post('/api/pin', async (request, reply) => {
    if (!gate) return reply.code(204).send();
    const pin = (request.body as Record<string, unknown> | null | undefined)?.pin;
    const client = pinClientKey(request.raw.socket.remoteAddress, request.headers['x-forwarded-for'], trustProxy);
    const r = gate.attempt(pin, client);
    switch (r.kind) {
      case 'ok': {
        const secure = isHttps(request, trustProxy) ? '; Secure' : '';
        request.log.info('pin ok');
        return reply
          .header('set-cookie', `${PIN_COOKIE}=${r.cookieValue}; Path=/; Max-Age=${PIN_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`)
          .header('cache-control', 'no-store')
          .code(204)
          .send();
      }
      case 'wrong':
        request.log.warn({ client }, 'pin wrong');
        return reply.code(401).send({ error: 'wrong' });
      case 'locked':
        request.log.warn({ client, retryAfterSec: r.retryAfterSec }, 'pin locked');
        return reply.code(429).header('retry-after', String(r.retryAfterSec)).send({ error: 'locked', retryAfterSec: r.retryAfterSec });
      case 'invalid':
        return reply.code(400).send({ error: 'pin(문자열)이 필요합니다' });
    }
  });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 });
  const logLesson = deps.logLesson ?? ((entry: LessonLog) => app.log.info({ lesson: entry }, 'lesson'));
  const familyPin = deps.familyPin?.trim();
  const gate = familyPin ? createPinGate({ pin: familyPin, secret: deps.pinSecret }) : null;
  const logClient =
    deps.logClient ??
    ((entry: ClientLogEntry) =>
      entry.kind === 'error' ? app.log.warn({ clientError: entry.event }, 'client error') : app.log.info({ clientLesson: entry.event }, 'client lesson'));
  /** 브라우저 체감 시간을 같은 질문의 최근 수업 id에 잇는다(qKey는 메모리에만). */
  const recentLessons = new RecentLessons();

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    return payload;
  });

  // 모든 요청(/api/*, 정적 파일, WebSocket 업그레이드)에 Host 허용 목록을 먼저 건다. 업그레이드도 핸드셰이크 전에 403.
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host)) {
      request.log.warn({ host: request.headers.host }, 'host rejected');
      return reply.code(403).send({ error: '허용되지 않은 Host입니다 (ALLOWED_HOSTS 참고)' });
    }
  });
  // 그다음 가족 비밀번호(업그레이드도 핸드셰이크 전에 401).
  registerPin(app, gate, deps.trustProxy ?? false);

  let activeLessons = 0;
  app.post('/api/lesson', { bodyLimit: LESSON_BODY_LIMIT }, async (request, reply) => {
    const body = parseLessonBody(request.body);
    if (!body) {
      return reply.code(400).send({
        error: `question(1~${MAX_QUESTION_CHARS}자 문자열)과 profile('kid'|'adult')이 필요합니다. context는 { previousQuestion, spoken(최대 ${MAX_CONTEXT_SPOKEN}개·각 ${MAX_SPOKEN_CHARS}자), interrupted?(boolean) }, heard는 ${MAX_QUESTION_CHARS}자 이하 문자열(선택), mode는 'quick'|'deep'(선택), level은 'elementary'|'middle'|'adult'(선택), lang은 'ko'|'en'(선택)`,
      });
    }
    const { question, profile, context, heard, mode, level, lang } = body;

    // 처리기가 돌기 전에 연결이 이미 끊겼으면 'close'가 다시 오지 않아 자리를 영영 돌려받지 못한다. 아무것도 시작하지 않는다.
    if (reply.raw.destroyed || request.raw.socket?.destroyed) {
      request.log.info('lesson client gone before start');
      return reply.code(499).send();
    }
    if (activeLessons >= MAX_CONCURRENT_LESSONS) {
      request.log.warn({ activeLessons }, 'lesson busy');
      return reply.code(429).header('retry-after', '5').send({ error: 'busy' });
    }
    activeLessons++;
    let released = false;

    // 수업이 어떻게 끝나든(완료·오류·연결 끊김) Gemini 스트림과 진행 중인 TTS를 끊고, 자리를 한 번만 돌려준다.
    const ac = new AbortController();
    const abort = () => {
      ac.abort();
      if (!released) {
        released = true;
        activeLessons--;
      }
    };
    reply.raw.on('close', abort);

    const t0 = performance.now();
    let firstSayMs: number | null = null;
    // 속도·원가 계측: 단계 시각과 토큰·글자 수를 모아 수업 줄 하나에 싣는다.
    const lessonId = randomBytes(6).toString('base64url');
    const meter = new LessonMeter(TTS_MODEL_ID, t0);
    recentLessons.add(lessonId, questionKey(question));
    reply.header('x-lesson-id', lessonId);
    async function* script() {
      try {
        for await (const chunk of deps.scriptText(question, profile, ac.signal, context, heard, mode, level, (u) => meter.teacherUsage(u), ...(lang === 'ko' ? [] : [lang] as const))) {
          meter.mark('firstChunkMs');
          yield chunk;
        }
      } finally {
        meter.mark('scriptEndMs');
      }
    }
    let ttsCalls = 0;
    const drawSketch = deps.drawSketch;
    const artistMeter: ArtistMeter = (u) => meter.artistCall(u);
    const lesson = runLesson({
      scriptText: script(),
      speak: (text, prev) => {
        meter.ttsCall(charCount(text));
        const p = lang === 'ko' ? deps.speak(text, profile, ac.signal, prev) : deps.speak(text, profile, ac.signal, prev, lang);
        // 첫 문장의 TTS(성공·실패 모두)가 끝난 때. TTS는 문장 순서대로 불린다(limiter FIFO).
        if (ttsCalls++ === 0) void p.then(() => meter.mark('firstTtsMs'), () => meter.mark('firstTtsMs'));
        return p;
      },
      // 연결이 끊기면(ac) 수업이 화가를 끊고 그 그림은 메시지 없이 버린다(실패로 세지 않음).
      drawSketch: drawSketch && ((order, signal) => drawSketch(order, signal, artistMeter)),
      signal: ac.signal,
      lang,
      onFirstLine: () => meter.mark('firstLineMs'),
      onEnd: ({ says, droppedLines, ttsFailures, firstTtsError, error, sketches, sketchFailures, sketchMs }) => {
        abort();
        const entry: LessonLog = {
          question, profile, mode, level, ...(lang === 'ko' ? {} : { lang }), firstSayMs, totalMs: Math.round(performance.now() - t0), says, droppedLines, ttsFailures,
          sketches, sketchFailures, sketchMs,
          lessonId, spoken: heard !== undefined, qChars: charCount(question), stages: meter.stages(), usage: meter.usage(),
        };
        if (firstTtsError !== undefined) entry.ttsError = describeTtsError(firstTtsError);
        if (error !== undefined) entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        logLesson(entry);
      },
    });
    async function* ndjson() {
      try {
        for await (const msg of lesson) {
          if (msg.type === 'say' && firstSayMs === null) firstSayMs = Math.round(performance.now() - t0);
          else if (msg.type === 'draw') meter.mark('firstDrawMs');
          yield JSON.stringify(msg) + '\n';
        }
      } finally {
        abort();
        reply.raw.off('close', abort);
      }
    }

    reply.header('content-type', 'application/x-ndjson; charset=utf-8').header('cache-control', 'no-cache');
    return reply.send(Readable.from(ndjson()));
  });

  app.get<{ Params: { profile: string }; Querystring: { lang?: string } }>('/api/filler/:profile', async (request, reply) => {
    const { profile } = request.params;
    if (!isProfile(profile)) return reply.code(400).send({ error: "profile은 'kid' 또는 'adult'여야 합니다" });
    const rawLang = request.query?.lang;
    if (rawLang !== undefined && !isLang(rawLang)) return reply.code(400).send({ error: "lang은 'ko' 또는 'en'이어야 합니다" });
    const lang: Lang = rawLang ?? 'ko';
    try {
      if (lang === 'ko') {
        return await getFillers(
          profile,
          deps.voice[profile],
          (t) => deps.speak(t, profile, AbortSignal.timeout(FILLER_TTS_TIMEOUT_MS)),
          deps.fillerDir,
          (err, text) => request.log.warn({ profile, text, ttsError: describeTtsError(err) }, 'filler tts failed'),
        );
      }
      return await getFillers(
        profile,
        (deps.voiceEn ?? deps.voice)[profile],
        (t) => deps.speak(t, profile, AbortSignal.timeout(FILLER_TTS_TIMEOUT_MS), undefined, lang),
        deps.fillerDir,
        (err, text) => request.log.warn({ profile, lang, text, ttsError: describeTtsError(err) }, 'filler tts failed'),
        lang,
      );
    } catch (err) {
      request.log.warn({ err }, 'filler generation failed');
      return reply.code(502).send({ error: '채움 음성을 만들지 못했습니다' });
    }
  });

  registerClientLog(app, deps.trustProxy ?? false, logClient, recentLessons);

  if (deps.listen) registerListen(app, deps.listen, deps.logListen ?? ((entry) => app.log.info({ listen: entry }, 'listen')));

  const staticDir = deps.staticDir ?? resolve(process.cwd(), 'dist');
  // 점 파일(.env 등)은 dist에 잘못 들어가도 내주지 않는다(404).
  if (existsSync(staticDir)) app.register(fastifyStatic, { root: staticDir, dotfiles: 'ignore' });

  return app;
}

/**
 * POST /api/client-log — 기기 오류와 체감 시간 보고. /api/*라 가족 비밀번호 쿠키가 있어야 닿는다(관문 hook).
 * 본문 CLIENT_LOG_MAX_BYTES(넘으면 413), 한 곳(주소)마다 초당·분당 횟수 제한(넘으면 429, 기록 없음),
 * 정해진 필드만 골라 남긴다(parseClientLog). 질문 원문·키·PIN·쿠키는 받지도 남기지도 않는다.
 */
function registerClientLog(app: FastifyInstance, trustProxy: boolean, logClient: (entry: ClientLogEntry) => void, recent: RecentLessons) {
  const allow = createRateLimiter();
  let limitedWarnAt = -Infinity;
  app.post('/api/client-log', { bodyLimit: CLIENT_LOG_MAX_BYTES }, async (request, reply) => {
    const client = pinClientKey(request.raw.socket.remoteAddress, request.headers['x-forwarded-for'], trustProxy);
    if (!allow(client)) {
      // 폭주하는 기기 하나가 로그를 덮지 않게: 넘친 보고는 버리고, 경고는 분에 한 번만.
      const now = Date.now();
      if (now - limitedWarnAt > 60_000) {
        limitedWarnAt = now;
        request.log.warn('client log rate limited');
      }
      return reply.code(429).header('retry-after', '60').send();
    }
    const events = parseClientLog(request.body);
    if (!events) return reply.code(400).send({ error: 'events(1~8개 배열)가 필요합니다' });
    for (const ev of events) {
      try {
        if (ev.kind === 'lesson') {
          const { qKey, kind: _kind, lessonId: sentId, ...rest } = ev;
          // 브라우저가 x-lesson-id를 받아 실어 보냈으면 그 수업에 바로, 아니면(대비) 같은 질문 중 물어본 때(받은 때 − endMs)에 가장 가까운 수업에.
          const lessonId = sentId ? recent.claimId(sentId, qKey) : recent.claim(qKey, rest.endMs);
          logClient({ kind: 'lesson', event: { lessonId, ...rest } });
        } else {
          logClient({ kind: 'error', event: ev });
        }
      } catch {
        // 기록 쪽 문제로 응답을 깨뜨리지 않는다.
      }
    }
    return reply.code(204).send();
  });
}

/** 메아리(선생님 말이 마이크로 다시 들어옴) 비교에는 최근 문장 몇 개면 충분하다. */
const ECHO_SPOKEN = 8;

/** 브라우저가 보내는 state를 검사하고 recentSpoken을 최근 것만, 한도 안으로 자른다. 잘못되면 null. */
function parseListenState(m: Record<string, unknown>): { lessonActive: boolean; recentSpoken: string[] } | null {
  const { lessonActive, recentSpoken } = m;
  if (typeof lessonActive !== 'boolean' || !Array.isArray(recentSpoken)) return null;
  if (!recentSpoken.every((s): s is string => typeof s === 'string')) return null;
  return { lessonActive, recentSpoken: recentSpoken.slice(-ECHO_SPOKEN).map((s) => s.slice(0, MAX_SPOKEN_CHARS)) };
}

/**
 * /api/listen을 열어도 되는 Origin인가(남의 웹페이지가 이 서버의 키로 소리를 흘려보내고 받아 적은 글을 읽지 못하게).
 * Origin 없음(브라우저가 아닌 클라이언트), Host와 같은 호스트의 페이지, https이면서 ALLOWED_HOSTS에 적힌 이름, vite 개발 서버(localhost·127.0.0.1:PW_PORT)만 받는다.
 */
export function isAllowedListenOrigin(
  origin: string | undefined,
  host: string | undefined,
  webPort = process.env.PW_PORT?.trim() || '5173',
  allowedHosts = process.env.ALLOWED_HOSTS ?? '',
): boolean {
  if (origin === undefined) return true;
  let originHost: string;
  let url: URL;
  try {
    url = new URL(origin); // 'null' 같은 값은 여기서 던진다
    originHost = url.host;
  } catch {
    return false;
  }
  if (!originHost) return false;
  if (host && originHost === host.trim().toLowerCase()) return true;
  // tailscale serve 뒤에서는 Host가 localhost:8787로 바뀔 수 있다. 그래서 https이면서 ALLOWED_HOSTS에 적힌 이름과 정확히 같은 Origin만 더 받는다.
  // (아무 *.ts.net이나 받으면 남의 tailnet Funnel 페이지가 방문자 브라우저로 이 서버에 붙을 수 있다.)
  if (url.protocol === 'https:' && allowedHosts.split(',').some((a) => hostnameOf(a) !== null && hostnameOf(a) === url.hostname)) return true;
  return [`localhost:${webPort}`, `127.0.0.1:${webPort}`, `[::1]:${webPort}`].includes(originHost);
}

/** 브라우저가 쉬어도(백그라운드 탭 등) Scribe가 15초 무입력으로 끊지 않게, 이만큼 아무것도 안 올렸으면 무음을 보낸다. */
const LISTEN_KEEPALIVE_MS = 10_000;
/** 브라우저가 이만큼 소리를 안 보내면 Scribe 세션을 닫는다(요금). 다음 소리가 오면 다시 연다. */
export const LISTEN_STT_IDLE_MS = 30_000;
/** 브라우저가 이만큼 아무 메시지(소리·ping·state·end)도 안 보내면 죽은 연결로 보고 1001로 닫는다(브라우저 ping은 10초마다). */
export const LISTEN_CLIENT_IDLE_MS = 45_000;
/**
 * 연결 하나가 STT로 올릴 수 있는 소리(keepAlive 무음 포함): 한꺼번에 이만큼(10초분)까지, 그 뒤로는 LISTEN_AUDIO_RATE_BPS로 다시 찬다.
 * 넘친 소리는 버린다(요금이 소리 길이로 매겨지므로 폭주하는 연결 하나가 몇 분치를 1초에 올리지 못하게).
 */
export const LISTEN_AUDIO_BURST_BYTES = 320_000;
/** 실시간(16kHz·16bit = 32,000B/s)의 2배. */
const LISTEN_AUDIO_RATE_BPS = 64_000;
/** keepAlive 한 번에 올리는 무음(100ms) 바이트. */
const KEEPALIVE_BYTES = 3200;
/** 동시에 열 수 있는 듣기 연결 수(가족 기기 몇 대면 충분하다). 넘치면 1013으로 닫는다(브라우저는 간격을 두고 다시 연다). */
export const LISTEN_MAX_SOCKETS = 8;

type SttHandle = ReturnType<ListenDeps['openStt']>;

/**
 * /api/listen?profile=kid|adult — 브라우저 마이크(PCM16 16kHz mono 바이너리)를 Scribe로 넘기고
 * 확정된 말을 판정해 돌려준다. Scribe 세션은 첫 소리에서 열고, LISTEN_STT_IDLE_MS 동안 소리가 없으면 닫는다
 * (다음 소리에서 다시 연다). ready는 연결 즉시 보낸다.
 */
function registerListen(app: FastifyInstance, listen: ListenDeps, logListen: (entry: ListenLog) => void) {
  app.register(fastifyWebsocket, { options: { maxPayload: LISTEN_MAX_PAYLOAD } });
  /** 지금 열려 있는 듣기 연결 수. */
  let sockets = 0;
  app.register(async (scope) => {
    scope.get('/api/listen', { websocket: true }, (socket, request) => {
      if (!isAllowedListenOrigin(request.headers.origin, request.headers.host)) {
        request.log.warn({ origin: request.headers.origin }, 'listen origin rejected');
        socket.close(1008, 'origin');
        return;
      }
      const query = request.query as Record<string, unknown> | undefined;
      const profile = query?.profile;
      if (!isProfile(profile)) {
        socket.close(1008, 'profile');
        return;
      }
      // lang(선택): 받아쓰기·판별 언어. 없으면 ko.
      const rawLang = query?.lang;
      if (rawLang !== undefined && !isLang(rawLang)) {
        socket.close(1008, 'lang');
        return;
      }
      const lang: Lang = rawLang ?? 'ko';
      if (sockets >= LISTEN_MAX_SOCKETS) {
        request.log.warn({ sockets }, 'listen busy');
        socket.close(1013, 'busy');
        return;
      }
      sockets++;
      // STT로 올릴 소리 예산(LISTEN_AUDIO_BURST_BYTES 참고). 쓸 수 있으면 깎고 true.
      let budget = LISTEN_AUDIO_BURST_BYTES;
      let budgetAt = Date.now();
      let overBudgetLogged = false;
      const spend = (bytes: number): boolean => {
        const now = Date.now();
        budget = Math.min(LISTEN_AUDIO_BURST_BYTES, budget + ((now - budgetAt) * LISTEN_AUDIO_RATE_BPS) / 1000);
        budgetAt = now;
        if (bytes > budget) {
          if (!overBudgetLogged) request.log.warn('listen audio over budget, dropping');
          overBudgetLogged = true;
          return false;
        }
        budget -= bytes;
        return true;
      };

      let state = { lessonActive: false, recentSpoken: [] as string[] };
      let done = false;
      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      /** 지금 열린 Scribe 세션(소리가 올 때만 연다). */
      let stt: SttHandle | null = null;
      // 연결이 끝나면 진행 중인 판정(모델 호출)도 멈춘다.
      const ac = new AbortController();
      let keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
      let sttIdleTimer: ReturnType<typeof setTimeout> | undefined;
      let clientIdleTimer: ReturnType<typeof setTimeout> | undefined;
      // 세션이 열려 있는 동안, 마지막으로 위로 올린 뒤 LISTEN_KEEPALIVE_MS가 지나면 keepAlive. 소리·ping을 올릴 때마다 다시 잰다.
      const armKeepAlive = () => {
        clearTimeout(keepAliveTimer);
        if (!stt) return;
        keepAliveTimer = setTimeout(() => {
          if (done || !stt) return;
          stt.keepAlive();
          armKeepAlive();
        }, LISTEN_KEEPALIVE_MS);
      };
      // 소리가 LISTEN_STT_IDLE_MS 동안 없으면 세션만 닫는다(브라우저 연결은 그대로). close() 뒤에는 그 세션의 이벤트가 오지 않는다.
      const closeStt = () => {
        clearTimeout(keepAliveTimer);
        clearTimeout(sttIdleTimer);
        const s = stt;
        stt = null;
        s?.close();
      };
      const armSttIdle = () => {
        clearTimeout(sttIdleTimer);
        sttIdleTimer = setTimeout(() => {
          if (!done) closeStt();
        }, LISTEN_STT_IDLE_MS);
      };
      // 브라우저에서 아무것도 안 오면(잠든 탭·끊긴 망) 죽은 연결로 보고 닫는다. 브라우저는 1001을 보고 다시 연결한다.
      const armClientIdle = () => {
        clearTimeout(clientIdleTimer);
        clientIdleTimer = setTimeout(() => {
          if (done) return;
          request.log.info('listen client idle, closing');
          shutdown();
          socket.close(1001, 'idle');
        }, LISTEN_CLIENT_IDLE_MS);
      };
      // 소켓이 어떻게 끝나든 STT는 한 번만 닫는다(close() 뒤에는 STT의 onClose가 오지 않는다).
      const shutdown = () => {
        if (done) return;
        done = true;
        sockets--;
        clearTimeout(clientIdleTimer);
        joiner.close();
        ac.abort();
        closeStt();
      };
      // STT 쪽 문제 → 고정 문구만 보내고 닫는다(브라우저가 다시 연결). 업스트림 문구는 서버 로그에만.
      const fail = (detail: string) => {
        if (done) return;
        request.log.warn({ listenError: detail }, 'listen stt failed');
        send({ type: 'error', message: LISTEN_ERROR_MESSAGES[lang] });
        shutdown();
        socket.close(1011, 'stt');
      };

      // 판정은 들은 순서대로 하나씩 내보낸다. 덜 끝난 말은 잠깐 기다렸다 다음 말과 이어 다시 판정한다(utteranceJoiner.ts).
      const joiner = new UtteranceJoiner({
        classify: (text) => {
          const input: ClassifyInput = { text, profile, lessonActive: state.lessonActive, recentSpoken: [...state.recentSpoken], ...(lang === 'ko' ? {} : { lang }) };
          return listen.classify(input, ac.signal).then(
            (v): JoinedVerdict => v,
            (err: unknown): JoinedVerdict => {
              request.log.warn({ classifyError: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown' }, 'listen classify failed');
              return { accept: false, question: '', reason: 'error', complete: true };
            },
          );
        },
        emit: (text, v, ms, sttMs) => {
          if (done) return; // 끊긴 뒤 끝난(abort된) 판정은 보낼 곳도 기록할 것도 없다
          logListen({ text, accept: v.accept, reason: v.reason, ms, sttMs, ...(v.complete === false && v.reason !== 'joined' ? { complete: false as const } : {}) });
          // 수업 요청은 MAX_QUESTION_CHARS를 넘는 질문을 400으로 거절한다: 길게 이은 말·모델이 늘린 질문도 수업이 되게 자른다.
          // miss(E7): 받아 적은 글이 있는데 질문이 아니라고 거절했다 — 브라우저가 연달아 못 알아들으면 "다시 말해 줄래?"를 띄운다.
          // 빈 받아쓰기(TV·청소기·소리 지름 같은 잡음)·감탄사·선생님 목소리(에코)·이어 붙이기·판정 오류는 못 알아들은 말이 아니다.
          const miss = !v.accept && v.reason === 'model' && text.trim().length > 0;
          send({ type: 'utterance', text, accept: v.accept, question: v.question.slice(0, MAX_QUESTION_CHARS), ...(miss ? { miss: true } : {}) });
        },
      });

      /** 세션이 없으면 새로 연다. 실패하면 fail하고 null. 예전 세션의 늦은 이벤트는 무시한다. */
      const ensureStt = (): SttHandle | null => {
        if (stt) return stt;
        let s: SttHandle;
        try {
          s = lang === 'ko' ? listen.openStt() : listen.openStt(lang);
          stt = s;
          const live = () => !done && stt === s;
          s.start({
            onPartial: (text) => {
              // 이어 붙이려고 기다리는 말이 있으면 앞에 붙여 보여 준다(말풍선이 끊기지 않게).
              const before = joiner.prefix();
              if (live()) send({ type: 'partial', text: before && text ? `${before} ${text}` : text });
            },
            onFinal: (text) => {
              if (live()) joiner.final(text);
            },
            onError: (e) => {
              if (live()) fail(`${e.name}(${e.kind}): ${e.message.slice(0, 200)}`);
            },
            onClose: () => {
              if (live()) fail('upstream closed');
            },
            onWarning: (e) => {
              if (live()) request.log.warn({ listenWarning: `${e.kind}: ${e.message.slice(0, 200)}` }, 'listen stt warning');
            },
          });
        } catch (err) {
          fail(`start threw: ${err instanceof Error ? err.name : 'unknown'}`);
          return null;
        }
        return s;
      };

      armClientIdle();
      send({ type: 'ready' });

      socket.on('message', (data, isBinary) => {
        if (done) return;
        armClientIdle();
        if (isBinary) {
          // 바이너리 = PCM16LE 바이트 그대로. 홀수 길이면 끝 바이트를 버려 2바이트 정렬을 지킨다.
          // 복사해 넘긴다(STT가 열리기 전엔 큐에 쌓인다).
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          const even = buf.length & ~1;
          if (even === 0 || !spend(even)) return;
          const s = ensureStt();
          if (!s) return;
          joiner.audio();
          s.sendAudio(new Uint8Array(buf.subarray(0, even)));
          armKeepAlive();
          armSttIdle();
          return;
        }
        let m: unknown;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (typeof m !== 'object' || m === null) return;
        const msg = m as Record<string, unknown>;
        if (msg.type === 'end') {
          if (stt) joiner.end();
          stt?.commit();
        }
        else if (msg.type === 'ping') {
          if (stt && spend(KEEPALIVE_BYTES)) {
            stt.keepAlive();
            armKeepAlive();
          }
        }
        else if (msg.type === 'state') {
          const next = parseListenState(msg);
          if (next) state = next;
        }
      });
      socket.on('close', shutdown);
      socket.on('error', shutdown);
    });
  });
}

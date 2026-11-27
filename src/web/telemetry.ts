// 기기 쪽 운영 계측: 잡히지 않은 오류·앱이 잡은 오류(H1)와 수업 체감 시간(G1)을 묶어 POST /api/client-log로 보낸다.
// DOM·화면을 바꾸지 않는다. 보내기 실패는 조용히 버린다(계측이 앱을 멈추게 하지 않는다).
// 보내지 않는 것: 질문·대사 원문(질문은 글자 수와 맞춤 열쇠만), 키, PIN, 쿠키(fetch가 HttpOnly 쿠키를 붙일 뿐 읽지 않는다).
import {
  CLIENT_LOG_MAX_BYTES,
  CLIENT_LOG_MAX_EVENTS,
  CLIENT_MESSAGE_MAX,
  CLIENT_STACK_MAX,
  LESSON_ID_RE,
  charCount,
  questionKey,
  type ClientErrorEvent,
  type ClientErrorKind,
  type ClientEvent,
  type ClientLessonEvent,
  type LessonResult,
} from '../shared/clientLog';
import type { LessonMode } from '../shared/lesson';

/** 사건을 모았다가 이만큼 뒤에 한 번에 보낸다. */
export const FLUSH_MS = 2000;
/** 같은 오류는 이 간격에 한 번만 보낸다. 그 사이에 난 것은 세어 두었다가 다음 번에 count로 보낸다. */
export const REPEAT_MS = 60_000;
/** 한 페이지에서 보내는 오류 보고 최대 수(무한 루프 오류가 서버를 두드리지 않게). */
export const MAX_ERROR_REPORTS = 100;
/** 기억하는 서로 다른 오류 수. 넘으면 새 오류는 버린다. */
const MAX_KEYS = 50;
/** 한 번에(같은 순간) 보내는 묶음 수. 서버의 초당 한도(5)보다 적게 — 넘치는 묶음은 429로 버려지므로 나머지는 1초 뒤에. */
export const MAX_SENDS_PER_FLUSH = 4;
const NEXT_SEND_MS = 1000;

/** UA 요약: 기기·브라우저·주 버전만(예: 'iPad Safari 18', 'Windows Chrome 140'). 40자 이하, 영문·숫자·공백·점만. */
export function uaSummary(ua: string, maxTouchPoints = 0): string {
  const ver = (re: RegExp) => re.exec(ua)?.[1] ?? '';
  let device = 'Other';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) device = 'iPad'; // iPadOS는 Mac처럼 보인다
  else if (/iPhone|iPod/.test(ua)) device = 'iPhone';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
  else if (/Linux/.test(ua)) device = 'Linux';
  let browser = 'Other';
  let v = '';
  if (/Edg\//.test(ua)) [browser, v] = ['Edge', ver(/Edg\/(\d+)/)];
  else if (/CriOS\//.test(ua)) [browser, v] = ['Chrome', ver(/CriOS\/(\d+)/)];
  else if (/FxiOS\//.test(ua)) [browser, v] = ['Firefox', ver(/FxiOS\/(\d+)/)];
  else if (/Firefox\//.test(ua)) [browser, v] = ['Firefox', ver(/Firefox\/(\d+)/)];
  else if (/Chrome\//.test(ua)) [browser, v] = ['Chrome', ver(/Chrome\/(\d+)/)];
  else if (/Safari\//.test(ua)) [browser, v] = ['Safari', ver(/Version\/(\d+)/)];
  return `${device} ${browser}${v ? ` ${v}` : ''}`.slice(0, 40);
}

/** 오류 값 → 문구·스택(앞부분). */
export function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const message = `${err.name}: ${err.message}`.slice(0, CLIENT_MESSAGE_MAX);
    const stack = typeof err.stack === 'string' && err.stack ? err.stack.slice(0, CLIENT_STACK_MAX) : undefined;
    return stack ? { message, stack } : { message };
  }
  if (typeof err === 'string') return { message: err.slice(0, CLIENT_MESSAGE_MAX) };
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return { message: String((err as { message: string }).message).slice(0, CLIENT_MESSAGE_MAX) };
  }
  return { message: Object.prototype.toString.call(err) };
}

export type ReporterOptions = {
  /** 본문(JSON)을 보낸다. 기본은 fetch keepalive. 던지거나 실패해도 된다. */
  send?: (body: string) => unknown;
  now?: () => number;
  /** 지금 화면 상태(예: 'lesson', 'idle', 'pin'). 오류마다 붙인다. */
  state?: () => string;
  ua?: string;
  flushMs?: number;
};

type Tracked = { lastSentAt: number; pending: ClientErrorEvent | null };

/** POST /api/client-log 기본 보내기. 401(PIN 전)·429·네트워크 오류는 조용히 버린다(PIN 화면으로 보내지 않게 apiFetch를 쓰지 않는다). */
export function sendClientLog(body: string): void {
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {});
}

/**
 * 기기 보고를 모아 보낸다. 같은 오류(종류·자리·문구·스택 첫 줄)는 REPEAT_MS에 한 번만 보내고 나머지는 count로 묶는다.
 * 한 번에 CLIENT_LOG_MAX_EVENTS개, CLIENT_LOG_MAX_BYTES 안으로 보낸다(넘치면 스택부터 줄이고, 그래도 넘치면 다음 번으로).
 */
export class ClientReporter {
  private readonly send: (body: string) => unknown;
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly errors = new Map<string, Tracked>();
  private lessons: ClientLessonEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private reported = 0;

  constructor(private readonly opts: ReporterOptions = {}) {
    this.send = opts.send ?? sendClientLog;
    this.now = opts.now ?? (() => Date.now());
    this.flushMs = opts.flushMs ?? FLUSH_MS;
  }

  /** 오류 하나. where는 앱이 잡은 오류의 자리('lesson', 'mic' 등, 소문자·하이픈). */
  error(kind: ClientErrorKind, err: unknown, where?: string): void {
    try {
      if (this.reported >= MAX_ERROR_REPORTS) return;
      const { message, stack } = describeError(err);
      const key = `${kind}|${where ?? ''}|${message}|${stack?.split('\n', 2)[1] ?? ''}`;
      let t = this.errors.get(key);
      if (!t) {
        if (this.errors.size >= MAX_KEYS) return;
        t = { lastSentAt: -Infinity, pending: null };
        this.errors.set(key, t);
      }
      if (t.pending) {
        t.pending.count++;
        return;
      }
      const ev: ClientErrorEvent = { kind, message, count: 1 };
      if (stack) ev.stack = stack;
      if (where) ev.where = where;
      const state = this.safeState();
      if (state) ev.state = state;
      if (this.opts.ua) ev.ua = this.opts.ua;
      t.pending = ev;
      this.schedule(Math.max(this.now() + this.flushMs, t.lastSentAt + REPEAT_MS));
    } catch {
      // 계측 자체의 문제는 삼킨다.
    }
  }

  /** 수업 하나의 체감 시간. */
  lesson(ev: ClientLessonEvent): void {
    try {
      this.lessons.push(this.opts.ua ? { ...ev, ua: this.opts.ua } : ev);
      if (this.lessons.length > CLIENT_LOG_MAX_EVENTS * 4) this.lessons.shift();
      this.schedule(this.now() + this.flushMs);
    } catch {
      // 계측 자체의 문제는 삼킨다(수업 끝 처리를 막지 않게).
    }
  }

  /** 지금 보낼 수 있는 것을 모두 보낸다(창을 닫을 때). 같은 오류의 REPEAT_MS 간격은 지킨다. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
    const now = this.now();
    const ready: { ev: ClientEvent; t?: Tracked }[] = this.lessons.map((ev) => ({ ev }));
    let next = Infinity;
    for (const t of this.errors.values()) {
      if (!t.pending) continue;
      if (now >= t.lastSentAt + REPEAT_MS) ready.push({ ev: t.pending, t });
      else next = Math.min(next, t.lastSentAt + REPEAT_MS);
    }
    let sends = 0;
    while (ready.length > 0) {
      if (sends >= MAX_SENDS_PER_FLUSH) {
        next = Math.min(next, now + NEXT_SEND_MS); // 못 보낸 것(남은 lessons·pending)은 다음 번에
        break;
      }
      const { body, used } = this.encode(ready.slice(0, CLIENT_LOG_MAX_EVENTS).map((b) => b.ev));
      const batch = ready.splice(0, Math.max(1, used)); // 못 실은 것은 다음 묶음으로
      for (const b of batch) {
        if (b.t) {
          b.t.pending = null;
          b.t.lastSentAt = now;
          this.reported++;
        }
      }
      this.lessons = this.lessons.filter((l) => !batch.some((b) => b.ev === l));
      if (!body) continue; // 하나만으로도 한도를 넘는 사건은 버린다
      sends++;
      try {
        this.send(body);
      } catch {
        // 보내기 실패는 버린다.
      }
    }
    if (next < Infinity) this.schedule(next);
  }

  /** 앞에서부터 한도 안에 들어가는 만큼 싣는다(넘치면 스택을 줄여 본다). used = 실은 사건 수(앞에서부터). */
  private encode(events: ClientEvent[]): { body: string | null; used: number } {
    const fit = (evs: ClientEvent[]) => {
      const s = JSON.stringify({ events: evs });
      return new TextEncoder().encode(s).length <= CLIENT_LOG_MAX_BYTES ? s : null;
    };
    const all = fit(events);
    if (all) return { body: all, used: events.length };
    // 스택을 줄여 본다(한글 문구는 3바이트라 넘칠 수 있다).
    const short = events.map((e) => (e.kind !== 'lesson' && e.stack ? { ...e, stack: e.stack.slice(0, 200) } : e));
    let body: string | null = null;
    let used = 0;
    for (let i = 1; i <= short.length; i++) {
      const s = fit(short.slice(0, i));
      if (!s) break;
      body = s;
      used = i;
    }
    return { body, used };
  }

  private schedule(at: number): void {
    if (at >= this.timerAt) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => this.flush(), Math.max(0, at - this.now()));
  }

  private safeState(): string | undefined {
    try {
      return this.opts.state?.();
    } catch {
      return undefined;
    }
  }
}

type ErrorTarget = Pick<EventTarget, 'addEventListener'>;
type ErrorEventLike = { error?: unknown; message?: string; filename?: string; lineno?: number; colno?: number };

/**
 * window의 잡히지 않은 오류(error)와 처리 안 된 거부(unhandledrejection)를 reporter로 보낸다.
 * 페이지를 떠날 때(pagehide, 숨겨질 때) 모은 것을 바로 보낸다.
 */
export function installErrorReporting(win: ErrorTarget, doc: (ErrorTarget & { visibilityState?: string }) | null, reporter: ClientReporter): void {
  win.addEventListener('error', (e) => {
    const ev = e as unknown as ErrorEventLike;
    const err = ev.error ?? `${ev.message ?? 'error'}${ev.filename ? ` (${ev.filename.split('?')[0]}:${ev.lineno ?? 0}:${ev.colno ?? 0})` : ''}`;
    reporter.error('error', err);
  });
  win.addEventListener('unhandledrejection', (e) => reporter.error('rejection', (e as unknown as { reason?: unknown }).reason));
  win.addEventListener('pagehide', () => reporter.flush());
  doc?.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') reporter.flush();
  });
}

/**
 * 수업 하나의 체감 시간 재기: 물어본 때(만든 때)부터 첫 소리 재생 시작, 첫 획, 끝까지.
 * finish는 한 번만 사건을 만든다(두 번째부터 null).
 */
export class LessonTimer {
  private soundAt: number | null = null;
  private strokeAt: number | null = null;
  private id: string | undefined;
  private done = false;
  private readonly t0: number;

  constructor(
    private readonly question: string,
    private readonly mode: LessonMode,
    private readonly spoken: boolean,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.t0 = now();
  }

  readonly sound = (): void => {
    if (this.soundAt === null) this.soundAt = this.now();
  };

  readonly stroke = (): void => {
    if (this.strokeAt === null) this.strokeAt = this.now();
  };

  /** 서버가 알려 준 이 수업의 id(x-lesson-id). 모양이 틀리면 버린다. */
  readonly lessonId = (id: string): void => {
    if (LESSON_ID_RE.test(id)) this.id = id;
  };

  finish(result: LessonResult): ClientLessonEvent | null {
    if (this.done) return null;
    this.done = true;
    const ms = (at: number | null) => (at === null ? null : Math.max(0, Math.round(at - this.t0)));
    return {
      kind: 'lesson',
      ...(this.id ? { lessonId: this.id } : {}),
      qKey: questionKey(this.question),
      qChars: charCount(this.question.trim()),
      mode: this.mode,
      spoken: this.spoken,
      firstSoundMs: ms(this.soundAt),
      firstStrokeMs: ms(this.strokeAt),
      endMs: ms(this.now()),
      result,
    };
  }
}

/**
 * obj와 똑같이 동작하되 method를 부르기 직전에 before()를 부르는 대리 객체. 나머지 메서드·값은 원래 객체로 그대로 간다
 * (this도 원래 객체). 보드·오디오에 계측 지점을 붙일 때 쓴다(그쪽 코드를 고치지 않고).
 */
export function tapMethod<T extends object, K extends keyof T>(obj: T, method: K, before: () => void): T {
  return new Proxy(obj, {
    get(target, key) {
      const v = Reflect.get(target, key, target);
      if (typeof v !== 'function') return v;
      if (key === method) {
        return (...args: unknown[]) => {
          try {
            before();
          } catch {
            // 계측 오류는 삼킨다.
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/** 수업 스트림을 그대로 흘리면서, 던진 오류(네트워크·멈춤·HTTP 실패)를 onError로 알린다(다시 던진다). */
export async function* tapStreamError<T>(src: AsyncIterable<T>, onError: (err: unknown) => void): AsyncIterable<T> {
  try {
    yield* src;
  } catch (err) {
    try {
      onError(err);
    } catch {
      // 계측 오류는 삼킨다.
    }
    throw err;
  }
}

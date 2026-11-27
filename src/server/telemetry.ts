// 운영 계측: 수업 하나의 단계별 시간·원가(토큰·글자 수)를 모으는 계량기, 기기 보고(POST /api/client-log) 검사,
// 보고 횟수 제한, 브라우저 체감 시간을 같은 수업(lessonId)에 잇는 최근 수업 목록.
// 이 계측이 새로 남기는 줄에는 질문·대사 원문, 키, PIN, 쿠키를 남기지 않는다(질문 맞춤 열쇠 qKey도 남기지 않는다).
// 예전부터 있던 수업 줄의 question·듣기 줄의 text 원문은 기본으로 남고, LOG_TEXT=0이면 뺀다(lessonLogWithoutText 등).
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import {
  CLIENT_ERROR_KINDS,
  CLIENT_LOG_MAX_EVENTS,
  CLIENT_MESSAGE_MAX,
  CLIENT_MS_MAX,
  CLIENT_STACK_MAX,
  LESSON_ID_RE,
  LESSON_RESULTS,
  type ClientErrorEvent,
  type ClientErrorKind,
  type ClientEvent,
  type ClientLessonEvent,
  type LessonResult,
  charCount,
} from '../shared/clientLog';
import { MAX_QUESTION_CHARS } from '../shared/lesson';
import { PIN_LENGTH } from './pin';

/** Gemini 호출 하나(또는 합)의 토큰. output은 대본·그림 글자(candidates), thoughts는 생각 토큰(값은 출력 단가로 매겨진다). */
export type ModelUsage = { model: string; input: number; output: number; thoughts: number; cached: number };

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** 응답의 usageMetadata → ModelUsage. 없으면 null. */
export function usageFrom(meta: GenerateContentResponseUsageMetadata | undefined, model: string): ModelUsage | null {
  if (!meta) return null;
  return {
    model,
    input: n(meta.promptTokenCount) + n(meta.toolUsePromptTokenCount),
    output: n(meta.candidatesTokenCount),
    thoughts: n(meta.thoughtsTokenCount),
    cached: n(meta.cachedContentTokenCount),
  };
}

/** 단계별 시간(요청을 받은 때부터 ms). 그 단계가 없었으면 null. */
export type LessonStages = {
  /** Gemini 첫 글자 조각. */
  firstChunkMs: number | null;
  /** 첫 올바른 대본 줄(say·draw·page·sketch). */
  firstLineMs: number | null;
  /** 첫 문장의 TTS가 끝남(성공·실패 모두). */
  firstTtsMs: number | null;
  /** 첫 판서(draw) 줄을 브라우저로 보냄. */
  firstDrawMs: number | null;
  /** Gemini 대본 스트림이 끝남. */
  scriptEndMs: number | null;
};

/** 수업 하나의 원가 재료. 단가는 pricing.ts, 계산은 scripts/latency-report.ts. */
export type LessonUsage = {
  /** 선생님(대본) 모델. 응답에 usageMetadata가 없었으면 null. */
  teacher: ModelUsage | null;
  /** 화가: 실제로 부른 Gemini 호출 수(캐시로 넘어간 주문은 빼고)와 토큰 합. model은 토큰을 받은 호출의 모델. */
  artist: { calls: number; input: number; output: number; thoughts: number; cached: number; model?: string };
  /** TTS: 부른 횟수와 보낸 글자 수(코드 포인트). */
  tts: { model: string; calls: number; chars: number };
};

/** 수업 하나의 계량기. app.ts가 수업마다 하나 만들고, 끝날 때 stages()·usage()를 로그 줄에 싣는다. */
export class LessonMeter {
  private readonly marks: LessonStages = { firstChunkMs: null, firstLineMs: null, firstTtsMs: null, firstDrawMs: null, scriptEndMs: null };
  private teacher: ModelUsage | null = null;
  private readonly artist: LessonUsage['artist'] = { calls: 0, input: 0, output: 0, thoughts: 0, cached: 0 };
  private readonly tts: LessonUsage['tts'];

  constructor(ttsModel: string, private readonly t0: number = performance.now(), private readonly now: () => number = () => performance.now()) {
    this.tts = { model: ttsModel, calls: 0, chars: 0 };
  }

  /** 단계 시각을 처음 한 번만 적는다. */
  mark(stage: keyof LessonStages): void {
    if (this.marks[stage] === null) this.marks[stage] = Math.max(0, Math.round(this.now() - this.t0));
  }

  /** 선생님 토큰(스트림의 마지막 usageMetadata가 누적값이라 덮어쓴다). */
  teacherUsage(u: ModelUsage): void {
    this.teacher = u;
  }

  /** 화가 호출 하나가 끝났다(토큰을 모르면 null — 그래도 호출 수는 센다). */
  artistCall(u: ModelUsage | null): void {
    this.artist.calls++;
    if (!u) return;
    this.artist.input += u.input;
    this.artist.output += u.output;
    this.artist.thoughts += u.thoughts;
    this.artist.cached += u.cached;
    this.artist.model ??= u.model;
  }

  ttsCall(chars: number): void {
    this.tts.calls++;
    this.tts.chars += chars;
  }

  stages(): LessonStages {
    return { ...this.marks };
  }

  usage(): LessonUsage {
    return { teacher: this.teacher && { ...this.teacher }, artist: { ...this.artist }, tts: { ...this.tts } };
  }
}

/** 브라우저가 수업이 끝난 뒤 체감 시간을 묶어 보내기까지의 보통 지연(web/telemetry.ts FLUSH_MS). 물어본 때 짐작에 쓴다. */
const REPORT_DELAY_MS = 2000;
/** 짐작한 물어본 때보다 이만큼 더 먼저 시작한 수업에는 잇지 않는다(보고가 사라진 옛 수업에 잘못 붙지 않게). */
export const CLAIM_EARLY_MS = 2 * 60_000;

/**
 * 최근 수업 목록: 브라우저가 보낸 체감 시간(qKey)을 같은 질문의 수업(lessonId)에 잇는다.
 * 같은 질문이 겹치면(두 기기가 같은 예시 카드를 누름, 한 기기에서 다시 물음) 보고의 물어본 때(받은 때 − endMs)에
 * 가장 가까이 시작한 수업에 잇는다. 한 수업은 한 번만 이어진다. ttlMs가 지났거나 max개를 넘으면 오래된 것부터 잊는다.
 * qKey는 메모리에만 있다.
 */
export class RecentLessons {
  private items: { lessonId: string; qKey: string; at: number; claimed: boolean }[] = [];
  constructor(private readonly max = 64, private readonly ttlMs = 30 * 60_000, private readonly now: () => number = Date.now) {}

  add(lessonId: string, qKey: string): void {
    this.prune();
    this.items.push({ lessonId, qKey, at: this.now(), claimed: false });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  /**
   * 아직 이어지지 않은 그 질문의 수업 id. endMs(물어본 때 → 끝)를 알면 물어본 때에 가장 가까이 시작한 수업,
   * 모르면 먼저 시작한 수업. 없으면 null.
   */
  claim(qKey: string, endMs?: number | null): string | null {
    this.prune();
    const asked = typeof endMs === 'number' ? this.now() - endMs - REPORT_DELAY_MS : null;
    let best: (typeof this.items)[number] | null = null;
    for (const it of this.items) {
      if (it.qKey !== qKey || it.claimed) continue;
      if (asked === null) {
        best = it; // 오래된 것부터 들어 있다
        break;
      }
      if (it.at < asked - CLAIM_EARLY_MS) continue;
      if (!best || Math.abs(it.at - asked) < Math.abs(best.at - asked)) best = it;
    }
    if (!best) return null;
    best.claimed = true;
    return best.lessonId;
  }

  /**
   * 브라우저가 x-lesson-id로 받은 id를 실어 보냈을 때: 그 id의 수업이 아직 이어지지 않았고 같은 질문이면 잇는다.
   * 모르는 id(오래돼 잊음·지어낸 값)·이미 이어진 id는 null(질문으로 다른 수업에 붙이지 않는다).
   */
  claimId(lessonId: string, qKey: string): string | null {
    this.prune();
    const it = this.items.find((x) => x.lessonId === lessonId);
    if (!it || it.claimed || it.qKey !== qKey) return null;
    it.claimed = true;
    return it.lessonId;
  }

  private prune(): void {
    const cut = this.now() - this.ttlMs;
    if (this.items.length > 0 && this.items[0].at < cut) this.items = this.items.filter((it) => it.at >= cut);
  }
}

/** 보고 횟수 한도: 한 곳(주소)마다 초당·분당, 그리고 모든 곳을 합친 분당. */
export const CLIENT_LOG_PER_SEC = 5;
export const CLIENT_LOG_PER_MIN = 30;
export const CLIENT_LOG_GLOBAL_PER_MIN = 120;

/** 고정 창(1초·1분) 횟수 제한. 넘으면 false. */
export function createRateLimiter(
  opts: { perSec?: number; perMin?: number; globalPerMin?: number; now?: () => number } = {},
): (key: string) => boolean {
  const perSec = opts.perSec ?? CLIENT_LOG_PER_SEC;
  const perMin = opts.perMin ?? CLIENT_LOG_PER_MIN;
  const globalPerMin = opts.globalPerMin ?? CLIENT_LOG_GLOBAL_PER_MIN;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { sec: number; secCount: number; min: number; minCount: number }>();
  let gMin = -1;
  let gCount = 0;
  return (key) => {
    const t = now();
    const sec = Math.floor(t / 1000);
    const min = Math.floor(t / 60_000);
    if (min !== gMin) {
      gMin = min;
      gCount = 0;
      for (const [k, v] of seen) if (v.min !== min) seen.delete(k); // 지난 분의 기록은 잊는다
    }
    let s = seen.get(key);
    if (!s) {
      if (seen.size >= 1000) return false; // 낯선 주소가 이만큼이면 받지 않는다(기록 폭주 막이)
      s = { sec, secCount: 0, min, minCount: 0 };
      seen.set(key, s);
    }
    if (s.sec !== sec) {
      s.sec = sec;
      s.secCount = 0;
    }
    if (s.min !== min) {
      s.min = min;
      s.minCount = 0;
    }
    if (s.secCount >= perSec || s.minCount >= perMin || gCount >= globalPerMin) return false;
    s.secCount++;
    s.minCount++;
    gCount++;
    return true;
  };
}

/**
 * 로그 보는 화면(터미널·편집기)을 속일 수 있는 글자: C0·C1 제어 문자(ESC·CSI 등, 줄바꿈 \n·탭 \t은 스택에 필요해 둔다),
 * 글자 방향 바꿈(RLO 등), 줄·문단 구분자(U+2028·2029).
 */
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/**
 * 따로 떨어진 PIN 길이의 숫자. 앞이 숫자·점(소수점 아래)이거나 스택 위치(`파일.js:` `파일.js:줄:`)의 쌍점이면 남긴다
 * — 그 밖의 쌍점(`pin:123456`)은 지운다.
 */
const PIN_LIKE = new RegExp(`(?<![\\d.])(?<!\\.[A-Za-z]{1,5}(?::\\d+)?:)\\d{${PIN_LENGTH}}(?!\\d)`, 'g');

/**
 * 오류 문구·스택에서 개인정보·비밀로 보일 만한 것을 지운다: 주소의 ?쿼리·#조각, 긴 토큰(키·쿠키 값 모양),
 * 따로 떨어진 PIN 길이(PIN_LENGTH)의 숫자, 로그 화면을 속이는 글자. 그다음 max자로 자른다.
 */
export function scrubText(s: string, max: number): string {
  return s
    .replace(UNSAFE_CHARS, ' ')
    .replace(/(https?:\/\/[^\s?#]*)[?#][^\s)]*/g, '$1')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(PIN_LIKE, '[n]')
    .slice(0, max);
}

/**
 * LOG_TEXT=0(원문 끄기)일 때의 수업 줄: 질문 원문(question)을 빼고 나머지(qChars 등)는 그대로.
 * 기본(켜짐)은 지금처럼 원문을 남긴다(가족용 — 아이가 무엇을 물었는지 부모가 본다).
 */
export function lessonLogWithoutText<T extends { question: string }>(entry: T): Omit<T, 'question'> {
  const { question: _question, ...rest } = entry;
  return rest;
}

/** LOG_TEXT=0일 때의 듣기 줄: 들은 말(text) 대신 글자 수(chars)만. */
export function listenLogWithoutText<T extends { text: string }>(entry: T): Omit<T, 'text'> & { chars: number } {
  const { text, ...rest } = entry;
  return { chars: charCount(text), ...rest };
}

const TOKEN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UA = /^[A-Za-z0-9 ._/-]{1,40}$/;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const msOrNull = (v: unknown): number | null | undefined => (v === null ? null : isInt(v, 0, CLIENT_MS_MAX) ? v : undefined);

function parseErrorEvent(e: Record<string, unknown>): ClientErrorEvent | null {
  if (!CLIENT_ERROR_KINDS.includes(e.kind as ClientErrorKind)) return null;
  if (typeof e.message !== 'string') return null;
  const ev: ClientErrorEvent = {
    kind: e.kind as ClientErrorKind,
    message: scrubText(e.message, CLIENT_MESSAGE_MAX),
    count: isInt(e.count, 1, 1_000_000) ? e.count : 1,
  };
  if (typeof e.stack === 'string' && e.stack) ev.stack = scrubText(e.stack, CLIENT_STACK_MAX);
  if (typeof e.where === 'string' && TOKEN.test(e.where)) ev.where = e.where;
  if (typeof e.state === 'string' && TOKEN.test(e.state)) ev.state = e.state;
  if (typeof e.ua === 'string' && UA.test(e.ua)) ev.ua = e.ua;
  return ev;
}

function parseLessonEvent(e: Record<string, unknown>): ClientLessonEvent | null {
  if (typeof e.qKey !== 'string' || !/^[0-9a-f]{8}$/.test(e.qKey)) return null;
  if (!isInt(e.qChars, 0, MAX_QUESTION_CHARS)) return null;
  if (e.mode !== 'quick' && e.mode !== 'deep') return null;
  if (typeof e.spoken !== 'boolean') return null;
  if (!LESSON_RESULTS.includes(e.result as LessonResult)) return null;
  const firstSoundMs = msOrNull(e.firstSoundMs);
  const firstStrokeMs = msOrNull(e.firstStrokeMs);
  const endMs = msOrNull(e.endMs);
  if (firstSoundMs === undefined || firstStrokeMs === undefined || endMs === undefined) return null;
  const ev: ClientLessonEvent = {
    kind: 'lesson', qKey: e.qKey, qChars: e.qChars, mode: e.mode, spoken: e.spoken,
    firstSoundMs, firstStrokeMs, endMs, result: e.result as LessonResult,
  };
  if (typeof e.ua === 'string' && UA.test(e.ua)) ev.ua = e.ua;
  if (typeof e.lessonId === 'string' && LESSON_ID_RE.test(e.lessonId)) ev.lessonId = e.lessonId;
  return ev;
}

/**
 * 보고 본문 검사: { events: [...] }(최대 CLIENT_LOG_MAX_EVENTS개). 정해진 필드만 골라 새 객체로 만든다(모르는 필드는 버림).
 * 모양이 틀린 사건 하나는 그것만 버리고, 본문 자체가 틀리면 null.
 */
export function parseClientLog(body: unknown): ClientEvent[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > CLIENT_LOG_MAX_EVENTS) return null;
  const out: ClientEvent[] = [];
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const ev = e.kind === 'lesson' ? parseLessonEvent(e) : parseErrorEvent(e);
    if (ev) out.push(ev);
  }
  return out;
}

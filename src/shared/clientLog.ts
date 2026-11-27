// 기기 오류·체감 시간 보고(POST /api/client-log)의 모양과 한도. 브라우저(telemetry.ts)와 서버(telemetry.ts)가 함께 쓴다.
// 질문·대사 원문, 키, PIN, 쿠키는 담지 않는다. 질문은 글자 수와 짧은 맞춤 열쇠(qKey)만 — qKey는 서버가 같은 질문의
// 수업 줄(lessonId)을 찾는 데만 쓰고 로그에 남기지 않는다.

/** 보고 본문 한도(바이트). 서버 bodyLimit과 브라우저 묶음 크기가 함께 쓴다. */
export const CLIENT_LOG_MAX_BYTES = 4096;
/** 한 번에 보내는 사건 수 한도. */
export const CLIENT_LOG_MAX_EVENTS = 8;
export const CLIENT_MESSAGE_MAX = 300;
export const CLIENT_STACK_MAX = 800;
/** 체감 시간 값의 상한(ms). 넘으면 잘못된 값으로 보고 버린다. */
export const CLIENT_MS_MAX = 30 * 60_000;

/** 잡히지 않은 오류(error), 처리 안 된 거부(rejection), 앱이 잡아서 사용자에게 보여 준 오류(app). */
export const CLIENT_ERROR_KINDS = ['error', 'rejection', 'app'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];
export const LESSON_RESULTS = ['done', 'error', 'aborted'] as const;
export type LessonResult = (typeof LESSON_RESULTS)[number];

export type ClientErrorEvent = {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  /** 앱이 잡은 오류의 자리(예: 'lesson', 'mic'). 소문자·숫자·하이픈만. */
  where?: string;
  /** 같은 오류가 몇 번 났나(브라우저가 묶어서 보낸다). */
  count: number;
  /** 그때 화면 상태(예: 'lesson', 'idle', 'pin'). */
  state?: string;
  /** UA 요약(예: 'iPad Safari 18'). */
  ua?: string;
};

/** 수업 하나의 브라우저 쪽 체감 시간(물어보기 → 첫 소리 재생 시작, → 첫 획, → 끝). 못 쟀으면 null. */
export type ClientLessonEvent = {
  kind: 'lesson';
  /** 서버가 수업 응답 머리글(x-lesson-id)로 알려 준 그 수업의 id. 받았으면 서버는 이것으로 바로 잇는다(qKey는 대비용). */
  lessonId?: string;
  qKey: string;
  qChars: number;
  mode: 'quick' | 'deep';
  spoken: boolean;
  firstSoundMs: number | null;
  firstStrokeMs: number | null;
  endMs: number | null;
  result: LessonResult;
  ua?: string;
};

export type ClientEvent = ClientErrorEvent | ClientLessonEvent;

/** 수업 id 모양(서버 randomBytes(6).toString('base64url') → 8자). */
export const LESSON_ID_RE = /^[A-Za-z0-9_-]{8}$/;
export type ClientLogBody = { events: ClientEvent[] };

/**
 * 질문 맞춤 열쇠: 다듬은(trim) 질문의 FNV-1a 32비트 해시(16진 8자). 서버도 받은 질문으로 같은 값을 만든다.
 * 서버는 이것으로 같은 질문의 최근 수업을 찾을 뿐, 로그에는 남기지 않는다.
 */
export function questionKey(question: string): string {
  let h = 0x811c9dc5;
  const s = question.trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 글자 수(코드 포인트). 한글 음절은 한 글자. */
export const charCount = (s: string): number => [...s].length;

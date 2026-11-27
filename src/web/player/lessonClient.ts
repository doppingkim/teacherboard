import type { LessonContext, LessonMessage, LessonMode, Level } from '../../shared/lesson';
import { LANG, pick } from '../i18n';
import type { Profile } from '../../shared/script';
import { apiFetch } from '../pinClient';

/**
 * 줄 단위 JSON 스트림을 객체로 읽는다. 조각 경계(여러 바이트 글자 포함)에 상관없이 줄을 모은다.
 * 빈 줄과 JSON이 아닌 줄은 건너뛴다. 소비자가 중간에 멈추면 스트림을 취소한다.
 */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (line: string): { ok: true; value: T } | { ok: false } => {
    const s = line.trim();
    if (!s) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(s) as T };
    } catch {
      return { ok: false };
    }
  };
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const r = parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (r.ok) yield r.value;
      }
    }
    buf += decoder.decode();
    const r = parse(buf);
    if (r.ok) yield r.value;
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * 수업 스트림이 이만큼 아무 줄도 보내지 않으면(서버·모델이 멈춤, 연결이 소리 없이 끊김) 요청을 끊고 오류로 끝낸다.
 * 신중한 선생님의 첫 문장(약 20초)·화가(최대 20초)·TTS(최대 15초)보다 넉넉하게.
 */
export const LESSON_IDLE_MS = 90_000;

/** 서버가 동시 수업 한도로 거절했을 때(429 busy) 자막에 보일 안내. 일반 오류("문제가 생겼어")와 달리 기다리면 된다고 알린다. */
export const BUSY_MESSAGE = pick('지금 다른 수업이 한창이야. 잠깐 뒤에 다시 물어봐 줄래?', 'Another lesson is going on right now. Could you ask again in a moment?');

/**
 * 수업 스트림. 요청은 이 함수를 부르는 즉시 보낸다(읽기 시작을 기다리지 않음) —
 * 그래서 채움 음성이 나가는 동안에도 서버는 이미 수업을 만들고 있다.
 * 응답이 실패(400 등)면 첫 next()에서 던진다. 401(가족 비밀번호)이면 apiFetch가 PIN 화면으로 돌려보낸다.
 * context(끼어들기 문맥)는 있을 때만 보낸다 — 서버는 `context: null`을 잘못된 요청(400)으로 본다.
 * heard(말로 물었을 때 받아 적은 그대로의 말)도 있을 때만 보낸다.
 * onLessonId(선택, 운영 계측): 서버가 응답 머리글 x-lesson-id로 알려 준 이 수업의 id(기기 체감 시간을 같은 수업에 잇는다).
 */
export function streamLesson(
  question: string, profile: Profile, signal: AbortSignal, context?: LessonContext, heard?: string, mode: LessonMode = 'quick', level?: Level,
  onLessonId?: (id: string) => void,
): AsyncIterable<LessonMessage> {
  // 바깥 신호(새 질문·프로필 바꿈) 또는 멈춤 감시로 요청을 끊는다. 끊기면 fetch와 본문 읽기가 오류로 끝난다.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal.aborted) ctl.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error('lesson stream stalled')), LESSON_IDLE_MS);
  };
  const disarm = () => {
    clearTimeout(idle);
    signal.removeEventListener('abort', onAbort);
  };
  arm();
  const res = apiFetch('/api/lesson', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, profile, mode, ...(level ? { level } : {}), ...(context ? { context } : {}), ...(heard !== undefined ? { heard } : {}), ...(LANG === 'ko' ? {} : { lang: LANG }) }),
    signal: ctl.signal,
  });
  res.catch(() => {}); // 끝내 읽지 않아도 처리되지 않은 거부가 되지 않게
  return (async function* () {
    try {
      const r = await res;
      if (r.status === 429) {
        // 동시 수업 한도(app.ts busy): 서버 안내문처럼 error 메시지로 넘겨 자막에 알맞은 문구가 뜨게 한다.
        await r.body?.cancel().catch(() => {});
        yield { type: 'error', message: BUSY_MESSAGE };
        return;
      }
      if (!r.ok || !r.body) throw new Error(`lesson request failed: ${r.status}`);
      const lessonId = r.headers.get('x-lesson-id');
      if (lessonId && onLessonId) {
        try {
          onLessonId(lessonId);
        } catch {
          // 계측 콜백 오류가 수업을 깨뜨리지 않게 한다.
        }
      }
      arm();
      for await (const m of readNdjson<LessonMessage>(r.body)) {
        arm();
        yield m;
      }
    } finally {
      disarm();
    }
  })();
}

/**
 * src를 그대로 흘리면서, 서버가 보낸 {type:'error'}의 문구를 onError로 알린다.
 * 그 문구는 서버가 정해 둔 안전한 안내문(거절·대본 오류)이라 그대로 화면에 보여도 된다.
 */
export async function* watchServerError(
  src: AsyncIterable<LessonMessage>,
  onError: (message: string) => void,
): AsyncIterable<LessonMessage> {
  for await (const m of src) {
    if (m.type === 'error' && typeof m.message === 'string' && m.message.trim()) onError(m.message);
    yield m;
  }
}

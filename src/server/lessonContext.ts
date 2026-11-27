import { MAX_CONTEXT_SPOKEN, MAX_QUESTION_CHARS, MAX_SPOKEN_CHARS, type Lang, type LessonContext } from '../shared/lesson';

/**
 * 요청 본문의 `context`를 검사한다.
 * undefined = 문맥 없음(보통 질문), null = 잘못된 문맥(→ 400). 한도를 넘으면 자르지 않고 잘못됨으로 본다.
 */
export function parseLessonContext(v: unknown): LessonContext | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { previousQuestion, spoken, interrupted } = v as Record<string, unknown>;
  if (typeof previousQuestion !== 'string') return null;
  const q = previousQuestion.trim();
  if (q.length === 0 || q.length > MAX_QUESTION_CHARS) return null;
  if (!Array.isArray(spoken) || spoken.length > MAX_CONTEXT_SPOKEN) return null;
  if (!spoken.every((s): s is string => typeof s === 'string' && s.length <= MAX_SPOKEN_CHARS)) return null;
  if (interrupted !== undefined && typeof interrupted !== 'boolean') return null;
  const ctx: LessonContext = { previousQuestion: q, spoken: [...spoken] };
  if (interrupted !== undefined) ctx.interrupted = interrupted;
  return ctx;
}

/**
 * 사용자 쪽 글(질문·앞 질문·선생님 말·받아 적은 말) 속 줄바꿈은 공백 하나로: 줄 단위로 짠 문맥
 * ("방금 수업 질문: …")을 흉내 내 지시처럼 보이게 하지 못하게.
 */
const oneLine = (s: string): string => s.replace(/[^\S\r\n\v\f\u0085\u2028\u2029]*[\r\n\v\f\u0085\u2028\u2029]+\s*/g, ' ');

/**
 * 말로 물은 질문(음성 인식)이면 붙이는 안내. heard는 받아 적은 그대로의 말(question은 판별 모델이 고쳐 적은 말).
 * 소리가 비슷한 낱말로 잘못 받아 적는 일(예: 허리디스크 → 퀄리디스크)이 있어, 대본 모델이 조용히 바로잡게 한다.
 */
function voiceNote(question: string, heard: string, lang: Lang = 'ko'): string[] {
  const raw = oneLine(heard).trim();
  if (lang === 'en') {
    return [
      '(This question was spoken and transcribed by speech recognition. Some words may have been misheard as similar-sounding words, e.g. "photo synthesis" → "photosynthesis".',
      ...(raw && raw !== question.trim() ? [`Exactly as transcribed: ${raw}`] : []),
      'Understand it as the most plausible original wording and use the corrected words in the title and explanation. Do not mention that anything was misheard.)',
    ];
  }
  return [
    '(이 질문은 말로 물은 것을 음성 인식이 받아 적은 거예요. 소리가 비슷한 다른 낱말로 잘못 적혔을 수 있어요. 예: 허리디스크 → 퀄리디스크.',
    ...(raw && raw !== question.trim() ? [`받아 적은 그대로: ${raw}`] : []),
    '가장 그럴듯한 원래 말로 알아듣고, 제목과 설명에도 바로잡은 말을 써 주세요. 잘못 들었다는 얘기는 하지 마세요.)',
  ];
}

/**
 * 앞 수업이 있을 때 붙이는 안내: "아직 이해가 안 돼"처럼 다시 설명해 달라는 말이면
 * 같은 제목·같은 설명을 되풀이하지 말고 다른 길로 풀게 한다(2026-11-22 사용자 요청).
 */
export const RETRY_NOTE = [
  '다시 설명해 달라는 말(예: 아직 이해가 안 돼, 무슨 말인지 모르겠어, 다시 설명해 줘)이면 이렇게 해 주세요:',
  '- 위에 적힌 선생님 말에서 쓴 비유·예·그림은 하나도 다시 쓰지 마세요. 같은 제목·같은 설명을 되풀이하면 안 돼요.',
  '- 먼저 앞 설명에서 어디가 어려웠을지 짐작해서(어려운 낱말, 너무 큰 단계, 눈에 안 보이는 개념) 그 부분을 집중해서 풀어요.',
  '- 수준을 한 단계 낮춰요: 더 어린 아이에게 말하듯, 더 짧은 문장과 더 쉬운 낱말로.',
  '- 완전히 다른 각도의 비유 하나를 골라(몸으로 해 볼 수 있는 것, 집에서 직접 볼 수 있는 것이면 더 좋아요) 그 비유 하나로 처음부터 끝까지 설명해요.',
  '- 그림도 다른 방식으로: 앞에서 장면을 보였으면 이번엔 나란히 비교나 단계별 그림으로.',
  '- 첫 말은 "그럼 이번엔 다르게 설명해 볼게!"처럼 시작하고, 제목은 질문을 그대로 쓰지 말고 새 비유의 핵심을 담아요.',
  '- 마지막에 한 문장으로 다시 정리해요.',
].join('\n');

/** RETRY_NOTE의 영어판. */
export const RETRY_NOTE_EN = [
  'If this asks you to explain again (e.g. "I still don\'t get it", "I don\'t understand", "explain again"), do this:',
  '- Do not reuse any analogy, example, or picture from the teacher\'s words above. Never repeat the same title or the same explanation.',
  '- First guess which part of the previous explanation was hard (a hard word, a step too big, an invisible concept) and focus on that part.',
  '- Go one level simpler: as if talking to a younger child, with shorter sentences and easier words.',
  '- Pick one analogy from a completely different angle (even better if it is something you can try with your body or see at home) and explain with that one analogy from start to finish.',
  '- Draw differently too: if you showed a scene before, this time use a side-by-side comparison or a step-by-step picture.',
  '- Start with something like "Okay, let me explain it a different way!", and do not reuse the question as the title — capture the core of the new analogy.',
  '- End by summing it up again in one sentence.',
].join('\n');

/**
 * 선생님 모델(Gemini)에게 보낼 user 내용. 문맥도 heard도 없으면 질문 그대로.
 * 어른 프로필에서도 같은 문장을 쓰도록 "아이가" 대신 "듣는 사람이"라고 쓴다.
 * heard(선택): 말로 물었을 때 음성 인식이 받아 적은 그대로의 말. 있으면 오인식 안내를 붙인다.
 */
export function buildUserMessage(rawQuestion: string, ctx?: LessonContext, heard?: string, lang: Lang = 'ko'): string {
  const question = oneLine(rawQuestion);
  const note = heard === undefined ? [] : voiceNote(question, heard, lang);
  if (!ctx) return note.length ? [question, ...note].join('\n') : question;
  const previousQuestion = oneLine(ctx.previousQuestion);
  const spoken = ctx.spoken.map((s) => oneLine(s).trim()).filter(Boolean);
  if (lang === 'en') {
    if (ctx.interrupted === false) {
      return [
        `Question of the lesson that just ended: ${previousQuestion}`,
        `What the teacher said then: ${spoken.length ? spoken.join(' ') : '(nothing)'}`,
        `Follow-up question: ${question}`,
        'If it is related to the previous lesson, continue from it; if it is a new topic, explain it fresh.',
        RETRY_NOTE_EN,
        ...note,
      ].join('\n');
    }
    return [
      `Question of the current lesson: ${previousQuestion}`,
      `What the teacher has said so far: ${spoken.length ? spoken.join(' ') : '(nothing yet)'}`,
      `The listener interrupted and asked: ${question}`,
      'Continue from the previous lesson.',
      RETRY_NOTE_EN,
      ...note,
    ].join('\n');
  }
  if (ctx.interrupted === false) {
    // 수업이 끝난 뒤 이어 물었다: 꼭 이어서 설명할 필요는 없다(새 주제일 수도 있다).
    return [
      `방금 끝난 수업 질문: ${previousQuestion}`,
      `그때 선생님이 한 말: ${spoken.length ? spoken.join(' ') : '(없음)'}`,
      `이어서 물은 말: ${question}`,
      '앞 수업과 관련 있으면 이어서, 새 주제면 새로 설명해 주세요.',
      RETRY_NOTE,
      ...note,
    ].join('\n');
  }
  return [
    `방금 수업 질문: ${previousQuestion}`,
    `선생님이 지금까지 한 말: ${spoken.length ? spoken.join(' ') : '(아직 없음)'}`,
    `듣는 사람이 이렇게 끼어들어 물었어요: ${question}`,
    '앞 수업과 이어서 설명해 주세요.',
    RETRY_NOTE,
    ...note,
  ].join('\n');
}

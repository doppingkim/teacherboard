// 수업 대본(JSON Lines)을 쓰는 선생님 모델: Gemini.
// 빠른 선생님 = Gemini 3.8 Flash(생각 low), 신중한 선생님 = Gemini 4 Neon(생각 medium, 그림도 직접).
import type { Lang, LessonContext, LessonMode, Level } from '../shared/lesson';
import type { Profile } from '../shared/script';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { blockedReason, getGemini, modelFor, thinkingFor, type GenAI } from './gemini';
import { usageFrom, type ModelUsage } from './telemetry';
import { buildUserMessage } from './lessonContext';
import { buildSystemPrompt } from './prompts';
import { buildSystemPromptEn } from './prompts.en';

/** 모델(안전 정책)이 이 질문의 수업을 막았을 때. */
export class RefusalError extends Error {
  constructor(message = '선생님 모델이 이 질문에 대한 수업을 막았습니다') {
    super(message);
    this.name = 'RefusalError';
  }
}

/** 대본 최대 길이(생각 포함 토큰). 신중한 선생님은 그림 좌표까지 쓰므로 넉넉히. */
const MAX_OUTPUT = { quick: 16000, deep: 32000 } as const;

/**
 * 질문 하나에 대한 대본(JSON Lines) 텍스트 조각을 스트리밍한다.
 * 조각은 줄 경계와 상관없이 오므로 LineSplitter로 줄을 모은다.
 * `client`는 테스트용 주입 지점이다. 생략하면 .env의 GEMINI_API_KEY로 만든 클라이언트를 쓴다.
 * `context`가 있으면(수업 중 끼어들기) 앞 수업 내용을 user 메시지에 함께 담는다.
 * `heard`가 있으면(말로 물음) 음성 인식 오인식을 바로잡으라는 안내를 붙인다.
 * `onUsage`는 스트림이 끝날 때(정상·오류·중단) 마지막으로 받은 usageMetadata(누적값)로 한 번 불린다. 없었으면 부르지 않는다.
 */
export async function* streamScriptText(
  question: string,
  profile: Profile,
  signal: AbortSignal,
  client: GenAI = getGemini(),
  context?: LessonContext,
  heard?: string,
  mode: LessonMode = 'quick',
  level?: Level,
  onUsage?: (u: ModelUsage) => void,
  lang: Lang = 'ko',
): AsyncIterable<string> {
  const model = modelFor(mode);
  const stream = await client.models.generateContentStream({
    model,
    contents: [{ role: 'user', parts: [{ text: buildUserMessage(question, context, heard, lang) }] }],
    config: {
      // 긴 시스템 지시문은 Gemini가 알아서(암묵적 캐시) 싸게 다시 읽는다.
      systemInstruction: lang === 'en' ? buildSystemPromptEn(profile, mode, level) : buildSystemPrompt(profile, mode, level),
      thinkingConfig: { thinkingLevel: thinkingFor(mode) },
      maxOutputTokens: MAX_OUTPUT[mode],
      abortSignal: signal,
    },
  });

  let blocked: string | null = null;
  let finish: string | undefined;
  let wrote = false;
  let usage: GenerateContentResponseUsageMetadata | undefined;
  try {
    for await (const chunk of stream) {
      blocked = blockedReason(chunk) ?? blocked;
      finish = chunk.candidates?.[0]?.finishReason ?? finish;
      usage = chunk.usageMetadata ?? usage;
      const text = chunk.text; // 생각은 받지 않는다(includeThoughts 꺼짐): 대본 글자만
      if (text) {
        wrote = true;
        yield text;
      }
    }
  } finally {
    const u = usageFrom(usage, model);
    try {
      if (u) onUsage?.(u);
    } catch {
      // 기록 쪽 문제로 수업을 멈추지 않는다.
    }
  }
  if (blocked) throw new RefusalError(`선생님 모델이 수업을 막았습니다 (${blocked})`);
  // 글자 하나 없이 끝났다(생각만 하다 MAX_TOKENS, RECITATION 등): 이유를 서버 로그에 남기게 던진다.
  if (!wrote) throw new Error(`선생님 모델이 빈 응답을 보냈습니다 (finish ${finish ?? '없음'})`);
}

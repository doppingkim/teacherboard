// Google Gemini API 공용: 클라이언트, 모델 이름, 생각 수준, 거절(차단) 판별.
// 2026-11-22: Anthropic 크레딧이 끊겨 Gemini(사용자의 Google 크레딧)로 옮겼다. 모델은 사용자 결정:
// 빠른 선생님 = Gemini 3.8 Flash, 신중한 선생님 = Gemini 4 Neon, 화가 = 3.8 Flash, 말 판별 = 3.5 Flash-Lite.
import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse } from '@google/genai';
import { requireEnv } from './config';

/** 우리가 쓰는 부분만(테스트가 가짜를 넣는다). */
export type GenAI = { models: Pick<GoogleGenAI['models'], 'generateContent' | 'generateContentStream'> };

let shared: GenAI | undefined;
/** .env의 GEMINI_API_KEY로 만든 클라이언트(처음 쓸 때 한 번). */
export const getGemini = (): GenAI => (shared ??= new GoogleGenAI({ apiKey: requireEnv(['GEMINI_API_KEY']).GEMINI_API_KEY }));

/** 모델 이름. .env로 바꿀 수 있다(QUICK_MODEL, DEEP_MODEL, ARTIST_MODEL, CLASSIFY_MODEL). */
export const MODEL_DEFAULTS = {
  quick: 'gemini-3.8-flash',
  deep: 'gemini-4-neon',
  artist: 'gemini-3.8-flash',
  classify: 'gemini-3.5-flash-lite',
} as const;
export type ModelRole = keyof typeof MODEL_DEFAULTS;
const MODEL_ENV: Record<ModelRole, string> = { quick: 'QUICK_MODEL', deep: 'DEEP_MODEL', artist: 'ARTIST_MODEL', classify: 'CLASSIFY_MODEL' };
export const modelFor = (role: ModelRole): string => process.env[MODEL_ENV[role]] || MODEL_DEFAULTS[role];

/**
 * 생각 수준. Gemini 3.8 Flash·4 시리즈는 생각을 끌 수 없고 low가 가장 낮다(공식 모델 페이지).
 * 신중한 선생님은 high(사용자 결정). 실측(2026-11-22, 아이 질문 2개): 첫 줄까지 high 14~24초 / medium 8~10초.
 * high가 비유·직접 해 보기가 더 풍부했다. DEEP_THINKING=medium으로 빠르게 할 수 있다.
 */
const LEVEL_DEFAULTS: Record<ModelRole, ThinkingLevel> = {
  quick: ThinkingLevel.LOW,
  deep: ThinkingLevel.HIGH,
  artist: ThinkingLevel.LOW,
  classify: ThinkingLevel.LOW,
};
const LEVEL_ENV: Record<ModelRole, string> = { quick: 'QUICK_THINKING', deep: 'DEEP_THINKING', artist: 'ARTIST_THINKING', classify: 'CLASSIFY_THINKING' };
export function thinkingFor(role: ModelRole): ThinkingLevel {
  const v = (process.env[LEVEL_ENV[role]] ?? '').toUpperCase();
  return (Object.values(ThinkingLevel) as string[]).includes(v) && v !== ThinkingLevel.THINKING_LEVEL_UNSPECIFIED
    ? (v as ThinkingLevel)
    : LEVEL_DEFAULTS[role];
}

/** 안전 정책으로 막혔으면 그 이유(로그용), 아니면 null. 질문이 막혔거나(promptFeedback) 답이 도중에 막혔을 때. */
export function blockedReason(res: Pick<GenerateContentResponse, 'promptFeedback' | 'candidates'>): string | null {
  const prompt = res.promptFeedback?.blockReason;
  if (prompt) return `prompt ${prompt}`;
  const finish = res.candidates?.[0]?.finishReason;
  if (finish && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'].includes(String(finish))) return `finish ${finish}`;
  return null;
}

/** 출력이 길이 한도에서 잘렸는가. */
export const hitMaxTokens = (res: Pick<GenerateContentResponse, 'candidates'>): boolean =>
  String(res.candidates?.[0]?.finishReason ?? '') === 'MAX_TOKENS';

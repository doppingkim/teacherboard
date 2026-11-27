// 원가 추정용 단가(scripts/latency-report.ts가 수업 로그의 토큰·글자 수에 곱한다). config.ts가 다시 내보낸다.
// 값을 모르면 'unknown' — 0으로 두면 "공짜"로 읽히므로 쓰지 않는다. 실제 청구서·요금표를 보고 숫자로 바꿔 넣는다.
// 단위: Gemini는 USD / 100만 토큰, TTS는 USD / 1글자.

export type Price = number | 'unknown';
export type ModelPrice = {
  /** 입력 토큰(캐시로 읽지 않은 것). */
  input: Price;
  /** 캐시로 읽은 입력 토큰. */
  cachedInput: Price;
  /** 출력 토큰(생각 토큰 포함). */
  output: Price;
};

const UNKNOWN: ModelPrice = { input: 'unknown', cachedInput: 'unknown', output: 'unknown' };

/** 모델 이름 → 단가. 목록에 없는 모델은 모두 unknown으로 본다. */
export const GEMINI_PRICES: Record<string, ModelPrice> = {
  'gemini-3.8-flash': UNKNOWN,
  'gemini-4-neon': UNKNOWN,
  'gemini-3.5-flash-lite': UNKNOWN,
};

/** TTS 모델 이름 → 글자당 단가. */
export const TTS_PRICES: Record<string, Price> = {
  eleven_v4_turbo: 'unknown',
};

export const geminiPrice = (model: string): ModelPrice => GEMINI_PRICES[model] ?? UNKNOWN;
export const ttsPrice = (model: string): Price => TTS_PRICES[model] ?? 'unknown';

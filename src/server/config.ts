import 'dotenv/config';
import type { Profile } from '../shared/script';
import { isValidPin, PIN_LENGTH } from './pin';

/** 원가 추정 단가(값을 모르면 'unknown'). scripts/latency-report.ts가 쓴다. */
export { GEMINI_PRICES, TTS_PRICES, geminiPrice, ttsPrice, type ModelPrice, type Price } from './pricing';

export type Config = {
  geminiKey: string;
  elevenKey: string;
  voice: Record<Profile, string>;
  /** 영어 수업 목소리(선택, ELEVENLABS_VOICE_KID_EN·ELEVENLABS_VOICE_ADULT_EN). 하나만 정하면 나머지는 voice 그대로. */
  voiceEn?: Record<Profile, string>;
  port: number;
  /** 가족 비밀번호. ''이면 관문을 끈다(혼자 PC에서 개발할 때). */
  familyPin: string;
  /** 쿠키 서명 비밀. 있으면 서버를 다시 켜도 기기가 기억된다. */
  pinSecret?: string;
  /** TRUST_PROXY=1(true·yes·on도): 이 컴퓨터의 터널(ngrok)이 붙인 X-Forwarded-For·Proto를 믿는다. */
  trustProxy: boolean;
  /** 기동은 막지 않지만 서버 로그에 남길 설정 경고(예: 알 수 없는 TRUST_PROXY 값). 없으면 이 필드도 없다. */
  warnings?: string[];
  /** 서버가 열리는 주소(HOST). 기본 127.0.0.1(이 컴퓨터에서만). */
  host: string;
  /**
   * LOG_TEXT: 수업 줄의 질문(question)·듣기 줄의 들은 말(text) 원문을 서버 로그에 남기나. 기본 켜짐(가족용 — 아이가 무엇을
   * 물었는지 부모가 본다). 0·false·no·off면 원문 대신 글자 수만 남긴다(다른 집에 내놓을 때).
   */
  logText: boolean;
};

/** PIN_SECRET 최소 길이(짧으면 쿠키 서명을 추측할 수 있다). */
export const PIN_SECRET_MIN = 32;

/**
 * 켜짐/꺼짐 값 읽기. 1·true·yes·on → true, 비었거나 0·false·no·off → false(대소문자 무시).
 * 그 밖의 값은 null(알 수 없음 — 부르는 쪽이 꺼짐으로 보고 경고를 남긴다).
 */
export function parseFlag(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase() ?? '';
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['', '0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

/** 이 컴퓨터에서만 받는 주소인가(127.x, ::1, localhost). */
const isLoopbackHost = (h: string): boolean => h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

/** 서버(index.ts)가 띄울 때 필요한 네 변수. 스크립트는 requireEnv로 필요한 것만 요구한다. */
export const ENV_VARS = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_KID', 'ELEVENLABS_VOICE_ADULT'] as const;
export type EnvVar = (typeof ENV_VARS)[number];

/**
 * names에 있는 변수만 검사해 trim한 값을 돌려준다. 비어 있는 것이 있으면 빠진 이름을 모두 담아 던진다.
 * 예) 목소리 샘플 스크립트는 ELEVENLABS_API_KEY만, Gemini 클라이언트는 GEMINI_API_KEY만.
 */
export function requireEnv<K extends EnvVar>(names: readonly K[], env: NodeJS.ProcessEnv = process.env): Record<K, string> {
  const missing = names.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`필수 환경 변수가 없습니다: ${missing.join(', ')} (.env.example 참고)`);
  }
  const out = {} as Record<K, string>;
  for (const k of names) out[k] = env[k]!.trim();
  return out;
}

/** 서버 전체 설정. 네 변수가 모두 있어야 한다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const v = requireEnv(ENV_VARS, env);
  const rawPort = env.PORT?.trim() || env.API_PORT?.trim() || '8787';
  // 10진 숫자만(Number는 '1e3'·'0x50'·'+80'도 받아 엉뚱한 포트로 뜬다).
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 값이 올바르지 않습니다: ${rawPort}`);
  }
  // PIN 값은 오류 문구에도 싣지 않는다.
  const familyPin = env.FAMILY_PIN?.trim() ?? '';
  if (familyPin && !isValidPin(familyPin)) throw new Error(`FAMILY_PIN은 숫자 ${PIN_LENGTH}자리여야 합니다 (.env 확인)`);
  const warnings: string[] = [];
  const trustFlag = parseFlag(env.TRUST_PROXY);
  // 알 수 없는 값은 꺼짐으로 두되 조용히 넘어가지 않는다(기동은 막지 않는다).
  if (trustFlag === null) {
    warnings.push(`TRUST_PROXY 값을 알 수 없어 꺼짐으로 둡니다: "${env.TRUST_PROXY!.trim().slice(0, 20)}" (켜려면 1·true·yes·on, 끄려면 0·false·no·off)`);
  }
  const trustProxy = trustFlag === true;
  // LOG_TEXT는 비어 있으면 켜짐(기본). 알 수 없는 값도 기본(켜짐) 그대로 두고 경고만 남긴다.
  const logTextFlag = env.LOG_TEXT?.trim() ? parseFlag(env.LOG_TEXT) : true;
  if (logTextFlag === null) {
    warnings.push(`LOG_TEXT 값을 알 수 없어 켜짐(원문 남김)으로 둡니다: "${env.LOG_TEXT!.trim().slice(0, 20)}" (끄려면 0·false·no·off)`);
  }
  const logText = logTextFlag !== false;
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!familyPin) {
    // 밖에 여는 설정인데 잠그지 않는 실수 막기
    const exposedBy = env.ALLOWED_HOSTS?.trim()
      ? 'ALLOWED_HOSTS가 설정돼 있는데'
      : trustProxy
        ? 'TRUST_PROXY가 켜져 있는데'
        : !isLoopbackHost(host)
          ? `HOST가 이 컴퓨터 밖(${host})에도 열리는데`
          : null;
    if (exposedBy) {
      throw new Error(`${exposedBy} FAMILY_PIN이 비어 있습니다. 밖에 여는 서버는 가족 비밀번호를 정해야 합니다 (.env에 FAMILY_PIN=숫자 6자리)`);
    }
  }
  const kidEn = env.ELEVENLABS_VOICE_KID_EN?.trim();
  const adultEn = env.ELEVENLABS_VOICE_ADULT_EN?.trim();
  const pinSecret = env.PIN_SECRET?.trim() || undefined;
  if (pinSecret && pinSecret.length < PIN_SECRET_MIN) {
    throw new Error(`PIN_SECRET은 ${PIN_SECRET_MIN}자 이상이어야 합니다 (.env 확인, 예: 긴 무작위 문자열)`);
  }
  return {
    geminiKey: v.GEMINI_API_KEY,
    elevenKey: v.ELEVENLABS_API_KEY,
    voice: { kid: v.ELEVENLABS_VOICE_KID, adult: v.ELEVENLABS_VOICE_ADULT },
    port,
    familyPin,
    trustProxy,
    host,
    logText,
    ...(pinSecret ? { pinSecret } : {}),
    ...(kidEn || adultEn ? { voiceEn: { kid: kidEn || v.ELEVENLABS_VOICE_KID, adult: adultEn || v.ELEVENLABS_VOICE_ADULT } } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

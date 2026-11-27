import type { Speech } from '../shared/lesson';

/**
 * Eleven v4 Turbo: 말투 태그를 알아듣고, Flash(0.8초)보다 조금 느린 1.2초 안팎(2026-11-22 실측).
 * v4(3.2초)와 들어 보니 비슷해, 더 빠르고 싼 Turbo로 정했다(사용자 선택 B).
 */
export const MODEL_ID = 'eleven_v4_turbo';
/**
 * 말투 태그([explaining warmly] 등)는 붙이지 않는다: 첫마디를 되풀이하는 일이 잦았다
 * ("오, 오, 정말…", 2026-11-22 아이패드 실사용 + 받아쓰기로 확인). 대신 앞 문장을 previous_text로 넘겨
 * 문장끼리 억양이 이어지게 한다.
 */
const OUTPUT_FORMAT = 'mp3_44100_128';

export class TtsError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
    this.name = 'TtsError';
  }
}

/** 서버 로그용 한 줄 설명. TtsError는 상태와 메시지(키는 헤더로만 보내므로 메시지에 없다). */
export function describeTtsError(err: unknown): string {
  if (err instanceof TtsError) return `TtsError ${err.status}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/** 타이밍 값(초): 숫자여야 한다(NaN·null 타이밍이 브라우저로 가지 않게). */
const isTime = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/** ElevenLabs 한 번 호출(응답 본문까지)의 시간 제한. */
export const TTS_TIMEOUT_MS = 15_000;

/**
 * ElevenLabs with-timestamps로 mp3와 글자별 타이밍을 받는다.
 * timeoutMs 안에 끝나지 않으면 TtsError(504). 바깥 signal로 중단되면 그 중단(AbortError)을 그대로 던진다.
 */
export async function synthesize(
  text: string,
  voiceId: string,
  apiKey: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = TTS_TIMEOUT_MS,
  previousText?: string,
): Promise<Speech> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await request(text, voiceId, apiKey, AbortSignal.any([signal, timeout]), fetchFn, previousText);
  } catch (err) {
    if (timeout.aborted && !signal.aborted) {
      throw new TtsError(504, `ElevenLabs가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다`);
    }
    throw err;
  }
}

async function request(text: string, voiceId: string, apiKey: string, signal: AbortSignal, fetchFn: typeof fetch, previousText?: string): Promise<Speech> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL_ID, ...(previousText ? { previous_text: previousText } : {}) }),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new TtsError(res.status, `ElevenLabs ${res.status}: ${detail}`);
  }
  let data: { audio_base64?: string; alignment?: Partial<Alignment> | null };
  try {
    data = await res.json();
  } catch (err) {
    if (signal.aborted) throw err; // 시간 초과·중단은 바깥에서 가린다
    throw new TtsError(502, 'ElevenLabs 응답이 올바른 JSON이 아닙니다');
  }
  const a = data?.alignment;
  const chars = a?.characters;
  const starts = a?.character_start_times_seconds;
  const ends = a?.character_end_times_seconds;
  if (
    !data?.audio_base64 ||
    !Array.isArray(chars) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    chars.length !== starts.length ||
    chars.length !== ends.length ||
    !chars.every((c) => typeof c === 'string') ||
    !starts.every(isTime) ||
    !ends.every(isTime)
  ) {
    throw new TtsError(502, 'ElevenLabs 응답의 audio_base64/alignment가 없거나 길이가 맞지 않습니다');
  }
  const startMs = starts.map((s) => Math.round(s * 1000));
  const endMs = ends.map((s) => Math.round(s * 1000));
  return {
    audioBase64: data.audio_base64,
    mime: 'audio/mpeg',
    timing: { chars, startMs, endMs },
    durationMs: endMs.length > 0 ? endMs[endMs.length - 1] : 0,
  };
}


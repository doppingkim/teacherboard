import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Lang, Speech } from '../shared/lesson';
import type { Profile } from '../shared/script';

/** 질문 직후 1초 안에 틀어 줄 채움 문장. 순서가 곧 캐시 파일 번호다. */
export const FILLER_TEXTS: readonly string[] = ['음~ 좋은 질문이야!', '오, 그거 궁금했구나!', '자, 그려 볼까?'];
/** 언어별 채움 문장. ko는 FILLER_TEXTS 그대로. */
export const FILLER_TEXTS_BY_LANG: Record<Lang, readonly string[]> = {
  ko: FILLER_TEXTS,
  en: ['Hmm, great question!', 'Ooh, you wondered about that!', "Okay, let's draw it!"],
};

const DEFAULT_DIR = resolve(process.cwd(), 'data', 'filler');

type CacheFile = { text: string; voiceId: string; speech: Speech };

const isSpeech = (v: unknown): v is Speech => {
  const s = v as Speech | null;
  return !!s && typeof s.audioBase64 === 'string' && s.audioBase64.length > 0 && s.mime === 'audio/mpeg' &&
    typeof s.durationMs === 'number' && !!s.timing && Array.isArray(s.timing.chars);
};

async function readCache(file: string, text: string, voiceId: string): Promise<Speech | null> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile>;
    return data.text === text && data.voiceId === voiceId && isSpeech(data.speech) ? data.speech : null;
  } catch {
    return null;
  }
}

type OnError = (err: unknown, text: string) => void;

async function loadOne(
  profile: Profile,
  voiceId: string,
  i: number,
  speak: (t: string) => Promise<Speech>,
  dir: string,
  onError?: OnError,
  lang: Lang = 'ko',
): Promise<Speech | null> {
  const text = FILLER_TEXTS_BY_LANG[lang][i];
  // ko는 예전 캐시 파일 이름 그대로.
  const file = join(dir, lang === 'ko' ? `${profile}-${i}.json` : `${lang}-${profile}-${i}.json`);
  const cached = await readCache(file, text, voiceId);
  if (cached) return cached;
  let speech: Speech;
  try {
    speech = await speak(text);
  } catch (err) {
    try {
      onError?.(err, text); // 원인은 서버 로그로
    } catch {
      // 로그 콜백 오류는 무시
    }
    return null; // 실패는 캐시하지 않는다 → 다음 요청에서 다시 시도
  }
  const body: CacheFile = { text, voiceId, speech };
  await writeFile(file, JSON.stringify(body), 'utf8').catch(() => {}); // 캐시 쓰기 실패는 치명적이지 않다
  return speech;
}

/** 같은 (dir, profile, voiceId)에 대한 동시 요청은 한 번의 작업을 함께 기다린다. */
const inflight = new Map<string, Promise<Speech[]>>();

/**
 * 프로필 목소리로 된 채움 음성을 돌려준다. `<dir>/<profile>-<i>.json`에 캐시하고,
 * 캐시가 없거나 깨졌거나 문장이나 목소리(voiceId)가 바뀌었으면 speak로 다시 만든다.
 * voiceId는 캐시 무효화 키로만 쓰인다(실제 목소리는 speak가 정한다).
 * 실패한 문장은 빠지고(원인은 onError로 알린다), 하나도 못 만들면 던진다.
 */
export function getFillers(
  profile: Profile,
  voiceId: string,
  speak: (t: string) => Promise<Speech>,
  dir: string = DEFAULT_DIR,
  onError?: OnError,
  lang: Lang = 'ko',
): Promise<Speech[]> {
  const key = JSON.stringify([resolve(dir), profile, voiceId, lang]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = (async () => {
    await mkdir(dir, { recursive: true });
    const all = await Promise.all(FILLER_TEXTS_BY_LANG[lang].map((_, i) => loadOne(profile, voiceId, i, speak, dir, onError, lang)));
    const ok = all.filter((s): s is Speech => s !== null);
    if (ok.length === 0) throw new Error(`채움 음성을 만들지 못했습니다 (${profile})`);
    return ok;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

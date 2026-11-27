// 화면 언어(한국어 / English). 페이지를 열 때 한 번 정하고, 바꾸면 다시 불러온다(문구가 모듈마다 흩어져 있어 그게 가장 단순하다).
// 고르는 순서: 주소의 ?lang=ko|en → 기기에 기억한 값 → 브라우저 언어(ko로 시작하면 한국어, 아니면 영어).
import { isLang, type Lang } from '../shared/lesson';

export type { Lang };

const KEY = 'teacherboard.lang';

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 저장소를 못 쓰는 브라우저(사생활 보호 모드 등)
  }
}

function detect(): Lang {
  // 브라우저 밖(단위 테스트)에서는 한국어 — 예전 동작 그대로.
  if (typeof window === 'undefined' || typeof location === 'undefined') return 'ko';
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (isLang(q)) {
      store()?.setItem(KEY, q);
      return q;
    }
  } catch {
    // 주소를 못 읽으면 넘어간다
  }
  const saved = store()?.getItem(KEY);
  if (isLang(saved)) return saved;
  const langs = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => /^ko\b/i.test(l ?? '')) ? 'ko' : 'en';
}

/** 지금 화면 언어. 페이지를 여는 동안 바뀌지 않는다. */
export const LANG: Lang = detect();

/** 언어에 맞는 쪽을 고른다. */
export const pick = <T>(ko: T, en: T): T => (LANG === 'en' ? en : ko);

/** 언어를 바꾸고 다시 불러온다(주소의 ?lang=도 함께 바꿔 다음에 ?lang이 이기지 않게). */
export function switchLang(next: Lang): void {
  store()?.setItem(KEY, next);
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) url.searchParams.set('lang', next);
  location.replace(url.toString());
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = LANG;
  document.documentElement.classList.toggle('lang-en', LANG === 'en');
  document.title = pick('티처보드', 'Teacherboard');
}

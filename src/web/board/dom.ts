// 보드 SVG 공용 도구: 요소 만들기, 숫자 다듬기, 시간 기반 애니메이션.

export const SVG_NS = 'http://www.w3.org/2000/svg';

export type Pt = [number, number];
/** 펜 위치(보드 좌표). down: 보드에 닿아 쓰는 중, smooth: 펜을 부드럽게 따라가게. */
export type Pose = { x: number; y: number; down: boolean; smooth?: boolean };

export const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
export const fx = (n: number) => n.toFixed(1);

/** signal이 abort되거나 p가 먼저 끝나면 resolve. */
export function raceAbort(p: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
    );
  });
}

/**
 * 시간 기반 애니메이션. rAF로 그리되, 탭이 가려져 rAF가 멈춰도 ms 뒤에는 끝낸다.
 * 끝까지 가면 true, abort되거나 보드가 비워지면(live()=false) 즉시 false.
 */
export function tween(ms: number, frame: (p: number) => void, live: () => boolean, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (!live() || signal?.aborted) return resolve(false);
    const t0 = performance.now();
    let finished = false;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    const step = (now: number) => {
      if (finished) return;
      if (!live()) return finish(false);
      const p = ms <= 0 ? 1 : Math.min(1, Math.max(0, (now - t0) / ms));
      frame(p);
      if (p >= 1) finish(true);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    timer = setTimeout(() => {
      if (finished) return;
      if (!live()) return finish(false);
      frame(1);
      finish(true);
    }, Math.max(0, ms) + 250);
  });
}

/**
 * 사파리 엔진(아이폰·아이패드의 모든 브라우저, 맥 사파리)인가. iOS의 크롬(CriOS)·파이어폭스(FxiOS)도 WebKit이고
 * UA에 Chrome/Firefox 낱말이 없다. 이 엔진은 SVG 필터(feTurbulence 등)를 CPU로 계산하고, 바뀌는 마스크를 바로 다시 그리지 않는다.
 */
export function isWebKitOnly(): boolean {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\/|OPR\/|Firefox/.test(ua);
}

let liteFx: boolean | null = null;
/**
 * 가벼운 효과로 그릴까(마커 질감 필터 끔). 사파리 엔진은 필터를 CPU로 매 프레임 다시 계산해 아이패드에서 버벅였다
 * (2026-11-22 실사용). 주소에 `?fx=full|lite`를 붙이면 강제로 고를 수 있다.
 */
export function liteEffects(): boolean {
  if (liteFx !== null) return liteFx;
  let forced: string | null = null;
  try {
    forced = new URLSearchParams(location.search).get('fx');
  } catch {
    forced = null;
  }
  liteFx = forced === 'lite' ? true : forced === 'full' ? false : isWebKitOnly();
  return liteFx;
}

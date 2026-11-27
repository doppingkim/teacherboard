// 그리는 단위(Item) 만들기: 선 한 획, 채우기, 글씨(한 글자씩 / 왼→오 쓸기), 낱말 상자 재기.
import type { Rect } from './layout';
import { easeStroke, hatchPath, seededRand, shadeInk, textSchedule } from './primitives';
import { clamp01, fx, isWebKitOnly, lerp, smoothstep, svg, type Pose, type Pt } from './dom';

export const STROKE_W = 7.2; // 시안 3.6 × 2 (viewBox가 두 배)
/**
 * 칠판 글씨 세 단계(D4 2026-11-23: 정리 48·이름표 44로 거의 같아 위계가 안 보였다). 크기는 약 1.5배씩
 * 줄고(제목 80 → 정리 52 → 이름표 38), 굵기도 함께 준다(TEXT_BOLD). 글씨체는 하이멜로디 그대로.
 */
export const FONT_SIZE = { title: 80, note: 52, label: 38 } as const;
export type TextRole = keyof typeof FONT_SIZE;
/**
 * 하이멜로디는 굵은 글꼴이 없어, 같은 색 테두리를 글자 밑에 깔아 굵게 보이게 한다(글자 크기 대비).
 * 제목은 가장 굵게, 이름표는 가늘게.
 */
export const TEXT_BOLD: Record<TextRole, number> = { title: 0.06, note: 0.045, label: 0.032 };
export const TEXT_WEIGHT = 5 / 3; // 시안: 선은 길이×3ms, 글씨는 폭×5ms → 글씨 폭 1px = 선 길이 5/3px
const CHAR_WEIGHT = 22; // 글자 사이 쉼 몫(보드 px 환산)
const MIN_WEIGHT = 8;
/** 손 속도 하한: 보드 px당 최대 ms. 말이 길어도 이보다 느리게 그리지 않는다(일찍 끝나고 쉰다). */
export const MAX_MS_PER_PX = 2.4;
const POOL_R = 0.6; // 잉크 고인 점 반지름(선 굵기 배)
const FILL_OPACITY = 0.26;

/**
 * 글씨를 드러내는 방법.
 * - mask: 글자마다 마스크를 쓸어 벗긴다(크롬 등). 획 안에서 잉크가 따라 그려진다.
 * - fade: 글자(tspan)마다 진하기를 올린다. 사파리 엔진(아이폰·아이패드·맥 사파리)은
 *   쓰는 중인 마스크의 변화를 바로 다시 그리지 않아, 다 쓴 뒤 한꺼번에 나타났다(2026-11-22 폰 실사용).
 * 주소에 `?write=mask|fade`를 붙이면 강제로 고를 수 있다.
 */
export type RevealMode = 'mask' | 'fade';
let revealMode: RevealMode | null = null;
export function textRevealMode(): RevealMode {
  if (revealMode) return revealMode;
  let forced: string | null = null;
  try {
    forced = new URLSearchParams(location.search).get('write');
  } catch {
    forced = null;
  }
  if (forced === 'mask' || forced === 'fade') return (revealMode = forced);
  return (revealMode = isWebKitOnly() ? 'fade' : 'mask');
}

export type TextOpts = {
  x: number;
  y: number;
  size: number;
  color: string;
  anchor: 'start' | 'middle';
  maxW: number;
  fitY?: (size: number) => number;
  clampX?: [number, number];
  bottomMax?: number;
  /** 굵기(글자 크기 대비 테두리 두께). 기본은 정리 줄 굵기. */
  bold?: number;
};

/** 그리는 단위 하나(선 한 획, 글씨 한 줄, 채우기 하나). */
export type Item = {
  weight: number; // 시간표용 길이(보드 px 환산)
  color: string;
  startPt(): Pt; // 펜이 내려앉는 곳(보드 좌표)
  /** 그리는 동안 작은 '쓰는 중' 묶음으로 옮겨 둘 요소(그 묶음만 매 프레임 필터). */
  node: Element | null;
  begin(): void;
  /** ms: 이 획에서 지난 시간, dur: 이 획 몫. 펜 위치를 돌려준다. */
  frame(ms: number, dur: number): Pose;
  done(): void;
  remove(): void;
};

/** 아이템이 보드에서 빌리는 것: 자르기 정의(defs)와 보드 안에서 겹치지 않는 id. */
/** pace: 손 빠르기 배수(1 = 그대로, 1.11 = 느리게). 글씨 한 칸에 쓸 수 있는 최대 시간을 늘린다. */
export type ItemCtx = { clips: SVGDefsElement; nextId(kind: string): string; pace?: () => number };


/**
 * 선 하나. map: 경로 로컬 좌표 → 보드 좌표, scale: 로컬 1당 보드 px.
 * pools: 획 시작·끝에 잉크 고인 점을 찍는다. 한 획으로 닫는 동그라미는 끝이 시작 옆을 지나가 두 점이 겹친 곳을
 * 따로 그은 짧은 선처럼 보이게 해서(QA2 2026-11-23) 찍지 않는다.
 */
export function strokeItem(
  parent: SVGGElement, d: string, color: string, scale: number, map: (x: number, y: number) => Pt,
  ease: (t: number) => number = easeStroke, pools = true,
): Item {
  const path = svg('path', { d, stroke: color, 'stroke-width': +(STROKE_W / scale).toFixed(4) });
  parent.appendChild(path);
  let len = 0;
  try {
    len = path.getTotalLength();
  } catch {
    len = 0;
  }
  if (!Number.isFinite(len)) len = 0;
  path.style.visibility = 'hidden';
  if (len > 0) {
    path.style.strokeDasharray = `${len} ${len}`;
    path.style.strokeDashoffset = String(len);
  }
  const local = (l: number): Pt => {
    try {
      const p = path.getPointAtLength(l);
      return [p.x, p.y];
    } catch {
      return [0, 0];
    }
  };
  const a = local(0);
  const pool = (at: Pt) => {
    // 획 시작·끝에 잉크가 살짝 고인 점(조금 더 진하게)
    (path.parentNode ?? parent).appendChild(svg('circle', {
      class: 'pool', cx: +at[0].toFixed(2), cy: +at[1].toFixed(2),
      r: +((STROKE_W * POOL_R) / scale).toFixed(3), fill: shadeInk(color, 0.3), opacity: 0.5,
    }));
  };
  return {
    weight: Math.max(MIN_WEIGHT, len * scale),
    color,
    startPt: () => map(a[0], a[1]),
    node: path,
    begin: () => {
      path.style.removeProperty('visibility');
      if (len > 0 && pools) pool(a);
    },
    frame: (ms, dur) => {
      const p = dur > 0 ? ease(ms / dur) : 1;
      if (len > 0) path.style.strokeDashoffset = String(len * (1 - p));
      const [lx, ly] = local(len * p);
      const [bx, by] = map(lx, ly);
      return { x: bx, y: by, down: true };
    },
    done: () => {
      path.style.removeProperty('stroke-dasharray');
      path.style.removeProperty('stroke-dashoffset');
      path.style.removeProperty('visibility');
      if (len > 0 && pools) pool(local(len));
    },
    remove: () => path.remove(),
  };
}

/**
 * 채우기: 닫힌 모양 안을 옅게(약 26%) 칠한다. 선이 다 그려진 뒤, 마커로 "/" 빗금을 오가며 칠하듯
 * 마스크의 지그재그가 드러나고, 끝나면 마스크를 걷어 깔끔하게 채운다. 윤곽선은 다시 그리지 않는다.
 */
export function fillItem(ctx: ItemCtx, parent: SVGGElement, d: string, color: string, scale: number, map: (x: number, y: number) => Pt): Item | null {
  const path = svg('path', { d, class: 'fill' });
  path.style.fill = color;
  path.style.fillOpacity = String(FILL_OPACITY);
  path.style.stroke = 'none';
  parent.appendChild(path);
  let b: Rect;
  try {
    const bb = path.getBBox();
    b = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
  } catch {
    path.remove();
    return null;
  }
  if (![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) {
    path.remove();
    return null;
  }
  const spacing = (STROKE_W * 2.1) / scale;
  const id = ctx.nextId('m');
  const pad = spacing * 2;
  const mask = svg('mask', {
    id, maskUnits: 'userSpaceOnUse', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
  });
  const zig = svg('path', { d: hatchPath(b, spacing), stroke: '#fff', 'stroke-width': +(spacing * 1.75).toFixed(4) });
  mask.appendChild(zig);
  parent.appendChild(mask);
  path.setAttribute('mask', `url(#${id})`);
  path.style.visibility = 'hidden';
  let len = 0;
  try {
    len = zig.getTotalLength();
  } catch {
    len = 0;
  }
  if (!Number.isFinite(len) || len <= 0) {
    mask.remove();
    path.removeAttribute('mask');
    len = 0;
  } else {
    zig.style.strokeDasharray = `${len} ${len}`;
    zig.style.strokeDashoffset = String(len);
  }
  const at = (l: number): Pt => {
    try {
      const p = zig.getPointAtLength(l);
      return map(p.x, p.y);
    } catch {
      return map(b.x, b.y);
    }
  };
  const start = len > 0 ? at(0) : map(b.x, b.y + b.h);
  const finish = () => {
    path.removeAttribute('mask');
    mask.remove();
    path.style.removeProperty('visibility');
  };
  return {
    weight: Math.max(MIN_WEIGHT, len * scale * 0.28), // 빗금은 빠르게
    color,
    startPt: () => start,
    node: null, // 채우기는 판서 묶음(선 아래)에 그대로 둔다: 빗금이 윤곽선 위로 올라오지 않게
    begin: () => path.style.removeProperty('visibility'),
    frame: (ms, dur) => {
      const p = dur > 0 ? clamp01(ms / dur) : 1;
      if (len <= 0) return { x: start[0], y: start[1], down: true };
      zig.style.strokeDashoffset = String(len * (1 - p));
      const [x, y] = at(len * p);
      return { x, y, down: true, smooth: true };
    },
    done: finish,
    remove: () => {
      path.remove();
      mask.remove();
    },
  };
}

/**
 * 글씨 하나(보드 좌표). maxW보다 넓으면 글자 크기를 줄인다.
 * - fitY: 줄어든 크기로 기준선을 다시 계산한다.
 * - clampX: 가운데 정렬 글씨가 [lo, hi] 안에 들어오게 x를 옮긴다.
 * - bottomMax: 실제로 잰 글씨 상자의 아래쪽이 이 값을 넘으면 그만큼 위로 올린다.
 * 한 글자씩 쓴다(글자마다 2~3번 짧게 쓸기). 글자 위치를 못 재면 예전처럼 왼→오 쓸기.
 */
export function textItem(ctx: ItemCtx, parent: SVGGElement, text: string, o: TextOpts): { item: Item; el: SVGTextElement } {
  const { x, color, anchor, maxW } = o;
  let { y, size } = o;
  const t = svg('text', { x, y, 'font-size': size, fill: color, 'text-anchor': anchor, stroke: color, 'stroke-linejoin': 'round', 'paint-order': 'stroke' });
  const boldK = o.bold ?? TEXT_BOLD.note;
  const bold = () => t.setAttribute('stroke-width', fx(size * boldK));
  bold();
  t.textContent = text; // 텍스트로만 넣는다(마크업 해석 없음)
  parent.appendChild(t);
  let w = 0;
  try {
    w = t.getComputedTextLength();
  } catch {
    w = 0;
  }
  if (w > maxW && w > 0) {
    size = Math.max(12, (size * maxW) / w);
    w = maxW;
    t.setAttribute('font-size', size.toFixed(1));
    bold();
  }
  if (o.fitY) {
    y = o.fitY(size);
    t.setAttribute('y', y.toFixed(1));
  }
  if (o.clampX && anchor === 'middle') {
    const [lo, hi] = o.clampX;
    const cx = Math.min(Math.max(x, lo + w / 2), Math.max(lo + w / 2, hi - w / 2));
    t.setAttribute('x', cx.toFixed(1));
  }
  const measure = () => {
    try {
      const b = t.getBBox();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch {
      return { x, y: y - size, width: w, height: size };
    }
  };
  let box = measure();
  if (o.bottomMax !== undefined && box.y + box.height > o.bottomMax) {
    const ny = Math.max(size * 0.8, y - (box.y + box.height - o.bottomMax)); // 보드 위로는 안 나가게
    if (ny !== y) {
      y = ny;
      t.setAttribute('y', y.toFixed(1));
      box = measure();
    }
  }
  const item = charWriter(ctx, parent, t, text, size, color, box) ?? sweepWriter(ctx, t, color, box, text.length);
  return { item, el: t };
}

/** 예전 방식: 글씨 상자를 왼→오로 쓸어 드러낸다(글자 위치를 못 잴 때). */
export function sweepWriter(ctx: ItemCtx, t: SVGTextElement, color: string, box: { x: number; y: number; width: number; height: number }, chars: number): Item {
  const id = ctx.nextId('c');
  const cp = svg('clipPath', { id });
  const r = svg('rect', { x: box.x - 4, y: box.y - 12, width: 0, height: box.height + 24 });
  cp.appendChild(r);
  ctx.clips.appendChild(cp);
  t.setAttribute('clip-path', `url(#${id})`);
  const at = (p: number): Pt => [box.x + box.width * p, box.y + box.height * (0.45 + 0.25 * Math.sin(p * 40))];
  return {
    weight: Math.max(MIN_WEIGHT, box.width * TEXT_WEIGHT + chars * CHAR_WEIGHT),
    color,
    startPt: () => at(0),
    node: t,
    begin: () => {},
    frame: (ms, dur) => {
      const p = dur > 0 ? clamp01(ms / dur) : 1;
      r.setAttribute('width', fx(box.width * p + 8));
      const [px, py] = at(p);
      return { x: px, y: py, down: true, smooth: true };
    },
    done: () => {
      t.removeAttribute('clip-path');
      cp.remove();
    },
    remove: () => {
      t.remove();
      cp.remove();
    },
  };
}

/**
 * 한 글자씩 쓰기: 글자 상자(getExtentOfChar)마다 위·왼쪽 → 아래·오른쪽으로 2~3번 짧게 쓸어 드러낸다.
 * 글자 사이 40~90ms, 띄어쓰기 앞 120ms 쉼(textSchedule). 측정이 안 되면 null.
 */
export function charWriter(
  ctx: ItemCtx,
  parent: SVGGElement, t: SVGTextElement, text: string, size: number, color: string,
  box: { x: number; y: number; width: number; height: number },
): Item | null {
  type Sweep = { path: SVGPathElement | null; len: number; a: Pt; b: Pt };
  type Glyph = { space: boolean; w: number; sweeps: Sweep[]; span: SVGTSpanElement | null; s: string };
  const fade = textRevealMode() === 'fade';
  let n = 0;
  try {
    n = t.getNumberOfChars();
  } catch {
    return null;
  }
  if (n <= 0 || n !== text.length) return null;
  const rand = seededRand(`${text}|${n}`);
  const id = ctx.nextId('t');
  const mask = svg('mask', {
    id, maskUnits: 'userSpaceOnUse', x: fx(box.x - 30), y: fx(box.y - 30), width: fx(box.width + 60), height: fx(box.height + 60),
  });
  const glyphs: Glyph[] = [];
  try {
    // 글자 = 보이는 글자 하나(이모지·결합 문자 묶음). UTF-16 칸 하나씩 나누면 사파리(fade)에서 반쪽 글자(�)가 보였다(QA 2026-11-22).
    for (const { s: str, i0 } of clusters(text)) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = i0; i < i0 + str.length; i++) {
        const e = t.getExtentOfChar(i);
        if (![e.x, e.y, e.width, e.height].every(Number.isFinite)) return null;
        if (e.width <= 0) continue;
        x0 = Math.min(x0, e.x); x1 = Math.max(x1, e.x + e.width);
        y0 = Math.min(y0, e.y); y1 = Math.max(y1, e.y + e.height);
      }
      const base = t.getStartPositionOfChar(i0).y;
      if (!Number.isFinite(base)) return null;
      const width = x1 > x0 ? x1 - x0 : 0;
      const e = { x: Number.isFinite(x0) ? x0 : 0, width };
      const space = /^\s+$/.test(str) || e.width <= 0.5;
      const g: Glyph = { space, w: Math.max(0, e.width), sweeps: [], span: null, s: str };
      if (!space) {
        const k = e.width > size * 0.5 && rand() < 0.75 ? 3 : 2;
        const top = base - size * 0.82, band = size / k;
        for (let s = 0; s < k; s++) {
          const yc = top + band * (s + 0.5) + (rand() - 0.5) * band * 0.15;
          const tilt = band * 0.22;
          const a: Pt = [e.x - 1, yc - tilt], b: Pt = [e.x + e.width + 1, yc + tilt];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          let path: SVGPathElement | null = null;
          if (!fade) {
            path = svg('path', {
              d: `M${fx(a[0])} ${fx(a[1])} L${fx(b[0])} ${fx(b[1])}`, stroke: '#fff', 'stroke-width': fx(band * 1.6),
            });
            path.style.strokeLinecap = 'butt';
            path.style.strokeDasharray = `${len} ${len}`;
            path.style.strokeDashoffset = String(len);
            mask.appendChild(path);
          }
          g.sweeps.push({ path, len, a, b });
        }
      }
      glyphs.push(g);
    }
  } catch {
    return null;
  }
  if (glyphs.every((g) => g.space)) return null;
  const count = glyphs.length;
  if (fade) {
    // 글자마다 tspan(위치는 그대로 흐른다). 진하기 0에서 시작.
    t.textContent = '';
    for (const g of glyphs) {
      const span = svg('tspan', {});
      span.textContent = g.s;
      span.style.fillOpacity = '0';
      span.style.strokeOpacity = '0';
      t.appendChild(span);
      g.span = span;
    }
  } else {
    parent.appendChild(mask);
    t.setAttribute('mask', `url(#${id})`);
  }
  /** 글자 g의 j번째 쓸기를 q(0~1)만큼. fade는 쓸기마다 진하기를 나눠 올린다. */
  const setSweep = (g: Glyph, j: number, q: number) => {
    const sw = g.sweeps[j];
    if (sw.path) sw.path.style.strokeDashoffset = String(sw.len * (1 - q));
    if (g.span) g.span.style.fillOpacity = g.span.style.strokeOpacity = String(Math.min(1, (j + q) / g.sweeps.length));
  };

  const firstPt = glyphs.find((g) => !g.space)!.sweeps[0].a;
  let sched: { startMs: number; durMs: number }[] | null = null;
  let doneUpTo = 0; // 이 앞 글자는 다 드러남
  const reveal = (g: Glyph) => {
    for (const s of g.sweeps) if (s.path) s.path.style.strokeDashoffset = '0';
    if (g.span) g.span.style.fillOpacity = g.span.style.strokeOpacity = '1';
  };
  const endOf = (i: number): Pt => {
    for (let k = i; k >= 0; k--) if (!glyphs[k].space) return glyphs[k].sweeps[glyphs[k].sweeps.length - 1].b;
    return firstPt;
  };
  const startOf = (i: number): Pt => {
    for (let k = i; k < glyphs.length; k++) if (!glyphs[k].space) return glyphs[k].sweeps[0].a;
    return endOf(i);
  };
  const finish = () => {
    if (fade) t.textContent = text; // tspan을 걷어 낸다(아이패드에서 요소 수를 줄인다)
    t.removeAttribute('mask');
    mask.remove();
  };
  return {
    weight: Math.max(MIN_WEIGHT, box.width * TEXT_WEIGHT + count * CHAR_WEIGHT),
    color,
    startPt: () => firstPt,
    node: t,
    begin: () => {},
    frame: (ms, dur) => {
      if (!sched) sched = textSchedule(glyphs.map((g) => g.w), glyphs.map((g) => g.space), dur, rand, { maxMsPerPx: MAX_MS_PER_PX * TEXT_WEIGHT * (ctx.pace?.() ?? 1) });
      const sc = sched;
      while (doneUpTo < count && ms >= sc[doneUpTo].startMs + sc[doneUpTo].durMs) reveal(glyphs[doneUpTo++]);
      if (doneUpTo >= count) {
        const [ex, ey] = endOf(count - 1);
        return { x: ex, y: ey, down: false, smooth: true };
      }
      const i = doneUpTo, s = sc[i], g = glyphs[i];
      if (ms < s.startMs || g.space) {
        // 글자 사이: 마커를 살짝 들고 다음 글자 시작으로
        const prevEnd = i > 0 ? sc[i - 1].startMs + sc[i - 1].durMs : 0;
        const u = smoothstep((ms - prevEnd) / Math.max(1, s.startMs - prevEnd));
        const [ax, ay] = endOf(i - 1), [bx, by] = startOf(i);
        return { x: lerp(ax, bx, u), y: lerp(ay, by, u), down: false, smooth: true };
      }
      // 글자 안: 쓸기 k번(80%) + 사이 되돌아가기(20%)
      const k = g.sweeps.length;
      const u = clamp01((ms - s.startMs) / Math.max(1, s.durMs));
      const drawShare = k > 1 ? 0.8 / k : 1, backShare = k > 1 ? 0.2 / (k - 1) : 0;
      let acc = 0;
      for (let j = 0; j < k; j++) {
        const sw = g.sweeps[j];
        if (u < acc + drawShare) {
          const q = easeStroke((u - acc) / drawShare);
          for (let m = 0; m < j; m++) setSweep(g, m, 1);
          setSweep(g, j, q);
          return { x: lerp(sw.a[0], sw.b[0], q), y: lerp(sw.a[1], sw.b[1], q), down: true, smooth: true };
        }
        setSweep(g, j, 1);
        acc += drawShare;
        if (j < k - 1 && u < acc + backShare) {
          const q = smoothstep((u - acc) / backShare);
          const nx = g.sweeps[j + 1].a;
          return { x: lerp(sw.b[0], nx[0], q), y: lerp(sw.b[1], nx[1], q), down: false, smooth: true };
        }
        acc += backShare;
      }
      const last = g.sweeps[k - 1].b;
      return { x: last[0], y: last[1], down: true, smooth: true };
    },
    done: finish,
    remove: () => {
      t.remove();
      mask.remove();
    },
  };
}

/** 보이는 글자 묶음(grapheme)과 그 첫 UTF-16 위치. Intl.Segmenter가 없으면 코드 포인트 + 결합 문자·ZWJ 이음. */
export function clusters(text: string): { s: string; i0: number }[] {
  const out: { s: string; i0: number }[] = [];
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  if (Seg) {
    for (const { segment, index } of new Seg(undefined, { granularity: 'grapheme' }).segment(text)) out.push({ s: segment, i0: index });
    return out;
  }
  let i = 0;
  for (const cp of Array.from(text)) {
    const prev = out[out.length - 1];
    const join = String.fromCharCode(0x200d);
    if (prev && (/^\p{M}/u.test(cp) || cp === join || cp === String.fromCharCode(0xfe0e) || cp === String.fromCharCode(0xfe0f) || prev.s.endsWith(join))) prev.s += cp;
    else out.push({ s: cp, i0: i });
    i += cp.length;
  }
  return out;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** 글자들의 실제 잉크 높이(기준선 위·아래, 보드 px). 캔버스가 없으면 null. */
function inkExtent(el: SVGTextElement, s: string, size: number): { ascent: number; descent: number } | null {
  try {
    if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return null;
    measureCtx.font = `${size}px ${getComputedStyle(el).fontFamily}`;
    const m = measureCtx.measureText(s);
    const ascent = m.actualBoundingBoxAscent, descent = m.actualBoundingBoxDescent;
    if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent <= 0) return null;
    return { ascent, descent: Math.max(0, descent) };
  } catch {
    return null;
  }
}

/**
 * 글씨 요소 전체가 실제로 덮는 상자(요소 좌표): getBBox와 글자 잉크(캔버스로 잰 하이멜로디 윗·아랫 끝)를 합치고
 * 굵게 두른 테두리 절반을 더한다. 사파리(WebKit)의 getBBox는 하이멜로디 글자 윗부분을 약 0.2em 덜 품어
 * (2026-11-23 측정: 38px 이름표에서 8px) 이름표 자리 찾기가 글자 윗부분을 비워 둔 것으로 잘못 알았다. 못 재면 null.
 */
export function textInkBox(el: SVGTextElement): Rect | null {
  try {
    const b = el.getBBox();
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0) return null;
    const size = Number(el.getAttribute('font-size')) || FONT_SIZE.note;
    const half = (Number(el.getAttribute('stroke-width')) || 0) / 2;
    let top = b.y, bottom = b.y + b.height;
    const text = el.textContent ?? '';
    const ink = text ? inkExtent(el, text, size) : null;
    if (ink && el.getNumberOfChars() > 0) {
      const base = el.getStartPositionOfChar(0).y;
      if (Number.isFinite(base)) {
        top = Math.min(top, base - ink.ascent);
        bottom = Math.max(bottom, base + ink.descent);
      }
    }
    return { x: b.x - half, y: top - half, w: b.width + 2 * half, h: bottom - top + 2 * half };
  } catch {
    return null;
  }
}

/** 글씨 요소에서 낱말(없으면 전체)의 보이는 상자. 못 재면 null. */
export function glyphBox(el: SVGTextElement, text: string, word?: string): Rect | null {
  try {
    const n = el.getNumberOfChars();
    if (n <= 0 || n !== text.length) return null;
    let from = 0, to = n - 1;
    const w = word?.trim();
    if (w) {
      const i = text.indexOf(w);
      if (i >= 0) {
        from = i;
        to = i + w.length - 1;
      }
    }
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to])) to--;
    const size = Number(el.getAttribute('font-size')) || FONT_SIZE.note;
    let x0 = Infinity, x1 = -Infinity;
    for (let i = from; i <= to; i++) {
      const e = el.getExtentOfChar(i);
      x0 = Math.min(x0, e.x);
      x1 = Math.max(x1, e.x + e.width);
    }
    const base = el.getStartPositionOfChar(from).y;
    // 실제 잉크 높이를 잰다(하이멜로디는 낱말마다 위아래 높이가 크게 달라 고정 비율이 안 맞았다). 굵게 두른 테두리 몫도 더한다.
    const ink = inkExtent(el, text.slice(from, to + 1), size);
    const pad = (Number(el.getAttribute('stroke-width')) || size * TEXT_BOLD.note) / 2;
    const top = base - (ink ? ink.ascent + pad : size * 0.74);
    const bottom = base + (ink ? ink.descent + pad : size * 0.1);
    if (![x0, x1, top, bottom].every(Number.isFinite) || x1 - x0 <= 0) return null;
    return { x: x0, y: top, w: x1 - x0, h: bottom - top };
  } catch {
    return null;
  }
}


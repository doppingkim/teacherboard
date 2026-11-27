import type { Ink, MarkStyle } from '../../shared/script';
import { BOARD, type Rect } from './layout';

const INK_COLORS: Record<Ink, string> = {
  black: '#23272b',
  blue: '#1f5fd1',
  red: '#d63b3b',
  green: '#1f9a57',
  orange: '#e8730c',
  gold: '#c99a06',
  purple: '#7b3fc4',
  pink: '#e0559b',
  brown: '#8a5a2b',
  sky: '#2a9fd6',
  navy: '#1d2f6f',
  gray: '#7d8590',
  lime: '#6aa516',
};

/** 마커 색 (Global Constraints). 모르는 값은 검정. */
export function inkColor(ink: Ink): string {
  return Object.prototype.hasOwnProperty.call(INK_COLORS, ink) ? INK_COLORS[ink] : INK_COLORS.black;
}

/** 경로 숫자: 소수 첫째 자리까지, -0 없이. */
const f = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
};
const pt = (x: number, y: number) => `${f(x)} ${f(y)}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const MIN_ARROW = 120; // 칸이 바로 붙어 있어도 화살표가 이만큼은 되도록 칸 안쪽으로 늘린다
const HEAD_LEN = 26;
const HEAD_ANGLE = (26 * Math.PI) / 180;
const EDGE = 4; // 보드 가장자리 여백

/**
 * 두 칸의 가까운 변(가운데) 사이를 잇는 살짝 휜 화살표.
 * 반환: [몸통 "M sx sy Q cx cy ex ey", 화살촉 "M p1 L end L p2"]
 */
export function arrowPath(from: Rect, to: Rect, bowDown = false): string[] {
  const fcx = from.x + from.w / 2, fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2, tcy = to.y + to.h / 2;
  const horizontal = Math.abs(tcx - fcx) >= Math.abs(tcy - fcy);

  let sx: number, sy: number, ex: number, ey: number;
  if (horizontal) {
    const dir = tcx >= fcx ? 1 : -1;
    sx = dir > 0 ? from.x + from.w : from.x;
    ex = dir > 0 ? to.x : to.x + to.w;
    sy = fcy; ey = tcy;
    const gap = (ex - sx) * dir;
    if (gap < MIN_ARROW) {
      const push = Math.min((MIN_ARROW - gap) / 2, from.w * 0.3, to.w * 0.3);
      sx -= push * dir; ex += push * dir;
    }
  } else {
    const dir = tcy >= fcy ? 1 : -1;
    sy = dir > 0 ? from.y + from.h : from.y;
    ey = dir > 0 ? to.y : to.y + to.h;
    sx = fcx; ex = tcx;
    const gap = (ey - sy) * dir;
    if (gap < MIN_ARROW) {
      const push = Math.min((MIN_ARROW - gap) / 2, from.h * 0.3, to.h * 0.3);
      sy -= push * dir; ey += push * dir;
    }
  }

  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  // 몸통에 수직인 방향으로 휘게 한다. 위쪽(보드 y가 작아지는 쪽)으로, bowDown이면 아래쪽으로
  // (위로 휜 선이 이름표를 지나면 보드가 아래로 휜 것을 고른다).
  let nx = dy / len, ny = -dx / len;
  if (ny > 0 !== bowDown) { nx = -nx; ny = -ny; }
  const bow = clamp(len * 0.22, 24, 140);
  const cx = (sx + ex) / 2 + nx * bow, cy = (sy + ey) / 2 + ny * bow;

  // 화살촉: 끝점에서의 접선(끝점 - 제어점) 방향
  const tx = ex - cx, ty = ey - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl, uy = ty / tl;
  const rot = (a: number) => [ux * Math.cos(a) - uy * Math.sin(a), ux * Math.sin(a) + uy * Math.cos(a)];
  const [r1x, r1y] = rot(HEAD_ANGLE), [r2x, r2y] = rot(-HEAD_ANGLE);
  const p1 = pt(ex - r1x * HEAD_LEN, ey - r1y * HEAD_LEN);
  const p2 = pt(ex - r2x * HEAD_LEN, ey - r2y * HEAD_LEN);

  return [`M${pt(sx, sy)} Q${pt(cx, cy)} ${pt(ex, ey)}`, `M${p1} L${pt(ex, ey)} L${p2}`];
}

/** 칸을 강조하는 한 획: 동그라미(타원), 밑줄, 네모. 보드 밖으로 나가지 않게 줄인다. */
export function highlightPath(r: Rect, style: 'circle' | 'underline' | 'box'): string {
  const maxX = BOARD.w - EDGE, maxY = BOARD.h - EDGE;
  switch (style) {
    case 'underline': {
      const y = Math.min(r.y + r.h + 8, maxY - 6);
      const x0 = clamp(r.x + r.w * 0.04, EDGE, maxX), x1 = clamp(r.x + r.w * 0.96, EDGE, maxX);
      return `M${pt(x0, y)} Q${pt((x0 + x1) / 2, y + 6)} ${pt(x1, y - 2)}`;
    }
    case 'box': {
      const p = 10;
      const x0 = clamp(r.x - p, EDGE, maxX), y0 = clamp(r.y - p, EDGE, maxY);
      const x1 = clamp(r.x + r.w + p, EDGE, maxX), y1 = clamp(r.y + r.h + p, EDGE, maxY);
      return `M${pt(x0, y0)} L${pt(x1, y0)} L${pt(x1, y1)} L${pt(x0, y1)} Z`;
    }
    case 'circle':
    default: {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const rx = Math.max(4, Math.min(r.w / 2 + 14, cx - EDGE, maxX - cx));
      // 라벨은 칸 아래쪽 끝에 붙으므로 세로로 더 크게 감싼다.
      const ry = Math.max(4, Math.min((r.h / 2) * 1.12 + 14, cy - EDGE, maxY - cy));
      const ar = `${f(rx)} ${f(ry)} 0 1 1`;
      return `M${pt(cx + rx, cy)} A${ar} ${pt(cx - rx, cy)} A${ar} ${pt(cx + rx, cy)}`;
    }
  }
}

// ---------- 진짜 같은 판서: 시간표·가감속·손으로 그은 표시 ----------

export type Slot = { startMs: number; durMs: number };
export type ScheduleOpts = {
  /** 획 하나의 최소 시간(ms). 기본 120. */
  minMs?: number;
  /** 획 사이 펜 들기 범위(ms). 기본 [80, 200]. */
  liftMs?: [number, number];
  /** 이보다 느리게는 그리지 않는다(보드 px당 ms). 시간이 남으면 일찍 끝난다. */
  maxMsPerPx?: number;
  /** 획 길이 흔들림(±). 기본 0.15. */
  variation?: number;
};

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);

/** 비율 w로 avail을 나누되 각 몫은 최소 min(모자라면 비율대로만). */
function share(w: number[], avail: number, min: number): number[] {
  const n = w.length;
  if (avail <= n * min) {
    const sw = sum(w) || 1;
    return w.map((x) => (avail * x) / sw);
  }
  const fixed = new Array<boolean>(n).fill(false);
  for (let round = 0; round <= n; round++) {
    const freeW = sum(w.filter((_, i) => !fixed[i]));
    const left = avail - min * fixed.filter(Boolean).length;
    const k = freeW > 0 ? left / freeW : 0;
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (!fixed[i] && k * w[i] < min) {
        fixed[i] = true;
        changed = true;
      }
    }
    if (!changed) return w.map((x, i) => (fixed[i] ? min : k * x));
  }
  return w.map(() => avail / n);
}

/**
 * 획 시간표: 길이에 비례(±15% 흔들림), 최소 120ms, 획 사이 펜 들기 80~200ms, 끝 ≤ totalMs.
 * 시간이 모자라면 펜 들기를 줄이고(전체의 20%까지는 남김), 그래도 모자라면 최소 시간을 깬다.
 */
export function strokeSchedule(lengths: number[], totalMs: number, rand: () => number, opts: ScheduleOpts = {}): Slot[] {
  const n = lengths.length;
  if (n === 0) return [];
  const total = Math.max(0, finite(totalMs, 0));
  const min = opts.minMs ?? 120;
  const [lo, hi] = opts.liftMs ?? [80, 200];
  const v = opts.variation ?? 0.15;
  const w = lengths.map((L) => Math.max(1, finite(L, 1)) * (1 + (rand() * 2 - 1) * v));
  let lifts = Array.from({ length: n - 1 }, () => lo + rand() * (hi - lo));
  const want = sum(lifts);
  const room = Math.max(total - n * min, Math.min(want, total * 0.2));
  if (want > room && want > 0) lifts = lifts.map((l) => (l * room) / want);
  let durs = share(w, Math.max(0, total - sum(lifts)), min);
  if (opts.maxMsPerPx !== undefined) {
    const cap = opts.maxMsPerPx;
    durs = durs.map((d, i) => Math.min(d, Math.max(min, w[i] * cap)));
  }
  const out: Slot[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push({ startMs: t, durMs: durs[i] });
    t += durs[i] + (i < n - 1 ? lifts[i] : 0);
  }
  return out;
}

/**
 * 글씨 시간표: 글자 폭에 비례(±15%), 글자 사이 40~90ms, 띄어쓰기 앞 120ms 쉼(띄어쓰기 자체는 0ms).
 * 쉼이 전체의 45%를 넘으면 줄인다. 끝 ≤ totalMs.
 */
export function textSchedule(
  widths: number[], isSpace: boolean[], totalMs: number, rand: () => number, opts: { maxMsPerPx?: number } = {},
): Slot[] {
  const n = widths.length;
  if (n === 0) return [];
  const total = Math.max(0, finite(totalMs, 0));
  const gaps = widths.map((_, i) => {
    if (i === 0) return 0;
    if (isSpace[i]) return 120;
    if (isSpace[i - 1]) return 0;
    return 40 + rand() * 50;
  });
  const g = sum(gaps);
  const maxG = total * 0.45;
  const k = g > maxG && g > 0 ? maxG / g : 1;
  const gs = gaps.map((x) => x * k);
  const w = widths.map((x, i) => (isSpace[i] ? 0 : Math.max(1, finite(x, 1)) * (1 + (rand() * 2 - 1) * 0.15)));
  const sw = sum(w) || 1;
  const avail = Math.max(0, total - sum(gs));
  const out: Slot[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += gs[i];
    let d = (avail * w[i]) / sw;
    if (opts.maxMsPerPx !== undefined && !isSpace[i]) d = Math.min(d, Math.max(60, w[i] * opts.maxMsPerPx));
    out.push({ startMs: t, durMs: d });
    t += d;
  }
  return out;
}

/** 획 가감속: 처음·끝은 느리고(멈추지는 않음) 가운데가 빠르다. 0→0, 1→1, 단조. */
export function easeStroke(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 0.3 * x + 0.7 * x * x * (3 - 2 * x);
}

/** 표시("쫙"): 빠르게 나가서 끝에서만 살짝 늦춘다. */
export function easeFlick(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 2.2);
}

/** 씨앗이 같으면 같은 수열(mulberry32). 문자열 씨앗은 FNV-1a로 바꾼다. */
export function seededRand(seed: number | string): () => number {
  let h: number;
  if (typeof seed === 'string') {
    h = 2166136261;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  } else {
    h = Math.floor(finite(seed, 1)) | 0;
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** #rrggbb를 검정 쪽으로 k(0..1)만큼 섞는다(잉크가 고인 점). */
export function shadeInk(hex: string, k: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - k)).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

type P = [number, number];
const bpt = ([x, y]: P) => pt(clamp(x, EDGE, BOARD.w - EDGE), clamp(y, EDGE, BOARD.h - EDGE));

/** 점들을 지나는 매끈한 곡선(Catmull-Rom → 3차 베지어). */
function smooth(ps: P[]): string {
  let d = `M${bpt(ps[0])}`;
  for (let i = 0; i < ps.length - 1; i++) {
    const p0 = ps[Math.max(0, i - 1)], p1 = ps[i], p2 = ps[i + 1], p3 = ps[Math.min(ps.length - 1, i + 2)];
    const c1: P = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: P = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${bpt(c1)} ${bpt(c2)} ${bpt(p2)}`;
  }
  return d;
}
const poly = (ps: P[], close = false) => `M${ps.map(bpt).join(' L')}${close ? ' Z' : ''}`;

/**
 * 선생님 표시 경로(보드 좌표). r: 표시할 낱말·그림 상자. 손으로 그은 느낌으로 살짝 기울고 흔들린다.
 * compact: 줄 간격이 좁은 정리 줄용 — 밑줄 계열을 글자에 더 바짝 붙여 다음 줄 글씨에 닿지 않게 한다.
 * 옆에 붙는 표시(star·check·pigtail·exclaim)는 오른쪽에, 자리가 없으면 왼쪽에.
 */
export function markPaths(style: MarkStyle, r: Rect, rand: () => number, compact = false): string[] {
  const j = (a: number) => (rand() * 2 - 1) * a;
  const x0 = r.x, x1 = r.x + r.w, y1 = r.y + r.h;
  const cy = r.y + r.h / 2;
  const S = clamp(r.h * 0.7, 28, 56);
  const right = x1 + 14 + S * 2 <= BOARD.w - EDGE || x0 - 14 - S * 2 < EDGE;
  const side = right ? x1 + 14 + S / 2 : x0 - 14 - S / 2; // 옆 표시의 가운데 x
  const dir = right ? 1 : -1;

  const underline = (yOff: number, inset: number, flick: boolean): string => {
    const ya = y1 + yOff + j(1.5);
    const xa = x0 - 6 + inset + j(3), xb = x1 + 8 - inset + j(4);
    const yb = ya - (1 + rand() * 3); // 오른쪽으로 살짝 올라간다
    const c: P = [(xa + xb) / 2 + j(10), (ya + yb) / 2 + 2 + rand() * 2.5];
    let d = `M${bpt([xa, ya])} Q${bpt(c)} ${bpt([xb, yb])}`;
    if (flick) d += ` Q${bpt([xb + 5, yb - 0.5])} ${bpt([xb + 8, yb - 3.5])}`; // 끝 삐침
    return d;
  };

  switch (style) {
    case 'double':
      return compact ? [underline(3, 0, false), underline(9, 8, true)] : [underline(7, 0, false), underline(18, 8, true)];
    case 'wavy': {
      const yy = y1 + (compact ? 6 : 11);
      const lam = clamp(r.h * 0.42, 14, 26);
      const xa = x0 - 4 + j(3), xb = x1 + 6 + j(3);
      const halves = Math.max(2, Math.round((xb - xa) / (lam / 2)));
      const step = (xb - xa) / halves;
      const rise = rand() * 3;
      let d = `M${bpt([xa, yy])}`;
      for (let i = 0; i < halves; i++) {
        const xs = xa + step * i, xe = xs + step;
        const ye = yy - (rise * (i + 1)) / halves;
        const amp = (4.5 + j(1)) * (i % 2 === 0 ? -1 : 1);
        d += ` Q${bpt([(xs + xe) / 2, ye + 2 * amp])} ${bpt([xe, ye])}`;
      }
      return [d];
    }
    case 'circle':
      return [circleMarkPath(circleAround(r), rand)];
    case 'box': {
      const p = 10;
      const a: P = [x0 - p + j(3), r.y - p + j(3)];
      return [poly([
        a,
        [x1 + p + j(3), r.y - p + j(3)],
        [x1 + p + j(3), y1 + p + j(3)],
        [x0 - p + j(3), y1 + p + j(3)],
        [a[0] + j(2), a[1] - 5], // 시작점을 살짝 지나친다
      ])];
    }
    case 'star': {
      const c: P = [side, r.y + r.h * 0.42];
      const R = S / 2;
      const ps: P[] = [];
      for (let k = 0; k < 5; k++) {
        const a = ((126 + 144 * k) * Math.PI) / 180; // 왼쪽 아래에서 시작하는 한붓그리기 별
        ps.push([c[0] + Math.cos(a) * R + j(R * 0.06), c[1] + Math.sin(a) * R + j(R * 0.06)]);
      }
      return [poly(ps, true)];
    }
    case 'pigtail': {
      // 낱말 밑을 쭉 긋다가 끝에서 돼지꼬리처럼 아래로 한 바퀴 말고 살짝 빠져나간다(한 획, 글자와 안 겹침).
      const ya = y1 + 9 + j(1.5);
      const xa = x0 - 4 + j(3), xb = x1 - 4 + j(2);
      const yb = ya - (1 + rand() * 2.5);
      const R = clamp(r.h * 0.16, 7, 13);
      const ps: P[] = [];
      for (let i = 0; i <= 4; i++) ps.push([lerp(xa, xb, i / 4), lerp(ya, yb, i / 4) + (i % 2 ? j(1) : 0)]);
      const T = Math.PI * 2 + 0.9;
      for (let i = 1; i <= 16; i++) {
        const t = (T * i) / 16;
        const drift = (R * 0.55 * t) / (Math.PI * 2); // 고리가 제자리에서 닫히지 않고 오른쪽으로 밀린다
        ps.push([xb + drift + R * Math.sin(t) + j(0.5), yb + R - R * Math.cos(t) + j(0.5)]);
      }
      const [ex, ey] = ps[ps.length - 1];
      ps.push([ex + R * 0.9, ey + R * 0.1]);
      return [smooth(ps)];
    }
    case 'check': {
      const p0: P = [side - S * 0.42 * dir + j(2), cy - S * 0.02 + j(2)];
      const p1: P = [side - S * 0.12 * dir + j(2), cy + S * 0.36 + j(2)];
      const p2: P = [side + S * 0.46 * dir + j(3), cy - S * 0.5 + j(3)];
      const m1: P = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 + 2];
      const m2: P = [(p1[0] + p2[0]) / 2 - 3 * dir, (p1[1] + p2[1]) / 2 + 3];
      return [`M${bpt(p0)} Q${bpt(m1)} ${bpt(p1)} Q${bpt(m2)} ${bpt(p2)}`];
    }
    case 'exclaim': {
      const out: string[] = [];
      for (let k = 0; k < 2; k++) {
        const x = side + (k - 0.5) * S * 0.38 * dir + j(1.5);
        const top = cy - S * 0.55 + j(2);
        out.push(`M${bpt([x + 1.5, top])} L${bpt([x - 1.5 + j(1), cy + S * 0.18])}`);
        const dy = cy + S * 0.44;
        out.push(`M${bpt([x - 2, dy])} L${bpt([x - 1, dy + 1.5])}`);
      }
      return out;
    }
    case 'underline':
    default:
      return [underline(compact ? 4 : 9, 0, true)];
  }
}

/** 동그라미 표시의 타원(보드 좌표). */
export type Ellipse = { cx: number; cy: number; rx: number; ry: number };

/** 상자를 감싸는 손그림 동그라미의 기본 타원: 글자 상자는 가로로 조금 더 넉넉하게. */
export function circleAround(r: Rect): Ellipse {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2 + 14 + r.h * 0.1, ry: r.h / 2 + 12 };
}

/**
 * 동그라미 획이 차지하는 반지름 범위(타원 반지름 1 기준). 흔들림(±1.8%), 끝 겹침(바깥으로 CIRCLE_TAIL_GAP),
 * 중심 흔들림(2px)을 품는다. 이 띠가 이름표 상자에 닿지 않으면 획도 닿지 않는다(fitEllipse가 쓴다).
 */
export const CIRCLE_BAND: readonly [number, number] = [0.95, 1.07];
/** 끝이 시작을 지나치는 각도 범위(도). 손으로 닫은 동그라미의 짧은 겹침. */
export const CIRCLE_OVER_DEG: readonly [number, number] = [10, 18];
/**
 * 겹친 끝이 시작 선에서 바깥으로 벌어지는 최대 거리(보드 px). 마커 굵기(7.2)의 절반보다 작아 겹친 곳이 한 획처럼 보인다
 * (QA2 2026-11-23: 5px이면 겹친 곳만 1.7배 굵어져, 양 끝 잉크 고임 점과 함께 원 왼쪽 위의 짧은 흔적으로 보였다).
 */
export const CIRCLE_TAIL_GAP = 1.2;

/**
 * 손으로 그은 동그라미 한 획의 점들(보드 좌표). 왼쪽 위에서 시작해 한 바퀴 돌고, 시작을 10~18°만 지나쳐 닫는다.
 * 지나친 끝은 시작 선 바로 바깥(CIRCLE_TAIL_GAP 이내)을 나란히 따라가 따로 그은 짧은 호로 보이지 않는다
 * (D3 2026-11-23: 예전에는 22~34°를 반지름 5% 바깥으로 돌아 원 옆에 뜻 없는 호가 생겼다).
 * 흔들림은 각도에 대해 주기적이라 시작과 겹친 끝의 반지름이 같다.
 */
export function circleMarkPoints(e: Ellipse, rand: () => number): [number, number][] {
  const j = (a: number) => (rand() * 2 - 1) * a;
  const cx = e.cx + j(2), cy = e.cy + j(2);
  const tilt = j((4 * Math.PI) / 180);
  const a0 = ((-150 + j(15)) * Math.PI) / 180;
  const [lo, hi] = CIRCLE_OVER_DEG;
  const over = ((lo + rand() * (hi - lo)) * Math.PI) / 180;
  const sweep = Math.PI * 2 + over;
  const phase = rand() * Math.PI * 2;
  const steps = 36;
  const ps: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    const k = 1 + 0.018 * Math.sin(2 * (a - a0) + phase); // 주기 π: 시작과 겹친 끝에서 같은 값
    // 한 바퀴를 다 돌기 직전(겹침 길이만큼 앞)부터 살짝 바깥으로 벌어져, 시작 선 옆을 나란히 지나간다
    const t = clamp((a - a0 - (Math.PI * 2 - over)) / (2 * over), 0, 1);
    // 시작점 위(t = 0.5)에서 가장 바깥, 끝에서는 다시 첫 바퀴 선 위로 돌아와 앉는다(QA2: 끝이 바깥에 떠 있으면
    // 둥근 끝이 원 밖으로 볼록 튀어 짧은 흔적처럼 보였다).
    const out = CIRCLE_TAIL_GAP * Math.sin(Math.PI * t);
    const ex = Math.cos(a) * (e.rx * k + out), ey = Math.sin(a) * (e.ry * k + out);
    ps.push([cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)]);
  }
  return ps;
}

/** 손으로 그은 동그라미 한 획(경로). */
export function circleMarkPath(e: Ellipse, rand: () => number): string {
  return smooth(circleMarkPoints(e, rand));
}

/** 채우기 마스크용 빗금 지그재그(로컬 좌표). "/" 방향 선을 왼쪽 위에서 오른쪽 아래로 쓸어 가며 오간다. */
export function hatchPath(b: Rect, spacing: number): string {
  const s = Math.max(0.5, spacing);
  const xa = b.x, ya = b.y, xb = b.x + b.w, yb = b.y + b.h;
  const ps: string[] = [];
  let up = true;
  const last = xb + yb;
  for (let k = 0; ; k++) {
    const c = Math.min(xa + ya + k * s, last); // 마지막 선은 오른쪽 아래 모서리에서 끝난다
    // x + y = c 선을 상자로 자른다
    const lowY = Math.min(yb, c - xa), highY = Math.max(ya, c - xb);
    const lo = pt(c - lowY, lowY), hi = pt(c - highY, highY);
    if (up) ps.push(lo, hi);
    else ps.push(hi, lo);
    up = !up;
    if (c >= last) break;
  }
  return ps.length ? `M${ps.join(' L')}` : `M${pt(xa, ya)}`;
}

/**
 * 경로 끝에 붙일 화살촉(같은 좌표계). 끝점과 그 직전의 진행 방향(L이면 앞 점, Q·C면 마지막 조절점)으로
 * 촉을 만든다. len: 촉 길이(경로 좌표 단위). M L Q C Z와 소문자(상대) 명령을 읽는다.
 * 길이 0인 마디(같은 점 반복)는 방향을 바꾸지 않는다. 못 만들면 null.
 */
export function arrowHeadPath(d: string, len: number): string | null {
  const toks = d.match(/[MLQCZmlqcz]|-?\d*\.?\d+/g);
  if (!toks) return null;
  let cmd = '';
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  let from: [number, number] | null = null; // 끝점으로 들어오는 방향의 앞 점
  const same = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6;
  let i = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    const t = toks[i];
    if (/^[MLQCZmlqcz]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (cur && start && !same(cur, start)) { from = cur; cur = start; }
        continue;
      }
    }
    const up = cmd.toUpperCase();
    const need = up === 'Q' ? 4 : up === 'C' ? 6 : up === 'M' || up === 'L' ? 2 : 0;
    if (need === 0 || i + need > toks.length) return null;
    const v = Array.from({ length: need }, num);
    if (v.some((n) => !Number.isFinite(n))) return null;
    const rel = cmd !== up;
    if (rel) {
      const [ox, oy] = cur ?? [0, 0];
      for (let k = 0; k < need; k += 2) { v[k] += ox; v[k + 1] += oy; }
    }
    const end: [number, number] = [v[need - 2], v[need - 1]];
    if (up === 'M') { start = end; from = null; cur = end; cmd = rel ? 'l' : 'L'; continue; }
    // 들어오는 방향: 끝점과 겹치지 않는 가장 가까운 조절점, 없으면 앞 점
    const cands: [number, number][] = [];
    for (let k = need - 4; k >= 0; k -= 2) cands.push([v[k], v[k + 1]]);
    if (cur) cands.push(cur);
    const dir = cands.find((c) => !same(c, end));
    if (dir) from = dir; // 길이 0 마디면 앞 방향 그대로
    cur = end;
  }
  if (!cur || !from) return null;
  const dx = cur[0] - from[0], dy = cur[1] - from[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return null;
  const ux = dx / L, uy = dy / L;
  const a = HEAD_ANGLE;
  const side = (s: number): [number, number] => [
    cur![0] - len * (ux * Math.cos(a) - s * uy * Math.sin(a)),
    cur![1] - len * (uy * Math.cos(a) + s * ux * Math.sin(a)),
  ];
  const [l, r] = [side(1), side(-1)];
  return `M${pt(l[0], l[1])} L${pt(cur[0], cur[1])} L${pt(r[0], r[1])}`;
}

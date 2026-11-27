// 그림 이름표 자리 찾기: 이름표가 그림 선이나 다른 이름표와 겹치면 가장 가까운 빈자리로 옮긴다.
// (2026-11-22 아이패드 실사용: "보이지 않는 바람"과 "흔들리는 나무"가 겹치고, 이름표가 그림 위에 쓰였다.)
import type { Pt } from './dom';
import { CIRCLE_BAND, circleAround, type Ellipse } from './primitives';

export type Box = { x: number; y: number; w: number; h: number };
export type Obstacles = { points: Pt[]; boxes: Box[] };

/** 이름표 둘레 여백(보드 px). 마커 선 굵기(7.2)의 절반 + 숨 쉴 틈. */
export const LABEL_PAD = 8;
/** 이만큼 넘게 옮겼으면 원래 가리키던 곳까지 안내선을 긋는다. */
export const LEADER_MIN = 28;
/** 목표가 이름표에서 이만큼 안이면 안내선을 긋지 않는다(보드 px). */
const LEADER_GAP = 4;
const STEP = 10;
const MAX_R = 240;
/** 먼저 이 거리 안에서(필요하면 글씨를 줄여) 찾고, 없을 때만 더 멀리. 멀리 옮기면 긴 안내선이 그림을 가로지른다. */
export const NEAR_R = 90;
/** 위·아래를 먼저(글씨는 가로로 길어 옆으로 옮기면 멀리 가야 한다), 그다음 비스듬히, 옆. */
const ANGLES = [-90, 90, -60, -120, 60, 120, -30, -150, 30, 150, 0, 180].map((a) => (a * Math.PI) / 180);

/** 두 상자를 모두 품는 상자. */
export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const inflate = (b: Box, p: number): Box => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (b: Box, outer: Box) => b.x >= outer.x && b.y >= outer.y && b.x + b.w <= outer.x + outer.w && b.y + b.h <= outer.y + outer.h;

/** 겹친 정도(겹친 선 점 수 + 겹친 상자 수 × 20). 0이면 깨끗하다. */
export function collisions(box: Box, obs: Obstacles, pad = LABEL_PAD): number {
  const b = inflate(box, pad);
  let n = 0;
  for (const [x, y] of obs.points) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) n++;
  for (const o of obs.boxes) if (overlaps(b, o)) n += 20;
  return n;
}

/** 선 점 격자(칸 CELL px). 점이 수만 개여도 상자 둘레 칸만 본다. */
const CELL = 32;
type Grid = Map<number, Pt[]>;
/** 칸 번호(cx, cy) → 수 하나(문자열 키보다 훨씬 빠르다). 보드 좌표 ±100만 px 안이면 겹치지 않는다. */
const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
function gridOf(points: Pt[]): Grid {
  const g: Grid = new Map();
  for (const p of points) {
    const k = cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL));
    const a = g.get(k);
    if (a) a.push(p);
    else g.set(k, [p]);
  }
  return g;
}
/**
 * 같은 점 배열로 여러 번 찾으면(이름표 하나에 크기·거리를 바꿔 최대 8번, 이름표 12개) 격자를 한 번만 만든다
 * (QA2 2026-11-23: 큰 그림 + 쪽 전체 장애물 7천 점에서 이름표 자리 찾기 시간의 대부분이 격자 다시 만들기였다).
 * 점 배열은 만든 뒤 바꾸지 않는다고 본다(개수가 바뀌면 다시 만든다).
 */
const grids = new WeakMap<Pt[], { n: number; grid: Grid }>();
function gridFor(points: Pt[]): Grid {
  const c = grids.get(points);
  if (c && c.n === points.length) return c.grid;
  const grid = gridOf(points);
  grids.set(points, { n: points.length, grid });
  return grid;
}
/** collisions와 같은 값을 격자로 센다. */
function gridCollisions(box: Box, grid: Grid, boxes: Box[], pad: number): number {
  const b = inflate(box, pad);
  let n = 0;
  const x1 = b.x + b.w, y1 = b.y + b.h;
  for (let cx = Math.floor(b.x / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    for (let cy = Math.floor(b.y / CELL); cy <= Math.floor(y1 / CELL); cy++) {
      const a = grid.get(cellKey(cx, cy));
      if (a) for (const [x, y] of a) if (x >= b.x && x <= x1 && y >= b.y && y <= y1) n++;
    }
  }
  for (const o of boxes) if (overlaps(b, o)) n += 20;
  return n;
}

/**
 * 이름표를 얼마나 옮길지(dx, dy). 겹치지 않으면 그대로(0, 0).
 * 가까운 거리부터 여러 방향으로 찾아 bounds 안의 첫 빈자리를 고른다. 빈자리가 없으면 가장 덜 겹치는 자리.
 */
export function placeLabel(box: Box, obs: Obstacles, bounds: Box, pad = LABEL_PAD, maxR = MAX_R): { dx: number; dy: number; score: number } {
  const grid = gridFor(obs.points);
  const score = (b: Box) => gridCollisions(b, grid, obs.boxes, pad);
  const here = score(box);
  if (here === 0) return { dx: 0, dy: 0, score: 0 };
  let best = { dx: 0, dy: 0, score: here };
  for (let r = STEP; r <= maxR; r += STEP) {
    for (const a of ANGLES) {
      const dx = Math.round(Math.cos(a) * r), dy = Math.round(Math.sin(a) * r);
      const moved = { ...box, x: box.x + dx, y: box.y + dy };
      if (!inside(moved, bounds)) continue;
      const s = score(moved);
      if (s === 0) return { dx, dy, score: 0 };
      if (s < best.score) best = { dx, dy, score: s };
    }
  }
  return best;
}

/**
 * 옮긴 이름표(box)에서 원래 가리키던 점(target)까지 짧은 곡선 안내선. 이름표 가장자리에서 시작해 점 조금 앞에서 멈춘다.
 * 점이 이름표 안이나 바로 옆(LEADER_GAP 안)이면 null: 그을 선이 글자 위의 짧은 흠집이 될 뿐이다.
 */
export function leaderPath(box: Box, target: Pt): string | null {
  if (inside({ x: target[0], y: target[1], w: 0, h: 0 }, inflate(box, LEADER_GAP))) return null;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const [tx, ty] = target;
  // 상자 가장자리에서 출발: 중심→목표 방향으로 상자를 벗어나는 점
  const dx = tx - cx, dy = ty - cy;
  const k = Math.min(dx !== 0 ? box.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? box.h / 2 / Math.abs(dy) : Infinity, 1);
  const sx = cx + dx * k + Math.sign(dx) * 4, sy = cy + dy * k + Math.sign(dy) * 4;
  const len = Math.hypot(tx - sx, ty - sy) || 1;
  const stop = Math.min(10, len / 3);
  const ex = tx - ((tx - sx) / len) * stop, ey = ty - ((ty - sy) / len) * stop;
  // 살짝 휜 손그림 선
  const mx = (sx + ex) / 2 - ((ey - sy) / len) * len * 0.12, my = (sy + ey) / 2 + ((ex - sx) / len) * len * 0.12;
  const f = (n: number) => n.toFixed(1);
  return `M${f(sx)} ${f(sy)} Q${f(mx)} ${f(my)} ${f(ex)} ${f(ey)}`;
}

/**
 * 상자(b)가 타원 획의 띠(반지름 band[0]~band[1] 배)에 닿는가. 타원 좌표로 늘이면 상자는 그대로 축 정렬 상자라
 * 가장 가까운 점(중심을 상자에 가둔 점)과 가장 먼 모서리만 보면 된다.
 */
export function ellipseHits(e: Ellipse, b: Box, band: readonly [number, number] = CIRCLE_BAND): boolean {
  const x0 = (b.x - e.cx) / e.rx, x1 = (b.x + b.w - e.cx) / e.rx;
  const y0 = (b.y - e.cy) / e.ry, y1 = (b.y + b.h - e.cy) / e.ry;
  const nx = Math.min(Math.max(0, x0), x1), ny = Math.min(Math.max(0, y0), y1);
  const near = Math.hypot(nx, ny);
  const far = Math.hypot(Math.max(Math.abs(x0), Math.abs(x1)), Math.max(Math.abs(y0), Math.abs(y1)));
  return near <= band[1] && far >= band[0];
}

/**
 * 타원 띠(CIRCLE_BAND[1]배)가 bounds 안에 들도록 가운데는 두고 반지름만 줄인다. 보드 가장자리에 붙은 그림(세 칸 중 양쪽 칸,
 * 넓은 그림)의 동그라미가 보드 밖으로 나가 획이 가장자리에 눌려 납작한 직선이 되지 않게(QA2 2026-11-23).
 */
function fitInside(e: Ellipse, bounds: Box): Ellipse {
  const k = CIRCLE_BAND[1];
  const rx = Math.min(e.rx, (e.cx - bounds.x) / k, (bounds.x + bounds.w - e.cx) / k);
  const ry = Math.min(e.ry, (e.cy - bounds.y) / k, (bounds.y + bounds.h - e.cy) / k);
  return rx === e.rx && ry === e.ry ? e : { ...e, rx: Math.max(4, rx), ry: Math.max(4, ry) };
}

/**
 * 동그라미 표시 타원 고르기(D1 2026-11-23: 그림을 감싼 빨간 동그라미가 이름표 "아주 먼 달"을 가로질렀다).
 * core(감쌀 그림 선 상자)를 기본 타원으로 감싸고, 획의 띠가 이름표 상자(avoid, pad만큼 넓혀)에 닿으면 그 이름표까지
 * 안에 품도록 타원을 키운다(닿는 것이 없을 때까지, 최대 6번). 끝내 못 피하면 가장 덜 닿는 타원.
 * bounds를 넘는 타원은(보드 밖으로 잘려 모양이 망가지니) 고르지 않는다(없으면 기본 타원).
 */
export function fitEllipse(core: Box, avoid: Box[], bounds: Box, pad = LABEL_PAD): Ellipse {
  const boxes = avoid.map((b) => inflate(b, pad));
  const hits = (e: Ellipse) => boxes.filter((b) => ellipseHits(e, b));
  const fits = (e: Ellipse) => e.cx - e.rx * CIRCLE_BAND[1] >= bounds.x && e.cx + e.rx * CIRCLE_BAND[1] <= bounds.x + bounds.w
    && e.cy - e.ry * CIRCLE_BAND[1] >= bounds.y && e.cy + e.ry * CIRCLE_BAND[1] <= bounds.y + bounds.h;
  const base = fitInside(circleAround(core), bounds);
  let best = { e: base, n: hits(base).length };
  if (best.n === 0) return base;
  let inside: Box[] = [];
  let e = base;
  for (let round = 0; round < 6; round++) {
    const hit = hits(e);
    if (hit.length === 0) break;
    inside = [...inside, ...hit.filter((b) => !inside.includes(b))];
    const all = inside.reduce(union, core);
    // 품을 상자들(그림 + 닿은 이름표)을 감싸는 타원: 가운데를 맞추고, 모든 모서리가 띠 안쪽(band[0]) 아래로 들어올 만큼 키운다
    const c = circleAround(all);
    let k = 1;
    for (const b of [core, ...inside]) {
      for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
        k = Math.max(k, Math.hypot((x - c.cx) / c.rx, (y - c.cy) / c.ry) / (CIRCLE_BAND[0] - 0.01));
      }
    }
    e = { ...c, rx: c.rx * k, ry: c.ry * k };
    const n = hits(e).length;
    if (fits(e) && n < best.n) best = { e, n };
    if (n === 0) break;
  }
  return best.e;
}

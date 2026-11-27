import { collisions, ellipseHits, fitEllipse, leaderPath, placeLabel, LABEL_PAD, type Box } from '../../src/web/board/labelPlace';
import { CIRCLE_BAND, circleAround, circleMarkPoints, seededRand } from '../../src/web/board/primitives';

const bounds: Box = { x: 0, y: 0, w: 400, h: 400 };
const label: Box = { x: 150, y: 190, w: 100, h: 20 };
/** 가로선 하나(이름표 한가운데를 지난다). */
const line = Array.from({ length: 41 }, (_, i) => [100 + i * 5, 200] as [number, number]);

test('겹치지 않으면 그대로', () => {
  expect(placeLabel(label, { points: [[10, 10]], boxes: [] }, bounds)).toEqual({ dx: 0, dy: 0, score: 0 });
});

test('선과 겹치면 가장 가까운 빈자리(위 먼저)로 옮기고, 옮긴 자리는 깨끗하다', () => {
  const obs = { points: line, boxes: [] };
  expect(collisions(label, obs)).toBeGreaterThan(0);
  const { dx, dy } = placeLabel(label, obs, bounds);
  expect(dx).toBe(0);
  expect(dy).toBeLessThan(0); // 위로
  const moved = { ...label, x: label.x + dx, y: label.y + dy };
  expect(collisions(moved, obs)).toBe(0);
  expect(Math.abs(dy)).toBeLessThanOrEqual(label.h + 2 * LABEL_PAD + 10); // 필요한 만큼만
});

test('앞 이름표(상자)와도 겹치지 않게', () => {
  const other: Box = { x: 140, y: 185, w: 120, h: 30 };
  const { dx, dy } = placeLabel(label, { points: [], boxes: [other] }, bounds);
  const moved = { ...label, x: label.x + dx, y: label.y + dy };
  expect(collisions(moved, { points: [], boxes: [other] })).toBe(0);
});

test('바깥(bounds)으로는 옮기지 않는다: 위가 막히면 아래로', () => {
  const top: Box = { x: 150, y: 2, w: 100, h: 20 };
  const obs = { points: Array.from({ length: 41 }, (_, i) => [100 + i * 5, 12] as [number, number]), boxes: [] };
  const { dy } = placeLabel(top, obs, bounds);
  expect(dy).toBeGreaterThan(0);
});

test('안내선은 이름표 가장자리에서 시작해 목표 조금 앞에서 멈춘다', () => {
  const d = leaderPath({ x: 100, y: 100, w: 80, h: 20 }, [140, 200])!;
  const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  expect(n[1]).toBeGreaterThanOrEqual(120); // 상자 아래 가장자리(y 120) 밖에서 출발
  expect(n[5]).toBeLessThan(200); // 목표(y 200) 앞에서 멈춤
});

// QA 2026-11-22: 옆으로 조금(28px 넘게) 옮긴 넓은 이름표는 원래 가리키던 점이 이름표 안에 있어, 안내선이 글자 위의 짧은 흠집이 됐다.
test('목표가 이름표 안(또는 바로 옆)이면 안내선을 긋지 않는다', () => {
  const moved: Box = { x: 130, y: 85, w: 150, h: 44 }; // 원래 (100,100)에서 (30,-15) 옮김
  expect(leaderPath(moved, [100 + 75, 100 + 22])).toBeNull();
  expect(leaderPath({ x: 100, y: 100, w: 80, h: 20 }, [182, 110])).toBeNull(); // 가장자리 2px 밖
  expect(leaderPath({ x: 100, y: 100, w: 80, h: 20 }, [140, 200])).not.toBeNull();
});

const brute = (box: Box, pts: [number, number][], boxes: Box[]) => collisions(box, { points: pts, boxes });

// QA 2026-11-22: 선 점이 아주 많으면(획 60개 × 2000자) 이름표 자리 찾기가 수 초 동안 화면을 멈췄다.
test('점이 아주 많아도 빨리 찾고, 결과는 하나하나 센 것과 같다', () => {
  const r = (() => { let a = 7; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
  const pts = Array.from({ length: 60000 }, () => [r() * 400, r() * 400] as [number, number]);
  const obs = { points: pts, boxes: [{ x: 10, y: 10, w: 40, h: 40 }] };
  let res = { dx: 0, dy: 0, score: 0 };
  // QA2 2026-11-23: 절대 한도(500ms)는 전체 시험·다른 브라우저가 함께 돌면 702ms까지 흔들려 실패했다. 같은 기계·같은 순간에
  // 같은 자리들을 하나하나 세는 찾기와 견줘 비율로 본다(부하는 둘 다 같이 느리게 한다). 둘 다 두 번 재서 가장 빠른 값.
  // 점 배열은 매번 새로 만들어 격자 만들기 몫도 잰다(이름표 하나에 7번 = 크기·거리를 바꿔 찾는 횟수).
  const ANG = [-90, 90, -60, -120, 60, 120, -30, -150, 30, 150, 0, 180].map((a) => (a * Math.PI) / 180);
  const naive = (box: Box) => {
    let best = collisions(box, obs);
    for (let rr = 10; rr <= 240 && best > 0; rr += 10) {
      for (const a of ANG) {
        const m = { ...box, x: box.x + Math.round(Math.cos(a) * rr), y: box.y + Math.round(Math.sin(a) * rr) };
        if (m.x < 0 || m.y < 0 || m.x + m.w > 400 || m.y + m.h > 400) continue;
        best = Math.min(best, collisions(m, obs));
      }
    }
    return best;
  };
  let grid = Infinity, slow = Infinity;
  for (let round = 0; round < 2; round++) {
    const fresh = { points: [...pts], boxes: obs.boxes };
    let t0 = performance.now();
    for (let i = 0; i < 7; i++) res = placeLabel({ x: 150, y: 190, w: 100, h: 20 }, fresh, bounds);
    grid = Math.min(grid, (performance.now() - t0) / 7);
    t0 = performance.now();
    for (let i = 0; i < 2; i++) naive({ x: 150, y: 190, w: 100, h: 20 });
    slow = Math.min(slow, (performance.now() - t0) / 2);
  }
  expect(grid * 4, `격자 ${grid.toFixed(1)}ms/번, 하나하나 ${slow.toFixed(1)}ms/번`).toBeLessThan(slow); // 보통 12~30배 빠르다
  const moved = { x: 150 + res.dx, y: 190 + res.dy, w: 100, h: 20 };
  expect(res.score).toBe(brute(moved, pts, obs.boxes));
});

test('격자로 센 겹침이 하나하나 센 것과 같다(경계의 점 포함)', () => {
  const pts: [number, number][] = [[142, 182], [258, 218], [141.9, 200], [200, 218.1], [0, 0], [-50, -50]];
  const obs = { points: pts, boxes: [] };
  const res = placeLabel(label, obs, { x: -100, y: -100, w: 600, h: 600 }, LABEL_PAD, 0);
  expect(res.score).toBe(brute(label, pts, []));
});

// ---------- D1 2026-11-23: 그림을 감싼 빨간 동그라미가 이름표 "아주 먼 달"을 가로질렀다 ----------
describe('동그라미 표시는 이름표 상자를 가로지르지 않는다(fitEllipse)', () => {
  const board: Box = { x: 4, y: 4, w: 1272, h: 712 };
  /** 실제 그을 획의 점(여러 씨앗)이 상자(+pad) 안에 들어가는가. */
  const strokeHits = (e: ReturnType<typeof fitEllipse>, b: Box) => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const p of circleMarkPoints(e, seededRand(seed))) if (collisions(b, { points: [p], boxes: [] }) > 0) return true;
    }
    return false;
  };

  test('ellipseHits: 띠에 걸친 상자만 닿음(완전히 안·완전히 밖은 아님)', () => {
    const e = { cx: 0, cy: 0, rx: 100, ry: 100 };
    expect(ellipseHits(e, { x: -10, y: -10, w: 20, h: 20 })).toBe(false); // 안
    expect(ellipseHits(e, { x: 200, y: 0, w: 20, h: 20 })).toBe(false); // 밖
    expect(ellipseHits(e, { x: 90, y: -5, w: 30, h: 10 })).toBe(true); // 걸침
    expect(ellipseHits(e, { x: -150, y: -150, w: 300, h: 300 })).toBe(true); // 타원을 통째로 덮음
    expect(ellipseHits(e, { x: 100 * CIRCLE_BAND[1] + 1, y: 0, w: 5, h: 5 })).toBe(false);
  });

  test('달 픽스처 모양: 기본 타원이 이름표를 자르면 피한 타원을 고르고, 실제 획도 이름표에 닿지 않는다', () => {
    const core: Box = { x: 565, y: 218, w: 214, h: 244 }; // 달 선
    const label: Box = { x: 568, y: 480, w: 140, h: 40 }; // 그 아래 왼쪽으로 치우친 이름표
    const connect: Box = { x: 380, y: 260, w: 150, h: 40 }; // 왼쪽 위 연결 라벨
    const e = fitEllipse(core, [label, connect], board);
    for (const b of [label, connect]) {
      expect(ellipseHits(e, { x: b.x - LABEL_PAD, y: b.y - LABEL_PAD, w: b.w + 2 * LABEL_PAD, h: b.h + 2 * LABEL_PAD })).toBe(false);
      expect(strokeHits(e, b)).toBe(false);
    }
  });

  test('이름표가 그림 선에 바짝 붙어 있으면 이름표까지 품는다(그림 선도 안에)', () => {
    const core: Box = { x: 500, y: 200, w: 200, h: 200 };
    const label: Box = { x: 520, y: 395, w: 160, h: 40 }; // 그림 바로 아래, 기본 타원의 띠에 걸림
    expect(ellipseHits(circleAround(core), { x: label.x - LABEL_PAD, y: label.y - LABEL_PAD, w: label.w + 16, h: label.h + 16 })).toBe(true);
    const e = fitEllipse(core, [label], board);
    expect(strokeHits(e, label)).toBe(false);
    // 이름표 네 모서리가 타원 안
    for (const [x, y] of [[label.x, label.y], [label.x + label.w, label.y + label.h]]) {
      expect(Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry)).toBeLessThan(CIRCLE_BAND[0]);
    }
  });

  test('닿는 것이 없으면 기본 타원 그대로, 보드를 넘는 큰 타원은 고르지 않는다', () => {
    const core: Box = { x: 500, y: 200, w: 200, h: 200 };
    expect(fitEllipse(core, [{ x: 0, y: 0, w: 30, h: 30 }], board)).toEqual(circleAround(core));
    const big: Box = { x: 10, y: 10, w: 1260, h: 700 }; // 보드만 한 상자
    const e = fitEllipse(core, [big], board);
    expect(e.cx - e.rx * CIRCLE_BAND[1]).toBeGreaterThanOrEqual(board.x - 0.01);
  });
});

// QA2 2026-11-23: 세 칸 중 왼쪽 칸(48~424)을 꽉 채운 그림의 동그라미가 보드 왼쪽 밖으로 나가, 획 점이 보드 가장자리(x 4)에
// 눌려 납작한 세로줄이 됐다(넓은 그림도 양쪽). 기본 타원도 보드 안에 들도록 줄인다.
test('fitEllipse: 그림이 보드 가장자리에 붙어 있어도 타원 띠는 보드 안', () => {
  const board: Box = { x: 4, y: 4, w: 1272, h: 712 };
  const fits = (e: ReturnType<typeof fitEllipse>) => e.cx - e.rx * CIRCLE_BAND[1] >= board.x - 0.01 && e.cx + e.rx * CIRCLE_BAND[1] <= board.x + board.w + 0.01
    && e.cy - e.ry * CIRCLE_BAND[1] >= board.y - 0.01 && e.cy + e.ry * CIRCLE_BAND[1] <= board.y + board.h + 0.01;
  for (const core of [
    { x: 36, y: 150, w: 400, h: 400 }, // 왼쪽 칸 꽉 찬 그림(+12 여백)
    { x: 844, y: 150, w: 400, h: 400 }, // 오른쪽 칸
    { x: 36, y: 118, w: 1208, h: 462 }, // 넓은 그림
  ]) {
    const e = fitEllipse(core, [], board);
    expect(fits(e), JSON.stringify({ core, e })).toBe(true);
    // 실제 획 점도 보드 안(가장자리에 눌리지 않는다)
    for (let seed = 1; seed <= 10; seed++) {
      for (const [x, y] of circleMarkPoints(e, seededRand(seed))) {
        expect(x).toBeGreaterThan(board.x);
        expect(x).toBeLessThan(board.x + board.w);
        expect(y).toBeGreaterThan(board.y);
        expect(y).toBeLessThan(board.y + board.h);
      }
    }
  }
});

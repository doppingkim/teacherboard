import { CIRCLE_BAND, CIRCLE_OVER_DEG, CIRCLE_TAIL_GAP, arrowHeadPath, arrowPath, circleAround, circleMarkPath, circleMarkPoints, highlightPath, inkColor } from '../../src/web/board/primitives';
import { STROKE_W } from '../../src/web/board/items';
import { clusters } from '../../src/web/board/items';

const a = { x: 0, y: 0, w: 100, h: 100 }, b = { x: 400, y: 0, w: 100, h: 100 };
test('화살표는 두 칸의 가까운 변 사이를 잇는다', () => {
  const [body, head] = arrowPath(a, b);
  expect(body.startsWith('M100 50')).toBe(true); expect(body).toContain('400 50'); expect(head).toMatch(/^M/);
});
test('밑줄은 칸 아래쪽 한 줄', () => expect(highlightPath(a, 'underline')).toMatch(/^M\S+ 1\d\d /));
test('색 매핑', () => { expect(inkColor('blue')).toBe('#1f5fd1'); expect(inkColor('green')).toBe('#1f9a57'); });

// 추가 케이스
test('검정·빨강 색과 모르는 값은 검정으로', () => {
  expect(inkColor('black')).toBe('#23272b');
  expect(inkColor('red')).toBe('#d63b3b');
  expect(inkColor('teal' as never)).toBe('#23272b');
});
test('세로로 놓인 칸은 아래 변 → 위 변으로 잇는다', () => {
  const [body] = arrowPath({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 400, w: 100, h: 100 });
  expect(body.startsWith('M50 100')).toBe(true); expect(body).toContain('50 400');
});
test('화살촉은 끝점을 지난다', () => {
  const [, head] = arrowPath(a, b);
  expect(head).toContain('L400 50 L');
});
test('바로 붙은 칸 사이 화살표도 너무 짧지 않다', () => {
  const [body] = arrowPath({ x: 48, y: 162, w: 376, h: 376 }, { x: 452, y: 162, w: 376, h: 376 });
  // "M sx sy Q cx cy ex ey"
  const n = (body.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  expect(n[4] - n[0]).toBeGreaterThanOrEqual(100);
});
test('박스와 동그라미는 닫힌 모양, 경로 문자에 NaN이 없다', () => {
  for (const s of ['circle', 'underline', 'box'] as const) {
    const d = highlightPath(a, s);
    expect(d).toMatch(/^M/); expect(d).not.toContain('NaN');
  }
  expect(highlightPath(a, 'box')).toMatch(/Z$/);
  expect(highlightPath(a, 'circle')).toContain('A');
});
test('넓은 칸 동그라미도 보드 밖으로 나가지 않는다', () => {
  const d = highlightPath({ x: 48, y: 130, w: 1184, h: 438 }, 'circle');
  const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  // M cx+rx cy A rx ry ... — rx 는 두 번째 숫자 묶음의 첫 값
  const [mx, , rx] = nums;
  expect(mx).toBeLessThanOrEqual(1280);
  expect(mx - 2 * rx).toBeGreaterThanOrEqual(0);
});
test('작은 그림 동그라미는 칸 아래쪽 라벨까지 감싼다(세로로 더 크게), 보드 안', () => {
  const r = { x: 48, y: 162, w: 376, h: 376 };
  const n = (highlightPath(r, 'circle').match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const [, cy, rx, ry] = n; // "M cx+rx cy A rx ry ..."
  expect(ry).toBeGreaterThan(rx);
  expect(cy + ry).toBeGreaterThanOrEqual(r.y + r.h + 30); // 라벨(칸 아래 끝 근처) 아래로 지나감
  expect(cy + ry).toBeLessThanOrEqual(582); // 정리 줄(584~)은 넘지 않음
  expect(cy - ry).toBeGreaterThanOrEqual(0);
});

test('13색 매핑', () => { expect(inkColor('gold')).toBe('#c99a06'); expect(inkColor('lime')).toBe('#6aa516'); });
test('13색 전부 지정 값', () => {
  const want = { black: '#23272b', blue: '#1f5fd1', red: '#d63b3b', green: '#1f9a57', orange: '#e8730c', gold: '#c99a06', purple: '#7b3fc4', pink: '#e0559b', brown: '#8a5a2b', sky: '#2a9fd6', navy: '#1d2f6f', gray: '#7d8590', lime: '#6aa516' } as const;
  for (const [ink, hex] of Object.entries(want)) expect(inkColor(ink as keyof typeof want)).toBe(hex);
});

// ---------- Task 6: 진짜 같은 판서 ----------
import { easeStroke, hatchPath, markPaths, seededRand, shadeInk, strokeSchedule, textSchedule } from '../../src/web/board/primitives';
import type { MarkStyle } from '../../src/shared/script';

const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

test('strokeSchedule: 순서대로, 겹침 없음, 펜 들기 80~200ms, 합 ≤ total', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const lens = [120, 40, 300, 80, 200, 15];
    const s = strokeSchedule(lens, 9000, seededRand(seed));
    expect(s).toHaveLength(lens.length);
    expect(s[0].startMs).toBe(0);
    for (let i = 1; i < s.length; i++) {
      const lift = s[i].startMs - (s[i - 1].startMs + s[i - 1].durMs);
      expect(lift).toBeGreaterThanOrEqual(80 - 1e-6);
      expect(lift).toBeLessThanOrEqual(200 + 1e-6);
    }
    const end = s[s.length - 1].startMs + s[s.length - 1].durMs;
    expect(end).toBeLessThanOrEqual(9000 + 1e-6);
  }
});

test('strokeSchedule: 시간이 모자라도 합 ≤ total, 시간이 남으면 거의 다 쓴다', () => {
  const tight = strokeSchedule(Array(30).fill(50), 1500, seededRand(3));
  const e = tight[29].startMs + tight[29].durMs;
  expect(e).toBeLessThanOrEqual(1500 + 1e-6);
  for (const x of tight) { expect(x.durMs).toBeGreaterThan(0); expect(Number.isFinite(x.startMs)).toBe(true); }
  const roomy = strokeSchedule([300, 300], 2000, seededRand(4));
  expect(roomy[1].startMs + roomy[1].durMs).toBeGreaterThan(1900);
  expect(strokeSchedule([], 1000, seededRand(1))).toEqual([]);
  expect(strokeSchedule([100], 0, seededRand(1))[0].durMs).toBeGreaterThanOrEqual(0);
});

test('strokeSchedule: 긴 획이 더 오래, 최소 120ms', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = strokeSchedule([10, 400, 5, 150], 6000, seededRand(seed));
    expect(s[1].durMs).toBeGreaterThan(s[3].durMs);
    expect(s[3].durMs).toBeGreaterThan(s[0].durMs - 1e-6);
    for (const x of s) expect(x.durMs).toBeGreaterThanOrEqual(120 - 1e-6);
  }
});

test('strokeSchedule: 같은 길이도 획마다 ±15% 안에서 조금씩 다르다', () => {
  const s = strokeSchedule(Array(8).fill(200), 20000, seededRand(7));
  const d = s.map((x) => x.durMs);
  expect(new Set(d.map((v) => v.toFixed(1))).size).toBeGreaterThan(1);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  for (const v of d) expect(Math.abs(v - mean) / mean).toBeLessThanOrEqual(0.36);
});

test('strokeSchedule: 손 속도보다 느리게는 그리지 않는다(maxMsPerPx)', () => {
  const s = strokeSchedule([100, 100], 60000, seededRand(2), { maxMsPerPx: 3 });
  for (const x of s) expect(x.durMs).toBeLessThanOrEqual(100 * 3 * 1.16);
});

test('easeStroke: 0→0, 1→1, 단조, 가운데가 더 빠름', () => {
  expect(easeStroke(0)).toBeCloseTo(0, 6);
  expect(easeStroke(1)).toBeCloseTo(1, 6);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = easeStroke(i / 100);
    expect(v).toBeGreaterThanOrEqual(prev);
    prev = v;
  }
  const slope = (t: number) => (easeStroke(t + 0.01) - easeStroke(t)) / 0.01;
  expect(slope(0.495)).toBeGreaterThan(slope(0) * 1.5);
  expect(slope(0.495)).toBeGreaterThan(slope(0.985) * 1.5);
  expect(slope(0)).toBeGreaterThan(0); // 시작에서 멈춰 있지 않는다
  expect(easeStroke(-1)).toBe(0); expect(easeStroke(2)).toBe(1);
});

const word = { x: 300, y: 40, w: 180, h: 70 };
test.each(['underline', 'double', 'wavy', 'circle', 'box', 'star', 'pigtail', 'check', 'exclaim'] as MarkStyle[])(
  'markPaths %s: 경로 1개 이상, 대상 근처',
  (style) => {
    const ps = markPaths(style, word, seededRand(11));
    expect(ps.length).toBeGreaterThanOrEqual(1);
    for (const d of ps) {
      expect(d).toMatch(/^M/);
      expect(d).not.toContain('NaN');
      const n = nums(d);
      for (let i = 0; i + 1 < n.length; i += 2) {
        const [x, y] = [n[i], n[i + 1]];
        expect(x).toBeGreaterThanOrEqual(word.x - 120); expect(x).toBeLessThanOrEqual(word.x + word.w + 120);
        expect(y).toBeGreaterThanOrEqual(word.y - 80); expect(y).toBeLessThanOrEqual(word.y + word.h + 80);
      }
    }
  },
);

test('double은 경로 2개, star는 닫힌 별', () => {
  expect(markPaths('double', word, seededRand(1))).toHaveLength(2);
  const star = markPaths('star', word, seededRand(1));
  expect(star).toHaveLength(1);
  expect(star[0]).toMatch(/Z$/);
  expect(nums(star[0]).length).toBeGreaterThanOrEqual(10); // 꼭짓점 5개 이상
  expect(markPaths('pigtail', word, seededRand(1))).toHaveLength(1);
});

test('markPaths: 밑줄은 글자 아래, 별·체크는 옆, 보드 밖으로 안 나감', () => {
  const [u] = markPaths('underline', word, seededRand(5));
  const un = nums(u);
  for (let i = 1; i < un.length; i += 2) expect(un[i]).toBeGreaterThan(word.y + word.h - 4);
  const [s] = markPaths('star', word, seededRand(5));
  const sx = nums(s).filter((_, i) => i % 2 === 0);
  expect(Math.min(...sx)).toBeGreaterThan(word.x + word.w);
  // 오른쪽 끝 낱말이면 왼쪽에 붙인다
  const edge = { x: 1100, y: 40, w: 170, h: 70 };
  for (const st of ['star', 'check', 'pigtail', 'exclaim', 'circle', 'box', 'underline'] as MarkStyle[]) {
    for (const d of markPaths(st, edge, seededRand(9))) {
      const n = nums(d);
      for (let i = 0; i + 1 < n.length; i += 2) {
        expect(n[i]).toBeGreaterThanOrEqual(0); expect(n[i]).toBeLessThanOrEqual(1280);
        expect(n[i + 1]).toBeGreaterThanOrEqual(0); expect(n[i + 1]).toBeLessThanOrEqual(720);
      }
    }
  }
});

test('markPaths: 같은 씨앗이면 같은 모양, 다르면 손맛이 다르다', () => {
  expect(markPaths('circle', word, seededRand(3))).toEqual(markPaths('circle', word, seededRand(3)));
  expect(markPaths('circle', word, seededRand(3))).not.toEqual(markPaths('circle', word, seededRand(4)));
});

test('seededRand: 0 이상 1 미만, 재현 가능, 문자열 씨앗', () => {
  const a = seededRand('달'), b = seededRand('달');
  for (let i = 0; i < 50; i++) { const v = a(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); expect(b()).toBe(v); }
});

test('textSchedule: 글자 사이 40~90ms, 띄어쓰기 120ms 쉼, 합 ≤ total', () => {
  const widths = [60, 50, 0, 70, 55];
  const space = [false, false, true, false, false];
  const s = textSchedule(widths, space, 3000, seededRand(2));
  expect(s).toHaveLength(5);
  expect(s[2].durMs).toBe(0); // 띄어쓰기는 쓰지 않는다
  const gap = (i: number) => s[i].startMs - (s[i - 1].startMs + s[i - 1].durMs);
  for (const i of [1, 4]) { expect(gap(i)).toBeGreaterThanOrEqual(40 - 1e-6); expect(gap(i)).toBeLessThanOrEqual(90 + 1e-6); }
  expect(gap(2) + gap(3)).toBeGreaterThanOrEqual(120 - 1e-6); // 띄어쓰기 앞뒤 쉼
  expect(s[4].startMs + s[4].durMs).toBeLessThanOrEqual(3000 + 1e-6);
  expect(s[3].durMs).toBeGreaterThan(s[1].durMs); // 넓은 글자가 더 오래
  const tight = textSchedule(Array(20).fill(50), Array(20).fill(false), 600, seededRand(2));
  expect(tight[19].startMs + tight[19].durMs).toBeLessThanOrEqual(600 + 1e-6);
});

test('hatchPath: "/" 빗금 지그재그가 상자 안에서 상자 전체를 쓸고 지나간다', () => {
  const b = { x: 10, y: 20, w: 30, h: 16 };
  const n = nums(hatchPath(b, 4));
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
  for (const x of xs) { expect(x).toBeGreaterThanOrEqual(10 - 1e-6); expect(x).toBeLessThanOrEqual(40 + 1e-6); }
  for (const y of ys) { expect(y).toBeGreaterThanOrEqual(20 - 1e-6); expect(y).toBeLessThanOrEqual(36 + 1e-6); }
  expect(xs[0]).toBe(10); expect(Math.max(...xs)).toBe(40); // 왼쪽에서 시작해 오른쪽 끝까지
  expect(xs.length).toBeGreaterThanOrEqual(2 * Math.floor((30 + 16) / 4));
});

test('shadeInk: 검정 쪽으로 섞고, 모르는 형식은 그대로', () => {
  expect(shadeInk('#ffffff', 0.5)).toBe('#808080');
  expect(shadeInk('#d63b3b', 0)).toBe('#d63b3b');
  expect(shadeInk('red', 0.3)).toBe('red');
});

test('markPaths compact(정리 줄): 밑줄·겹밑줄·물결이 글자 바닥 아래 줄 간격 안(≤ 15px)에 머문다', () => {
  const w = { x: 100, y: 600, w: 200, h: 47 };
  for (const st of ['underline', 'double', 'wavy'] as MarkStyle[]) {
    for (let seed = 1; seed <= 20; seed++) {
      for (const d of markPaths(st, w, seededRand(seed), true)) {
        const n = nums(d);
        for (let i = 1; i < n.length; i += 2) expect(n[i]).toBeLessThanOrEqual(w.y + w.h + (st === 'wavy' ? 19 : 15)); // 물결은 제어점이 실제 곡선의 2배 멀리 있다
      }
    }
  }
});

describe('arrowHeadPath: 화살촉은 늘 선이 나아가는 쪽 끝을 향한다', () => {
  const pts = (d: string) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  test('오른쪽으로 가는 직선: 촉 끝은 (10,0), 양 날개는 왼쪽 뒤에', () => {
    const [x1, y1, tx, ty, x2, y2] = pts(arrowHeadPath('M0 0 L10 0', 3)!);
    expect([tx, ty]).toEqual([10, 0]);
    expect(x1).toBeLessThan(10); expect(x2).toBeLessThan(10);
    expect(Math.sign(y1)).toBe(-Math.sign(y2));
  });
  test('왼쪽으로 가는 직선은 반대로', () => {
    const [x1, , tx, , x2] = pts(arrowHeadPath('M10 5 L0 5', 3)!);
    expect(tx).toBe(0);
    expect(x1).toBeGreaterThan(0); expect(x2).toBeGreaterThan(0);
  });
  test('곡선(Q)은 마지막 조절점에서 끝점으로 가는 방향: 아래로', () => {
    const [, y1, tx, ty, , y2] = pts(arrowHeadPath('M0 0 Q10 0 10 10', 3)!);
    expect([tx, ty]).toEqual([10, 10]);
    expect(y1).toBeLessThan(10); expect(y2).toBeLessThan(10);
  });
  test('C 곡선과 여러 M: 마지막 부분의 끝', () => {
    const [, y1, tx, ty] = pts(arrowHeadPath('M0 0 L5 5 M20 20 C20 10 30 10 30 0', 3)!);
    expect([tx, ty]).toEqual([30, 0]);
    expect(y1).toBeGreaterThan(0); // 위로 가는 화살표의 날개는 아래쪽
  });
  test('길이가 0이면 null', () => {
    expect(arrowHeadPath('M5 5 L5 5', 3)).toBeNull();
  });
  // QA 2026-11-22: 소문자(상대) 명령을 절대 좌표로 읽어 촉이 엉뚱한 곳(60,0)에 붙었다.
  test('상대 명령(l·q·c·m)도 실제 끝점에 붙는다', () => {
    expect(pts(arrowHeadPath('M10 50 l60 0', 3)!).slice(2, 4)).toEqual([70, 50]);
    const [, y1, tx, ty] = pts(arrowHeadPath('M0 0 q10 0 10 10', 3)!);
    expect([tx, ty]).toEqual([10, 10]); expect(y1).toBeLessThan(10);
    expect(pts(arrowHeadPath('M0 0 c0 10 10 10 10 20 l5 0', 3)!).slice(2, 4)).toEqual([15, 20]);
    expect(pts(arrowHeadPath('M0 0 L5 5 m10 10 l0 -10', 3)!).slice(2, 4)).toEqual([15, 5]);
  });
  // QA 2026-11-22: 끝에 길이 0인 마디(같은 점 반복)가 붙으면 촉이 사라졌다.
  test('끝의 길이 0 마디는 건너뛰고 앞 방향으로 촉을 단다', () => {
    const [x1, , tx, ty, x2] = pts(arrowHeadPath('M10 50 L60 50 L60 50', 3)!);
    expect([tx, ty]).toEqual([60, 50]);
    expect(x1).toBeLessThan(60); expect(x2).toBeLessThan(60);
    expect(pts(arrowHeadPath('M0 0 L10 0 Q10 0 10 0', 3)!).slice(2, 4)).toEqual([10, 0]);
  });
  test('닫힌 경로(Z)는 시작점으로 돌아오는 방향', () => {
    const [, , tx, ty] = pts(arrowHeadPath('M0 0 L10 0 L10 10 Z', 3)!);
    expect([tx, ty]).toEqual([0, 0]);
  });
});

// QA 2026-11-22: 사파리(fade) 글씨가 UTF-16 칸마다 tspan을 만들어 이모지가 반쪽(�)으로 보였다. 보이는 글자 묶음으로 나눈다.
describe('clusters: 보이는 글자 묶음', () => {
  const text = '🌙 é 👨‍👩‍👧 한';
  const want = ['🌙', ' ', 'é', ' ', '👨‍👩‍👧', ' ', '한'];
  test('Intl.Segmenter로', () => {
    const c = clusters(text);
    expect(c.map((x) => x.s)).toEqual(want);
    for (const { s, i0 } of c) expect(text.slice(i0, i0 + s.length)).toBe(s); // UTF-16 위치가 맞다
  });
  test('Segmenter가 없어도(옛 사파리) 같은 묶음', () => {
    const I = Intl as unknown as { Segmenter?: unknown };
    const saved = I.Segmenter;
    try {
      delete I.Segmenter;
      const c = clusters(text);
      expect(c.map((x) => x.s)).toEqual(want);
      for (const { s, i0 } of c) expect(text.slice(i0, i0 + s.length)).toBe(s);
    } finally {
      I.Segmenter = saved;
    }
  });
});

// ---------- D3 2026-11-23: 동그라미 옆에 뜻 없는 짧은 호가 따로 그려졌다 ----------
describe('손그림 동그라미(circleMarkPoints)', () => {
  const e = { cx: 640, cy: 340, rx: 150, ry: 170 };
  /** 타원 반지름 1 기준 거리. */
  const rho = ([x, y]: [number, number]) => Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry);
  const angle = ([x, y]: [number, number]) => Math.atan2((y - e.cy) / e.ry, (x - e.cx) / e.rx);

  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('씨앗 %i: 한 바퀴 + 짧은 겹침(≤ 18°+기울기), 겹친 끝은 시작 선에서 선 굵기 안쪽', (seed) => {
    const ps = circleMarkPoints(e, seededRand(seed));
    // 지나온 각도 합(한 바퀴 넘게)
    const cum = [0];
    for (let i = 1; i < ps.length; i++) {
      let d = angle(ps[i]) - angle(ps[i - 1]);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      cum.push(cum[i - 1] + Math.abs(d));
    }
    const overDeg = (cum[cum.length - 1] * 180) / Math.PI - 360;
    expect(overDeg).toBeGreaterThanOrEqual(CIRCLE_OVER_DEG[0] - 3);
    expect(overDeg).toBeLessThanOrEqual(CIRCLE_OVER_DEG[1] + 3);
    // 한 바퀴를 넘은(겹친) 점은 모두 첫 바퀴 선에서 CIRCLE_TAIL_GAP(+흔들림) 안: 따로 그은 호로 보이지 않는다
    const seg = (q: [number, number], p0: [number, number], p1: [number, number]) => {
      const vx = p1[0] - p0[0], vy = p1[1] - p0[1];
      const t = Math.max(0, Math.min(1, ((q[0] - p0[0]) * vx + (q[1] - p0[1]) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(q[0] - p0[0] - t * vx, q[1] - p0[1] - t * vy);
    };
    const first = ps.filter((_, i) => cum[i] <= Math.PI);
    const over = ps.filter((_, i) => cum[i] > 2 * Math.PI);
    expect(over.length).toBeGreaterThanOrEqual(1);
    for (const q of over) {
      const d = Math.min(...first.slice(1).map((p, i) => seg(q, first[i], p)));
      expect(d).toBeLessThanOrEqual(CIRCLE_TAIL_GAP + 2);
    }
    // 모든 점이 CIRCLE_BAND 띠 안(이름표 피하기가 이 띠를 믿는다)
    for (const p of ps) {
      expect(rho(p)).toBeGreaterThanOrEqual(CIRCLE_BAND[0]);
      expect(rho(p)).toBeLessThanOrEqual(CIRCLE_BAND[1]);
    }
  });

  // QA2 2026-11-23: 아이패드 가로 스크린샷에서 동그라미 왼쪽 위에 짧은 흔적이 남았다 — 겹친 끝이 시작 선에서 5px 바깥으로
  // 벌어져(선 굵기 7.2의 70%) 겹친 곳만 굵은 짧은 선처럼 보였다. 겹친 끝은 선 굵기 절반 안에서 같은 선 위를 지나야 한다.
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('씨앗 %i: 겹친 끝은 시작 선에서 선 굵기 절반(3.6px) 안 — 따로 그은 짧은 선으로 보이지 않는다', (seed) => {
    const ps = circleMarkPoints(e, seededRand(seed));
    const cum = [0];
    for (let i = 1; i < ps.length; i++) {
      let d = angle(ps[i]) - angle(ps[i - 1]);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      cum.push(cum[i - 1] + Math.abs(d));
    }
    const seg = (q: [number, number], p0: [number, number], p1: [number, number]) => {
      const vx = p1[0] - p0[0], vy = p1[1] - p0[1];
      const t = Math.max(0, Math.min(1, ((q[0] - p0[0]) * vx + (q[1] - p0[1]) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(q[0] - p0[0] - t * vx, q[1] - p0[1] - t * vy);
    };
    const first = ps.filter((_, i) => cum[i] <= Math.PI);
    const dist = (q: [number, number]) => Math.min(...first.slice(1).map((p, i) => seg(q, first[i], p)));
    for (const q of ps.filter((_, i) => cum[i] > 2 * Math.PI)) expect(dist(q)).toBeLessThanOrEqual(STROKE_W / 2);
    // 끝점은 첫 바퀴 선 위로 돌아와 앉는다(끝이 바깥에 떠 있으면 둥근 끝이 원 밖으로 볼록 튀어 보였다)
    expect(dist(ps[ps.length - 1])).toBeLessThanOrEqual(1.2);
  });

  test('markPaths circle도 같은 한 획(경로 하나, NaN 없음)', () => {
    const ps = markPaths('circle', { x: 300, y: 40, w: 180, h: 70 }, seededRand(2));
    expect(ps).toHaveLength(1);
    expect(ps[0]).not.toContain('NaN');
    expect(circleMarkPath(circleAround({ x: 300, y: 40, w: 180, h: 70 }), seededRand(2))).toBe(ps[0]);
  });
});

test('arrowPath bowDown: 같은 두 칸을 아래로 휘어 잇는다(조절점이 선 아래)', () => {
  const up = (arrowPath(a, b)[0].match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const down = (arrowPath(a, b, true)[0].match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  expect(up[3]).toBeLessThan(50); // Q 조절점 y
  expect(down[3]).toBeGreaterThan(50);
  expect(down[0]).toBe(up[0]); expect(down[4]).toBe(up[4]); // 끝점은 같다
});

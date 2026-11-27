// C1·C3: 글꼴 역할·색 토큰은 styles.css :root에 한 번만 정의한다. 글자/바탕 짝마다 대비 4.5:1 이상(WCAG AA 본문 기준).
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
/** 첫 :root 블록(미디어 쿼리 밖)의 변수들. */
const root = (() => {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1];
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
})();

type Rgb = [number, number, number];
const hex = (v: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) throw new Error(`hex 색이 아님: ${v}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** 반투명 흰색을 바탕 위에 얹은 색. */
const over = (base: Rgb, alpha: number): Rgb => base.map((c) => c * (1 - alpha) + 255 * alpha) as Rgb;
const tok = (name: string): Rgb => {
  const v = root[name];
  expect(v, name).toBeTruthy();
  return hex(v);
};

describe('색 토큰(C3)', () => {
  test('역할 토큰이 모두 있다', () => {
    for (const n of [
      '--c-primary', '--c-on-primary', '--c-selected', '--c-on-selected', '--c-warn', '--c-on-warn',
      '--c-neutral', '--c-on-neutral', '--c-on-neutral-muted', '--c-surface', '--c-on-surface', '--c-placeholder',
      '--c-on-night', '--c-focus', '--night',
    ]) {
      expect(root[n], n).toBeTruthy();
    }
  });

  test('밤하늘 배경은 rgb(52,58,82) 그대로', () => {
    expect(tok('--night')).toEqual([52, 58, 82]);
  });

  test('주 행동·선택됨·경고는 서로 다른 색', () => {
    const cs = ['--c-primary', '--c-selected', '--c-warn', '--c-neutral'].map((n) => root[n].toLowerCase());
    expect(new Set(cs).size).toBe(cs.length);
  });

  // 대비 표(보고서에 옮긴다): 모두 4.5:1 이상
  const pairs: Array<[string, string, string]> = [
    ['물어보기·말로 물어볼래?', '--c-on-primary', '--c-primary'],
    ['고른 스위치·듣는 중', '--c-on-selected', '--c-selected'],
    ['연결 안 됨', '--c-on-warn', '--c-warn'],
    ['꺼짐·카드', '--c-on-neutral', '--c-neutral'],
    ['허락 필요(흐린 글자)', '--c-on-neutral-muted', '--c-neutral'],
    ['입력 글자', '--c-on-surface', '--c-surface'],
    ['입력 안내 글자', '--c-placeholder', '--c-surface'],
  ];
  for (const [what, fg, bg] of pairs) {
    test(`${what}: ${fg} / ${bg} ≥ 4.5`, () => {
      const r = contrast(tok(fg), tok(bg));
      console.log(`[대비] ${what} ${root[fg]} on ${root[bg]} = ${r.toFixed(2)}:1`);
      expect(r).toBeGreaterThanOrEqual(4.5);
    });
  }

  // QA 2026-11-23: 마이크를 여는 중(허락 창이 떠 있는 동안) 칩 전체를 opacity 0.65로 흐리게 해 글자 대비가 4.16:1이었다.
  test('여는 중 마이크 칩(흐린 모양)도 글자 대비 ≥ 4.5 — 흰 질문창 위에서 투명도까지 계산', () => {
    // 규칙 상자(미디어 쿼리 밖)를 선택자 글자 그대로 찾는다(공백·줄바꿈은 하나로)
    const block = (sel: string) => {
      for (const m of css.matchAll(/(?:^|[}\n])\s*([^{}@/]+?)\s*\{([^{}]*)\}/g))
        if (m[1].replace(/\s+/g, ' ').trim() === sel) return m[2];
      return '';
    };
    const pend = block('.mic-pill[data-pending]');
    const vars = block('.mic:has(.mic-pill[data-pending]), .mic-pill[data-pending]');
    expect(vars, '여는 중 색 규칙').toBeTruthy();
    const opacity = Number(/opacity:\s*([\d.]+)/.exec(pend)?.[1] ?? 1);
    const ref = (v: string) => tok(/var\((--[\w-]+)\)/.exec(v)![1]);
    const fg = ref(/--mic-fg:\s*([^;]+);/.exec(vars)![1]);
    const bg = ref(/--mic-bg:\s*([^;]+);/.exec(vars)![1]);
    const white: Rgb = [255, 255, 255];
    const blend = (c: Rgb): Rgb => c.map((v, i) => v * opacity + white[i] * (1 - opacity)) as Rgb;
    const r = contrast(blend(fg), blend(bg));
    console.log(`[대비] 여는 중 마이크 칩 = ${r.toFixed(2)}:1 (opacity ${opacity})`);
    expect(r).toBeGreaterThanOrEqual(4.5);
  });

  test('고르지 않은 스위치 글자 / 밤하늘 위 반투명 트랙 ≥ 4.5', () => {
    const track = over(tok('--night'), Number(root['--c-night-track-alpha']));
    const r = contrast(tok('--c-on-night'), track);
    console.log(`[대비] 고르지 않은 스위치 ${root['--c-on-night']} on track = ${r.toFixed(2)}:1`);
    expect(r).toBeGreaterThanOrEqual(4.5);
  });
});

describe('글꼴 역할(C1)', () => {
  test('칠판 글씨는 Hi Melody, 화면 글씨는 역할 변수 넷', () => {
    expect(root['--font-board']).toMatch(/^'Hi Melody'/);
    for (const n of ['--font-display', '--font-control', '--font-input']) expect(root[n], n).toBeTruthy();
  });

  test('글꼴 이름을 규칙에 직접 쓰지 않는다(:root·@font-face 밖)', () => {
    const body = css.replace(/:root\s*\{[\s\S]*?\n\}/, '').replace(/@font-face\s*\{[\s\S]*?\}/g, '');
    expect(body).not.toMatch(/'(Hi Melody|Jua|Pretendard|Patrick Hand)'/);
  });

  test('글꼴은 칠판 Hi Melody(영어 화면은 Patrick Hand) + 화면 Jua. 굵은 고딕(Pretendard) CDN은 뺀다', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) => /href="([^"]+)"/.exec(m[0])![1]);
    const external = sheets.filter((u) => /^https?:/.test(u));
    expect(external).toEqual(['https://fonts.googleapis.com/css2?family=Hi+Melody&family=Jua&family=Patrick+Hand&display=swap']);
  });
});

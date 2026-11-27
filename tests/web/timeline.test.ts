import { describe, test, expect } from 'vitest';
import { FIGURE_MS_PER_FILL, FIGURE_MS_PER_LINE, MAX_FIGURE_MS, MIN_FIGURE_MS, figureDrawMs, planDraws, speechLengthMs } from '../../src/web/player/timeline';
import type { SayTiming } from '../../src/shared/lesson';

const tm = (text: string, msPerChar = 100): SayTiming => ({ chars: [...text], startMs: [...text].map((_, i) => i * msPerChar), endMs: [...text].map((_, i) => (i + 1) * msPerChar) });

describe('timeline', () => {
  test('at 없는 판서는 말 길이를 weight 비율로 나눠 이어 그린다', () => {
    const p = planDraws('가나다라마바사아자차', tm('가나다라마바사아자차'), [{ weight: 1 }, { weight: 3 }]);
    expect(p).toEqual([{ startMs: 0, durationMs: 250 }, { startMs: 250, durationMs: 750 }]);
  });
  test('at 단어 위치에서 시작', () => {
    const t = '우리가 달을 보면'; expect(planDraws(t, tm(t), [{ at: '달', weight: 1 }])[0].startMs).toBe(400);
  });
  test('at이 두 번 나오면 첫 위치', () => {
    const t = '달 그리고 달'; expect(planDraws(t, tm(t), [{ at: '달', weight: 1 }])[0].startMs).toBe(0);
  });
  test('at을 못 찾으면 순서대로 그리기', () => {
    const t = '나무가 지나가'; expect(planDraws(t, tm(t), [{ at: '달', weight: 1 }])[0].startMs).toBe(0);
  });
  test('타이밍이 없으면 글자당 180ms', () => {
    expect(speechLengthMs('열글자짜리문장입니다', null)).toBe(1800);
    expect(planDraws('우리 달', null, [{ at: '달', weight: 1 }])[0].startMs).toBe(540);
  });
  test('길이는 250~2500ms', () => {
    const t = '가'.repeat(100);
    const p = planDraws(t, tm(t), [{ weight: 1 }, { weight: 1000 }]);
    expect(p[0].durationMs).toBe(250); expect(p[1].durationMs).toBe(2500);
  });
  test('빈 chars 타이밍은 null처럼 취급', () => {
    const empty: SayTiming = { chars: [], startMs: [], endMs: [] };
    expect(speechLengthMs('abcd', empty)).toBe(720);
    expect(planDraws('우리 달', empty, [{ at: '달', weight: 1 }])[0].startMs).toBe(540);
  });
  test('at 앞에 이모지(두 칸짜리 글자)가 있어도 그 낱말의 시각에 시작한다', () => {
    const t = '🌙 달이 떴다'; // 글자: 🌙, ' ', 달(2번째) …
    expect(planDraws(t, tm(t), [{ at: '달', weight: 1 }])[0].startMs).toBe(200);
    expect(planDraws(t, null, [{ at: '달', weight: 1 }])[0].startMs).toBe(2 * 180);
    // 정렬 글자가 여러 글자로 묶여 와도(예: 'ab') 이어 붙인 위치로 찾는다
    const grouped: SayTiming = { chars: ['ab', 'c', '달'], startMs: [0, 100, 200], endMs: [100, 200, 300] };
    expect(planDraws('abc달', grouped, [{ at: '달', weight: 1 }])[0].startMs).toBe(200);
  });
  test('fixedMs(그림) 판서는 말 길이와 상관없이 그 길이로 그리고, 뒤 순서 판서는 그만큼 밀린다', () => {
    const t = '가나다라마바사아자차'; // 1000ms
    const p = planDraws(t, tm(t), [{ weight: 3, fixedMs: 4000 }, { weight: 1 }, { at: '마', weight: 1, fixedMs: 2000 }]);
    // 글씨 길이는 예전처럼 몫(1000 × 1/4 → 최소 250), 시작은 그림이 끝난 4000ms
    expect(p).toEqual([{ startMs: 0, durationMs: 4000 }, { startMs: 4000, durationMs: 250 }, { startMs: 400, durationMs: 2000 }]);
  });
});

describe('figureDrawMs', () => {
  const fig = (strokes: (string | { d: string; fill?: boolean })[], labels = 0) =>
    ({ strokes, labels: Array.from({ length: labels }, () => ({ x: 0, y: 0, text: 'x' })) });
  test('선 하나(M 하나·글씨 하나)마다 FIGURE_MS_PER_LINE, 채우기는 FIGURE_MS_PER_FILL', () => {
    const f = fig([...Array(10).fill('M0 0 L1 1'), 'M0 0 L1 1 M2 2 L3 3', { d: 'M0 0 L9 9 Z', fill: true }], 1);
    expect(figureDrawMs(f)).toBe(13 * FIGURE_MS_PER_LINE + FIGURE_MS_PER_FILL);
  });
  test('채우기는 선보다 덜 센다', () => expect(FIGURE_MS_PER_FILL).toBeLessThan(FIGURE_MS_PER_LINE));
  test('상대 좌표(m)가 있으면 한 획', () => {
    expect(figureDrawMs(fig(Array(7).fill('M0 0 l1 1 m2 2 l1 1')))).toBe(7 * FIGURE_MS_PER_LINE);
  });
  test('최소 1.5초, 최대 7.5초', () => {
    expect(MIN_FIGURE_MS).toBe(1500); expect(MAX_FIGURE_MS).toBe(7500);
    expect(figureDrawMs(fig(['M0 0 L1 1']))).toBe(1500);
    expect(figureDrawMs(fig(Array(41).fill('M0 0 L1 1')))).toBe(7500);
  });
  test('데모 강아지(선 22 + 글씨 1 + 채우기 3)는 데모(6.5초) 근처 속도', () => {
    const f = fig([...Array(22).fill('M0 0 L1 1'), ...Array(3).fill({ d: 'M0 0 L9 9 Z', fill: true })], 1);
    expect(figureDrawMs(f)).toBeGreaterThanOrEqual(5500);
    expect(figureDrawMs(f)).toBeLessThanOrEqual(7000);
  });
});

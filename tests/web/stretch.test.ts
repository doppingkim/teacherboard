import { describe, expect, it } from 'vitest';
import { timeStretch } from '../../src/web/player/stretch';

const SR = 44100;
const sine = (hz: number, sec: number, amp = 0.5) => {
  const a = new Float32Array(Math.round(SR * sec));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return a;
};
/** 오르는 영점 통과 수 / 초 ≈ 주파수(음 높이). */
const pitchHz = (a: Float32Array, from = 0.1, to = 0.9) => {
  const s = Math.floor(a.length * from), e = Math.floor(a.length * to);
  let n = 0;
  for (let i = s + 1; i < e; i++) if (a[i - 1] < 0 && a[i] >= 0) n++;
  return n / ((e - s) / SR);
};
const rms = (a: Float32Array, from = 0.1, to = 0.9) => {
  const s = Math.floor(a.length * from), e = Math.floor(a.length * to);
  let sum = 0;
  for (let i = s; i < e; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / (e - s));
};

describe('timeStretch', () => {
  it('0.9배: 길이는 1/0.9배, 음 높이는 그대로', () => {
    const src = sine(220, 1);
    const out = timeStretch(src, SR, 0.9);
    expect(out.length).toBe(Math.round(src.length / 0.9));
    expect(Math.abs(pitchHz(out) - 220)).toBeLessThan(220 * 0.03);
  });

  it('크기도 그대로(겹쳐 붙인 자리에서 소리가 꺼지거나 커지지 않음)', () => {
    const src = sine(180, 1);
    const out = timeStretch(src, SR, 0.9);
    expect(rms(out) / rms(src)).toBeGreaterThan(0.9);
    expect(rms(out) / rms(src)).toBeLessThan(1.1);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(0.5 * 1.15);
  });

  it('빠르게(1.2배)도 된다', () => {
    const src = sine(300, 1);
    const out = timeStretch(src, SR, 1.2);
    expect(out.length).toBe(Math.round(src.length / 1.2));
    expect(Math.abs(pitchHz(out) - 300)).toBeLessThan(300 * 0.03);
  });

  it('1배·이상한 배율·이상한 샘플레이트면 받은 그대로', () => {
    const src = sine(220, 0.2);
    expect(timeStretch(src, SR, 1)).toBe(src);
    expect(timeStretch(src, SR, 0)).toBe(src);
    expect(timeStretch(src, SR, -1)).toBe(src);
    expect(timeStretch(src, SR, Number.NaN)).toBe(src);
    expect(timeStretch(src, SR, Infinity)).toBe(src);
    expect(timeStretch(src, 0, 0.9)).toBe(src);
  });

  it('아주 짧은 소리(한 조각보다 짧음)·빈 소리는 그대로', () => {
    const empty = new Float32Array(0);
    expect(timeStretch(empty, SR, 0.9)).toBe(empty);
    const tiny = sine(220, 0.01);
    expect(timeStretch(tiny, SR, 0.9)).toBe(tiny);
  });

  it('무음은 무음으로(NaN 없음)', () => {
    const out = timeStretch(new Float32Array(SR), SR, 0.9);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('10초 문장도 아이패드에서 버틸 만큼 빠르다', () => {
    const src = new Float32Array(SR * 10);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin(i * 0.031) * 0.3 + Math.sin(i * 0.0071) * 0.2;
    const t0 = performance.now();
    timeStretch(src, SR, 0.9);
    expect(performance.now() - t0).toBeLessThan(1500); // 이 PC 기준 넉넉하게(실제는 훨씬 짧음)
  });
});

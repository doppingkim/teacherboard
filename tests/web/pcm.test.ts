import { toPcm16k, rms, Framer } from '../../src/web/voice/pcm';

function signal(n: number): Float32Array {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(i * 0.01) * 0.8 + (i % 7) * 0.01;
  return s;
}

function runFramer(rate: number, total: number, chunk: number) {
  const sig = signal(total);
  const f = new Framer(rate);
  const frames: Int16Array[] = [];
  for (let o = 0; o < total; o += chunk) frames.push(...f.push(sig.subarray(o, Math.min(total, o + chunk))));
  const per = Math.round((320 * rate) / 16000);
  const ref: Int16Array[] = [];
  for (let o = 0; o + per <= total; o += per) ref.push(toPcm16k(sig.subarray(o, o + per), rate));
  return { frames, ref };
}

test('Framer 48k: 128샘플 조각을 이어 붙여도 샘플 유실 없음', () => {
  const { frames, ref } = runFramer(48000, 128 * 100, 128);
  expect(frames.length).toBe(Math.floor((128 * 100) / 960));
  expect(frames.every((f) => f.length === 320)).toBe(true);
  expect(frames).toEqual(ref);
});

test('Framer 44.1k: 프레임당 882샘플, 조각 경계에서 유실 없음', () => {
  const { frames, ref } = runFramer(44100, 128 * 100, 128);
  expect(frames.length).toBe(Math.floor((128 * 100) / 882));
  expect(frames.every((f) => f.length === 320)).toBe(true);
  expect(frames).toEqual(ref);
});

test('Framer: 조각 크기가 달라도 결과 동일', () => {
  const a = runFramer(48000, 9600, 128).frames;
  const b = runFramer(48000, 9600, 1000).frames;
  expect(a).toEqual(b);
});

test('48k → 16k 길이 1/3, 값 평균', () => {
  const input = new Float32Array(480).fill(0.5);
  const out = toPcm16k(input, 48000);
  expect(out.length).toBe(160);
  expect(Math.abs(out[0] - 16384)).toBeLessThanOrEqual(1);
  const ramp = toPcm16k(new Float32Array([0, 0.3, 0.6, -0.3, -0.6, 0]), 48000);
  expect(ramp.length).toBe(2);
  expect(Math.abs(ramp[0] - Math.round(0.3 * 32767))).toBeLessThanOrEqual(1);
  expect(Math.abs(ramp[1] + Math.round(0.3 * 32767))).toBeLessThanOrEqual(1);
});

test('16k 입력은 그대로 변환', () => {
  const out = toPcm16k(new Float32Array([0, 0.5, -0.5]), 16000);
  expect(out.length).toBe(3);
  expect(out[0]).toBe(0);
});

test('클리핑', () => {
  const out = toPcm16k(new Float32Array([2, -2, 1, -1]), 16000);
  expect(out[0]).toBe(32767);
  expect(out[1]).toBe(-32768);
  expect(out[2]).toBe(32767);
  expect(out[3]).toBe(-32768);
});

test('rms 무음 0, 꽉 찬 사인파≈0.707', () => {
  expect(rms(new Int16Array(320))).toBe(0);
  expect(rms(new Int16Array(0))).toBe(0);
  const sine = new Int16Array(1600);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.round(32767 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  expect(rms(sine)).toBeGreaterThan(0.7);
  expect(rms(sine)).toBeLessThan(0.715);
});

test.each([8000, 11025])('%iHz(16k보다 낮음)는 늘려서 16k로: 1초 → 약 16000샘플, 프레임은 약 320샘플', (rate) => {
  const f = new Framer(rate);
  const frames = f.push(new Float32Array(rate).fill(0.5));
  const total = frames.reduce((n, x) => n + x.length, 0);
  expect(Math.abs(total - 16000)).toBeLessThanOrEqual(400);
  expect(frames.every((x) => Math.abs(x.length - 320) <= 1)).toBe(true);
  expect(frames[0][100]).toBe(Math.round(0.5 * 32767));
});

test('8k → 16k는 사이 값을 이어 채운다', () => {
  const out = toPcm16k(new Float32Array([0, 0.5, 1, 0.5]), 8000);
  expect(out.length).toBe(8);
  expect(Array.from(out).slice(0, 5)).toEqual([0, 0.25, 0.5, 0.75, 1].map((v) => Math.round(v * 32767)));
});

/**
 * 말소리를 음 높이 그대로 늘이거나 줄인다(WSOLA: 파형이 가장 잘 이어지는 자리를 찾아 겹쳐 붙이기).
 * ElevenLabs의 speed 설정은 v4 Turbo에서 거의 듣지 않아서(0.9로 줘도 2~3%, 2026-11-23 실측) 브라우저에서 늘인다.
 * Web Audio의 playbackRate는 음 높이까지 바뀌므로(느리면 목소리가 굵어짐) 쓰지 않는다.
 */

/** 한 조각 30ms, 이어 붙일 자리는 ±10ms 안에서 찾는다(말소리에 흔히 쓰는 값). */
const FRAME_S = 0.03;
const SEEK_S = 0.01;
/** 이어짐 점수를 셀 때 몇 샘플마다 볼지(거친 찾기). 찾은 근처는 한 샘플씩 다시 본다. */
const CORR_STRIDE = 8;
const COARSE_STEP = 6;

/**
 * rate < 1이면 느리게(길이 1/rate배), rate > 1이면 빠르게. rate가 1이거나 이상한 값이면 받은 그대로 돌려준다.
 * 결과 길이는 round(입력 길이 / rate).
 */
export function timeStretch(input: Float32Array, sampleRate: number, rate: number): Float32Array {
  if (!Number.isFinite(rate) || rate <= 0 || Math.abs(rate - 1) < 1e-3) return input;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return input;
  const n = Math.max(2, Math.round(FRAME_S * sampleRate) & ~1);
  const hop = n / 2; // 내보내는 쪽 간격(반씩 겹침 — 한 창(Hann)이 겹쳐 더하면 1이 된다)
  const outLen = Math.round(input.length / rate);
  if (input.length < n || outLen < n) return input;
  const seek = Math.round(SEEK_S * sampleRate);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  const out = new Float32Array(outLen + n);
  const norm = new Float32Array(outLen + n);
  const at = (i: number) => (i >= 0 && i < input.length ? input[i] : 0);
  /** 앞 조각이 자연스럽게 이어졌을 자리(target)와 후보 자리(pos)의 닮은 정도. */
  const score = (target: number, pos: number, stride: number) => {
    let s = 0;
    for (let i = 0; i < n; i += stride) s += at(target + i) * at(pos + i);
    return s;
  };

  let prev = 0; // 앞 조각을 가져온 입력 위치
  for (let outPos = 0; outPos < outLen; outPos += hop) {
    const nominal = Math.round(outPos * rate);
    let best = nominal;
    if (outPos > 0) {
      const target = prev + hop;
      const lo = Math.max(0, nominal - seek);
      const hi = Math.min(input.length - 1, nominal + seek);
      let bestScore = -Infinity;
      for (let p = lo; p <= hi; p += COARSE_STEP) {
        const s = score(target, p, CORR_STRIDE);
        if (s > bestScore) [bestScore, best] = [s, p];
      }
      // 거친 찾기로 고른 자리 근처를 한 샘플씩 다시 본다(점수는 모두 촘촘하게 새로 센다).
      const c = best;
      bestScore = -Infinity;
      for (let p = Math.max(lo, c - COARSE_STEP + 1); p <= Math.min(hi, c + COARSE_STEP - 1); p++) {
        const s = score(target, p, 1);
        if (s > bestScore) [bestScore, best] = [s, p];
      }
    }
    for (let i = 0; i < n; i++) {
      out[outPos + i] += at(best + i) * win[i];
      norm[outPos + i] += win[i];
    }
    prev = best;
  }
  const result = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) result[i] = norm[i] > 1e-3 ? out[i] / norm[i] : out[i];
  return result;
}

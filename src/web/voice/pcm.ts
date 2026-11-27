export const TARGET_RATE = 16000;

/** Float32 [-1,1] → 16kHz PCM16. 구간 평균으로 다운샘플하고(16k보다 낮으면 선형 보간으로 늘린다) 범위를 넘으면 자른다. */
export function toPcm16k(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / TARGET_RATE;
  // 16k보다 낮은 장치(블루투스 헤드셋 8k 등)를 그대로 보내면 서버는 16k로 읽어 빨라진 소리를 받는다.
  const outLen = ratio === 1 ? input.length : ratio < 1 ? Math.round(input.length / ratio) : Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let v: number;
    if (ratio === 1) {
      v = input[i];
    } else if (ratio < 1) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const a = input[Math.min(j, input.length - 1)];
      const b = input[Math.min(j + 1, input.length - 1)];
      v = a + (b - a) * (pos - j);
    } else {
      const start = Math.round(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.round((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      v = sum / (end - start);
    }
    v = Math.max(-1, Math.min(1, v));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

/** 0..1 실효값(RMS). */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

/** 임의 길이의 Float32 조각을 모아 20ms(320샘플@16k) PCM16 프레임으로 잘라 낸다. 남은 샘플은 다음 호출로 이월. */
export class Framer {
  private readonly inputPerFrame: number;
  private buf: Float32Array;
  private len = 0;

  constructor(
    private readonly inputRate: number,
    frameSamples = 320,
  ) {
    this.inputPerFrame = Math.max(1, Math.round((frameSamples * inputRate) / TARGET_RATE));
    this.buf = new Float32Array(this.inputPerFrame * 4);
  }

  push(chunk: Float32Array): Int16Array[] {
    if (this.len + chunk.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;

    const frames: Int16Array[] = [];
    let offset = 0;
    while (this.len - offset >= this.inputPerFrame) {
      frames.push(toPcm16k(this.buf.subarray(offset, offset + this.inputPerFrame), this.inputRate));
      offset += this.inputPerFrame;
    }
    if (offset > 0) {
      this.buf.copyWithin(0, offset, this.len);
      this.len -= offset;
    }
    return frames;
  }
}

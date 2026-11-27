import type { Speech } from '../../shared/lesson';
import { timeStretch } from './stretch';

export interface AudioOut {
  /**
   * 끝까지 재생되거나 stop()/signal abort면 resolve. 재생 자체가 실패하면 reject.
   * rate: 빠르기(1 = 그대로, 0.9 = 느리게). 음 높이는 그대로 둔다. s.timing·durationMs는 이미 이 빠르기로 맞춘 값이어야 한다.
   */
  play(s: Speech, signal: AbortSignal, rate?: number): Promise<void>;
  stop(): void;
  /** 사용자 터치 핸들러 안에서 (await 전에) 불러야 한다. 이후 자동 재생이 허용된다. */
  unlock(): Promise<void>;
  /**
   * 누가 말을 시작하면 선생님 목소리를 줄인다. on이면 음량 DUCK_VOLUME, 아니면 1. 재생 여부와 상관없이 유지된다.
   * 음량을 못 바꾸는 브라우저(iOS Safari)에서는 on인 동안 음소거한다.
   */
  duck(on: boolean): void;
}

/** 덕킹 음량. 0.15 → 0.5(2026-11-22: 거의 안 들릴 만큼 줄어든다는 피드백. 말이 확인됐을 때만 줄이므로 살짝만). */
export const DUCK_VOLUME = 0.5;

/**
 * 목소리 크기 맞추기(라우드니스 정규화). "경" 목소리(v4 터보)는 말소리 RMS가 약 -21.5dBFS로, 예전 테오(-11dBFS)보다
 * 10dB쯤 작았다. 게다가 iOS는 마이크가 켜져 있으면 스피커 출력을 더 줄인다(2026-11-22 아이패드 실사용: "너무 작다").
 * 문장마다 말소리 RMS를 재서 TARGET_RMS_DB까지 올리고(최대 MAX_BOOST배), 뒤의 리미터가 찢어짐을 막는다.
 */
export const TARGET_RMS_DB = -14;
export const MAX_BOOST = 4;
/** 이 크기보다 작은 샘플은 말 사이 쉼으로 보고 RMS 계산에서 뺀다. */
const SILENCE = 0.003;

/** 말소리 RMS(dBFS)에서 곱할 음량. 이미 크면 1(줄이지는 않는다), 아무리 작아도 MAX_BOOST까지. */
export function boostFor(rmsDb: number): number {
  if (!Number.isFinite(rmsDb)) return 1;
  return Math.min(MAX_BOOST, Math.max(1, 10 ** ((TARGET_RMS_DB - rmsDb) / 20)));
}

/** 샘플들의 말소리 RMS(dBFS). 쉼(아주 작은 샘플)은 뺀다. */
export function speechRmsDb(samples: Float32Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (Math.abs(v) > SILENCE) {
      sum += v * v;
      n++;
    }
  }
  return n === 0 ? -Infinity : 10 * Math.log10(sum / n);
}

/** 'ended'가 끝내 오지 않는 브라우저(모바일 절전 등)를 위한 여유. */
const END_GRACE_MS = 2000;
/**
 * 멈춘 컨텍스트의 resume()을 기다리는 최대 시간. 터치 밖에서 깨울 수 없으면 resume()은 끝내 응답하지 않는다
 * (Web Audio 명세: 시작이 허용될 때까지 보류) — 그때는 기다리지 않고 <audio>로 튼다.
 */
export const RESUME_WAIT_MS = 400;

/** 50ms짜리 무음 WAV(8kHz·8비트·모노) data: URL. unlock용. */
function silentWav(): string {
  const n = 400;
  const bytes = new Uint8Array(44 + n);
  const v = new DataView(bytes.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + n, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  tag(36, 'data'); v.setUint32(40, n, true);
  bytes.fill(128, 44);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

type Chain = { ctx: AudioContext; input: AudioNode; duck: GainNode };

/** 리미터(찢어짐 방지) → 덕킹 음량 → 스피커. Web Audio가 없으면 null. */
function makeChain(): Chain | null {
  const w = typeof window === 'undefined' ? undefined : (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
  const AC = w?.AudioContext ?? w?.webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const duck = ctx.createGain();
    limiter.connect(duck);
    duck.connect(ctx.destination);
    return { ctx, input: limiter, duck };
  } catch {
    return null;
  }
}

/** base64 → ArrayBuffer */
function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * 소리 내보내기. 터치로 풀린 Web Audio가 돌고 있으면 그쪽으로(문장마다 크기 맞춤 + 리미터),
 * 아니면(지원 안 함·아직 안 풀림·풀었다 멈춤·디코딩 실패) 예전처럼 HTMLAudioElement로 그대로 튼다.
 */
/** HTMLAudioElement 하나를 재사용한다(iOS는 터치로 한 번 풀어 준 요소만 자동 재생을 허용). */
export function createAudioOut(): AudioOut {
  const el = new Audio();
  el.preload = 'auto';
  let current: (() => void) | null = null; // 지금 재생 중인 play()를 끝내는 함수
  let chain: Chain | null = null; // unlock(터치)에서 만든다
  /** iOS처럼 음량을 못 바꾸는 곳인가(덕킹을 하지 않는다, duck 참고). */
  let volumeIgnored = false;

  const stop = () => {
    const finish = current;
    current = null;
    finish?.();
    el.pause();
  };

  /** Web Audio로 틀기. 끝나거나 멈추면 'done'. 디코딩에 실패하면 null(예전 방식으로 넘긴다). */
  const playBuffer = async (c: Chain, s: Speech, signal: AbortSignal, rate: number): Promise<'done' | null> => {
    let buf: AudioBuffer;
    try {
      buf = await c.ctx.decodeAudioData(b64ToBuffer(s.audioBase64));
    } catch {
      return null;
    }
    if (signal.aborted) return 'done';
    const samples = buf.getChannelData(0);
    const gain = c.ctx.createGain();
    gain.gain.value = boostFor(speechRmsDb(samples));
    if (rate !== 1) {
      // 느리게(쉽게 단계): 음 높이 그대로 늘인 소리로 바꾼다. 목소리는 한 채널(mono)이다.
      const stretched = timeStretch(samples, buf.sampleRate, rate);
      if (stretched !== samples) {
        const b = c.ctx.createBuffer(1, stretched.length, buf.sampleRate);
        b.getChannelData(0).set(stretched);
        buf = b;
      }
    }
    gain.connect(c.input);
    const src = c.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    return new Promise<'done'>((resolve) => {
      let done = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (current === finish) current = null;
        clearTimeout(watchdog);
        signal.removeEventListener('abort', finish);
        src.onended = null;
        try {
          src.stop();
        } catch {
          // 이미 끝남
        }
        src.disconnect();
        gain.disconnect();
        resolve('done');
      };
      current = finish;
      src.onended = finish;
      signal.addEventListener('abort', finish, { once: true });
      src.start();
      watchdog = setTimeout(finish, buf.duration * 1000 + END_GRACE_MS);
    });
  };

  return {
    async play(s, signal, rate = 1) {
      const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
      // 이미 취소된 요청(예: 지난 수업의 늦은 호출)은 지금 재생 중인 소리를 건드리지 않는다.
      if (signal.aborted) return;
      stop();
      if (chain && chain.ctx.state !== 'running') {
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          chain.ctx.resume().catch(() => {}),
          new Promise<void>((r) => (t = setTimeout(r, RESUME_WAIT_MS))),
        ]);
        clearTimeout(t);
      }
      if (signal.aborted) return; // 기다리는 동안 새 질문 등으로 취소됐다
      if (chain && chain.ctx.state === 'running') {
        if ((await playBuffer(chain, s, signal, r)) === 'done') return;
        if (signal.aborted) return; // 디코딩 중 취소 + 디코딩 실패: 지난 문장을 <audio>로 틀지 않는다
      }
      return playElement(s, signal, r);
    },
    stop,
    duck(on) {
      el.volume = on ? DUCK_VOLUME : 1;
      if (on) volumeIgnored = el.volume > DUCK_VOLUME + 0.01;
      // iOS/iPadOS Safari는 volume을 무시한다(늘 1). 예전엔 대신 음소거했는데, 마이크가 스피커의 선생님 목소리를
      // 말로 잘못 알아들을 때마다 설명이 뚝뚝 끊겼다(2026-11-22 아이패드 실사용). 그래서 그런 곳에서는 줄이지 않는다.
      // 끼어든 질문이 확인되면 수업 자체를 멈추므로 끼어들기는 그대로 된다.
      el.muted = false;
      if (chain) chain.duck.gain.value = on && !volumeIgnored ? DUCK_VOLUME : 1;
    },
    unlock() {
      stop();
      // Web Audio도 터치 안에서 만들고 깨운다(iOS는 터치 밖에서 시작한 소리를 막는다).
      chain ??= makeChain();
      void chain?.ctx.resume().catch(() => {});
      el.src = silentWav();
      const p = el.play(); // 터치 핸들러 안에서 동기적으로 불려야 한다
      return p.then(
        () => { if (current === null) el.pause(); },
        () => {},
      );
    },
  };

  function playElement(s: Speech, signal: AbortSignal, rate: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const cleanup = () => {
          settled = true;
          el.removeEventListener('ended', onEnded);
          el.removeEventListener('error', onError);
          signal.removeEventListener('abort', onAbort);
          clearTimeout(watchdog);
          if (current === finish) current = null;
        };
        const finish = () => {
          if (settled) return;
          cleanup();
          resolve();
        };
        const fail = (err: unknown) => {
          if (settled) return;
          cleanup();
          el.pause();
          reject(err instanceof Error ? err : new Error('audio playback failed'));
        };
        const onEnded = () => finish();
        const onError = () => fail(new Error('audio decode failed'));
        const onAbort = () => {
          finish();
          el.pause();
        };
        current = finish;
        el.addEventListener('ended', onEnded);
        el.addEventListener('error', onError);
        signal.addEventListener('abort', onAbort, { once: true });
        el.src = `data:${s.mime};base64,${s.audioBase64}`;
        // 새 src를 넣으면 playbackRate가 defaultPlaybackRate로 돌아가므로 둘 다 맞춘다. 음 높이는 그대로(preservesPitch).
        const pe = el as HTMLAudioElement & { webkitPreservesPitch?: boolean };
        pe.preservesPitch = true;
        pe.webkitPreservesPitch = true;
        el.defaultPlaybackRate = rate;
        el.playbackRate = rate;
        el.play().then(
          () => {
            if (settled) return;
            // durationMs(정렬 끝)가 비었거나 짧게 와도 실제 길이(el.duration)보다 먼저 끊지 않는다.
            const known = Number.isFinite(s.durationMs) ? Math.max(0, s.durationMs) : 0;
            const real = Number.isFinite(el.duration) ? (el.duration * 1000) / rate : 0;
            watchdog = setTimeout(finish, Math.max(known, real) + END_GRACE_MS);
          },
          (err) => fail(err),
        );
    });
  }
}

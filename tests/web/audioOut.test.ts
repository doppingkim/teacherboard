import { afterEach, describe, test, expect, vi } from 'vitest';
import { createAudioOut, DUCK_VOLUME } from '../../src/web/player/audioOut';

class FakeAudioEl {
  static last: FakeAudioEl;
  volume = 1;
  muted = false;
  preload = '';
  src = '';
  constructor() {
    FakeAudioEl.last = this;
  }
  addEventListener() {}
  removeEventListener() {}
  pause() {}
  play() {
    return Promise.resolve();
  }
}

afterEach(() => vi.unstubAllGlobals());

test('duck(true)면 음량 0.5(살짝만), duck(false)면 1', () => {
  vi.stubGlobal('Audio', FakeAudioEl);
  const out = createAudioOut();
  expect(DUCK_VOLUME).toBe(0.5);
  out.duck(true);
  expect(FakeAudioEl.last.volume).toBe(0.5);
  out.duck(true);
  expect(FakeAudioEl.last.volume).toBe(0.5);
  expect(FakeAudioEl.last.muted).toBe(false);
  out.duck(false);
  expect(FakeAudioEl.last.volume).toBe(1);
  expect(FakeAudioEl.last.muted).toBe(false);
});

/** iOS Safari: volume을 바꿔도 늘 1로 남는다. */
class IosAudioEl {
  static last: IosAudioEl;
  muted = false;
  preload = '';
  src = '';
  constructor() {
    IosAudioEl.last = this;
  }
  get volume() {
    return 1;
  }
  set volume(_v: number) {}
  addEventListener() {}
  removeEventListener() {}
  pause() {}
  play() {
    return Promise.resolve();
  }
}

test('음량을 못 바꾸는 브라우저(iOS)에서는 음소거하지 않는다(선생님 목소리를 말로 착각해 끊기던 문제)', () => {
  vi.stubGlobal('Audio', IosAudioEl);
  const out = createAudioOut();
  out.duck(true);
  expect(IosAudioEl.last.muted).toBe(false);
  out.duck(false);
  expect(IosAudioEl.last.muted).toBe(false);
  expect(IosAudioEl.last.volume).toBe(1);
});

test('boostFor: 작은 목소리는 목표 크기(-14dBFS)까지, 큰 목소리는 그대로, 최대 4배', async () => {
  const { boostFor, TARGET_RMS_DB, MAX_BOOST } = await import('../../src/web/player/audioOut');
  expect(TARGET_RMS_DB).toBe(-14);
  expect(boostFor(-20)).toBeCloseTo(10 ** (6 / 20), 5); // 6dB 올림 ≈ 2배
  expect(boostFor(-10)).toBe(1); // 이미 크면 줄이지 않는다
  expect(boostFor(-40)).toBe(MAX_BOOST);
  expect(boostFor(-Infinity)).toBe(1); // 무음
  expect(boostFor(NaN)).toBe(1);
});

test('speechRmsDb: 쉼(아주 작은 샘플)은 빼고 말소리만 잰다', async () => {
  const { speechRmsDb } = await import('../../src/web/player/audioOut');
  const half = new Float32Array(200).fill(0.5);
  const withSilence = new Float32Array(400);
  withSilence.set(half, 0); // 뒤 절반은 0(쉼)
  expect(speechRmsDb(half)).toBeCloseTo(20 * Math.log10(0.5), 5);
  expect(speechRmsDb(withSilence)).toBeCloseTo(speechRmsDb(half), 5);
  expect(speechRmsDb(new Float32Array(10))).toBe(-Infinity);
});

// ---------- Web Audio 경로(가짜 AudioContext) ----------

/** 재생을 기록하는 가짜 <audio>. play()는 바로 resolve, ended는 시험이 직접 부른다. */
class RecAudioEl {
  static last: RecAudioEl;
  volume = 1;
  muted = false;
  preload = '';
  src = '';
  duration = NaN;
  played: string[] = [];
  paused = 0;
  private ls: Record<string, Set<() => void>> = {};
  constructor() {
    RecAudioEl.last = this;
  }
  addEventListener(t: string, f: () => void) {
    (this.ls[t] ??= new Set()).add(f);
  }
  removeEventListener(t: string, f: () => void) {
    this.ls[t]?.delete(f);
  }
  emit(t: string) {
    for (const f of [...(this.ls[t] ?? [])]) f();
  }
  pause() {
    this.paused++;
  }
  play() {
    this.played.push(this.src);
    return Promise.resolve();
  }
}

type CtxOpts = { state?: string; resume?: () => Promise<void>; decode?: () => Promise<unknown> };
function fakeWindow(o: CtxOpts) {
  const node = () => ({ connect() {}, disconnect() {} });
  const sources: { started: boolean; onended: (() => void) | null }[] = [];
  class Ctx {
    state = o.state ?? 'running';
    destination = {};
    createDynamicsCompressor() {
      const p = () => ({ value: 0 });
      return { ...node(), threshold: p(), knee: p(), ratio: p(), attack: p(), release: p() };
    }
    createGain() {
      return { ...node(), gain: { value: 1 } };
    }
    createBufferSource() {
      const s = { ...node(), buffer: null as unknown, started: false, onended: null as (() => void) | null, start() { s.started = true; }, stop() {} };
      sources.push(s);
      return s;
    }
    resume() {
      return o.resume ? o.resume() : Promise.resolve();
    }
    decodeAudioData() {
      return o.decode ? o.decode() : Promise.resolve({ duration: 1, getChannelData: () => new Float32Array(10).fill(0.1) });
    }
  }
  return { win: { AudioContext: Ctx }, sources };
}
const sp = (id: string, durationMs = 1000): import('../../src/shared/lesson').Speech => ({
  audioBase64: btoa(id), mime: 'audio/mpeg', durationMs, timing: { chars: ['a'], startMs: [0], endMs: [durationMs] },
});

describe('Web Audio·대체 재생 경계', () => {
  afterEach(() => vi.useRealTimers());

  test('멈춘 컨텍스트가 resume()에서 끝내 응답하지 않아도(자동 재생 정책) 수업이 멈추지 않고 <audio>로 넘긴다', async () => {
    vi.useFakeTimers();
    const { win } = fakeWindow({ state: 'suspended', resume: () => new Promise(() => {}) });
    vi.stubGlobal('window', win);
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    void out.unlock();
    let done = false;
    void out.play(sp('s1'), new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(RecAudioEl.last.played.some((s) => s.includes(btoa('s1')))).toBe(true);
    RecAudioEl.last.emit('ended');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  test('resume()을 기다리는 동안 취소되면(새 질문) 지난 문장을 <audio>로 틀지 않는다', async () => {
    let wake!: () => void;
    const { win } = fakeWindow({ state: 'suspended', resume: () => new Promise<void>((r) => (wake = r)) });
    vi.stubGlobal('window', win);
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    void out.unlock();
    const ac = new AbortController();
    const p = out.play(sp('old'), ac.signal);
    ac.abort();
    wake();
    await p;
    expect(RecAudioEl.last.played.some((s) => s.includes(btoa('old')))).toBe(false);
  });

  test('디코딩 중에 취소되고 디코딩도 실패하면 지난 문장을 <audio>로 틀지 않는다(새 수업 소리와 겹침)', async () => {
    let fail!: () => void;
    const { win } = fakeWindow({ decode: () => new Promise((_, rej) => (fail = () => rej(new Error('bad mp3')))) });
    vi.stubGlobal('window', win);
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    void out.unlock();
    const ac = new AbortController();
    const p = out.play(sp('old'), ac.signal);
    await Promise.resolve();
    ac.abort();
    fail();
    await p;
    expect(RecAudioEl.last.played.some((s) => s.includes(btoa('old')))).toBe(false);
  });

  test('디코딩에 실패하면 <audio>로 대신 튼다', async () => {
    const { win } = fakeWindow({ decode: () => Promise.reject(new Error('bad mp3')) });
    vi.stubGlobal('window', win);
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    void out.unlock();
    const p = out.play(sp('s1'), new AbortController().signal);
    await vi.waitFor(() => expect(RecAudioEl.last.played.some((s) => s.includes(btoa('s1')))).toBe(true));
    RecAudioEl.last.emit('ended');
    await p;
  });

  test('Web Audio에서 onended가 안 와도 길이 + 여유 뒤에 끝난다(watchdog)', async () => {
    vi.useFakeTimers();
    const { win, sources } = fakeWindow({});
    vi.stubGlobal('window', win);
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    void out.unlock();
    let done = false;
    void out.play(sp('s1'), new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(sources.at(-1)?.started).toBe(true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(true);
  });

  test('<audio>: durationMs가 0·NaN이어도 실제 길이(el.duration)보다 먼저 끊지 않는다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    let done = false;
    void out.play(sp('s1', 0), new AbortController().signal).then(() => (done = true));
    RecAudioEl.last.duration = 10; // 10초짜리 음성
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(false); // 예전: 2초(여유)만에 끊고 다음 문장으로
    await vi.advanceTimersByTimeAsync(8000);
    expect(done).toBe(true);
    const out2 = createAudioOut();
    let done2 = false;
    void out2.play(sp('s2', NaN), new AbortController().signal).then(() => (done2 = true));
    RecAudioEl.last.duration = 4;
    await vi.advanceTimersByTimeAsync(3000);
    expect(done2).toBe(false);
  });

  test('이미 취소된 신호면 <audio>도 건드리지 않는다', async () => {
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    const ac = new AbortController();
    ac.abort();
    await out.play(sp('x'), ac.signal);
    expect(RecAudioEl.last.played).toEqual([]);
  });
});

describe('빠르기(rate)', () => {
  afterEach(() => vi.useRealTimers());

  test('<audio>: rate 0.9면 0.9배로, 음 높이는 그대로(preservesPitch), 끝 감시는 늘어난 길이로', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    let done = false;
    void out.play(sp('s1', 0), new AbortController().signal, 0.9).then(() => (done = true));
    const el = RecAudioEl.last as RecAudioEl & { playbackRate?: number; defaultPlaybackRate?: number; preservesPitch?: boolean };
    expect(el.playbackRate).toBeCloseTo(0.9);
    expect(el.defaultPlaybackRate).toBeCloseTo(0.9);
    expect(el.preservesPitch).toBe(true);
    el.duration = 9; // 9초 소리를 0.9배로 → 10초
    await vi.advanceTimersByTimeAsync(11_500);
    expect(done).toBe(false); // 9초 + 여유 2초로 끊지 않는다
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(true);
  });

  test('<audio>: rate를 안 주면 1배', async () => {
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    void out.play(sp('s1'), new AbortController().signal);
    expect((RecAudioEl.last as RecAudioEl & { playbackRate?: number }).playbackRate).toBe(1);
  });

  test('Web Audio: rate 0.9면 늘인 소리(길이 1/0.9배)를 튼다, 1이면 받은 소리 그대로', async () => {
    const SR = 44100;
    const decoded = () => {
      const data = new Float32Array(SR);
      for (let i = 0; i < SR; i++) data[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / SR);
      return { duration: 1, sampleRate: SR, getChannelData: () => data };
    };
    const { win, sources } = fakeWindow({ decode: () => Promise.resolve(decoded()) });
    (win.AudioContext.prototype as unknown as { createBuffer: unknown }).createBuffer = (_ch: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    };
    vi.stubGlobal('window', win);
    vi.stubGlobal('Audio', RecAudioEl);
    const out = createAudioOut();
    void out.unlock();
    void out.play(sp('s1'), new AbortController().signal, 0.9);
    await new Promise((r) => setTimeout(r, 0));
    const slow = sources.at(-1) as unknown as { buffer: { length: number; getChannelData(): Float32Array } };
    expect(slow.buffer.length).toBe(Math.round(SR / 0.9));
    expect(slow.buffer.getChannelData().some((v) => v !== 0)).toBe(true);
    void out.play(sp('s2'), new AbortController().signal, 1);
    await new Promise((r) => setTimeout(r, 0));
    const same = sources.at(-1) as unknown as { buffer: { length?: number; duration: number } };
    expect(same.buffer.length).toBeUndefined(); // 디코딩한 그대로(새로 만들지 않음)
  });
});

import { Framer, rms } from './pcm';
import { pick } from '../i18n';

export type MicDevice = { deviceId: string; label: string };
export type Mic = {
  onFrame(cb: (f: Int16Array) => void): void;
  /** 장치가 뽑히는 등 입력 트랙이 끝나면 호출된다. */
  onEnded(cb: () => void): void;
  /** 오디오 컨텍스트가 멈췄다(suspended·interrupted — 전화·다른 앱·화면 꺼짐 등). 깨우기는 부른 쪽이 resume()으로. */
  onSuspended(cb: () => void): void;
  /** 멈춘 컨텍스트를 깨워 본다. timeoutMs 안에 running이 되면 true(이미 running이어도 true). */
  resume(timeoutMs?: number): Promise<boolean>;
  level(): number;
  close(): void;
  deviceId: string;
};

export class MicError extends Error {
  constructor(
    /** insecure: 안전하지 않은 주소(http + LAN IP 등)라 브라우저에 마이크 기능(mediaDevices)이 아예 없다. */
    public kind: 'denied' | 'nodevice' | 'insecure' | 'other',
    msg: string,
  ) {
    super(msg);
    this.name = 'MicError';
  }
}

/** openMic에서 컨텍스트를 깨우는 데 기다리는 최대 시간. 넘으면 MicError('other')(트랙도 멈춘다). */
export const OPEN_RESUME_TIMEOUT_MS = 3000;
/** 열린 뒤 멈춘 컨텍스트를 깨울 때 기본으로 기다리는 시간. */
const RESUME_TIMEOUT_MS = 1000;

/** p가 ms 안에 끝나면 true, 아니면 false(p의 실패도 false). */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((ok) => {
    const t = setTimeout(() => ok(false), ms);
    p.then(
      () => {
        clearTimeout(t);
        ok(true);
      },
      () => {
        clearTimeout(t);
        ok(false);
      },
    );
  });
}

/** Safari의 'interrupted'까지 포함한 '멈춤' 상태. */
const isSuspendedState = (st: string) => st === 'suspended' || st === 'interrupted';

function toMicError(e: unknown): MicError {
  if (e instanceof MicError) return e;
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e);
  // NotSupportedError: 허락 창을 띄울 수 없는 브라우저(헤드리스 등) — 허락을 못 받은 것과 같다.
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotSupportedError') return new MicError('denied', msg);
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new MicError('nodevice', msg);
  return new MicError('other', msg);
}

export async function openMic(deviceId?: string): Promise<Mic> {
  // 안전하지 않은 주소(http + LAN IP)나 마이크를 모르는 브라우저에는 mediaDevices가 없다.
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError('insecure', 'getUserMedia unavailable');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    throw toMicError(e);
  }

  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  const closeAll = () => {
    node?.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void context?.close().catch(() => {});
  };

  try {
    context = new AudioContext();
    // 권한 창을 기다린 뒤 만든 컨텍스트는 suspended일 수 있다(Safari). 깨우지 않으면 프레임이 안 온다.
    // 터치 밖에서 다시 열 때(모바일) resume이 끝나지 않을 수 있어 시간을 정해 둔다.
    if (!(await settlesWithin(context.resume(), OPEN_RESUME_TIMEOUT_MS))) throw new MicError('other', 'AudioContext resume timed out');
    await context.audioWorklet.addModule('/voice-worklet.js');
    const source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    // 일부 브라우저는 목적지에 이어지지 않은 노드를 돌리지 않는다. 무음 게인으로 이어 마이크 소리가 새지 않게 한다.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute).connect(context.destination);
  } catch (e) {
    closeAll();
    throw toMicError(e);
  }

  const framer = new Framer(context.sampleRate);
  const frameCbs: Array<(f: Int16Array) => void> = [];
  const endedCbs: Array<() => void> = [];
  const suspendedCbs: Array<() => void> = [];
  let lastLevel = 0;
  let closed = false;

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (closed) return;
    for (const frame of framer.push(ev.data)) {
      lastLevel = rms(frame);
      for (const cb of frameCbs) {
        try {
          cb(frame);
        } catch (err) {
          console.error('mic frame callback failed', err);
        }
      }
    }
  };

  const track = stream.getAudioTracks()[0];
  track?.addEventListener('ended', () => {
    if (closed) return;
    for (const cb of endedCbs) {
      try {
        cb();
      } catch (err) {
        console.error('mic ended callback failed', err);
      }
    }
  });

  const ctx = context;
  ctx.addEventListener('statechange', () => {
    if (closed || !isSuspendedState(ctx.state as string)) return;
    for (const cb of suspendedCbs) {
      try {
        cb();
      } catch (err) {
        console.error('mic suspended callback failed', err);
      }
    }
  });

  return {
    deviceId: track?.getSettings().deviceId ?? deviceId ?? '',
    onFrame(cb) {
      frameCbs.push(cb);
    },
    onEnded(cb) {
      endedCbs.push(cb);
    },
    onSuspended(cb) {
      suspendedCbs.push(cb);
    },
    async resume(timeoutMs = RESUME_TIMEOUT_MS) {
      if (closed) return false;
      if (ctx.state === 'running') return true;
      await settlesWithin(ctx.resume(), timeoutMs);
      return !closed && (ctx.state as string) === 'running'; // await 뒤에는 상태가 바뀌었을 수 있다
    },
    level: () => lastLevel,
    close() {
      if (closed) return;
      closed = true;
      frameCbs.length = 0;
      endedCbs.length = 0;
      suspendedCbs.length = 0;
      if (node) node.port.onmessage = null;
      closeAll();
    },
  };
}

export async function listMics(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || pick(`마이크 ${i + 1}`, `Microphone ${i + 1}`) }));
}

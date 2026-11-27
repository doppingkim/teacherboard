import WebSocket from 'ws';

export const SCRIBE_URL =
  'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=ko&audio_format=pcm_16000&commit_strategy=manual';

/** 언어별 Scribe 주소(받아쓰기 언어만 다르다). */
export const scribeUrl = (lang: 'ko' | 'en' = 'ko'): string =>
  lang === 'ko' ? SCRIBE_URL : SCRIBE_URL.replace('language_code=ko', `language_code=${lang}`);

const SAMPLE_RATE = 16000;
/** 1초 분량(16kHz, 16bit, mono). 이보다 큰 덩어리는 나눠 보낸다. */
const MAX_CHUNK = 32000;
/** keepAlive용 100ms 무음. */
const SILENCE_BYTES = 3200;
/**
 * 열리기 전(핸드셰이크 대기 중) 쌓아 둘 소리의 최대 바이트(약 10초).
 * 넘치면 가장 오래된 소리부터 버린다. 지금 하는 말이 더 중요하고, 연결을 끊는 것보다 덜 거슬리기 때문.
 */
export const PENDING_AUDIO_LIMIT = 320_000;
/** 이 안에 열리지 않으면(핸드셰이크가 멈춤) 오류로 본다. ws에는 기본 시간 한도가 없어 그대로 두면 소리만 쌓이고 아무 알림도 없다. */
export const CONNECT_TIMEOUT_MS = 10_000;

export interface WsLike {
  readyState: number; // 1 = OPEN
  send(data: string): void;
  close(): void;
  on(ev: 'open' | 'close', fn: () => void): void;
  on(ev: 'message', fn: (data: string | Buffer) => void): void;
  on(ev: 'error', fn: (err: Error) => void): void;
}

export type Connect = (url: string, headers: Record<string, string>) => WsLike;

const defaultConnect: Connect = (url, headers) => new WebSocket(url, { headers }) as unknown as WsLike;

/** 주의: `.message`는 업스트림(ElevenLabs)이 준 문구다. 브라우저로 그대로 보내면 안 된다(고정 문구만). */
export class SttError extends Error {
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export type SttEvents = {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(e: SttError): void;
  onClose(): void;
  /** 치명적이지 않은 업스트림 알림(commit_throttled, *warning*). 세션은 그대로 쓴다. */
  onWarning?(e: SttError): void;
};

/** 세션을 끝내지 않는 업스트림 메시지 종류. */
const isWarning = (type: string): boolean => type === 'commit_throttled' || type.includes('warning');

type Queued = { audio: Uint8Array } | { commit: true };

/** ElevenLabs Scribe v2 Realtime 한 세션. 소리는 16kHz 16bit mono PCM. */
export class ScribeSession {
  private ws: WsLike | null = null;
  private queue: Queued[] = []; // 열리기 전 들어온 소리·commit을 순서대로
  private queuedBytes = 0; // queue 안 소리 바이트 합(PENDING_AUDIO_LIMIT 이하)
  private open = false;
  private closed = false;
  private dirty = false; // 지난 commit 뒤 받은 소리가 있는가
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private opts: { apiKey: string; connect?: Connect; lang?: 'ko' | 'en' }) {}

  start(ev: SttEvents): void {
    const ws = (this.opts.connect ?? defaultConnect)(scribeUrl(this.opts.lang), { 'xi-api-key': this.opts.apiKey });
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.closed || this.open) return;
      ev.onError(new SttError('timeout', `not open after ${CONNECT_TIMEOUT_MS}ms`));
      this.close();
    }, CONNECT_TIMEOUT_MS);
    ws.on('open', () => {
      if (this.closed) return;
      clearTimeout(this.connectTimer);
      this.open = true;
      const queued = this.queue;
      this.queue = [];
      this.queuedBytes = 0;
      for (const q of queued) {
        if ('audio' in q) this.writeAudio(q.audio);
        else this.writeCommit();
      }
    });
    ws.on('message', (data) => {
      if (this.closed) return;
      let m: any;
      try {
        m = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        return;
      }
      const type = m?.message_type;
      if (type === 'partial_transcript') ev.onPartial(String(m.text ?? ''));
      else if (type === 'committed_transcript') ev.onFinal(String(m.text ?? ''));
      else if (type === 'session_started') return;
      else if (typeof type === 'string') {
        const detail = m.error ?? m.message;
        if (detail === undefined) return;
        // commit_throttled(확정 요청이 너무 잦음)와 경고는 세션이 계속 살아 있다 → 알리기만 한다.
        if (isWarning(type)) ev.onWarning?.(new SttError(type, String(detail)));
        else ev.onError(new SttError(type, String(detail)));
      }
    });
    ws.on('error', (err) => {
      if (this.closed) return;
      ev.onError(new SttError('socket', err.message));
    });
    ws.on('close', () => {
      if (this.closed) return;
      clearTimeout(this.connectTimer);
      this.closed = true;
      this.open = false;
      this.queue = [];
      this.queuedBytes = 0;
      ev.onClose();
    });
  }

  sendAudio(pcm16: Uint8Array): void {
    if (!this.ws || this.closed || pcm16.length === 0) return;
    this.dirty = true;
    if (!this.open) this.enqueueAudio(pcm16);
    else this.writeAudio(pcm16);
  }

  /** 열리기 전 소리를 쌓되 PENDING_AUDIO_LIMIT를 넘으면 가장 오래된 소리부터 버린다. */
  private enqueueAudio(pcm16: Uint8Array): void {
    // 한 덩어리가 한도보다 크면 뒤쪽(최근)만 남긴다. 짝수로 맞춰 PCM16 정렬을 지킨다.
    if (pcm16.length > PENDING_AUDIO_LIMIT) pcm16 = pcm16.subarray(pcm16.length - (PENDING_AUDIO_LIMIT & ~1));
    this.queue.push({ audio: pcm16 });
    this.queuedBytes += pcm16.length;
    while (this.queuedBytes > PENDING_AUDIO_LIMIT) {
      const i = this.queue.findIndex((q) => 'audio' in q);
      const [dropped] = this.queue.splice(i, 1) as [{ audio: Uint8Array }];
      this.queuedBytes -= dropped.audio.length;
      // commit 표시는 순서대로 지킨다. 단, 앞의 소리를 모두 잃어 맨 앞에 남은 commit은
      // 확정할 것이 없는 빈 commit이라 함께 버린다.
      while (this.queue.length > 0 && !('audio' in this.queue[0])) this.queue.shift();
    }
  }

  commit(): void {
    if (!this.ws || this.closed || !this.dirty) return;
    this.dirty = false;
    if (!this.open) this.queue.push({ commit: true });
    else this.writeCommit();
  }

  keepAlive(): void {
    if (!this.canSend()) return;
    this.sendChunk(new Uint8Array(SILENCE_BYTES), false);
  }

  close(): void {
    clearTimeout(this.connectTimer);
    this.closed = true;
    this.open = false;
    this.queue = [];
    this.queuedBytes = 0;
    this.ws?.close(); // 이미 닫힌 소켓에 불러도 무해
  }

  private canSend(): boolean {
    return !!this.ws && this.open && !this.closed && this.ws.readyState === 1;
  }

  private writeAudio(pcm16: Uint8Array): void {
    if (!this.canSend()) return;
    for (let i = 0; i < pcm16.length; i += MAX_CHUNK) {
      this.sendChunk(pcm16.subarray(i, i + MAX_CHUNK), false);
    }
  }

  private writeCommit(): void {
    if (!this.canSend()) return;
    this.sendChunk(new Uint8Array(0), true);
  }

  private sendChunk(buf: Uint8Array, commit: boolean): void {
    this.ws!.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(buf).toString('base64'),
        commit,
        sample_rate: SAMPLE_RATE,
      }),
    );
  }
}

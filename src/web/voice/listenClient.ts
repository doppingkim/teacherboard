// /api/listen 웹소켓 클라이언트. DOM에 기대지 않는다(소켓은 주입 가능).
//
// 프로토콜(서버 app.ts registerListen)
// - 브라우저 → 서버: 바이너리 = PCM16LE 16kHz mono, JSON {type:'end'} / {type:'state', lessonActive, recentSpoken} / {type:'ping'}
// - 서버 → 브라우저: {type:'ready'} / {type:'partial', text} / {type:'utterance', text, accept, question} / {type:'error', message}
//   STT가 실패하면 서버는 error를 보내고 1011로 닫는다 → 여기서는 닫힘을 재연결 사유로 본다.
//
// 규칙
// - 서버가 ready를 보내기 전·끊긴 동안의 소리와 end는 버린다(쌓아 두었다가 한꺼번에 보내지 않음).
// - ready가 되면 마지막 state를 다시 보낸다(재연결 뒤에도 서버가 수업 문맥을 안다).
// - 우리가 close()하지 않았는데 닫히면 'error'를 알리고 backoffMs 순서(끝은 마지막 값 반복)로 다시 연다.
//   간격은 ready로 가장 긴 재연결 간격(기본 5초) 넘게 버틴 연결이 끊겼을 때만 처음부터 — 서버는 Scribe가 받아들이기
//   전에 ready를 보내므로, 인증 실패처럼 ready 직후 1011로 닫히기를 되풀이하면 간격은 계속 늘어난다.
//   LONG_AFTER번 연달아 실패하면(서버가 꺼졌거나 망이 없음) 간격을 longBackoffMs(기본 15초·30초·60초, 끝은 반복)로 늘린다.
//   서버는 브라우저가 45초 동안 아무것도 안 보내면 1001로 닫는다 → 이것도 끊김으로 보고 다시 연다.
// - 1008(origin·profile 거절)은 다시 해도 똑같으니 'error'로 멈춘다(connect()를 다시 부르면 다시 시도).
// - 열린 뒤 readyTimeoutMs 안에 ready가 안 오면 끊김으로 본다.

export type ListenStatus = 'connecting' | 'ready' | 'error' | 'closed';
/** miss(E7): 받아 적은 글이 있는데 질문이 아니라고 거절했다(빈 받아쓰기·감탄사·에코·이어 붙이기는 아님). */
export type ListenUtterance = { text: string; accept: boolean; question: string; miss?: boolean };

/** 브라우저 WebSocket 중 이 클라이언트가 쓰는 부분. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: never) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: never) => void) | null;
}

const OPEN = 1;
const DEFAULT_PING_MS = 10_000;
const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];
const DEFAULT_READY_TIMEOUT_MS = 10_000;
/** 이만큼 연달아 실패한 뒤에는 긴 간격을 쓴다. */
const LONG_AFTER = 6;
const DEFAULT_LONG_BACKOFF_MS = [15_000, 30_000, 60_000];
/** 서버가 받지 않는 연결(origin·profile 거절). 다시 해도 똑같다. */
const CLOSE_POLICY = 1008;

type Timer = ReturnType<typeof setTimeout>;

export class ListenClient {
  onStatus?: (s: ListenStatus) => void;
  onPartial?: (text: string) => void;
  onUtterance?: (u: ListenUtterance) => void;

  private readonly url: string;
  private readonly makeSocket: (url: string) => WebSocketLike;
  private readonly pingMs: number;
  private readonly backoffMs: number[];
  private readonly longBackoffMs: number[];
  private readonly readyTimeoutMs: number;
  /** ready로 이만큼 버틴 연결이 끊겨야 재연결 간격을 처음부터 다시 센다. */
  private readonly stableMs: number;

  private ws: WebSocketLike | null = null;
  private ready = false;
  private stopped = true; // connect() 전이거나 close() 뒤
  private attempt = 0;
  private readyAt = 0;
  private current: ListenStatus = 'closed';
  private retryTimer: Timer | null = null;
  private readyTimer: Timer | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private state: { lessonActive: boolean; recentSpoken: string[] } | null = null;

  constructor(opts: {
    url: string;
    makeSocket?: (url: string) => WebSocketLike;
    pingMs?: number;
    backoffMs?: number[];
    /** LONG_AFTER번 연달아 실패한 뒤 쓸 간격. 빈 배열이면 늘리지 않는다. */
    longBackoffMs?: number[];
    readyTimeoutMs?: number;
  }) {
    this.url = opts.url;
    this.makeSocket = opts.makeSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.pingMs = opts.pingMs ?? DEFAULT_PING_MS;
    this.backoffMs = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
    this.longBackoffMs = opts.longBackoffMs ?? DEFAULT_LONG_BACKOFF_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stableMs = Math.max(...this.backoffMs);
  }

  /** 마지막으로 알린 상태. 처음과 close() 뒤에는 'closed'. */
  get status(): ListenStatus {
    return this.current;
  }

  /** 연결을 시작한다. 이미 연결 중이면 아무것도 안 한다. */
  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** 연결을 끊고 다시 연결하지 않는다. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) {
      detach(ws);
      try {
        ws.close(1000, 'client');
      } catch {
        // 이미 닫힘
      }
    }
    this.emit('closed');
  }

  /** PCM16 한 덩어리. ready가 아니면 버린다. 버퍼의 해당 부분 바이트만 정확히 보낸다. */
  sendPcm(pcm: Int16Array): void {
    if (!this.canSend() || pcm.length === 0) return;
    this.ws!.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
  }

  /** 지금 말이 끝났다(서버가 STT를 확정한다). ready가 아니면 버린다. */
  end(): void {
    this.sendJson({ type: 'end' });
  }

  /** 수업 상태. 마지막 값을 기억했다가 ready가 될 때마다 다시 보낸다. */
  setState(lessonActive: boolean, recentSpoken: string[]): void {
    this.state = { lessonActive, recentSpoken: [...recentSpoken] };
    this.sendJson({ type: 'state', ...this.state });
  }

  private canSend(): boolean {
    return this.ready && this.ws !== null && this.ws.readyState === OPEN;
  }

  private sendJson(m: unknown): void {
    if (!this.canSend()) return;
    this.ws!.send(JSON.stringify(m));
  }

  private emit(s: ListenStatus): void {
    this.current = s;
    safe(() => this.onStatus?.(s));
  }

  private open(): void {
    this.retryTimer = null;
    if (this.stopped) return;
    this.ready = false;
    this.emit('connecting');
    let ws: WebSocketLike;
    try {
      ws = this.makeSocket(this.url);
    } catch {
      this.ws = null;
      this.lost();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.receive(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.lost(ev?.code === CLOSE_POLICY);
    };
    ws.onerror = () => {
      // 보통 close가 뒤따른다. 안 와도 재연결하도록 직접 닫고 끊김으로 처리한다.
      if (this.ws !== ws) return;
      this.drop(ws);
    };
    // 열리지 않거나 열려도 서버가 ready를 안 보내면 끊김으로 본다.
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.ws === ws && !this.ready) this.drop(ws);
    }, this.readyTimeoutMs);
  }

  /** 우리 쪽에서 소켓을 버린다: 닫고 끊김으로 처리. */
  private drop(ws: WebSocketLike): void {
    detach(ws);
    try {
      ws.close();
    } catch {
      // 무시
    }
    this.lost();
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let m: unknown;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof m !== 'object' || m === null) return;
    const msg = m as Record<string, unknown>;
    switch (msg.type) {
      case 'ready':
        if (this.ready) return;
        this.ready = true;
        this.readyAt = Date.now();
        if (this.readyTimer !== null) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        if (this.state) this.sendJson({ type: 'state', ...this.state });
        this.startPing();
        this.emit('ready');
        return;
      case 'partial':
        if (typeof msg.text === 'string') {
          const text = msg.text;
          safe(() => this.onPartial?.(text));
        }
        return;
      case 'utterance':
        if (typeof msg.text === 'string' && typeof msg.accept === 'boolean' && typeof msg.question === 'string') {
          const u: ListenUtterance = { text: msg.text, accept: msg.accept, question: msg.question };
          if (msg.miss === true) u.miss = true;
          safe(() => this.onUtterance?.(u));
        }
        return;
      // 'error': 서버가 곧 1011로 닫는다 → onclose에서 재연결.
    }
  }

  /** 이 소켓은 끝났다: error를 알리고 다음 간격 뒤에 다시 연다(terminal이면 멈춘다). 한 소켓에 한 번만. */
  private lost(terminal = false): void {
    const ws = this.ws;
    if (ws) detach(ws);
    // 충분히 오래 ready였던 연결만 "잘 되던 연결"로 보고 간격을 처음부터 다시 센다.
    if (this.ready && Date.now() - this.readyAt >= this.stableMs) this.attempt = 0;
    this.ws = null;
    this.ready = false;
    this.clearTimers();
    if (this.stopped) return;
    if (terminal) {
      this.stopped = true;
      this.emit('error');
      return;
    }
    this.emit('error');
    const delay = this.delayFor(this.attempt);
    this.attempt++;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  /** n번째(0부터) 연달은 재시도까지 기다릴 시간. */
  private delayFor(n: number): number {
    const long = this.longBackoffMs;
    if (n >= LONG_AFTER && long.length > 0) return long[Math.min(n - LONG_AFTER, long.length - 1)];
    return this.backoffMs[Math.min(n, this.backoffMs.length - 1)];
  }

  private startPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.sendJson({ type: 'ping' }), this.pingMs);
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.readyTimer = null;
  }
}

/** 바깥 콜백의 문제로 연결 관리를 멈추지 않는다. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // 무시
  }
}

/** 예전 소켓의 늦은 이벤트가 새 연결을 건드리지 않게 핸들러를 뗀다. */
function detach(ws: WebSocketLike): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
}

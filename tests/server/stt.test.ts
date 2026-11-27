import { CONNECT_TIMEOUT_MS, PENDING_AUDIO_LIMIT, ScribeSession, SttError, SCRIBE_URL, type WsLike } from '../../src/server/stt';

type Handlers = Record<string, (...a: any[]) => void>;

function fake() {
  const handlers: Handlers = {};
  const sent: any[] = [];
  const ws: WsLike & { closed: boolean } = {
    readyState: 0,
    closed: false,
    send: (d: string) => void sent.push(JSON.parse(d)),
    close() {
      this.closed = true;
    },
    on: ((ev: string, fn: any) => void (handlers[ev] = fn)) as any,
  };
  const connect = vi.fn((_u: string, _h: Record<string, string>) => ws);
  const open = () => {
    ws.readyState = 1;
    handlers.open();
  };
  const msg = (o: object) => handlers.message(JSON.stringify(o));
  return { ws, sent, connect, open, msg, handlers };
}

const evs = () => ({ onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onClose: vi.fn() });
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

test('URL·헤더', () => {
  const f = fake();
  new ScribeSession({ apiKey: 'k', connect: f.connect }).start(evs());
  expect(f.connect).toHaveBeenCalledWith(SCRIBE_URL, { 'xi-api-key': 'k' });
  expect(SCRIBE_URL).toBe(
    'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=ko&audio_format=pcm_16000&commit_strategy=manual',
  );
});

test('열리기 전 소리는 쌓였다가 열리면 base64 input_audio_chunk로', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  const pcm = new Uint8Array([1, 2, 3, 4]);
  s.sendAudio(pcm);
  expect(f.sent).toEqual([]);
  f.open();
  expect(f.sent).toEqual([
    { message_type: 'input_audio_chunk', audio_base_64: b64(pcm), commit: false, sample_rate: 16000 },
  ]);
});

test('32000바이트 넘으면 나눠 보낸다', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  f.open();
  s.sendAudio(new Uint8Array(40000));
  expect(f.sent.map((m) => Buffer.from(m.audio_base_64, 'base64').length)).toEqual([32000, 8000]);
});

test('commit은 소리를 보낸 뒤에만', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  f.open();
  s.commit();
  expect(f.sent).toEqual([]);
  s.sendAudio(new Uint8Array(2));
  s.commit();
  expect(f.sent[1]).toEqual({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 });
  s.commit();
  expect(f.sent).toHaveLength(2);
});

test('partial/committed → 콜백', () => {
  const f = fake();
  const e = evs();
  new ScribeSession({ apiKey: 'k', connect: f.connect }).start(e);
  f.open();
  f.msg({ message_type: 'session_started' });
  f.msg({ message_type: 'partial_transcript', text: '달' });
  f.msg({ message_type: 'committed_transcript', text: '달은 왜?' });
  expect(e.onPartial).toHaveBeenCalledWith('달');
  expect(e.onFinal).toHaveBeenCalledWith('달은 왜?');
});

test('오류 메시지 → onError(kind)', () => {
  const f = fake();
  const e = evs();
  new ScribeSession({ apiKey: 'k', connect: f.connect }).start(e);
  f.open();
  f.msg({ message_type: 'auth_error', error: 'x' });
  const err = e.onError.mock.calls[0][0];
  expect(err).toBeInstanceOf(SttError);
  expect(err.kind).toBe('auth_error');
});

test('keepAlive는 3200바이트 무음', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  f.open();
  s.keepAlive();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].commit).toBe(false);
  const raw = Buffer.from(f.sent[0].audio_base_64, 'base64');
  expect(raw.length).toBe(3200);
  expect(raw.every((x) => x === 0)).toBe(true);
});

test('소켓 close/error는 콜백으로, close()는 소켓을 닫는다', () => {
  const f = fake();
  const e = evs();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(e);
  f.handlers.error(new Error('boom'));
  expect(e.onError.mock.calls[0][0].kind).toBe('socket');
  f.handlers.close();
  expect(e.onClose).toHaveBeenCalled();
  s.close();
  expect(f.ws.closed).toBe(true);
});

test('열리기 전 commit도 순서대로 보낸다', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  s.sendAudio(new Uint8Array(2));
  s.commit();
  f.open();
  expect(f.sent.map((m) => m.commit)).toEqual([false, true]);
  expect(f.sent[1].audio_base_64).toBe('');
});

test('close() 뒤에는 보내지도 쌓지도 않는다', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  f.open();
  s.sendAudio(new Uint8Array(2));
  s.close();
  f.sent.length = 0;
  s.sendAudio(new Uint8Array(2));
  s.commit();
  s.keepAlive();
  expect(f.sent).toEqual([]);
});

test('연결 중 close()하면 쌓인 소리는 버리고 늦은 open도 무시', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  s.sendAudio(new Uint8Array(2));
  s.commit();
  s.close();
  f.open();
  expect(f.sent).toEqual([]);
  s.keepAlive();
  expect(f.sent).toEqual([]);
});

test('소켓 close 뒤에는 콜백·전송이 멈춘다', () => {
  const f = fake();
  const e = evs();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(e);
  f.open();
  f.handlers.close();
  f.msg({ message_type: 'partial_transcript', text: 'x' });
  f.handlers.error(new Error('late'));
  s.sendAudio(new Uint8Array(2));
  expect(e.onPartial).not.toHaveBeenCalled();
  expect(e.onError).not.toHaveBeenCalled();
  expect(f.sent).toEqual([]);
});

test('readyState가 OPEN이 아니면 보내지 않는다', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  f.open();
  f.ws.readyState = 2;
  s.keepAlive();
  expect(f.sent).toEqual([]);
});

test('error 대신 message를 담은 오류 프레임도 받는다', () => {
  const f = fake();
  const e = evs();
  new ScribeSession({ apiKey: 'k', connect: f.connect }).start(e);
  f.open();
  f.msg({ message_type: 'rate_limited', message: 'slow down' });
  expect(e.onError.mock.calls[0][0]).toMatchObject({ kind: 'rate_limited', message: 'slow down' });
});

test.each([
  ['commit_throttled', { message_type: 'commit_throttled', error: 'too many commits' }],
  ['warning', { message_type: 'warning', message: 'audio too quiet' }],
  ['input_warning', { message_type: 'input_warning', message: 'x' }],
])('%s는 치명적이지 않다 → onWarning, onError 아님', (_n, frame) => {
  const f = fake();
  const e = { ...evs(), onWarning: vi.fn() };
  new ScribeSession({ apiKey: 'k', connect: f.connect }).start(e);
  f.open();
  f.msg(frame);
  expect(e.onError).not.toHaveBeenCalled();
  expect(e.onWarning).toHaveBeenCalledTimes(1);
  expect(e.onWarning.mock.calls[0][0]).toMatchObject({ kind: frame.message_type });
});

test('onWarning이 없어도 경고는 조용히 넘긴다', () => {
  const f = fake();
  const e = evs();
  new ScribeSession({ apiKey: 'k', connect: f.connect }).start(e);
  f.open();
  f.msg({ message_type: 'commit_throttled', error: 'x' });
  expect(e.onError).not.toHaveBeenCalled();
});

/** 보낸 프레임을 'v x 길이'(같은 값으로 채운 소리끼리 합침)와 'C'(commit)로 요약한다. */
function summary(sent: any[]): string[] {
  const out: string[] = [];
  let cur: { v: number; n: number } | null = null;
  const flush = () => {
    if (cur) out.push(`${cur.v}x${cur.n}`);
    cur = null;
  };
  for (const m of sent) {
    if (m.commit) {
      flush();
      out.push('C');
      continue;
    }
    const b = Buffer.from(m.audio_base_64, 'base64');
    if (cur && cur.v === b[0]) cur.n += b.length;
    else {
      flush();
      cur = { v: b[0], n: b.length };
    }
  }
  flush();
  return out;
}
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

test('열리기 전 쌓이는 소리는 320000바이트(약 10초)까지, 넘치면 오래된 소리부터 버리고 commit 순서는 지킨다', () => {
  expect(PENDING_AUDIO_LIMIT).toBe(320000);
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  s.sendAudio(fill(100000, 1));
  s.sendAudio(fill(100000, 2));
  s.commit();
  s.sendAudio(fill(200000, 3)); // 합계 400000 → 가장 오래된 1을 버린다
  f.open();
  expect(summary(f.sent)).toEqual(['2x100000', 'C', '3x200000']);
});

test('넘쳐서 소리를 모두 잃은 commit은 빈 commit이 되므로 함께 버린다', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  s.sendAudio(fill(160000, 1));
  s.commit();
  s.sendAudio(fill(160000, 2));
  s.sendAudio(fill(160000, 3)); // 1이 버려지면 앞의 commit은 확정할 소리가 없다
  s.commit();
  f.open();
  expect(summary(f.sent)).toEqual(['2x160000', '3x160000', 'C']);
});

test('한 덩어리가 한도보다 크면 뒤쪽 320000바이트만 쌓는다', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  const big = fill(400000, 5);
  big.fill(9, 0, 80000);
  s.sendAudio(big);
  f.open();
  expect(summary(f.sent)).toEqual(['5x320000']);
});

test('열린 뒤에는 한도와 상관없이 바로 보낸다', () => {
  const f = fake();
  const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
  s.start(evs());
  f.open();
  s.sendAudio(fill(200000, 1));
  s.sendAudio(fill(200000, 2));
  expect(summary(f.sent)).toEqual(['1x200000', '2x200000']);
});

describe('연결 시간 한도', () => {
  afterEach(() => vi.useRealTimers());

  test(`${CONNECT_TIMEOUT_MS}ms 안에 열리지 않으면(핸드셰이크 멈춤) onError(timeout) 후 소켓을 닫는다`, () => {
    vi.useFakeTimers();
    const f = fake();
    const e = evs();
    const s = new ScribeSession({ apiKey: 'k', connect: f.connect });
    s.start(e);
    s.sendAudio(new Uint8Array(640));
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
    expect(e.onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(e.onError).toHaveBeenCalledTimes(1);
    expect(e.onError.mock.calls[0][0]).toMatchObject({ kind: 'timeout' });
    expect(f.ws.closed).toBe(true);
    f.open(); // 늦게 열려도 쌓인 소리를 보내지 않는다
    expect(f.sent).toEqual([]);
  });

  test('제때 열리거나 먼저 close()하면 시간 한도는 오류를 내지 않는다', () => {
    vi.useFakeTimers();
    const a = fake();
    const ea = evs();
    new ScribeSession({ apiKey: 'k', connect: a.connect }).start(ea);
    a.open();
    const b = fake();
    const eb = evs();
    const sb = new ScribeSession({ apiKey: 'k', connect: b.connect });
    sb.start(eb);
    sb.close();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 2);
    expect(ea.onError).not.toHaveBeenCalled();
    expect(eb.onError).not.toHaveBeenCalled();
  });
});

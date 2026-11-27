import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import { ListenClient, type ListenStatus, type WebSocketLike } from '../../src/web/voice/listenClient';

/** 가짜 WebSocket. 테스트가 open/message/close를 직접 일으킨다. */
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: (string | ArrayBuffer)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  // 테스트용
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  json() {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
  }
  binary() {
    return this.sent.filter((s): s is ArrayBuffer => s instanceof ArrayBuffer);
  }
}

const URL_ = 'ws://host/api/listen?profile=kid';
function mk(opts: { pingMs?: number; backoffMs?: number[]; readyTimeoutMs?: number } = {}) {
  const statuses: ListenStatus[] = [];
  const c = new ListenClient({ url: URL_, makeSocket: (u) => new FakeSocket(u), ...opts });
  c.onStatus = (s) => statuses.push(s);
  return { c, statuses, sock: () => FakeSocket.all[FakeSocket.all.length - 1] };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('ListenClient', () => {
  test('열리면 ready, sendPcm은 바이너리, end/state/ping은 JSON', () => {
    const { c, statuses, sock } = mk({ pingMs: 10000 });
    c.connect();
    expect(statuses).toEqual(['connecting']);
    expect(sock().url).toBe(URL_);
    expect(sock().binaryType).toBe('arraybuffer');
    sock().open();
    sock().msg({ type: 'ready' });
    expect(statuses).toEqual(['connecting', 'ready']);

    // 더 큰 버퍼의 일부(subarray)여도 그 바이트만 정확히 보낸다
    const big = new Int16Array([9, 1, -2, 300, 9]);
    c.sendPcm(big.subarray(1, 4));
    const [bin] = sock().binary();
    expect(Array.from(new Int16Array(bin))).toEqual([1, -2, 300]);
    expect(bin.byteLength).toBe(6);

    c.end();
    c.setState(true, ['안녕', '달은']);
    expect(sock().json()).toEqual([{ type: 'end' }, { type: 'state', lessonActive: true, recentSpoken: ['안녕', '달은'] }]);

    vi.advanceTimersByTime(10000);
    expect(sock().json().at(-1)).toEqual({ type: 'ping' });
    vi.advanceTimersByTime(10000);
    expect(sock().json().filter((m) => m.type === 'ping')).toHaveLength(2);
  });

  test('ready 전 sendPcm은 버림(끊긴 동안 소리를 쌓지 않음)', () => {
    const { c, sock } = mk();
    c.sendPcm(new Int16Array([1, 2])); // 연결 전
    c.connect();
    c.sendPcm(new Int16Array([1, 2])); // 여는 중
    sock().open();
    c.sendPcm(new Int16Array([1, 2])); // 열렸지만 서버 ready 전
    c.end();
    expect(sock().sent).toEqual([]);
    sock().msg({ type: 'ready' });
    c.sendPcm(new Int16Array([3]));
    expect(sock().binary()).toHaveLength(1);
    sock().drop();
    c.sendPcm(new Int16Array([4])); // 끊긴 뒤
    expect(sock().binary()).toHaveLength(1);
  });

  test('ready가 되면 마지막 state를 다시 보낸다(재연결 뒤에도 서버가 문맥을 안다)', () => {
    const { c, sock } = mk();
    c.setState(true, ['하나']); // 연결 전 — 보낼 수 없으니 기억만
    c.connect();
    sock().open();
    sock().msg({ type: 'ready' });
    expect(sock().json()).toEqual([{ type: 'state', lessonActive: true, recentSpoken: ['하나'] }]);
  });

  test('끊기면 error 후 backoff 순서로 재연결', () => {
    const { c, statuses, sock } = mk({ backoffMs: [500, 1000, 2000, 5000] });
    c.connect();
    sock().open();
    sock().msg({ type: 'ready' });
    sock().drop();
    expect(statuses).toEqual(['connecting', 'ready', 'error']);
    expect(FakeSocket.all).toHaveLength(1);

    const waitFor = (ms: number) => {
      const n = FakeSocket.all.length;
      vi.advanceTimersByTime(ms - 1);
      expect(FakeSocket.all).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(n + 1);
    };
    waitFor(500);
    sock().drop(); // 열리지도 못함
    waitFor(1000);
    sock().drop();
    waitFor(2000);
    sock().drop();
    waitFor(5000);
    sock().drop();
    waitFor(5000); // 마지막 간격을 계속 쓴다
    expect(statuses.filter((s) => s === 'error')).toHaveLength(5);
  });

  test('ready 직후 곧바로 1011로 끊기기를 되풀이하면(STT 인증 실패) 간격은 계속 늘어난다', () => {
    const { c, statuses, sock } = mk({ backoffMs: [500, 1000, 2000, 5000] });
    c.connect();
    const readyThenFail = () => {
      sock().open();
      sock().msg({ type: 'ready' });
      sock().msg({ type: 'error', message: 'x' });
      sock().drop(1011);
    };
    const waitFor = (ms: number) => {
      const n = FakeSocket.all.length;
      vi.advanceTimersByTime(ms - 1);
      expect(FakeSocket.all).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(n + 1);
    };
    readyThenFail();
    waitFor(500);
    readyThenFail();
    waitFor(1000);
    readyThenFail();
    waitFor(2000);
    readyThenFail();
    waitFor(5000);
    readyThenFail();
    waitFor(5000);
    expect(statuses.filter((s) => s === 'error')).toHaveLength(5);
  });

  test('6번 연달아 실패하면 간격을 15초 → 30초 → 60초로 늘리고 60초에 머문다. 오래 버틴 연결 뒤엔 처음부터', () => {
    const { c, sock } = mk(); // 기본 간격
    c.connect();
    const waitFor = (ms: number) => {
      const n = FakeSocket.all.length;
      vi.advanceTimersByTime(ms - 1);
      expect(FakeSocket.all).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(n + 1);
    };
    for (const ms of [500, 1000, 2000, 5000, 5000, 5000, 15_000, 30_000, 60_000, 60_000]) {
      sock().drop();
      waitFor(ms);
    }
    // 잘 되던 연결(ready로 5초 넘게)이 끊기면 다시 500부터
    sock().open();
    sock().msg({ type: 'ready' });
    vi.advanceTimersByTime(5000);
    sock().drop();
    waitFor(500);
  });

  test('5초 넘게 ready로 버틴 뒤 끊기면 간격은 처음(500)부터', () => {
    const { c, sock } = mk({ backoffMs: [500, 1000, 2000, 5000] });
    c.connect();
    sock().drop();
    vi.advanceTimersByTime(500);
    sock().drop();
    vi.advanceTimersByTime(1000);
    sock().drop();
    vi.advanceTimersByTime(2000); // 다음 간격은 5000이 될 참
    expect(FakeSocket.all).toHaveLength(4);
    sock().open();
    sock().msg({ type: 'ready' });
    vi.advanceTimersByTime(5000);
    sock().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(5);
  });

  test('1008(origin·profile 거절)로 닫히면 error로 멈추고 다시 연결하지 않는다', () => {
    const { c, statuses, sock } = mk({ backoffMs: [500] });
    c.connect();
    sock().open();
    sock().drop(1008);
    expect(statuses).toEqual(['connecting', 'error']);
    expect(c.status).toBe('error');
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all).toHaveLength(1);
    c.connect(); // 직접 다시 부르면 다시 시도한다
    expect(FakeSocket.all).toHaveLength(2);
  });

  test('열렸는데 10초 안에 ready가 안 오면 끊고 재연결', () => {
    const { c, statuses, sock } = mk({ backoffMs: [500] });
    c.connect();
    const first = sock();
    first.open();
    vi.advanceTimersByTime(9999);
    expect(statuses).toEqual(['connecting']);
    vi.advanceTimersByTime(1);
    expect(statuses).toEqual(['connecting', 'error']);
    expect(first.closed).not.toBeNull();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(2);
    // ready가 오면 시간 제한은 풀린다
    sock().open();
    sock().msg({ type: 'ready' });
    vi.advanceTimersByTime(60000);
    expect(statuses.at(-1)).toBe('ready');
    expect(FakeSocket.all).toHaveLength(2);
  });

  test('status는 마지막 상태를 보여 준다', () => {
    const { c, sock } = mk();
    expect(c.status).toBe('closed');
    c.connect();
    expect(c.status).toBe('connecting');
    sock().open();
    sock().msg({ type: 'ready' });
    expect(c.status).toBe('ready');
    c.close();
    expect(c.status).toBe('closed');
  });

  test('콜백이 던져도 클라이언트는 계속 동작한다', () => {
    const { c, sock } = mk();
    const partials: string[] = [];
    c.onPartial = (t) => {
      partials.push(t);
      throw new Error('boom');
    };
    c.onUtterance = () => {
      throw new Error('boom');
    };
    c.connect();
    sock().open();
    sock().msg({ type: 'ready' });
    expect(() => sock().msg({ type: 'partial', text: '하나' })).not.toThrow();
    expect(() => sock().msg({ type: 'utterance', text: 'a', accept: true, question: 'a' })).not.toThrow();
    sock().msg({ type: 'partial', text: '둘' });
    expect(partials).toEqual(['하나', '둘']);
    expect(c.status).toBe('ready');
  });

  test('서버 error(STT 실패) 뒤 1011로 닫히면 error 한 번, 그리고 재연결', () => {
    const { c, statuses, sock } = mk({ backoffMs: [500] });
    c.connect();
    sock().open();
    sock().msg({ type: 'ready' });
    sock().msg({ type: 'error', message: '듣기 연결에 문제가 생겼어요.' });
    sock().drop(1011);
    expect(statuses).toEqual(['connecting', 'ready', 'error']);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(2);
  });

  test('onerror 뒤 close가 와도 error는 한 번만, 재연결도 한 번만', () => {
    const { c, statuses, sock } = mk({ backoffMs: [500] });
    c.connect();
    sock().onerror?.({});
    sock().drop();
    expect(statuses).toEqual(['connecting', 'error']);
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  test('close()는 재연결하지 않고 closed, ping도 멈춘다', () => {
    const { c, statuses, sock } = mk({ pingMs: 1000 });
    c.connect();
    const s = sock();
    s.open();
    s.msg({ type: 'ready' });
    c.close();
    expect(s.closed).not.toBeNull();
    expect(statuses.at(-1)).toBe('closed');
    s.drop(1000); // 닫힘 이벤트가 늦게 와도
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(s.json().filter((m) => m.type === 'ping')).toHaveLength(0);
    expect(statuses.filter((x) => x === 'error')).toHaveLength(0);
  });

  test('재연결 대기 중 close()면 다시 열지 않는다', () => {
    const { c, sock } = mk({ backoffMs: [500] });
    c.connect();
    sock().drop();
    c.close();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  test('partial/utterance 콜백', () => {
    const { c, sock } = mk();
    const partials: string[] = [];
    const utts: unknown[] = [];
    c.onPartial = (t) => partials.push(t);
    c.onUtterance = (u) => utts.push(u);
    c.connect();
    sock().open();
    sock().msg({ type: 'ready' });
    sock().msg({ type: 'partial', text: '달은' });
    sock().msg({ type: 'utterance', text: '달은 왜 따라와?', accept: true, question: '달은 왜 나를 따라와?' });
    // 이상한 메시지는 무시
    sock().onmessage?.({ data: 'not json' });
    sock().onmessage?.({ data: new ArrayBuffer(2) });
    sock().msg({ type: 'partial', text: 3 });
    sock().msg({ type: 'utterance', text: 'x' });
    expect(partials).toEqual(['달은']);
    expect(utts).toEqual([{ text: '달은 왜 따라와?', accept: true, question: '달은 왜 나를 따라와?' }]);
  });

  test('못 알아들은 말 표시(miss: true)는 그대로 넘기고, 다른 값이면 넘기지 않는다(E7)', () => {
    const { c, sock } = mk();
    const utts: unknown[] = [];
    c.onUtterance = (u) => utts.push(u);
    c.connect();
    sock().open();
    sock().msg({ type: 'ready' });
    sock().msg({ type: 'utterance', text: '음 그거', accept: false, question: '', miss: true });
    sock().msg({ type: 'utterance', text: '우와', accept: false, question: '', miss: 'yes' });
    expect(utts).toEqual([{ text: '음 그거', accept: false, question: '', miss: true }, { text: '우와', accept: false, question: '' }]);
  });

  test('예전 소켓의 늦은 이벤트는 무시한다', () => {
    const { c, statuses, sock } = mk({ backoffMs: [500] });
    const partials: string[] = [];
    c.onPartial = (t) => partials.push(t);
    c.connect();
    const old = sock();
    old.open();
    old.msg({ type: 'ready' });
    old.drop();
    vi.advanceTimersByTime(500);
    const fresh = sock();
    expect(fresh).not.toBe(old);
    old.msg({ type: 'partial', text: '옛날' });
    old.drop();
    expect(partials).toEqual([]);
    expect(statuses.filter((s) => s === 'error')).toHaveLength(1);
  });
});

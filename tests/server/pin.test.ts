import { createHash } from 'node:crypto';
import {
  createPinGate,
  PIN_COOKIE,
  PIN_DAILY_LOCK_MAX_MS,
  PIN_DAILY_LOCK_MS,
  PIN_DAILY_MAX_FAILS,
  PIN_DAILY_WINDOW_MS,
  PIN_GLOBAL_MAX_FAILS,
  PIN_LOCK_MAX_MS,
  PIN_LOCK_MS,
  PIN_MAX_FAILS,
  PIN_WINDOW_MS,
  pinClientKey,
  forwardedHttps,
} from '../../src/server/pin';

const A = '203.0.113.1';
const B = '198.51.100.7';

const PIN = '135790';
const cookieOf = (value: string) => `${PIN_COOKIE}=${value}`;

function login(gate: ReturnType<typeof createPinGate>, pin = PIN): string {
  const r = gate.attempt(pin, A);
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
  return r.cookieValue;
}

afterEach(() => vi.useRealTimers());

test('맞는 PIN → 쿠키 값, 그 쿠키로 통과', () => {
  const gate = createPinGate({ pin: PIN });
  const v = login(gate);
  expect(gate.check(cookieOf(v))).toBe(true);
  expect(gate.check(`other=1; ${cookieOf(v)}; x=y`)).toBe(true);
});

test('쿠키 값에는 PIN도 PIN 해시도 없다', () => {
  const gate = createPinGate({ pin: PIN, secret: 's3cret' });
  const v = login(gate);
  expect(v).not.toContain(PIN);
  expect(v).not.toContain(createHash('sha256').update(PIN).digest('hex'));
  expect(v).not.toContain(createHash('sha256').update(PIN).digest('base64url'));
});

test('쿠키가 없거나 모양이 이상하면 거절', () => {
  const gate = createPinGate({ pin: PIN });
  for (const c of [undefined, '', 'tb_pin=', 'tb_pin=abc', 'tb_pin=1.2.3', `other=${login(gate)}`]) {
    expect(gate.check(c)).toBe(false);
  }
});

test('쿠키를 고치면 거절(서명·발급 시각 둘 다)', () => {
  const gate = createPinGate({ pin: PIN });
  const v = login(gate);
  const [issued, mac] = v.split('.');
  const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  expect(gate.check(cookieOf(`${issued}.${flip(mac)}`))).toBe(false);
  expect(gate.check(cookieOf(`${Number(issued) + 1}.${mac}`))).toBe(false);
  expect(gate.check(cookieOf(`${issued}.${mac.slice(0, -2)}`))).toBe(false);
  expect(gate.check(cookieOf(`${issued}.${mac}x`))).toBe(false);
});

test('PIN을 바꾸면(같은 PIN_SECRET이어도) 예전 쿠키는 거절', () => {
  const v = login(createPinGate({ pin: PIN, secret: 'same' }));
  expect(createPinGate({ pin: PIN, secret: 'same' }).check(cookieOf(v))).toBe(true);
  expect(createPinGate({ pin: '246802', secret: 'same' }).check(cookieOf(v))).toBe(false);
});

test('PIN_SECRET이 없으면 프로세스마다 무작위: 다시 만든 관문은 예전 쿠키를 모른다', () => {
  const v = login(createPinGate({ pin: PIN }));
  expect(createPinGate({ pin: PIN }).check(cookieOf(v))).toBe(false);
  expect(createPinGate({ pin: PIN, secret: 'other' }).check(cookieOf(v))).toBe(false);
});

test('1년이 지난 쿠키는 거절', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const gate = createPinGate({ pin: PIN });
  const v = login(gate);
  vi.setSystemTime(new Date('2026-12-31T00:00:00Z'));
  expect(gate.check(cookieOf(v))).toBe(true);
  vi.setSystemTime(new Date('2027-01-02T00:00:00Z'));
  expect(gate.check(cookieOf(v))).toBe(false);
});

test('틀린 PIN → wrong, 문자열이 아니면 invalid(세지 않음)', () => {
  const gate = createPinGate({ pin: PIN });
  expect(gate.attempt('000000', A).kind).toBe('wrong');
  expect(gate.attempt('13579', A).kind).toBe('wrong');
  expect(gate.attempt(135790, A).kind).toBe('invalid');
  expect(gate.attempt(undefined, A).kind).toBe('invalid');
  expect(gate.attempt('1'.repeat(100), A).kind).toBe('invalid');
  // invalid는 잠금 횟수에 들지 않는다: 2번 더 틀려도(총 4번) 아직 안 잠긴다
  for (let i = 0; i < PIN_MAX_FAILS - 3; i++) expect(gate.attempt('000000', A).kind).toBe('wrong');
  expect(gate.attempt(PIN, A).kind).toBe('ok');
});

test('한 곳에서 10분 안에 5번 틀리면 그곳은 10분 동안 맞는 PIN도 locked(남은 초), 지나면 풀린다', () => {
  vi.useFakeTimers();
  const gate = createPinGate({ pin: PIN });
  for (let i = 0; i < PIN_MAX_FAILS - 1; i++) {
    expect(gate.attempt('000000', A).kind).toBe('wrong');
    vi.advanceTimersByTime(1000);
  }
  expect(gate.attempt('000000', A)).toEqual({ kind: 'locked', retryAfterSec: PIN_LOCK_MS / 1000 });
  vi.advanceTimersByTime(4 * 60_000);
  expect(gate.attempt(PIN, A)).toEqual({ kind: 'locked', retryAfterSec: PIN_LOCK_MS / 1000 - 240 });
  vi.advanceTimersByTime(PIN_LOCK_MS - 4 * 60_000 - 1);
  expect(gate.attempt(PIN, A)).toEqual({ kind: 'locked', retryAfterSec: 1 });
  vi.advanceTimersByTime(1);
  expect(gate.attempt(PIN, A).kind).toBe('ok');
});

test('잠금이 풀리면 틀린 횟수를 처음부터 센다', () => {
  vi.useFakeTimers();
  const gate = createPinGate({ pin: PIN });
  for (let i = 0; i < PIN_MAX_FAILS; i++) gate.attempt('000000', A);
  vi.advanceTimersByTime(PIN_LOCK_MS);
  expect(gate.attempt('000000', A).kind).toBe('wrong');
  expect(gate.attempt(PIN, A).kind).toBe('ok');
});

test('한 곳이 잠겨도 다른 곳은 PIN을 넣을 수 있다', () => {
  const gate = createPinGate({ pin: PIN });
  for (let i = 0; i < PIN_MAX_FAILS; i++) gate.attempt('000000', A);
  expect(gate.attempt(PIN, A).kind).toBe('locked');
  expect(gate.attempt('000000', B).kind).toBe('wrong');
  expect(gate.attempt(PIN, B).kind).toBe('ok');
});

test('같은 곳이 또 잠기면 잠금 시간이 두 배씩(최대 PIN_LOCK_MAX_MS), 맞히면 처음으로', () => {
  vi.useFakeTimers();
  const gate = createPinGate({ pin: PIN });
  const lockOnce = () => {
    for (let i = 0; i < PIN_MAX_FAILS - 1; i++) gate.attempt('000000', A);
    return gate.attempt('000000', A);
  };
  let ms = PIN_LOCK_MS;
  for (let n = 0; n < 10; n++) {
    expect(lockOnce()).toEqual({ kind: 'locked', retryAfterSec: ms / 1000 });
    vi.advanceTimersByTime(ms);
    ms = Math.min(ms * 2, PIN_LOCK_MAX_MS);
  }
  expect(gate.attempt(PIN, A).kind).toBe('ok');
  expect(lockOnce()).toEqual({ kind: 'locked', retryAfterSec: PIN_LOCK_MS / 1000 });
});

test('여러 곳을 합쳐 10분 안에 PIN_GLOBAL_MAX_FAILS번 틀리면 모두 10분 잠근다(대입 막이)', () => {
  vi.useFakeTimers();
  const gate = createPinGate({ pin: PIN });
  // 곳마다 4번씩(각자는 안 잠기게) 여러 곳에서
  let n = 0;
  let last: ReturnType<typeof gate.attempt> = { kind: 'wrong' };
  for (let c = 0; n < PIN_GLOBAL_MAX_FAILS; c++) {
    for (let i = 0; i < PIN_MAX_FAILS - 1 && n < PIN_GLOBAL_MAX_FAILS; i++, n++) {
      last = gate.attempt('000000', `10.0.${c}.1`);
    }
  }
  expect(last).toEqual({ kind: 'locked', retryAfterSec: PIN_LOCK_MS / 1000 });
  expect(gate.attempt(PIN, 'fresh-client').kind).toBe('locked');
  vi.advanceTimersByTime(PIN_LOCK_MS);
  expect(gate.attempt(PIN, 'fresh-client').kind).toBe('ok');
});

test('틀린 횟수는 10분 창 안의 것만 센다', () => {
  vi.useFakeTimers();
  const gate = createPinGate({ pin: PIN });
  for (let i = 0; i < PIN_MAX_FAILS - 1; i++) gate.attempt('000000', A);
  vi.advanceTimersByTime(PIN_WINDOW_MS);
  expect(gate.attempt('000000', A).kind).toBe('wrong'); // 앞의 4번은 창 밖
  for (let i = 0; i < PIN_MAX_FAILS - 2; i++) expect(gate.attempt('000000', A).kind).toBe('wrong');
  expect(gate.attempt('000000', A).kind).toBe('locked');
});

test('맞히면 틀린 횟수를 지운다', () => {
  const gate = createPinGate({ pin: PIN });
  for (let i = 0; i < PIN_MAX_FAILS - 1; i++) gate.attempt('000000', A);
  expect(gate.attempt(PIN, A).kind).toBe('ok');
  for (let i = 0; i < PIN_MAX_FAILS - 1; i++) expect(gate.attempt('000000', A).kind).toBe('wrong');
});

test('PIN은 숫자 6자리여야 한다', () => {
  for (const pin of ['', '12345', '1234567', 'abcdef', '12 456']) {
    expect(() => createPinGate({ pin })).toThrow(/6자리/);
  }
});

describe('전체 잠금도 되풀이되면 늘어난다', () => {
  let seq = 0;
  /** 곳마다 4번씩 나눠 PIN_GLOBAL_MAX_FAILS번 틀려 전체 잠금을 건다. 마지막 결과를 돌려준다. */
  const globalLock = (gate: ReturnType<typeof createPinGate>) => {
    let last: ReturnType<typeof gate.attempt> = { kind: 'wrong' };
    for (let n = 0; n < PIN_GLOBAL_MAX_FAILS; n++) last = gate.attempt('000000', `g${seq}-${Math.floor(n / (PIN_MAX_FAILS - 1))}`);
    seq++;
    return last;
  };

  test('다시 걸릴 때마다 두 배', () => {
    vi.useFakeTimers();
    const gate = createPinGate({ pin: PIN });
    let ms = PIN_LOCK_MS;
    // 하루 예산(PIN_DAILY_MAX_FAILS)을 넘지 않는 만큼만: 20 × 5 = 100
    for (let n = 0; n < PIN_DAILY_MAX_FAILS / PIN_GLOBAL_MAX_FAILS; n++) {
      expect(globalLock(gate)).toEqual({ kind: 'locked', retryAfterSec: ms / 1000 });
      expect(gate.attempt(PIN, `new-${n}`)).toEqual({ kind: 'locked', retryAfterSec: ms / 1000 });
      vi.advanceTimersByTime(ms);
      ms = Math.min(ms * 2, PIN_LOCK_MAX_MS);
    }
  });

  test('맞는 PIN이 들어오면 처음(10분)으로', () => {
    vi.useFakeTimers();
    const gate = createPinGate({ pin: PIN });
    globalLock(gate);
    vi.advanceTimersByTime(PIN_LOCK_MS);
    expect(globalLock(gate)).toEqual({ kind: 'locked', retryAfterSec: (2 * PIN_LOCK_MS) / 1000 });
    vi.advanceTimersByTime(2 * PIN_LOCK_MS);
    expect(gate.attempt(PIN, 'family').kind).toBe('ok');
    expect(globalLock(gate)).toEqual({ kind: 'locked', retryAfterSec: PIN_LOCK_MS / 1000 });
  });

  test('24시간 동안 전체 잠금이 없으면 처음(10분)으로', () => {
    vi.useFakeTimers();
    const gate = createPinGate({ pin: PIN });
    globalLock(gate);
    vi.advanceTimersByTime(PIN_LOCK_MS);
    globalLock(gate); // 20분
    vi.advanceTimersByTime(2 * PIN_LOCK_MS + 24 * 60 * 60_000 - 1);
    expect(globalLock(gate)).toEqual({ kind: 'locked', retryAfterSec: (4 * PIN_LOCK_MS) / 1000 }); // 아직 24시간이 안 됐다
    vi.advanceTimersByTime(4 * PIN_LOCK_MS + 24 * 60 * 60_000);
    expect(globalLock(gate)).toEqual({ kind: 'locked', retryAfterSec: PIN_LOCK_MS / 1000 });
  });
});

test('10분 전체 한도는 20, 하루 예산은 100(넘으면 24시간)', () => {
  expect(PIN_GLOBAL_MAX_FAILS).toBe(20);
  expect(PIN_DAILY_MAX_FAILS).toBe(100);
  expect(PIN_DAILY_LOCK_MS).toBe(24 * 60 * 60_000);
  expect(PIN_DAILY_WINDOW_MS).toBe(24 * 60 * 60_000);
  expect(PIN_LOCK_MAX_MS).toBe(24 * 60 * 60_000);
});

describe('하루 예산: 10분 한도 바로 밑으로 꾸준히 대입해도 막는다', () => {
  let seq = 0;
  /**
   * 10분마다 (한도-1)번씩, 곳마다 4번씩 나눠 틀린다 — 곳 잠금도 10분 전체 잠금도 안 걸리게.
   * total번 틀리고 마지막 결과를 돌려준다.
   */
  const slowBrute = (gate: ReturnType<typeof createPinGate>, total: number) => {
    let last: ReturnType<typeof gate.attempt> = { kind: 'wrong' };
    let inBatch = 0;
    for (let n = 0; n < total; n++) {
      if (inBatch === PIN_GLOBAL_MAX_FAILS - 1) {
        vi.advanceTimersByTime(PIN_WINDOW_MS);
        inBatch = 0;
      }
      last = gate.attempt('000000', `d${seq}-${Math.floor(n / (PIN_MAX_FAILS - 1))}`);
      inBatch++;
    }
    seq++;
    return last;
  };

  test('24시간 안에 100번까지는 wrong, 101번째에 24시간 전체 잠금(맞는 PIN도)', () => {
    vi.useFakeTimers();
    const gate = createPinGate({ pin: PIN });
    expect(slowBrute(gate, PIN_DAILY_MAX_FAILS)).toEqual({ kind: 'wrong' });
    expect(gate.attempt('000000', 'one-more')).toEqual({ kind: 'locked', retryAfterSec: PIN_DAILY_LOCK_MS / 1000 });
    vi.advanceTimersByTime(PIN_DAILY_LOCK_MS - 1000);
    expect(gate.attempt(PIN, 'family')).toEqual({ kind: 'locked', retryAfterSec: 1 });
    vi.advanceTimersByTime(1000);
    expect(gate.attempt(PIN, 'family').kind).toBe('ok');
  });

  test('24시간 창 밖의 틀림은 세지 않는다', () => {
    vi.useFakeTimers();
    const gate = createPinGate({ pin: PIN });
    slowBrute(gate, PIN_DAILY_MAX_FAILS);
    vi.advanceTimersByTime(PIN_DAILY_WINDOW_MS);
    expect(slowBrute(gate, PIN_DAILY_MAX_FAILS)).toEqual({ kind: 'wrong' });
  });

  test('되풀이되면 두 배씩(최대 PIN_DAILY_LOCK_MAX_MS), 맞는 PIN이 들어오면 처음으로', () => {
    vi.useFakeTimers();
    const gate = createPinGate({ pin: PIN });
    let ms = PIN_DAILY_LOCK_MS;
    for (let n = 0; n < 5; n++) {
      expect(slowBrute(gate, PIN_DAILY_MAX_FAILS + 1)).toEqual({ kind: 'locked', retryAfterSec: ms / 1000 });
      vi.advanceTimersByTime(ms);
      ms = Math.min(ms * 2, PIN_DAILY_LOCK_MAX_MS);
    }
    expect(PIN_DAILY_LOCK_MAX_MS).toBeLessThan(PIN_DAILY_LOCK_MS * 16);
    expect(gate.attempt(PIN, 'family').kind).toBe('ok');
    expect(slowBrute(gate, PIN_DAILY_MAX_FAILS + 1)).toEqual({ kind: 'locked', retryAfterSec: PIN_DAILY_LOCK_MS / 1000 });
  });
});

test('같은 이름의 쿠키가 여럿이면 하나라도 맞으면 통과', () => {
  const gate = createPinGate({ pin: PIN });
  const v = login(gate);
  expect(gate.check(`${PIN_COOKIE}=garbage; ${cookieOf(v)}`)).toBe(true);
  expect(gate.check(`${cookieOf(v)}; ${PIN_COOKIE}=garbage`)).toBe(true);
  expect(gate.check(`${PIN_COOKIE}=garbage; ${PIN_COOKIE}=1.x`)).toBe(false);
});

describe('pinClientKey(잠금을 셀 곳)', () => {
  test('TRUST_PROXY가 아니면 소켓 주소', () => {
    expect(pinClientKey('127.0.0.1', '203.0.113.9', false)).toBe('127.0.0.1');
    expect(pinClientKey('192.168.0.9', undefined, false)).toBe('192.168.0.9');
  });
  test('TRUST_PROXY여도 loopback이 아닌 곳에서 오면 소켓 주소', () => {
    expect(pinClientKey('192.168.0.9', '203.0.113.9', true)).toBe('192.168.0.9');
  });
  test('TRUST_PROXY + loopback이면 X-Forwarded-For 맨 오른쪽', () => {
    expect(pinClientKey('127.0.0.1', '10.0.0.1, 203.0.113.9', true)).toBe('203.0.113.9');
    expect(pinClientKey('::1', ['10.0.0.1', '198.51.100.2'], true)).toBe('198.51.100.2');
    expect(pinClientKey('::ffff:127.0.0.1', '203.0.113.9', true)).toBe('203.0.113.9');
  });
  test('맨 오른쪽이 IP가 아니면 소켓 주소로', () => {
    expect(pinClientKey('127.0.0.1', '203.0.113.9, evil', true)).toBe('127.0.0.1');
    expect(pinClientKey('127.0.0.1', '203.0.113.9:443', true)).toBe('127.0.0.1');
    expect(pinClientKey('127.0.0.1', '', true)).toBe('127.0.0.1');
  });
  test('IPv6는 /64로 묶는다(한 집이 주소를 바꿔 가며 피하지 못하게)', () => {
    const a = pinClientKey('2001:db8:1:2:aaaa::1', undefined, false);
    expect(a).toBe('2001:db8:1:2::/64');
    expect(pinClientKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff', undefined, false)).toBe(a);
    expect(pinClientKey('127.0.0.1', '2001:db8:1:2::99', true)).toBe(a);
    expect(pinClientKey('2001:db8:1:3::1', undefined, false)).not.toBe(a);
    expect(pinClientKey('fe80::1%eth0', undefined, false)).toBe('fe80:0:0:0::/64');
  });
  test('IPv4에 매핑된 IPv6는 IPv4로', () => {
    expect(pinClientKey('::ffff:192.168.0.9', undefined, false)).toBe('192.168.0.9');
  });
});

describe('forwardedHttps(X-Forwarded-Proto)', () => {
  test('TRUST_PROXY + loopback이고 맨 오른쪽 값이 https일 때만', () => {
    expect(forwardedHttps('127.0.0.1', 'https', true)).toBe(true);
    expect(forwardedHttps('127.0.0.1', 'http, https', true)).toBe(true);
    expect(forwardedHttps('127.0.0.1', 'https, http', true)).toBe(false);
    expect(forwardedHttps('127.0.0.1', ['https', 'http'], true)).toBe(false);
    expect(forwardedHttps('127.0.0.1', 'https', false)).toBe(false);
    expect(forwardedHttps('192.168.0.9', 'https', true)).toBe(false);
    expect(forwardedHttps('127.0.0.1', undefined, true)).toBe(false);
  });
});

// 가족 비밀번호(PIN) 관문: PIN 확인(상수 시간), 서명 쿠키 발급·검사, 잠금.
// 잠금은 접속한 곳(클라이언트 주소)마다 따로 — 낯선 사람이 틀려도 가족의 다른 기기는 PIN을 넣을 수 있다.
// 그와 별도로 모든 곳을 합친 큰 한도(대입 막이)가 있다. 이미 쿠키가 있는 기기는 어떤 잠금에도 영향받지 않는다.
// PIN 값은 어디에도 기록하지 않는다(쿠키 값에도 PIN·PIN 해시가 실리지 않는다).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const PIN_COOKIE = 'tb_pin';
export const PIN_LENGTH = 6;
/** 이 창(ms) 안에 한 곳에서 PIN_MAX_FAILS번 틀리면 그곳을 잠근다. */
export const PIN_WINDOW_MS = 10 * 60_000;
export const PIN_MAX_FAILS = 5;
/** 한 곳의 첫 잠금 시간. 같은 곳이 또 잠기면 두 배씩 늘어난다(최대 PIN_LOCK_MAX_MS). 맞히면 처음으로. */
export const PIN_LOCK_MS = 10 * 60_000;
export const PIN_LOCK_MAX_MS = 24 * 60 * 60_000;
/**
 * 모든 곳을 합쳐 PIN_WINDOW_MS 안에 이만큼 틀리면 모두 잠근다(여러 주소로 나눠 대입하는 것 막이).
 * 전체 잠금도 되풀이되면 두 배씩(최대 PIN_LOCK_MAX_MS). 맞는 PIN이 들어오거나 PIN_GLOBAL_RESET_MS 동안 전체 잠금이 없으면 처음으로.
 */
export const PIN_GLOBAL_MAX_FAILS = 20;
export const PIN_GLOBAL_RESET_MS = 24 * 60 * 60_000;
/**
 * 하루 예산: 모든 곳을 합쳐 PIN_DAILY_WINDOW_MS 안에 PIN_DAILY_MAX_FAILS번을 넘게 틀리면 PIN_DAILY_LOCK_MS 동안 모두 잠근다
 * (10분 한도 바로 밑으로 꾸준히 대입하는 것 막이). 되풀이되면 두 배씩(최대 PIN_DAILY_LOCK_MAX_MS).
 * 맞는 PIN이 들어오거나 PIN_DAILY_RESET_MS 동안 하루 잠금이 없으면 처음으로.
 */
export const PIN_DAILY_MAX_FAILS = 100;
export const PIN_DAILY_WINDOW_MS = 24 * 60 * 60_000;
export const PIN_DAILY_LOCK_MS = 24 * 60 * 60_000;
export const PIN_DAILY_LOCK_MAX_MS = 7 * 24 * 60 * 60_000;
export const PIN_DAILY_RESET_MS = 7 * 24 * 60 * 60_000;
/** 기억하는 곳이 이만큼 넘으면 지난 기록(창 밖·잠금 끝남)을 지운다. */
const MAX_TRACKED_CLIENTS = 1000;
export const PIN_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
/** 이보다 긴 문자열은 비교하지 않는다(잘못된 요청). */
const MAX_INPUT = 32;
/** 서버 시계가 조금 뒤로 가도 막 받은 쿠키를 버리지 않게. */
const CLOCK_SKEW_S = 5 * 60;

export const isValidPin = (pin: string): boolean => new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

export type PinAttempt =
  | { kind: 'ok'; cookieValue: string }
  | { kind: 'wrong' }
  | { kind: 'locked'; retryAfterSec: number }
  | { kind: 'invalid' };

export type PinGate = {
  /** Cookie 머리글에 유효한 PIN 쿠키가 있나. */
  check(cookieHeader: string | undefined): boolean;
  /** client(접속한 곳의 주소)에서 온 PIN 시도 하나. 그곳이나 전체가 잠겨 있으면 맞아도 locked. */
  attempt(pin: unknown, client: string): PinAttempt;
};

const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();

/** 한 요청에서 살펴볼 같은 이름 쿠키의 최대 개수. */
const MAX_COOKIES = 8;

/** Cookie 머리글에서 이름이 name인 값들(경로가 다른 같은 이름 쿠키가 여럿 올 수 있다). */
function readCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
    if (out.length >= MAX_COOKIES) break;
  }
  return out;
}

export const isLoopback = (addr: string | undefined): boolean =>
  !!addr && (addr === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(addr));

/** 머리글 값(여러 줄이면 이어서)의 맨 오른쪽 항목. */
function rightmost(v: string | string[] | undefined): string {
  const parts = (Array.isArray(v) ? v.join(',') : (v ?? '')).split(',');
  return parts[parts.length - 1].trim();
}

/** 잠금을 셀 단위: IPv4는 주소 그대로, IPv4에 매핑된 IPv6는 IPv4로, IPv6는 /64(한 집·한 회선이 받는 범위)로 묶는다. */
function addressBucket(addr: string): string {
  let a = addr.trim();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(a);
  if (mapped) return mapped[1];
  if (isIP(a) !== 6) return a;
  // 끝에 붙은 IPv4(예: 64:ff9b::1.2.3.4)는 16비트 두 칸으로 바꾼다.
  a = a.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (_m, b1, b2, b3, b4) =>
    `${((+b1 << 8) | +b2).toString(16)}:${((+b3 << 8) | +b4).toString(16)}`);
  const [head, tail] = a.includes('::') ? a.split('::') : [a, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

/**
 * PIN 잠금을 셀 "접속한 곳". TRUST_PROXY이고 TCP 상대가 같은 컴퓨터(터널: ngrok·tailscale serve)이면
 * X-Forwarded-For의 맨 오른쪽 주소(그 터널이 붙인 실제 방문자 주소 — 왼쪽은 방문자가 써 보낼 수 있다). IP가 아니면 소켓 주소.
 * 그 밖에는 소켓 주소. IPv6는 /64로 묶는다.
 */
export function pinClientKey(peer: string | undefined, xff: string | string[] | undefined, trustProxy: boolean): string {
  const p = peer ?? 'unknown';
  if (trustProxy && isLoopback(p)) {
    const last = rightmost(xff);
    if (last && isIP(last)) return addressBucket(last);
  }
  return addressBucket(p);
}

/** TRUST_PROXY이고 TCP 상대가 같은 컴퓨터이며 X-Forwarded-Proto의 맨 오른쪽 값이 https인가. */
export function forwardedHttps(peer: string | undefined, xfp: string | string[] | undefined, trustProxy: boolean): boolean {
  return trustProxy && isLoopback(peer) && rightmost(xfp).toLowerCase() === 'https';
}

/**
 * pin: 숫자 PIN_LENGTH자리. secret: 쿠키 서명 비밀(PIN_SECRET). 없으면 프로세스마다 무작위라 재시작하면 기기가 다시 PIN을 넣는다.
 * 서명 입력에 PIN 해시를 넣으므로 PIN을 바꾸면 예전 쿠키는 모두 무효가 된다.
 */
export function createPinGate(opts: { pin: string; secret?: string }): PinGate {
  if (!isValidPin(opts.pin)) throw new Error(`FAMILY_PIN은 숫자 ${PIN_LENGTH}자리여야 합니다`);
  const pinDigest = sha256(opts.pin);
  const pinTag = pinDigest.toString('hex');
  const key = opts.secret ? sha256(`teacherboard-pin-secret:${opts.secret}`) : randomBytes(32);
  const mac = (issuedSec: number): Buffer => createHmac('sha256', key).update(`tb1.${issuedSec}.${pinTag}`).digest();

  type ClientState = { fails: number[]; lockedUntil: number; locks: number };
  const clients = new Map<string, ClientState>();
  let globalFails: number[] = [];
  let globalLockedUntil = 0;
  let globalLocks = 0;
  let dailyFails: number[] = [];
  let dailyLockedUntil = 0;
  let dailyLocks = 0;

  const prune = (now: number) => {
    if (clients.size <= MAX_TRACKED_CLIENTS) return;
    for (const [k, c] of clients) {
      // 잠금 횟수(locks)를 잊어도 되는 때: 마지막 잠금이 끝나고 최대 잠금 시간만큼 지났다.
      if (now >= c.lockedUntil + PIN_LOCK_MAX_MS && c.fails.every((t) => now - t >= PIN_WINDOW_MS)) clients.delete(k);
    }
  };
  const lockedFor = (until: number, now: number): PinAttempt => ({ kind: 'locked', retryAfterSec: Math.ceil((until - now) / 1000) });

  return {
    check(cookieHeader) {
      const nowSec = Math.floor(Date.now() / 1000);
      return readCookies(cookieHeader, PIN_COOKIE).some((v) => {
        const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(v);
        if (!m) return false;
        const issued = Number(m[1]);
        if (issued > nowSec + CLOCK_SKEW_S || nowSec - issued > PIN_COOKIE_MAX_AGE_S) return false;
        const got = Buffer.from(m[2], 'base64url');
        const want = mac(issued);
        return got.length === want.length && timingSafeEqual(got, want);
      });
    },

    attempt(pin, client) {
      const now = Date.now();
      const c = clients.get(client);
      const until = Math.max(globalLockedUntil, dailyLockedUntil, c?.lockedUntil ?? 0);
      if (now < until) return lockedFor(until, now);
      if (typeof pin !== 'string' || pin.length > MAX_INPUT) return { kind: 'invalid' };
      // 길이와 상관없이 같은 시간에 비교하도록 해시끼리 비교한다.
      if (timingSafeEqual(sha256(pin), pinDigest)) {
        clients.delete(client);
        globalLocks = 0;
        dailyLocks = 0;
        const issued = Math.floor(now / 1000);
        return { kind: 'ok', cookieValue: `${issued}.${mac(issued).toString('base64url')}` };
      }
      const st = c ?? { fails: [], lockedUntil: 0, locks: 0 };
      if (!c) {
        prune(now);
        clients.set(client, st);
      }
      st.fails = st.fails.filter((t) => now - t < PIN_WINDOW_MS);
      st.fails.push(now);
      globalFails = globalFails.filter((t) => now - t < PIN_WINDOW_MS);
      globalFails.push(now);
      if (st.fails.length >= PIN_MAX_FAILS) {
        st.fails = [];
        st.lockedUntil = now + Math.min(PIN_LOCK_MS * 2 ** st.locks, PIN_LOCK_MAX_MS);
        st.locks++;
      }
      if (globalFails.length >= PIN_GLOBAL_MAX_FAILS) {
        globalFails = [];
        if (now - globalLockedUntil >= PIN_GLOBAL_RESET_MS) globalLocks = 0; // 지난 전체 잠금이 끝난 지 오래됐다
        globalLockedUntil = now + Math.min(PIN_LOCK_MS * 2 ** globalLocks, PIN_LOCK_MAX_MS);
        globalLocks++;
      }
      dailyFails = dailyFails.filter((t) => now - t < PIN_DAILY_WINDOW_MS);
      dailyFails.push(now);
      if (dailyFails.length > PIN_DAILY_MAX_FAILS) {
        dailyFails = [];
        if (now - dailyLockedUntil >= PIN_DAILY_RESET_MS) dailyLocks = 0;
        dailyLockedUntil = now + Math.min(PIN_DAILY_LOCK_MS * 2 ** dailyLocks, PIN_DAILY_LOCK_MAX_MS);
        dailyLocks++;
      }
      const lockedUntil = Math.max(globalLockedUntil, dailyLockedUntil, st.lockedUntil);
      return now < lockedUntil ? lockedFor(lockedUntil, now) : { kind: 'wrong' };
    },
  };
}

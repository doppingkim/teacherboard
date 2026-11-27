// 가족 비밀번호: 서버 확인·PIN 보내기, 그리고 어느 API든 401이면 "다시 PIN 화면"을 알린다. DOM에 기대지 않는다.

export const PIN_LENGTH = 6;
/** 시작할 때 확인을 이만큼만 기다린다(서버가 멈춰도 화면은 뜬다). */
const CHECK_TIMEOUT_MS = 5000;
/** PIN을 보내고 답을 이만큼만 기다린다(넘으면 error: "다시 해 볼까?"가 뜨고 숫자판이 풀린다). */
export const SEND_PIN_TIMEOUT_MS = 15_000;

let unauthorized: (() => void) | null = null;

/** API가 401을 돌려줄 때마다 부를 함수(main.ts가 PIN 화면으로 돌아간다). null이면 뗀다. */
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorized = fn;
}

/** fetch와 같다. 응답이 401이면 onUnauthorized로 알린다(응답은 그대로 돌려준다). */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(input, init);
  if (r.status === 401) {
    try {
      unauthorized?.();
    } catch {
      // 알림 쪽 문제로 요청 처리를 멈추지 않는다
    }
  }
  return r;
}

/**
 * 이 기기가 들어와 있나(GET /api/pin). 401이면 'need'. 서버가 안 되면(네트워크·5xx·시간 초과) 'ok' —
 * PIN 화면에 가두지 않고 수업에서 평소 오류 문구를 보여 준다.
 */
export async function checkPin(): Promise<'ok' | 'need'> {
  try {
    const r = await fetch('/api/pin', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    return r.status === 401 ? 'need' : 'ok';
  } catch {
    return 'ok';
  }
}

export type PinResult = { kind: 'ok' } | { kind: 'wrong' } | { kind: 'locked'; retryAfterSec: number } | { kind: 'error' };

/** PIN을 보낸다. 맞으면 서버가 HttpOnly 쿠키를 심는다. 틀린 401은 onUnauthorized로 알리지 않는다. */
export async function sendPin(pin: string): Promise<PinResult> {
  let r: Response;
  // 서버·터널이 멈춰도 숫자판이 영영 막히지 않게(보내는 동안 숫자판을 막는다) 시간을 정한다.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('pin timeout', 'TimeoutError')), SEND_PIN_TIMEOUT_MS);
  try {
    r = await fetch('/api/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
      credentials: 'same-origin',
      signal: ac.signal,
    });
  } catch {
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
  if (r.ok) return { kind: 'ok' };
  if (r.status === 401) return { kind: 'wrong' };
  if (r.status === 429) {
    let sec = Number(r.headers.get('retry-after'));
    try {
      const body = (await r.json()) as { retryAfterSec?: unknown };
      if (typeof body.retryAfterSec === 'number') sec = body.retryAfterSec;
    } catch {
      // 본문이 없으면 Retry-After 머리글
    }
    return { kind: 'locked', retryAfterSec: Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : 60 };
  }
  return { kind: 'error' };
}

/** 키패드로 넣는 숫자들. */
export class PinEntry {
  private digits = '';
  constructor(readonly size = PIN_LENGTH) {}

  get value(): string {
    return this.digits;
  }
  get length(): number {
    return this.digits.length;
  }
  get full(): boolean {
    return this.digits.length >= this.size;
  }

  /** 숫자 하나를 더한다. 이 숫자로 막 다 찼으면 true(자동으로 보낼 때). 숫자가 아니거나 이미 찼으면 무시. */
  push(d: string): boolean {
    if (this.full || !/^\d$/.test(d)) return false;
    this.digits += d;
    return this.full;
  }

  back(): void {
    this.digits = this.digits.slice(0, -1);
  }

  clear(): void {
    this.digits = '';
  }
}

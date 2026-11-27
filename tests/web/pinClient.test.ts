import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiFetch, checkPin, onUnauthorized, PinEntry, SEND_PIN_TIMEOUT_MS, sendPin } from '../../src/web/pinClient';
import { streamLesson } from '../../src/web/player/lessonClient';

afterEach(() => {
  vi.unstubAllGlobals();
  onUnauthorized(null);
});

describe('checkPin', () => {
  test('204 → ok, 401 → need', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    expect(await checkPin()).toBe('ok');
    expect(f).toHaveBeenCalledWith('/api/pin', expect.objectContaining({ credentials: 'same-origin' }));
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    expect(await checkPin()).toBe('need');
  });

  test('서버가 안 되면(네트워크·5xx) ok로 보고 지나간다(수업에서 오류를 보여 준다)', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('failed'); });
    expect(await checkPin()).toBe('ok');
    vi.stubGlobal('fetch', async () => new Response('', { status: 502 }));
    expect(await checkPin()).toBe('ok');
  });
});

describe('sendPin', () => {
  test('PIN을 JSON으로 POST하고 결과를 나눈다', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    expect(await sendPin('123456')).toEqual({ kind: 'ok' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/pin');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ pin: '123456' });

    vi.stubGlobal('fetch', async () => new Response('{"error":"wrong"}', { status: 401 }));
    expect(await sendPin('000000')).toEqual({ kind: 'wrong' });
    vi.stubGlobal('fetch', async () => new Response('{"error":"locked","retryAfterSec":125}', { status: 429 }));
    expect(await sendPin('000000')).toEqual({ kind: 'locked', retryAfterSec: 125 });
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    expect(await sendPin('000000')).toEqual({ kind: 'locked', retryAfterSec: 30 });
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    expect(await sendPin('000000')).toEqual({ kind: 'error' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('failed'); });
    expect(await sendPin('000000')).toEqual({ kind: 'error' });
  });

  test('서버가 답하지 않으면(멈춘 터널 등) 정해진 시간 뒤 error — 숫자판이 영영 막히지 않는다', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.stubGlobal('fetch', (_u: string, init?: RequestInit) => new Promise<Response>((_ok, fail) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => fail(signal!.reason));
      }));
      const p = sendPin('123456');
      let done = false;
      void p.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(SEND_PIN_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ kind: 'error' });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('429 남은 초: 본문 > Retry-After > 60초, 0·음수·숫자 아님은 60초', async () => {
    const r429 = (body: string, retry?: string) => async () => new Response(body, { status: 429, headers: retry ? { 'retry-after': retry } : {} });
    vi.stubGlobal('fetch', r429('{"retryAfterSec":12.2}', '99'));
    expect(await sendPin('000000')).toEqual({ kind: 'locked', retryAfterSec: 13 });
    vi.stubGlobal('fetch', r429('not json'));
    expect(await sendPin('000000')).toEqual({ kind: 'locked', retryAfterSec: 60 });
    vi.stubGlobal('fetch', r429('{"retryAfterSec":-5}'));
    expect(await sendPin('000000')).toEqual({ kind: 'locked', retryAfterSec: 60 });
    vi.stubGlobal('fetch', r429('{"retryAfterSec":"30"}', 'abc'));
    expect(await sendPin('000000')).toEqual({ kind: 'locked', retryAfterSec: 60 });
  });

  test('400(모양이 틀림)·403(Host 거절)은 error', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 400 }));
    expect(await sendPin('12')).toEqual({ kind: 'error' });
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 403 }));
    expect(await sendPin('123456')).toEqual({ kind: 'error' });
  });

  test('틀린 PIN의 401은 "다시 PIN 화면" 알림을 울리지 않는다', async () => {
    const seen = vi.fn();
    onUnauthorized(seen);
    vi.stubGlobal('fetch', async () => new Response('{"error":"wrong"}', { status: 401 }));
    await sendPin('000000');
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('apiFetch / onUnauthorized', () => {
  test('401이면 알리고 응답은 그대로 돌려준다', async () => {
    const seen = vi.fn();
    onUnauthorized(seen);
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    expect((await apiFetch('/api/filler/kid')).status).toBe(401);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', async () => new Response('[]', { status: 200 }));
    await apiFetch('/api/filler/kid');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test('수업 요청이 401이면 알린다', async () => {
    const seen = vi.fn();
    onUnauthorized(seen);
    vi.stubGlobal('fetch', async () => new Response('{"error":"pin"}', { status: 401 }));
    const it = streamLesson('달?', 'kid', new AbortController().signal)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/401/);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('PinEntry', () => {
  test('숫자만 6자리까지, 지우기, 다 차면 full', () => {
    const e = new PinEntry(6);
    expect(e.push('1')).toBe(false);
    e.push('x');
    expect(e.length).toBe(1);
    for (const d of '23456') e.push(d);
    expect(e.full).toBe(true);
    expect(e.value).toBe('123456');
    expect(e.push('7')).toBe(false); // 다 찼으면 더 받지 않는다
    expect(e.value).toBe('123456');
    e.back();
    expect(e.value).toBe('12345');
    expect(e.push('9')).toBe(true); // 이번 숫자로 다 찼다
    e.clear();
    expect(e.length).toBe(0);
    e.back();
    expect(e.length).toBe(0);
  });
});

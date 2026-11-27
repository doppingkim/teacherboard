import { MODEL_ID, synthesize, TtsError } from '../../src/server/tts';

const ok = {
  audio_base64: 'AAAA',
  alignment: {
    characters: ['달', '!'],
    character_start_times_seconds: [0, 0.25],
    character_end_times_seconds: [0.25, 0.4],
  },
};

test('응답을 ms 타이밍으로 바꾼다', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
  const sp = await synthesize('달!', 'v1', 'k', new AbortController().signal, f as any);
  expect(sp.timing).toEqual({ chars: ['달', '!'], startMs: [0, 250], endMs: [250, 400] });
  expect(sp.durationMs).toBe(400);
  expect(sp.audioBase64).toBe('AAAA');
  expect(sp.mime).toBe('audio/mpeg');
  const [url, init] = f.mock.calls[0] as any;
  expect(url).toContain('/v1/text-to-speech/v1/with-timestamps');
  expect(url).toContain('output_format=mp3_44100_128');
  expect(JSON.parse(init.body)).toEqual({ text: '달!', model_id: 'eleven_v4_turbo' }); // 말투 태그 없음, 앞 문장 없으면 previous_text도 없음
  expect(MODEL_ID).toBe('eleven_v4_turbo');
  expect(init.headers['xi-api-key']).toBe('k');
});

test('200이 아니면 TtsError(status)', async () => {
  const f = async () => new Response('busy', { status: 429 });
  const p = synthesize('a', 'v', 'k', new AbortController().signal, f as any);
  await expect(p).rejects.toMatchObject({ status: 429 });
  await expect(p).rejects.toBeInstanceOf(TtsError);
});

test('alignment가 없으면 TtsError', async () => {
  const f = async () => new Response(JSON.stringify({ audio_base64: 'AAAA' }), { status: 200 });
  await expect(synthesize('a', 'v', 'k', new AbortController().signal, f as any)).rejects.toBeInstanceOf(TtsError);
});

const resp = (body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
const sig = () => new AbortController().signal;

test('start 배열이 없으면 TtsError(502)', async () => {
  const { character_start_times_seconds: _s, ...al } = ok.alignment;
  await expect(synthesize('a', 'v', 'k', sig(), resp({ ...ok, alignment: al }) as any)).rejects.toMatchObject({ name: 'TtsError', status: 502 });
});
test('배열 길이가 다르면 TtsError', async () => {
  const bad = { ...ok, alignment: { ...ok.alignment, character_end_times_seconds: [0.25] } };
  await expect(synthesize('a', 'v', 'k', sig(), resp(bad) as any)).rejects.toBeInstanceOf(TtsError);
});
test('JSON이 아닌 200 본문은 TtsError(502)', async () => {
  await expect(synthesize('a', 'v', 'k', sig(), resp('<html>') as any)).rejects.toMatchObject({ name: 'TtsError', status: 502 });
});

test('describeTtsError: TtsError는 상태와 메시지, 그 밖은 이름과 메시지', async () => {
  const { describeTtsError } = await import('../../src/server/tts');
  expect(describeTtsError(new TtsError(429, 'ElevenLabs 429: busy'))).toBe('TtsError 429: ElevenLabs 429: busy');
  expect(describeTtsError(new TypeError('fetch failed'))).toBe('TypeError: fetch failed');
  expect(describeTtsError('x')).toBe('x');
});

/** 신호가 끊길 때까지 응답하지 않는 fetch. */
const hangingFetch = vi.fn((_url: string, init: RequestInit) =>
  new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))));

test('응답이 시간 안에 안 오면 TtsError(504)', async () => {
  const p = synthesize('a', 'v', 'k', sig(), hangingFetch as any, 20);
  await expect(p).rejects.toBeInstanceOf(TtsError);
  await expect(p).rejects.toMatchObject({ status: 504 });
});
test('기본 시간 제한은 15초', async () => {
  const spy = vi.spyOn(AbortSignal, 'timeout');
  try {
    const f = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    await synthesize('달!', 'v1', 'k', sig(), f as any);
    expect(spy).toHaveBeenCalledWith(15_000);
  } finally {
    spy.mockRestore();
  }
});
test('바깥 신호로 중단되면 TtsError가 아니라 중단으로 전해진다', async () => {
  const ac = new AbortController();
  const p = synthesize('a', 'v', 'k', ac.signal, hangingFetch as any, 10_000);
  ac.abort();
  const err = await p.catch((e) => e);
  expect(err).not.toBeInstanceOf(TtsError);
  expect(err).toMatchObject({ name: 'AbortError' });
});

test('앞 문장을 previous_text로 넘긴다(억양 잇기)', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
  await synthesize('달!', 'v1', 'k', new AbortController().signal, f as any, undefined, '해가 졌어.');
  const [, init] = f.mock.calls[0] as any;
  expect(JSON.parse(init.body)).toEqual({ text: '달!', model_id: 'eleven_v4_turbo', previous_text: '해가 졌어.' });
});

// QA 2026-11-22: 타이밍에 숫자가 아닌 값이 오면 NaN/null 타이밍이 브라우저로 그대로 갔다.
test.each([
  ['시작 시각이 문자열', { characters: ['a'], character_start_times_seconds: ['x'], character_end_times_seconds: [0.1] }],
  ['끝 시각이 null', { characters: ['a'], character_start_times_seconds: [0], character_end_times_seconds: [null] }],
  ['글자가 문자열이 아님', { characters: [1], character_start_times_seconds: [0], character_end_times_seconds: [0.1] }],
])('타이밍 값이 잘못되면(%s) TtsError(502)', async (_n, alignment) => {
  const f = async () => new Response(JSON.stringify({ audio_base64: 'AAAA', alignment }), { status: 200 });
  await expect(synthesize('a', 'v', 'k', new AbortController().signal, f as any)).rejects.toMatchObject({ status: 502 });
});

describe('특수문자·경계값(QA 2026-11-22)', () => {
  const okFetch = () => vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
  test('따옴표·역슬래시·줄바꿈·이모지가 든 문장도 JSON 본문으로 그대로 간다', async () => {
    const f = okFetch();
    const text = '그는 "안녕\\" 했어\n😀 & <b>';
    await synthesize(text, 'v', 'k', new AbortController().signal, f as any);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).text).toBe(text);
  });
  test('목소리 id는 URL 경로에 인코딩해 넣는다(경로 바꾸기 불가)', async () => {
    const f = okFetch();
    await synthesize('a', '../x?y#z', 'k', new AbortController().signal, f as any);
    expect((f.mock.calls[0] as any)[0]).toContain('/v1/text-to-speech/..%2Fx%3Fy%23z/with-timestamps');
  });
  test('빈 앞 문장은 previous_text로 보내지 않는다', async () => {
    const f = okFetch();
    await synthesize('a', 'v', 'k', new AbortController().signal, f as any, undefined, '');
    expect(JSON.parse((f.mock.calls[0] as any)[1].body)).not.toHaveProperty('previous_text');
  });
  test('글자가 하나도 없는 정렬(빈 배열)은 길이 0으로 받는다', async () => {
    const f = async () => new Response(JSON.stringify({ audio_base64: 'AAAA', alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] } }), { status: 200 });
    await expect(synthesize('...', 'v', 'k', new AbortController().signal, f as any)).resolves.toMatchObject({ durationMs: 0 });
  });
  test('오류 본문은 200자까지만 메시지에 담는다', async () => {
    const f = async () => new Response('x'.repeat(5000), { status: 500 });
    const err = await synthesize('a', 'v', 'k', new AbortController().signal, f as any).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.message.length).toBeLessThan(230);
  });
});

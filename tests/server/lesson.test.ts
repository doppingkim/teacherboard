import { limiter, MAX_BOARD_OPS, MAX_SAYS, runLesson } from '../../src/server/lesson';
import type { LessonMessage, Speech } from '../../src/shared/lesson';
import type { FigureOp, SketchOrder } from '../../src/shared/script';

async function* lines(...xs: string[]) { for (const x of xs) yield x + '\n'; }
const sp = (t: string): Speech => ({ audioBase64: t, mime: 'audio/mpeg', timing: { chars: [...t], startMs: [], endMs: [] }, durationMs: 100 });
const collect = async (g: AsyncGenerator<LessonMessage>) => { const out: LessonMessage[] = []; for await (const m of g) out.push(m); return out; };
const SAY = (t: string) => JSON.stringify({ say: t });
const DRAW = JSON.stringify({ draw: { kind: 'text', role: 'title', text: '제목', ink: 'black' } });

test('순서: say1, 그 draw, say2, done', async () => {
  const out = await collect(runLesson({ scriptText: lines(SAY('하나'), DRAW, SAY('둘')), speak: async t => sp(t) }));
  expect(out.map(m => m.type)).toEqual(['say', 'draw', 'say', 'done']);
  expect(out[1]).toMatchObject({ sayId: 1 });
});
test('say2의 TTS는 say1의 TTS가 끝나기 전에 시작된다', async () => {
  const started: string[] = []; let release!: () => void; const gate = new Promise<void>(r => (release = r));
  const speak = async (t: string) => { started.push(t); if (t === '하나') await gate; return sp(t); };
  const g = runLesson({ scriptText: lines(SAY('하나'), SAY('둘')), speak });
  const p = collect(g); await new Promise(r => setTimeout(r, 20));
  expect(started).toEqual(['하나', '둘']); release(); await p;
});
test('TTS에 바로 앞 문장을 넘긴다(첫 문장은 없음, 사이의 판서는 건너뜀)', async () => {
  const seen: [string, string | undefined][] = [];
  await collect(runLesson({ scriptText: lines(SAY('하나'), DRAW, SAY('둘'), SAY('셋')), speak: async (t, prev) => { seen.push([t, prev]); return sp(t); } }));
  expect(seen).toEqual([['하나', undefined], ['둘', '하나'], ['셋', '둘']]);
});
test('TTS 실패해도 계속: speech null', async () => {
  const out = await collect(runLesson({ scriptText: lines(SAY('하나'), SAY('둘')), speak: async t => { if (t === '하나') throw new Error('x'); return sp(t); } }));
  expect(out[0]).toMatchObject({ type: 'say', id: 1, speech: null });
  expect(out[1]).toMatchObject({ type: 'say', id: 2, speech: { audioBase64: '둘' } });
});
test('깨진 줄은 건너뛴다', async () => {
  const out = await collect(runLesson({ scriptText: lines('{"say":', SAY('정상')), speak: async t => sp(t) }));
  expect(out.map(m => m.type)).toEqual(['say', 'done']);
});
test('대본 스트림 오류 → error 메시지로 끝남', async () => {
  async function* bad() { yield SAY('하나') + '\n'; throw new Error('boom'); }
  const out = await collect(runLesson({ scriptText: bad(), speak: async t => sp(t) }));
  expect(out.at(-1)).toMatchObject({ type: 'error' });
});

// --- 브리프 외 추가 테스트 ---
test('동시 TTS는 maxParallelTts를 넘지 않는다', async () => {
  let active = 0, peak = 0;
  const speak = async (t: string) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return sp(t); };
  const says = Array.from({ length: 7 }, (_, i) => SAY(`문장${i}`));
  const out = await collect(runLesson({ scriptText: lines(...says), speak, maxParallelTts: 2 }));
  expect(out.filter(m => m.type === 'say').map(m => (m as { id: number }).id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(peak).toBe(2);
});
test('기본 동시 TTS 한도는 3', async () => {
  let active = 0, peak = 0;
  const speak = async (t: string) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return sp(t); };
  await collect(runLesson({ scriptText: lines(...Array.from({ length: 6 }, (_, i) => SAY(`s${i}`))), speak }));
  expect(peak).toBe(3);
});
test('줄바꿈 없는 마지막 줄과 page도 처리하고, onEnd로 통계를 알린다', async () => {
  async function* chunks() { yield '{"sa'; yield 'y":"하나"}\n{"page":true}\nnot json\n'; yield SAY('끝'); }
  const onEnd = vi.fn();
  const out = await collect(runLesson({ scriptText: chunks(), speak: async t => sp(t), onEnd }));
  expect(out.map(m => m.type)).toEqual(['say', 'page', 'say', 'done']);
  expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ says: 2, droppedLines: 1 }));
});
test('오류 메시지에는 내부 오류 내용이 그대로 나가지 않는다', async () => {
  async function* bad() { throw new Error('secret-key-sk-123'); }
  const onEnd = vi.fn();
  const out = await collect(runLesson({ scriptText: bad(), speak: async t => sp(t), onEnd }));
  expect(out).toHaveLength(1);
  expect(out[0].type).toBe('error');
  expect(JSON.stringify(out[0])).not.toContain('secret');
  expect(onEnd.mock.calls[0][0].error).toBeInstanceOf(Error);
});
test('소비자가 일찍 멈추면 대본 읽기도 멈춘다', async () => {
  let pulled = 0;
  async function* many() { for (let i = 0; i < 100; i++) { pulled++; yield SAY(`s${i}`) + '\n'; await new Promise(r => setTimeout(r, 1)); } }
  const g = runLesson({ scriptText: many(), speak: async t => sp(t) });
  await g.next();
  await g.return(undefined);
  const at = pulled;
  await new Promise(r => setTimeout(r, 30));
  expect(pulled).toBeLessThanOrEqual(at + 1);
});

test('limiter: 자리가 풀리는 같은 틱에 새 호출이 와도 한도를 넘지 않고 FIFO를 지킨다', async () => {
  const lim = limiter(1);
  const started: string[] = [];
  let running = 0, peak = 0;
  let releaseA!: () => void; const gateA = new Promise<void>(r => (releaseA = r));
  let releaseB!: () => void; const gateB = new Promise<void>(r => (releaseB = r));
  const held = (name: string, gate: Promise<void>) => () => {
    started.push(name); running++; peak = Math.max(peak, running);
    return gate.then(() => { running--; });
  };
  // A의 fn은 gateA를 그대로 돌려준다 → limiter의 await가 gateA의 첫 반응이 된다.
  const a = lim(() => { started.push('A'); return gateA; });
  const b = lim(held('B', gateB));
  let c: Promise<void> | undefined;
  // 두 번째 반응: limiter가 A의 자리를 푼 직후, 깨어난 B가 실행되기 전에 C가 들어온다.
  const cQueued = gateA.then(() => { c = lim(held('C', Promise.resolve())); });
  releaseA();
  await a; await cQueued; await new Promise(r => setTimeout(r, 0));
  expect(started).toEqual(['A', 'B']); // C는 B 뒤에서 기다려야 한다
  releaseB();
  await b; await c;
  expect(started).toEqual(['A', 'B', 'C']);
  expect(peak).toBe(1);
});
test('onEnd가 던져도 스트림은 정상으로 끝난다', async () => {
  const out = await collect(runLesson({ scriptText: lines(SAY('하나')), speak: async t => sp(t), onEnd: () => { throw new Error('log down'); } }));
  expect(out.map(m => m.type)).toEqual(['say', 'done']);
});

test('TTS 실패 수를 세고 첫 오류를 통계에 남긴다(중단은 세지 않는다)', async () => {
  const { TtsError } = await import('../../src/server/tts');
  const onEnd = vi.fn();
  const speak = async (t: string) => {
    if (t === '하나') throw new TtsError(429, 'ElevenLabs 429: busy');
    if (t === '둘') throw new TtsError(500, 'ElevenLabs 500: down');
    if (t === '셋') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return sp(t);
  };
  const out = await collect(runLesson({ scriptText: lines(SAY('하나'), SAY('둘'), SAY('셋'), SAY('넷')), speak, onEnd }));
  expect(out.map(m => m.type)).toEqual(['say', 'say', 'say', 'say', 'done']);
  const stats = onEnd.mock.calls[0][0];
  expect(stats.ttsFailures).toBe(2);
  expect(stats.firstTtsError).toMatchObject({ name: 'TtsError', status: 429 });
});
test('TTS가 모두 성공하면 ttsFailures 0', async () => {
  const onEnd = vi.fn();
  await collect(runLesson({ scriptText: lines(SAY('하나')), speak: async t => sp(t), onEnd }));
  expect(onEnd.mock.calls[0][0]).toMatchObject({ ttsFailures: 0 });
  expect(onEnd.mock.calls[0][0].firstTtsError).toBeUndefined();
});
test('화가가 없으면: 그림 주문은 곧바로 figure null로 알리고, 보여 주기는 draw로 나간다', async () => {
  const ORDER = JSON.stringify({ sketch: { id: '병사', size: 'small', describe: '투구 쓴 병사' } });
  const SHOW = JSON.stringify({ draw: { kind: 'sketch', id: '병사' }, at: '병사' });
  const out = await collect(runLesson({ scriptText: lines(ORDER, SAY('병사가 있었어'), SHOW), speak: async t => sp(t) }));
  expect(out.map(m => m.type)).toEqual(['sketch', 'say', 'draw', 'done']);
  expect(out[0]).toEqual({ type: 'sketch', id: '병사', figure: null });
  expect(out[2]).toMatchObject({ type: 'draw', sayId: 1, at: '병사', op: { kind: 'sketch', id: '병사', size: 'small' } });
});

// --- Task 3: 화가 연결 ---
const ORDER = (id: string, describe = `${id} 그림`) => JSON.stringify({ sketch: { id, size: 'small', describe } });
const FIG = (id: string): FigureOp => ({ kind: 'figure', id, size: 'small', ink: 'black', strokes: ['M0 0 L10 10'] });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** 밖에서 풀어 주는 promise. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('느린 그림이 say를 막지 않는다', async () => {
  const fig = deferred<FigureOp | null>();
  const g = runLesson({
    scriptText: lines(SAY('하나'), ORDER('병사'), SAY('둘')),
    speak: async (t) => sp(t),
    drawSketch: () => fig.promise,
  });
  const first = await g.next();
  const second = await g.next();
  expect([first.value, second.value].map((m) => (m as LessonMessage).type)).toEqual(['say', 'say']);
  fig.resolve(FIG('병사'));
  const rest = await collect(g);
  expect(rest).toEqual([{ type: 'sketch', id: '병사', figure: FIG('병사') }, { type: 'done' }]);
});

test('완성된 그림은 say 대기 중에도 먼저 나간다', async () => {
  const tts = deferred<void>();
  const fig = deferred<FigureOp | null>();
  const g = runLesson({
    scriptText: lines(SAY('하나'), ORDER('병사'), SAY('둘')),
    speak: async (t) => { if (t === '둘') await tts.promise; return sp(t); },
    drawSketch: () => fig.promise,
  });
  expect((await g.next()).value).toMatchObject({ type: 'say', id: 1 });
  const pending = g.next(); // say 2는 TTS를 기다리는 중
  await tick(10);
  fig.resolve(FIG('병사'));
  expect((await pending).value).toEqual({ type: 'sketch', id: '병사', figure: FIG('병사') });
  tts.resolve();
  const rest = await collect(g);
  expect(rest.map((m) => m.type)).toEqual(['say', 'done']);
  expect(rest[0]).toMatchObject({ id: 2, speech: { audioBase64: '둘' } });
});

test('그림 실패 → {type:"sketch", figure:null}, sketchFailures 1', async () => {
  const onEnd = vi.fn();
  const out = await collect(runLesson({
    scriptText: lines(SAY('하나'), ORDER('병사'), SAY('둘')),
    speak: async (t) => sp(t),
    drawSketch: async () => null,
    onEnd,
  }));
  expect(out).toContainEqual({ type: 'sketch', id: '병사', figure: null });
  expect(out.at(-1)).toEqual({ type: 'done' });
  const stats = onEnd.mock.calls[0][0];
  expect(stats).toMatchObject({ sketches: 1, sketchFailures: 1 });
  expect(stats.sketchMs).toHaveLength(1);
  expect(Number.isInteger(stats.sketchMs[0]) && stats.sketchMs[0] >= 0).toBe(true);
});

test('화가가 계약을 어기고 던져도 figure null로 받고 실패로 센다', async () => {
  const onEnd = vi.fn();
  const out = await collect(runLesson({
    scriptText: lines(SAY('하나'), ORDER('성')),
    speak: async (t) => sp(t),
    drawSketch: async () => { throw new Error('artist exploded'); },
    onEnd,
  }));
  expect(out.map((m) => m.type)).toEqual(['say', 'sketch', 'done']);
  expect(out[1]).toEqual({ type: 'sketch', id: '성', figure: null });
  expect(onEnd.mock.calls[0][0]).toMatchObject({ sketches: 1, sketchFailures: 1 });
});

test('성공한 그림은 실패로 세지 않고, 걸린 시간을 남긴다', async () => {
  const onEnd = vi.fn();
  await collect(runLesson({
    scriptText: lines(SAY('하나'), ORDER('병사')),
    speak: async (t) => sp(t),
    drawSketch: async (o) => { await tick(20); return FIG(o.id); },
    onEnd,
  }));
  const stats = onEnd.mock.calls[0][0];
  expect(stats).toMatchObject({ sketches: 1, sketchFailures: 0 });
  expect(stats.sketchMs[0]).toBeGreaterThanOrEqual(15);
});

test('동시 화가 호출 최대 4', async () => {
  let active = 0, peak = 0;
  const started: string[] = [];
  const drawSketch = async (o: SketchOrder) => {
    started.push(o.id); active++; peak = Math.max(peak, active);
    await tick(10);
    active--;
    return FIG(o.id);
  };
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const out = await collect(runLesson({ scriptText: lines(SAY('하나'), ...ids.map((id) => ORDER(id))), speak: async (t) => sp(t), drawSketch }));
  expect(peak).toBe(4);
  expect(started).toEqual(ids); // FIFO
  expect(out.filter((m) => m.type === 'sketch').map((m) => (m as { id: string }).id).sort()).toEqual(ids);
  expect(out.at(-1)).toEqual({ type: 'done' });
});

test('maxParallelSketch로 화가 동시 호출 수를 바꿀 수 있다', async () => {
  let active = 0, peak = 0;
  const drawSketch = async (o: SketchOrder) => { active++; peak = Math.max(peak, active); await tick(5); active--; return FIG(o.id); };
  await collect(runLesson({ scriptText: lines(SAY('하나'), ORDER('a'), ORDER('b'), ORDER('c')), speak: async (t) => sp(t), drawSketch, maxParallelSketch: 1 }));
  expect(peak).toBe(1);
});

test('done은 마지막 그림이 끝난 뒤에 나온다(고정 유예 없음, 일찍 abort하지 않음)', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const signals: AbortSignal[] = [];
    const onEnd = vi.fn();
    // 대본은 곧바로 끝나지만 그림은 10초(화가 시간 제한 12초 안) 걸린다.
    const drawSketch = (o: SketchOrder, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<FigureOp | null>((r) => setTimeout(() => r(FIG(o.id)), o.id === '빠름' ? 1000 : 10_000));
    };
    const out: LessonMessage[] = [];
    let ended = false;
    const p = (async () => {
      for await (const m of runLesson({ scriptText: lines(SAY('하나'), ORDER('빠름'), ORDER('느림')), speak: async (t) => sp(t), drawSketch, onEnd })) out.push(m);
      ended = true;
    })();
    await vi.advanceTimersByTimeAsync(1000);
    expect(out.map((m) => m.type)).toEqual(['say', 'sketch']);
    await vi.advanceTimersByTimeAsync(8000); // 9초: 예전 3초 유예라면 이미 버렸을 때
    expect(ended).toBe(false);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(out.map((m) => m.type)).toEqual(['say', 'sketch', 'sketch', 'done']);
    expect(out[2]).toEqual({ type: 'sketch', id: '느림', figure: FIG('느림') });
    expect(onEnd.mock.calls[0][0]).toMatchObject({ sketches: 2, sketchFailures: 0 });
    expect(onEnd.mock.calls[0][0].sketchMs).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test('화가 시간 초과(null) → done 전에 {type:"sketch", figure:null}을 보낸다', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const onEnd = vi.fn();
    // 진짜 화가처럼 12초 시간 제한에 걸리면 null.
    const drawSketch = () => new Promise<FigureOp | null>((r) => setTimeout(() => r(null), 12_000));
    const out: LessonMessage[] = [];
    const p = (async () => {
      for await (const m of runLesson({ scriptText: lines(SAY('하나'), ORDER('협상')), speak: async (t) => sp(t), drawSketch, onEnd })) out.push(m);
    })();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(out.map((m) => m.type)).toEqual(['say']);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(out).toEqual([expect.objectContaining({ type: 'say' }), { type: 'sketch', id: '협상', figure: null }, { type: 'done' }]);
    expect(onEnd.mock.calls[0][0]).toMatchObject({ sketches: 1, sketchFailures: 1 });
  } finally {
    vi.useRealTimers();
  }
});

test('끝을 기다리는 중 요청이 abort되면(연결 끊김) 화가를 abort하고 그림 메시지 없이 끝낸다', async () => {
  const signals: AbortSignal[] = [];
  const onEnd = vi.fn();
  const req = new AbortController();
  const g = runLesson({
    scriptText: lines(SAY('하나'), ORDER('병사')),
    speak: async (t) => sp(t),
    // 진짜 화가처럼 abort되면 null을 돌려준다.
    drawSketch: (_o, signal) => { signals.push(signal); return new Promise((r) => signal.addEventListener('abort', () => r(null))); },
    signal: req.signal,
    onEnd,
  });
  expect((await g.next()).value).toMatchObject({ type: 'say' });
  const pending = g.next(); // 대본은 끝났고 그림을 기다리는 중
  await tick(20);
  expect(signals[0].aborted).toBe(false);
  req.abort();
  expect(signals[0].aborted).toBe(true);
  expect((await pending).value).toEqual({ type: 'done' }); // figure:null 메시지는 없다
  expect((await g.next()).done).toBe(true);
  expect(onEnd.mock.calls[0][0]).toMatchObject({ sketches: 1, sketchFailures: 0 });
});

test('남은 그림이 없으면 done을 기다리지 않는다', async () => {
  const t0 = performance.now();
  const out = await collect(runLesson({ scriptText: lines(SAY('하나'), ORDER('병사')), speak: async (t) => sp(t), drawSketch: async (o) => FIG(o.id) }));
  expect(out.map((m) => m.type)).toEqual(['say', 'sketch', 'done']);
  expect(performance.now() - t0).toBeLessThan(500);
});

test('대본 오류로 끝나도 남은 그림을 먼저 보내고 error', async () => {
  async function* bad() { yield SAY('하나') + '\n'; yield ORDER('병사') + '\n'; throw new Error('boom'); }
  const out = await collect(runLesson({ scriptText: bad(), speak: async (t) => sp(t), drawSketch: async (o) => { await tick(20); return FIG(o.id); } }));
  expect(out.map((m) => m.type)).toEqual(['say', 'sketch', 'error']);
});

test('abort → 화가 signal도 abort', async () => {
  const signals: AbortSignal[] = [];
  const onEnd = vi.fn();
  const g = runLesson({
    scriptText: lines(SAY('하나'), ORDER('병사')),
    speak: async (t) => sp(t),
    drawSketch: (_o, signal) => { signals.push(signal); return new Promise(() => {}); },
    onEnd,
  });
  await g.next(); // say 1
  await tick(10);
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(false);
  await g.return(undefined); // 소비자가 멈춤(연결 끊김)
  expect(signals[0].aborted).toBe(true);
  // 연결 끊김으로 버린 그림은 실패로 세지 않는다.
  expect(onEnd.mock.calls[0][0]).toMatchObject({ sketches: 1, sketchFailures: 0 });
});

test('멈춘 뒤 자리를 기다리던 주문은 화가를 부르지 않는다', async () => {
  const called: string[] = [];
  const g = runLesson({
    scriptText: lines(SAY('하나'), ORDER('a'), ORDER('b')),
    speak: async (t) => sp(t),
    drawSketch: (o, signal) => { called.push(o.id); return new Promise((r) => signal.addEventListener('abort', () => r(null))); },
    maxParallelSketch: 1,
  });
  await g.next();
  await tick(10);
  expect(called).toEqual(['a']);
  await g.return(undefined);
  await tick(10);
  expect(called).toEqual(['a']);
});

// QA 2026-11-22: 모델이 같은 말을 되풀이하며 폭주하면 say마다 TTS(유료)를 불렀다.
test(`say는 수업당 ${MAX_SAYS}개까지: 넘으면 대본 읽기를 멈추고 TTS도 더 부르지 않는다`, async () => {
  let calls = 0;
  let read = 0;
  async function* flood() { for (let i = 0; i < 500; i++) { read++; yield SAY(`문장${i}`) + '\n'; } }
  const onEnd = vi.fn();
  const out = await collect(runLesson({ scriptText: flood(), speak: async (t) => { calls++; return sp(t); }, onEnd }));
  expect(out.filter((m) => m.type === 'say')).toHaveLength(MAX_SAYS);
  expect(calls).toBe(MAX_SAYS);
  expect(read).toBeLessThanOrEqual(MAX_SAYS + 1);
  expect(out.at(-1)).toEqual({ type: 'done' });
  expect(onEnd.mock.calls[0][0]).toMatchObject({ says: MAX_SAYS });
});
test('한도 직전 say에 붙은 판서는 그대로 나간다', async () => {
  const says = Array.from({ length: MAX_SAYS }, (_, i) => SAY(`s${i}`));
  const out = await collect(runLesson({ scriptText: lines(...says, DRAW, SAY('넘침'), DRAW), speak: async (t) => sp(t) }));
  expect(out.filter((m) => m.type === 'draw')).toHaveLength(1);
  expect(out.at(-2)).toMatchObject({ type: 'draw', sayId: MAX_SAYS });
});

// QA 2026-11-22: 말이 하나도 없는 대본(빈 응답, 모두 깨진 줄)은 done으로 끝나 빈 칠판에 "또 궁금한 거 있어?"만 떴다.
test('말(say)이 하나도 없으면 done 대신 error로 끝나고 통계에 이유를 남긴다', async () => {
  const onEnd = vi.fn();
  const out = await collect(runLesson({ scriptText: lines('not json', '```', DRAW), speak: async (t) => sp(t), onEnd }));
  expect(out.at(-1)).toEqual({ type: 'error', message: '수업을 만드는 중에 문제가 생겼어요. 다시 물어봐 줄래?' });
  expect(onEnd.mock.calls[0][0].error).toBeInstanceOf(Error);
  const empty = await collect(runLesson({ scriptText: lines(), speak: async (t) => sp(t) }));
  expect(empty.map((m) => m.type)).toEqual(['error']);
});

// QA 2026-11-22: 요청이 끊긴 뒤에도 대본 스트림이 signal을 따르지 않으면 끝까지 읽고 say마다 TTS를 불렀다.
test('요청이 끊기면 signal을 따르지 않는 대본도 더 읽지 않고, 그 뒤 TTS를 부르지 않는다', async () => {
  const req = new AbortController();
  let read = 0;
  async function* slow() { for (let i = 0; i < 50; i++) { await tick(2); read++; if (i === 3) req.abort(); yield SAY(`s${i}`) + '\n'; } }
  let calls = 0;
  const onEnd = vi.fn();
  const out = await collect(runLesson({ scriptText: slow(), speak: async (t) => { calls++; return sp(t); }, signal: req.signal, onEnd }));
  expect(read).toBe(4);
  expect(calls).toBeLessThanOrEqual(3);
  expect(out.at(-1)).toEqual({ type: 'done' }); // 끊긴 수업은 오류로 세지 않는다(받을 사람도 없다)
  expect(onEnd.mock.calls[0][0]).toMatchObject({ ttsFailures: 0 });
  expect(onEnd.mock.calls[0][0].error).toBeUndefined();
});
test('자리를 기다리던 TTS는 요청이 끊기면 부르지 않는다(실패로 세지 않음)', async () => {
  const req = new AbortController();
  const started: string[] = [];
  const onEnd = vi.fn();
  const speak = (t: string) => { started.push(t); return new Promise<Speech>((r) => setTimeout(() => r(sp(t)), 30)); };
  const p = collect(runLesson({ scriptText: lines(SAY('a'), SAY('b'), SAY('c')), speak, maxParallelTts: 1, signal: req.signal, onEnd }));
  await tick(5);
  req.abort();
  await p;
  expect(started).toEqual(['a']);
  expect(onEnd.mock.calls[0][0]).toMatchObject({ ttsFailures: 0 });
});

// QA 2026-11-22: 말 없이 판서 줄만 되풀이하는 폭주는 say 한도에 걸리지 않아 보드에 판서 수천 개가 갈 수 있었다.
test(`판서(draw·page)는 수업당 ${MAX_BOARD_OPS}개까지: 넘는 판서는 버리고 말은 계속 나간다`, async () => {
  const onEnd = vi.fn();
  const flood = Array.from({ length: 500 }, (_, i) => (i % 50 === 49 ? '{"page":true}' : DRAW));
  const out = await collect(runLesson({ scriptText: lines(SAY('하나'), ...flood, SAY('둘')), speak: async (t) => sp(t), onEnd }));
  expect(out.filter((m) => m.type === 'draw' || m.type === 'page')).toHaveLength(MAX_BOARD_OPS);
  expect(out.filter((m) => m.type === 'say').map((m) => (m as { text: string }).text)).toEqual(['하나', '둘']);
  expect(out.at(-1)).toEqual({ type: 'done' });
  expect(onEnd.mock.calls[0][0]).toMatchObject({ droppedLines: 500 - MAX_BOARD_OPS });
});

// E2(2026-11-23): 이어 물을 질문 줄은 대본 어디에 와도 수업 끝(done 바로 앞)에 한 번 나간다.
const NEXT = (...qs: string[]) => JSON.stringify({ next: qs });
test('next 줄은 done 바로 앞에 한 번 나간다(대본 중간에 와도)', async () => {
  const out = await collect(runLesson({ scriptText: lines(SAY('하나'), NEXT('달은 왜 모양이 바뀌어?', '해는 왜 뜨거워?'), DRAW, SAY('둘')), speak: async t => sp(t) }));
  expect(out.map(m => m.type)).toEqual(['say', 'draw', 'say', 'next', 'done']);
  expect(out[3]).toEqual({ type: 'next', questions: ['달은 왜 모양이 바뀌어?', '해는 왜 뜨거워?'] });
});
test('next 줄이 없으면 지금처럼 done만', async () => {
  const out = await collect(runLesson({ scriptText: lines(SAY('하나')), speak: async t => sp(t) }));
  expect(out.map(m => m.type)).toEqual(['say', 'done']);
});
test('오류로 끝난 수업에는 next를 보내지 않는다', async () => {
  async function* bad() { yield SAY('하나') + '\n'; yield NEXT('해는 왜 뜨거워?') + '\n'; throw new Error('boom'); }
  const out = await collect(runLesson({ scriptText: bad(), speak: async t => sp(t) }));
  expect(out.map(m => m.type)).toEqual(['say', 'error']);
});
test('next 줄만 있고 say가 없으면 오류(빈 칠판 수업 아님)', async () => {
  const out = await collect(runLesson({ scriptText: lines(NEXT('해는 왜 뜨거워?')), speak: async t => sp(t) }));
  expect(out.map(m => m.type)).toEqual(['error']);
});
test('say 한도에 걸려 대본 읽기를 멈추면 뒤의 next는 읽지 않는다', async () => {
  const says = Array.from({ length: MAX_SAYS + 1 }, (_, i) => SAY(`문장${i}`));
  const out = await collect(runLesson({ scriptText: lines(...says, NEXT('해는 왜 뜨거워?')), speak: async t => sp(t) }));
  expect(out.some(m => m.type === 'next')).toBe(false);
  expect(out.at(-1)).toMatchObject({ type: 'done' });
});

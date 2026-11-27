import { afterEach, describe, test, expect, vi } from 'vitest';
import { LessonPlayer, SKETCH_EST_MS } from '../../src/web/player/player';
import { FIGURE_MS_PER_LINE, MIN_FIGURE_MS } from '../../src/web/player/timeline';
import { Layout } from '../../src/web/board/layout';
import type { LessonMessage, SayTiming, Speech } from '../../src/shared/lesson';
import type { DrawOp } from '../../src/shared/script';

// 가짜 보드·오디오
const fakeBoard = () => ({ calls: [] as string[], async draw(op: any) { this.calls.push('draw:' + op.kind); }, async wipe() { this.calls.push('wipe'); }, clear() {}, setSubtitle(t: string) { this.calls.push('sub:' + t); }, writeIdle() {} });
const fakeAudio = () => ({ played: [] as string[], async play(s: Speech) { this.played.push(s.audioBase64); }, stop: vi.fn(), async unlock() {}, duck() {} });
const speech = (id: string): Speech => ({ audioBase64: id, mime: 'audio/mpeg', timing: { chars: ['a'], startMs: [0], endMs: [10] }, durationMs: 10 });
async function* msgs(...m: LessonMessage[]) { for (const x of m) yield x; }
const T = { kind: 'text', role: 'title', text: '제목', ink: 'black' } as const;

describe('LessonPlayer (brief)', () => {
  test('say 순서대로 재생하고 판서는 자기 say 뒤에', async () => {
    const board = fakeBoard(), audio = fakeAudio();
    const r = await new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'draw', sayId: 1, op: T },
      { type: 'say', id: 2, text: '둘', speech: speech('s2') }, { type: 'done' }));
    expect(r).toBe('done'); expect(audio.played).toEqual(['s1', 's2']);
    expect(board.calls.indexOf('sub:하나')).toBeLessThan(board.calls.indexOf('draw:text'));
  });
  test('speech가 null이어도 자막과 판서는 진행', async () => {
    const board = fakeBoard();
    await new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: null }, { type: 'draw', sayId: 1, op: T }, { type: 'done' }));
    expect(board.calls).toContain('draw:text');
  });
  test('abort 후 도착한 메시지는 그리지 않는다', async () => {
    const board = fakeBoard(), audio = fakeAudio(); let push!: (m: LessonMessage) => void; const q: LessonMessage[] = [];
    async function* live() { while (true) { while (q.length) { const m = q.shift()!; yield m; if (m.type === 'done') return; } await new Promise(r => (push = (m) => { q.push(m); r(null); })); } }
    const pl = new LessonPlayer({ board, layout: new Layout(), audio }); const p = pl.play(live());
    push({ type: 'say', id: 1, text: '하나', speech: speech('s1') }); await new Promise(r => setTimeout(r, 10));
    pl.abort(); push({ type: 'draw', sayId: 1, op: T }); push({ type: 'done' });
    expect(await p).toBe('aborted'); expect(board.calls).not.toContain('draw:text'); expect(audio.stop).toHaveBeenCalled();
  });
  test('page 메시지는 지운다', async () => {
    const board = fakeBoard();
    await new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() }).play(msgs({ type: 'page' }, { type: 'done' }));
    expect(board.calls).toContain('wipe');
  });
});

describe('LessonPlayer onSay', () => {
  test('onSay가 say 순서대로, 재생을 시작할 때 불린다(판서만 있는 묶음은 빼고)', async () => {
    const said: string[] = [];
    const order: string[] = [];
    const audio = { async play(s: Speech) { order.push('play:' + s.audioBase64); }, stop: vi.fn(), async unlock() {}, duck() {} };
    const r = await new LessonPlayer({ board: fakeBoard(), layout: new Layout(), audio, onSay: (t) => { said.push(t); order.push('say:' + t); } }).play(msgs(
      { type: 'draw', sayId: 0, op: T },
      { type: 'say', id: 1, text: '하나', speech: speech('s1') },
      { type: 'say', id: 2, text: '둘', speech: null },
      { type: 'say', id: 3, text: '셋', speech: speech('s3') },
      { type: 'done' }));
    expect(r).toBe('done');
    expect(said).toEqual(['하나', '둘', '셋']);
    expect(order).toEqual(['say:하나', 'play:s1', 'say:둘', 'say:셋', 'play:s3']);
  });

  test('onSay가 던져도 수업은 계속된다', async () => {
    const audio = fakeAudio();
    const r = await new LessonPlayer({ board: fakeBoard(), layout: new Layout(), audio, onSay: () => { throw new Error('boom'); } }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'done' }));
    expect(r).toBe('done');
    expect(audio.played).toEqual(['s1']);
  });
});

const fig = (id: string): DrawOp => ({ kind: 'figure', id, size: 'small', ink: 'green', strokes: ['M0 0 L10 10'] });

describe('LessonPlayer (추가)', () => {
  test('sayId 0 판서는 say 없이 바로 그린다', async () => {
    const board = fakeBoard();
    const r = await new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() }).play(msgs({ type: 'draw', sayId: 0, op: T }, { type: 'done' }));
    expect(r).toBe('done');
    expect(board.calls).toEqual(['sub:', 'draw:text']); // 빈 자막: '생각 중' 카드를 먼저 지운다
  });

  test('수업이 말 없는 판서로 시작하면 그리기 전에 자막을 비워 생각 중 카드를 지운다(한 번만)', async () => {
    const board = fakeBoard();
    const r = await new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() }).play(msgs(
      { type: 'draw', sayId: 0, op: T },
      { type: 'say', id: 1, text: '하나', speech: speech('s1') },
      { type: 'page' },
      { type: 'draw', sayId: 1, op: T },
      { type: 'done' }));
    expect(r).toBe('done');
    expect(board.calls[0]).toBe('sub:'); // 첫 판서보다 먼저
    expect(board.calls.filter((c) => c === 'sub:')).toHaveLength(1); // 문장 뒤 말 없는 묶음은 앞 자막을 그대로 둔다
  });

  test('place()가 newPage면 지우고 그린다', async () => {
    const board = fakeBoard();
    await new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'draw', sayId: 1, op: T }, { type: 'draw', sayId: 1, op: T }, { type: 'done' }));
    expect(board.calls.filter((c) => c !== 'sub:하나')).toEqual(['draw:text', 'wipe', 'draw:text']);
  });

  test('connect·mark는 칸이 있을 때만, 없는 id면 그 판서만 건너뛴다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const board = fakeBoard();
      const draw = (op: DrawOp): LessonMessage => ({ type: 'draw', sayId: 1, op });
      const p = new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() }).play(msgs(
        { type: 'say', id: 1, text: '나무와 달', speech: speech('s1') },
        draw({ kind: 'connect', from: '나무', to: '달', ink: 'blue' }),
        draw(fig('나무')), draw(fig('달')),
        draw({ kind: 'connect', from: '나무', to: '달', ink: 'blue' }),
        draw({ kind: 'mark', target: '없음', style: 'circle', ink: 'red' }),
        draw({ kind: 'mark', target: '달', style: 'circle', ink: 'red' }),
        { type: 'done' }));
      await vi.advanceTimersByTimeAsync(5000); // 없는 대상 mark는 1.5초 기다렸다가 건너뛴다
      expect(await p).toBe('done');
      expect(board.calls.filter((c) => c.startsWith('draw:'))).toEqual(['draw:figure', 'draw:figure', 'draw:connect', 'draw:mark']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('page 뒤 판서는 지운 다음에 그린다', async () => {
    const board = fakeBoard();
    await new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'draw', sayId: 1, op: fig('a') },
      { type: 'page' }, { type: 'draw', sayId: 1, op: fig('b') },
      { type: 'say', id: 2, text: '둘', speech: speech('s2') }, { type: 'done' }));
    expect(board.calls.filter((c) => !c.startsWith('sub:'))).toEqual(['draw:figure', 'wipe', 'draw:figure']);
  });

  test('다음 say는 앞 문장 음성이 끝난 뒤에 시작한다', async () => {
    const board = fakeBoard();
    const ends: (() => void)[] = [];
    const audio = { played: [] as string[], play(s: Speech) { this.played.push(s.audioBase64); return new Promise<void>((r) => ends.push(r)); }, stop: vi.fn(), async unlock() {}, duck() {} };
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'say', id: 2, text: '둘', speech: speech('s2') }, { type: 'done' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(audio.played).toEqual(['s1']);
    expect(board.calls).toEqual(['sub:하나']);
    ends[0]();
    await new Promise((r) => setTimeout(r, 20));
    expect(audio.played).toEqual(['s1', 's2']);
    ends[1]();
    expect(await p).toBe('done');
  });

  test('음성이 실패해도 문장 길이만큼 진행하고 끝난다', async () => {
    const board = fakeBoard();
    const audio = { async play() { throw new Error('NotAllowedError'); }, stop: vi.fn(), async unlock() {}, duck() {} };
    const r = await new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'draw', sayId: 1, op: T }, { type: 'done' }));
    expect(r).toBe('done');
    expect(board.calls).toEqual(['sub:하나', 'draw:text']);
  });

  test('error 메시지나 done 없이 끝난 스트림은 error', async () => {
    const mk = () => new LessonPlayer({ board: fakeBoard(), layout: new Layout(), audio: fakeAudio() });
    expect(await mk().play(msgs({ type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'error', message: 'x' }))).toBe('error');
    expect(await mk().play(msgs({ type: 'say', id: 1, text: '하나', speech: speech('s1') }))).toBe('error');
    async function* boom(): AsyncGenerator<LessonMessage> { yield { type: 'page' }; throw new Error('network'); }
    expect(await mk().play(boom())).toBe('error');
  });

  test('abort는 말 없는 문장을 기다리는 중에도 바로 끝내고 예약된 판서를 취소한다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const board = fakeBoard();
      let push!: () => void;
      async function* live(): AsyncGenerator<LessonMessage> {
        yield { type: 'say', id: 1, text: '아주 긴 문장이라서 한참 걸린다', speech: null };
        yield { type: 'draw', sayId: 1, op: fig('a') };
        yield { type: 'draw', sayId: 1, op: fig('b') };
        await new Promise<void>((r) => (push = r));
        yield { type: 'done' };
      }
      const pl = new LessonPlayer({ board, layout: new Layout(), audio: fakeAudio() });
      const p = pl.play(live());
      await vi.advanceTimersByTimeAsync(20);
      expect(board.calls).toEqual(['sub:아주 긴 문장이라서 한참 걸린다', 'draw:figure']); // a는 0ms, b는 나중
      pl.abort();
      expect(await p).toBe('aborted'); // 시간을 흘리지 않아도 바로 끝난다
      await vi.advanceTimersByTimeAsync(10_000);
      expect(board.calls.filter((c) => c.startsWith('draw:'))).toEqual(['draw:figure']); // b는 취소됨
      push();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- 시각 규칙(가짜 타이머) ----------

const tm = (text: string, msPerChar = 100): SayTiming => ({
  chars: [...text], startMs: [...text].map((_, i) => i * msPerChar), endMs: [...text].map((_, i) => (i + 1) * msPerChar),
});
const sp = (text: string): Speech => ({ audioBase64: 'x', mime: 'audio/mpeg', timing: tm(text), durationMs: [...text].length * 100 });
const figN = (id: string, strokes: number): DrawOp => ({ kind: 'figure', id, size: 'small', ink: 'green', strokes: Array(strokes).fill('M0 0 L10 10') });
const note = (text: string): DrawOp => ({ kind: 'text', role: 'note', text, ink: 'black' });
const opName = (op: DrawOp) =>
  op.kind === 'figure' ? `figure:${op.id}` : op.kind === 'text' ? `text:${op.text}` : op.kind === 'connect' ? `connect:${op.from}>${op.to}` : op.kind === 'mark' ? `mark:${op.target}` : `sketch:${op.id}`;

/** draw·wipe의 시작 시각(음성 시작 기준)과 길이를 기록하는 보드, 실제로 시간이 걸리는 오디오. */
function timedRig(wipeMs = 100) {
  let audioStart = 0;
  let markStarted!: () => void;
  const audioStarted = new Promise<void>((r) => (markStarted = r));
  const rel = () => performance.now() - audioStart;
  const log: { what: string; t: number; dur?: number }[] = [];
  /** at: 그릴 때의 칸 자리(칸 객체는 나중에 옮겨질 수 있어 그 순간 값을 베껴 둔다). */
  const drawn: { op: DrawOp; place: any; at: any }[] = [];
  let relayouts = 0;
  const subs: [string, number][] = [];
  const t0 = performance.now();
  const board = {
    async draw(op: DrawOp, place: unknown, dur: number) {
      log.push({ what: opName(op), t: rel(), dur });
      drawn.push({ op, place, at: JSON.parse(JSON.stringify(place)) });
      await new Promise((r) => setTimeout(r, dur));
    },
    async wipe() {
      log.push({ what: 'wipe', t: rel() });
      await new Promise((r) => setTimeout(r, wipeMs));
    },
    clear() {},
    setSubtitle(s: string) {
      subs.push([s, performance.now() - t0]);
    },
    writeIdle() {},
    relayout() {
      relayouts++;
    },
  };
  const audio = {
    play(s: Speech) {
      audioStart = performance.now();
      markStarted();
      return new Promise<void>((r) => setTimeout(r, s.durationMs));
    },
    stop: vi.fn(),
    async unlock() {},
    duck() {},
  };
  return { board, audio, log, drawn, subs, audioStarted, relayouts: () => relayouts };
}

describe('LessonPlayer 판서 시각', () => {
  afterEach(() => vi.useRealTimers());
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

  test('at 판서는 앞의 순서 판서가 그리는 중이어도 timing.startMs[i]에 시작한다', async () => {
    fake();
    const text = '나무와 달이 있어'; // 9글자 = 900ms, '달'은 4번째 → 400ms
    const { board, audio, log } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: figN('나무', 3) },
      { type: 'draw', sayId: 1, at: '달', op: figN('달', 1) },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    // 그림 길이는 문장 몫이 아니라 획 수(최소 1.5초)
    expect(log).toEqual([
      { what: 'figure:나무', t: 0, dur: MIN_FIGURE_MS },
      { what: 'figure:달', t: 400, dur: MIN_FIGURE_MS },
    ]);
  });

  test('가리키는 그림보다 먼저 계획된 connect도 빠지지 않는다(칸은 도착 순서로 잡는다)', async () => {
    fake();
    const text = '나무와 달이 있어'; // '달' 400ms, '있어' 700ms
    const { board, audio, log } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: figN('나무', 1) },
      { type: 'draw', sayId: 1, at: '있어', op: figN('달', 1) },
      { type: 'draw', sayId: 1, at: '달', op: { kind: 'connect', from: '나무', to: '달', ink: 'blue' } },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => [e.what, e.t])).toEqual([['figure:나무', 0], ['connect:나무>달', 400], ['figure:달', 700]]);
  });

  test('문장이 시작된 뒤 도착한 판서는 아직 시작 안 한 형제들과 함께 다시 계획된다', async () => {
    fake();
    const text = '가나다라마바사아자차'; // 1000ms
    const { board, audio, log, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      await audioStarted; // 음성이 시작된 뒤에 판서가 온다(서버가 say 바로 뒤에 보내는 흔한 경우)
      yield { type: 'draw', sayId: 1, op: note('가나다라마바사아') };
      yield { type: 'draw', sayId: 1, op: note('자차카타파하가나') };
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log).toEqual([
      { what: 'text:가나다라마바사아', t: 0, dur: 500 },
      { what: 'text:자차카타파하가나', t: 500, dur: 500 },
    ]);
  });

  test('newPage 배치는 앞 판서가 끝나길 기다려 지우고, 새 페이지 판서는 지우기 뒤에 그린다', async () => {
    fake();
    const text = '나무와 달이 있어'; // '달' 400ms, '이' 500ms
    const { board, audio, log } = timedRig(100);
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: { kind: 'text', role: 'title', text: '제목', ink: 'black' } }, // 0~900
      { type: 'draw', sayId: 1, at: '달', op: { kind: 'text', role: 'title', text: '둘째', ink: 'black' } }, // 새 페이지
      { type: 'draw', sayId: 1, at: '이', op: figN('c', 1) }, // 새 페이지에 속함
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => [e.what, e.t])).toEqual([['text:제목', 0], ['wipe', 900], ['text:둘째', 1000], ['figure:c', 1000]]);
  });

  test('page 단계는 앞 판서가 끝난 뒤 지우고, 다음 문장은 지운 뒤에 시작한다', async () => {
    fake();
    const text = '나무와 달이 있어';
    const { board, audio, log, subs } = timedRig(100);
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: sp('하나') }, // 200ms
      { type: 'draw', sayId: 1, op: figN('a', 1) }, // 0~1500 (그림 최소 길이)
      { type: 'page' },
      { type: 'say', id: 2, text, speech: sp(text) },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(subs).toEqual([['하나', 0], [text, 1600]]); // 1500에 판서 끝 → 지우기 100ms → 1600
    expect(log.map((e) => e.what)).toEqual(['figure:a', 'wipe']);
  });
});

describe('LessonPlayer 판서 늦음 측정', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

  test('문장이 이미 지나간 뒤 도착한 at 판서는 늦은 것으로 기록·요약된다', async () => {
    fake();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = '나무와 달이 있어'; // '달' 400ms
    const { board, audio, log, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      await audioStarted;
      await new Promise((r) => setTimeout(r, 600)); // '달'(400ms)을 이미 말한 뒤에 도착
      yield { type: 'draw', sayId: 1, at: '달', op: figN('달', 1) };
      yield { type: 'done' };
    }
    const pl = new LessonPlayer({ board, layout: new Layout(), audio });
    const p = pl.play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => e.what)).toEqual(['figure:달']);
    expect(log[0].t).toBeGreaterThanOrEqual(600); // 도착 즉시(가짜 타이머의 setTimeout 0은 1ms)
    expect(log[0].t).toBeLessThanOrEqual(601);
    const st = pl.syncStats();
    expect(st).toMatchObject({ draws: 1, late: 1 });
    expect(st.maxLateMs).toBeGreaterThanOrEqual(200); // 계획 400ms, 실제 600ms
    expect(st.maxLateMs).toBeLessThanOrEqual(201);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatch(/result=done draws=1 late>150ms=1 maxLateMs=20[01]$/);
  });

  test('제때 그린 판서는 늦지 않다', async () => {
    fake();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = '나무와 달이 있어';
    const { board, audio } = timedRig();
    const pl = new LessonPlayer({ board, layout: new Layout(), audio });
    const p = pl.play(msgs(
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: figN('나무', 3) },
      { type: 'draw', sayId: 1, at: '달', op: figN('달', 1) },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(pl.syncStats()).toEqual({ draws: 2, late: 0, maxLateMs: 0 });
    expect(info.mock.calls[0][0]).toMatch(/draws=2 late>150ms=0 maxLateMs=0/);
  });
});

// ---------- 주문 그림(sketch)·표시(mark) ----------

const sk = (id: string, size: 'small' | 'wide' = 'small'): DrawOp => ({ kind: 'sketch', id, size });
const sketchMsg = (id: string, strokes = 1): LessonMessage => ({
  type: 'sketch', id, figure: { kind: 'figure', id, size: 'small', ink: 'black', strokes: Array(strokes).fill('M0 0 L10 10') },
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLOT = [48, 452, 856];

describe('LessonPlayer 주문 그림', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

  test('그림이 계획보다 늦게 오면 도착 즉시 그린다', async () => {
    fake();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = '병사가 서 있어요'; // 9글자 900ms, sketch는 0ms 계획
    const { board, audio, log, drawn, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: sk('병사') };
      await audioStarted;
      await wait(600);
      yield sketchMsg('병사', 3);
      yield { type: 'done' };
    }
    const pl = new LessonPlayer({ board, layout: new Layout(), audio });
    const p = pl.play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => e.what)).toEqual(['figure:병사']);
    expect(log[0].t).toBeGreaterThanOrEqual(600);
    expect(log[0].t).toBeLessThanOrEqual(601);
    expect(drawn[0].op.kind).toBe('figure'); // 보드에는 받은 그림이 간다
    expect(drawn[0].at).toMatchObject({ rect: { x: 452, w: 376 }, newPage: false }); // 이 쪽의 작은 그림 하나 → 가운데
    const st = pl.syncStats(); // 기다린 시간이 지연으로 잡힌다
    expect(st).toMatchObject({ draws: 1, late: 1 });
    expect(st.maxLateMs).toBeGreaterThanOrEqual(600);
    expect(st.maxLateMs).toBeLessThanOrEqual(601);
  });

  test('그림이 먼저 오면 보관했다가 계획 시각에 그린다(무게 = 그림 획 수)', async () => {
    fake();
    const text = '가나다라마바사아자차'; // 1000ms
    const { board, audio, log } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      sketchMsg('a', 10), // 보여 주기보다 먼저 도착
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: sk('a') },
      { type: 'draw', sayId: 1, op: figN('b', 1) },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    // 10획 → 2500ms(짐작 SKETCH_EST_MS 3000ms가 아님), b는 그 뒤. 문장(1000ms)보다 길어도 된다.
    expect(log).toEqual([
      { what: 'figure:a', t: 0, dur: 10 * FIGURE_MS_PER_LINE },
      { what: 'figure:b', t: 10 * FIGURE_MS_PER_LINE, dur: MIN_FIGURE_MS },
    ]);
  });

  test('재생 중 그림이 도착하면 아직 시작 안 한 판서를 그 획 수로 다시 계획한다', async () => {
    fake();
    const text = '가나다라마바사아자차'; // 1000ms
    const { board, audio, log, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: sk('a') }; // 0ms 시작, 계획 때는 짐작 길이 SKETCH_EST_MS
      yield { type: 'draw', sayId: 1, op: figN('b', 1) }; // 처음 계획: SKETCH_EST_MS 뒤
      await audioStarted;
      await wait(100);
      yield sketchMsg('a', 8); // 8획 → 2000ms: b를 다시 계획
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    expect(SKETCH_EST_MS).toBe(3000);
    expect(log.map((e) => [e.what, e.t])).toEqual([['figure:a', 100], ['figure:b', 2000]]);
    expect(log[0].dur).toBe(2000); // 늦게 왔어도 실제 획 수로 그린다
  });

  test('늦게 온 그림은 짐작(SKETCH_EST_MS)이 아니라 실제 획 수 길이로 그린다', async () => {
    fake();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = '병사가 서 있어요';
    const { board, audio, log, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: sk('병사') };
      await audioStarted;
      await wait(600);
      yield sketchMsg('병사', 20);
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    expect(log.map((e) => [e.what, e.dur])).toEqual([['figure:병사', 20 * FIGURE_MS_PER_LINE]]);
  });

  test('예약 뒤 페이지가 넘어가면 늦게 온 그림은 버린다(page는 그림을 기다리지 않는다)', async () => {
    fake();
    const { board, audio, log, subs } = timedRig(100);
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text: '하나', speech: sp('하나') }; // 200ms
      yield { type: 'draw', sayId: 1, op: sk('a') };
      yield { type: 'page' };
      yield { type: 'say', id: 2, text: '둘셋넷', speech: sp('둘셋넷') }; // 300~600
      await wait(400); // 둘째 문장 중에 도착
      yield sketchMsg('a', 2);
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => e.what)).toEqual(['wipe']);
    expect(subs).toEqual([['하나', 0], ['둘셋넷', 300]]); // 200 음성 끝 → 지우기 100 → 300
  });

  test('새 페이지 배치로 넘어가도 오지 않은 그림은 지우기를 막지 않고, 늦게 오면 버린다', async () => {
    fake();
    const text = '가나다라마바사아자차'; // 1000ms
    const { board, audio, log, audioStarted } = timedRig(100);
    const wide: DrawOp = { kind: 'figure', id: 'w', size: 'wide', ink: 'green', strokes: ['M0 0 L10 10'] };
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: sk('a') }; // 작은 칸, 0ms 계획
      yield { type: 'draw', sayId: 1, at: '마', op: wide }; // 넓은 그림 → 새 페이지, 400ms 계획
      await audioStarted;
      await wait(1500);
      yield sketchMsg('a');
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => [e.what, e.t])).toEqual([['wipe', 0], ['figure:w', 400]]);
  });

  test('figure:null → 그리지 않고(칸은 비워 둠) 수업 계속', async () => {
    fake();
    const text = '가나다라마바사아자차';
    const { board, audio, log, drawn } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: sk('a') },
      { type: 'sketch', id: 'a', figure: null },
      { type: 'draw', sayId: 1, op: figN('b', 1) },
      { type: 'say', id: 2, text: '둘', speech: sp('둘') },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => e.what)).toEqual(['figure:b']);
    expect(drawn[0].place.rect.x).toBe(SLOT[1]); // 이미 실패한 a는 칸을 잡지 않아 b 혼자 가운데
  });

  test('done이 오면 아직 안 온 그림은 없는 것으로 보고 끝낸다', async () => {
    fake();
    const { board, audio, log } = timedRig();
    let finished = false;
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: sp('하나') },
      { type: 'draw', sayId: 1, op: sk('a') },
      { type: 'draw', sayId: 1, op: { kind: 'mark', target: 'a', style: 'circle', ink: 'red' } },
      { type: 'say', id: 2, text: '둘', speech: sp('둘') },
      { type: 'draw', sayId: 2, op: sk('b') }, // done 뒤에 시작하는 문장의 보여 주기
      { type: 'done' })).then((r) => { finished = true; return r; });
    await vi.advanceTimersByTimeAsync(400);
    expect(finished).toBe(true);
    expect(await p).toBe('done');
    expect(log).toEqual([]); // 그림도, 그림에 붙은 표시도 없음
  });

  test('connect는 그림 도착 전에도 예약 칸으로 그린다', async () => {
    fake();
    const text = '가나다라마바사아자차';
    const { board, audio, log, drawn } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: sk('a') },
      { type: 'draw', sayId: 1, op: figN('b', 1) },
      { type: 'draw', sayId: 1, at: '마', op: { kind: 'connect', from: 'a', to: 'b', ink: 'blue' } },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    // a는 끝내 안 온다(done이 먼저 와 바로 '없음'): a 칸을 비우고 b는 가운데로 모인다. 비운 칸을 가리키는 연결선은 긋지 않는다.
    expect(log.map((e) => e.what)).toEqual(['figure:b']);
    expect(drawn[0].at.rect.x).toBe(452);
  });

  test('connect는 그림 도착 전에도 예약 칸으로 그린다(그림이 늦게 오는 경우)', async () => {
    fake();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = '가나다라마바사아자차';
    const { board, audio, log, drawn, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: sk('a') };
      yield { type: 'draw', sayId: 1, op: figN('b', 1) };
      yield { type: 'draw', sayId: 1, at: '마', op: { kind: 'connect', from: 'a', to: 'b', ink: 'blue' } };
      await audioStarted;
      await wait(600);
      yield sketchMsg('a');
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => e.what).sort()).toEqual(['connect:a>b', 'figure:a', 'figure:b']);
    expect(log[0].t).toBe(400);
    const c = drawn.find((x) => x.op.kind === 'connect')!;
    expect(c.at.refs.map((r: { x: number }) => r.x)).toEqual([184, 720]); // 2개 자리(가운데 정렬)
  });

  test('여러 그림의 칸 순서 = 보여 주기 도착 순서(그림 도착 순서와 무관)', async () => {
    fake();
    const text = '가나다라마바사아자차';
    const { board, audio, drawn, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield sketchMsg('c');
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: sk('a') };
      yield { type: 'draw', sayId: 1, op: sk('b') };
      yield { type: 'draw', sayId: 1, op: sk('c') };
      await audioStarted;
      await wait(100);
      yield sketchMsg('b');
      await wait(100);
      yield sketchMsg('a');
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(20000);
    expect(await p).toBe('done');
    const x = Object.fromEntries(drawn.map((d) => [(d.op as { id: string }).id, d.place.rect.x]));
    expect(x).toEqual({ a: SLOT[0], b: SLOT[1], c: SLOT[2] });
  });
});

describe('LessonPlayer 표시(mark)', () => {
  afterEach(() => vi.useRealTimers());
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const title = { kind: 'text', id: 't1', role: 'title', text: '공룡이 멸종한 까닭', ink: 'black' } as const;

  test('mark는 대상 글씨 그리기가 끝난 뒤 시작한다(글씨 칸 + word 전달)', async () => {
    fake();
    const text = '나무와 달이 있어'; // 900ms, '달' 400ms
    const { board, audio, log, drawn } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text, speech: sp(text) },
      { type: 'draw', sayId: 1, op: title }, // 0~900
      { type: 'draw', sayId: 1, at: '달', op: { kind: 'mark', target: 't1', word: '멸종', style: 'underline', ink: 'red' } },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => [e.what, e.t])).toEqual([['text:공룡이 멸종한 까닭', 0], ['mark:t1', 900]]);
    const m = drawn.find((x) => x.op.kind === 'mark')!;
    expect(m.op).toMatchObject({ word: '멸종', style: 'underline' });
    expect(m.place).toEqual({ refs: [{ x: 48, y: 24, w: 1184, h: 90 }] });
  });

  test('대상 그림이 늦게 오면 mark도 그 그림이 끝난 뒤에', async () => {
    fake();
    const text = '가나다라마바사아자차'; // 1000ms
    const { board, audio, log, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: sk('a') }; // 0~1000 계획
      yield { type: 'draw', sayId: 1, at: '다', op: { kind: 'mark', target: 'a', style: 'star', ink: 'gold' } };
      await audioStarted;
      await wait(300);
      yield sketchMsg('a', 2);
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => [e.what, e.t])).toEqual([['figure:a', 300], ['mark:a', 300 + MIN_FIGURE_MS]]);
  });

  test('대상이 아직 예약되지 않았으면 1.5초 안에 예약될 때 기다렸다 그린다', async () => {
    fake();
    const text = '가나다라마바사아자차';
    const { board, audio, log, audioStarted } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text, speech: sp(text) };
      yield { type: 'draw', sayId: 1, op: { kind: 'mark', target: 'b', style: 'circle', ink: 'red' } };
      await audioStarted;
      await wait(800);
      yield { type: 'draw', sayId: 1, op: figN('b', 1) };
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => e.what)).toEqual(['figure:b', 'mark:b']);
    const end = log[0].t + log[0].dur!;
    expect(log[1].t).toBeGreaterThanOrEqual(end - 1);
    expect(log[1].t).toBeLessThanOrEqual(end + 1);
  });

  test('대상 없는 mark는 1.5초 기다린 뒤 건너뛴다', async () => {
    fake();
    const { board, audio, log } = timedRig();
    let finishedAt = -1;
    const t0 = performance.now();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: sp('하나') },
      { type: 'draw', sayId: 1, op: { kind: 'mark', target: '없음', style: 'circle', ink: 'red' } },
      { type: 'draw', sayId: 1, op: note('a') },
      { type: 'done' })).then((r) => { finishedAt = performance.now() - t0; return r; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(log.map((e) => e.what)).toEqual(['text:a']);
    expect(finishedAt).toBeGreaterThanOrEqual(1500);
    expect(finishedAt).toBeLessThan(1600);
  });

  test('오지 않는 그림에 붙은 mark가 page를 막지 않는다', async () => {
    fake();
    const { board, audio, log, subs } = timedRig(100);
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text: '하나', speech: sp('하나') }; // 200ms
      yield { type: 'draw', sayId: 1, op: sk('a') };
      yield { type: 'draw', sayId: 1, op: { kind: 'mark', target: 'a', style: 'circle', ink: 'red' } };
      yield { type: 'page' };
      yield { type: 'say', id: 2, text: '둘', speech: sp('둘') };
      await wait(1000);
      yield sketchMsg('a');
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('done');
    expect(subs).toEqual([['하나', 0], ['둘', 300]]);
    expect(log.map((e) => e.what)).toEqual(['wipe']);
  });
});

// ---------- 작은 그림 자리(B2 2026-11-23): 한 쪽의 그림 수에 맞춰 가운데 정렬 ----------

describe('LessonPlayer 작은 그림 자리', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const xAt = (drawn: { op: DrawOp; at: any }[], id: string) => drawn.find((d) => (d.op as { id?: string }).id === id)!.at.rect.x;

  test('앞을 내다본다: 뒤 문장의 그림까지 이미 와 있으면 첫 그림부터 2개 자리(양쪽 균형)에 그린다', async () => {
    fake();
    const { board, audio, drawn, relayouts } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 0, text: '질문', speech: sp('질문') }, // 첫 문장을 말하는 동안 뒤 대본이 다 온다
      { type: 'say', id: 1, text: '나무', speech: sp('나무') },
      { type: 'draw', sayId: 1, op: figN('나무', 1) },
      { type: 'say', id: 2, text: '그리고 달', speech: sp('그리고 달') },
      { type: 'draw', sayId: 2, op: figN('달', 1) },
      { type: 'say', id: 3, text: '끝', speech: sp('끝') },
      { type: 'draw', sayId: 3, op: { kind: 'text', role: 'note', text: '정리', ink: 'black' } },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    expect([xAt(drawn, '나무'), xAt(drawn, '달')]).toEqual([184, 720]);
    expect(relayouts()).toBe(0); // 처음부터 맞는 자리: 옮길 일이 없다
  });

  test('쪽 넘김 뒤의 그림은 세지 않는다: 쪽마다 따로 가운데', async () => {
    fake();
    const { board, audio, drawn } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 1, text: '하나', speech: sp('하나') },
      { type: 'draw', sayId: 1, op: figN('a', 1) },
      { type: 'page' },
      { type: 'say', id: 2, text: '둘', speech: sp('둘') },
      { type: 'draw', sayId: 2, op: figN('b', 1) },
      { type: 'draw', sayId: 2, op: figN('c', 1) },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    expect([xAt(drawn, 'a'), xAt(drawn, 'b'), xAt(drawn, 'c')]).toEqual([452, 184, 720]);
  });

  test('대비: 두 번째 그림이 첫 그림을 그린 뒤에 오면 첫 칸을 옆으로 옮기고 보드에 옮기라고 알린다', async () => {
    fake();
    const { board, audio, drawn, audioStarted, relayouts } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text: '나무가 있어', speech: sp('나무가 있어') };
      yield { type: 'draw', sayId: 1, op: figN('나무', 1) };
      await audioStarted;
      await wait(2000); // 첫 그림을 다 그린 뒤에야 다음 대본이 온다
      yield { type: 'say', id: 2, text: '달', speech: sp('달') };
      yield { type: 'draw', sayId: 2, op: figN('달', 1) };
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    expect(xAt(drawn, '나무')).toBe(452); // 그때는 혼자 → 가운데
    expect(xAt(drawn, '달')).toBe(720);
    const tree = drawn.find((d) => (d.op as { id?: string }).id === '나무')!;
    expect(tree.place.rect.x).toBe(184); // 칸 객체가 옆으로 옮겨졌다 → 보드가 그린 그림을 따라 옮긴다
    expect(relayouts()).toBeGreaterThanOrEqual(1);
  });

  test('칸을 잡은 주문 그림이 나중에 실패하면 그 칸을 비우고 남은 그림을 다시 가운데로', async () => {
    fake();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { board, audio, drawn, audioStarted, relayouts } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 1, text: '가나다라마바사', speech: sp('가나다라마바사') };
      yield { type: 'draw', sayId: 1, op: figN('a', 1) };
      yield { type: 'draw', sayId: 1, op: sk('b') };
      await audioStarted;
      await wait(300);
      yield { type: 'sketch', id: 'b', figure: null };
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    expect(drawn.map((d) => (d.op as { id?: string }).id)).toEqual(['a']);
    expect(xAt(drawn, 'a')).toBe(184); // 그릴 때는 둘 자리
    expect(drawn[0].place.rect.x).toBe(452); // b가 실패해 혼자 남자 가운데로
    expect(relayouts()).toBeGreaterThanOrEqual(1);
  });

  test('이미 실패로 온 주문 그림은 세지도, 칸을 잡지도 않는다', async () => {
    fake();
    const { board, audio, drawn, relayouts } = timedRig();
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(msgs(
      { type: 'say', id: 0, text: '질문', speech: sp('질문') },
      { type: 'say', id: 1, text: '가나다라', speech: sp('가나다라') },
      { type: 'draw', sayId: 1, op: figN('a', 1) },
      { type: 'say', id: 2, text: '마바사', speech: sp('마바사') },
      { type: 'draw', sayId: 2, op: sk('b') },
      { type: 'sketch', id: 'b', figure: null },
      { type: 'draw', sayId: 2, op: figN('c', 1) },
      { type: 'done' }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await p).toBe('done');
    expect([xAt(drawn, 'a'), xAt(drawn, 'c')]).toEqual([184, 720]);
    expect(relayouts()).toBe(0);
  });

  // QA2 2026-11-23(독립 리뷰 재현): 앞을 내다볼 때 센 주문 그림이 칸을 잡기 전에 실패하면 a가 2개 자리(184)에 혼자 남았다.
  test.each([100, 300, 600, 900, 1200])('센 주문 그림이 칸을 잡기 전에 실패해도(%ims 뒤) 남은 그림은 다시 가운데로', async (delay) => {
    fake();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { board, audio, drawn, audioStarted, relayouts } = timedRig();
    async function* live(): AsyncGenerator<LessonMessage> {
      yield { type: 'say', id: 0, text: '질문', speech: sp('질문') };
      yield { type: 'say', id: 1, text: '가나다라마바사', speech: sp('가나다라마바사') };
      yield { type: 'draw', sayId: 1, op: figN('a', 1) };
      yield { type: 'say', id: 2, text: '아자차카타파하', speech: sp('아자차카타파하') };
      yield { type: 'draw', sayId: 2, op: sk('b') };
      await audioStarted;
      await wait(delay);
      yield { type: 'sketch', id: 'b', figure: null };
      yield { type: 'done' };
    }
    const p = new LessonPlayer({ board, layout: new Layout(), audio }).play(live());
    await vi.advanceTimersByTimeAsync(20000);
    expect(await p).toBe('done');
    expect(drawn.map((d) => (d.op as { id?: string }).id)).toEqual(['a']);
    expect(drawn[0].place.rect.x).toBe(452); // 혼자 남았으니 가운데
    if (xAt(drawn, 'a') !== 452) expect(relayouts()).toBeGreaterThanOrEqual(1); // 그린 뒤 옮겼으면 보드에 알렸다
  });
});

// E2(2026-11-23): 수업 끝 이어 물을 질문은 플레이어가 받아 두었다가 끝난 뒤 UI가 꺼내 간다.
describe('LessonPlayer 이어 물을 질문(next)', () => {
  test('next를 받아 두고, 판서·재생에는 영향이 없다', async () => {
    const board = fakeBoard(), audio = fakeAudio();
    const pl = new LessonPlayer({ board, layout: new Layout(), audio });
    expect(pl.nextQuestions()).toEqual([]);
    const r = await pl.play(msgs(
      { type: 'say', id: 1, text: '하나', speech: speech('s1') }, { type: 'draw', sayId: 1, op: T },
      { type: 'next', questions: ['달은 왜 모양이 바뀌어?', '해도 나를 따라와?'] }, { type: 'done' }));
    expect(r).toBe('done');
    expect(pl.nextQuestions()).toEqual(['달은 왜 모양이 바뀌어?', '해도 나를 따라와?']);
    expect(board.calls).toEqual(['sub:하나', 'draw:text']);
    expect(audio.played).toEqual(['s1']);
  });
  test('next가 없으면 빈 목록(카드 없이 지금처럼)', async () => {
    const pl = new LessonPlayer({ board: fakeBoard(), layout: new Layout(), audio: fakeAudio() });
    await pl.play(msgs({ type: 'say', id: 1, text: '하나', speech: null }, { type: 'done' }));
    expect(pl.nextQuestions()).toEqual([]);
  });
  test('돌려준 목록을 고쳐도 플레이어 것은 그대로', async () => {
    const pl = new LessonPlayer({ board: fakeBoard(), layout: new Layout(), audio: fakeAudio() });
    await pl.play(msgs({ type: 'say', id: 1, text: '하나', speech: null }, { type: 'next', questions: ['해는 왜 뜨거워?'] }, { type: 'done' }));
    pl.nextQuestions().push('x');
    expect(pl.nextQuestions()).toEqual(['해는 왜 뜨거워?']);
  });
});

describe('LessonPlayer 빠르기(쉽게 단계 0.9배)', () => {
  const timed = (id: string): Speech => ({ audioBase64: id, mime: 'audio/mpeg', timing: { chars: ['가', '나'], startMs: [0, 900], endMs: [900, 1800] }, durationMs: 1800 });
  const recAudio = () => ({ got: [] as { s: Speech; rate: number | undefined }[], async play(s: Speech, _sig: AbortSignal, rate?: number) { this.got.push({ s, rate }); }, stop: vi.fn(), async unlock() {}, duck() {} });
  const recBoard = () => ({ ms: [] as number[], async draw(_op: any, _p: any, ms: number) { this.ms.push(ms); }, async wipe() {}, clear() {}, setSubtitle() {}, writeIdle() {} });

  test('speed 0.9: 소리는 0.9배로 틀고, 그 문장의 글자 시각·길이는 1/0.9배로 늘린다', async () => {
    const audio = recAudio();
    const r = await new LessonPlayer({ board: recBoard(), layout: new Layout(), audio, speed: 0.9 }).play(msgs(
      { type: 'say', id: 1, text: '가나', speech: timed('s1') }, { type: 'done' }));
    expect(r).toBe('done');
    expect(audio.got[0].rate).toBeCloseTo(0.9);
    expect(audio.got[0].s.durationMs).toBe(2000);
    expect(audio.got[0].s.timing.startMs).toEqual([0, 1000]);
    expect(audio.got[0].s.timing.endMs).toEqual([1000, 2000]);
    expect(audio.got[0].s.audioBase64).toBe('s1'); // 소리 자체는 그대로(늘이는 건 audioOut)
  });

  test('speed가 없으면(보통·깊게) 받은 그대로, 빠르기 1', async () => {
    const audio = recAudio();
    const s = timed('s1');
    await new LessonPlayer({ board: recBoard(), layout: new Layout(), audio }).play(msgs({ type: 'say', id: 1, text: '가나', speech: s }, { type: 'done' }));
    expect(audio.got[0].rate).toBe(1);
    expect(audio.got[0].s).toBe(s);
  });

  test('speed 0.9: 그림 그리는 길이(획 수로 정한 몫)도 1/0.9배', async () => {
    const strokes = Array.from({ length: 12 }, (_, i) => `M${i} 0 L${i} 10`);
    const op: DrawOp = { kind: 'figure', id: 'f', size: 'small', ink: 'green', strokes };
    const run = async (speed?: number) => {
      const board = recBoard();
      await new LessonPlayer({ board, layout: new Layout(), audio: recAudio(), speed }).play(msgs(
        { type: 'say', id: 1, text: '가나', speech: timed('s1') }, { type: 'draw', sayId: 1, op }, { type: 'done' }));
      return board.ms[0];
    };
    const normal = await run();
    expect(normal).toBe(12 * FIGURE_MS_PER_LINE);
    expect(await run(0.9)).toBeCloseTo(normal / 0.9, 5);
  });

  test('이상한 speed(0·음수·NaN)는 1로 본다', async () => {
    for (const speed of [0, -1, Number.NaN]) {
      const audio = recAudio();
      await new LessonPlayer({ board: recBoard(), layout: new Layout(), audio, speed }).play(msgs({ type: 'say', id: 1, text: '가나', speech: timed('s1') }, { type: 'done' }));
      expect(audio.got[0].rate).toBe(1);
    }
  });
});

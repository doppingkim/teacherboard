import { FINAL_WAIT_MS, JOIN_WINDOW_MS, MAX_JOINS, UtteranceJoiner, type JoinedVerdict } from '../../src/server/utteranceJoiner';

const done = (question: string): JoinedVerdict => ({ accept: true, question, reason: 'model', complete: true });
const partial = (accept = false, question = ''): JoinedVerdict => ({ accept, question, reason: 'model', complete: false });

/** 판정 결과를 글마다 정해 두고, 응답 시점은 직접 푼다. */
function setup(verdicts: Record<string, JoinedVerdict>) {
  let now = 0;
  const pending: Array<{ text: string; resolve: (v: JoinedVerdict) => void }> = [];
  const out: Array<{ text: string; v: JoinedVerdict }> = [];
  const j = new UtteranceJoiner({
    classify: (text) => new Promise((resolve) => pending.push({ text, resolve })),
    emit: (text, v) => out.push({ text, v }),
    now: () => now,
  });
  /** 맨 앞 판정을 정해 둔 결과로 푼다. */
  const answer = async () => {
    const p = pending.shift()!;
    p.resolve(verdicts[p.text] ?? done(p.text));
    await Promise.resolve();
    await Promise.resolve();
  };
  const advance = async (ms: number) => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { j, out, pending, answer, advance };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('끝난 말은 바로 내보낸다', async () => {
  const s = setup({});
  s.j.audio(); s.j.end(); s.j.final('달은 왜 따라와?');
  await s.answer();
  expect(s.out).toEqual([{ text: '달은 왜 따라와?', v: done('달은 왜 따라와?') }]);
});

test('덜 끝난 말 + 이어진 말 → 앞 말은 joined, 이은 글을 다시 판정', async () => {
  const s = setup({ '허리디스크가': partial(), '허리디스크가 왜 생겨?': done('허리디스크가 왜 생겨?') });
  s.j.audio(); s.j.end(); s.j.final('허리디스크가');
  await s.answer();
  expect(s.out).toEqual([]); // 기다린다
  expect(s.j.prefix()).toBe('허리디스크가');
  await s.advance(1000);
  s.j.audio(); // 다시 말하기 시작
  await s.advance(5000); // 창(2.5초)이 지나도 말하는 중이면 기다린다
  expect(s.out).toEqual([]);
  s.j.end(); s.j.final('왜 생겨?');
  expect(s.out).toEqual([{ text: '허리디스크가', v: { accept: false, question: '', reason: 'joined', complete: false } }]);
  expect(s.pending.map((p) => p.text)).toEqual(['허리디스크가 왜 생겨?']);
  await s.answer();
  expect(s.out[1]).toEqual({ text: '허리디스크가 왜 생겨?', v: done('허리디스크가 왜 생겨?') });
  expect(s.j.prefix()).toBe('');
});

test('덜 끝난 말 뒤로 아무 말이 없으면 end부터 창이 지난 뒤 처음 판정 그대로', async () => {
  const s = setup({ '그런데 공룡은': partial(true, '그런데 공룡은?') });
  s.j.audio(); s.j.end(); s.j.final('그런데 공룡은');
  await s.advance(1200); // 판정에 1.2초
  await s.answer();
  await s.advance(JOIN_WINDOW_MS - 1200 - 1);
  expect(s.out).toEqual([]);
  await s.advance(1);
  expect(s.out).toEqual([{ text: '그런데 공룡은', v: partial(true, '그런데 공룡은?') }]);
  expect(s.pending).toHaveLength(0); // 모델을 다시 부르지 않는다
});

test('판정이 창보다 늦으면 바로 내보낸다', async () => {
  const s = setup({ '엄마 나': partial() });
  s.j.audio(); s.j.end(); s.j.final('엄마 나');
  await s.advance(JOIN_WINDOW_MS + 500);
  await s.answer();
  await s.advance(0);
  expect(s.out).toEqual([{ text: '엄마 나', v: partial() }]);
});

test('앞 말 판정 중에 다음 말이 확정되면 기다렸다가 바로 잇는다', async () => {
  const s = setup({ '공룡은': partial(), '공룡은 왜 없어졌어?': done('공룡은 왜 없어졌어?') });
  s.j.audio(); s.j.end(); s.j.final('공룡은');
  s.j.audio(); s.j.end(); s.j.final('왜 없어졌어?');
  expect(s.pending.map((p) => p.text)).toEqual(['공룡은']); // 하나씩
  await s.answer();
  expect(s.out[0].v.reason).toBe('joined');
  expect(s.pending.map((p) => p.text)).toEqual(['공룡은 왜 없어졌어?']);
  await s.answer();
  expect(s.out).toHaveLength(2);
  expect(s.out[1].v).toEqual(done('공룡은 왜 없어졌어?'));
});

test('다음 말이 끝났는데 확정이 안 오면 FINAL_WAIT_MS 뒤 그대로', async () => {
  const s = setup({ '공룡은': partial() });
  s.j.audio(); s.j.end(); s.j.final('공룡은');
  await s.answer();
  s.j.audio(); s.j.end();
  await s.advance(FINAL_WAIT_MS);
  expect(s.out).toEqual([{ text: '공룡은', v: partial() }]);
});

test('다음 말이 비었으면 기다리던 말은 처음 판정대로, 빈 말은 empty', async () => {
  const s = setup({ '공룡은': partial() });
  s.j.audio(); s.j.end(); s.j.final('공룡은');
  await s.answer();
  s.j.audio(); s.j.end(); s.j.final('');
  expect(s.out.map((o) => [o.text, o.v.reason])).toEqual([['공룡은', 'model'], ['', 'empty']]);
});

test(`이어 붙이기는 ${MAX_JOINS}번까지`, async () => {
  const s = setup({ 'a': partial(), 'a b': partial(), 'a b c': partial(true, 'abc') });
  s.j.audio(); s.j.end(); s.j.final('a'); await s.answer();
  s.j.audio(); s.j.end(); s.j.final('b'); await s.answer();
  s.j.audio(); s.j.end(); s.j.final('c'); await s.answer();
  expect(s.out.map((o) => [o.text, o.v.reason])).toEqual([['a', 'joined'], ['a b', 'joined'], ['a b c', 'model']]);
});

test('판정이 던지면 error로 보낸다', async () => {
  const out: JoinedVerdict[] = [];
  const j = new UtteranceJoiner({ classify: async () => { throw new Error('x'); }, emit: (_t, v) => out.push(v) });
  j.final('왜?');
  await vi.waitFor(() => expect(out).toEqual([{ accept: false, question: '', reason: 'error', complete: true }]));
});

test('close 뒤에는 아무것도 보내지 않는다', async () => {
  const s = setup({ '공룡은': partial() });
  s.j.audio(); s.j.end(); s.j.final('공룡은');
  await s.answer();
  s.j.close();
  await s.advance(10_000);
  s.j.final('왜?');
  expect(s.out).toEqual([]);
  expect(s.pending).toHaveLength(0);
});

test('잡아 둔 말은 다음 말이 확정되지 않아도(잡음 뒤 확정이 안 옴) 끝없이 기다리지 않고 처음 판정 그대로 나간다', async () => {
  const s = setup({ '그런데 공룡은': partial(true, '그런데 공룡은?') });
  s.j.audio(); s.j.end(); s.j.final('그런데 공룡은');
  await s.answer();
  // 짧은 잡음이 3초보다 자주 열렸다 닫히는데 확정된 글이 안 온다(commit_throttled 등): end·audio마다 기다림이 다시 늘어나면 안 된다.
  for (let i = 0; i < 30; i++) {
    s.j.audio();
    await s.advance(500);
    s.j.end();
    await s.advance(FINAL_WAIT_MS - 1000);
  }
  expect(s.out).toEqual([{ text: '그런데 공룡은', v: partial(true, '그런데 공룡은?') }]);
});

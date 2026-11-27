import { SpeechGate, type GateEvent } from '../../src/web/voice/speechGate';

// 합성 프레임: rms가 level이 되는 상수 신호 (rms = |v|/32768)
const frame = (level: number) => new Int16Array(320).fill(Math.round(level * 32768));
const SILENCE = 0.002;
const SPEECH = 0.1;

function feed(gate: SpeechGate, level: number, frames: number): GateEvent[] {
  const out: GateEvent[] = [];
  for (let i = 0; i < frames; i++) out.push(...gate.push(frame(level)));
  return out;
}
const types = (e: GateEvent[]) => e.map((x) => x.type);

test('짧은 소리(100ms)는 시작 안 함', () => {
  const g = new SpeechGate();
  feed(g, SILENCE, 50);
  const ev = [...feed(g, SPEECH, 5), ...feed(g, SILENCE, 60)];
  expect(ev.length).toBe(0);
});

test('말 200ms → start(preRoll ≤ 25프레임) 후 audio', () => {
  const g = new SpeechGate();
  feed(g, SILENCE, 100);
  const ev = feed(g, SPEECH, 10);
  const start = ev.find((e) => e.type === 'start');
  expect(start).toBeDefined();
  if (start?.type === 'start') {
    expect(start.preRoll.length).toBeLessThanOrEqual(25);
    expect(start.preRoll.length).toBeGreaterThan(0);
  }
  expect(ev[0].type).toBe('start');
  expect(types(ev).slice(1).every((t) => t === 'audio')).toBe(true);
  expect(ev.filter((e) => e.type === 'audio').length).toBeGreaterThan(0);
});

test('말 끝나고 1300ms 뒤 end, 그 전엔 audio 계속(말 중간 쉼을 끊지 않게)', () => {
  const g = new SpeechGate();
  feed(g, SILENCE, 50);
  feed(g, SPEECH, 20);
  const before = feed(g, SILENCE, 64); // 1280ms
  expect(types(before).every((t) => t === 'audio')).toBe(true);
  expect(before.length).toBe(64);
  const after = feed(g, SILENCE, 2);
  expect(types(after)).toContain('end');
  // end 이후엔 조용
  expect(feed(g, SILENCE, 20).length).toBe(0);
});

test('잡음 바닥이 올라가면 문턱도 올라감', () => {
  const quiet = new SpeechGate();
  feed(quiet, SILENCE, 100);
  expect(types(feed(quiet, 0.03, 10))).toContain('start');

  const noisy = new SpeechGate();
  for (const lv of [0.004, 0.006, 0.009, 0.013, 0.019]) feed(noisy, lv, 60); // 바닥이 서서히 ≈0.019로 → 시작 문턱 ≈0.057
  expect(feed(noisy, 0.03, 10).length).toBe(0);
});

test('strict면 같은 소리로 시작 안 함', () => {
  const g = new SpeechGate();
  g.setStrict(true);
  feed(g, SILENCE, 50);
  expect(feed(g, 0.02, 8).length).toBe(0); // 0.015*1.5=0.0225 > 0.02

  const g2 = new SpeechGate();
  feed(g2, SILENCE, 50);
  expect(types(feed(g2, 0.02, 10))).toContain('start');
});

test('reset은 상태를 비움', () => {
  const g = new SpeechGate();
  feed(g, SILENCE, 30);
  feed(g, SPEECH, 20);
  g.reset();
  expect(feed(g, SILENCE, 50).length).toBe(0); // 말하던 상태가 풀려 end/audio가 안 나옴
});

test('reset은 잡음 바닥도 지움(다시 보정)', () => {
  const g = new SpeechGate();
  feed(g, 0.05, 100);
  g.reset();
  feed(g, SILENCE, 30);
  expect(types(feed(g, SPEECH, 10))).toContain('start');
});

test('시작 후 500ms는 보정만: 처음부터 계속되는 소음은 start 안 함', () => {
  const g = new SpeechGate();
  expect(feed(g, 0.05, 300).length).toBe(0);
  const g2 = new SpeechGate();
  expect(feed(g2, SPEECH, 25).length).toBe(0); // 보정 구간엔 큰 소리도 start 불가
});

test('말하는 동안 바닥이 천천히 따라가서 일정한 소음은 결국 end', () => {
  const g = new SpeechGate();
  feed(g, SILENCE, 30);
  const ev = feed(g, SPEECH, 500);
  const endIdx = types(ev).indexOf('end');
  expect(types(ev)[0]).toBe('start');
  expect(endIdx).toBeGreaterThan(0);
  expect(ev.slice(endIdx + 1).length).toBe(0); // 이후 다시 start 안 함
});

test('15초 상한: 강제 end 후 소리가 잦아들 때까지 start 금지', () => {
  const g = new SpeechGate({ maxSpeechMs: 400 }); // 20프레임
  feed(g, SILENCE, 30);
  const ev = feed(g, SPEECH, 40);
  expect(types(ev).filter((t) => t === 'end').length).toBe(1);
  expect(types(ev).filter((t) => t === 'start').length).toBe(1);
  expect(feed(g, SPEECH, 20).length).toBe(0); // 여전히 시끄러움 → 시작 금지
  expect(feed(g, SILENCE, 64).length).toBe(0); // 1300ms 못 채움 → 계속 잠김
  expect(feed(g, SILENCE, 2).length).toBe(0); // 잠금 풀림(이벤트는 없음)
  expect(types(feed(g, SPEECH, 10))).toContain('start');
});

test('pre-roll 내용과 순서', () => {
  const g = new SpeechGate();
  const mk = (v: number) => new Int16Array(320).fill(v);
  for (let i = 0; i < 30; i++) g.push(mk(10 + i)); // 조용(값 10..39)
  const out: GateEvent[] = [];
  for (let i = 0; i < 9; i++) out.push(...g.push(mk(4000 + i)));
  const start = out[0];
  expect(start.type).toBe('start');
  if (start.type !== 'start') return;
  expect(start.preRoll.length).toBe(25);
  const vals = start.preRoll.map((f) => f[0]);
  expect(vals).toEqual([...vals].sort((a, b) => a - b)); // 시간순
  expect(vals[0]).toBe(10 + 30 - 17); // 말 8프레임 + 그 앞 17프레임
  expect(vals[24]).toBe(4007);
  const next = out[1];
  expect(next.type === 'audio' && next.pcm[0]).toBe(4008); // 중복·누락 없이 이어짐
});

test('end는 정확히 한 번, 두 번째 발화도 동작', () => {
  const g = new SpeechGate();
  feed(g, SILENCE, 30);
  const first = [...feed(g, SPEECH, 20), ...feed(g, SILENCE, 200)];
  expect(types(first).filter((t) => t === 'end').length).toBe(1);
  const second = [...feed(g, SPEECH, 20), ...feed(g, SILENCE, 100)];
  expect(types(second)[0]).toBe('start');
  expect(types(second).filter((t) => t === 'end').length).toBe(1);
});

test('start는 연 소리 길이(voicedMs), audio는 프레임마다 voiced를 알려 준다', () => {
  const g = new SpeechGate();
  feed(g, SILENCE, 50);
  const ev = feed(g, SPEECH, 10);
  const start = ev.find((e) => e.type === 'start');
  expect(start).toMatchObject({ type: 'start', voicedMs: 160 }); // 150ms → 8프레임
  const audio = ev.filter((e) => e.type === 'audio');
  expect(audio.every((e) => e.type === 'audio' && e.voiced)).toBe(true);
  const quiet = feed(g, SILENCE, 3);
  expect(quiet.every((e) => e.type === 'audio' && !e.voiced)).toBe(true);
});

test('수업 중(strict)에는 문턱이 두 배라 조금 큰 방 소음으로는 안 열린다', () => {
  const floor = 0.004; // 시작 문턱: 보통 max(0.012, 0.015) = 0.015, strict 0.03
  const normal = new SpeechGate();
  feed(normal, floor, 60);
  expect(types(feed(normal, 0.025, 10))).toContain('start');
  const strict = new SpeechGate();
  strict.setStrict(true);
  feed(strict, floor, 60);
  expect(feed(strict, 0.025, 10).length).toBe(0);
  expect(types(feed(strict, SPEECH, 10))).toContain('start'); // 또렷한 말소리는 연다
});

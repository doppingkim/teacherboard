import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import { DEFAULT_CONFIRM, HEARD_LINGER_MS, MISHEARD_COOLDOWN_MS, MISHEARD_LINGER_MS, MISS_WINDOW_MS, VoiceController } from '../../src/web/voice/voiceController';

function rig(opts: { lessonActive?: boolean; spoken?: string[]; confirm?: { voicedMs: number; minLetters: number } } = {}) {
  const conn = { ready: true };
  const log: string[] = [];
  const client = {
    sendPcm: vi.fn((pcm: Int16Array) => log.push(`pcm:${Array.from(pcm).join(',')}`)),
    end: vi.fn(() => log.push('end')),
    setState: vi.fn((a: boolean, s: string[]) => log.push(`state:${a}:${s.join('|')}`)),
  };
  const audio = { duck: vi.fn((on: boolean) => log.push(`duck:${on}`)) };
  const questions: string[] = [];
  const heard: (string | null)[] = [];
  const vc = new VoiceController({
    client,
    audio,
    isReady: () => conn.ready,
    lessonActive: () => opts.lessonActive ?? true,
    recentSpoken: () => opts.spoken ?? ['달은 지구를 돌아요'],
    onQuestion: (q) => questions.push(q),
    onHeard: (t) => heard.push(t),
    // 덕킹·판정 셈을 보는 테스트: 말 확인은 start에서 바로(확인 규칙은 아래 '말 확인' 묶음에서 본다)
    confirm: opts.confirm ?? { voicedMs: 0, minLetters: 0 },
  });
  return { vc, client, audio, log, questions, heard, conn };
}
const pcm = (...v: number[]) => new Int16Array(v);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('VoiceController', () => {
  test('start → duck(true)·state 전송, pre-roll 다음 audio를 보내고 end면 end', () => {
    const { vc, log, heard } = rig({ lessonActive: true, spoken: ['하나', '둘'] });
    vc.handle({ type: 'start', preRoll: [pcm(1), pcm(2)], voicedMs: 0 });
    vc.handle({ type: 'audio', pcm: pcm(3), voiced: false });
    vc.handle({ type: 'end' });
    expect(log).toEqual(['state:true:하나|둘', 'duck:true', 'pcm:1', 'pcm:2', 'pcm:3', 'state:true:하나|둘', 'end']);
    expect(heard).toEqual(['']);
  });

  test('end 때도 state를 다시 보낸다(판정 때 recentSpoken이 최신이게)', () => {
    const spoken = ['하나'];
    const { vc, log } = rig({ lessonActive: true, spoken });
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    spoken.push('둘'); // 말하는 동안 선생님이 한 문장 더 말했다
    vc.handle({ type: 'end' });
    expect(log).toEqual(['state:true:하나', 'duck:true', 'state:true:하나|둘', 'end']);
  });

  test('partial은 들은 말로 보여 준다', () => {
    const { vc, heard } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.partial('달은');
    expect(heard).toEqual(['', '달은']);
  });

  test('판정을 기다리지도 말하지도 않을 때 온 늦은 partial은 말풍선을 다시 열지 않는다', () => {
    const { vc, heard } = rig();
    vc.partial('혼자'); // 시작 전
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.partial('달은'); // 판정 기다리는 중 — 보여 준다
    vi.advanceTimersByTime(4000);
    vc.partial('늦은 말');
    expect(heard).toEqual(['', '달은', null]);
  });

  test('거절 utterance → duck(false), 질문 안 함', () => {
    const { vc, audio, questions, heard } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.utterance({ text: '우와!', accept: false, question: '' });
    expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
    expect(heard.at(-1)).toBeNull();
    expect(questions).toEqual([]);
  });

  test('수락 → onQuestion(question)', () => {
    const { vc, audio, questions, heard } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.utterance({ text: '달은 왜 따라와', accept: true, question: '달은 왜 나를 따라와?' });
    expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
    // 말풍선은 닫았다가, 고쳐 알아들은 질문을 잠깐 보여 준 뒤 닫는다
    expect(heard.slice(-2)).toEqual([null, '달은 왜 나를 따라와?']);
    vi.advanceTimersByTime(HEARD_LINGER_MS);
    expect(heard.at(-1)).toBeNull();
    expect(questions).toEqual(['달은 왜 나를 따라와?']);
  });

  test('수락이어도 question이 비어 있으면 묻지 않는다', () => {
    const { vc, questions } = rig();
    vc.utterance({ text: '음', accept: true, question: '  ' });
    expect(questions).toEqual([]);
  });

  test('end 뒤 4초 안에 판정 없으면 duck(false)', () => {
    const { vc, audio, heard } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vi.advanceTimersByTime(3999);
    expect(audio.duck.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(1);
    expect(audio.duck.mock.calls).toEqual([[true], [false]]);
    expect(heard.at(-1)).toBeNull();
  });

  test('4초 전에 판정이 오면 타이머는 다시 unduck하지 않는다', () => {
    const { vc, audio } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.utterance({ text: '우와', accept: false, question: '' });
    vi.advanceTimersByTime(10000);
    expect(audio.duck.mock.calls).toEqual([[true], [false]]);
  });

  test('다음 말이 시작되면 앞 타이머가 덕킹을 풀지 않는다', () => {
    const { vc, audio } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vi.advanceTimersByTime(3000);
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vi.advanceTimersByTime(3000); // 앞 end에서 6초 — 아직 말하는 중
    expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
  });

  test('말하는 중에 앞 말의 판정이 오면 질문은 하되 덕킹은 유지', () => {
    const { vc, audio, questions } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.utterance({ text: '왜?', accept: true, question: '왜 그래?' });
    expect(questions).toEqual(['왜 그래?']);
    expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
  });

  test('듣기 연결이 ready가 아니면 start를 무시한다(덕킹 안 함, 뒤따르는 audio/end도 안 보냄)', () => {
    const { vc, client, audio, heard, conn } = rig();
    conn.ready = false;
    vc.handle({ type: 'start', preRoll: [pcm(1)], voicedMs: 0 });
    vc.handle({ type: 'audio', pcm: pcm(2), voiced: false });
    vc.handle({ type: 'end' });
    expect(audio.duck).not.toHaveBeenCalled();
    expect(client.setState).not.toHaveBeenCalled();
    expect(client.sendPcm).not.toHaveBeenCalled();
    expect(client.end).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
    conn.ready = true;
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    expect(audio.duck).toHaveBeenCalledWith(true);
  });

  test('판정을 기다리는 말이 남아 있으면 덕킹을 유지하고, 모두 오면 푼다', () => {
    const { vc, audio, heard, questions } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.utterance({ text: '우와', accept: false, question: '' }); // 첫 말 판정 — 둘째가 남음
    expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
    expect(heard.at(-1)).not.toBeNull();
    vc.utterance({ text: '왜?', accept: true, question: '왜 그래?' });
    expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
    expect(heard.slice(-2)).toEqual([null, '왜 그래?']);
    expect(questions).toEqual(['왜 그래?']);
  });

  test('판정 하나가 끝내 안 와도 마지막 end에서 4초 뒤엔 덕킹을 푼다', () => {
    const { vc, audio } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.utterance({ text: '우와', accept: false, question: '' });
    vi.advanceTimersByTime(3999);
    expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
    // 시간이 지난 뒤 늦게 온 판정은 질문은 넘기되 셈을 음수로 만들지 않는다
    vc.utterance({ text: '왜?', accept: true, question: '왜?' });
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vc.utterance({ text: '음', accept: false, question: '' });
    expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
  });

  test('mute면 무시', () => {
    const { vc, client, audio, questions } = rig();
    vc.setMuted(true);
    vc.handle({ type: 'start', preRoll: [pcm(1)], voicedMs: 0 });
    vc.handle({ type: 'audio', pcm: pcm(2), voiced: false });
    vc.handle({ type: 'end' });
    vc.utterance({ text: '왜?', accept: true, question: '왜?' });
    expect(client.sendPcm).not.toHaveBeenCalled();
    expect(client.end).not.toHaveBeenCalled();
    expect(client.setState).not.toHaveBeenCalled();
    expect(audio.duck).not.toHaveBeenCalledWith(true);
    expect(questions).toEqual([]);
  });

  test('말하는 중에 mute하면 덕킹을 풀고 서버 쪽 말을 끝낸다', () => {
    const { vc, client, audio, heard } = rig();
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.setMuted(true);
    expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(heard.at(-1)).toBeNull();
    vi.advanceTimersByTime(10000);
    expect(audio.duck.mock.calls).toEqual([[true], [false]]);
  });

  test('mute를 풀면 다시 듣는다. start 없이 온 audio/end는 보내지 않는다', () => {
    const { vc, client } = rig();
    vc.setMuted(true);
    vc.setMuted(false);
    vc.handle({ type: 'audio', pcm: pcm(1), voiced: false }); // 게이트가 말 중간이었던 경우
    vc.handle({ type: 'end' });
    expect(client.sendPcm).not.toHaveBeenCalled();
    expect(client.end).not.toHaveBeenCalled();
    vc.handle({ type: 'start', preRoll: [pcm(5)], voicedMs: 0 });
    expect(client.sendPcm).toHaveBeenCalledTimes(1);
  });

  describe('mute·장치 바꾸기(flush)로 끝낸 말의 판정은 무시한다', () => {
    const flush = (vc: VoiceController) => {
      vc.setMuted(true);
      vc.setMuted(false);
    };

    test('말하는 중에 flush → 그 말의 판정이 나중에 와도 질문하지 않는다', () => {
      const { vc, questions } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      flush(vc);
      vc.utterance({ text: '왜?', accept: true, question: '왜?' });
      expect(questions).toEqual([]);
    });

    test('end를 보낸 뒤(판정 대기 중) flush해도 그 판정은 무시한다', () => {
      const { vc, questions } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vc.handle({ type: 'end' });
      flush(vc);
      vc.utterance({ text: '왜?', accept: true, question: '왜?' });
      expect(questions).toEqual([]);
    });

    test('예전 판정이 새 말의 대기 셈을 깎지 않는다(덕킹 유지), 새 판정은 받는다', () => {
      const { vc, audio, questions } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      flush(vc);
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '옛말', accept: true, question: '옛말?' });
      expect(questions).toEqual([]);
      expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
      vc.utterance({ text: '새 말', accept: true, question: '새 말?' });
      expect(questions).toEqual(['새 말?']);
      expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
    });

    test('듣기 연결이 끊기면(linkReset) 남은 예전 판정은 오지 않으므로 잊는다', () => {
      const { vc, questions } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      flush(vc);
      vc.linkReset();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '새 말', accept: true, question: '새 말?' });
      expect(questions).toEqual(['새 말?']);
    });

    test('ready가 아닐 때 보낸 end(버려짐)는 판정을 기다리지 않는다', () => {
      const { vc, questions, conn } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      conn.ready = false;
      flush(vc); // end는 클라이언트가 버린다 → 판정이 오지 않는다
      conn.ready = true;
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '새 말', accept: true, question: '새 말?' });
      expect(questions).toEqual(['새 말?']);
    });

    test('15초 넘게 안 온 예전 판정은 잊는다(업스트림이 확정을 버린 경우)', () => {
      const { vc, questions } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      flush(vc);
      vi.advanceTimersByTime(15_001);
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '새 말', accept: true, question: '새 말?' });
      expect(questions).toEqual(['새 말?']);
    });
  });

  describe('최대 덕킹 감시(20초)', () => {
    test('20초 동안 계속 덕킹이면 풀고, 말을 끝내고(end), 셈을 비운다', () => {
      const { vc, client, audio, heard } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vi.advanceTimersByTime(19_999);
      expect(audio.duck.mock.calls).toEqual([[true]]);
      vi.advanceTimersByTime(1);
      expect(audio.duck.mock.calls).toEqual([[true], [false]]);
      expect(client.end).toHaveBeenCalledTimes(1);
      expect(heard.at(-1)).toBeNull();
      // 게이트가 아직 말 중이어도 이어지는 audio/end는 보내지 않는다
      vc.handle({ type: 'audio', pcm: pcm(1), voiced: false });
      vc.handle({ type: 'end' });
      expect(client.sendPcm).not.toHaveBeenCalled();
      expect(client.end).toHaveBeenCalledTimes(1);
      // 다음 말은 다시 덕킹한다
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
    });

    test('말과 판정 대기가 이어져도(연속 덕킹) 처음 덕킹부터 20초', () => {
      const { vc, audio } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vi.advanceTimersByTime(3_000);
      vc.handle({ type: 'end' });
      vi.advanceTimersByTime(2_000);
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 }); // 앞 판정이 안 와 아직 덕킹 중
      vi.advanceTimersByTime(14_999);
      expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
      vi.advanceTimersByTime(1);
      expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
    });

    test('덕킹이 풀리면 감시도 다시 센다', () => {
      const { vc, audio, client } = rig();
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '우와', accept: false, question: '' }); // 풀림
      vi.advanceTimersByTime(10_000);
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vi.advanceTimersByTime(19_999);
      expect(audio.duck.mock.calls.at(-1)).toEqual([true]);
      expect(client.end).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(audio.duck.mock.calls.at(-1)).toEqual([false]);
      expect(client.end).toHaveBeenCalledTimes(2);
    });
  });

  test('unduckAfterMs를 바꿀 수 있다', () => {
    const audio = { duck: vi.fn() };
    const vc = new VoiceController({
      client: { sendPcm() {}, end() {}, setState() {} },
      audio,
      isReady: () => true,
      lessonActive: () => false,
      recentSpoken: () => [],
      onQuestion() {},
      onHeard() {},
      unduckAfterMs: 100,
      confirm: { voicedMs: 0, minLetters: 0 },
    });
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    vc.handle({ type: 'end' });
    vi.advanceTimersByTime(100);
    expect(audio.duck.mock.calls).toEqual([[true], [false]]);
  });

  describe('말 확인(기본: 큰 소리 350ms + partial 글자 2자)', () => {
    const voiced = (ms: number) => ({ type: 'audio' as const, pcm: new Int16Array(ms * 16), voiced: true });
    const quiet = (ms: number) => ({ type: 'audio' as const, pcm: new Int16Array(ms * 16), voiced: false });

    test('잡음(글자 없는 partial)은 오래 이어져도 덕킹·말풍선 없음. 서버로는 보내고 판정은 받는다', () => {
      const { vc, audio, heard, client } = rig({ confirm: DEFAULT_CONFIRM });
      vc.handle({ type: 'start', preRoll: [], voicedMs: 160 });
      for (let i = 0; i < 10; i++) vc.handle(voiced(100));
      vc.partial('');
      vc.partial('...');
      vc.handle({ type: 'end' });
      expect(audio.duck).not.toHaveBeenCalled();
      expect(heard).toEqual([]);
      expect(client.sendPcm).toHaveBeenCalledTimes(10);
      expect(client.end).toHaveBeenCalledTimes(1);
      vc.utterance({ text: '', accept: false, question: '' });
      expect(audio.duck).not.toHaveBeenCalled(); // 줄인 적이 없으니 풀 것도 없다
      expect(heard).toEqual([]);
    });

    test('글자가 나와도 큰 소리가 350ms가 안 되면 아직 확인 안 함', () => {
      const { vc, audio } = rig({ confirm: DEFAULT_CONFIRM });
      vc.handle({ type: 'start', preRoll: [], voicedMs: 160 });
      vc.handle(voiced(100));
      vc.handle(quiet(500)); // 조용한 프레임은 세지 않는다
      vc.partial('달은');
      expect(audio.duck).not.toHaveBeenCalled();
      vc.handle(voiced(100)); // 160+100+100 = 360ms
      expect(audio.duck.mock.calls).toEqual([[true]]);
    });

    test('큰 소리가 이어졌고 글자가 나오면 그때 덕킹하고 그때까지 들은 말을 보여 준다', () => {
      const { vc, audio, heard } = rig({ confirm: DEFAULT_CONFIRM });
      vc.handle({ type: 'start', preRoll: [], voicedMs: 160 });
      vc.handle(voiced(200));
      vc.partial('허');
      expect(audio.duck).not.toHaveBeenCalled();
      vc.partial('허리디');
      expect(audio.duck.mock.calls).toEqual([[true]]);
      expect(heard).toEqual(['허리디']);
      vc.partial('허리디스크');
      expect(heard).toEqual(['허리디', '허리디스크']);
    });

    test('확인 안 된 짧은 질문도 받아들이면 묻고, 알아들은 말을 잠깐 보여 준다', () => {
      const { vc, audio, heard, questions } = rig({ confirm: DEFAULT_CONFIRM });
      vc.handle({ type: 'start', preRoll: [], voicedMs: 160 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '왜', accept: true, question: '왜?' });
      expect(audio.duck).not.toHaveBeenCalled();
      expect(questions).toEqual(['왜?']);
      expect(heard).toEqual(['왜?']);
      vi.advanceTimersByTime(HEARD_LINGER_MS);
      expect(heard).toEqual(['왜?', null]);
    });

    test('onQuestion은 받아 적은 그대로의 말도 함께 넘긴다', () => {
      const got: Array<[string, string]> = [];
      const vc = new VoiceController({
        client: { sendPcm() {}, end() {}, setState() {} },
        audio: { duck() {} },
        isReady: () => true,
        lessonActive: () => false,
        recentSpoken: () => [],
        onQuestion: (q, h) => got.push([q, h]),
        onHeard() {},
      });
      vc.handle({ type: 'start', preRoll: [], voicedMs: 160 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '퀄리디스크가 뭐야', accept: true, question: '허리디스크가 뭐야?' });
      expect(got).toEqual([['허리디스크가 뭐야?', '퀄리디스크가 뭐야']]);
    });

    test('남은 말풍선은 새 말이 확인되면 그 말로 바뀌고, 그 뒤 타이머가 닫지 않는다', () => {
      const { vc, heard } = rig({ confirm: DEFAULT_CONFIRM });
      vc.handle({ type: 'start', preRoll: [], voicedMs: 400 });
      vc.handle({ type: 'end' });
      vc.utterance({ text: '왜', accept: true, question: '왜?' });
      vc.handle({ type: 'start', preRoll: [], voicedMs: 400 });
      vc.partial('그럼 달은');
      expect(heard).toEqual(['왜?', '그럼 달은']);
      vi.advanceTimersByTime(HEARD_LINGER_MS);
      expect(heard.at(-1)).toBe('그럼 달은');
    });
  });
});

// E7(2026-11-23): 말로 물었는데 연달아 못 알아들으면 말풍선에 "다시 말해 줄래?"를 한 번.
describe('못 알아들음 안내', () => {
  const MSG = '잘 못 들었어. 다시 말해 줄래?';
  function rigMiss(o: { lesson?: boolean; misheard?: string | null } = {}) {
    const st = { lesson: o.lesson ?? false };
    const heard: (string | null)[] = [];
    const questions: string[] = [];
    const vc = new VoiceController({
      client: { sendPcm: vi.fn(), end: vi.fn(), setState: vi.fn() },
      audio: { duck: vi.fn() },
      isReady: () => true,
      lessonActive: () => st.lesson,
      recentSpoken: () => [],
      onQuestion: (q) => questions.push(q),
      onHeard: (t) => heard.push(t),
      ...(o.misheard === null ? {} : { misheard: o.misheard ?? MSG }),
    });
    /** 큰 소리 voicedMs 동안 말하고 끝낸다(16kHz: 16샘플 = 1ms). */
    const say = (voicedMs = 600) => {
      vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
      vc.handle({ type: 'audio', pcm: new Int16Array(voicedMs * 16), voiced: true });
      vc.handle({ type: 'end' });
    };
    const miss = (text = '음 그거') => vc.utterance({ text, accept: false, question: '', miss: true });
    return { vc, heard, questions, say, miss, st };
  }

  test('짧은 시간에 두 번 못 알아들으면 안내를 한 번 보이고, 잠시 뒤 닫는다', () => {
    const { heard, say, miss } = rigMiss();
    say(); miss();
    expect(heard).not.toContain(MSG);
    vi.advanceTimersByTime(3000);
    say(); miss('그거 뭐');
    expect(heard.filter((h) => h === MSG)).toHaveLength(1);
    vi.advanceTimersByTime(MISHEARD_LINGER_MS);
    expect(heard.at(-1)).toBeNull();
  });

  test('한 번만이면 안내하지 않는다, 두 번이 MISS_WINDOW_MS보다 멀면 안내하지 않는다', () => {
    const { heard, say, miss } = rigMiss();
    say(); miss();
    vi.advanceTimersByTime(MISS_WINDOW_MS + 1000);
    say(); miss();
    expect(heard).not.toContain(MSG);
  });

  test('시끄러운 TV처럼 계속 못 알아들어도 안내는 한 번뿐(쉬는 시간 동안)', () => {
    const { heard, say, miss } = rigMiss();
    for (let i = 0; i < 12; i++) {
      say(); miss();
      vi.advanceTimersByTime(4000);
    }
    expect(heard.filter((h) => h === MSG)).toHaveLength(1);
    vi.advanceTimersByTime(MISHEARD_COOLDOWN_MS);
    say(); miss(); say(); miss();
    expect(heard.filter((h) => h === MSG)).toHaveLength(2);
  });

  test('질문을 받아들이면 셈과 쉬는 시간을 처음부터(다음에 또 못 알아들으면 다시 안내)', () => {
    const { vc, heard, say, miss } = rigMiss();
    say(); miss(); say(); miss();
    say(); vc.utterance({ text: '달은 왜?', accept: true, question: '달은 왜?' });
    vi.advanceTimersByTime(5000);
    say(); miss(); say(); miss();
    expect(heard.filter((h) => h === MSG)).toHaveLength(2);
  });

  test.each([
    ['수업 중(선생님이 말하는 중·생각 중)', { lesson: true }, 600, '음 그거', true],
    ['짧은 잡음(큰 소리가 confirm.voicedMs보다 짧음)', {}, 100, '음 그거', true],
    ['긴 말(TV·어른 대화일 가능성)', {}, 600, '오늘 저녁 뉴스입니다 전국에 비가 내리겠고 바람도 강하게 불겠습니다 우산을 챙기세요', true],
    ['miss가 아닌 거절(감탄사·에코)', {}, 600, '우와', false],
    ['받아 적은 글자가 없음(큰 잡음, QA 2026-11-23)', {}, 600, '', true],
    ['안내 문구를 안 줌(기능 끔)', { misheard: null }, 600, '음 그거', true],
  ] as const)('안내하지 않는다: %s', (_n, o, voicedMs, text, isMiss) => {
    const { vc, heard, say } = rigMiss(o as { lesson?: boolean; misheard?: null });
    for (let i = 0; i < 3; i++) {
      say(voicedMs);
      vc.utterance({ text, accept: false, question: '', ...(isMiss ? { miss: true } : {}) });
    }
    expect(heard).not.toContain(MSG);
  });

  test('다시 말하는 중이면 덮지 않는다(그 말의 말풍선이 우선)', () => {
    const { vc, heard, say, miss } = rigMiss();
    say(); miss();
    say(); // 판정이 오기 전에 또 말하기 시작
    vc.handle({ type: 'start', preRoll: [], voicedMs: 0 });
    miss();
    expect(heard).not.toContain(MSG);
  });
});

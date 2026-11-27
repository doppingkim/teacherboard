// 확정된 말(Scribe final)을 판정해 들은 순서대로 내보낸다. 말이 덜 끝난 것 같으면(판정 complete: false)
// 바로 내보내지 않고 잠깐 기다렸다가 다음 말과 이어 붙여 다시 판정한다(한국어는 말 중간에 쉬는 일이 잦다).
//
// 규칙
// - 확정된 말 하나마다 utterance 메시지를 정확히 하나, 들은 순서대로 보낸다(브라우저는 보낸 end 순서대로 판정을 맞춘다).
// - 판정은 하나씩 한다(앞 말이 덜 끝났으면 뒤 말과 이어야 하니까).
// - 덜 끝난 말(held)은:
//   · 다음 확정된 말이 오면 held 몫으로 "이어 붙임"(accept false, reason joined)을 먼저 보내고, 이은 글을 다시 판정해 다음 말 몫으로 보낸다.
//   · 다음 말이 없으면 그 말의 end부터 JOIN_WINDOW_MS가 지날 때까지 기다리고, 지나면 처음 판정 그대로 보낸다(모델을 다시 부르지 않는다).
//   · 기다리는 동안 소리가 다시 오면(다음 말이 시작됨) 창을 멈추고 그 말의 확정을 기다린다(end 뒤 FINAL_WAIT_MS 안 오면 그대로 보낸다).
// - 이어 붙이기는 MAX_JOINS번까지. 그 뒤엔 덜 끝났어도 그대로 보낸다.
import type { Verdict } from './classify';

/** 덜 끝난 말의 end부터 다음 말이 시작되기를 기다리는 시간. 판정에 걸린 시간도 여기에 든다. */
export const JOIN_WINDOW_MS = 2500;
/** 다음 말이 끝났는데(end) 확정된 글이 이만큼 안 오면 기다리던 말을 그대로 보낸다. */
export const FINAL_WAIT_MS = 3000;
/** 다음 말이 이만큼 계속되면(끝이 안 오면) 기다리던 말을 그대로 보낸다. 브라우저 게이트 최대 길이(15초)보다 길게. */
export const SEGMENT_MAX_MS = 20_000;
export const MAX_JOINS = 2;
/** 덜 끝난 말을 잡아 두는 최대 시간. 소리·end가 와도 이보다 오래 늘리지 않는다(확정된 글이 끝내 안 오는 잡음이 되풀이될 때). */
const HOLD_MAX_MS = SEGMENT_MAX_MS + FINAL_WAIT_MS;
/** 이만큼 지나도 확정된 글이 안 온 end는 잊는다. */
const STALE_END_MS = 15_000;

export type JoinedVerdict = Pick<Verdict, 'accept' | 'question' | 'complete'> & { reason: Verdict['reason'] | 'error' | 'joined' };

export type UtteranceJoinerDeps = {
  /** 글 하나를 판정한다. 던지지 않는다고 기대하지만, 던지면 error 판정으로 본다. */
  classify(text: string): Promise<JoinedVerdict>;
  /**
   * 확정된 말 하나의 결과. text는 판정한 글(이은 글이면 이은 전체). ms는 판정에 걸린 시간.
   * sttMs는 브라우저가 말을 끝낸(end) 뒤 받아쓰기가 확정되기까지 걸린 시간(이은 글이면 마지막 말 것).
   */
  emit(text: string, v: JoinedVerdict, ms: number, sttMs: number): void;
  now?: () => number;
};

type Held = { text: string; v: JoinedVerdict; ms: number; joins: number; endAt: number; since: number; sttMs: number };

export class UtteranceJoiner {
  private readonly now: () => number;
  /** 아직 판정을 시작하지 않은 확정된 말(그 말의 end 시각과 함께). */
  private finals: Array<{ text: string; endAt: number; sttMs: number }> = [];
  /** end를 받았지만 확정된 글이 아직 안 온 말들의 end 시각. */
  private ends: number[] = [];
  private busy = false;
  private held: Held | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 마지막 end 뒤로 소리가 왔다(다음 말이 진행 중). */
  private segmentOpen = false;
  private closed = false;

  constructor(private readonly deps: UtteranceJoinerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 브라우저 소리가 왔다. */
  audio(): void {
    if (this.segmentOpen) return;
    this.segmentOpen = true;
    if (this.held && !this.busy) this.arm(SEGMENT_MAX_MS); // 다음 말이 시작됐다: 창을 멈추고 그 말을 기다린다
  }

  /** 브라우저가 말을 끝냈다(commit). */
  end(): void {
    this.segmentOpen = false;
    this.ends.push(this.now());
    if (this.held && !this.busy && this.finals.length === 0) this.arm(FINAL_WAIT_MS);
  }

  /** Scribe가 확정한 글. */
  final(text: string): void {
    if (this.closed) return;
    // 확정이 끝내 안 온 end(업스트림이 버림)는 잊는다. 안 그러면 뒤 말들의 end 시각이 밀린다.
    const now = this.now();
    while (this.ends.length > 0 && now - this.ends[0] > STALE_END_MS) this.ends.shift();
    const endAt = this.ends.shift() ?? now;
    this.finals.push({ text, endAt, sttMs: Math.max(0, now - endAt) });
    this.pump();
  }

  /** partial 앞에 붙일 글(이어 붙이려고 기다리는 말). 없으면 ''. */
  prefix(): string {
    return this.held ? this.held.text : '';
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.held = null;
    this.finals = [];
  }

  private pump(): void {
    if (this.closed || this.busy) return;
    const next = this.finals.shift();
    if (!next) return;
    const h = this.held;
    if (h) {
      clearTimeout(this.timer);
      this.held = null;
      // 다음 말이 비었으면(잡음 등) 이을 것이 없다: 기다리던 말은 처음 판정대로, 빈 말은 빈 말로 보낸다.
      if (next.text.trim() === '') {
        this.deps.emit(h.text, h.v, h.ms, h.sttMs);
        this.deps.emit(next.text, { accept: false, question: '', reason: 'empty', complete: true }, 0, next.sttMs);
        this.pump();
        return;
      }
      this.deps.emit(h.text, { accept: false, question: '', reason: 'joined', complete: false }, h.ms, h.sttMs);
      this.run(`${h.text} ${next.text.trim()}`, next.endAt, h.joins + 1, next.sttMs);
      return;
    }
    this.run(next.text, next.endAt, 0, next.sttMs);
  }

  private run(text: string, endAt: number, joins: number, sttMs: number): void {
    this.busy = true;
    const t0 = this.now();
    this.deps
      .classify(text)
      .catch((): JoinedVerdict => ({ accept: false, question: '', reason: 'error', complete: true }))
      .then((v) => {
        this.busy = false;
        if (this.closed) return;
        const ms = this.now() - t0;
        if (v.complete === false && joins < MAX_JOINS && text.trim() !== '') {
          this.held = { text: text.trim(), v, ms, joins, endAt, since: this.now(), sttMs };
          if (this.finals.length > 0) return this.pump(); // 다음 말이 이미 확정됐다: 바로 잇는다
          if (this.segmentOpen) return this.arm(SEGMENT_MAX_MS);
          if (this.ends.length > 0) return this.arm(FINAL_WAIT_MS); // 다음 말은 끝났고 확정을 기다리는 중
          return this.arm(Math.max(0, endAt + JOIN_WINDOW_MS - this.now()));
        }
        this.deps.emit(text, v, ms, sttMs);
        this.pump();
      });
  }

  /** ms 뒤에 기다리던 말을 처음 판정 그대로 보낸다. */
  private arm(ms: number): void {
    clearTimeout(this.timer);
    if (this.held) ms = Math.min(ms, Math.max(0, this.held.since + HOLD_MAX_MS - this.now()));
    this.timer = setTimeout(() => {
      const h = this.held;
      if (!h || this.closed) return;
      this.held = null;
      this.deps.emit(h.text, h.v, h.ms, h.sttMs);
      this.pump();
    }, ms);
  }
}

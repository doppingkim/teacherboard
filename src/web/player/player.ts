// 수업 플레이어: LessonMessage 스트림을 받아 문장 음성을 차례로 틀고, 각 문장에 묶인 판서를
// 음성 시작 기준 시각(planDraws)에 그린다. DOM을 직접 만지지 않는다(보드·오디오는 주입).
//
// 판서 규칙
// - 칸 잡기(layout.place / rectOf)는 도착 순서대로 한다(문장이 시작됐으면 도착 즉시, 아니면 문장 시작 때).
//   그래서 connect·mark가 가리키는 그림보다 먼저 그려질 시각이라도 칸은 이미 잡혀 있다.
// - 그리기는 각자 계획된 시각에 시작한다(서로 기다리지 않음 — Board.draw는 동시 호출 가능).
//   기다리는 것은 지우기뿐: page 단계나 newPage 배치가 나오면 그 앞 페이지의 판서가 모두 끝난 뒤
//   지우고, 그 뒤의 판서는 지우기가 끝날 때까지 기다린다.
// - 재생 중인 문장에 판서가 더 오면 그 문장 전체를 다시 계획하고, 아직 시작하지 않은 판서의 타이머를
//   새 계획으로 다시 건다(이미 시작한 판서는 그대로 진행).
//
// 주문 그림(sketch)
// - 보여 주기(draw sketch)는 도착 순서대로 같은 크기 그림처럼 칸을 예약한다 → connect는 그림이
//   오기 전에도 그 칸으로 그린다.
// - 그림({type:'sketch'})이 먼저 와 있으면 계획 시각에 그리고, 아직이면 기다렸다가 오는 즉시 그린다.
//   기다리는 동안은 지우기를 막지 않는다: 그 페이지를 지울 때까지 안 오면 버린다(칸은 빈 채로).
// - figure:null(화가 실패), 또는 done/error/끊김까지 안 온 그림은 없는 것으로 본다(서버는 포기한
//   그림에 메시지를 보내지 않는다 — lesson.ts의 sketch 계약).
// - 무게는 그림 획 수(아직 안 왔으면 SKETCH_WEIGHT). 재생 중에 오면 그 문장을 다시 계획한다.
// - 그리는 길이는 그림의 획 수로 정한다(figureDrawMs, 문장보다 길어도 됨). 아직 안 온 그림은
//   SKETCH_WEIGHT 획으로 짐작해 계획하고, 늦게 와서 기다렸다 그릴 때는 받은 그림의 실제 획 수로 그린다.
//
// 작은 그림 자리(B2)
// - 작은 그림(figure·sketch)을 놓을 때 아직 칸을 안 잡은 뒤의 판서들(이미 도착한 것)을 훑어 이 쪽에 작은 그림이
//   모두 몇 개 올지 센다(layout.expectSmallOnPage). 대본은 대개 재생보다 앞서 오므로 보통 이 수가 맞고, 그림은 처음부터
//   가운데 정렬 자리(1개면 가운데, 2개면 양쪽 균형)에 그려진다. 이미 실패로 온 주문 그림은 세지 않고 칸도 잡지 않는다.
// - 대비: 아직 안 온 그림이 나중에 같은 쪽에 오면 layout이 칸을 다시 가운데로 모으고, 보드가 이미 그린 그림·표시·
//   연결선을 새 자리로 부드럽게 옮긴다(board.relayout). 칸을 잡은 주문 그림이 실패하거나 끝내 안 오면 그 칸을 비우고
//   남은 그림을 다시 모은다.
//
// 표시(mark)
// - 대상(id 있는 글씨·그림·주문 그림)의 그리기가 끝난 뒤, 그리고 자기 계획 시각 뒤에 시작한다.
// - 대상이 아직 예약 전이면 MARK_WAIT_MS까지 기다리고, 그래도 없거나 대상이 끝내 안 그려지면 건너뛴다.
//
// 싱크 측정(정책은 아직 그대로): 판서마다 lateMs = max(0, 실제 시작 − 계획 시작)을 재고(그림·대상을
// 기다린 시간 포함), 수업이 끝나면 한 줄 요약을 console.info로 남긴다(판서 수, 150ms 넘게 늦은 수,
// 최대 lateMs). 끝내 그리지 못한 판서는 세지 않는다.
import type { LessonMessage, Speech } from '../../shared/lesson';
import type { DrawOp, FigureOp, MarkOp } from '../../shared/script';
import type { BoardLike } from '../board/board';
import type { Layout, Placement, Rect } from '../board/layout';
import type { AudioOut } from './audioOut';
import { FIGURE_MS_PER_LINE, MAX_FIGURE_MS, MIN_FIGURE_MS, figureDrawMs, planDraws, speechLengthMs, type DrawReq } from './timeline';

export type PlayResult = 'done' | 'aborted' | 'error';
/** 말과 판서의 어긋남 요약. late는 LATE_MS보다 늦게 시작한 판서 수. */
export type SyncStats = { draws: number; late: number; maxLateMs: number };
export const LATE_MS = 150;
/** 아직 오지 않은 주문 그림의 계획용 무게(획 수 짐작). */
export const SKETCH_WEIGHT = 12;
/** 아직 오지 않은 주문 그림을 계획할 때 짐작하는 그리기 길이(SKETCH_WEIGHT 획). */
export const SKETCH_EST_MS = Math.min(MAX_FIGURE_MS, Math.max(MIN_FIGURE_MS, SKETCH_WEIGHT * FIGURE_MS_PER_LINE));
/** mark의 대상이 아직 예약 전일 때 기다리는 최대 시간. */
export const MARK_WAIT_MS = 1500;

type Timer = ReturnType<typeof setTimeout>;
type DrawEntry = {
  op: DrawOp;
  at?: string;
  seg: Segment;
  /** 칸을 못 잡았으면(connect 대상 id 없음 등) 건너뛰고 계획에서도 뺀다. */
  skip: boolean;
  /** 시작 시각이 되면 부른다. 한 번만. */
  fire: (() => void) | null;
  timer: Timer | null;
  durationMs: number;
  /** 계획된 시작 시각(performance.now 기준). plan()이 정한다. */
  plannedAt: number | null;
  /** 칸을 잡았다(reserve를 지났다). 앞을 내다볼 때 이 판서는 이미 놓인 것으로 본다. */
  reserved?: boolean;
  /** 잡은 칸(주문 그림이 실패하면 이 칸을 비운다). */
  rect?: Rect;
};
/** 문장 하나. virtual: say 없이 온 판서 묶음(sayId 0, 또는 page 바로 뒤) — 자막·음성 없이 바로 그린다. */
type Segment = { kind: 'say'; text: string; speech: Speech | null; draws: DrawEntry[]; startedAt: number | null; virtual: boolean };
type Step = Segment | { kind: 'page' };

/**
 * 한 페이지(지우기와 지우기 사이). draws: 이 페이지를 지우기 전에 끝나야 하는 붙잡기(hold)들.
 * closed: 지우기가 시작됨 — 이 페이지에 더 그리지 않는다.
 */
type Page = { draws: Set<Promise<void>>; closed: boolean };
const newPage = (): Page => ({ draws: new Set(), closed: false });

/** id로 가리킬 수 있는 판서(글씨·그림·주문 그림). mark는 이것이 다 그려지길 기다린다. */
type Target = { rect: Rect; page: Page; state: 'pending' | 'drawn' | 'failed'; after: ((drawn: boolean) => void)[] };
/** 그림을 기다리는 보여 주기 하나. wake(null) = 그림 없음(실패·페이지 넘어감·수업 끝). */
type SketchWait = { id: string; page: Page; wake: (fig: FigureOp | null) => void };

/**
 * 판서 무게: figure는 획 수, text는 글자 수/4, sketch는 받은 그림의 획 수(아직이면 SKETCH_WEIGHT,
 * 실패면 0), 나머지(connect·mark)는 2. sketch: 그 id로 받은 그림(undefined = 아직 안 옴).
 */
export function drawWeight(op: DrawOp, sketch?: FigureOp | null): number {
  switch (op.kind) {
    case 'figure':
      return op.strokes.length;
    case 'text':
      return [...op.text].length / 4;
    case 'sketch':
      return sketch === undefined ? SKETCH_WEIGHT : sketch === null ? 0 : sketch.strokes.length;
    default:
      return 2;
  }
}

/**
 * 그림의 정해진 그리기 길이(문장 몫이 아님): figure는 figureDrawMs, sketch는 받은 그림의 figureDrawMs
 * (아직이면 SKETCH_EST_MS, 실패면 0 — 그리지 않으니 뒤 판서를 밀지 않는다). 글씨·연결·표시는 undefined(몫).
 */
export function drawFixedMs(op: DrawOp, sketch?: FigureOp | null): number | undefined {
  if (op.kind === 'figure') return figureDrawMs(op);
  if (op.kind === 'sketch') return sketch === undefined ? SKETCH_EST_MS : sketch === null ? 0 : figureDrawMs(sketch);
  return undefined;
}

const now = () => performance.now();

/**
 * 느리게 틀 문장의 타이밍: 글자 시각과 길이를 slow배로(소리를 그만큼 늘여 트니 판서 계획도 같은 시계로 맞춘다).
 * slow가 1이면 받은 그대로.
 */
export function slowSpeech<S extends Speech | null>(s: S, slow: number): S {
  if (!s || slow === 1) return s;
  const t = s.timing;
  const timing = t ? { ...t, startMs: t.startMs.map((v) => Math.round(v * slow)), endMs: t.endMs.map((v) => Math.round(v * slow)) } : t;
  return { ...s, timing, durationMs: Math.round(s.durationMs * slow) };
}

/** 한 수업에 하나. play()는 한 번만 부른다. */
export class LessonPlayer {
  private readonly ctl = new AbortController();
  private aborted = false;
  /** 걸려 있는 타이머 → abort 때 기다리던 쪽을 깨우는 함수. */
  private readonly timers = new Map<Timer, () => void>();
  /** 시작했거나 예약된 모든 판서 작업(끝나면 빠진다). done은 이것을 기다린다. */
  private readonly pending = new Set<Promise<void>>();
  /** 지금 페이지. 다음 지우기는 이 페이지의 붙잡기가 모두 풀려야 시작한다. */
  private page: Page = newPage();
  /** 지금 페이지의 판서가 넘어야 하는 문: 앞 페이지 지우기가 끝나면 열린다. */
  private gate: Promise<void> = Promise.resolve();
  private wakeLoop: (() => void) | null = null;
  private resolveAborted: ((r: PlayResult) => void) | null = null;
  private readonly sync: SyncStats = { draws: 0, late: 0, maxLateMs: 0 };
  /** 받은 주문 그림(null = 실패). 보여 주기보다 먼저 오면 여기 보관한다. */
  private readonly sketches = new Map<string, FigureOp | null>();
  private readonly sketchWaits = new Set<SketchWait>();
  /** 스트림이 끝났다: 아직 안 온 그림은 더 오지 않는다. */
  private sketchesClosed = false;
  /** 자막을 한 번이라도 썼다(첫 setSubtitle이 보드의 '생각 중' 카드를 지운다). */
  private subtitled = false;
  /** 예약된 보여 주기(그림이 오면 아직 시작 안 한 것을 다시 계획한다). */
  private readonly shows = new Map<string, DrawEntry[]>();
  private readonly targets = new Map<string, Target>();
  /** 아직 예약 전인 대상을 기다리는 mark들. */
  private readonly targetWaits = new Map<string, Set<(t: Target) => void>>();
  /** 받은 단계(문장·쪽 넘김) 목록. 작은 그림 자리를 정할 때 앞을 내다본다. */
  private steps: Step[] = [];
  /** 서버가 보낸 이어 물을 질문(E2). 수업이 끝나면 UI가 nextQuestions()로 꺼내 카드로 보인다. */
  private next: string[] = [];

  /** onSay: 문장(say) 재생을 시작할 때 그 문장으로 부른다(끼어들기 문맥·에코 가드용). 판서만 있는 묶음은 부르지 않는다. */
  /** 판서·소리 길이에 곱하는 수(빠르기 0.9 → 약 1.11배 길게). */
  private readonly slow: number;

  /** speed: 말·판서 빠르기(1 = 그대로, 0.9 = 느리게 — levelSpeed). */
  constructor(private readonly deps: { board: BoardLike; layout: Layout; audio: AudioOut; onSay?: (text: string) => void; speed?: number }) {
    const sp = deps.speed;
    this.slow = sp !== undefined && Number.isFinite(sp) && sp > 0 ? 1 / sp : 1;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.ctl.abort();
    this.deps.audio.stop();
    for (const [t, wake] of this.timers) {
      clearTimeout(t);
      wake();
    }
    this.timers.clear();
    this.closeSketches();
    this.wakeLoop?.();
    this.resolveAborted?.('aborted');
  }

  play(messages: AsyncIterable<LessonMessage>): Promise<PlayResult> {
    if (this.aborted) return Promise.resolve('aborted');
    const aborted = new Promise<PlayResult>((r) => (this.resolveAborted = r));
    const run = this.run(messages)
      .catch((): PlayResult => (this.aborted ? 'aborted' : 'error'))
      .then((r) => {
        this.reportSync(r);
        return r;
      });
    return Promise.race([run, aborted]);
  }

  /** 이어 물을 질문(E2). 서버가 next를 안 보냈으면 빈 목록. 수업이 끝난 뒤 부른다. */
  nextQuestions(): string[] {
    return [...this.next];
  }

  /** 지금까지 시작한 판서의 싱크 요약. */
  syncStats(): SyncStats {
    return { ...this.sync };
  }

  private reportSync(r: PlayResult): void {
    const { draws, late, maxLateMs } = this.sync;
    if (draws === 0) return;
    console.info(`[teacherboard] draw sync: result=${r} draws=${draws} late>${LATE_MS}ms=${late} maxLateMs=${maxLateMs}`);
  }

  /** 판서가 실제로 시작할 때: 계획보다 얼마나 늦었는지 잰다. */
  private noteStart(d: DrawEntry): void {
    const lateMs = d.plannedAt === null ? 0 : Math.max(0, Math.round(now() - d.plannedAt));
    this.sync.draws++;
    if (lateMs > LATE_MS) this.sync.late++;
    this.sync.maxLateMs = Math.max(this.sync.maxLateMs, lateMs);
  }

  private async run(messages: AsyncIterable<LessonMessage>): Promise<PlayResult> {
    const steps = this.steps;
    let tail: Step | undefined;
    let end: 'done' | 'error' | null = null;
    const notify = () => {
      const w = this.wakeLoop;
      this.wakeLoop = null;
      w?.();
    };

    const handle = (m: LessonMessage) => {
      switch (m.type) {
        case 'say': {
          const seg: Segment = { kind: 'say', text: m.text, speech: slowSpeech(m.speech, this.slow), draws: [], startedAt: null, virtual: false };
          steps.push(seg);
          tail = seg;
          break;
        }
        case 'draw': {
          // 서버는 판서를 자기 say 바로 뒤에 보낸다. page 뒤(또는 say 전, sayId 0)에 온 판서는
          // 말 없는 묶음으로 그 자리에서 바로 그린다.
          if (tail?.kind !== 'say') {
            const seg: Segment = { kind: 'say', text: '', speech: null, draws: [], startedAt: null, virtual: true };
            steps.push(seg);
            tail = seg;
          }
          const seg = tail;
          const entry: DrawEntry = { op: m.op, seg, skip: false, fire: null, timer: null, durationMs: 0, plannedAt: null };
          if (m.at !== undefined) entry.at = m.at;
          seg.draws.push(entry);
          if (seg.startedAt !== null) {
            // 재생 중에 도착: 칸을 바로 잡고, 문장 전체를 다시 계획한다.
            this.reserve(entry);
            this.plan(seg);
          }
          break;
        }
        case 'sketch':
          this.onSketch(m.id, m.figure);
          break;
        case 'page': {
          const step: Step = { kind: 'page' };
          steps.push(step);
          tail = step;
          break;
        }
        case 'next':
          // 판서·재생과 무관: 받아 두기만 한다(서버는 done 바로 앞에 보낸다).
          if (Array.isArray(m.questions)) this.next = m.questions.filter((q) => typeof q === 'string');
          break;
        case 'done':
        case 'error':
          end = m.type;
          break;
      }
    };

    // 읽기: 메시지를 받는 대로 단계 목록에 넣는다(재생을 기다리지 않음). 이 부분은 동기적으로
    // 시작해야 한다 — 첫 next()가 play() 호출 안에서 바로 불린다.
    void (async () => {
      try {
        for await (const m of messages) {
          if (this.aborted) return; // for-await이 스트림을 닫는다
          handle(m);
          notify();
          if (end) return;
        }
        end ??= 'error'; // done 없이 끊김
      } catch {
        if (!this.aborted) end ??= 'error';
      } finally {
        this.closeSketches(); // 어떻게 끝났든 아직 안 온 그림은 더 오지 않는다
        notify();
      }
    })();

    // 재생: 단계를 순서대로.
    let i = 0;
    while (!this.aborted) {
      if (i < steps.length) {
        const step = steps[i++];
        if (step.kind === 'page') await this.runPage();
        else await this.runSegment(step);
        continue;
      }
      if (end) break;
      await new Promise<void>((r) => (this.wakeLoop = r));
    }
    if (this.aborted) return 'aborted';
    while (this.pending.size > 0 && !this.aborted) await Promise.all([...this.pending]);
    await this.gate;
    return this.aborted ? 'aborted' : (end ?? 'error');
  }

  // ---------- 페이지 ----------

  /** 페이지를 붙잡는다: 돌려준 함수를 부를 때까지 이 페이지를 지우지 않는다. 여러 번 불러도 한 번만 푼다. */
  private hold(page: Page): () => void {
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    page.draws.add(p);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      page.draws.delete(p);
      done();
    };
  }

  /** 새 페이지: 지금 페이지의 붙잡기가 모두 풀리면 지우고, 이후 판서는 그 지우기를 기다린다. */
  private turnPage(): Promise<void> {
    const old = this.page;
    this.page = newPage();
    const prev = this.gate;
    this.gate = (async () => {
      await prev;
      // 기다리는 동안 늦게 온 그림이 다시 붙잡을 수 있으니 빌 때까지 반복한다.
      while (old.draws.size > 0) await Promise.all([...old.draws]);
      this.closePage(old); // 비었음을 확인한 같은 순간에 닫는다(그 사이에 끼어들 틈 없음)
      if (!this.aborted) await this.deps.board.wipe(this.ctl.signal);
    })().catch(() => {});
    return this.gate;
  }

  /** 지우기 시작: 이 페이지에서 아직 그림을 기다리는 보여 주기는 버린다. */
  private closePage(page: Page): void {
    page.closed = true;
    for (const w of [...this.sketchWaits]) {
      if (w.page !== page) continue;
      this.sketchWaits.delete(w);
      w.wake(null);
    }
  }

  private async runPage(): Promise<void> {
    this.deps.layout.reset();
    await this.turnPage(); // 다음 문장은 지운 뒤에 시작한다
  }

  private async runSegment(seg: Segment): Promise<void> {
    if (seg.virtual) {
      // 말 없이 판서부터 오면(sayId 0) 그 판서가 '생각 중' 카드 밑에 가리지 않게 먼저 카드를 지운다.
      if (!this.subtitled) this.deps.board.setSubtitle('');
      this.subtitled = true;
    } else {
      this.subtitled = true;
      this.deps.board.setSubtitle(seg.text);
      try {
        this.deps.onSay?.(seg.text);
      } catch {
        // 알림 쪽 문제로 수업을 멈추지 않는다.
      }
    }
    seg.startedAt = now();
    for (const d of seg.draws) this.reserve(d); // 미리 와 있던 판서: 도착 순서대로 칸 잡기
    this.plan(seg);
    const total = speechLengthMs(seg.text, seg.speech?.timing ?? null);
    if (seg.speech) {
      try {
        await this.deps.audio.play(seg.speech, this.ctl.signal, 1 / this.slow);
        return;
      } catch {
        // 재생 실패(자동 재생 막힘 등): 소리 없이 남은 길이만큼 진행한다.
      }
    }
    const left = seg.startedAt + total - now();
    if (left > 0) await this.later(left);
  }

  // ---------- 주문 그림 ----------

  private onSketch(id: string, fig: FigureOp | null): void {
    if (this.aborted || this.sketchesClosed) return;
    this.sketches.set(id, fig);
    // 실패: 이미 잡아 둔 칸을 비우고 남은 그림을 다시 가운데로 모은다.
    if (!fig) for (const d of this.shows.get(id) ?? []) this.releaseSlot(d);
    // 아직 칸을 안 잡았어도 앞을 내다볼 때 셌을 수 있다: 남은 판서로 다시 세어 이미 놓인 그림을 다시 가운데로(QA2).
    if (!fig) this.recountSmalls();
    for (const w of [...this.sketchWaits]) {
      if (w.id !== id) continue;
      this.sketchWaits.delete(w);
      w.wake(fig);
    }
    // 재생 중인 문장은 실제 획 수로 다시 계획한다(나머지는 시작 때 계획). 보여 주기가 이미 시작해
    // 그림을 기다리는 중이어도, 그 뒤의 아직 시작 안 한 순서 판서는 실제 길이만큼 밀어야 한다.
    const segs = new Set<Segment>();
    for (const d of this.shows.get(id) ?? []) if (d.seg.startedAt !== null) segs.add(d.seg);
    for (const seg of segs) this.plan(seg);
  }

  /** 수업이 끝났거나 멈췄다: 기다리던 그림은 모두 없는 것으로. */
  private closeSketches(): void {
    this.sketchesClosed = true;
    for (const w of [...this.sketchWaits]) {
      this.sketchWaits.delete(w);
      w.wake(null);
    }
  }

  /** 주문 그림 칸을 비운다(실패·끝내 안 옴). 이 쪽의 칸이었으면 보드가 남은 판서를 옮긴다. */
  private releaseSlot(d: DrawEntry): void {
    if (!d.rect || this.aborted) return;
    if (this.deps.layout.release(d.rect)) this.deps.board.relayout?.();
  }

  /**
   * 지금 쪽의 작은 그림 수를 다시 센다(놓인 칸 + 아직 칸을 안 잡은 도착한 판서, 쪽 넘김 전까지). 칸이 옮겨지면 보드도 따라 옮긴다.
   * (QA2 2026-11-23: 앞을 내다볼 때 센 주문 그림이 칸을 잡기 전에 실패하면 첫 그림이 2개 자리 왼쪽에 혼자 남았다.)
   * 칸을 잡지 않은 판서는 모두 아직 시작 안 한 단계에 있다(시작한 문장의 판서는 시작할 때·도착할 때 곧바로 칸을 잡는다).
   */
  private recountSmalls(): void {
    if (this.aborted) return;
    let start = 0;
    this.steps.forEach((s, i) => {
      if (s.kind === 'say' && s.startedAt !== null) start = i + 1;
    });
    const ops: DrawOp[] = [];
    for (let i = start; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (step.kind === 'page') break;
      for (const e of step.draws) {
        if (e.reserved || e.skip) continue;
        if (e.op.kind === 'sketch' && this.sketches.get(e.op.id) === null) continue;
        ops.push(e.op);
      }
    }
    if (this.deps.layout.recount(ops)) this.deps.board.relayout?.();
  }

  /**
   * 앞을 내다보기: d부터(d 포함) 아직 칸을 안 잡은 판서들(쪽 넘김 전까지, 도착한 것만).
   * 이미 실패로 온 주문 그림은 칸을 잡지 않으니 뺀다.
   */
  private upcoming(d: DrawEntry): DrawOp[] {
    const ops: DrawOp[] = [];
    const from = this.steps.indexOf(d.seg);
    for (let i = Math.max(0, from); i < this.steps.length; i++) {
      const step = this.steps[i];
      if (step.kind === 'page') break;
      for (const e of step.draws) {
        if (e !== d && (e.reserved || e.skip)) continue;
        if (e.op.kind === 'sketch' && this.sketches.get(e.op.id) === null) continue;
        ops.push(e.op);
      }
    }
    return ops;
  }

  // ---------- 대상(mark용) ----------

  private addTarget(id: string, rect: Rect): Target {
    const t: Target = { rect, page: this.page, state: 'pending', after: [] };
    this.targets.set(id, t);
    const waits = this.targetWaits.get(id);
    if (waits) {
      this.targetWaits.delete(id);
      for (const w of [...waits]) w(t);
    }
    return t;
  }

  /** 지금 페이지에 예약된 대상. */
  private findTarget(id: string): Target | null {
    const t = this.targets.get(id);
    return t && this.deps.layout.rectOf(id) ? t : null;
  }

  /** 대상이 예약될 때까지 최대 MARK_WAIT_MS 기다린다(없으면 null). */
  private waitTarget(id: string): Promise<Target | null> {
    if (this.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let waits = this.targetWaits.get(id);
      if (!waits) this.targetWaits.set(id, (waits = new Set()));
      const set = waits;
      const finish = (t: Target | null) => {
        clearTimeout(timer);
        this.timers.delete(timer);
        set.delete(onTarget);
        if (set.size === 0 && this.targetWaits.get(id) === set) this.targetWaits.delete(id);
        resolve(t);
      };
      const onTarget = (t: Target) => finish(t);
      set.add(onTarget);
      const timer = setTimeout(() => finish(null), MARK_WAIT_MS);
      this.timers.set(timer, () => finish(null));
    });
  }

  /** 대상 그리기가 끝났다(drawn: 실제로 그렸는지). 따라오는 mark가 먼저 페이지를 붙잡게 한 뒤 푼다. */
  private settle(t: Target, drawn: boolean): void {
    t.state = drawn ? 'drawn' : 'failed';
    const after = t.after;
    t.after = [];
    for (const cb of after) cb(drawn);
  }

  private whenSettled(t: Target, cb: (drawn: boolean) => void): void {
    if (t.state === 'pending') t.after.push(cb);
    else cb(t.state === 'drawn');
  }

  // ---------- 칸 잡기·그리기 ----------

  private track(job: Promise<void>): void {
    const j = job.catch(() => {});
    this.pending.add(j);
    void j.then(() => this.pending.delete(j));
  }

  /** 칸을 잡고 그리기 작업을 만든다. 작업은 (지우기 문 + 시작 시각 [+ 그림·대상])을 기다렸다가 그린다. */
  private reserve(d: DrawEntry): void {
    if (this.aborted) return;
    const { layout, board } = this.deps;
    const op = d.op;
    d.reserved = true;
    if (op.kind === 'mark') return this.reserveMark(d, op);

    if (op.kind === 'connect') {
      const refs: Rect[] = [];
      for (const id of [op.from, op.to]) {
        const r = layout.rectOf(id);
        if (r) refs.push(r);
      }
      if (refs.length < 2) {
        d.skip = true; // 칸을 못 찾으면 이 판서만 건너뛴다
        return;
      }
      // 그 사이 한쪽 칸이 비워졌으면(주문 그림 실패) 긋지 않는다.
      const draw = async () => {
        if (refs.every((r) => r.w > 0)) await board.draw(op, { refs }, d.durationMs, this.ctl.signal);
      };
      this.track(this.simpleJob(d, draw, null));
      return;
    }

    // 이미 실패로 온 주문 그림은 칸을 잡지 않는다(빈 칸이 생기지 않게).
    if (op.kind === 'sketch' && this.sketches.get(op.id) === null) {
      d.skip = true;
      return;
    }
    const small = (op.kind === 'figure' || op.kind === 'sketch') && op.size !== 'wide';
    const place = small ? layout.place(op, layout.expectSmallOnPage(this.upcoming(d))) : layout.place(op);
    if (!place) {
      d.skip = true;
      return;
    }
    if (place.newPage) this.turnPage(); // place()가 이미 layout을 비웠다
    // 같은 쪽의 작은 그림 수가 짐작보다 늘었으면 칸들이 옮겨졌다: 이미 그린 판서도 따라 옮긴다.
    else if (layout.moved) board.relayout?.();
    d.rect = place.rect;
    const target = op.id ? this.addTarget(op.id, place.rect) : null;
    if (op.kind === 'sketch') {
      const list = this.shows.get(op.id) ?? [];
      list.push(d);
      this.shows.set(op.id, list);
      this.track(this.sketchJob(d, op.id, place, target));
    } else {
      this.track(this.simpleJob(d, () => board.draw(op, place, d.durationMs, this.ctl.signal), target));
    }
  }

  /** 시작 신호. plan()이 타이머로 부른다. */
  private startSignal(d: DrawEntry): Promise<void> {
    return new Promise<void>((r) => (d.fire = r));
  }

  /** 글씨·그림·연결: 지우기 문과 시작 시각을 기다렸다가 그린다. */
  private async simpleJob(d: DrawEntry, draw: () => Promise<void>, target: Target | null): Promise<void> {
    const gate = this.gate;
    const started = this.startSignal(d);
    const release = this.hold(this.page);
    let drawn = false;
    try {
      await Promise.all([gate, started]);
      if (this.aborted) return;
      this.noteStart(d);
      await draw();
      drawn = true;
    } finally {
      if (target) this.settle(target, drawn && !this.aborted);
      release();
    }
  }

  /** 주문 그림 보여 주기: 시작 시각에 그림이 있으면 그리고, 없으면 페이지를 놓아주고 기다린다. */
  private async sketchJob(d: DrawEntry, id: string, place: Placement, target: Target | null): Promise<void> {
    const gate = this.gate;
    const page = this.page;
    const started = this.startSignal(d);
    let release: (() => void) | null = this.hold(page);
    const free = () => {
      const r = release;
      release = null;
      r?.();
    };
    let drawn = false;
    try {
      await Promise.all([gate, started]);
      if (this.aborted) return;
      let fig = this.sketches.get(id);
      if (fig === undefined) {
        fig = await new Promise<FigureOp | null>((resolve) => {
          if (this.sketchesClosed) return resolve(null);
          this.sketchWaits.add({
            id,
            page,
            wake: (f) => {
              if (f && !page.closed && !this.aborted) release = this.hold(page); // 그리는 동안 다시 붙잡는다
              resolve(f);
            },
          });
          free(); // 기다리는 동안은 지우기를 막지 않는다
        });
      }
      if (!fig || this.aborted || page.closed) {
        // 실패·끝내 안 옴: 칸을 비우고 남은 그림을 다시 모은다(쪽이 이미 넘어갔으면 그대로).
        if (!fig && !page.closed) this.releaseSlot(d);
        return;
      }
      this.noteStart(d);
      // 늦게 와서 기다렸으면 계획은 짐작(SKETCH_EST_MS)이었다: 받은 그림의 실제 획 수로 그린다.
      await this.deps.board.draw(fig, place, figureDrawMs(fig) * this.slow, this.ctl.signal);
      drawn = true;
    } finally {
      if (target) this.settle(target, drawn && !this.aborted);
      free();
    }
  }

  /** 표시: 대상을 찾고(없으면 잠깐 기다림), 대상이 다 그려진 뒤 + 자기 시작 시각 뒤에 그린다. */
  private reserveMark(d: DrawEntry, op: MarkOp): void {
    const started = this.startSignal(d);
    let release: (() => void) | null = this.hold(this.page); // 대상을 찾는 동안(최대 MARK_WAIT_MS)
    const free = () => {
      const r = release;
      release = null;
      r?.();
    };
    this.track(
      (async () => {
        try {
          const t = this.findTarget(op.target) ?? (await this.waitTarget(op.target));
          if (!t || this.aborted) return;
          // 대상이 그려지길 기다리는 동안은 붙잡지 않는다(대상이 그림을 기다리며 페이지를 놓아줄 수 있으니).
          // 대상이 끝나는 순간 대상의 페이지를 이어 붙잡는다.
          const ok = await new Promise<boolean>((resolve) => {
            const old = release;
            release = null;
            this.whenSettled(t, (drawn) => {
              const live = drawn && !t.page.closed && !this.aborted;
              if (live) release = this.hold(t.page);
              resolve(live);
            });
            old?.();
          });
          if (!ok) return;
          await started;
          if (this.aborted) return;
          this.noteStart(d);
          await this.deps.board.draw(op, { refs: [t.rect] }, d.durationMs, this.ctl.signal);
        } finally {
          free();
        }
      })(),
    );
  }

  /** 문장의 판서 시각을 (다시) 계획하고, 아직 시작하지 않은 판서의 타이머를 새로 건다. */
  private plan(seg: Segment): void {
    if (this.aborted || seg.startedAt === null) return;
    const live = seg.draws.filter((d) => !d.skip);
    const reqs: DrawReq[] = live.map((d) => {
      const sketch = d.op.kind === 'sketch' ? this.sketches.get(d.op.id) : undefined;
      const req: DrawReq = { weight: drawWeight(d.op, sketch) };
      const fixedMs = drawFixedMs(d.op, sketch);
      if (fixedMs !== undefined) req.fixedMs = fixedMs * this.slow;
      if (d.at !== undefined) req.at = d.at;
      return req;
    });
    const plans = planDraws(seg.text, seg.speech?.timing ?? null, reqs);
    live.forEach((d, j) => {
      const fire = d.fire;
      if (!fire) return; // 이미 시작했다
      if (d.timer !== null) {
        clearTimeout(d.timer);
        this.timers.delete(d.timer);
      }
      d.durationMs = plans[j].durationMs;
      d.plannedAt = seg.startedAt! + plans[j].startMs;
      const delay = Math.max(0, d.plannedAt - now());
      const t = setTimeout(() => {
        this.timers.delete(t);
        d.timer = null;
        d.fire = null;
        fire();
      }, delay);
      d.timer = t;
      this.timers.set(t, fire);
    });
  }

  /** ms 뒤 resolve. abort되면 바로 resolve. */
  private later(ms: number): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.set(t, resolve);
    });
  }
}

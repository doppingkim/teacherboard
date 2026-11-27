import type { LessonMessage, Speech } from '../shared/lesson';
import { createParseState, parseScriptLine, type FigureOp, type ScriptEvent, type SketchOrder } from '../shared/script';
import { LineSplitter } from './lineSplitter';

export type LessonStats = {
  says: number;
  droppedLines: number;
  /** 실패한 TTS 호출 수(수업 중단으로 인한 AbortError는 빼고). 실패한 문장은 speech: null로 나간다. */
  ttsFailures: number;
  /** 첫 TTS 실패 원인(서버 로그용). */
  firstTtsError?: unknown;
  error?: unknown;
  /** 받은 그림 주문 수. */
  sketches: number;
  /**
   * figure: null로 나간 주문 수: 화가가 null을 돌려줬거나(시간 초과·거절·검증 실패, 던진 경우, 화가 없음 포함).
   * 요청 abort나 소비자가 멈춰(연결 끊김) 버린 주문은 세지 않는다.
   */
  sketchFailures: number;
  /** 결과가 나온 주문마다, 주문을 받은 때부터 결과까지 걸린 ms(자리 대기 포함). 끝난 순서대로. */
  sketchMs: number[];
};

export type LessonDeps = {
  scriptText: AsyncIterable<string>;
  /** previousText: 바로 앞 문장(억양을 이어 가게 TTS에 넘긴다). 첫 문장이면 없음. */
  speak: (text: string, previousText?: string) => Promise<Speech>;
  maxParallelTts?: number /* 기본 3 */;
  /**
   * 그림 주문 → 화가 그림(실패는 null). 던지지 않아야 하지만 던져도 null로 받는다.
   * 시간 제한은 화가 쪽(20초)이 맡는다. signal은 요청 abort(deps.signal)나 소비자가 멈추면 abort된다.
   * 없으면 주문은 곧바로 figure: null.
   */
  drawSketch?: (order: SketchOrder, signal: AbortSignal) => Promise<FigureOp | null>;
  maxParallelSketch?: number /* 기본 4 */;
  /** 요청 abort(연결 끊김). abort되면 화가 호출을 끊고, 남은 그림은 메시지 없이 버린다. */
  signal?: AbortSignal;
  /** 수업이 끝날 때(정상·오류) 한 번 불린다. 서버 로그용. */
  onEnd?: (stats: LessonStats) => void;
  /** 첫 올바른 대본 줄(say·draw·page·sketch)을 읽었을 때 한 번(속도 계측용). */
  onFirstLine?: () => void;
  /** 브라우저에 보낼 오류 문구의 언어(기본 ko). */
  lang?: 'ko' | 'en';
};

/** 브라우저에 보내는 오류 문구. 내부 오류 내용(키·URL 등)은 절대 싣지 않는다. */
const SCRIPT_ERROR = '수업을 만드는 중에 문제가 생겼어요. 다시 물어봐 줄래?';
const REFUSAL_ERROR = '이 질문은 수업으로 만들 수 없어요. 다른 걸 물어봐 줄래?';
const ERRORS = {
  ko: { script: SCRIPT_ERROR, refusal: REFUSAL_ERROR },
  en: { script: 'Something went wrong while making the lesson. Could you ask again?', refusal: "I can't make a lesson for that question. Could you ask something else?" },
} as const;

/**
 * 수업 하나의 say 최대 개수. 프롬프트는 15~26문장을 쓰게 한다. 모델이 되풀이하며 폭주하면 say마다
 * TTS(유료)를 부르게 되므로, 이만큼에서 대본 읽기를 멈추고 수업을 끝낸다.
 */
export const MAX_SAYS = 60;
/**
 * 수업 하나의 판서(draw·page) 최대 개수. 보통 수업은 50개 안팎. 모델이 같은 판서 줄을 되풀이하면(말 없이) say 한도에
 * 걸리지 않으므로, 넘는 판서는 버린다(버린 줄로 센다). 말은 계속 나간다.
 */
export const MAX_BOARD_OPS = 200;

const abortError = (): Error => Object.assign(new Error('lesson stopped'), { name: 'AbortError' });

type SayEntry = { kind: 'say'; id: number; text: string; speech: Promise<Speech | null>; settled: boolean; value: Speech | null };
type Entry = SayEntry | { kind: 'msg'; msg: LessonMessage };

/**
 * 동시에 실행되는 작업 수를 n개로 제한한다(FIFO). 테스트를 위해 export.
 * 끝난 작업은 자리를 대기자에게 곧바로 넘긴다(active를 줄이지 않음). 그래야 대기자가
 * 깨어나기 전 같은 틱에 들어온 새 호출이 자리를 가로채 한도를 넘거나 순서를 앞지르지 못한다.
 */
export function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((r) => waiting.push(r)); // 자리는 넘겨받는다
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * 대본 텍스트 스트림을 LessonMessage 스트림으로 바꾼다.
 * 대본은 따로 읽어 "출력 대기열"에 넣고(say는 TTS를 바로 시작), 대기열 앞에서부터
 * 순서대로 내보낸다. 그래서 draw는 항상 자기 say 뒤에 나오고, 뒤 문장의 TTS는
 * 앞 문장 TTS가 끝나기 전에 미리 시작된다. TTS 실패는 speech: null.
 *
 * 그림 주문(sketch)은 대기열에 넣지 않고 받자마자 화가를 부른다. 끝난 그림은 "완성 목록"에
 * 쌓였다가 다음 yield 기회에 대기열보다 먼저 나간다(앞 say가 TTS를 기다리는 중이어도).
 * done/error 전에는 남은 그림이 모두 끝날 때까지 기다린다(고정 유예 없음, 일찍 끊지 않음). 대본이 일찍 끝나도
 * 말은 한참 더 재생되므로 그림은 늦게 와도 쓸모 있다. 상한은 화가의 시간 제한(시작부터 20초)이고,
 * 시간 초과·실패는 {type:'sketch', id, figure: null}로 알린다. 메시지 없이 버리는 것은 요청 abort(연결 끊김)나
 * 소비자가 멈춘 경우뿐이다.
 */
export async function* runLesson(deps: LessonDeps): AsyncGenerator<LessonMessage> {
  const run = limiter(Math.max(1, deps.maxParallelTts ?? 3));
  const drawRun = limiter(Math.max(1, deps.maxParallelSketch ?? 4));
  const sketchAc = new AbortController();
  const queue: Entry[] = [];
  /** 끝난 그림. 대기열과 따로, 먼저 나간다. */
  const ready: LessonMessage[] = [];
  let drawing = 0; // 아직 결과가 안 나온 주문 수
  const stats: LessonStats = { says: 0, droppedLines: 0, ttsFailures: 0, sketches: 0, sketchFailures: 0, sketchMs: [] };
  let finished = false;
  let stopped = false;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  /** notify가 오거나 p가 끝날 때까지 기다린다. 확인과 대기 사이에 await가 없어야 깨움을 놓치지 않는다. */
  const wakeOr = (p?: Promise<unknown>) =>
    new Promise<void>((r) => {
      wake = r;
      if (p) void p.then(() => r());
    });

  const startSketch = (order: SketchOrder) => {
    stats.sketches++;
    const draw = deps.drawSketch;
    if (!draw) {
      stats.sketchFailures++;
      ready.push({ type: 'sketch', id: order.id, figure: null });
      return;
    }
    const t0 = performance.now();
    drawing++;
    const signal = sketchAc.signal;
    void drawRun(async () => (signal.aborted ? null : draw(order, signal)))
      .catch(() => null)
      .then((figure) => {
        drawing--;
        if (signal.aborted) return; // 버린 주문(연결 끊김·소비자 멈춤): 메시지도 시간도 남기지 않는다
        stats.sketchMs.push(Math.round(performance.now() - t0));
        if (!figure) stats.sketchFailures++;
        ready.push({ type: 'sketch', id: order.id, figure });
        notify();
      });
  };

  const state = createParseState();
  let lastSay: string | undefined;
  let capped = false; // say가 MAX_SAYS개를 넘었다: 그 뒤 대본은 읽지 않는다
  let boardOps = 0;
  let sawLine = false;
  /** 이어 물을 질문(E2). 대본 어디에 와도 수업이 잘 끝나면 done 바로 앞에 한 번 보낸다. */
  let next: string[] | null = null;
  const accept =(line: string) => {
    if (capped) return;
    const ev = parseScriptLine(line, state);
    if (ev && !sawLine) {
      sawLine = true;
      try {
        deps.onFirstLine?.();
      } catch {
        // 계측 콜백 오류가 수업을 깨뜨리지 않게 한다.
      }
    }
    if (!ev) stats.droppedLines++;
    else if (ev.t === 'say' && stats.says >= MAX_SAYS) capped = true;
    else if ((ev.t === 'draw' || ev.t === 'page') && ++boardOps > MAX_BOARD_OPS) stats.droppedLines++;
    else if (ev.t === 'sketch') startSketch(ev.order);
    else if (ev.t === 'next') next = ev.questions; // 파서가 수업당 한 번만 받는다. done 바로 앞에 보낸다
    else queue.push(toEntry(ev));
  };
  const toEntry = (ev: Exclude<ScriptEvent, { t: 'sketch' } | { t: 'next' }>): Entry => {
    switch (ev.t) {
      case 'say': {
        stats.says++;
        const prev = lastSay;
        lastSay = ev.text;
        // 멈췄거나 요청이 끊긴 뒤 자리를 얻은 TTS는 부르지 않는다(비용). 중단(AbortError)으로 보고 세지 않는다.
        const speech = run(() => (stopped || deps.signal?.aborted ? Promise.reject(abortError()) : deps.speak(ev.text, prev))).catch((err: unknown) => {
          if (!(err instanceof Error && err.name === 'AbortError')) {
            stats.ttsFailures++;
            if (stats.firstTtsError === undefined) stats.firstTtsError = err;
          }
          return null;
        });
        const entry: SayEntry = { kind: 'say', id: ev.id, text: ev.text, speech, settled: false, value: null };
        void speech.then((v) => { entry.value = v; entry.settled = true; });
        return entry;
      }
      case 'draw': {
        const msg: LessonMessage = { type: 'draw', sayId: ev.sayId, op: ev.op };
        if (ev.at !== undefined) msg.at = ev.at;
        return { kind: 'msg', msg };
      }
      case 'page':
        return { kind: 'msg', msg: { type: 'page' } };
    }
  };

  // 요청 abort: 화가를 끊고, 끝 대기에서 깨운다.
  const onAbort = () => { sketchAc.abort(); notify(); };
  if (deps.signal?.aborted) sketchAc.abort();
  else deps.signal?.addEventListener('abort', onAbort, { once: true });

  const pump = (async () => {
    const splitter = new LineSplitter();
    try {
      // 요청이 끊기면(연결 끊김) 대본 스트림이 signal을 따르지 않아도 더 읽지 않는다(그 뒤 say마다 TTS를 부르지 않게).
      const halted = () => stopped || deps.signal?.aborted === true;
      for await (const chunk of deps.scriptText) {
        if (halted()) break;
        splitter.push(chunk).forEach(accept);
        notify();
        if (capped) break; // 다음 조각을 더 당기지 않는다
      }
      if (!halted() && !capped) splitter.flush().forEach(accept);
      // 말이 하나도 없는 대본(빈 응답, 모두 깨진 줄)은 빈 칠판으로 '끝'나지 않게 오류로 알린다.
      if (stats.says === 0 && !halted()) stats.error = new Error('대본에 올바른 say 줄이 하나도 없습니다');
    } catch (err) {
      stats.error = err;
    } finally {
      finished = true;
      notify();
    }
  })();

  try {
    while (true) {
      const sketch = ready.shift();
      if (sketch) { yield sketch; continue; }
      const head = queue[0];
      if (head) {
        // say의 TTS를 기다리는 동안 끝난 그림이 생기면 깨어나 먼저 보낸다.
        if (head.kind === 'say' && !head.settled) { await wakeOr(head.speech); continue; }
        queue.shift();
        if (head.kind === 'say') yield { type: 'say', id: head.id, text: head.text, speech: head.value };
        else yield head.msg;
        continue;
      }
      if (finished) break;
      await wakeOr();
    }

    // 대본과 대기열은 끝났다. 남은 그림이 모두 끝날 때까지(각자 화가 시간 제한까지) 기다린다.
    while (true) {
      const sketch = ready.shift();
      if (sketch) { yield sketch; continue; }
      if (drawing === 0 || sketchAc.signal.aborted) break;
      await wakeOr();
    }

    await pump;
    if (stats.error !== undefined) {
      const refused = stats.error instanceof Error && stats.error.name === 'RefusalError';
      const msgs = ERRORS[deps.lang ?? 'ko'];
      yield { type: 'error', message: refused ? msgs.refusal : msgs.script };
    } else {
      if (next) yield { type: 'next', questions: next };
      yield { type: 'done' };
    }
  } finally {
    stopped = true;
    deps.signal?.removeEventListener('abort', onAbort);
    sketchAc.abort(); // 소비자가 멈춘 경우: 그리는 중·자리 대기 중인 화가 호출을 끊는다(정상 종료면 남은 것 없음)
    try {
      deps.onEnd?.(stats);
    } catch {
      // 로그 콜백 오류가 수업 스트림을 깨뜨리지 않게 한다.
    }
  }
}

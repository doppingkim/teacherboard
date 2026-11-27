import type { ConnectOp, DrawOp, FigureOp, Ink, MarkOp, TextOp } from '../../shared/script';
import { LANG } from '../i18n';
import { BOARD, type Placement, type Rect } from './layout';
import { arrowHeadPath, arrowPath, circleMarkPath, easeFlick, inkColor, markPaths, seededRand, strokeSchedule } from './primitives';
import { SVG_NS, clamp01, fx, lerp, raceAbort, sleep, smoothstep, svg, tween, type Pt } from './dom';
import { FONT_SIZE, MAX_MS_PER_PX, STROKE_W, TEXT_BOLD, clusters, fillItem, glyphBox, strokeItem, textInkBox, textItem, type Item, type ItemCtx } from './items';
import { Layers } from './layers';
import { MarkerPen, penMarkup } from './pen';
// 기다림(E1) 문구 카드 자리·판서 줄이기(setRoom) 스타일은 src/web/cards.css에 있다(앱이 cards.ts로 불러온다).
// 보드만 띄우는 시험 페이지에서 Vite 클라이언트를 끌어오지 않게 여기서는 불러오지 않는다.
import { LEADER_MIN, NEAR_R, collisions, fitEllipse, leaderPath, placeLabel, union, type Box, type Obstacles } from './labelPlace';

export { FONT_SIZE, STROKE_W } from './items';

export interface BoardLike {
  draw(op: DrawOp, place: Placement | { refs: Rect[] }, durationMs: number, signal: AbortSignal): Promise<void>;
  wipe(signal: AbortSignal): Promise<void>; // 지우개 애니메이션 약 700ms 후 비움
  clear(): void;
  setSubtitle(text: string): void;
  writeIdle(text: string, at?: 'center' | 'top'): void; // 보드 가운데(또는 위쪽)에 문구를 바로(애니메이션 짧게) 씀
  /** 칸 객체(Rect)가 옮겨졌으면(layout.place·release) 이미 그린·그리는 판서를 새 자리로 부드럽게 옮긴다. */
  relayout?(): void;
}

/** 칸이 옮겨질 때 판서가 미끄러지는 시간. */
export const RELAYOUT_MS = 450;
/** 보드 가장자리 여백(이름표·표시를 이 안에). */
const BOARD_IN: Box = { x: 4, y: 4, w: BOARD.w - 8, h: BOARD.h - 8 };
/** 쪽 전체 장애물(다른 판서의 선 점) 최대 개수. */
const MAX_PAGE_POINTS = 4000;

/**
 * 칸에 붙은 판서 하나(그림·연결·표시). at: 그릴 때의 칸 자리, off: 지금 옮겨 둔 만큼, goal: 옮겨 갈 만큼.
 * 칸 객체는 layout이 그대로 고치므로 (지금 칸 − at)만큼 옮기면 된다.
 */
type Anchor = { g: SVGGElement; op: DrawOp; rects: Rect[]; at: Pt[]; off: Pt; goal: Pt; tok: number };

const WIPE_MS = 700;
const IDLE_MS = 600;
const FONT_WAIT_MS = 2500;
const ERASER_W = 74;
const FIG_CLIP_PAD = 12; // 그림 칸 자르기 여백(보드 px)
const LABEL_GAP = 10; // connect 라벨 아래쪽과 화살표 맨 위 사이
const FIG_CIRCLE_GAP = 12; // 그림 동그라미와 그림 선 사이 여유(보드 px)
const LEAD_MS = 170;
/** 이름표 빈자리를 못 찾으면 이 배율로 줄여 가며 다시 찾는다. */
const LABEL_SHRINK = [0.85, 0.72, 0.6];
/** 생각 중 문구를 바꾸는 간격. */
export const THINKING_ROTATE_MS = 3200; // 첫 획 전에 마커가 시작점으로 날아가 닿는 시간

/** 예시 질문 카드(A1, 판서 면 44%~93%)가 있을 때 대기 문구의 가운데 높이(보드 좌표). */
const IDLE_TOP_Y = 170;

// 기다리는 동안(E1) 칠판에 먼저 써 주는 질문과 끄적이는 낙서. 자리는 보드 좌표(1280×720).
/** 질문 글씨 가운데 줄 높이(제목 크기). 문구 카드(styles·cards.css .with-question)는 그 아래 약 56%에서 시작한다. */
const WAIT_Q_Y = 250;
/** 질문을 쓰는 시간: 글자당, 최소·최대(빠른 선생님은 3~5초 안에 첫 말이 오니 길게 끌지 않는다). */
const WAIT_Q_MS_PER_CHAR = 70;
const WAIT_Q_MIN_MS = 700;
const WAIT_Q_MAX_MS = 1700;
/** 한 줄에 쓸 글자 수(넘으면 두 줄), 두 줄에 쓸 최대 글자 수(넘으면 줄임표). 칠판 글씨는 크게 읽혀야 한다. */
const WAIT_LINE_CHARS = 16;
const WAIT_MAX_CHARS = 34;
/** 낙서 자리: 문구 카드 아래 한 줄에 세 칸. */
const WAIT_DOODLE_Y = 560;
const WAIT_DOODLE_XS = [520, 640, 760] as const;
const WAIT_DOODLE_SIZE = 64;
const WAIT_DOODLE_MS = 900;
const WAIT_DOODLE_PAUSE_MS = 450; // 펜을 치우기(650ms) 전에 다음 낙서를 시작한다: 마커가 칠판 앞에 머문다
/** 수업이 시작되면 질문·낙서가 이만큼 위로 떠오르며 흐려진다. */
const WAIT_LIFT_MS = 420;
const WAIT_LIFT_PX = 18;
/** 생각하는 낙서(0~100 상자): 소용돌이, 별, 물음표, 전구, 물결, 반짝이. */
const DOODLES: readonly (readonly string[])[] = [
  ['M50 50 Q58 44 56 54 Q52 64 42 58 Q32 48 42 36 Q56 24 70 38 Q82 54 70 70 Q54 86 34 78'],
  ['M50 12 L60 40 L90 40 L66 58 L76 88 L50 70 L24 88 L34 58 L10 40 L40 40 Z'],
  ['M30 32 Q30 12 52 12 Q74 12 72 32 Q70 46 52 52 L50 66', 'M50 82 L50 86'],
  ['M50 14 Q24 14 24 40 Q24 56 38 66 L38 76 L62 76 L62 66 Q76 56 76 40 Q76 14 50 14', 'M40 86 L60 86'],
  ['M10 56 Q22 36 34 56 Q46 76 58 56 Q70 36 82 56 Q88 64 92 58'],
  ['M50 14 L50 86', 'M14 50 L86 50', 'M26 26 L74 74', 'M74 26 L26 74'],
];

/**
 * 기다리는 동안 칠판에 쓸 질문 줄(1~2줄). 짧으면 한 줄, 길면 가운데 가까운 띄어쓰기에서 두 줄로 나누고,
 * 그래도 길면 앞부분만 쓰고 줄임표를 붙인다(말로 물은 긴 말도 칠판에 크게 보이게).
 */
export function waitingLines(question: string): string[] {
  let q = question.replace(/\s+/g, ' ').trim();
  // 보이는 글자 묶음으로 센다(QA2: 코드 포인트로 자르면 가족 이모지 같은 ZWJ 묶음이 쪼개져 깨진 글자가 쓰였다).
  const glyphs = (s: string) => clusters(s).map((c) => c.s);
  const chars = glyphs(q);
  if (chars.length > WAIT_MAX_CHARS) q = chars.slice(0, WAIT_MAX_CHARS - 1).join('').trimEnd() + '…';
  const cs = glyphs(q);
  if (cs.length <= WAIT_LINE_CHARS) return [q];
  const mid = Math.floor(cs.length / 2);
  let cut = -1;
  for (let d = 0; d <= mid; d++) {
    if (cs[mid - d] === ' ') { cut = mid - d; break; }
    if (cs[mid + d] === ' ') { cut = mid + d; break; }
  }
  if (cut <= 0) cut = mid; // 띄어쓰기가 없으면 가운데에서
  return [cs.slice(0, cut).join('').trim(), cs.slice(cut).join('').trim()].filter(Boolean);
}

let uidSeq = 0;

/** 판서 글씨체: 한국어는 Hi Melody, 영어는 Patrick Hand(styles.css의 :root.lang-en). */
const BOARD_FONT = LANG === 'en' ? 'Patrick Hand' : 'Hi Melody';
const BOARD_FONT_SAMPLE = LANG === 'en' ? 'Abc' : '가나다';

/** 판서 글씨체(Hi Melody)가 준비될 때까지(최대 FONT_WAIT_MS) 기다린다. 글씨 폭을 재기 전에 필요. */
async function waitForFont(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const until = performance.now() + FONT_WAIT_MS;
  while (performance.now() < until) {
    try {
      // 구글 폰트 CSS가 아직 안 왔으면 맞는 @font-face가 없어 빈 배열이 온다 → 잠깐 뒤 다시.
      // 글꼴 파일 요청이 매달리면 load()가 그동안 안 끝난다(QA2 2026-11-23: 9초 매달림 → 첫 판서도 9초 늦음): 남은 시간까지만 기다린다.
      const left = Math.max(0, until - performance.now());
      const faces = await Promise.race([
        fonts.load(`${FONT_SIZE.label}px "${BOARD_FONT}"`, BOARD_FONT_SAMPLE),
        sleep(left).then(() => null),
      ]);
      if (faces === null || faces.length > 0) return;
    } catch {
      return;
    }
    await sleep(100);
  }
}

/** `?fps=1`: 구석에 FPS(개발용). window.__tbFps에 최근 값도 남긴다(헤드리스 측정용). */
let fpsStarted = false;
function startFpsMeter(): void {
  if (fpsStarted || typeof window === 'undefined') return;
  if (new URLSearchParams(location.search).get('fps') !== '1') return;
  fpsStarted = true;
  const el = document.createElement('div');
  el.className = 'fps-meter';
  el.style.cssText =
    'position:fixed;left:6px;bottom:6px;z-index:9999;padding:3px 7px;border-radius:6px;' +
    'font:12px/1.2 ui-monospace,monospace;color:#d8ffe8;background:rgba(0,0,0,.6);pointer-events:none';
  document.body.appendChild(el);
  const w = window as unknown as { __tbFps?: { fps: number; min: number; samples: number[] } };
  const stat = { fps: 0, min: Infinity, samples: [] as number[] };
  w.__tbFps = stat;
  let frames = 0, t0 = performance.now(), worst = 0, last = t0;
  const loop = (now: number) => {
    frames++;
    worst = Math.max(worst, now - last);
    last = now;
    if (now - t0 >= 500) {
      const fps = Math.round((frames * 1000) / (now - t0));
      stat.fps = fps;
      stat.min = Math.min(stat.min, fps);
      stat.samples.push(fps);
      if (stat.samples.length > 240) stat.samples.shift();
      el.textContent = `${fps} fps · 최저 ${stat.min} · 최장 ${Math.round(worst)}ms`;
      frames = 0;
      t0 = now;
      worst = 0;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export class Board implements BoardLike {
  private readonly uid = `tb${++uidSeq}`;
  private readonly ink: SVGGElement; // 다 그린 판서: 마커 필터가 걸린 정적 층
  private readonly inkWrap: SVGGElement;
  private readonly liveRoot: SVGGElement; // 그리는 중인 판서(판서마다 자기 영역만 필터)
  private readonly liveWrap: SVGGElement;
  private readonly liveDefs: SVGDefsElement;
  private readonly activeRoot: SVGGElement; // 지금 쓰는 획 하나(따로 된 층: 판서 묶음 필터를 매 프레임 다시 계산하지 않게)
  private readonly activeWrap: SVGGElement;
  private readonly clips: SVGDefsElement;
  private readonly eraser: SVGGElement;
  private readonly wipeRect: SVGRectElement;
  private readonly subtitle: HTMLSpanElement;
  /** 판서 면(사진 속 흰 면). 질문 카드(cards.ts)가 여기에 붙는다. */
  readonly surface: HTMLDivElement;
  private readonly thinkingCard: HTMLDivElement;
  private readonly thinkingText: HTMLSpanElement;
  private thinkingTimer: ReturnType<typeof setInterval> | undefined;
  /** 기다리는 동안 질문 쓰기·낙서(E1). abort하면 멈춘다. */
  private waitCtl: AbortController | null = null;
  /** 기다림마다 붙이는 표지(class). 끝난 기다림만 흐려 지우고, 바로 이어 시작한 기다림의 질문은 남긴다(QA2). */
  private readonly waitTags = new WeakMap<AbortController, string>();
  private waitSeq = 0;
  private readonly pen: MarkerPen;
  private readonly layers: Layers;
  private readonly ctx: ItemCtx;
  private gen = 0; // clear()/wipe 완료 때마다 증가 → 진행 중이던 애니메이션은 멈춘다
  private clipSeq = 0;
  private idleCtl: AbortController | null = null;
  private fontReady: Promise<void> | null = null;
  /** mark가 낱말을 찾도록: 글씨 id → 글씨 요소, 그림 id → 그림 묶음. 페이지가 바뀌면 비운다. */
  private texts = new Map<string, { el: SVGTextElement; text: string }>();
  private figures = new Map<string, SVGGElement>();
  private readonly liftMs: [number, number];
  /** 손 빠르기 배수(1 = 그대로). 쉽게 단계는 말을 늘인 만큼 크게 — setPace. */
  private pace = 1;
  /** 이 쪽에서 칸에 붙은 판서들(relayout이 옮긴다). 쪽이 바뀌면 비운다. */
  private anchors: Anchor[] = [];

  constructor(host: HTMLElement) {
    const u = this.uid;
    const board = document.createElement('div');
    board.className = 'board';
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.liftMs = reduce ? [40, 90] : [80, 200];
    // 정적 마크업만(사용자/모델 데이터 없음).
    board.innerHTML = `
      <div class="frame">
        <div class="photo"></div>
        <div class="surface">
          <div class="thinking-card" hidden><span class="thinking-text"></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
          <svg class="ink-layer" viewBox="0 0 ${BOARD.w} ${BOARD.h}" xmlns="${SVG_NS}" aria-hidden="true">
            <defs>
              <clipPath id="${u}-wipe"><rect class="wipe-rect" x="-20" y="-20" width="${BOARD.w + 40}" height="${BOARD.h + 40}"/></clipPath>
            </defs>
            <defs class="clips"></defs>
            <g class="ink-wrap"><g class="ink"></g></g>
          </svg>
          <svg class="live-layer" viewBox="0 0 ${BOARD.w} ${BOARD.h}" xmlns="${SVG_NS}" aria-hidden="true">
            <defs class="live-defs"></defs>
            <g class="live-wrap"><g class="live"></g></g>
          </svg>
          <svg class="active-layer" viewBox="0 0 ${BOARD.w} ${BOARD.h}" xmlns="${SVG_NS}" aria-hidden="true">
            <g class="active-wrap"><g class="active-root"></g></g>
          </svg>
          <svg class="pen-layer" viewBox="0 0 ${BOARD.w} ${BOARD.h}" xmlns="${SVG_NS}" aria-hidden="true">
            <defs>
              <linearGradient id="${u}-eraser" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="#b4bbc1"/><stop offset="0.45" stop-color="#eef0f2"/><stop offset="1" stop-color="#c3c9ce"/>
              </linearGradient>
            </defs>
            ${penMarkup(u)}
            <g class="eraser" style="display:none">
              <rect x="0" y="-16" width="${ERASER_W}" height="${BOARD.h + 32}" rx="14" fill="url(#${u}-eraser)"/>
              <rect x="${ERASER_W - 14}" y="-16" width="14" height="${BOARD.h + 32}" rx="6" fill="#4d535a"/>
            </g>
          </svg>
        </div>
      </div>`;
    const sub = document.createElement('div');
    sub.className = 'subtitle';
    this.subtitle = document.createElement('span');
    sub.appendChild(this.subtitle);
    // 자막 말풍선은 헤더 바로 아래, 칠판 위에(2026-11-22 사용자 요청). 꼬리는 아래 칠판을 가리킨다.
    host.append(sub, board);

    const stat = board.querySelector<SVGSVGElement>('svg.ink-layer')!;
    const liveSvg = board.querySelector<SVGSVGElement>('svg.live-layer')!;
    this.ink = stat.querySelector('.ink')!;
    this.inkWrap = stat.querySelector('.ink-wrap')!;
    this.clips = stat.querySelector('defs.clips')!;
    this.wipeRect = stat.querySelector('.wipe-rect')!;
    this.liveRoot = liveSvg.querySelector('.live')!;
    this.liveWrap = liveSvg.querySelector('.live-wrap')!;
    this.liveDefs = liveSvg.querySelector('defs.live-defs')!;
    const activeSvg = board.querySelector<SVGSVGElement>('svg.active-layer')!;
    this.activeRoot = activeSvg.querySelector('.active-root')!;
    this.activeWrap = activeSvg.querySelector('.active-wrap')!;
    const penSvg = board.querySelector<SVGSVGElement>('svg.pen-layer')!;
    this.eraser = penSvg.querySelector('.eraser')!;
    this.pen = new MarkerPen(penSvg.querySelector<SVGGElement>('.pen')!);
    const nextId = (kind: string) => `${this.uid}-${kind}${++this.clipSeq}`;
    this.layers = new Layers(this.ink, this.liveRoot, this.activeRoot, this.liveDefs, nextId);
    this.ctx = { clips: this.clips, nextId, pace: () => this.pace };
    this.thinkingCard = board.querySelector<HTMLDivElement>('.thinking-card')!;
    this.thinkingText = board.querySelector<HTMLSpanElement>('.thinking-text')!;
    this.surface = board.querySelector<HTMLDivElement>('.surface')!;
    startFpsMeter();
  }

  /**
   * 판서를 위쪽 가운데로 (1 − fraction)배 줄여 판서 면 아래 띠를 비운다(E2 이어 묻기 카드 자리). 0이면 원래대로.
   * 판서 좌표는 그대로다(층 전체를 CSS로 줄인다). 원래대로 돌릴 때는 애니메이션 없이(clear 직후 새 질문을 쓰니까).
   */
  setRoom(fraction: number): void {
    const f = Math.min(0.5, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    this.surface.classList.toggle('room-anim', f > 0);
    this.surface.style.setProperty('--room', f.toFixed(4));
  }

  setSubtitle(text: string): void {
    this.stopThinking();
    this.subtitle.classList.remove('thinking');
    this.subtitle.textContent = text;
  }

  /**
   * 선생님이 생각하는 중: 칠판 가운데에 문구 카드(점 세 개가 통통)를 띄우고, 문구를 THINKING_ROTATE_MS마다 바꾼다
   * (마지막 문구에서 멈춤). 다음 setSubtitle(첫 문장 등)·clear가 지운다.
   * question(E1)을 주면 그 질문을 먼저 칠판에 손글씨로 써 주고, 문구 카드는 그 아래로 내려가며, 다 쓴 뒤에는 마커가
   * 문구 아래에서 작은 낙서를 끄적이다 걷기를 되풀이한다(준비하는 모습). 수업이 시작되면(setSubtitle) 질문과 낙서는
   * 위로 살짝 떠오르며 흐려져 걷힌다 — 첫 제목이 보통 같은 질문이라 같은 글이 두 번 남지 않게.
   */
  setThinking(lines: readonly string[], question?: string): void {
    this.stopThinking();
    if (lines.length === 0) return;
    this.subtitle.textContent = '';
    const q = question?.trim();
    this.thinkingCard.classList.toggle('with-question', !!q);
    if (q) this.startWaiting(q);
    let i = 0;
    const show = () => {
      this.thinkingText.textContent = lines[i];
      this.thinkingCard.classList.remove('swap');
      void this.thinkingCard.offsetWidth; // 문구가 바뀔 때마다 살짝 떠오르는 효과를 다시
      this.thinkingCard.classList.add('swap');
    };
    show();
    this.thinkingCard.hidden = false;
    if (lines.length > 1) {
      this.thinkingTimer = setInterval(() => {
        i++;
        show();
        if (i >= lines.length - 1) {
          // 마지막 문구에서 멈춘다: 타이머도 끝낸다(카드는 그대로)
          clearInterval(this.thinkingTimer);
          this.thinkingTimer = undefined;
        }
      }, THINKING_ROTATE_MS);
    }
  }

  private stopThinking(fadeWaiting = true): void {
    if (this.thinkingTimer !== undefined) clearInterval(this.thinkingTimer);
    this.thinkingTimer = undefined;
    this.thinkingCard.hidden = true;
    this.endWaiting(fadeWaiting);
  }

  // ---------- 기다리는 동안(E1) ----------

  /** 질문을 쓰고 낙서를 되풀이한다. waitCtl을 abort하면 멈춘다. */
  private startWaiting(question: string): void {
    const ctl = new AbortController();
    this.waitCtl = ctl;
    const tag = `wait-${++this.waitSeq}`;
    this.waitTags.set(ctl, tag);
    const gen = this.gen;
    const live = () => gen === this.gen && !ctl.signal.aborted;
    void (async () => {
      await raceAbort(this.font(), ctl.signal);
      if (!live()) return;
      const lines = waitingLines(question);
      const { holder, g } = this.layers.openLive(`op waiting waiting-q ${tag}`);
      const size = FONT_SIZE.title;
      const gap = size * 1.08;
      const top = WAIT_Q_Y - ((lines.length - 1) * gap) / 2;
      const items = lines.map((t, i) => textItem(this.ctx, g, t, {
        x: BOARD.w / 2, y: top + i * gap, size, color: inkColor('navy'), anchor: 'middle', maxW: BOARD.w - 200, bold: TEXT_BOLD.title,
      }).item);
      const ms = Math.min(WAIT_Q_MAX_MS, Math.max(WAIT_Q_MIN_MS, [...lines.join('')].length * WAIT_Q_MS_PER_CHAR));
      const filter = this.layers.filterLive(holder);
      try {
        await this.run(items, ms, live, ctl.signal);
      } finally {
        this.layers.settle(holder, g, filter, () => gen === this.gen);
      }
      if (this.liftMs[0] < 80) return; // 움직임 줄이기: 낙서는 하지 않는다(문구 카드만)
      // 준비하는 모습: 문구 아래 세 자리에 작은 낙서를 하나씩 끄적이고, 셋이 차면 흐려 지우고 다시.
      let n = Math.floor(Math.random() * DOODLES.length);
      while (live()) {
        const row: SVGGElement[] = [];
        for (let i = 0; i < WAIT_DOODLE_XS.length && live(); i++) {
          await sleep(WAIT_DOODLE_PAUSE_MS);
          if (!live()) break;
          row.push(await this.doodle(DOODLES[n++ % DOODLES.length], WAIT_DOODLE_XS[i], live, ctl.signal, tag));
        }
        await sleep(WAIT_DOODLE_PAUSE_MS * 2);
        if (!live()) break;
        await Promise.all(row.map((d) => this.fade(d, 1, 0, live).then(() => removeWithFilter(d))));
      }
    })();
  }

  /** 낙서 하나(0~100 상자 경로들)를 (cx, WAIT_DOODLE_Y) 둘레에 회색으로 가늘게 그린다. 그린 묶음을 돌려준다. */
  private async doodle(paths: readonly string[], cx: number, live: () => boolean, signal: AbortSignal, tag: string): Promise<SVGGElement> {
    const s = WAIT_DOODLE_SIZE / 100;
    const x0 = cx - WAIT_DOODLE_SIZE / 2, y0 = WAIT_DOODLE_Y - WAIT_DOODLE_SIZE / 2;
    const { holder, g } = this.layers.openLive(`op waiting waiting-doodle ${tag}`);
    const local = svg('g', { transform: `translate(${fx(x0)} ${fx(y0)}) scale(${s})` });
    g.appendChild(local);
    const map = (x: number, y: number): Pt => [x0 + x * s, y0 + y * s];
    const color = inkColor('gray');
    const items = paths.map((d) => strokeItem(local, d, color, s / 0.62, map)); // 글씨보다 가는 선
    const filter = this.layers.filterLive(holder);
    const gen = this.gen;
    try {
      await this.run(items, WAIT_DOODLE_MS, live, signal);
    } finally {
      this.layers.settle(holder, g, filter, () => gen === this.gen); // 멈춰도 남겨 두면 endWaiting이 흐려 지운다
    }
    return g;
  }

  /**
   * 기다림 끝: 끄적이기를 멈추고, 써 둔 질문·낙서를 위로 살짝 떠오르며 흐려 지운다(fade=false면 바로 지움).
   * 그리다 멈춘 획이 정적 층으로 옮겨질 틈(마이크로태스크·한 틱)을 준 뒤 모은다.
   */
  private endWaiting(fade: boolean): void {
    const ctl = this.waitCtl;
    this.waitCtl = null;
    ctl?.abort();
    const sweep = () => [this.ink, this.liveRoot].flatMap((root) => [...root.querySelectorAll<SVGGElement>('.waiting')]);
    if (!fade) {
      for (const el of sweep()) removeWithFilter(el);
      return;
    }
    if (!ctl) return;
    const gen = this.gen;
    const live = () => gen === this.gen;
    // 이 기다림의 것만(곧바로 새 기다림을 시작했으면 그 질문은 이 틈에 이미 생겼을 수 있다).
    const tag = this.waitTags.get(ctl);
    setTimeout(() => {
      if (!live()) return;
      for (const el of sweep()) {
        if (tag && !el.classList.contains(tag)) continue;
        el.classList.remove('waiting'); // 다음 기다림이 다시 집지 않게
        void tween(WAIT_LIFT_MS, (p) => {
          const e = smoothstep(p);
          el.style.opacity = String(1 - e);
          el.style.transform = `translateY(${fx(-WAIT_LIFT_PX * e)}px)`;
        }, live).then(() => removeWithFilter(el));
      }
    }, 0);
  }

  clear(): void {
    this.stopThinking(false);
    this.gen++;
    this.idleCtl?.abort();
    this.idleCtl = null;
    this.ink.replaceChildren();
    this.liveRoot.replaceChildren();
    this.activeRoot.replaceChildren();
    this.liveDefs.replaceChildren();
    this.clips.replaceChildren();
    this.texts.clear();
    this.figures.clear();
    this.anchors = [];
    this.eraser.style.display = 'none';
    this.inkWrap.removeAttribute('clip-path');
    this.liveWrap.removeAttribute('clip-path');
    this.activeWrap.removeAttribute('clip-path');
    this.pen.reset();
    this.setRoom(0);
  }

  async wipe(signal: AbortSignal): Promise<void> {
    const gen = this.gen;
    const live = () => gen === this.gen;
    if (!signal.aborted && (this.ink.childNodes.length > 0 || this.liveRoot.childNodes.length > 0)) {
      this.idleCtl?.abort();
      this.pen.hide(160);
      this.eraser.style.display = '';
      const clip = `url(#${this.uid}-wipe)`;
      this.inkWrap.setAttribute('clip-path', clip);
      this.liveWrap.setAttribute('clip-path', clip);
      this.activeWrap.setAttribute('clip-path', clip);
      const from = -ERASER_W - 16, to = BOARD.w + 16;
      await tween(
        WIPE_MS,
        (p) => {
          const x = from + (to - from) * p;
          this.eraser.setAttribute('transform', `translate(${fx(x)} 0)`);
          this.wipeRect.setAttribute('x', fx(x + ERASER_W / 2)); // 지우개 가운데 왼쪽은 지워짐
        },
        live,
        signal,
      );
    }
    // 끝났든 abort됐든 보드는 비운 상태로 둔다(보드가 이미 clear()됐으면 그대로).
    if (live()) this.clear();
    this.wipeRect.setAttribute('x', '-20');
  }

  /** at: 'top'이면 가운데가 아니라 위쪽(예시 질문 카드가 아래 절반에 붙을 때, A1)에 쓴다. */
  writeIdle(text: string, at: 'center' | 'top' = 'center'): void {
    this.idleCtl?.abort();
    for (const root of [this.ink, this.liveRoot]) {
      for (const el of root.querySelectorAll('.idle')) (el.closest('.ink-live') ?? el).remove();
    }
    const ctl = new AbortController();
    this.idleCtl = ctl;
    const gen = this.gen;
    const live = () => gen === this.gen;
    void (async () => {
      await raceAbort(this.font(), ctl.signal);
      if (ctl.signal.aborted || !live()) return;
      const { holder, g } = this.layers.openLive('op idle');
      const size = FONT_SIZE.title;
      const { item } = textItem(this.ctx, g, text, {
        x: BOARD.w / 2, y: (at === 'top' ? IDLE_TOP_Y : BOARD.h / 2) + size * 0.3, size, color: inkColor('black'), anchor: 'middle', maxW: BOARD.w - 160, bold: TEXT_BOLD.title,
      });
      const filter = this.layers.filterLive(holder);
      try {
        await this.run([item], IDLE_MS, live, ctl.signal);
      } finally {
        this.layers.settle(holder, g, filter, live);
      }
    })();
  }

  /**
   * 손 빠르기(1 = 그대로, 1.11 = 느리게). 획·글씨가 낼 수 있는 가장 느린 빠르기, 펜 드는 쉼, 표시 길이를 이만큼 늘린다.
   * 판서 길이(durationMs) 자체는 플레이어가 이미 같은 배수로 늘여서 준다.
   */
  setPace(p: number): void {
    this.pace = Number.isFinite(p) && p > 0 ? Math.min(2, Math.max(0.5, p)) : 1;
  }

  async draw(op: DrawOp, place: Placement | { refs: Rect[] }, durationMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const gen = this.gen;
    const live = () => gen === this.gen;
    await raceAbort(this.font(), signal); // 글씨 폭을 재기 전에 글꼴 준비
    if (signal.aborted || !live()) return;

    const { holder, g } = this.layers.openLive(`op op-${op.kind}`);
    let items: Item[] = [];
    let ms = durationMs;
    let mark = false;
    let anchor: Anchor | null = null;
    switch (op.kind) {
      case 'figure':
        if ('rect' in place) {
          anchor = this.anchor(g, op, [place.rect]);
          items = this.figureItems(g, op, place);
        }
        break;
      case 'text':
        if ('rect' in place) items = [this.titleOrNote(g, op, place.rect)];
        break;
      case 'connect':
        // 같은 칸끼리 잇기(from === to)는 칸 안에서 거꾸로 가는 화살표가 되니 긋지 않는다(QA 2026-11-22).
        // 비운 칸(주문 그림 실패로 크기 0)을 가리키면 긋지 않는다.
        if ('refs' in place && place.refs.length >= 2 && !sameRect(place.refs[0], place.refs[1]) && place.refs.every((r) => r.w > 0)) {
          anchor = this.anchor(g, op, place.refs.slice(0, 2));
          items = this.connectItems(g, op, place.refs[0], place.refs[1]);
        }
        break;
      case 'mark':
        if ('refs' in place && place.refs.length >= 1 && place.refs[0].w > 0) {
          anchor = this.anchor(g, op, [place.refs[0]]);
          items = this.markItems(g, op, place.refs[0]);
          mark = true;
          // 표시는 빠르게(0.3~0.6초): 밑줄은 "쫙", 동그라미는 한 번에 휙
          const len = items.reduce((s, it) => s + it.weight, 0);
          ms = Math.min(Math.max(0, durationMs), Math.min(600, Math.max(300, 240 + len * 0.55)) * this.pace);
        }
        break;
    }
    if (items.length === 0) {
      holder.remove();
      return;
    }
    const filter = this.layers.filterLive(holder);
    try {
      // 그리는 중에 칸이 옮겨지면(relayout) 판서 묶음이 옮겨 간 만큼 펜도 옮겨 그린다(QA2 2026-11-23).
      const a = anchor;
      const offset = a ? (): Pt => (a.g === g ? a.off : [0, 0]) : undefined;
      await this.run(items, ms, live, signal, mark, offset);
    } finally {
      this.layers.settle(holder, g, filter, live);
    }
  }


  // ---------- 칸 옮기기(B2) ----------

  private anchor(g: SVGGElement, op: DrawOp, rects: Rect[]): Anchor {
    const a: Anchor = { g, op, rects, at: rects.map((r): Pt => [r.x, r.y]), off: [0, 0], goal: [0, 0], tok: 0 };
    this.anchors.push(a);
    return a;
  }

  /**
   * 칸이 옮겨졌으면 판서를 따라 옮긴다(B2: 한 쪽의 그림 수가 늘거나 줄면 가운데 정렬을 다시 한다).
   * 그림·표시는 칸이 옮긴 만큼 미끄러지고, 양 끝 칸이 서로 다르게 옮긴 연결선은 새 자리로 다시 그어 바꿔 끼운다.
   * 비운 칸(크기 0)에 붙은 판서는 흐려지며 사라진다.
   */
  relayout(): void {
    const gen = this.gen;
    const live = () => gen === this.gen;
    for (const a of [...this.anchors]) {
      if (!a.g.isConnected) {
        this.anchors.splice(this.anchors.indexOf(a), 1);
        continue;
      }
      if (a.rects.some((r) => r.w <= 0)) {
        this.anchors.splice(this.anchors.indexOf(a), 1);
        void this.fade(a.g, 1, 0, live).then(() => removeWithFilter(a.g));
        continue;
      }
      const d = a.rects.map((r, i): Pt => [r.x - a.at[i][0], r.y - a.at[i][1]]);
      const same = d.every(([x, y]) => x === d[0][0] && y === d[0][1]);
      if (!same && a.op.kind === 'connect') {
        this.redrawConnect(a, live);
        continue;
      }
      if (d[0][0] === a.goal[0] && d[0][1] === a.goal[1]) continue;
      a.goal = d[0];
      const tok = ++a.tok;
      const [x0, y0] = a.off, [tx, ty] = a.goal;
      const set = (x: number, y: number) => {
        a.off = [x, y];
        if (x === 0 && y === 0) a.g.removeAttribute('transform');
        else a.g.setAttribute('transform', `translate(${fx(x)} ${fx(y)})`);
        this.layers.syncActive(); // 지금 쓰는 획(따로 된 층)도 같이 옮긴다(QA2)
      };
      void tween(RELAYOUT_MS, (p) => {
        if (a.tok !== tok) return;
        const e = smoothstep(p);
        set(lerp(x0, tx, e), lerp(y0, ty, e));
      }, live).then(() => {
        if (a.tok === tok && live()) set(tx, ty);
      });
    }
  }

  /** 양 끝이 따로 옮겨진 연결선: 새 자리로 한 번에 다시 그어 놓고, 예전 선과 겹쳐 바꿔 끼운다. */
  private redrawConnect(a: Anchor, live: () => boolean): void {
    const op = a.op as ConnectOp;
    const [from, to] = a.rects;
    const old = a.g;
    const { holder, g } = this.layers.openLive('op op-connect');
    g.style.opacity = '0';
    const items = sameRect(from, to) ? [] : this.connectItems(g, op, from, to, old);
    for (const it of items) {
      it.begin();
      it.frame(1, 1);
      it.done();
    }
    const filter = this.layers.filterLive(holder);
    this.layers.settle(holder, g, filter, live);
    a.g = g;
    a.at = a.rects.map((r): Pt => [r.x, r.y]);
    a.off = [0, 0];
    a.goal = [0, 0];
    a.tok++;
    void this.fade(g, 0, 1, live);
    void this.fade(old, 1, 0, live).then(() => removeWithFilter(old));
  }

  private fade(el: SVGElement, from: number, to: number, live: () => boolean): Promise<boolean> {
    return tween(RELAYOUT_MS, (p) => {
      el.style.opacity = String(lerp(from, to, smoothstep(p)));
    }, live).then((ok) => {
      if (to >= 1) el.style.removeProperty('opacity');
      return ok;
    });
  }

  /** 칸에 붙은 판서가 아직 다 못 간 거리(옮기는 중이면 그만큼 더해야 최종 자리). */
  private pending(el: Element): Pt {
    const a = this.anchors.find((x) => x.g === el);
    return a ? [a.goal[0] - a.off[0], a.goal[1] - a.off[1]] : [0, 0];
  }

  /**
   * 이 쪽의 다른 판서(skip 밖): 선 위의 점(약 6px 간격)과 글씨·칠한 면 상자(보드 좌표, 옮긴 자리 그대로).
   * 이름표·연결 라벨·동그라미 자리를 고를 때 쓴다(D1: 나중에 그린 선이 앞 이름표를, 나중에 쓴 이름표가 앞 선을 덮지 않게).
   */
  private pageObstacles(...skip: Element[]): { points: Pt[]; boxes: Box[]; texts: Box[] } {
    const points: Pt[] = [];
    const fills: Box[] = [];
    const texts: Box[] = [];
    const paths: { m: DOMMatrix; el: SVGPathElement; len: number; k: number }[] = [];
    // 옮기는 중인 판서(relayout)는 옮겨 갈 자리로 친다(QA2 2026-11-23: 막 옮기기 시작한 그림의 옛 자리를 피하고 새 자리에 라벨을 썼다).
    const moving = this.anchors.map((a) => ({ g: a.g, d: this.pending(a.g) })).filter(({ d }) => d[0] !== 0 || d[1] !== 0);
    for (const root of [this.ink, this.liveRoot]) {
      for (const el of root.querySelectorAll<SVGGraphicsElement>('path, text')) {
        if (skip.some((k) => k.contains(el)) || el.closest('mask, clipPath, defs, .idle')) continue;
        let m = toBoard(el);
        if (!m) continue;
        const mv = moving.find(({ g }) => g.contains(el));
        if (mv) m = new DOMMatrix([1, 0, 0, 1, mv.d[0], mv.d[1]]).multiply(m);
        if (el instanceof SVGTextElement || el.classList.contains('fill')) {
          const b = boardBox(el, m);
          if (b) (el instanceof SVGTextElement ? texts : fills).push(b);
          continue;
        }
        try {
          const len = (el as SVGPathElement).getTotalLength();
          const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
          if (Number.isFinite(len) && len > 0) paths.push({ m, el: el as SVGPathElement, len, k });
        } catch {
          // 못 재는 선은 건너뛴다
        }
      }
    }
    const total = paths.reduce((s, p) => s + p.len * p.k, 0);
    const step = Math.max(6, total / MAX_PAGE_POINTS); // 보드 px
    for (const { m, el, len, k } of paths) {
      try {
        for (let l = 0; l <= len; l += step / k) {
          const q = el.getPointAtLength(l);
          points.push([m.a * q.x + m.c * q.y + m.e, m.b * q.x + m.d * q.y + m.f]);
        }
      } catch {
        // 건너뛴다
      }
    }
    return { points, boxes: [...fills, ...texts], texts };
  }

  // ---------- 애니메이션 ----------

  /**
   * 여러 획을 strokeSchedule로 나눠 사람 손처럼 그린다: 획마다 가감속, 획 사이 펜 들기(마커가 다음 시작점으로 이동).
   * abort되면 시작 안 한 획은 지운다. offset: 판서 묶음이 지금 옮겨 둔 만큼(relayout). 획 좌표에 더해 펜을 놓는다.
   */
  private async run(items: Item[], durationMs: number, live: () => boolean, signal: AbortSignal, mark = false, offset?: () => Pt): Promise<void> {
    if (items.length === 0) return;
    const at = (x: number, y: number): Pt => {
      const [ox, oy] = offset?.() ?? [0, 0];
      return [x + ox, y + oy];
    };
    let pen = 0;
    let active: { deactivate(): void; close(): void } | null = null;
    let begun = -1;
    let ok = false;
    try {
      const rand = seededRand((Math.random() * 2 ** 31) | 0);
      const total = Math.max(0, durationMs);
      pen = this.pen.take();
      const wasVisible = this.pen.visible;
      const lead = pen ? Math.min(LEAD_MS, total * 0.12) : 0;
      const sched = strokeSchedule(
        items.map((it) => it.weight),
        total - lead,
        rand,
        mark
          ? { minMs: 50, liftMs: [50 * this.pace, 110 * this.pace] }
          : { maxMsPerPx: MAX_MS_PER_PX * this.pace, liftMs: [this.liftMs[0] * this.pace, this.liftMs[1] * this.pace] },
      );
      const lastS = sched[sched.length - 1];
      const end = lead + lastS.startMs + lastS.durMs;
      if (pen) {
        if (!wasVisible) {
          const [sx, sy] = at(...items[0].startPt());
          this.pen.x = sx;
          this.pen.y = sy;
          this.pen.h = 1;
        }
        this.pen.show();
      }
      let cur = 0;
      let from: Pt = [this.pen.x, this.pen.y];
      const fromH = this.pen.h;
      const act = this.layers.openActive();
      active = act;
      const beginUpTo = (i: number) => {
        while (begun < i) {
          const it = items[++begun];
          act.activate(it.node);
          it.begin();
        }
      };
      const tick = (t: number) => {
        const tt = t - lead;
        while (cur < items.length && tt >= sched[cur].startMs + sched[cur].durMs) {
          beginUpTo(cur);
          const p = items[cur].frame(sched[cur].durMs, sched[cur].durMs);
          items[cur].done();
          act.deactivate();
          from = at(p.x, p.y);
          cur++;
        }
        if (cur >= items.length) {
          if (pen) this.pen.moveTo(from[0], from[1], 0);
          return;
        }
        const s = sched[cur];
        const it = items[cur];
        if (pen) this.pen.setColor(it.color);
        if (tt >= s.startMs) {
          beginUpTo(cur);
          const p = it.frame(tt - s.startMs, s.durMs);
          if (pen) this.pen.moveTo(...at(p.x, p.y), p.down ? 0 : 0.32, p.smooth);
          return;
        }
        if (!pen) return;
        // 펜 들기: 앞 획 끝 → 이 획 시작, 위로 들렸다가 내려앉는다
        const prevEnd = cur > 0 ? sched[cur - 1].startMs + sched[cur - 1].durMs : -lead;
        const u = clamp01((tt - prevEnd) / Math.max(1, s.startMs - prevEnd));
        const [tx, ty] = at(...it.startPt());
        const e = smoothstep(u);
        const h = cur === 0 ? Math.max(Math.sin(Math.PI * u) * (wasVisible ? 0.8 : 0), fromH * (1 - e)) : Math.sin(Math.PI * u);
        this.pen.moveTo(lerp(from[0], tx, e), lerp(from[1], ty, e), h);
      };
      ok = await tween(end, (p) => tick(p * end), live, signal);
    } finally {
      active?.close(); // 그리다 멈춘 획도 판서 묶음으로 돌려놓는다
      if (!ok) for (const rest of items.slice(begun + 1)) rest.remove(); // 시작 안 한 획은 그리지 않는다
      if (pen) this.pen.release(pen, live);
    }
  }

  private font(): Promise<void> {
    if (!this.fontReady) this.fontReady = waitForFont();
    return this.fontReady;
  }


  private titleOrNote(g: SVGGElement, op: TextOp, rect: Rect): Item {
    const role = op.role === 'title' ? 'title' : 'note';
    const size = FONT_SIZE[role];
    const baseline = (s: number) => rect.y + rect.h / 2 + s * 0.3;
    const { item, el } = textItem(this.ctx, g, op.text, {
      x: rect.x + 4, y: baseline(size), size, color: inkColor(op.ink), anchor: 'start', maxW: rect.w - 8, fitY: baseline, bold: TEXT_BOLD[role],
    });
    el.classList.add(role);
    if (op.id) this.texts.set(op.id, { el, text: op.text });
    return item;
  }

  private figureItems(g: SVGGElement, op: FigureOp, place: Placement): Item[] {
    const { rect, scale } = place;
    const base = inkColor(op.ink);
    // 범위 밖 좌표(-5..105, 넓은 그림은 y 37 초과)가 칸 밖·보드 밖으로 번지지 않게 칸(+여백)으로 자른다.
    const c = {
      x0: Math.max(0, rect.x - FIG_CLIP_PAD), y0: Math.max(0, rect.y - FIG_CLIP_PAD),
      x1: Math.min(BOARD.w, rect.x + rect.w + FIG_CLIP_PAD), y1: Math.min(BOARD.h, rect.y + rect.h + FIG_CLIP_PAD),
    };
    const clipId = this.ctx.nextId('f');
    const cp = svg('clipPath', { id: clipId });
    cp.appendChild(svg('rect', { x: c.x0, y: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0 }));
    this.clips.appendChild(cp);
    g.setAttribute('clip-path', `url(#${clipId})`);
    if (op.id) this.figures.set(op.id, g);

    const local = svg('g', { class: 'shape', transform: `translate(${rect.x} ${rect.y}) scale(${scale})` });
    g.appendChild(local);
    const fills = svg('g', { class: 'fills' }); // 채우기는 선 아래
    local.appendChild(fills);
    // 마커 끝 위치(보드 좌표, 그리기 시작할 때의 칸 자리 기준). 잘린 영역 밖으로는 따라가지 않는다.
    // 칸 객체는 layout이 옮길 수 있다(relayout): 그 몫은 판서 묶음의 transform으로 옮기고 펜은 run()이 더한다(QA2).
    const ox = rect.x, oy = rect.y;
    const map = (x: number, y: number): Pt => [
      Math.min(c.x1, Math.max(c.x0, ox + x * scale)),
      Math.min(c.y1, Math.max(c.y0, oy + y * scale)),
    ];
    const lines: Item[] = [];
    const fillItems: Item[] = [];
    for (const s of Array.isArray(op.strokes) ? op.strokes : []) {
      const d = typeof s === 'string' ? s : s?.d;
      if (typeof d !== 'string') continue;
      const color = typeof s === 'object' && s.ink ? inkColor(s.ink) : base;
      if (typeof s === 'object' && s.fill) {
        // 채우기는 채우기만(윤곽은 화가가 따로 그렸다). 선이 다 그려진 뒤에 칠한다.
        const it = fillItem(this.ctx, fills, d, color, scale, map);
        if (it) fillItems.push(it);
        continue;
      }
      // 한 획 안의 M 여러 개는 펜을 들었다 놓는 따로따로의 획(상대 좌표 m이 있으면 그대로).
      const parts = /[a-z]/.test(d.replace(/z/g, '')) ? [d] : d.split(/(?=M)/).map((p) => p.trim()).filter(Boolean);
      for (const p of parts) lines.push(strokeItem(local, p, color, scale, map));
      if (typeof s === 'object' && s.arrow) {
        // 화살촉은 프로그램이 끝 방향대로 붙인다(보드에서 약 24px)
        const head = arrowHeadPath(d, 24 / Math.max(0.01, scale));
        if (head) lines.push(strokeItem(local, head, color, scale, map));
      }
    }
    // 이름표: 그림 선·칠한 면·앞 이름표, 그리고 이 쪽의 다른 판서(연결선·표시·글씨)와 겹치면 가장 가까운 빈자리로 옮기고,
    // 멀리 옮겼으면 안내선을 긋는다.
    const page = this.pageObstacles(g);
    const obs: Obstacles = {
      points: [...figurePoints(lines, ox, oy, scale), ...page.points],
      boxes: [...fillBoxes(fills, ox, oy, scale), ...page.boxes],
    };
    const bounds: Box = { x: c.x0, y: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0 };
    const labels: Item[] = [];
    for (const l of Array.isArray(op.labels) ? op.labels : []) {
      // 좌표가 수가 아니거나 글씨가 비면 그리지 않는다(파서가 막지만 보드도 x="NaN" 글씨를 만들지 않게).
      if (!Number.isFinite(Number(l.x)) || !Number.isFinite(Number(l.y)) || String(l.text ?? '').trim() === '') continue;
      const [x, y] = map(Number(l.x), Number(l.y));
      const lc = inkColor((l.ink ?? op.ink) as Ink);
      const opts = (size: number) => ({ size, color: lc, anchor: 'middle' as const, maxW: rect.w, clampX: [rect.x, rect.x + rect.w] as [number, number], bold: TEXT_BOLD.label });
      let t = textItem(this.ctx, g, String(l.text), { x, y, ...opts(FONT_SIZE.label) });
      t.el.classList.add('label');
      const box = boxOf(t.el);
      if (box) {
        // 빈자리를 못 찾으면 글씨를 조금씩 줄여 다시 찾는다(칸 가장자리에 이름표 둘이 나란히 붙은 경우 등).
        // 화가가 칸 가장자리 밖으로 살짝 걸쳐 둔 이름표도 옮길 수 있게, 범위는 칸과 원래 자리를 함께 품는다.
        const area = union(bounds, box);
        // 가까운 곳(필요하면 글씨를 줄여서) → 그래도 없으면 멀리. 처음으로 깨끗한 자리, 없으면 가장 덜 겹치는 자리.
        const sized = (k: number): Box => ({ x: box.x + (box.w * (1 - k)) / 2, y: box.y + box.h * (1 - k), w: box.w * k, h: box.h * k });
        let pick = { k: 1, ...placeLabel(box, obs, area, undefined, NEAR_R) };
        for (const [k, far] of [...LABEL_SHRINK.map((k) => [k, false] as const), [1, true] as const, ...LABEL_SHRINK.map((k) => [k, true] as const)]) {
          if (pick.score === 0) break;
          const p = placeLabel(sized(k), obs, area, undefined, far ? undefined : NEAR_R);
          if (p.score < pick.score) pick = { k, ...p };
        }
        const { k, dx, dy } = pick;
        if (dx !== 0 || dy !== 0 || k !== 1) {
          t.item.remove();
          t = textItem(this.ctx, g, String(l.text), { x: x + dx, y: y + dy, ...opts(FONT_SIZE.label * k) });
          t.el.classList.add('label');
          const moved = boxOf(t.el) ?? { ...box, x: box.x + dx, y: box.y + dy };
          const lead = Math.hypot(dx, dy) >= LEADER_MIN ? leaderPath(moved, [box.x + box.w / 2, box.y + box.h / 2]) : null;
          if (lead) {
            const id = (px: number, py: number): Pt => [px, py];
            labels.push(strokeItem(g, lead, lc, 2.2, id));
          }
          obs.boxes.push(moved);
        } else {
          obs.boxes.push(box);
        }
      }
      labels.push(t.item);
    }
    return [...lines, ...fillItems, ...labels];
  }

  /** replacing: 바꿔 끼울 예전 연결선(장애물로 치지 않는다). */
  private connectItems(g: SVGGElement, op: ConnectOp, from: Rect, to: Rect, replacing?: Element): Item[] {
    const color = inkColor(op.ink);
    const id = (x: number, y: number): Pt => [x, y];
    const page = replacing ? this.pageObstacles(g, replacing) : this.pageObstacles(g);
    const textObs: Obstacles = { points: [], boxes: page.texts };
    // 위로 휜 화살표가 글씨·이름표를 지나면 아래로 휜 것으로(덜 지나는 쪽).
    let [body, head] = arrowPath(from, to);
    const hits = (ds: string[]) => pathPoints(g, ds).reduce((n, p) => n + (collisions({ x: p[0], y: p[1], w: 0, h: 0 }, textObs) > 0 ? 1 : 0), 0);
    const up = hits([body, head]);
    if (up > 0) {
      const down = arrowPath(from, to, true);
      if (hits(down) < up) [body, head] = down;
    }
    const items = [strokeItem(g, body, color, 1, id), strokeItem(g, head, color, 1, id)];
    if (op.label) {
      const paths = [...g.querySelectorAll('path')];
      let mx = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
      let top = Math.min(from.y + from.h / 2, to.y + to.h / 2);
      try {
        const pt = paths[0].getPointAtLength(paths[0].getTotalLength() / 2);
        mx = pt.x;
        // 몸통 + 화살촉 상자를 합친 맨 위(선 굵기 절반 포함)
        top = Math.min(...paths.map((p) => p.getBBox().y)) - STROKE_W / 2;
      } catch {
        /* 기본값 사용 */
      }
      const bottomMax = top - LABEL_GAP;
      const label = String(op.label);
      const opts = { size: FONT_SIZE.label, color, anchor: 'middle' as const, maxW: 520, clampX: [8, BOARD.w - 8] as [number, number], bold: TEXT_BOLD.label };
      let t = textItem(this.ctx, g, label, { x: mx, y: bottomMax, ...opts, bottomMax });
      // 라벨이 그림 선·이름표·글씨에 닿으면(D1: "엄청 멀다!"가 동그라미에 닿았다) 가까운 빈자리로. 화살표 자체도 피한다.
      const box = boxOf(t.el);
      if (box) {
        const obs: Obstacles = { points: [...page.points, ...pathPoints(g, [body, head])], boxes: page.boxes };
        let pick = placeLabel(box, obs, BOARD_IN, undefined, NEAR_R);
        if (pick.score > 0) {
          const far = placeLabel(box, obs, BOARD_IN);
          if (far.score < pick.score) pick = far;
        }
        if (pick.dx !== 0 || pick.dy !== 0) {
          const x = Number(t.el.getAttribute('x')) + pick.dx, y = Number(t.el.getAttribute('y')) + pick.dy;
          t.item.remove();
          t = textItem(this.ctx, g, label, { x, y, ...opts });
        }
      }
      t.el.classList.add('label');
      items.push(t.item);
    }
    return items;
  }

  /** 표시: 대상(글씨면 word 글자 상자, 그림이면 그린 모양 상자)에 손으로 그은 표시. */
  private markItems(g: SVGGElement, op: MarkOp, target: Rect): Item[] {
    const r = this.markRect(op, target);
    const t = this.texts.get(op.target);
    const compact = !!t && t.el.isConnected && Number(t.el.getAttribute('font-size')) === FONT_SIZE.note;
    const rand = seededRand(`${op.target}|${op.word ?? ''}|${op.style}`);
    const color = inkColor(op.ink);
    const id = (x: number, y: number): Pt => [x, y];
    const fg = this.figures.get(op.target);
    if (op.style === 'circle' && !t && fg?.isConnected) {
      // 그림 동그라미: 그림 선만 감싸고, 이름표·글씨는 품거나 비켜 간다 — 획이 글자 상자를 가로지르지 않는다
      // (D1 2026-11-23: 그림+이름표 상자에 맞춘 타원이 아래쪽 이름표 "아주 먼 달"을 잘랐다).
      const shape = fg.querySelector<SVGGElement>(':scope > .shape');
      const m = shape ? toBoard(shape) : null;
      const core = shape && m ? boardBox(shape, m) : null;
      if (core && core.w > 4 && core.h > 4) {
        const [px, py] = this.pending(fg);
        const page = this.pageObstacles(g);
        // 그림 선에서 FIG_CIRCLE_GAP만큼 띄운다(동그라미가 그림 끝에 닿아 보이지 않게).
        const g0 = FIG_CIRCLE_GAP;
        const e = fitEllipse({ x: core.x + px - g0, y: core.y + py - g0, w: core.w + 2 * g0, h: core.h + 2 * g0 }, page.texts, BOARD_IN);
        return [strokeItem(g, circleMarkPath(e, rand), color, 1, id, easeFlick, false)];
      }
    }
    // 동그라미는 한 획으로 닫혀 끝이 시작 옆을 지난다: 잉크 고임 점을 찍지 않는다(QA2: 두 점 사이 겹친 곳이 짧은 흔적으로 보였다).
    return markPaths(op.style, r, rand, compact).map((d) => strokeItem(g, d, color, 1, id, easeFlick, op.style !== 'circle'));
  }

  /** 표시할 상자(보드 좌표). 글씨: word 글자들(기준선 기준으로 보이는 높이만), 그림: 그린 모양, 아니면 받은 칸. */
  private markRect(op: MarkOp, ref: Rect): Rect {
    const t = this.texts.get(op.target);
    if (t && t.el.isConnected) {
      // 옆에 붙는 표시(별·체크·느낌표)는 낱말이 줄 가운데면 다음 낱말과 겹치니 줄 끝에 붙인다.
      let word = op.word;
      if (word && (op.style === 'star' || op.style === 'check' || op.style === 'exclaim')) {
        const i = t.text.indexOf(word.trim());
        if (i >= 0 && t.text.slice(i + word.trim().length).trim().length > 0) word = undefined;
      }
      const r = glyphBox(t.el, t.text, word);
      if (r) return r;
    }
    const fg = this.figures.get(op.target);
    const m = fg?.isConnected ? toBoard(fg) : null;
    const box = fg && m ? boardBox(fg, m) : null;
    if (fg && box) {
      // 옮기는 중이면 옮겨 갈 자리 기준(칸 ref는 이미 새 자리다)
      const [px, py] = this.pending(fg);
      const x0 = Math.max(ref.x - FIG_CLIP_PAD, box.x + px), y0 = Math.max(ref.y - FIG_CLIP_PAD, box.y + py);
      const x1 = Math.min(ref.x + ref.w + FIG_CLIP_PAD, box.x + px + box.w), y1 = Math.min(ref.y + ref.h + FIG_CLIP_PAD, box.y + py + box.h);
      if ([x0, y0, x1, y1].every(Number.isFinite) && x1 - x0 > 4 && y1 - y0 > 4) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return ref;
  }
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** 글씨 요소의 보드 상자(실제 글자 잉크 + 테두리, textInkBox). 못 재면 null. */
function boxOf(el: SVGTextElement): Box | null {
  return textInkBox(el);
}

/** 이름표 자리 찾기에 쓰는 선 점의 최대 개수. 더 많으면 간격을 넓힌다(QA 2026-11-22: 획 60개 × 2000자에서 수십 초 멈춤). */
const MAX_FIGURE_POINTS = 3000;

/** 그림 선들 위의 점(보드 좌표, 약 6px 간격, 모두 합쳐 MAX_FIGURE_POINTS개까지). 선은 그림 좌표(translate + scale)로 그려져 있다. */
function figurePoints(items: Item[], ox: number, oy: number, scale: number): Pt[] {
  const paths: { path: SVGPathElement; len: number }[] = [];
  for (const it of items) {
    const path = it.node as SVGPathElement | null;
    if (!path || typeof path.getTotalLength !== 'function') continue;
    try {
      const len = path.getTotalLength();
      if (Number.isFinite(len) && len >= 0) paths.push({ path, len });
    } catch {
      // 못 재는 선은 건너뛴다
    }
  }
  const total = paths.reduce((s, p) => s + p.len, 0);
  const step = Math.max(0.5, 6 / scale, total / MAX_FIGURE_POINTS);
  const pts: Pt[] = [];
  for (const { path, len } of paths) {
    try {
      for (let l = 0; l <= len; l += step) {
        const p = path.getPointAtLength(l);
        pts.push([ox + p.x * scale, oy + p.y * scale]);
      }
    } catch {
      // 못 재는 선은 건너뛴다
    }
  }
  return pts;
}

/** 칠한 면의 보드 상자들. */
function fillBoxes(fills: SVGGElement, ox: number, oy: number, scale: number): Box[] {
  const out: Box[] = [];
  for (const p of fills.querySelectorAll('path')) {
    try {
      const b = p.getBBox();
      if (b.width > 0 && b.height > 0) out.push({ x: ox + b.x * scale, y: oy + b.y * scale, w: b.width * scale, h: b.height * scale });
    } catch {
      // 건너뛴다
    }
  }
  return out;
}

/** 요소의 좌표 → 보드 좌표 변환(요소 자신과 조상의 transform을 svg까지 곱한다). 화면 배치와 상관없이 잰다. */
function toBoard(el: SVGGraphicsElement): DOMMatrix | null {
  try {
    let m = new DOMMatrix();
    for (let n: Element | null = el; n && !(n instanceof SVGSVGElement); n = n.parentElement) {
      const t = (n as SVGGraphicsElement).transform?.baseVal?.consolidate?.();
      if (t) {
        const q = t.matrix;
        m = new DOMMatrix([q.a, q.b, q.c, q.d, q.e, q.f]).multiply(m);
      }
    }
    return m;
  } catch {
    return null;
  }
}

/** 요소 상자(보드 좌표, m = toBoard(el)). 못 재면 null. */
function boardBox(el: SVGGraphicsElement, m: DOMMatrix): Box | null {
  try {
    const t = el instanceof SVGTextElement ? textInkBox(el) : null;
    const b = t ? { x: t.x, y: t.y, width: t.w, height: t.h } : el.getBBox();
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || (b.width <= 0 && b.height <= 0)) return null;
    const ps = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
      .map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  } catch {
    return null;
  }
}

/** 보드 좌표 경로들 위의 점(약 6px 간격). 잠깐 parent에 붙여 잰다. */
function pathPoints(parent: SVGGElement, ds: string[]): Pt[] {
  const out: Pt[] = [];
  for (const d of ds) {
    const p = svg('path', { d });
    parent.appendChild(p);
    try {
      const len = p.getTotalLength();
      for (let l = 0; l <= len; l += 6) {
        const q = p.getPointAtLength(l);
        out.push([q.x, q.y]);
      }
    } catch {
      // 건너뛴다
    } finally {
      p.remove();
    }
  }
  return out;
}

/** 판서 묶음과 그 마커 필터 정의를 함께 지운다. */
function removeWithFilter(g: SVGGElement): void {
  const id = /url\(#([^)]+)\)/.exec(g.getAttribute('filter') ?? '')?.[1];
  if (id) g.ownerDocument.getElementById(id)?.remove();
  g.remove();
}

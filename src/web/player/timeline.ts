import type { SayTiming } from '../../shared/lesson';
import type { FigureOp } from '../../shared/script';

export const MS_PER_CHAR_FALLBACK = 180;
/** 글씨·연결·표시의 길이 범위(문장 길이를 무게 비율로 나눈 몫을 여기로 자른다). */
export const MIN_DRAW_MS = 250, MAX_DRAW_MS = 2500;
/**
 * 그림(figure·주문 그림)은 문장 길이가 아니라 획 수로 길이를 정한다(사람 손 속도, 스펙 4.6).
 * 선 하나 ≈ 획 최소 120ms + 펜 들기 80~200ms라 선마다 250ms, 빗금 채우기는 빠르니 150ms.
 * 데모(`?demo=1`, 그림당 6~9초)와 같은 빠르기. 1.5~7.5초로 자르고, 문장보다 길어도 된다.
 */
export const FIGURE_MS_PER_LINE = 250, FIGURE_MS_PER_FILL = 150;
export const MIN_FIGURE_MS = 1500, MAX_FIGURE_MS = 7500;
/**
 * weight: 획 수 또는 글자 수(호출자가 계산). fixedMs: 있으면 몫 대신 이 길이로 그린다(그림) —
 * 문장보다 길어도 되고, 뒤의 순서 판서는 그만큼 밀린다(at 판서는 그대로 자기 시각).
 */
export type DrawReq = { at?: string; weight: number; fixedMs?: number };
export type DrawPlan = { startMs: number; durationMs: number };

const usable = (t: SayTiming | null): t is SayTiming => !!t && t.chars.length > 0;
const clamp = (ms: number) => Math.min(MAX_DRAW_MS, Math.max(MIN_DRAW_MS, ms));

/** 그림 그리는 길이: 선(M마다 따로, 보드와 같은 규칙)·글씨 수와 채우기 수로. */
export function figureDrawMs(fig: Pick<FigureOp, 'strokes' | 'labels'>): number {
  let lines = Array.isArray(fig.labels) ? fig.labels.length : 0;
  let fills = 0;
  for (const s of Array.isArray(fig.strokes) ? fig.strokes : []) {
    const d = typeof s === 'string' ? s : s?.d;
    if (typeof d !== 'string') continue;
    if (typeof s === 'object' && s.fill) {
      fills++;
      continue;
    }
    // board.ts figureItems: 상대 좌표(m 등 소문자)가 없으면 M마다 펜을 드는 따로따로의 획
    lines += /[a-z]/.test(d.replace(/z/g, '')) ? 1 : Math.max(1, d.split(/(?=M)/).filter((p) => p.trim()).length);
  }
  const ms = lines * FIGURE_MS_PER_LINE + fills * FIGURE_MS_PER_FILL;
  return Math.min(MAX_FIGURE_MS, Math.max(MIN_FIGURE_MS, ms));
}

export function speechLengthMs(text: string, timing: SayTiming | null): number {
  if (usable(timing)) return timing.endMs[timing.endMs.length - 1];
  return [...text].length * MS_PER_CHAR_FALLBACK;
}

function anchorMs(text: string, timing: SayTiming | null, at: string | undefined): number | null {
  if (!at) return null;
  if (usable(timing)) {
    // 이어 붙인 문자열의 위치(UTF-16 칸)를 정렬 글자 번호로 바꾼다(이모지·묶인 글자는 한 칸이 아니다).
    const pos = timing.chars.join('').indexOf(at);
    if (pos < 0) return null;
    let off = 0;
    for (let k = 0; k < timing.chars.length; k++) {
      off += String(timing.chars[k]).length;
      if (off > pos) return timing.startMs[k] ?? null;
    }
    return null;
  }
  const i = text.indexOf(at);
  return i < 0 ? null : [...text.slice(0, i)].length * MS_PER_CHAR_FALLBACK; // 길이(speechLengthMs)와 같은 글자 단위
}

export function planDraws(text: string, timing: SayTiming | null, draws: DrawReq[]): DrawPlan[] {
  const total = speechLengthMs(text, timing);
  const anchors = draws.map((d) => anchorMs(text, timing, d.at));
  const seqWeight = draws.reduce((s, d, i) => (anchors[i] === null ? s + Math.max(d.weight, 0) : s), 0);
  let cursor = 0;
  return draws.map((d, i) => {
    const w = Math.max(d.weight, 0);
    const share = seqWeight > 0 ? (total * w) / seqWeight : total;
    const durationMs = d.fixedMs !== undefined ? Math.max(0, d.fixedMs) : clamp(share);
    const a = anchors[i];
    if (a !== null) return { startMs: a, durationMs };
    const startMs = cursor;
    cursor += durationMs;
    return { startMs, durationMs };
  });
}

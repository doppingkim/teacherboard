export type Ink =
  | 'black' | 'blue' | 'red' | 'green' | 'orange' | 'gold' | 'purple'
  | 'pink' | 'brown' | 'sky' | 'navy' | 'gray' | 'lime';
/** 마커 13색. 순서는 프롬프트·팔레트에서 보여 주는 순서. */
export const INKS: readonly Ink[] = [
  'black', 'blue', 'red', 'green', 'orange', 'gold', 'purple', 'pink', 'brown', 'sky', 'navy', 'gray', 'lime',
];
export type Label = { x: number; y: number; text: string; ink?: Ink };
/** 획 하나: 경로 문자열(그림 색), 또는 획별 색·채우기가 있는 객체. */
/** arrow: 이 선의 끝에 화살촉을 프로그램이 붙인다(끝의 진행 방향 그대로 — 화가가 촉을 거꾸로 그리는 일 방지). */
export type Stroke = string | { d: string; ink?: Ink; fill?: boolean; arrow?: boolean };
export type FigureOp = { kind: 'figure'; id?: string; size: 'small' | 'wide'; ink: Ink; strokes: Stroke[]; labels?: Label[] };
export type TextOp = { kind: 'text'; id?: string; role: 'title' | 'note'; text: string; ink: Ink };
export type ConnectOp = { kind: 'connect'; from: string; to: string; ink: Ink; label?: string };
export type MarkStyle = 'underline' | 'double' | 'wavy' | 'circle' | 'box' | 'star' | 'pigtail' | 'check' | 'exclaim';
/** 선생님 표시: target(그림·글씨 id)에, word가 있으면 그 글자 위에. */
export type MarkOp = { kind: 'mark'; target: string; word?: string; style: MarkStyle; ink: Ink };
/** 미리 주문한 그림을 보여 주기. size는 같은 id 주문에서 파서가 채운다. */
export type SketchShowOp = { kind: 'sketch'; id: string; size: 'small' | 'wide' };
/** 화가에게 보내는 그림 주문. */
export type SketchOrder = { id: string; size: 'small' | 'wide'; describe: string };
/** 예전 대본의 `highlight`는 파싱 시 MarkOp로 바뀐다. */
export type DrawOp = FigureOp | TextOp | ConnectOp | MarkOp | SketchShowOp;
export type ScriptEvent =
  | { t: 'say'; id: number; text: string }
  | { t: 'draw'; sayId: number; at?: string; op: DrawOp }
  | { t: 'page' }
  | { t: 'sketch'; order: SketchOrder }
  /** 수업 끝에 보여 줄 "이어 물을 질문"(E2). 1~NEXT_MAX개, 각 NEXT_MIN_CHARS~NEXT_MAX_CHARS자. */
  | { t: 'next'; questions: string[] };
/** 수업 하나의 파서 상태. sketches: 받아들인 주문 id → size. next: 이어 물을 질문 줄을 이미 받았다. */
export type ParseState = { lastSayId: number; sketches: Map<string, 'small' | 'wide'>; next?: boolean };
export type Profile = 'kid' | 'adult'; // 서버·브라우저 공용

export const createParseState = (): ParseState => ({ lastSayId: 0, sketches: new Map() });

const MARK_STYLES: readonly string[] = ['underline', 'double', 'wavy', 'circle', 'box', 'star', 'pigtail', 'check', 'exclaim'];
const PATH_RE = /^[MLQCZmlqcz0-9 .,\-]+$/;
const MIN = -5;
const MAX = 105;
const MAX_STROKES = 60;
const MAX_SKETCHES = 5;
/** 그림 하나의 이름표 최대 개수(프롬프트는 1~4개). 넘으면 획 수 초과처럼 그림을 버린다. */
const MAX_LABELS = 12;
/** 이어 물을 질문: 카드 수, 한 질문 글자 수(카드 두 줄에 들어가게), 모델이 폭주한 배열은 통째로 버린다. */
export const NEXT_MAX = 3;
export const NEXT_MIN_CHARS = 3;
export const NEXT_MAX_CHARS = 40;
const NEXT_RAW_MAX = 20;
/**
 * 카드에 그대로 보이는 글이라 줄바꿈·마크업 글자·주소처럼 보이는 것은 받지 않는다(질문 말투만).
 * 줄·문단 구분자(U+2028·2029), 글 방향을 바꾸는 글자(U+202A~202E·2066~2069), 폭 없는 글자(U+200B~200F·2060·FEFF)도
 * 카드 글을 나누거나 뒤집거나 빈 카드처럼 보이게 하니 뺀다.
 */
const NEXT_BAD_RE = /[\u0000-\u001f\u007f<>{}[\]\\`\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]|https?:|www\.|@/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
/** 말·글씨 본문: 공백만 있는 값은 읽을 것도 그릴 것도 없으니 버린다(공백 say는 TTS 호출만 낭비). */
const isContent = (v: unknown, max: number): v is string => isStr(v, max) && v.trim().length > 0;
const isInk = (v: unknown): v is Ink => typeof v === 'string' && (INKS as readonly string[]).includes(v);
/** 모르는 색(또는 없는 색)은 판서를 버리지 않고 검정으로. */
const toInk = (v: unknown): Ink => (isInk(v) ? v : 'black');
const isSize = (v: unknown): v is 'small' | 'wide' => v === 'small' || v === 'wide';
const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN && v <= MAX;

const TOKEN_RE = /[MLQCZmlqcz]|-?\d*\.?\d+/g;
const ARGS: Record<string, number> = { m: 2, l: 2, q: 4, c: 6, z: 0 };

/**
 * 경로 검사: 허용 글자, 길이, 그리고 모든 점이 상자(MIN~MAX) 안인지.
 * 소문자(상대) 명령은 숫자 하나하나가 작아도 쌓이면 상자 밖으로 나가므로, 펜 위치를 따라가며 절대 위치로 검사한다.
 */
function validPath(d: unknown): d is string {
  if (typeof d !== 'string' || d.length > 2000 || !PATH_RE.test(d)) return false;
  const toks = d.match(TOKEN_RE) ?? [];
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0; // 지금 펜 위치, 하위 경로 시작점
  let seg: number[] = [];
  for (const t of toks) {
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      seg = [];
      if (cmd === 'Z' || cmd === 'z') { cx = sx; cy = sy; }
      continue;
    }
    const v = Number(t);
    const lower = cmd.toLowerCase();
    const rel = cmd !== '' && cmd === lower && lower !== 'z';
    const abs = rel ? v + (seg.length % 2 === 0 ? cx : cy) : v;
    if (!inRange(abs)) return false;
    seg.push(abs);
    const need = ARGS[lower] ?? 0;
    if (need > 0 && seg.length === need) {
      cx = seg[need - 2];
      cy = seg[need - 1];
      if (lower === 'm') { sx = cx; sy = cy; cmd = cmd === 'm' ? 'l' : 'L'; } // M 뒤의 좌표 쌍은 L
      seg = [];
    }
  }
  return true;
}

/** 획 검증 + 정리(모르는 필드는 버림). 잘못된 획 → null. */
function parseStroke(s: unknown): Stroke | null {
  if (typeof s === 'string') return validPath(s) ? s : null;
  if (!isObj(s) || !validPath(s.d)) return null;
  if (s.fill !== undefined && typeof s.fill !== 'boolean') return null;
  if (s.arrow !== undefined && typeof s.arrow !== 'boolean') return null;
  const out: { d: string; ink?: Ink; fill?: boolean; arrow?: boolean } = { d: s.d };
  if (s.ink !== undefined) out.ink = toInk(s.ink);
  if (s.fill !== undefined) out.fill = s.fill as boolean;
  if (s.arrow === true && s.fill !== true) out.arrow = true;
  return out;
}

function parseLabel(l: unknown): Label | null {
  if (!isObj(l) || !inRange(l.x) || !inRange(l.y) || !isStr(l.text, 60)) return null;
  const out: Label = { x: l.x, y: l.y, text: l.text };
  if (l.ink !== undefined) out.ink = toInk(l.ink);
  return out;
}

/** 그림 하나를 검증해 정리된 FigureOp로. 대본 줄과 화가 출력 모두 이것으로 검사한다. */
export function parseFigure(o: unknown): FigureOp | null {
  if (!isObj(o) || o.kind !== 'figure' || !isSize(o.size)) return null;
  if (o.id !== undefined && !isStr(o.id, 60)) return null;
  if (!Array.isArray(o.strokes) || o.strokes.length === 0 || o.strokes.length > MAX_STROKES) return null;
  const strokes: Stroke[] = [];
  for (const s of o.strokes) {
    const st = parseStroke(s);
    if (st === null) return null;
    strokes.push(st);
  }
  const fig: FigureOp = { kind: 'figure', size: o.size, ink: toInk(o.ink), strokes };
  if (o.id !== undefined) fig.id = o.id;
  if (o.labels !== undefined) {
    if (!Array.isArray(o.labels) || o.labels.length > MAX_LABELS) return null;
    const labels: Label[] = [];
    for (const l of o.labels) {
      const lb = parseLabel(l);
      if (lb === null) return null;
      labels.push(lb);
    }
    fig.labels = labels;
  }
  return fig;
}

function parseOp(o: unknown, state: ParseState): DrawOp | null {
  if (!isObj(o)) return null;
  switch (o.kind) {
    case 'figure':
      return parseFigure(o);
    case 'text': {
      if (o.role !== 'title' && o.role !== 'note') return null;
      if (o.id !== undefined && !isStr(o.id, 60)) return null;
      if (!isContent(o.text, 60)) return null;
      const op: TextOp = { kind: 'text', role: o.role, text: o.text, ink: toInk(o.ink) };
      if (o.id !== undefined) op.id = o.id;
      return op;
    }
    case 'connect': {
      if (!isStr(o.from, 60) || !isStr(o.to, 60)) return null;
      if (o.label !== undefined && !isStr(o.label, 60)) return null;
      const op: ConnectOp = { kind: 'connect', from: o.from, to: o.to, ink: toInk(o.ink) };
      if (o.label !== undefined) op.label = o.label;
      return op;
    }
    case 'mark':
    case 'highlight': {
      // 예전 대본의 highlight(circle/underline/box)는 같은 모양의 mark로 바꾼다.
      if (!isStr(o.target, 60)) return null;
      if (typeof o.style !== 'string' || !MARK_STYLES.includes(o.style)) return null;
      if (o.word !== undefined && !isContent(o.word, 60)) return null;
      const op: MarkOp = { kind: 'mark', target: o.target, style: o.style as MarkStyle, ink: toInk(o.ink) };
      if (o.word !== undefined) op.word = o.word;
      return op;
    }
    case 'sketch': {
      if (!isStr(o.id, 60)) return null;
      const size = state.sketches.get(o.id);
      return size ? { kind: 'sketch', id: o.id, size } : null; // 주문 없는 보여 주기는 버린다
    }
    default:
      return null;
  }
}

/** 그림 주문. 수업당 MAX_SKETCHES개까지, 같은 id는 한 번만. 받아들이면 state에 기억한다. */
function parseOrder(o: unknown, state: ParseState): SketchOrder | null {
  if (!isObj(o) || !isStr(o.id, 60) || !isSize(o.size) || !isContent(o.describe, 150)) return null;
  if (state.sketches.size >= MAX_SKETCHES || state.sketches.has(o.id)) return null;
  state.sketches.set(o.id, o.size);
  return { id: o.id, size: o.size, describe: o.describe };
}

/**
 * 이어 물을 질문 줄: 배열 속 쓸 만한 질문만(앞뒤 공백을 떼고, 같은 것은 한 번) 앞에서 NEXT_MAX개. 하나도 없으면 null.
 * 내용의 안전(아이에게 맞는 주제)은 프롬프트가 맡고, 여기서는 카드에 보일 글의 모양만 지킨다.
 */
function parseNext(v: unknown, state: ParseState): string[] | null {
  if (state.next || !Array.isArray(v) || v.length === 0 || v.length > NEXT_RAW_MAX) return null;
  const out: string[] = [];
  for (const q of v) {
    if (typeof q !== 'string') continue;
    const t = q.trim();
    const n = [...t].length;
    // 줄바꿈·탭 같은 제어 글자는 다듬어 잇지 않고 그 질문을 뺀다(NEXT_BAD_RE).
    if (n < NEXT_MIN_CHARS || n > NEXT_MAX_CHARS || NEXT_BAD_RE.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= NEXT_MAX) break;
  }
  if (out.length === 0) return null;
  state.next = true;
  return out;
}

/** 대본 한 줄을 검증해 이벤트로 변환한다. 잘못된 줄은 null (state는 변하지 않음). */
export function parseScriptLine(line: string, state: ParseState): ScriptEvent | null {
  let raw: unknown;
  // 모델이 JSON 배열처럼 줄 끝에 쉼표를 붙이거나(`{...},`) 첫 줄에 BOM을 붙여도 그 줄을 살린다.
  const text = line.trim().replace(/,$/, ''); // trim은 BOM(U+FEFF)도 지운다
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;

  if ('say' in raw) {
    if (!isContent(raw.say, 200)) return null;
    state.lastSayId += 1;
    return { t: 'say', id: state.lastSayId, text: raw.say };
  }
  if ('draw' in raw) {
    if (raw.at !== undefined && !isStr(raw.at, 60)) return null;
    const op = parseOp(raw.draw, state);
    if (!op) return null;
    const ev: ScriptEvent = { t: 'draw', sayId: state.lastSayId, op };
    if (raw.at !== undefined) ev.at = raw.at as string;
    return ev;
  }
  if ('sketch' in raw) {
    const order = parseOrder(raw.sketch, state);
    return order ? { t: 'sketch', order } : null;
  }
  if (raw.page === true) return { t: 'page' };
  if ('next' in raw) {
    const questions = parseNext(raw.next, state);
    return questions ? { t: 'next', questions } : null;
  }
  return null;
}

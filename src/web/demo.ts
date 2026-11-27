// 고정 판서 데모(`?demo=1`): 서버·API 키 없이 보드만 확인한다.
// 1쪽: 제목(한 글자씩) → 여러 색 그림 2개(채우기 포함, 화가 예시 그대로) → connect → 낱말 표시들 → 정리 글씨 → 표시
// 2쪽: 지우개로 넘긴 뒤 넓은 그림(성, 빗금 채우기 여러 개)과 네모 표시.
// `?fps=1`을 함께 주면 구석에 FPS가 뜬다.
import { Board } from './board/board';
import { Layout } from './board/layout';
import type { DrawOp, FigureOp } from '../shared/script';

const circle = (cx: number, cy: number, r: number) => {
  const k = Math.round(r * 0.55);
  return `M${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} Z`;
};

// src/server/artist.ts ARTIST_EXAMPLES의 강아지·지구와 달·성(획 순서: 윤곽 → 세부 → 무늬 → 채우기)
const DOG_BODY = 'M22 56 C22 49 33 44 46 44 C59 44 70 49 70 56 C70 63 59 68 46 68 C33 68 22 63 22 56 Z';
const DOG_HEAD = circle(76, 40, 12);
const DOG_EAR = 'M68 31 C62 32 60 42 64 47 C67 44 69 38 70 32 Z';
const DOG: FigureOp = {
  kind: 'figure', id: '강아지', size: 'small', ink: 'black',
  strokes: [
    { d: DOG_BODY, ink: 'brown' },
    { d: DOG_HEAD, ink: 'brown' },
    { d: 'M84 42 C90 41 94 44 93 48 C92 51 87 52 83 50', ink: 'brown' },
    { d: DOG_EAR, ink: 'brown' },
    { d: 'M28 64 L28 84 L34 84 L34 67 M38 67 L38 84 L44 84 L44 68 M54 68 L54 84 L60 84 L60 67 M62 66 L63 84 L69 84 L67 60', ink: 'brown' },
    { d: 'M23 52 Q12 44 14 30', ink: 'brown' },
    { d: 'M79 37 L79 39', ink: 'black' },
    { d: 'M91 44 L94 46 L91 48 Z', ink: 'black' },
    { d: 'M85 50 Q88 53 91 50', ink: 'black' },
    { d: 'M87 52 C87 56 91 56 91 52 Z', ink: 'pink' },
    { d: 'M64 46 Q68 52 72 52', ink: 'red' },
    { d: 'M67 55 C67 54 68 53 69 53 C70 53 71 54 71 55 C71 56 70 57 69 57 C68 57 67 56 67 55 Z', ink: 'gold' },
    { d: 'M32 52 Q37 48 42 52 Q37 56 32 52 Z M50 50 Q53 47 56 50 Q53 53 50 50 Z', ink: 'black' },
    { d: 'M8 34 Q6 38 8 42 M11 25 Q7 27 7 31', ink: 'gray' },
    { d: 'M10 86 Q50 83 92 86', ink: 'green' },
    { d: 'M16 86 L18 82 L20 86 M78 86 L80 82 L82 86', ink: 'lime' },
    { d: DOG_BODY, ink: 'brown', fill: true },
    { d: DOG_HEAD, ink: 'brown', fill: true },
    { d: DOG_EAR, ink: 'brown', fill: true },
  ],
  labels: [{ x: 50, y: 97, text: '걸어가는 나', ink: 'brown' }],
};

const EARTH = circle(45, 52, 20);
const CONTINENT_A = 'M33 40 C38 36 45 38 44 44 C43 49 36 50 38 56 C39 60 33 61 30 56 C28 50 29 44 33 40 Z';
const CONTINENT_B = 'M50 50 C55 46 62 49 61 55 C60 61 55 66 50 63 C47 60 47 54 50 50 Z';
const MOON = circle(75, 32, 7);
const EARTH_MOON: FigureOp = {
  kind: 'figure', id: '지구와 달', size: 'small', ink: 'black',
  strokes: [
    { d: EARTH, ink: 'blue' },
    { d: CONTINENT_A, ink: 'green' },
    { d: CONTINENT_B, ink: 'green' },
    { d: MOON, ink: 'gray' },
    { d: 'M3 52 C3 37 22 24 45 24 C68 24 87 37 87 52 C87 67 68 80 45 80 C22 80 3 67 3 52 Z', ink: 'gray' },
    { d: 'M26 21 L32 25 L26 29', ink: 'orange' },
    { d: 'M71 30 C71 29 72 28 73 28 C74 28 75 29 75 30 C75 31 74 32 73 32 C72 32 71 31 71 30 Z M77 35 Q78 33 79 35 Q78 37 77 35 Z', ink: 'gray' },
    { d: 'M36 36 Q45 33 54 36 M52 41 Q56 38 59 42 M31 64 Q35 67 40 66', ink: 'sky' },
    { d: 'M12 9 L12 17 M8 13 L16 13 M88 68 L88 74 M85 71 L91 71 M18 86 L18 92 M15 89 L21 89', ink: 'gold' },
    { d: EARTH, ink: 'blue', fill: true },
    { d: CONTINENT_A, ink: 'green', fill: true },
    { d: CONTINENT_B, ink: 'green', fill: true },
    { d: MOON, ink: 'gold', fill: true },
  ],
  labels: [
    { x: 45, y: 90, text: '지구', ink: 'blue' },
    { x: 90, y: 20, text: '달', ink: 'gray' },
  ],
};

const CASTLE_WALL = 'M22 36 L22 19 L78 19 L78 36 Z';
const CASTLE_TOWER_L = 'M8 36 L8 14 L22 14 L22 36 Z';
const CASTLE_TOWER_R = 'M78 36 L78 14 L92 14 L92 36 Z';
const CASTLE_ROOF_L = 'M6 14 L15 5 L24 14 Z';
const CASTLE_ROOF_R = 'M76 14 L85 5 L94 14 Z';
const CASTLE_GATE = 'M45 36 L45 28 C45 23 55 23 55 28 L55 36 Z';
const CASTLE: FigureOp = {
  kind: 'figure', id: '성', size: 'wide', ink: 'black',
  strokes: [
    { d: CASTLE_TOWER_L, ink: 'gray' },
    { d: CASTLE_TOWER_R, ink: 'gray' },
    { d: CASTLE_ROOF_L, ink: 'red' },
    { d: CASTLE_ROOF_R, ink: 'red' },
    { d: CASTLE_WALL, ink: 'gray' },
    { d: 'M40 19 L40 11 L60 11 L60 19', ink: 'gray' },
    { d: CASTLE_GATE, ink: 'brown' },
    { d: 'M24 19 L24 16 L28 16 L28 19 M32 19 L32 16 L36 16 L36 19 M64 19 L64 16 L68 16 L68 19 M72 19 L72 16 L76 16 L76 19', ink: 'gray' },
    { d: 'M40 11 L40 8 L44 8 L44 11 M48 11 L48 8 L52 8 L52 11 M56 11 L56 8 L60 8 L60 11', ink: 'gray' },
    { d: 'M13 25 L13 21 Q15 18 17 21 L17 25 Z M83 25 L83 21 Q85 18 87 21 L87 25 Z M48 17 L48 14 Q50 12 52 14 L52 17 Z', ink: 'navy' },
    { d: 'M15 5 L15 0 L21 2 L15 4 M85 5 L85 0 L91 2 L85 4', ink: 'red' },
    { d: 'M50 8 L50 1 L57 3 L50 5', ink: 'gold' },
    { d: 'M47 25 L47 36 M50 24 L50 36 M53 25 L53 36 M45 30 L55 30', ink: 'black' },
    { d: 'M26 24 L32 24 M36 24 L42 24 M58 24 L64 24 M68 24 L74 24 M30 30 L36 30 M64 30 L70 30 M11 30 L17 30 M83 30 L89 30', ink: 'gray' },
    { d: 'M0 36 Q25 34 50 36 Q75 37 100 35', ink: 'green' },
    { d: CASTLE_TOWER_L, ink: 'gray', fill: true },
    { d: CASTLE_TOWER_R, ink: 'gray', fill: true },
    { d: CASTLE_WALL, ink: 'gray', fill: true },
    { d: CASTLE_ROOF_L, ink: 'red', fill: true },
    { d: CASTLE_ROOF_R, ink: 'red', fill: true },
    { d: CASTLE_GATE, ink: 'brown', fill: true },
  ],
  labels: [],
};

type Step = { say?: string; op: DrawOp; ms: number; pause?: number };

const STEPS: Step[] = [
  { say: '자, 오늘의 질문! 달은 왜 나를 따라올까?', op: { kind: 'text', id: 't1', role: 'title', text: '달은 왜 나를 따라올까?', ink: 'navy' }, ms: 2600 },
  { say: '내가 강아지처럼 길을 걸어가면…', op: DOG, ms: 6500 },
  { say: '저~ 멀리에는 지구 둘레를 도는 달이 있어.', op: EARTH_MOON, ms: 6000 },
  { say: '달은 너무너무 멀어.', op: { kind: 'connect', from: '강아지', to: '지구와 달', ink: 'blue', label: '엄~청 멀다!' }, ms: 1800 },
  { say: '바로 이 달!', op: { kind: 'mark', target: 't1', word: '달은', style: 'circle', ink: 'red' }, ms: 600, pause: 250 },
  { say: '왜 따라오는 걸까?', op: { kind: 'mark', target: 't1', word: '따라올까?', style: 'underline', ink: 'red' }, ms: 500, pause: 250 },
  { say: '나를!', op: { kind: 'mark', target: 't1', word: '나를', style: 'pigtail', ink: 'green' }, ms: 600, pause: 250 },
  { op: { kind: 'mark', target: 't1', style: 'star', ink: 'gold' }, ms: 500 },
  { say: '멀리 있을수록 천천히 움직여 보이거든!', op: { kind: 'text', id: 'n1', role: 'note', text: '멀리 있을수록 천천히 움직여 보여!', ink: 'green' }, ms: 3000 },
  { say: '천천히!', op: { kind: 'mark', target: 'n1', word: '천천히', style: 'circle', ink: 'red' }, ms: 600, pause: 250 },
  { op: { kind: 'mark', target: 'n1', style: 'exclaim', ink: 'orange' }, ms: 500 },
  { say: '그래서 달이 나를 졸졸 따라오는 것 같은 거야.', op: { kind: 'text', id: 'n2', role: 'note', text: '그래서 달이 따라오는 것 같아', ink: 'purple' }, ms: 2600 },
  { say: '달이,', op: { kind: 'mark', target: 'n2', word: '달이', style: 'double', ink: 'blue' }, ms: 600, pause: 250 },
  { say: '따라오는 것 같아!', op: { kind: 'mark', target: 'n2', word: '따라오는', style: 'wavy', ink: 'red' }, ms: 600, pause: 250 },
  { say: '알겠지?', op: { kind: 'mark', target: 'n2', style: 'check', ink: 'green' }, ms: 500, pause: 1600 },
  // 2쪽: 제목이 또 오면 새 페이지(지우개)
  { say: '하나 더! 옛날 성은 어떻게 생겼을까?', op: { kind: 'text', id: 't2', role: 'title', text: '옛날 성은 어떻게 생겼을까?', ink: 'black' }, ms: 2600 },
  { say: '탑 두 개, 뾰족 지붕, 가운데 성문!', op: CASTLE, ms: 9000 },
  { say: '여기가 바로 성!', op: { kind: 'mark', target: 't2', word: '성은', style: 'box', ink: 'blue' }, ms: 600 },
];

export async function runDemo(host: HTMLElement): Promise<void> {
  const board = new Board(host);
  const layout = new Layout();
  const signal = new AbortController().signal;
  for (const s of STEPS) {
    if (s.say) board.setSubtitle(s.say);
    const op = s.op;
    if (op.kind === 'figure' || op.kind === 'text') {
      const place = layout.place(op);
      if (!place) continue;
      if (place.newPage) await board.wipe(signal);
      await board.draw(op, place, s.ms, signal);
    } else if (op.kind === 'connect' || op.kind === 'mark') {
      const ids = op.kind === 'connect' ? [op.from, op.to] : [op.target];
      const refs = ids.map((id) => layout.rectOf(id));
      if (refs.some((r) => !r)) continue;
      await board.draw(op, { refs: refs as NonNullable<(typeof refs)[number]>[] }, s.ms, signal);
    }
    await new Promise((r) => setTimeout(r, s.pause ?? 450));
  }
  board.setSubtitle('또 궁금한 거 있어?');
}

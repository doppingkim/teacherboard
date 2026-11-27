import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { INKS, parseFigure, type FigureOp, type SketchOrder } from '../shared/script';
import { blockedReason, getGemini, hitMaxTokens, modelFor, thinkingFor, type GenAI } from './gemini';
import { usageFrom, type ModelUsage } from './telemetry';

/** 주문 하나를 기다리는 최대 시간. 넘기면 그 그림은 null(수업은 계속). Gemini 3.8 Flash 실측 7~12초라 20초. */
export const ARTIST_TIMEOUT_MS = 20_000;
/** 같은 주문 캐시의 최대 개수(넘으면 가장 오래 안 쓴 것부터 버린다). */
export const ARTIST_CACHE_MAX = 200;
// 모델: Gemini 3.8 Flash(생각 low). ARTIST_MODEL·ARTIST_THINKING으로 바꿀 수 있다(gemini.ts).

type Example = { describe: string; size: 'small' | 'wide'; figure: Record<string, unknown> };

const circle = (cx: number, cy: number, r: number) => {
  const k = Math.round(r * 0.55);
  return `M${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} Z`;
};

const DROP = 'M50 25 C42 38 38 48 38 55 C38 64 44 70 50 70 C56 70 62 64 62 55 C62 48 58 38 50 25 Z';
const CAR = 'M2 30 L2 24 L6 20 L16 20 L20 24 L22 24 L22 30 Z';
const FAR_MOON = circle(90, 9, 4);
const POT_WATER = 'M22 55 Q35 52 50 55 Q65 58 78 55 L78 80 Q78 83 75 83 L25 83 Q22 83 22 80 Z';

/**
 * 프롬프트에 넣는 좋은 그림 예시: 꾸밈 없이 원리가 한눈에 보이는 설명 그림(2026-11-22 사용자 요청:
 * "요소 하나하나 잘 그리기보다 이해가 쏙쏙 되는 그림"). 테스트가 모두 parseFigure를 통과하는지 확인한다.
 */
export const ARTIST_EXAMPLES: readonly Example[] = [
  {
    describe: '가까운 나무는 휙휙(긴 화살표), 먼 산은 느릿느릿(짧은 화살표), 아주 먼 달은 그대로 보이는 것을 차 탄 아이 쪽에서부터 나란히 비교',
    size: 'wide',
    figure: {
      kind: 'figure', id: '거리 비교', size: 'wide', ink: 'black',
      strokes: [
        // 1) 비교할 것들을 왼쪽(가까움) → 오른쪽(멂) 순서로, 알아볼 만큼만 간단히
        { d: CAR, ink: 'red' },
        { d: 'M5 31 L9 31 M15 31 L19 31', ink: 'black' },
        { d: 'M7 21 L9 24 L15 24 L15 21', ink: 'sky' },
        { d: 'M33 32 L33 24', ink: 'brown' },
        { d: circle(33, 19, 5), ink: 'green' },
        { d: 'M50 32 L58 18 L66 32', ink: 'green' },
        { d: FAR_MOON, ink: 'gold' },
        { d: 'M24 32 L72 32', ink: 'gray' },
        // 2) 핵심: 움직임의 크기를 화살표 길이로
        { d: 'M26 35 L41 35', ink: 'red', arrow: true },
        { d: 'M55 35 L61 35', ink: 'orange', arrow: true },
        // 3) 채우기는 마지막
        { d: CAR, ink: 'red', fill: true },
        { d: FAR_MOON, ink: 'gold', fill: true },
      ],
      labels: [
        { x: 33, y: 9, text: '휙휙', ink: 'red' },
        { x: 58, y: 12, text: '느릿느릿', ink: 'orange' },
        { x: 90, y: 22, text: '그대로', ink: 'navy' },
      ],
    },
  },
  {
    describe: '햇빛 화살표가 물방울 하나로 들어가 꺾여 나오면서 빨강·주황·노랑·초록·파랑·보라로 갈라지는 그림',
    size: 'small',
    figure: {
      kind: 'figure', id: '물방울 무지개', size: 'small', ink: 'black',
      strokes: [
        // 1) 들어오는 햇빛 → 물방울
        { d: 'M5 30 L38 45', ink: 'gold', arrow: true },
        { d: DROP, ink: 'blue' },
        // 2) 핵심: 나오는 빛이 색깔별로 갈라진다
        { d: 'M60 60 L92 70', ink: 'red' },
        { d: 'M60 61 L91 76', ink: 'orange' },
        { d: 'M59 62 L89 82', ink: 'gold' },
        { d: 'M58 63 L86 87', ink: 'green' },
        { d: 'M57 64 L82 92', ink: 'blue' },
        { d: 'M56 65 L77 95', ink: 'purple' },
        // 3) 채우기
        { d: DROP, ink: 'sky', fill: true },
      ],
      labels: [
        { x: 12, y: 22, text: '햇빛', ink: 'gold' },
        { x: 50, y: 16, text: '물방울', ink: 'blue' },
        { x: 80, y: 52, text: '색이 나뉨', ink: 'red' },
      ],
    },
  },
  {
    describe: '불 위 냄비 속 물이 끓어 거품이 생기고, 수증기가 구불구불 화살표로 위로 올라가는 그림',
    size: 'small',
    figure: {
      kind: 'figure', id: '끓는 물', size: 'small', ink: 'black',
      strokes: [
        // 1) 냄비와 물(간단한 윤곽)
        { d: 'M20 45 L20 80 Q20 85 25 85 L75 85 Q80 85 80 80 L80 45', ink: 'gray' },
        { d: 'M20 50 L12 50 M80 50 L88 50', ink: 'gray' },
        { d: 'M22 55 Q35 52 50 55 Q65 58 78 55', ink: 'blue' },
        // 2) 원인: 아래의 불 → 결과: 거품, 위로 올라가는 수증기
        { d: 'M35 96 Q38 88 41 96 M47 96 Q50 86 53 96 M59 96 Q62 88 65 96', ink: 'orange' },
        { d: `${circle(39, 70, 4)} ${circle(59, 65, 3)}`, ink: 'sky' },
        { d: 'M38 42 Q34 33 38 25 Q42 17 38 9', ink: 'red', arrow: true },
        { d: 'M62 42 Q58 33 62 25 Q66 17 62 9', ink: 'red', arrow: true },
        // 3) 채우기
        { d: POT_WATER, ink: 'blue', fill: true },
      ],
      labels: [
        { x: 84, y: 22, text: '수증기', ink: 'red' },
        { x: 88, y: 93, text: '불', ink: 'orange' },
      ],
    },
  },
];

/**
 * 설명 그림을 선(좌표)으로 그리는 규칙. 화가 프롬프트와 '신중한 선생님' 모드 선생님 프롬프트가 함께 쓴다.
 * 그 안의 "주문"은 신중한 선생님 모드에서는 선생님 자신의 계획이다.
 */
export const DRAWING_RULES = `# 가장 중요한 규칙: 예쁜 그림보다, 이해가 쏙 되는 설명 그림
- 선생님이 칠판에 빠르게 그리는 설명 그림이야. 물체 하나하나를 잘 그리는 것보다, 보자마자 "아, 그래서 그렇구나!" 하고 원리가 보이는 게 훨씬 중요해.
- 주문이 말하는 비교·움직임·원인과 결과를 그림의 짜임으로 보여 줘:
  - 나란히 비교: 크기·거리·빠르기·개수를 같은 줄에 놓고 차이가 눈에 띄게(길이, 크기, 개수로).
  - 전 → 후, 원인 → 결과: 왼쪽에서 오른쪽으로, 사이에 화살표.
  - 속을 잘라 보기(단면), 흐름(물·빛·공기·힘이 어디로 가는지)은 화살표로.
- 화살표는 마음껏 써. 화살표는 몸통 선 하나만 그리고 "arrow": true를 붙여: 프로그램이 선이 끝나는 쪽에 화살촉을 정확한 방향으로 달아 줘.
  - 선은 반드시 '출발 → 도착' 순서로 그려(M이 출발, 마지막 점이 도착). 화살촉은 마지막 점에 달려.
  - 화살촉(V자)을 직접 그리지 마. 두 번 달리거나 거꾸로 보여.
  - 예: 왼쪽에서 오른쪽으로 가는 화살표 {"d":"M26 35 L41 35","ink":"red","arrow":true}, 위로 올라가는 구불구불 화살표 {"d":"M38 42 Q34 33 38 25 Q42 17 38 9","ink":"red","arrow":true}
- 주문의 방향을 정확히 지켜: 빛·물·공기·힘·움직임이 어디서 어디로 가는지 확인하고 그대로 그려. 원인 → 결과, 전 → 후도 같은 방향으로.
- 물체는 알아볼 만큼만 간단히: 특징 2~3개면 충분해(나무 = 줄기 + 둥근 잎 덩어리, 차 = 몸통 + 바퀴 + 창, 사람 = 동그란 머리 + 간단한 몸과 팔다리, 해 = 동그라미 + 빛살).
- 털·비늘·벽돌·풀잎·잔무늬·장식 배경은 그리지 마. 설명에 필요 없는 것은 비워 둬. 주문에 없는 것은 그리지 마.
- 글자나 숫자를 획으로 쓰지 마. 이름은 labels로.

# 구도
- 비교·순서가 있으면 왼쪽 → 오른쪽(가까운 것 → 먼 것, 전 → 후)으로 나란히, 서로 겹치지 않게.
- 상자를 넉넉히 써서 크게 그려. 가장자리는 3~5만 비워.
- 이름표 자리를 남겨 둬: 그림과 겹치지 않는 빈 곳.

# 획 순서: 사람이 그리는 순서 그대로
strokes 배열 순서대로 한 획씩 그려지는 모습을 사람들이 보게 돼. 그러니 실제 선생님이 그리는 순서로 내:
1. 등장하는 것들의 간단한 윤곽(비교 순서대로, 왼쪽부터)
2. 핵심: 화살표·차이를 보여 주는 선(이게 설명의 알맹이야)
3. 채우기(fill:true) 획은 맨 마지막에 몰아서

# 색: 13색 마커
${INKS.join(', ')} (gold는 노랑 대신 쓰는 진한 노랑)
- 색은 뜻이 있게 써: 비교하는 두 쪽은 서로 다른 색, 핵심 화살표는 눈에 띄는 색(red, orange), 뜨거움 red/orange, 차가움·물 blue/sky, 식물 green, 해·빛 gold.
- 보통 3~5색이면 충분해. 모든 획을 검정으로 그리지 마.
- 맨 위 "ink"는 그림의 기본색(보통 black). 획에는 모두 "ink"를 적어.

# 채우기(fill)
- "fill": true인 획은 반드시 Z로 닫힌 경로여야 해. 그 도형 안을 같은 색으로 옅게(약 25%) 칠해. 선이 다 그려진 뒤 칠해져.
- 칠하기는 0~3개, 설명에 도움이 될 때만(물, 비교하는 두 영역, 중심 물체). 작은 세부나 열린 선은 칠하지 마.
- 채우기 획은 이미 그린 닫힌 윤곽 경로를 똑같이 한 번 더 써서 맨 끝에 둬(예시처럼).
- 칠하지 않는 획에는 "fill"을 아예 적지 마(예시처럼). 적은 글자가 적을수록 그림이 빨리 나와.

# 좌표와 경로 규칙(어기면 그림이 통째로 버려져)
- "size": "small"은 가로·세로 모두 0~100인 정사각형 상자, "wide"는 가로 x 0~100, 세로 y 0~37인 납작하고 넓은 상자야. 주문에 적힌 크기를 그대로 써. 왼쪽 위가 0,0이고 y는 아래로 커져. wide에서는 y가 37을 넘지 않게, 물체를 납작한 상자에 맞춰 작게 그리고 옆으로 펼쳐.
- "d"는 SVG path 문자열이고 M, L, Q, C, Z 명령만 써. H, V, A, S, T 같은 다른 명령, 소수점, 다른 글자는 금지. 숫자는 정수만, 숫자 사이는 공백으로 띄워.
- 모든 숫자는 0~100 안(상자 밖으로 나가지 마). 대문자(절대 좌표)만 써.
- 동그라미는 C 곡선 네 개로: 중심 (50,50) 반지름 20 → "M30 50 C30 39 39 30 50 30 C61 30 70 39 70 50 C70 61 61 70 50 70 C39 70 30 61 30 50 Z" (조절점은 반지름의 약 0.55만큼 떨어져). 타원도 같은 방식으로 가로·세로 반지름만 다르게.
- 작은 점(눈동자 등)은 길이 2짜리 짧은 선으로("M46 29 L46 31").
- 한 획 = 펜을 대고 이어 그리는 한 부분. 한 경로 안에 "M"을 여러 번 써서 같은 색의 짧은 선 여러 개(창살, 주름, 별)를 묶어도 돼. 경로 하나는 2000자 이하.
- 획은 40개 이하. 보통 8~20개면 충분해. 그림은 빨리 나와야 하니 같은 선을 쓸데없이 반복하지 말고, 같은 색의 짧은 선은 "M" 여러 개로 한 획에 묶어.
- 판서처럼 굵고 단순한 선으로 그려. 1~2칸짜리 잔 지그재그나 털 같은 잔선은 쓰지 마.

# 이름표(labels)
- 이해를 돕는 핵심 낱말 1~4개(8글자 이하)를 붙여: 비교하는 것의 이름, 화살표의 뜻(휙휙, 뜨거워, 올라감). 그림과 겹치지 않는 빈 곳에, 좌표도 상자 안에.
- 이름표는 주문(describe)과 같은 언어로 써(영어 주문이면 영어 이름표, 영어는 짧은 낱말 1~2개).

# 아이와 가족이 보는 그림
- 싸움·전쟁도 피나 다친 모습 없이 자세로만 보여 줘(칼을 맞대고, 방패로 막고).
- 피, 상처, 쓰러지거나 죽은 몸, 무서운 표정은 주문에 있어도 그리지 마. 놀란 얼굴, 도망가는 모습처럼 순하게 바꿔.
`;

/** 영어 수업용 예시: 같은 그림, 주문·id·이름표만 영어로. */
const EN_TEXT: Record<string, string> = {
  '거리 비교': 'distance', '휙휙': 'zoom', '느릿느릿': 'slow', '그대로': 'still',
  '물방울 무지개': 'rainbow drop', '햇빛': 'sunlight', '물방울': 'drop', '색이 나뉨': 'splits',
  '끓는 물': 'boiling', '수증기': 'steam', '불': 'fire',
};
const EN_DESCRIBE = [
  'From the child in the car outward: a nearby tree whooshes by (long arrow), a far mountain moves slowly (short arrow), the very far moon stays still — side by side',
  'A sunlight arrow enters a single water drop, bends, and comes out split into red, orange, yellow, green, blue, and purple',
  'Water in a pot on a fire boils into bubbles, and steam rises in wavy arrows',
];
export const ARTIST_EXAMPLES_EN: readonly Example[] = ARTIST_EXAMPLES.map((ex, i) => {
  const f = ex.figure as { id: string; labels: { text: string }[] };
  return {
    ...ex,
    describe: EN_DESCRIBE[i],
    figure: { ...ex.figure, id: EN_TEXT[f.id] ?? f.id, labels: f.labels.map((l) => ({ ...l, text: EN_TEXT[l.text] ?? l.text })) },
  };
});

/** DRAWING_RULES의 영어판(신중한 선생님 영어 수업이 쓴다). */
export const DRAWING_RULES_EN = `# The most important rule: an explaining picture you instantly understand, not a pretty one
- This is a quick explanation drawing a teacher makes on the whiteboard. Making the principle visible at a glance ("oh, that's why!") matters far more than drawing each object well.
- Show the comparison, motion, or cause and effect through the layout of the picture:
  - Side-by-side comparison: put size, distance, speed, or count on the same line so the difference stands out (by length, size, or count).
  - Before → after, cause → effect: left to right, with an arrow between.
  - Cutaways (cross sections) and flows (where water, light, air, or force goes) use arrows.
- Use arrows freely. Draw only the shaft as one line and add "arrow": true: the program attaches the arrowhead at the end of the line in the right direction.
  - Always draw the line from start to end (M is the start, the last point is the end). The head goes on the last point.
  - Never draw the arrowhead (V shape) yourself. It would appear twice or backwards.
  - Example: left-to-right arrow {"d":"M26 35 L41 35","ink":"red","arrow":true}, wavy upward arrow {"d":"M38 42 Q34 33 38 25 Q42 17 38 9","ink":"red","arrow":true}
- Keep directions exactly as planned: check where light, water, air, force, or motion goes from and to, and draw it that way. Cause → effect and before → after go the same way.
- Draw objects just simply enough to recognize: 2-3 features are enough (tree = trunk + round leafy blob, car = body + wheels + window, person = round head + simple body and limbs, sun = circle + rays).
- Do not draw fur, scales, bricks, blades of grass, fine patterns, or decorative backgrounds. Leave out anything the explanation does not need.
- Never write letters or numbers with strokes. Names go in labels.

# Layout
- If there is a comparison or order, place things left → right (near → far, before → after), side by side, not overlapping.
- Use the box generously and draw big. Leave 3-5 empty at the edges.
- Leave room for labels: empty spots that do not overlap the drawing.

# Stroke order: the order a person would draw
People watch the strokes being drawn one by one in array order, so output them in the order a real teacher draws:
1. Simple outlines of the things that appear (in comparison order, from the left)
2. The core: arrows and lines that show the difference (this is the heart of the explanation)
3. Fill strokes (fill:true) all together at the very end

# Colors: 13 markers
${INKS.join(', ')} (gold is a deep yellow used instead of yellow)
- Use color with meaning: the two sides of a comparison in different colors, key arrows in a standout color (red, orange), hot red/orange, cold and water blue/sky, plants green, sun and light gold.
- 3-5 colors are usually enough. Do not draw everything in black.
- The top-level "ink" is the picture's base color (usually black). Every stroke must have an "ink".

# Fill
- A stroke with "fill": true must be a closed path ending in Z. Its inside is lightly tinted (about 25%) in the same color, after all lines are drawn.
- 0-3 fills, only when they help the explanation (water, two compared areas, the central object). Do not fill small details or open lines.
- A fill stroke repeats an already drawn closed outline path exactly, placed at the end (as in the examples).
- Do not write "fill" at all on strokes that are not filled. The fewer characters, the faster the picture arrives.

# Coordinate and path rules (break them and the whole picture is thrown away)
- "size": "small" is a square box 0-100 wide and tall; "wide" is a flat, wide box x 0-100, y 0-37. Use the size given. Top left is 0,0 and y grows downward. In wide, keep y at most 37: draw objects small to fit the flat box and spread them sideways.
- "d" is an SVG path string using only the M, L, Q, C, Z commands. Other commands like H, V, A, S, T, decimals, and any other characters are forbidden. Integers only, separated by spaces.
- Every number stays within 0-100 (do not leave the box). Use uppercase (absolute) commands only.
- Circles use four C curves: center (50,50) radius 20 → "M30 50 C30 39 39 30 50 30 C61 30 70 39 70 50 C70 61 61 70 50 70 C39 70 30 61 30 50 Z" (control points about 0.55 × radius away). Ellipses the same way with different horizontal and vertical radii.
- Small dots (pupils etc.) are short lines of length 2 ("M46 29 L46 31").
- One stroke = one part drawn without lifting the pen. You may use "M" several times in one path to group short lines of the same color (bars, wrinkles, stars). Each path is at most 2000 characters.
- At most 40 strokes. 8-20 is usually enough. Pictures must arrive fast, so do not repeat lines needlessly; group short same-color lines into one stroke with multiple "M".
- Draw with bold, simple whiteboard lines. No tiny 1-2 unit zigzags or fur-like scribbles.

# Labels
- Add 1-4 key words (1-2 short English words each) that help understanding: names of compared things, the meaning of arrows (zoom, hot, rises). Place them in empty spots that do not overlap the drawing, with coordinates inside the box.
- Label in English.

# Pictures children and families see
- Fights and wars only through poses, with no blood or injuries (swords crossed, blocking with a shield).
- Never draw blood, wounds, fallen or dead bodies, or scary faces even if asked. Soften them into surprised faces or running away.
`;

/** 영어 예시(프롬프트용 글). */
export const drawingExamplesEn = (): string =>
  ARTIST_EXAMPLES_EN.map((ex, i) => `Example ${i + 1} — size: ${ex.size} / order: ${ex.describe}\n${JSON.stringify(ex.figure)}`).join('\n\n');

/** 좋은 그림 예시(프롬프트용 글). */
export const drawingExamples = (): string =>
  ARTIST_EXAMPLES.map((ex, i) => `예시 ${i + 1} — 크기: ${ex.size} / 주문: ${ex.describe}\n${JSON.stringify(ex.figure)}`).join('\n\n');

/** 화가 시스템 프롬프트(한국어). */
export function buildArtistPrompt(): string {
  return `너는 화이트보드 앞 선생님의 설명 그림을 그리는 화가야. 선생님이 수업하면서 "이런 그림을 그려 줘" 하고 말로 주문하면, 너는 그 주문을 마커로 쓱쓱 그린 선 그림 하나(JSON)로 돌려줘. 보는 사람은 아이와 가족이야.

${DRAWING_RULES}
# 출력
- JSON 하나만: {"kind":"figure","id":"...","size":"small|wide","ink":"black","strokes":[{"d":"...","ink":"..."}, {"d":"...","ink":"...","arrow":true}, {"d":"...","ink":"...","fill":true}, ...],"labels":[...]}
- id는 아무 짧은 이름이나 써도 돼(프로그램이 주문 id로 바꿔).

# 좋은 그림 예시
${drawingExamples()}`;
}

/** 화가 출력의 구조화 출력 JSON 스키마. 세부 검증(좌표·명령·획 수)은 parseFigure가 맡는다. */
export const ARTIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['figure'] },
    id: { type: 'string' },
    size: { type: 'string', enum: ['small', 'wide'] },
    ink: { type: 'string', enum: [...INKS] },
    strokes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          d: { type: 'string' },
          ink: { type: 'string', enum: [...INKS] },
          fill: { type: 'boolean' },
          arrow: { type: 'boolean' },
        },
        required: ['d', 'ink'],
      },
    },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          text: { type: 'string' },
          ink: { type: 'string', enum: [...INKS] },
        },
        required: ['x', 'y', 'text', 'ink'],
      },
    },
  },
  required: ['kind', 'id', 'size', 'ink', 'strokes', 'labels'],
} as const;

const userMessage = (o: SketchOrder) =>
  `크기: ${o.size} (${o.size === 'wide' ? '가로 x 0~100, 세로 y 0~37' : '가로·세로 0~100'})\n주문: ${o.describe}`;

/**
 * meter(선택): 이 호출 때문에 실제로 Gemini를 불렀으면, 그 호출이 끝날 때(성공·실패·시간 초과) 토큰과 함께 한 번 불린다
 * (토큰을 모르면 null). 캐시에 있던 주문·이미 그리는 중인 같은 주문에 붙은 호출은 부르지 않는다(돈이 안 든다).
 */
export type ArtistMeter = (usage: ModelUsage | null) => void;
export type Artist = (order: SketchOrder, signal: AbortSignal, meter?: ArtistMeter) => Promise<FigureOp | null>;

/**
 * 그림 주문 → FigureOp. 실패(거절·잘못된 JSON·검증 실패·오류·시간 초과)는 모두 null(던지지 않음).
 * 같은 크기·묘사는 캐시한다(null은 캐시하지 않음). `client`는 테스트용 주입 지점.
 */
export type ArtistOptions = {
  client?: GenAI;
  model?: string;
  timeoutMs?: number;
  /** 실패 이유 알림(로그용). 오류 객체나 이유만 넘기고 요청·키는 넘기지 않는다. */
  onError?: (order: SketchOrder, err: unknown) => void;
  /** 응답 토큰 사용량(스모크·비용 확인용: cachedContentTokenCount로 캐시가 읽혔는지 본다). */
  onUsage?: (order: SketchOrder, usage: GenerateContentResponseUsageMetadata) => void;
};

export function createArtist(opts: ArtistOptions = {}): Artist {
  const model = opts.model ?? modelFor('artist');
  const timeoutMs = opts.timeoutMs ?? ARTIST_TIMEOUT_MS;
  // 긴 시스템 지시문(규칙 + 예시 그림)은 주문마다 같다: Gemini가 알아서(암묵적 캐시) 싸게 다시 읽는다.
  const system = buildArtistPrompt();
  let client = opts.client;
  // 서버 실행 중 유지, 최대 ARTIST_CACHE_MAX개(가장 오래 안 쓴 것부터 버림). 같은 주문은 한 작업을 함께 기다린다.
  // 작업은 호출자 signal이 아니라 자기 컨트롤러로 끊는다: 기다리던 호출자가 모두 끊겼을 때만(한 명이라도 남으면 계속 그린다).
  type Job = { p: Promise<FigureOp | null>; ac: AbortController; waiters: number; settled: boolean };
  const cache = new Map<string, Job>();

  function fail(order: SketchOrder, err: unknown): null {
    try {
      opts.onError?.(order, err);
    } catch {
      // 로그 콜백 오류는 수업을 막지 않는다.
    }
    return null;
  }

  async function draw(order: SketchOrder, signal: AbortSignal, meter?: ArtistMeter): Promise<FigureOp | null> {
    let called = false;
    const metered = (u: ModelUsage | null) => {
      if (!called) return;
      called = false; // 한 번만
      try {
        meter?.(u);
      } catch {
        // 기록 쪽 문제로 수업을 멈추지 않는다.
      }
    };
    try {
      client ??= getGemini();
      called = true;
      const res = await client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: userMessage(order) }] }],
        config: {
          systemInstruction: system,
          thinkingConfig: { thinkingLevel: thinkingFor('artist') },
          maxOutputTokens: 8000,
          responseMimeType: 'application/json',
          responseJsonSchema: ARTIST_SCHEMA,
          // 전체가 시간 한도 안에서 끝난다(호출자가 끊어도 바로 멈춘다).
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        },
      });
      metered(usageFrom(res.usageMetadata, model));
      try {
        if (res.usageMetadata) opts.onUsage?.(order, res.usageMetadata);
      } catch {
        // 로그 콜백 오류는 수업을 막지 않는다.
      }
      const blocked = blockedReason(res);
      if (blocked) return fail(order, new Error(`artist blocked: ${blocked}`));
      if (hitMaxTokens(res)) return fail(order, new Error('artist: hit max tokens'));
      const text = res.text;
      if (!text) return fail(order, new Error('artist: no text'));
      const raw: unknown = JSON.parse(text);
      // id·size는 주문이 정한다: 모델이 빈 id나 다른 size를 줘도 검증에서 떨어지거나 다른 크기로 그려지지 않게.
      const fig = parseFigure(raw && typeof raw === 'object' ? { ...raw, id: order.id, size: order.size } : raw);
      return fig ?? fail(order, new Error('artist: figure failed validation'));
    } catch (err) {
      metered(null); // 응답 전에 끝난 호출도 부른 것으로 센다(토큰은 모름)
      // 호출자가 끊은 것(수업이 멈춤·연결 끊김)은 화가 실패가 아니다. 시간 초과와 진짜 오류만 알린다.
      if (signal.aborted) return null;
      return fail(order, err);
    }
  }

  return (order, signal, meter) => {
    if (signal.aborted) return Promise.resolve(null);
    const key = `${order.size}|${order.describe}`;
    let job = cache.get(key);
    if (job) {
      cache.delete(key); // 최근에 쓴 것으로(맨 뒤로)
      cache.set(key, job);
    } else {
      const ac = new AbortController();
      const fresh: Job = { p: draw(order, ac.signal, meter), ac, waiters: 0, settled: false };
      cache.set(key, fresh);
      while (cache.size > ARTIST_CACHE_MAX) cache.delete(cache.keys().next().value!);
      void fresh.p.then((fig) => {
        fresh.settled = true;
        if (fig === null && cache.get(key) === fresh) cache.delete(key);
      });
      job = fresh;
    }
    const j = job;
    j.waiters++;
    return new Promise<FigureOp | null>((resolve) => {
      let left = false;
      const leave = () => {
        left = true;
        j.waiters--;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (left) return;
        leave();
        resolve(null);
        if (j.waiters === 0 && !j.settled) {
          // 아무도 안 기다린다: 그리기를 끊고(비용 멈춤), 끊긴 작업에 새 호출자가 붙지 않게 캐시에서 뺀다.
          if (cache.get(key) === j) cache.delete(key);
          j.ac.abort();
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void j.p.then((fig) => {
        if (left) return;
        leave();
        resolve(fig ? { ...fig, id: order.id } : null);
      });
    });
  };
}

// "달은 왜 나를 따라올까?" 예시 수업(신중한 선생님)의 설명 그림 세 개. 한국어·영어 예시가 같은 선을 쓰고 이름표만 다르다.
import { ARTIST_EXAMPLES } from './artist';

type Stroke = { d: string; ink: string; fill?: boolean; arrow?: boolean };
type Label = { x: number; y: number; text: string; ink: string };
type Figure = { kind: 'figure'; id: string; size: 'small' | 'wide'; ink: string; strokes: Stroke[]; labels: Label[] };

const circle = (cx: number, cy: number, r: number) => {
  const k = Math.round(r * 0.55);
  return `M${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} Z`;
};

type Texts = {
  ids: [string, string, string];
  window: [string, string, string, string]; // 차 탄 나, 나무, 산, 달
  finger: [string, string, string, string, string]; // 많이, 조금, 손가락, 창문, 고개 흔들기
  trip: [string, string, string, string]; // 지구, 달, 지구 30개, 38만 km
};

const TEXTS: Record<'ko' | 'en', Texts> = {
  ko: {
    ids: ['창밖', '손가락', '달까지'],
    window: ['차 탄 나', '나무: 휙휙', '산: 느릿느릿', '달: 그대로'],
    finger: ['많이!', '조금', '손가락', '창문', '고개 흔들기'],
    trip: ['지구', '달', '지구 30개!', '38만 km'],
  },
  en: {
    ids: ['window', 'finger', 'moon trip'],
    window: ['me in the car', 'tree: zoom', 'mountain: slow', 'moon: still'],
    finger: ['a lot!', 'a little', 'finger', 'window', 'shake head'],
    trip: ['Earth', 'moon', '30 Earths!', '384,000 km'],
  },
};

/** 그림 세 개: 차 창밖 비교(wide), 손가락 실험(small), 지구에서 달까지(small). */
export function moonLessonFigures(lang: 'ko' | 'en'): [Figure, Figure, Figure] {
  const t = TEXTS[lang];

  // 1) 차 창밖: 화가 예시 1(거리 비교)의 선에 초승달을 얹고 이름표를 붙인다.
  const base = ARTIST_EXAMPLES[0].figure as { strokes: Stroke[] };
  const farMoon = circle(90, 9, 4);
  const crescent = 'M92 3 C85 4 85 15 92 16 C88 13 88 6 92 3 Z';
  const window: Figure = {
    kind: 'figure', id: t.ids[0], size: 'wide', ink: 'black',
    strokes: base.strokes.map((s) => (s.d === farMoon ? { ...s, d: crescent } : { ...s })),
    labels: [
      { x: 12, y: 13, text: t.window[0], ink: 'red' },
      { x: 33, y: 7, text: t.window[1], ink: 'red' },
      { x: 58, y: 11, text: t.window[2], ink: 'orange' },
      { x: 84, y: 26, text: t.window[3], ink: 'navy' },
    ],
  };

  // 2) 손가락 실험: 눈 앞 손가락은 많이, 멀리 창문은 조금 움직여 보인다.
  const fingerD = 'M38 40 C38 36 44 36 44 40 L44 66 L38 66 Z';
  const windowD = 'M70 34 L94 34 L94 62 L70 62 Z';
  const finger: Figure = {
    kind: 'figure', id: t.ids[1], size: 'small', ink: 'black',
    strokes: [
      { d: 'M4 52 Q13 42 22 52 Q13 62 4 52 Z', ink: 'black' },
      { d: 'M13 50 L13 54', ink: 'black' },
      { d: fingerD, ink: 'orange' },
      { d: 'M38 44 L44 44', ink: 'orange' },
      { d: windowD, ink: 'blue' },
      { d: 'M82 34 L82 62 M70 48 L94 48', ink: 'blue' },
      { d: 'M24 52 L36 52 M48 52 L68 52', ink: 'gray' },
      { d: 'M30 28 L52 28', ink: 'red', arrow: true },
      { d: 'M52 24 L30 24', ink: 'red', arrow: true },
      { d: 'M79 27 L85 27', ink: 'green', arrow: true },
      { d: 'M4 76 L22 76', ink: 'purple', arrow: true },
      { d: 'M22 80 L4 80', ink: 'purple', arrow: true },
      { d: fingerD, ink: 'orange', fill: true },
      { d: windowD, ink: 'sky', fill: true },
    ],
    labels: [
      { x: 41, y: 16, text: t.finger[0], ink: 'red' },
      { x: 82, y: 19, text: t.finger[1], ink: 'green' },
      { x: 41, y: 76, text: t.finger[2], ink: 'orange' },
      { x: 82, y: 72, text: t.finger[3], ink: 'blue' },
      { x: 13, y: 90, text: t.finger[4], ink: 'purple' },
    ],
  };

  // 3) 지구에서 달까지: 지구를 줄 세운 거리.
  const earth = circle(10, 50, 8);
  const moon = circle(92, 50, 3);
  const row = Array.from({ length: 16 }, (_, i) => circle(21 + i * 4, 50, 2)).join(' ');
  const trip: Figure = {
    kind: 'figure', id: t.ids[2], size: 'small', ink: 'black',
    strokes: [
      { d: earth, ink: 'blue' },
      { d: 'M6 46 C8 44 11 45 10 48 C9 51 6 51 6 46 Z', ink: 'green' },
      { d: moon, ink: 'gray' },
      { d: row, ink: 'sky' },
      { d: 'M20 40 Q55 30 88 40', ink: 'red', arrow: true },
      { d: earth, ink: 'blue', fill: true },
      { d: moon, ink: 'gold', fill: true },
    ],
    labels: [
      { x: 10, y: 68, text: t.trip[0], ink: 'blue' },
      { x: 92, y: 64, text: t.trip[1], ink: 'gray' },
      { x: 54, y: 24, text: t.trip[2], ink: 'red' },
      { x: 54, y: 64, text: t.trip[3], ink: 'navy' },
    ],
  };

  return [window, finger, trip];
}

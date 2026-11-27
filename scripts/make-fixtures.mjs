// e2e 픽스처 생성: node scripts/make-fixtures.mjs
// silence.mp3는 ffmpeg로 만든 0.3초 무음(ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t 0.3 -c:a libmp3lame -b:a 32k).
import { readFileSync, writeFileSync } from 'node:fs';

const b64 = readFileSync(new URL('../tests/fixtures/silence.mp3', import.meta.url)).toString('base64');
const MS = 60; // 글자당

const speech = (text) => {
  const chars = [...text];
  const startMs = chars.map((_, i) => i * MS);
  const endMs = chars.map((_, i) => (i + 1) * MS);
  return { audioBase64: b64, mime: 'audio/mpeg', timing: { chars, startMs, endMs }, durationMs: chars.length * MS };
};

const lines = [];
let id = 0;
const say = (text) => { id += 1; lines.push({ type: 'say', id, text, speech: speech(text) }); };
const draw = (op, at) => lines.push({ type: 'draw', sayId: id, ...(at ? { at } : {}), op });

say('자, 오늘의 질문! 달은 왜 나를 따라올까?');
draw({ kind: 'text', id: '제목', role: 'title', text: '달은 왜 나를 따라올까?', ink: 'black' });
draw({ kind: 'mark', target: '제목', word: '따라올까', style: 'underline', ink: 'red' });
// 나무: 주문 그림이 보여 주기보다 먼저 온다 / 달: 늦게 온다 / 별: 화가가 실패(figure:null)
const sk = (id, size, ink, strokes, labels) => ({ kind: 'figure', id, size, ink, strokes, ...(labels ? { labels } : {}) });
say('창밖의 나무는 휙휙 지나가지?');
// 나무는 실제 화가 출력처럼 획마다 색({d, ink})과 채우기(fill:true, 채우기만 그림)를 쓴다.
const CROWN = 'M50 20 C25 22 22 55 50 55 C78 55 75 22 50 20 Z';
lines.push({ type: 'sketch', id: '나무', figure: sk('나무', 'small', 'green', [
  { d: 'M50 85 L50 55', ink: 'brown' },
  CROWN,
  'M10 85 L90 85',
  { d: 'M50 70 L38 60', ink: 'brown' },
  { d: 'M50 62 L62 52', ink: 'brown' },
  { d: CROWN, ink: 'lime', fill: true },
], [{ x: 50, y: 98, text: '가까운 나무', ink: 'black' }]) });
draw({ kind: 'sketch', id: '나무', size: 'small' });
say('그런데 저~ 멀리 있는 달은 어때?');
draw({ kind: 'sketch', id: '달', size: 'small' });
lines.push({ type: 'sketch', id: '달', figure: sk('달', 'small', 'blue', ['M60 15 C30 20 30 75 60 80 C42 68 42 27 60 15 Z', 'M82 22 L82 32 M77 27 L87 27', 'M40 40 L44 44', 'M45 55 L49 58'], [{ x: 50, y: 98, text: '아주 먼 달' }]) });
say('그 옆에는 그림이 안 만들어진 칸이야.');
draw({ kind: 'sketch', id: '별', size: 'small' });
lines.push({ type: 'sketch', id: '별', figure: null });
say('달은 너무 멀어서 안 움직이는 것 같아.');
draw({ kind: 'connect', from: '나무', to: '달', ink: 'blue', label: '엄청 멀다!' });
say('바로 이 달이야!');
draw({ kind: 'mark', target: '달', style: 'circle', ink: 'red' });
say('그래서 달이 따라오는 것 같은 거야!');
draw({ kind: 'text', role: 'note', text: '멀수록 천천히 움직여 보여!', ink: 'green' });
lines.push({ type: 'done' });

writeFileSync(new URL('../tests/fixtures/moon-lesson.ndjson', import.meta.url), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`wrote ${lines.length} lines`);

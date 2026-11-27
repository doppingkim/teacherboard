// 실제 Gemini 판별 스모크: npx tsx scripts/smoke-classify.ts
import 'dotenv/config';
import { classifyUtterance, geminiAsk, type ClassifyInput } from '../src/server/classify';

const ask = geminiAsk();
const cases: Array<[string, boolean]> = [
  ['근데 왜 그런 거야?', true],
  ['공룡은 어떻게 멸종했어?', true],
  ['엄마 나 물 마시고 싶어', true],
  ['형 그거 내 거야 돌려줘', true],
  ['다시 말해 줘', true],
  ['아 진짜 웃기다', true],
  ['퀄리디스크가 뭐야?', false],
  ['광합썽은 어떻게 해?', false],
  ['그런데 공룡은', false],
  ['엄마 나 내일', false],
  ['왜?', true],
];
for (const [text, lessonActive] of cases) {
  const input: ClassifyInput = { text, profile: 'kid', lessonActive, recentSpoken: ['달은 너무 멀어서 거의 안 움직이는 것처럼 보여.'] };
  const t0 = Date.now();
  const v = await classifyUtterance(input, ask);
  console.log(`${String(Date.now() - t0).padStart(5)}ms  ${v.accept ? '수락' : '거절'}  ${v.reason.padEnd(8)} ${v.complete ? '끝남  ' : '덜끝남'} ${text} → ${v.question}`);
}

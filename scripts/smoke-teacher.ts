// 실제 선생님(Gemini) 호출 스모크: npx tsx scripts/smoke-teacher.ts ["질문"] [kid|adult] [quick|deep]
// .env에 GEMINI_API_KEY만 있으면 된다(ElevenLabs 설정은 필요 없음).
import { streamScriptText, RefusalError } from '../src/server/teacher';
import { LineSplitter } from '../src/server/lineSplitter';
import { createParseState, parseScriptLine, type Profile } from '../src/shared/script';

const question = process.argv[2] ?? '달은 왜 나를 따라와?';
const profile: Profile = process.argv[3] === 'adult' ? 'adult' : 'kid';
const mode = process.argv[4] === 'deep' ? 'deep' : 'quick';

const splitter = new LineSplitter();
const state = createParseState();
const started = Date.now();
let firstLineMs: number | undefined;
let total = 0;
let dropped = 0;
let firstKind: string | undefined;
let afterFirst: string | undefined; // 첫 say 다음 줄의 종류
const orders: { id: string; describe: string; size: string; ms: number }[] = [];
let lateOrders = 0; // 첫 say 바로 뒤가 아닌 곳에서 나온 주문
let shows = 0;
let marks = 0;
let says = 0;

function handle(line: string) {
  total += 1;
  if (firstLineMs === undefined) firstLineMs = Date.now() - started;
  const ev = parseScriptLine(line, state);
  if (ev === null) {
    dropped += 1;
    console.log(`  버림  ${line}`);
    return;
  }
  firstKind ??= ev.t;
  if (says === 1 && afterFirst === undefined) afterFirst = ev.t;
  if (ev.t === 'say') says += 1;
  if (ev.t === 'sketch') {
    orders.push({ ...ev.order, ms: Date.now() - started });
    if (says !== 1) lateOrders += 1;
  }
  if (ev.t === 'draw' && ev.op.kind === 'sketch') shows += 1;
  if (ev.t === 'draw' && ev.op.kind === 'mark') marks += 1;
  console.log(`  ${ev.t.padEnd(6)}  ${JSON.stringify(ev)}`);
}

console.log(`질문: ${question} (${profile}, ${mode})`);
try {
  for await (const chunk of streamScriptText(question, profile, new AbortController().signal, undefined, undefined, undefined, mode)) {
    for (const line of splitter.push(chunk)) handle(line);
  }
  for (const line of splitter.flush()) handle(line);
} catch (e) {
  if (e instanceof RefusalError) console.error('막힘:', e.message);
  else throw e;
}

console.log('---');
console.log(`첫 줄까지: ${firstLineMs ?? '-'} ms`);
console.log(`첫 이벤트: ${firstKind ?? '-'}${firstKind === 'say' ? ' (OK)' : ' (첫 줄이 say가 아님!)'}`);
console.log(`첫 say 다음 줄: ${afterFirst ?? '-'}${afterFirst === 'sketch' ? ' (OK)' : ''}`);
console.log(`그림 주문: ${orders.length}개 (첫 say 바로 뒤가 아닌 주문 ${lateOrders}개), 보여 주기: ${shows}개, 표시: ${marks}개`);
for (const o of orders) console.log(`  [${o.ms} ms] ${o.id} (${o.size}): ${o.describe}`);
console.log(`전체 줄: ${total}, 버려진 줄: ${dropped}`);
console.log(`전체 시간: ${Date.now() - started} ms`);

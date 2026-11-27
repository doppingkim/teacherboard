// 실제 키로: 받아 적은 말이 틀린 채(classify가 못 고침)로 와도 대본 제목이 바로잡히는지 본다. 제목 줄까지만 받고 끊는다.
// npx tsx scripts/smoke-heard.ts
import 'dotenv/config';
import { streamScriptText } from '../src/server/teacher';

const TITLE = '"role":"title"';
for (const heard of ['퀄리디스크가 뭐야', '광합썽은 어떻게 해']) {
  let buf = '';
  const ac = new AbortController();
  try {
    for await (const chunk of streamScriptText(heard, 'kid', ac.signal, undefined, undefined, heard)) {
      buf += chunk;
      const at = buf.indexOf(TITLE);
      if (at >= 0 && buf.indexOf('\n', at) >= 0) break;
    }
  } finally {
    ac.abort();
  }
  const title = buf.split('\n').find((l) => l.includes(TITLE)) ?? '(제목 없음)';
  console.log(`▶ ${heard}\n  ${title.slice(0, 200)}\n`);
}

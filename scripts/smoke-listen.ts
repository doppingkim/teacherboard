// 실제 키로 /api/listen 경로 확인: TTS로 만든 말소리를 마이크 대신 흘려보낸다.
// 서버를 먼저 띄운 뒤(PORT=8788 등): npx tsx scripts/smoke-listen.ts [port]
import 'dotenv/config';
import WebSocket from 'ws';

const port = Number(process.argv[2] ?? process.env.PORT ?? process.env.API_PORT ?? 8787);
const key = process.env.ELEVENLABS_API_KEY!;
const voice = process.env.ELEVENLABS_VOICE_ADULT || process.env.ELEVENLABS_VOICE_KID!;

async function speechPcm(text: string): Promise<Buffer> {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const silence = (ms: number) => Buffer.alloc((16000 * 2 * ms) / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** parts가 여럿이면 말하다 쉰 것: 조각마다 end를 보내고 gapMs 뒤 다음 조각(브라우저 게이트가 1.3초 쉼에서 끊은 경우). */
const phrases: Array<{ parts: string[]; lessonActive: boolean; gapMs?: number }> = [
  { parts: ['공룡은 왜 멸종했어?'], lessonActive: false },
  { parts: ['우와 대박이다'], lessonActive: true },
  { parts: ['근데 왜?'], lessonActive: true },
  { parts: ['허리디스크가', '왜 생기는 거야?'], lessonActive: false, gapMs: 700 },
  { parts: ['그런데 공룡은'], lessonActive: false },
];

const ws = new WebSocket(`ws://localhost:${port}/api/listen?profile=kid`, { headers: { origin: `http://localhost:${port}` } });
const t = () => performance.now();
let endAt = 0;
ws.on('message', (data) => {
  const m = JSON.parse(String(data));
  if (m.type === 'partial') console.log(`  부분 +${Math.round(t() - endAt)}ms: ${m.text}`);
  else if (m.type === 'utterance') console.log(`  판정 +${Math.round(t() - endAt)}ms (마지막 end 기준): ${m.accept ? '수락' : '거절'} "${m.text}" → "${m.question}"`);
  else console.log('  서버:', JSON.stringify(m));
});
await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
await sleep(500);

const stream = async (pcm: Buffer) => {
  for (let i = 0; i < pcm.length; i += 640) { // 20ms씩 실시간으로
    ws.send(pcm.subarray(i, i + 640));
    await sleep(20);
  }
};

for (const p of phrases) {
  console.log(`
▶ ${p.parts.join(' / ')} (수업 중: ${p.lessonActive})`);
  ws.send(JSON.stringify({ type: 'state', lessonActive: p.lessonActive, recentSpoken: ['달은 너무 멀어서 거의 안 움직이는 것처럼 보여.'] }));
  const audio = await Promise.all(p.parts.map(speechPcm));
  for (const [i, a] of audio.entries()) {
    await stream(Buffer.concat([silence(300), a, silence(1300)])); // 끝의 1.3초 = 게이트 hangover
    endAt = t();
    ws.send(JSON.stringify({ type: 'end' }));
    if (i < audio.length - 1) await sleep(p.gapMs ?? 0);
  }
  await sleep(7000);
}
ws.close();

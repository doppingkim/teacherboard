// 목소리 샘플 생성: npx tsx scripts/voice-samples.ts <voiceId...>
// 각 목소리로 샘플 문장을 합성해 data/samples/<voiceId>.mp3로 저장한다. (.env의 ELEVENLABS_API_KEY 필요)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireEnv } from '../src/server/config';
import { synthesize } from '../src/server/tts';

const SAMPLE = process.env.SAMPLE_TEXT ?? '자, 오늘의 질문! 달은 왜 나를 따라올까? 달은 아주아주 멀리 있어서, 우리가 걸어가도 거의 같은 자리에 보이는 거야.';

async function main() {
  const voiceIds = process.argv.slice(2);
  if (voiceIds.length === 0) {
    console.error('사용법: npx tsx scripts/voice-samples.ts <voiceId...>');
    process.exit(1);
  }
  // 목소리를 고르기 전이므로 ELEVENLABS_VOICE_* 없이 키만 있으면 된다.
  const { ELEVENLABS_API_KEY: elevenKey } = requireEnv(['ELEVENLABS_API_KEY']);
  const dir = join('data', 'samples');
  mkdirSync(dir, { recursive: true });
  for (const id of voiceIds) {
    try {
      const sp = await synthesize(SAMPLE, id, elevenKey, new AbortController().signal);
      const file = join(dir, `${id}.mp3`);
      writeFileSync(file, Buffer.from(sp.audioBase64, 'base64'));
      console.log(`${id}: ${file} (${sp.durationMs}ms)`);
    } catch (e) {
      console.error(`${id}: 실패 - ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});

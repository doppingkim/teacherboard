// e2e용 가짜 API 서버: 진짜 buildApp + 시험용 PIN(TEST_PIN), Gemini·ElevenLabs 대신 가짜. .env를 읽지 않는다.
// playwright.config.ts가 띄우고, vite가 /api를 여기로 넘긴다. 수업·채움 음성·듣기는 시험이 page.route로 흉내 낸다.
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app';
import type { Speech } from '../../src/shared/lesson';
import { TEST_PIN, TEST_SERVER_HEADER } from './testPin';

const port = Number(process.argv[2] || process.env.PW_API_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error('pinServer: 포트가 필요합니다');

const silence: Speech = {
  audioBase64: readFileSync(new URL('../fixtures/silence.mp3', import.meta.url)).toString('base64'),
  mime: 'audio/mpeg',
  durationMs: 300,
  timing: { chars: ['음'], startMs: [0], endMs: [300] },
};

const app = buildApp({
  scriptText: async function* () {
    yield JSON.stringify({ say: '시험 서버예요' }) + '\n';
  },
  speak: async () => silence,
  voice: { kid: 'e2e-kid', adult: 'e2e-adult' },
  fillerDir: mkdtempSync(join(tmpdir(), 'tb-e2e-filler-')),
  staticDir: join(tmpdir(), 'tb-e2e-no-dist'),
  logLesson: () => {},
  familyPin: TEST_PIN,
});
app.addHook('onSend', async (_req, reply) => {
  reply.header(TEST_SERVER_HEADER, '1');
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e pin server on ${port}`);

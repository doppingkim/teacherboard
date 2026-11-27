// 말로 묻기의 수업 흐름(2026-11-23 craft E7·E1) — chromium 전용(가짜 마이크 장치 플래그). /api/listen은 흉내 낸다.
import { expect, test } from '@playwright/test';
import { mockListen, speechLikeWav } from './voiceMocks';
import { gotoUnlocked } from './pin';
import { readFileSync } from 'node:fs';

test.skip(({ browserName }) => browserName !== 'chromium', '가짜 마이크 장치는 chromium만');

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${speechLikeWav()}`, // 약 5초마다 1.2초 말소리
    ],
  },
  permissions: ['microphone'],
});

const lesson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const MSG = '잘 못 들었어. 다시 말해 줄래?';

test('E7: 말로 물었는데 연달아 두 번 못 알아들으면 말풍선에 "다시 말해 줄래?"를 한 번 보인다', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/api/lesson', (route) => route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lesson }));
  const listen = await mockListen(page, 'manual');
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await expect.poll(() => listen.ends, { timeout: 15000 }).toBe(1);
  listen.sockets[0].send(JSON.stringify({ type: 'utterance', text: '음 그거', accept: false, question: '', miss: true }));
  await page.waitForTimeout(500);
  await expect(page.locator('.heard')).toBeHidden(); // 한 번은 그냥 넘어간다
  await expect.poll(() => listen.ends, { timeout: 15000 }).toBe(2);
  listen.sockets[0].send(JSON.stringify({ type: 'utterance', text: '그거 있잖아', accept: false, question: '', miss: true }));
  await expect(page.locator('.heard')).toHaveText(`👂 ${MSG}`);
  await expect(page.locator('.heard')).toBeHidden({ timeout: 5000 });
  // 감탄사(miss 아님)는 세지 않는다
  await expect.poll(() => listen.ends, { timeout: 15000 }).toBe(3);
  listen.sockets[0].send(JSON.stringify({ type: 'utterance', text: '우와', accept: false, question: '' }));
  await page.waitForTimeout(500);
  await expect(page.locator('.heard')).toBeHidden();
});

test('E1·E7: 말로 물은 질문도 받아들여지면 칠판에 먼저 쓴다(고쳐 알아들은 질문으로)', async ({ page }) => {
  await page.route('**/api/lesson', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lesson }).catch(() => {});
  });
  const listen = await mockListen(page, 'manual');
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await expect.poll(() => listen.ends, { timeout: 15000 }).toBe(1);
  listen.sockets[0].send(JSON.stringify({ type: 'utterance', text: '퀄리디스크가 뭐야', accept: true, question: '허리디스크가 뭐야?' }));
  await expect(page.locator('.board svg text', { hasText: '허리디스크가 뭐야?' })).toHaveCount(1);
  await expect(page.locator('.q-card')).toHaveCount(0);
});

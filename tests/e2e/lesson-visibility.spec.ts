// 탭 숨김 ↔ 듣기(web-player-ui QA, 2026-11-22). chromium 전용(가짜 마이크 장치 플래그). /api/listen은 routeWebSocket으로 흉내.
import { expect, test, type Page } from '@playwright/test';
import { gotoUnlocked } from './pin';
import { mockApi, mockListen, speechLikeWav } from './voiceMocks';

test.skip(({ browserName }) => browserName !== 'chromium', '가짜 마이크 장치는 chromium만');
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speechLikeWav()}`],
  },
  permissions: ['microphone'],
});

const setVisibility = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate((st) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => st });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

test('탭이 숨으면 듣기 연결을 닫고 말을 보내지 않으며, 돌아오면 다시 연결한다(숨은 탭의 TV 소리로 수업이 생기지 않게)', async ({ page }) => {
  await mockApi(page);
  const listen = await mockListen(page, 'manual');
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => listen.urls.length).toBe(1);
  await setVisibility(page, 'hidden');
  await listen.closed; // 숨자 연결을 닫았다
  const sent = listen.binary;
  await page.waitForTimeout(6000); // 가짜 마이크의 "말"이 한 번 이상 지나간다
  expect(listen.binary).toBe(sent);
  expect(listen.urls.length).toBe(1); // 숨은 동안 다시 붙지 않는다
  await setVisibility(page, 'visible');
  await expect.poll(() => listen.urls.length).toBe(2);
  await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible();
});

test('꺼 둔 마이크는 탭에서 돌아와도 꺼진 채로', async ({ page }) => {
  await mockApi(page);
  const listen = await mockListen(page, 'manual');
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('button', { name: '듣는 중' }).click({ timeout: 15000 });
  await expect(page.getByRole('button', { name: '마이크 꺼짐' })).toBeVisible();
  const n = listen.urls.length;
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.waitForTimeout(500);
  expect(listen.urls.length).toBe(n);
  await expect(page.getByRole('button', { name: '마이크 꺼짐' })).toBeVisible();
});


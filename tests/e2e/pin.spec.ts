// 가족 비밀번호 화면. PIN은 시험 서버(pinServer.ts, TEST_PIN)에만 보낸다 — 진짜 .env와 상관없다.
import { expect, test } from '@playwright/test';
import { assertTestServer, enterPin, gotoUnlocked, TEST_PIN } from './pin';

const wrongPin = TEST_PIN.split('').reverse().join('');

test.beforeEach(async ({ page }) => {
  await assertTestServer(page);
});

test('처음엔 PIN 화면 → 맞히면 프로필 화면, 다시 열어도 기억한다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('가족 비밀번호를 눌러 줘')).toBeVisible();
  await expect(page.getByRole('button', { name: '🧒 아이' })).toBeHidden();
  // 잘못 누른 것은 지우기로 고친다
  await page.getByRole('button', { name: '9', exact: true }).click();
  await expect(page.locator('.pin-dot.on')).toHaveCount(1);
  await page.getByRole('button', { name: '지우기' }).click();
  await expect(page.locator('.pin-dot.on')).toHaveCount(0);
  await enterPin(page, TEST_PIN);
  await expect(page.getByRole('button', { name: '🧒 아이' })).toBeVisible();
  await expect(page.getByText('가족 비밀번호를 눌러 줘')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: '🧒 아이' })).toBeVisible();
  await expect(page.getByText('가족 비밀번호를 눌러 줘')).toBeHidden();
});

test('키보드 숫자로도 넣을 수 있다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('가족 비밀번호를 눌러 줘')).toBeVisible();
  await page.keyboard.type(TEST_PIN);
  await expect(page.getByRole('button', { name: '🧒 아이' })).toBeVisible();
});

test('틀리면 흔들고 "다시 해 볼까?", 그다음 맞히면 들어간다', async ({ page }) => {
  await page.goto('/');
  await enterPin(page, wrongPin);
  await expect(page.getByText('다시 해 볼까?')).toBeVisible();
  await expect(page.locator('.pin-dots')).toHaveClass(/shake/);
  await expect(page.locator('.pin-dot.on')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '🧒 아이' })).toBeHidden();
  await enterPin(page, TEST_PIN);
  await expect(page.getByRole('button', { name: '🧒 아이' })).toBeVisible();
});

test('잠기면 "잠깐 쉬었다가 다시 해 줘 (n분)"이고 숫자판을 막는다', async ({ page }) => {
  // 시험 서버를 진짜로 잠그지 않게 이 응답만 흉내 낸다
  await page.route('**/api/pin', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'locked', retryAfterSec: 125 }) })
      : route.fallback());
  await page.goto('/');
  await enterPin(page, wrongPin);
  await expect(page.getByText('잠깐 쉬었다가 다시 해 줘 (3분)')).toBeVisible();
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeDisabled();
});

test('수업 요청이 401이면 PIN 화면으로 돌아간다', async ({ page }) => {
  await page.route('**/api/filler/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/lesson', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"pin"}' }));
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.getByText('가족 비밀번호를 눌러 줘')).toBeVisible();
  // 다시 맞히면 저장된 프로필로 시작 화면
  await enterPin(page, TEST_PIN);
  await expect(page.getByText('🧒 아이로 시작해요')).toBeVisible();
});

test('휴대폰 가로에서도 숫자판이 화면 안에 다 보인다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await ctx.newPage();
  await page.goto('/');
  for (const name of ['1', '0', '지우기']) {
    const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(390);
  }
  await ctx.close();
});

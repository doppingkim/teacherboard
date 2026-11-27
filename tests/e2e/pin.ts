// 가족 비밀번호 시험 도우미. PIN은 시험 서버(pinServer.ts)에만 보낸다.
import { expect, type Page } from '@playwright/test';
import { TEST_PIN, TEST_SERVER_HEADER } from './testPin';

export { TEST_PIN };

/** /api가 시험 서버로 가는지 확인한다(다른 개발 서버를 재사용했으면 PIN을 보내기 전에 멈춘다). */
export async function assertTestServer(page: Page): Promise<void> {
  const r = await page.request.get('/api/pin');
  if (r.headers()[TEST_SERVER_HEADER] !== '1') {
    throw new Error('e2e /api가 시험용 PIN 서버가 아닌 곳으로 갑니다. 다른 vite가 그 포트에 떠 있으면 PW_PORT를 바꿔 주세요');
  }
}

/** 시험 서버에 TEST_PIN을 보내 이 컨텍스트에 쿠키를 받아 둔다. */
export async function unlock(page: Page): Promise<void> {
  await assertTestServer(page);
  const r = await page.request.post('/api/pin', { data: { pin: TEST_PIN } });
  expect(r.status()).toBe(204);
}

/** 쿠키를 받은 뒤 path로 간다(PIN 화면 없이 바로 프로필 화면). */
export async function gotoUnlocked(page: Page, path = '/'): Promise<void> {
  await unlock(page);
  await page.goto(path);
}

/** PIN 화면 숫자판을 누른다. */
export async function enterPin(page: Page, pin: string): Promise<void> {
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
}

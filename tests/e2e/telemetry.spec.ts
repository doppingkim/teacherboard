// 운영 계측(G1·H1): 브라우저가 수업 체감 시간과 오류를 /api/client-log로 보낸다(시험용 PIN 서버가 받는다). 화면은 바뀌지 않는다.
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { gotoUnlocked } from './pin';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const QUESTION = '달은 왜 나를 따라와?';

const isClientLog = (req: Request) => req.url().endsWith('/api/client-log') && req.method() === 'POST';
type Ev = Record<string, unknown>;
const eventsOf = (req: Request): Ev[] => (req.postDataJSON() as { events: Ev[] }).events;

async function ask(page: Page) {
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill(QUESTION);
  await page.getByRole('button', { name: '물어보기' }).click();
}

test('수업이 끝나면 체감 시간(첫 소리·첫 획·끝)을 보낸다 — 질문 원문 없이, 서버가 준 수업 id(x-lesson-id)를 실어, 서버가 204로 받는다', async ({ page }) => {
  await page.route('**/api/lesson', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-ndjson', headers: { 'x-lesson-id': 'Tq9_-k2Z' }, body: lessonNdjson }));
  await gotoUnlocked(page);
  const sent = page.waitForRequest((r) => isClientLog(r) && eventsOf(r).some((e) => e.kind === 'lesson'), { timeout: 30_000 });
  await ask(page);
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 });
  const req = await sent;
  const ev = eventsOf(req).find((e) => e.kind === 'lesson')!;
  expect(ev).toMatchObject({ lessonId: 'Tq9_-k2Z', qChars: 12, mode: expect.stringMatching(/quick|deep/), spoken: false, result: 'done', qKey: expect.stringMatching(/^[0-9a-f]{8}$/) });
  expect(ev.firstSoundMs).toEqual(expect.any(Number));
  expect(ev.firstStrokeMs).toEqual(expect.any(Number));
  expect(ev.endMs as number).toBeGreaterThanOrEqual(ev.firstStrokeMs as number);
  expect(req.postData()).not.toContain('달은');
  expect((await req.response())?.status()).toBe(204);
});

test('수업이 실패하면 앱 오류(where lesson)를 보낸다', async ({ page }) => {
  await page.route('**/api/lesson', (route) => route.abort('failed'));
  await gotoUnlocked(page);
  const sent = page.waitForRequest((r) => isClientLog(r) && eventsOf(r).some((e) => e.kind === 'app'), { timeout: 30_000 });
  await ask(page);
  const ev = eventsOf(await sent).find((e) => e.kind === 'app')!;
  expect(ev).toMatchObject({ where: 'lesson', count: 1, state: expect.any(String), ua: expect.any(String) });
  expect(JSON.stringify(ev)).not.toContain('달은');
});

test('잡히지 않은 오류도 보낸다', async ({ page }) => {
  await gotoUnlocked(page);
  const sent = page.waitForRequest((r) => isClientLog(r) && eventsOf(r).some((e) => e.kind === 'error'), { timeout: 30_000 });
  await page.evaluate(() => setTimeout(() => { throw new Error('e2e uncaught'); }, 0));
  const ev = eventsOf(await sent).find((e) => e.kind === 'error')!;
  expect(ev.message).toContain('e2e uncaught');
});

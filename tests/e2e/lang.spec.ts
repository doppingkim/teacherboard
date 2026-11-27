// 화면 언어: 브라우저 언어를 따르고, 버튼으로 바꾸면 기억한다. 영어 화면은 수업 요청에 lang: 'en'을 싣는다.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { gotoUnlocked } from './pin';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');

test.describe('영어 브라우저', () => {
  test.use({ locale: 'en-US' });

  test('English screens, and the lesson request carries lang: en', async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/lesson', (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lessonNdjson });
    });
    await gotoUnlocked(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByText("Who's asking?")).toBeVisible();
    await page.getByRole('button', { name: '🧒 Kid' }).click();
    await page.getByRole('textbox', { name: 'Question' }).fill('Why does the moon follow me?');
    await page.getByRole('button', { name: 'Ask!' }).click();
    await expect(page.locator('.subtitle')).toHaveText('Anything else you wonder about?', { timeout: 20000 });
    expect(bodies[0]).toMatchObject({ question: 'Why does the moon follow me?', profile: 'kid', lang: 'en' });
  });

  test('the language button switches to Korean and is remembered', async ({ page }) => {
    await gotoUnlocked(page);
    await page.locator('.lang-overlay').click(); // 프로필 화면이 위쪽 띠를 덮으므로 화면 구석 버튼
    await expect(page.getByText('누가 물어볼까?')).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  });
});

test('한국어 화면은 lang을 보내지 않는다(예전 서버와 같은 요청)', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/lesson', (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lessonNdjson });
  });
  await gotoUnlocked(page, '/?lang=ko');
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].lang).toBeUndefined();
});

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoUnlocked } from './pin';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const silenceB64 = readFileSync(new URL('../fixtures/silence.mp3', import.meta.url)).toString('base64');

/** 실제 API 없이: /api/lesson은 픽스처, /api/filler/kid는 무음 한 개(lesson.spec.ts와 같은 방식). */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/lesson', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lessonNdjson }));
  await page.route('**/api/filler/kid', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        audioBase64: silenceB64, mime: 'audio/mpeg', durationMs: 300,
        timing: { chars: ['음'], startMs: [0], endMs: [300] },
      }]),
    }));
}

for (const vp of [{ width: 1280, height: 800 }, { width: 844, height: 390 }]) {
  test(`겹침 없음 ${vp.width}x${vp.height}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    await mockApi(page);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    const board = await page.locator('.board').boundingBox();
    const ask = await page.locator('form.ask').boundingBox();
    expect(board && ask).toBeTruthy();
    expect(ask!.y).toBeGreaterThanOrEqual(board!.y + board!.height); // 질문창은 보드 아래
    expect(ask!.y + ask!.height).toBeLessThanOrEqual(vp.height); // 화면 안
    expect(board!.y).toBeGreaterThanOrEqual(0);
    await ctx.close();
  });
}

test('휴대폰 가로에서 로고·프로필 칩이 보드와 겹치지 않는다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await ctx.newPage();
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  const board = (await page.locator('.board').boundingBox())!;
  const chip = page.getByRole('button', { name: /프로필 바꾸기/ });
  await expect(chip).toBeVisible();
  for (const box of [await page.locator('.topbar .logo').boundingBox(), await chip.boundingBox()]) {
    expect(box).toBeTruthy();
    const apart =
      box!.x + box!.width <= board.x || box!.x >= board.x + board.width ||
      box!.y + box!.height <= board.y || box!.y >= board.y + board.height;
    expect(apart, `${JSON.stringify(box)} vs board ${JSON.stringify(board)}`).toBe(true);
  }
  await ctx.close();
});

// 로고는 말풍선 줄 왼쪽 빈자리에 앉는다(따로 줄을 두지 않아 칠판이 위로 올라온다). 두 줄짜리 말풍선도 로고를 덮지 않아야 한다.
for (const vp of [{ width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 844, height: 390 }]) {
  test(`긴 말풍선이 로고와 겹치지 않는다 ${vp.width}x${vp.height}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    await mockApi(page);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await page.evaluate(() => {
      document.querySelector('.subtitle > span')!.textContent =
        '구름 속 강한 바람이 이 알갱이들을 위아래로 마구 흔들어. 그러면서 얼음 알갱이가 점점 커지는 거야.';
    });
    const logo = (await page.locator('.topbar .logo').boundingBox())!;
    const bubble = (await page.locator('.subtitle > span').boundingBox())!;
    const board = (await page.locator('.board').boundingBox())!;
    const apart =
      logo.x + logo.width <= bubble.x || logo.x >= bubble.x + bubble.width ||
      logo.y + logo.height <= bubble.y || logo.y >= bubble.y + bubble.height;
    expect(apart, `logo ${JSON.stringify(logo)} vs bubble ${JSON.stringify(bubble)}`).toBe(true);
    expect(bubble.y + bubble.height).toBeLessThanOrEqual(board.y + 2); // 말풍선은 칠판 위
    await ctx.close();
  });
}

test('밤하늘 배경', async ({ page }) => {
  await gotoUnlocked(page);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(52, 58, 82)');
});

test('프로필 칩으로 프로필 바꾸기', async ({ page }) => {
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('button', { name: /프로필 바꾸기/ }).click();
  await expect(page.getByRole('button', { name: '🙂 어른' })).toBeVisible();
});

const LONG_SAY = '구름 속 강한 바람이 이 알갱이들을 위아래로 마구 흔들어. 그러면서 얼음 알갱이가 점점 커지는 거야. 아주 아주 길게 이어지는 말이야.';

// QA 2026-11-22: 두 줄로 자른 말풍선 아래 여백에 셋째 줄 윗부분이 비쳐 보였다(아이패드 사파리에서 뚜렷).
for (const vp of [{ width: 820, height: 1180 }, { width: 1180, height: 820 }, { width: 568, height: 320 }]) {
  test(`말풍선은 둘째 줄까지만 보이고 셋째 줄이 비치지 않는다 ${vp.width}x${vp.height}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    await mockApi(page);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    const r = await page.evaluate((say) => {
      const span = document.querySelector('.subtitle > span')! as HTMLElement;
      span.textContent = say + ' ' + say; // 셋째 줄이 반드시 생기게
      const cs = getComputedStyle(span);
      // overflow:hidden은 안쪽 여백 가장자리에서 자른다: 자르는 칸 높이가 두 줄 높이를 넘으면 셋째 줄 윗부분이 보인다
      return { clip: span.clientHeight, lines: 2 * parseFloat(cs.lineHeight), scroll: span.scrollHeight };
    }, LONG_SAY);
    expect(r.scroll, JSON.stringify(r)).toBeGreaterThan(r.lines + 1); // 정말 넘치는 글
    expect(r.clip, JSON.stringify(r)).toBeLessThanOrEqual(r.lines + 1);
    await ctx.close();
  });
}

// QA 2026-11-22: 노치·다이내믹 아일랜드 휴대폰 가로(safe-area 왼쪽 59px)에서 로고가 오른쪽으로 밀려 긴 말풍선에 가렸고,
// 질문창이 홈 막대 자리(아래 21px)까지 내려갔다. 크로뮴만 safe-area를 흉내 낼 수 있다.
test('노치 휴대폰 가로: 로고가 말풍선에 안 가리고 질문창은 홈 막대 위', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'safe-area 흉내는 크로뮴 CDP만');
  const vp = { width: 844, height: 390 };
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { left: 59, right: 59, top: 0, bottom: 21 } } as never);
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.evaluate((say) => { document.querySelector('.subtitle > span')!.textContent = say; }, LONG_SAY);
  const logo = (await page.locator('.topbar .logo').boundingBox())!;
  const bubble = (await page.locator('.subtitle > span').boundingBox())!;
  const ask = (await page.locator('form.ask').boundingBox())!;
  const board = (await page.locator('.board').boundingBox())!;
  expect(logo.x).toBeGreaterThanOrEqual(59); // safe-area가 정말 걸렸다
  const apart =
    logo.x + logo.width <= bubble.x || logo.x >= bubble.x + bubble.width ||
    logo.y + logo.height <= bubble.y || logo.y >= bubble.y + bubble.height;
  expect(apart, `logo ${JSON.stringify(logo)} vs bubble ${JSON.stringify(bubble)}`).toBe(true);
  expect(ask.y + ask.height).toBeLessThanOrEqual(vp.height - 21);
  expect(ask.y).toBeGreaterThanOrEqual(board.y + board.height);
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(board.y + 2);
  await ctx.close();
});

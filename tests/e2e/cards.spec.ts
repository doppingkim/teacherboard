// 수업 흐름(2026-11-23 craft): E1 기다림(질문을 칠판에 먼저 씀), E2 이어 묻기 카드. (A1 예시 카드는 사용자 결정으로 뺐다 — 빈 칠판은 문구 한 줄.)
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoUnlocked } from './pin';

const moon = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const NEXT_QS = ['달은 왜 모양이 바뀌어?', '달에도 바람이 불어?', '해도 나를 따라와?'];
/** 픽스처 수업 + 끝에 이어 물을 질문(서버는 done 바로 앞에 보낸다). */
const withNext = moon.replace(/^(\{"type":"done"\})/m, `${JSON.stringify({ type: 'next', questions: NEXT_QS })}\n$1`);

type Body = { question: string; context?: { previousQuestion: string; spoken: string[]; interrupted?: boolean } };

/** /api/lesson을 body로 돌려준다(delayMs 뒤). 보낸 요청 본문을 모은다. */
async function mockLesson(page: Page, body: string, delayMs = 0): Promise<Body[]> {
  const bodies: Body[] = [];
  await page.route('**/api/lesson', async (route) => {
    bodies.push(route.request().postDataJSON());
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body }).catch(() => {});
  });
  return bodies;
}

const VPS = [
  { name: '아이패드 가로', width: 1180, height: 820 },
  { name: '아이패드 세로', width: 820, height: 1180 },
  { name: '휴대폰 가로', width: 844, height: 390 },
  { name: '휴대폰 세로', width: 390, height: 844 },
];

type Box = { x: number; y: number; width: number; height: number };
const inside = (a: Box, b: Box) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
const apart = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

/** 카드가 모두 판서 면 안에, 아이 손가락으로 누를 만큼(44px 이상), 서로 겹치지 않게, 맨 위에서 눌리는지. */
async function expectCardsUsable(page: Page, n: number): Promise<Box[]> {
  const cards = page.locator('.q-card');
  await expect(cards).toHaveCount(n);
  await page.waitForTimeout(700); // 붙는 애니메이션
  const surface = (await page.locator('.board .surface').boundingBox())!;
  const boxes: Box[] = [];
  for (let i = 0; i < n; i++) {
    const b = (await cards.nth(i).boundingBox())!;
    expect(b.height, `카드 ${i} 높이`).toBeGreaterThanOrEqual(44);
    expect(b.width, `카드 ${i} 폭`).toBeGreaterThanOrEqual(44);
    expect(inside(b, surface), `카드 ${i} ${JSON.stringify(b)} 가 칠판 ${JSON.stringify(surface)} 밖`).toBe(true);
    // 카드 가운데를 누르면 그 카드가 받는다(다른 층에 가리지 않음)
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.q-card')?.textContent ?? null, [b.x + b.width / 2, b.y + b.height / 2]);
    expect(hit).toBe(await cards.nth(i).textContent());
    boxes.push(b);
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(apart(boxes[i], boxes[j]), `카드 ${i}·${j} 겹침`).toBe(true);
  return boxes;
}

for (const vp of VPS) {
  test(`E2 이어 묻기 카드가 판서를 가리지 않고 칠판 안에서 누를 수 있다 — ${vp.name}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await mockLesson(page, withNext);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
    await page.getByRole('textbox').press('Enter');
    await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 30000 });
    const boxes = await expectCardsUsable(page, 3);
    await expect(page.locator('.q-card-text')).toHaveText(NEXT_QS);
    await page.waitForTimeout(700); // 판서가 줄어드는 동안
    // 판서(글씨·그림 선)는 모두 카드 띠 위에 있다
    const cardTop = Math.min(...boxes.map((b) => b.y));
    const inkBottom = await page.evaluate(() => {
      let bottom = -Infinity;
      for (const el of document.querySelectorAll('.board svg.ink-layer .ink path, .board svg.ink-layer .ink text')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) bottom = Math.max(bottom, r.bottom);
      }
      return bottom;
    });
    expect(inkBottom).toBeLessThanOrEqual(cardTop + 1);
    await ctx.close();
  });
}

test('E2: 이어 묻기 카드를 누르면 앞 수업 문맥(interrupted: false)과 함께 그 질문으로 수업한다 — 시간이 지나도', async ({ page }) => {
  const bodies = await mockLesson(page, withNext);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 30000 });
  // 이어 묻기 창(2분)을 넘겨도 카드는 이어 묻는 것: 시계를 5분 앞으로
  await page.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 5 * 60_000; });
  await page.getByRole('button', { name: '해도 나를 따라와?' }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].question).toBe('해도 나를 따라와?');
  expect(bodies[1].context?.previousQuestion).toBe('달은 왜 나를 따라와?');
  expect(bodies[1].context?.interrupted).toBe(false);
  expect(bodies[1].context?.spoken.length).toBeGreaterThan(0);
  await expect(page.locator('.q-card')).toHaveCount(0);
});

test('E2: 서버가 이어 물을 질문을 안 보내면 카드 없이 지금처럼 끝나고 판서도 줄지 않는다', async ({ page }) => {
  await mockLesson(page, moon);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 30000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.q-card')).toHaveCount(0);
  expect(await page.locator('.board .surface').evaluate((el) => getComputedStyle(el).getPropertyValue('--room').trim())).toMatch(/^0(\.0+)?$/);
});

test('E1: 기다리는 동안 질문을 칠판에 먼저 쓰고, 수업이 시작되면 걷힌다(제목만 남음)', async ({ page }) => {
  await mockLesson(page, withNext, 3000);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  const q = page.locator('.board svg text', { hasText: '달은 왜 나를 따라와?' });
  await expect(q).toHaveCount(1);
  await expect(page.locator('.thinking-card')).toBeVisible();
  await expect(page.locator('.thinking-card')).toHaveClass(/with-question/);
  // 질문 글씨는 생각 중 문구보다 위에 있다(겹치지 않음)
  await page.waitForTimeout(1800);
  const qBox = (await q.boundingBox())!;
  const tBox = (await page.locator('.thinking-text').boundingBox())!;
  expect(qBox.y + qBox.height).toBeLessThanOrEqual(tBox.y);
  // 준비하는 모습: 마커가 문구 아래에 낙서를 끄적인다
  await expect(page.locator('.board .waiting-doodle').first()).toBeAttached({ timeout: 3000 });
  // 수업이 시작되면 질문·낙서는 걷히고, 끝나면 칠판에는 수업 제목만
  await expect(page.locator('.thinking-card')).toBeHidden({ timeout: 10000 });
  await expect(q).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('.board .waiting-doodle')).toHaveCount(0);
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 30000 });
  await expect(page.locator('.board svg text', { hasText: '달은 왜 나를 따라올까?' })).toHaveCount(1);
});

test('E1: 긴 질문은 두 줄로(줄임표) 칠판 안에 쓴다', async ({ page }) => {
  await mockLesson(page, withNext, 3000);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('우리 집 강아지는 왜 밤마다 창문 밖을 보면서 짖고 꼬리를 흔들고 빙글빙글 돌까요 정말 궁금해요');
  await page.getByRole('textbox').press('Enter');
  const lines = page.locator('.board svg .waiting-q text');
  await expect(lines).toHaveCount(2);
  const surface = (await page.locator('.board .surface').boundingBox())!;
  await page.waitForTimeout(1900);
  for (let i = 0; i < 2; i++) expect(inside((await lines.nth(i).boundingBox())!, surface)).toBe(true);
  await expect(lines.nth(1)).toHaveText(/…$/);
});

test('빈 칠판에는 문구 한 줄만 — 예시 카드 없음(처음, 그리고 한 문장도 못 하고 오류로 끝난 뒤)', async ({ page }) => {
  await page.route('**/api/lesson', (route) => route.abort('failed'));
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await expect(page.locator('.board svg text', { hasText: '궁금한 거 물어봐!' })).toHaveCount(1);
  await expect(page.locator('.q-card')).toHaveCount(0);
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('.subtitle')).toHaveText('앗, 잠깐 문제가 생겼어. 다시 물어봐 줄래?', { timeout: 10000 });
  await expect(page.locator('.board svg text', { hasText: '궁금한 거 물어봐!' })).toHaveCount(1, { timeout: 3000 });
  await expect(page.locator('.q-card')).toHaveCount(0);
  await expect(page.locator('.board svg text', { hasText: '달은 왜 나를 따라와?' })).toHaveCount(0, { timeout: 3000 });
});

test('카드 글은 글자로만 보인다(모델이 만든 질문의 마크업을 해석하지 않음)', async ({ page }) => {
  const evil = '<img src=x onerror="window.__xss=1">';
  // 파서가 거르지만, 브라우저도 글자로만 넣는지 따로 본다(서버를 거치지 않은 메시지)
  const body = moon.replace(/^(\{"type":"done"\})/m, `${JSON.stringify({ type: 'next', questions: [evil] })}\n$1`);
  await mockLesson(page, body);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('.q-card-text')).toHaveText([evil], { timeout: 30000 });
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('.board img').count()).toBe(0);
});

// QA 2026-11-23(lesson-flow): 상태 전이.
test('생각 중에 PIN이 만료되거나(401) 프로필을 바꾸면 질문 글씨·낙서·문구가 멈추고 걷힌다(덮인 화면 뒤에서 계속 그리지 않음)', async ({ page }) => {
  let n = 0;
  await page.route('**/api/lesson', async (route) => {
    n++;
    if (n === 1) {
      await new Promise((r) => setTimeout(r, 2500));
      return route.fulfill({ status: 401, body: '{}' }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 20_000));
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: withNext }).catch(() => {});
  });
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('.board .waiting-q')).toHaveCount(1);
  await expect(page.locator('.overlay')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.thinking-card')).toBeHidden({ timeout: 2000 });
  await expect(page.locator('.board .waiting')).toHaveCount(0, { timeout: 2000 });
  await page.waitForTimeout(2500);
  await expect(page.locator('.board .waiting-doodle')).toHaveCount(0); // 새 낙서가 생기지 않는다
});

test('생각 중에 프로필을 바꾸면 기다림이 걷힌다', async ({ page }) => {
  await mockLesson(page, withNext, 20_000);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('.board .waiting-q')).toHaveCount(1);
  await page.getByRole('button', { name: /프로필 바꾸기/ }).click();
  await expect(page.locator('.thinking-card')).toBeHidden({ timeout: 2000 });
  await expect(page.locator('.board .waiting')).toHaveCount(0, { timeout: 2000 });
  await page.waitForTimeout(2500);
  await expect(page.locator('.board .waiting-doodle')).toHaveCount(0);
});

test('키보드로 카드를 누르면 초점이 칠판으로 간다(body로 떨어지지 않음)', async ({ page }) => {
  await mockLesson(page, withNext);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('.q-cards-next .q-card').first()).toBeVisible({ timeout: 30000 });
  await page.locator('.q-card').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.q-card')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('board') ?? false)).toBe(true);
});

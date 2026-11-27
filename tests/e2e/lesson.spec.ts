import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoUnlocked } from './pin';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const silenceB64 = readFileSync(new URL('../fixtures/silence.mp3', import.meta.url)).toString('base64');

/** 실제 API 없이: /api/lesson은 픽스처, /api/filler/kid는 무음 한 개. */
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

test('수업이 끝까지 판서된다', async ({ page }) => {
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 });
  expect(await page.locator('svg .ink path').count()).toBeGreaterThanOrEqual(10);
  await expect(page.locator('svg text', { hasText: '달은 왜 나를 따라올까?' })).toHaveCount(1);
});

test('수업이 끝난 직후 물으면 앞 수업 문맥을 interrupted: false로 보낸다', async ({ page }) => {
  await mockApi(page);
  const bodies: Array<{ question: string; context?: { previousQuestion: string; spoken: string[]; interrupted?: boolean } }> = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/lesson') && req.method() === 'POST') bodies.push(req.postDataJSON());
  });
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 });
  await page.getByRole('textbox').fill('그럼 해는?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0].context).toBeUndefined();
  expect(bodies[1].question).toBe('그럼 해는?');
  expect(bodies[1].context?.previousQuestion).toBe('달은 왜 나를 따라와?');
  expect(bodies[1].context?.interrupted).toBe(false);
  expect(bodies[1].context?.spoken.length).toBeGreaterThan(0);
});

test('서버가 보낸 오류 문구를 자막에 보여 준다', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/lesson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'error', message: '이 질문은 수업으로 만들 수 없어요. 다른 걸 물어봐 줄래?' }) + '\n',
    }));
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('무서운 이야기 해 줘');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.locator('.subtitle')).toHaveText('이 질문은 수업으로 만들 수 없어요. 다른 걸 물어봐 줄래?', { timeout: 10000 });
});

test('네트워크 오류면 기본 오류 문구', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/lesson', (route) => route.abort('failed'));
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.locator('.subtitle')).toHaveText('앗, 잠깐 문제가 생겼어. 다시 물어봐 줄래?', { timeout: 10000 });
});

test('저장소를 못 써도(사생활 보호·용량 초과) 고른 수준·선생님으로 묻는다', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
  });
  await mockApi(page);
  const bodies: Array<{ level?: string; mode?: string }> = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/lesson') && req.method() === 'POST') bodies.push(req.postDataJSON());
  });
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('radio', { name: '깊게' }).click();
  await page.getByRole('radio', { name: '신중한 선생님' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ mode: 'deep', level: 'adult' });
  await expect(page.getByRole('radio', { name: '깊게' })).toHaveAttribute('aria-checked', 'true');
});

test('빠르게 거듭 물으면 앞 요청은 끊기고 마지막 수업만 끝까지 간다', async ({ page }) => {
  const failed: string[] = [];
  page.on('requestfailed', (r) => {
    if (r.url().endsWith('/api/lesson')) failed.push(r.postDataJSON().question);
  });
  await page.route('**/api/lesson', async (route) => {
    const q = route.request().postDataJSON().question as string;
    await new Promise((r) => setTimeout(r, 600));
    const body = JSON.stringify({ type: 'say', id: 1, text: `답-${q}`, speech: null }) + '\n' + JSON.stringify({ type: 'done' }) + '\n';
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body }).catch(() => {});
  });
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  const box = page.getByRole('textbox');
  for (const q of ['하나', '둘', '셋']) {
    await box.fill(q);
    await box.press('Enter');
  }
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 10000 });
  expect(failed).toEqual(['하나', '둘']);
  await expect(page.locator('.thinking-card')).toBeHidden();
});

test('글자로 물을 때(터치 안) 멈춘 Web Audio를 다시 깨운다(iOS: 전화·잠금 뒤 소리가 작은 <audio>로만 나던 문제)', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __resumes: number };
    w.__resumes = 0;
    const orig = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function (this: AudioContext) {
      w.__resumes++;
      return orig.call(this);
    };
  });
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => (window as unknown as { __resumes: number }).__resumes);
  test.skip(before === 0, '이 브라우저 빌드에는 Web Audio가 없다(<audio>로만 튼다)');
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  // 수업 재생(play)도 멈춘 컨텍스트면 resume을 부르지만, 돌고 있는 컨텍스트에서 늘었다면 그건 물어보기 터치의 몫이다
  await expect.poll(() => page.evaluate(() => (window as unknown as { __resumes: number }).__resumes)).toBeGreaterThan(before);
});

test('PIN이 만료돼 수업 요청이 401이면 PIN 화면으로 돌아간다', async ({ page }) => {
  await page.route('**/api/lesson', (route) => route.fulfill({ status: 401, body: '' }));
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.getByText('가족 비밀번호를 눌러 줘')).toBeVisible();
});

test('질문·대사·오류 문구의 HTML은 글자로만 보인다(XSS)', async ({ page }) => {
  const evil = '<img src=x onerror="window.__xss=1">';
  await page.route('**/api/lesson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'say', id: 1, text: evil, speech: null }) + '\n' + JSON.stringify({ type: 'error', message: evil }) + '\n',
    }));
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill(evil);
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.locator('.subtitle')).toHaveText(evil, { timeout: 10000 });
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('img').count()).toBe(0);
});

test('서버가 바쁘면(429 busy) 잠깐 뒤에 다시 물어 달라고 한다', async ({ page }) => {
  await page.route('**/api/lesson', (route) =>
    route.fulfill({ status: 429, headers: { 'retry-after': '5' }, contentType: 'application/json', body: '{"error":"busy"}' }));
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.locator('.subtitle')).toHaveText('지금 다른 수업이 한창이야. 잠깐 뒤에 다시 물어봐 줄래?', { timeout: 10000 });
  await expect(page.locator('.thinking-card')).toBeHidden();
});

// A4(2026-11-23): 휴대폰 세로도 세로 전용 배치로 바로 쓴다(돌려 달라는 안내를 없앴다). 배치는 layout-orient.spec.ts.
test('휴대폰 세로 화면도 돌려 달라고 하지 않고 바로 쓴다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await gotoUnlocked(page);
  await expect(page.getByText('가로로 돌려 줘!')).toBeHidden();
  await expect(page.getByRole('button', { name: '🧒 아이' })).toBeVisible();
  await ctx.close();
});

test('휴대폰 가로 화면이면 안내가 없다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await ctx.newPage();
  await gotoUnlocked(page);
  await expect(page.getByText('가로로 돌려 줘!')).toBeHidden();
  await ctx.close();
});

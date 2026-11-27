// 마이크를 못 쓰는 경우와 처음 쓰는 기기(A2) — 가짜 허락 창 플래그 없이(chromium 전용). 글자 질문은 언제나 된다.
// 처음 쓰는 기기(이 기기에서 마이크가 열린 적 없음 + 권한이 아직 없음)는 바로 허락 창을 띄우지 않고 "말로 물어볼래?" 버튼을 보인다.
// 누르면 허락 창(getUserMedia). 거절되면 칩은 차분한 중립색 '허락 필요'(경고 색이 아님).
// 참고: 헤드리스 chromium은 허락 창을 띄울 수 없어서, 권한이 없으면 getUserMedia가 NotAllowedError가 아니라
// NotSupportedError("Not supported")로 거절한다(mic.ts가 이것도 'denied'로 본다). 그래서 진짜 거절(NotAllowedError)과
// 장치 없음(NotFoundError)은 getUserMedia를 바꿔 끼워 따로 시험한다.
import { expect, test, type Page } from '@playwright/test';
import { mockApi, mockListen } from './voiceMocks';
import { gotoUnlocked } from './pin';

test.skip(({ browserName }) => browserName !== 'chromium', '음성 화면 시험은 chromium만');
test.use({ permissions: [] });

/** getUserMedia 부른 횟수를 window.__gum에 센다(rejectAs면 그 이름으로 거절). */
async function countGum(page: Page, rejectAs?: string): Promise<void> {
  await page.addInitScript((n) => {
    const w = window as unknown as { __gum: number };
    w.__gum = 0;
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      w.__gum++;
      return n ? Promise.reject(new DOMException('stub', n)) : orig(c);
    };
  }, rejectAs ?? '');
}
const gum = (page: Page) => page.evaluate(() => (window as unknown as { __gum: number }).__gum);
/** 이 기기에서 마이크가 열린 적이 있다(main.ts MIC_OK_KEY). */
const seenMicBefore = (page: Page) => page.addInitScript(() => localStorage.setItem('teacherboard.micOk', '1'));
const tokenColor = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement('i');
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

async function textStillWorks(page: Page, lessons: unknown[]): Promise<void> {
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 });
  expect(lessons).toHaveLength(1);
}

test('처음 쓰는 기기: 경고 대신 "말로 물어볼래?" — 누르기 전에는 허락 창(getUserMedia)을 열지 않는다', async ({ page }) => {
  await countGum(page);
  const api = await mockApi(page);
  const listen = await mockListen(page, 'accept');
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  const ask = page.getByRole('button', { name: '말로 물어볼래?' });
  await expect(ask).toBeVisible();
  await expect(ask).toHaveAccessibleDescription(/허락 창/);
  await expect(page.locator('.mic-more')).toBeHidden(); // 버튼 하나로
  const primary = await tokenColor(page, '--c-primary');
  await expect.poll(() => page.locator('.mic-pill').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(primary);
  await page.waitForTimeout(500);
  expect(await gum(page)).toBe(0);
  expect(listen.sockets).toHaveLength(0);
  await textStillWorks(page, api.lessons); // 마이크 없이도 글로 묻는다
  expect(await gum(page)).toBe(0);
});

test('처음 쓰는 기기: 누르면 허락 창 → 거절이면 차분한 "허락 필요"(경고 색 아님) + 글자 질문', async ({ page }) => {
  await countGum(page, 'NotAllowedError');
  const api = await mockApi(page);
  const listen = await mockListen(page, 'accept');
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('button', { name: '말로 물어볼래?' }).click();
  const pill = page.getByRole('button', { name: '마이크 허락 필요' });
  await expect(pill).toBeVisible();
  expect(await gum(page)).toBe(1);
  await expect(page.locator('.mic-label')).toHaveText('허락 필요');
  const neutral = await tokenColor(page, '--c-neutral');
  await expect.poll(() => page.locator('.mic-pill').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(neutral);
  const bg = await page.locator('.mic-pill').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bg).not.toBe(await tokenColor(page, '--c-warn'));
  await expect(pill).toHaveAccessibleDescription(/글로 물어봐도/);
  expect(listen.sockets).toHaveLength(0);
  // 다음에 와도 다시 "말로 물어볼래?"(허락을 받은 적이 없다)
  expect(await page.evaluate(() => localStorage.getItem('teacherboard.micOk'))).toBeNull();
  await textStillWorks(page, api.lessons);
});

test('권한 없음(헤드리스 거절) → 허락 필요 + 글자 질문으로 수업', async ({ page }) => {
  const api = await mockApi(page);
  const listen = await mockListen(page, 'accept');
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('button', { name: '말로 물어볼래?' }).click();
  await expect(page.getByRole('button', { name: '마이크 허락 필요' })).toBeVisible({ timeout: 10000 });
  expect(listen.sockets).toHaveLength(0); // 마이크가 없으면 듣기 연결도 안 연다
  await textStillWorks(page, api.lessons);
});

for (const name of ['NotAllowedError', 'NotFoundError']) {
  test(`마이크를 쓴 적 있는 기기: 프로필을 누르면 바로 열고, getUserMedia ${name} → 허락 필요 + 글자 질문`, async ({ page }) => {
    await seenMicBefore(page);
    await countGum(page, name);
    const api = await mockApi(page);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '마이크 허락 필요' })).toBeVisible({ timeout: 10000 });
    expect(await gum(page)).toBe(1);
    await textStillWorks(page, api.lessons);
  });
}

test('거부 상태에서 칩을 누르면 다시 열어 본다', async ({ page }) => {
  await seenMicBefore(page);
  await countGum(page, 'NotAllowedError');
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('button', { name: '마이크 허락 필요' }).click();
  await expect.poll(() => gum(page)).toBe(2);
  await expect(page.getByRole('button', { name: '마이크 허락 필요' })).toBeVisible();
});

test('여는 중에는 흐린 모양이고, 실제로 거절된 뒤에야 허락 필요', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((_, reject) => setTimeout(() => reject(new DOMException('stub', 'NotAllowedError')), 1500));
  });
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('button', { name: '말로 물어볼래?' }).click();
  const pill = page.locator('.mic-pill');
  await expect(pill).toHaveAttribute('aria-busy', 'true');
  await expect(pill).toHaveAttribute('data-pending', '');
  await expect(page.locator('.mic-label')).toHaveText('말로 물어볼래?'); // 결과 전에는 '허락 필요'를 보이지 않는다
  await expect(page.getByRole('button', { name: '마이크 허락 필요' })).toBeVisible();
  await expect(pill).toHaveAttribute('aria-busy', 'false');
  await expect(pill).not.toHaveAttribute('data-pending');
});

test('안전하지 않은 주소(mediaDevices 없음) → 처음이어도 바로 허락 필요 모양 + https 안내', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'mediaDevices', { get: () => undefined, configurable: true });
  });
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  const pill = page.getByRole('button', { name: '마이크 허락 필요' });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('title', /https/);
  await expect(pill).toHaveAccessibleDescription(/https/);
});

test.describe('휴대폰 가로 844x390', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  for (const st of ['말로 물어볼래?', '허락 필요']) {
    test(`칩 문구(${st})가 다 보이고 입력칸은 200px 이상`, async ({ page }) => {
      await mockApi(page);
      await gotoUnlocked(page);
      await page.getByRole('button', { name: '🧒 아이' }).click();
      if (st === '허락 필요') await page.getByRole('button', { name: '말로 물어볼래?' }).click();
      const label = page.locator('.mic-label');
      await expect(label).toHaveText(st, { timeout: 10000 });
      const pill = page.locator('.mic-pill');
      // 글자가 잘리지 않고 칩 안에 다 들어 있다
      expect(await label.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      const [lb, pb, ib, fb] = await Promise.all([
        label.boundingBox(), pill.boundingBox(), page.getByRole('textbox').boundingBox(), page.locator('form.ask').boundingBox(),
      ]);
      expect(lb!.x + lb!.width).toBeLessThanOrEqual(pb!.x + pb!.width);
      expect(ib!.width).toBeGreaterThanOrEqual(200);
      expect(fb!.x).toBeGreaterThanOrEqual(0);
      expect(fb!.x + fb!.width).toBeLessThanOrEqual(844);
    });
  }
});

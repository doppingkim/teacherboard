// 시각 언어(C1 글꼴 역할 · C3 색 토큰 · C4 펜 커서 · C5 마이크 칩 줄)와 작은 접근성(스위치 방향키 · 프로필 뒤 초점).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoUnlocked } from './pin';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const silenceB64 = readFileSync(new URL('../fixtures/silence.mp3', import.meta.url)).toString('base64');

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/lesson', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lessonNdjson }));
  await page.route('**/api/filler/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        audioBase64: silenceB64, mime: 'audio/mpeg', durationMs: 300,
        timing: { chars: ['음'], startMs: [0], endMs: [300] },
      }]),
    }));
}

async function enter(page: Page): Promise<void> {
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await expect(page.locator('.mic-pill')).toBeVisible();
}

/** :root 변수 값을 이 페이지에서 계산된 색(rgb(...))으로. */
const tokenColor = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement('i');
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
/** 배경색(색 전환 0.2s가 끝난 뒤의 값). */
const bg = async (page: Page, sel: string) => {
  const loc = page.locator(sel).first();
  await loc.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  return loc.evaluate((e) => getComputedStyle(e).backgroundColor);
};
const font = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).fontFamily);

test.describe('C3 색 토큰', () => {
  test('선택됨은 수준·선생님 스위치가 같은 한 색, 물어보기는 주 행동 색', async ({ page }) => {
    await enter(page);
    const selected = await tokenColor(page, '--c-selected');
    const primary = await tokenColor(page, '--c-primary');
    expect(selected).not.toBe(primary);
    expect(await bg(page, '.level-switch .mode-opt[aria-checked="true"]')).toBe(selected);
    expect(await bg(page, '.mode-switch:not(.level-switch) .mode-opt[aria-checked="true"]')).toBe(selected);
    // 다른 수준을 골라도 같은 색
    await page.getByRole('radio', { name: '깊게' }).click();
    expect(await bg(page, '.level-switch .mode-opt[aria-checked="true"]')).toBe(selected);
    await page.getByRole('radio', { name: '신중한 선생님' }).click();
    expect(await bg(page, '.mode-switch:not(.level-switch) .mode-opt[aria-checked="true"]')).toBe(selected);
    // 고르지 않은 것은 바탕이 없다
    expect(await bg(page, '.level-switch .mode-opt[aria-checked="false"]')).toBe('rgba(0, 0, 0, 0)');
    expect(await bg(page, '.ask-btn')).toBe(primary);
  });

  test('프로필 고르기 카드는 중립색, 시작 버튼은 주 행동 색', async ({ page }) => {
    await mockApi(page);
    await gotoUnlocked(page);
    const neutral = await tokenColor(page, '--c-neutral');
    expect(await bg(page, '.sticker-kid')).toBe(neutral);
    expect(await bg(page, '.sticker-adult')).toBe(neutral);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await page.getByRole('button', { name: /프로필 바꾸기/ }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: '시작' })).toBeVisible();
    expect(await bg(page, '.start-btn')).toBe(await tokenColor(page, '--c-primary'));
  });
});

test.describe('C1 글꼴 역할', () => {
  test('칠판은 Hi Melody, 화면 글씨(말풍선·버튼·스위치·마이크 칩·입력칸)는 역할 글꼴', async ({ page }) => {
    await enter(page);
    for (const sel of ['.ask-btn', '.mode-opt', '.mic-pill', '.ask-input', '.subtitle > span', '.topbar .logo']) {
      expect(await font(page, sel), sel).toMatch(/^"?Jua"?/);
    }
    const boardFont = await page.evaluate(() => {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      document.querySelector('.board svg.ink-layer')!.append(t);
      const f = getComputedStyle(t).fontFamily;
      t.remove();
      return f;
    });
    expect(boardFont).toMatch(/^"?Hi Melody"?/);
    const html = await font(page, 'body');
    expect(html).not.toMatch(/Pretendard/);
  });
});

test.describe('스위치 방향키(radiogroup)', () => {
  test('수준·선생님 스위치: 고른 것만 Tab으로 들어가고 ←→↑↓로 고른다', async ({ page }) => {
    await enter(page);
    const level = page.getByRole('radiogroup', { name: '설명 수준' });
    await expect(level.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(level.getByRole('radio', { name: '쉽게' })).toHaveAttribute('tabindex', '0');
    await level.getByRole('radio', { name: '쉽게' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(level.getByRole('radio', { name: '보통' })).toBeFocused();
    await expect(level.getByRole('radio', { name: '보통' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(level.getByRole('radio', { name: '깊게' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowRight'); // 끝에서 처음으로
    await expect(level.getByRole('radio', { name: '쉽게' })).toBeFocused();
    await page.keyboard.press('ArrowLeft'); // 처음에서 끝으로
    await expect(level.getByRole('radio', { name: '깊게' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(level.getByRole('radio', { name: '보통' })).toHaveAttribute('aria-checked', 'true');
    await expect(level.locator('[tabindex="0"]')).toHaveCount(1);
    // 저장도 된다(다시 들어와도 보통)
    expect(await page.evaluate(() => localStorage.getItem('teacherboard.level.kid'))).toBe('middle');

    const mode = page.getByRole('radiogroup', { name: '설명 방식' });
    await mode.getByRole('radio', { name: '빠른 선생님' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(mode.getByRole('radio', { name: '신중한 선생님' })).toBeFocused();
    await expect(mode.getByRole('radio', { name: '신중한 선생님' })).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('teacherboard.mode'))).toBe('deep');
  });
});

test('프로필을 고른 뒤 초점은 칠판(입력칸·body가 아님)', async ({ page }) => {
  await enter(page);
  const active = await page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName.toLowerCase()}.${a.className}` : '';
  });
  expect(active).toMatch(/^div\.board/);
  await expect(page.locator('.board')).toHaveAttribute('tabindex', '-1');
});

// QA 2026-11-23: 로고를 눌러 프로필 화면을 덮어도 Tab이 덮개 뒤 칠판 카드·질문창으로 넘어갔다(보이지 않는 버튼에 초점).
test('프로필 화면이 덮인 동안 Tab·화면 읽기는 뒤의 칠판 카드·질문창으로 가지 않고, 닫으면 돌아온다', async ({ page, browserName }) => {
  await enter(page);
  await expect(page.locator('form.ask')).toBeVisible();
  await page.getByRole('button', { name: /프로필 바꾸기/ }).click();
  await expect(page.getByRole('button', { name: '🙂 어른' })).toBeVisible();
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(tab);
    const where = await page.evaluate(() => {
      const a = document.activeElement;
      return !a || a === document.body || a.closest('.overlay') ? 'overlay' : `${a.tagName}.${a.className}`;
    });
    expect(where).toBe('overlay');
  }
  // 칠판(그 위 카드 포함)·질문창·스위치 기둥이 모두 inert(덮개를 띄울 때 카드를 치우든 말든)
  expect(
    await page.evaluate(() => ['.board', 'form.ask', '.side-left', '.side-right'].map((s) => !!document.querySelector(s)!.closest('[inert]'))),
  ).toEqual([true, true, true, true]);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await expect(page.locator('form.ask')).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll('#app [inert]').length)).toBe(0);
  await expect(page.locator('.board')).toBeFocused();
});

test.describe('C4 펜 커서', () => {
  for (const vp of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
    test(`작고, 펜촉이 쓰는 점에 있고 몸통은 오른쪽 아래로만(쓴 글씨 쪽을 덮지 않음) ${vp.width}x${vp.height}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: vp });
      const page = await ctx.newPage();
      await mockApi(page);
      await gotoUnlocked(page);
      await page.getByRole('button', { name: '🧒 아이' }).click();
      await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
      await page.getByRole('button', { name: /물어보기/ }).click();
      await page.waitForFunction(() => (document.querySelector('.pen') as SVGElement | null)?.style.opacity === '1', null, { timeout: 20000 });
      for (let i = 0; i < 6; i++) {
        const m = await page.evaluate(() => {
          const root = document.querySelector('.pen') as SVGGElement;
          const body = root.querySelector('.pen-body') as SVGGElement;
          const surf = document.querySelector('.board .surface')!.getBoundingClientRect();
          const ctm = root.getScreenCTM()!;
          const unit = surf.width / 1280; // 판서 좌표 1 = 화면 px
          // 몸통 윤곽의 실제 점들(getBoundingClientRect는 돌리기 전 상자의 모서리까지 넣어 느슨하다)
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const g of body.querySelectorAll<SVGGeometryElement>('path, rect')) {
            const m = g.getScreenCTM()!;
            const len = g.getTotalLength();
            for (let k = 0; k <= 60; k++) {
              const p = g.getPointAtLength((len * k) / 60).matrixTransform(m);
              x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
            }
          }
          const r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
          const cols = [...body.querySelectorAll<SVGGraphicsElement>('.pen-col')].map((e) => e.getBBox().width);
          return { visible: root.style.opacity === '1', nib: { x: ctm.e, y: ctm.f }, r: { x: r.x, y: r.y, w: r.width, h: r.height }, unit, surfW: surf.width, colW: Math.max(...cols) };
        });
        if (!m.visible) continue;
        const tol = 2 * m.unit; // 펠트 촉 둥근 끝(반올림)
        expect(m.r.x, JSON.stringify(m)).toBeGreaterThanOrEqual(m.nib.x - tol);
        expect(m.r.y, JSON.stringify(m)).toBeGreaterThanOrEqual(m.nib.y - tol);
        expect(m.r.w / m.surfW, '펜 폭').toBeLessThanOrEqual(0.09);
        expect(m.r.h / m.surfW, '펜 높이').toBeLessThanOrEqual(0.07);
        expect(m.colW, '몸통 대부분이 쓰는 색').toBeGreaterThanOrEqual(60);
        await page.waitForTimeout(150);
      }
      await ctx.close();
    });
  }
});

test.describe('C5 휴대폰 세로 질문창', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('위 줄 마이크 칩이 줄 폭을 채우고(빈 오른쪽 없음), 아래 줄은 입력칸 + 물어보기', async ({ page }) => {
    await enter(page);
    const form = (await page.locator('form.ask').boundingBox())!;
    // 처음 쓰는 기기("말로 물어볼래?": ▾ 없음)와 듣는 중·꺼짐(칩 + ▾) 모두
    const micRow = async () => {
      const pill = (await page.locator('.mic-pill').boundingBox())!;
      const more = await page.locator('.mic-more').boundingBox();
      return { x: pill.x, y: pill.y, width: (more ? more.x + more.width : pill.x + pill.width) - pill.x, height: pill.height };
    };
    let mic = await micRow();
    expect(mic.width).toBeGreaterThanOrEqual(form.width - 24);
    await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('.mic-pill')!;
      p.dataset.status = 'off';
      p.querySelector('.mic-label')!.textContent = '꺼짐';
    });
    mic = await micRow();
    const input = (await page.getByRole('textbox').boundingBox())!;
    const btn = (await page.locator('.ask-btn').boundingBox())!;
    expect(mic.width).toBeGreaterThanOrEqual(form.width - 24);
    expect(input.y).toBeGreaterThanOrEqual(mic.y + mic.height - 1);
    expect(Math.abs(input.y + input.height / 2 - (btn.y + btn.height / 2))).toBeLessThanOrEqual(3);
    expect(btn.x + btn.width).toBeLessThanOrEqual(form.x + form.width);
  });
});

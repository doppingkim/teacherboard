import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoUnlocked } from './pin';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const silenceB64 = readFileSync(new URL('../fixtures/silence.mp3', import.meta.url)).toString('base64');

/** 실제 API 없이: /api/lesson은 픽스처, /api/filler/kid는 무음 한 개(layout.spec.ts와 같은 방식). */
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

type Box = { x: number; y: number; width: number; height: number };
const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
const cx = (b: Box) => b.x + b.width / 2;

const LONG_SAY = '구름 속 강한 바람이 이 알갱이들을 위아래로 마구 흔들어. 그러면서 얼음 알갱이가 점점 커지는 거야.';

/** 수업 화면의 주요 조각 상자(긴 말풍선을 띄운 상태). */
async function boxes(page: Page): Promise<Record<string, Box>> {
  await page.evaluate((say) => { document.querySelector('.subtitle > span')!.textContent = say; }, LONG_SAY);
  const get = async (sel: string) => {
    const b = await page.locator(sel).boundingBox();
    expect(b, sel).toBeTruthy();
    return b!;
  };
  return {
    logo: await get('.topbar .logo'),
    bubble: await get('.subtitle > span'),
    board: await get('.board'),
    level: await get('[role=radiogroup][aria-label="설명 수준"]'),
    mode: await get('[role=radiogroup][aria-label="설명 방식"]'),
    ask: await get('form.ask'),
  };
}

const VIEWPORTS = [
  { name: '아이패드 가로', width: 1180, height: 820, portrait: false },
  { name: '아이패드 세로', width: 820, height: 1180, portrait: true },
  { name: '휴대폰 가로', width: 844, height: 390, portrait: false },
  { name: '휴대폰 세로', width: 390, height: 844, portrait: true },
  { name: '데스크톱', width: 1280, height: 800, portrait: false },
];

for (const vp of VIEWPORTS) {
  test(`${vp.name} ${vp.width}x${vp.height}: 조각들이 서로 겹치지 않고 화면 안에 있다`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await mockApi(page);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('textbox')).toBeVisible();
    const b = await boxes(page);
    const names = Object.keys(b);
    for (const n of names) {
      const r = b[n];
      expect(r.x, `${n} ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(0);
      expect(r.y, `${n} ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, `${n} ${JSON.stringify(r)}`).toBeLessThanOrEqual(vp.width);
      expect(r.y + r.height, `${n} ${JSON.stringify(r)}`).toBeLessThanOrEqual(vp.height);
    }
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++)
        expect(apart(b[names[i]], b[names[j]]), `${names[i]} ${JSON.stringify(b[names[i]])} vs ${names[j]} ${JSON.stringify(b[names[j]])}`).toBe(true);

    // 차례: 말풍선 → 칠판 → (세로면 스위치 줄) → 질문창
    expect(b.bubble.y + b.bubble.height).toBeLessThanOrEqual(b.board.y + 2);
    expect(b.ask.y).toBeGreaterThanOrEqual(b.board.y + b.board.height);
    // 왼쪽 수준 / 오른쪽 선생님(사용자 결정)은 어느 방향에서나
    expect(cx(b.level)).toBeLessThan(cx(b.board));
    expect(cx(b.mode)).toBeGreaterThan(cx(b.board));
    if (vp.portrait) {
      // 세로: 스위치는 칠판 아래 한 줄, 질문창 위
      for (const s of [b.level, b.mode]) {
        expect(s.y).toBeGreaterThanOrEqual(b.board.y + b.board.height);
        expect(s.y + s.height).toBeLessThanOrEqual(b.ask.y);
      }
      expect(b.level.x + b.level.width).toBeLessThanOrEqual(b.mode.x);
      // 칠판은 화면 폭 가득(16:9 사진 비율 유지)
      expect(b.board.width / vp.width).toBeGreaterThanOrEqual(0.9);
    } else {
      // 가로: 칠판 양옆 기둥(지금 배치 그대로)
      expect(b.level.x + b.level.width).toBeLessThanOrEqual(b.board.x);
      expect(b.mode.x).toBeGreaterThanOrEqual(b.board.x + b.board.width);
      // 스위치는 칠판 높이 가운데
      const cy = (r: Box) => r.y + r.height / 2;
      for (const s of [b.level, b.mode]) expect(Math.abs(cy(s) - cy(b.board))).toBeLessThanOrEqual(b.board.height * 0.06);
    }

    // B5: 보이는 장식은 정해진 자리(칠판 옆 기둥)에만 있고 아무것도 가리지 않는다
    const doodles = page.locator('.doodle');
    for (let i = 0; i < (await doodles.count()); i++) {
      const d = doodles.nth(i);
      if (!(await d.isVisible())) continue;
      const r = (await d.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(vp.width);
      expect(r.y + r.height).toBeLessThanOrEqual(vp.height);
      for (const n of names) expect(apart(r, b[n]), `doodle ${i} ${JSON.stringify(r)} vs ${n} ${JSON.stringify(b[n])}`).toBe(true);
      // 칠판 높이 안(칠판 위·아래 모서리 높이에 맞춘 자리)
      expect(r.y).toBeGreaterThanOrEqual(b.board.y - 1);
      expect(r.y + r.height).toBeLessThanOrEqual(b.board.y + b.board.height + 1);
    }
    await ctx.close();
  });
}

// QA 2026-11-23: 휴대폰 세로에서 화면 높이가 줄면(자판이 화면을 줄이는 브라우저·작은 창) 칠판이 좁아지는데, 스위치 줄과 질문창도
// 칠판 폭(격자 폭)으로 같이 줄어 '깊게'가 '빠른 선생님'에 덮였고(390×500) 입력칸이 22px만 남았다(390×430).
// 또 키 낮은 가로 휴대폰용 위 여백(2.4rem)이 세로에도 붙어 칠판이 그만큼 더 작아졌다.
for (const vp of [{ width: 390, height: 500 }, { width: 390, height: 430 }, { width: 360, height: 480 }, { width: 414, height: 500 }]) {
  test(`휴대폰 세로가 낮아져도(자판) 스위치·질문창이 겹치지 않고 입력칸이 남는다 ${vp.width}x${vp.height}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    await mockApi(page);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('textbox')).toBeVisible();
    const b = await boxes(page);
    const names = Object.keys(b);
    for (const n of names) {
      const r = b[n];
      expect(r.x, n).toBeGreaterThanOrEqual(0);
      expect(r.y, n).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, n).toBeLessThanOrEqual(vp.width);
      expect(r.y + r.height, n).toBeLessThanOrEqual(vp.height);
    }
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++)
        expect(apart(b[names[i]], b[names[j]]), `${names[i]} ${JSON.stringify(b[names[i]])} vs ${names[j]} ${JSON.stringify(b[names[j]])}`).toBe(true);
    expect(b.level.x + b.level.width).toBeLessThanOrEqual(b.mode.x);
    // 질문창 안: 마이크 칩·입력칸·물어보기가 질문창 밖으로 나가지 않고, 입력칸은 글자를 쳐 넣을 만큼
    for (const sel of ['.mic-pill', '.ask-input', '.ask-btn']) {
      const r = (await page.locator(sel).boundingBox())!;
      expect(r.x, sel).toBeGreaterThanOrEqual(b.ask.x - 0.5);
      expect(r.x + r.width, sel).toBeLessThanOrEqual(b.ask.x + b.ask.width + 0.5);
    }
    expect((await page.locator('.ask-input').boundingBox())!.width).toBeGreaterThanOrEqual(110);
    // 위아래로 버리는 띠가 없다(가로 휴대폰용 위 여백이 세로에 붙지 않는다)
    expect(b.logo.y).toBeLessThanOrEqual(20);
    await ctx.close();
  });
}

test('데스크톱·아이패드 가로에서는 장식이 칠판 옆 네 구석에 보인다', async ({ browser }) => {
  for (const vp of [{ width: 1180, height: 820 }, { width: 1280, height: 800 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    await mockApi(page);
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    const board = (await page.locator('.board').boundingBox())!;
    const ds = page.locator('.doodle');
    await expect(ds).toHaveCount(4);
    const rs = [];
    for (let i = 0; i < 4; i++) {
      await expect(ds.nth(i)).toBeVisible();
      rs.push((await ds.nth(i).boundingBox())!);
    }
    // 둘은 칠판 왼쪽, 둘은 오른쪽 / 둘은 칠판 위쪽 절반, 둘은 아래쪽 절반
    expect(rs.filter((r) => r.x + r.width <= board.x).length).toBe(2);
    expect(rs.filter((r) => r.x >= board.x + board.width).length).toBe(2);
    expect(rs.filter((r) => r.y + r.height / 2 < board.y + board.height / 2).length).toBe(2);
    await ctx.close();
  }
});

test('휴대폰 세로: 돌려 달라는 안내 없이 수업이 끝까지 되고 질문창을 쓸 수 있다', async ({ browser }) => {
  const vp = { width: 390, height: 844 };
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  await mockApi(page);
  await gotoUnlocked(page);
  await expect(page.getByText('가로로 돌려 줘!')).toBeHidden();
  await page.getByRole('button', { name: '🧒 아이' }).click();
  const input = page.getByRole('textbox');
  await expect(input).toBeVisible();
  const ib = (await input.boundingBox())!;
  expect(ib.width).toBeGreaterThanOrEqual(110); // 글자를 쳐 넣을 칸이 남는다
  expect(ib.y + ib.height).toBeLessThanOrEqual(vp.height);
  const btn = page.getByRole('button', { name: '물어보기' });
  const bb = (await btn.boundingBox())!;
  expect(bb.x + bb.width).toBeLessThanOrEqual(vp.width);
  await input.fill('달은 왜 나를 따라와?');
  await btn.click();
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 });
  expect(await page.locator('svg .ink path').count()).toBeGreaterThanOrEqual(10);
  await expect(page.locator('svg text', { hasText: '달은 왜 나를 따라올까?' })).toHaveCount(1);
  // 끝난 뒤 바로 다시 물을 수 있다
  await input.fill('그럼 해는?');
  await expect(input).toHaveValue('그럼 해는?');
  await ctx.close();
});

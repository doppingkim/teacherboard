import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoUnlocked } from './pin';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const silenceB64 = readFileSync(new URL('../fixtures/silence.mp3', import.meta.url)).toString('base64');

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

async function runLesson(page: Page): Promise<void> {
  await mockApi(page);
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
  await page.getByRole('button', { name: '물어보기' }).click();
  // 아래 개수·boundingBox 검사는 이 마지막 자막 대기(수업 끝)에 기대어 모든 판서가 끝난 뒤에 본다.
  await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 30000 });
}

test('늦게 온 그림도 그려지고 수업이 끝난다', async ({ page }) => {
  await runLesson(page);
  // 제목 + 먼저 온 나무(5획) + 늦게 온 달(4획) + 연결 + 밑줄 + 달 동그라미(mark). 실패한 별 칸은 비어 있다.
  expect(await page.locator('svg .ink path').count()).toBeGreaterThanOrEqual(14);
  expect(await page.locator('svg .ink .op-figure').count()).toBeGreaterThanOrEqual(2); // 먼저 온 나무 + 늦게 온 달
  await expect(page.locator('svg text', { hasText: '달은 왜 나를 따라올까?' })).toHaveCount(1);
  await expect(page.locator('svg text', { hasText: '아주 먼 달' }).first()).toBeAttached();
  await expect(page.locator('svg text', { hasText: '가까운 나무' }).first()).toBeAttached();
});

test('mark 밑줄이 제목 아래에 그려진다', async ({ page }) => {
  await runLesson(page);
  const title = await page.locator('svg text', { hasText: '달은 왜 나를 따라올까?' }).boundingBox();
  expect(title).toBeTruthy();
  const marks = page.locator('svg .ink .op-mark path');
  expect(await marks.count()).toBeGreaterThanOrEqual(1);
  const box = await marks.first().boundingBox();
  expect(box).toBeTruthy();
  // 밑줄은 제목 글자 바닥 근처(아래쪽 절반)이고 제목 가로 범위 안쪽에 있다
  expect(box!.y).toBeGreaterThan(title!.y + title!.height * 0.5);
  expect(box!.y).toBeLessThan(title!.y + title!.height + 40);
  expect(box!.x).toBeGreaterThanOrEqual(title!.x - 10);
  expect(box!.x + box!.width).toBeLessThanOrEqual(title!.x + title!.width + 10);
  // '따라올까?'는 제목 뒤쪽이라 밑줄 중심은 제목 상자의 오른쪽 절반에 있다
  expect(box!.x + box!.width / 2).toBeGreaterThan(title!.x + title!.width * 0.5);
});

test('화가 출력 모양(획마다 색, fill:true)이 그대로 그려진다', async ({ page }) => {
  await runLesson(page);
  const tree = page.locator('svg .ink .op-figure', { has: page.locator('text', { hasText: '가까운 나무' }) });
  await expect(tree).toHaveCount(1);
  // fill:true 획은 채우기 path 하나로만(윤곽을 다시 긋지 않음)
  await expect(tree.locator('path.fill')).toHaveCount(1);
  const fill = await tree.locator('path.fill').evaluate((el) => getComputedStyle(el).fill);
  expect(fill).toBe('rgb(106, 165, 22)'); // lime
  // 선 획 색: 그림 기본색(green) 말고 획마다 준 brown도 있다
  const strokes = await tree.locator('path:not(.fill)').evaluateAll((els) => els.map((e) => e.getAttribute('stroke')));
  expect(strokes).toContain('#1f9a57'); // 기본 green
  expect(strokes).toContain('#8a5a2b'); // 획마다 준 brown
  expect(strokes.filter((c) => c === '#8a5a2b')).toHaveLength(3);
});

// ---------- 보드만 따로(QA 2026-11-22): 앱(main.ts) 없이 Board를 페이지에 띄워 이상한 판서 데이터를 넣어 본다 ----------
// main.ts를 싣지 않는 빈 페이지라, 다른 파일 수정으로 vite가 페이지를 다시 불러도 흔들리지 않는다.
async function boardOnly(page: Page, query = ''): Promise<void> {
  await page.route('**/board-only.html*', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
      + '<link href="https://fonts.googleapis.com/css2?family=Hi+Melody&display=swap" rel="stylesheet">'
      + '<link rel="stylesheet" href="/src/web/styles.css"></head><body><div id="host" style="--bw:1000px;width:1000px"></div></body></html>',
  }));
  await page.goto('/board-only.html' + query);
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    const { Board } = await import('/src/web/board/board.ts' as string);
    const { Layout } = await import('/src/web/board/layout.ts' as string);
    w.board = new Board(document.getElementById('host')!);
    w.layout = new Layout();
  });
}

test('글씨·이름표·연결 라벨·자막의 <, &, " 는 글자 그대로(마크업으로 해석하지 않는다)', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const s = new AbortController().signal;
    const evil = '<img src=x onerror="window.__x=1">&amp;"\'';
    const t = { kind: 'text', role: 'title', text: evil, ink: 'black', id: 't' };
    await board.draw(t, layout.place(t), 0, s);
    const f = { kind: 'figure', size: 'small', ink: 'black', strokes: ['M10 10 L90 90'], labels: [{ x: 50, y: 50, text: evil }], id: 'f' };
    await board.draw(f, layout.place(f), 0, s);
    await board.draw({ kind: 'connect', from: 't', to: 'f', ink: 'red', label: evil }, { refs: [layout.rectOf('t'), layout.rectOf('f')] }, 0, s);
    board.setThinking([evil]);
    const think = document.querySelector('.thinking-text')!.textContent;
    board.setSubtitle(evil);
    return {
      imgs: document.querySelectorAll('img').length, x: (window as any).__x ?? null, think,
      texts: [...document.querySelectorAll('svg .ink text')].map((e) => e.textContent),
      sub: document.querySelector('.subtitle > span')!.textContent,
    };
  });
  const evil = '<img src=x onerror="window.__x=1">&amp;"\'';
  expect(r).toEqual({ imgs: 0, x: null, think: evil, texts: [evil, evil, evil], sub: evil });
});

test('같은 칸끼리 잇기(from = to)는 화살표를 긋지 않고, 다른 칸이면 긋는다', async ({ page }) => {
  await boardOnly(page);
  const n = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const s = new AbortController().signal;
    const f = { kind: 'figure', size: 'small', ink: 'black', strokes: ['M10 10 L90 90'], id: 'a' };
    await board.draw(f, layout.place(f), 0, s);
    const g = { ...f, id: 'b' };
    await board.draw(g, layout.place(g), 0, s);
    await board.draw({ kind: 'connect', from: 'a', to: 'a', ink: 'red' }, { refs: [layout.rectOf('a'), layout.rectOf('a')] }, 0, s);
    const same = document.querySelectorAll('svg .ink .op-connect').length;
    await board.draw({ kind: 'connect', from: 'a', to: 'b', ink: 'red' }, { refs: [layout.rectOf('a'), layout.rectOf('b')] }, 0, s);
    return [same, document.querySelectorAll('svg .ink .op-connect').length];
  });
  expect(n).toEqual([0, 1]);
});

test('clear() 뒤에는 그리던 판서·이름표·대기 문구가 더 자라지 않고 남은 것이 없다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const s = new AbortController().signal;
    const f = { kind: 'figure', size: 'wide', ink: 'black', strokes: Array.from({ length: 20 }, (_, i) => `M${i * 5} 0 L${i * 5} 30`), labels: [{ x: 50, y: 20, text: '이름표' }] };
    const t = { kind: 'text', role: 'note', text: '정리 줄 글씨가 길게', ink: 'blue' };
    const jobs = [board.draw(f, layout.place(f), 6000, s), board.draw(t, layout.place(t), 6000, s)];
    board.writeIdle('기다리는 중');
    await new Promise((r) => setTimeout(r, 400));
    board.clear();
    let muts = 0;
    const mo = new MutationObserver((l) => (muts += l.length));
    mo.observe(document.querySelector('.board')!, { subtree: true, childList: true, attributes: true });
    await Promise.all(jobs);
    await new Promise((r) => setTimeout(r, 1200));
    mo.disconnect();
    const n = (sel: string) => document.querySelectorAll(sel).length;
    return { muts, left: n('.ink > *') + n('.live > *') + n('.active-root > *') + n('defs.clips > *') + n('defs.live-defs > *'), pen: (document.querySelector('.pen') as SVGElement).style.opacity };
  });
  expect(r).toEqual({ muts: 0, left: 0, pen: '0' });
});

test('생각 중 문구는 마지막 문구에서 멈추고 타이머도 끝낸다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board } = window as unknown as { board: any };
    const live = new Set<unknown>();
    const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
    (window as any).setInterval = (fn: any, ms: any) => { const id = si(fn, ms); live.add(id); return id; };
    (window as any).clearInterval = (id: any) => { live.delete(id); ci(id); };
    board.setThinking(['하나', '둘']);
    const first = document.querySelector('.thinking-text')!.textContent;
    await new Promise((r) => setTimeout(r, 3500));
    return { first, last: document.querySelector('.thinking-text')!.textContent, timers: live.size };
  });
  expect(r).toEqual({ first: '하나', last: '둘', timers: 0 });
});

test('사파리식(fade) 글씨는 이모지·결합 글자를 반쪽으로 쪼개지 않는다', async ({ page }) => {
  await boardOnly(page, '?write=fade');
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    await document.fonts.load('80px "Hi Melody"', '가나다');
    const text = '🌙 달 👨‍👩‍👧 é 한글';
    const t = { kind: 'text', role: 'title', text, ink: 'black' };
    const job = board.draw(t, layout.place(t), 3000, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 400));
    const spans = [...document.querySelectorAll('svg text tspan')].map((e) => e.textContent!);
    await job;
    return { spans, final: document.querySelector('svg .ink text')!.textContent };
  });
  expect(r.spans.length).toBeGreaterThan(0);
  expect(r.spans).toContain('🌙');
  expect(r.spans).toContain('👨‍👩‍👧');
  expect(r.spans).toContain('é');
  expect(r.spans.join('')).toBe('🌙 달 👨‍👩‍👧 é 한글');
  expect(r.final).toBe('🌙 달 👨‍👩‍👧 é 한글');
});

test('아주 큰 그림(획 60개 × 2000자 + 이름표 12개)도 화면을 오래 멈추지 않는다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    await document.fonts.load('44px "Hi Melody"', '가나다');
    const stroke = (k: number) => { let d = `M${k % 100} 0`; let i = 0; while (d.length < 1900) { d += ` L${(i * 7 + k) % 100} ${(i * 13) % 100}`; i++; } return d; };
    const f = {
      kind: 'figure', size: 'small', ink: 'black', strokes: Array.from({ length: 60 }, (_, k) => stroke(k)),
      labels: Array.from({ length: 12 }, (_, i) => ({ x: 10 + (i % 4) * 25, y: 20 + Math.floor(i / 4) * 30, text: '아주 긴 이름표 ' + i })),
    };
    // QA2 2026-11-23: 같은 쪽에 큰 그림 둘이 이미 있으면(쪽 전체 장애물 4000점까지) 이름표가 그 선도 피한다 — 그 경우를 잰다.
    // 여러 시험이 함께 돌면(다른 브라우저·vitest) 한 번 잰 값이 5~10배 흔들린다: 세 번 재서 가장 빠른 값을 본다.
    // (부하 없이 약 0.3~0.5초. 고치기 전 약 24초라, 가장 빠른 값으로도 되돌아감은 충분히 잡힌다.)
    const s = new AbortController().signal;
    let ms = Infinity, labels = 0;
    for (let round = 0; round < 3; round++) {
      board.clear();
      layout.reset();
      for (const id of ['p', 'q']) await board.draw({ ...f, id, labels: [] }, layout.place({ ...f, id }), 0, s);
      const pf = layout.place(f);
      const t0 = performance.now();
      await board.draw(f, pf, 0, s);
      ms = Math.min(ms, performance.now() - t0);
      labels = document.querySelectorAll('svg .ink text').length;
    }
    return { ms, labels };
  });
  expect(r.labels).toBe(12);
  expect(r.ms).toBeLessThan(4000); // 고치기 전 약 24초
});

// ---------- 판서 품질(2026-11-23 craft B2·D1·D3·D4): 픽스처 수업 끝 화면을 수치로 ----------

/** 수업 끝 화면의 판서 측정(보드 좌표 1280×720). */
async function measureBoard(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('svg.ink-layer') as SVGSVGElement;
    const inv = svg.getScreenCTM()!.inverse();
    const mOf = (el: SVGGraphicsElement) => inv.multiply(el.getScreenCTM()!);
    const box = (el: SVGGraphicsElement) => {
      const b = el.getBBox(), m = mOf(el);
      const ps = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
        .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
      const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    const figs = [...document.querySelectorAll<SVGGElement>('svg .ink .op-figure')].map(box);
    // 이름표는 실제 글자 잉크(캔버스로 잰 하이멜로디 윗·아랫 끝)까지 품은 상자로 잰다(사파리 getBBox는 글자 윗부분을 덜 품는다).
    const ctx = document.createElement('canvas').getContext('2d')!;
    const labels = [...document.querySelectorAll<SVGTextElement>('svg .ink text.label')].map((t) => {
      const b = box(t);
      const size = Number(t.getAttribute('font-size'));
      ctx.font = `${size}px "Hi Melody"`;
      const mt = ctx.measureText(t.textContent!);
      const k = b.h / t.getBBox().height; // 보드 배율(옮긴 그림 안이어도 배율은 1)
      const base = new DOMPoint(0, t.getStartPositionOfChar(0).y).matrixTransform(mOf(t)).y;
      const top = Math.min(b.y, base - mt.actualBoundingBoxAscent * k), bottom = Math.max(b.y + b.h, base + mt.actualBoundingBoxDescent * k);
      return { text: t.textContent!, box: { x: b.x, y: top, w: b.w, h: bottom - top } };
    });
    // 모든 선(채우기·마스크 빼고) 위의 점, 2px 간격
    const strokes: { cls: string; pts: [number, number][] }[] = [];
    for (const p of document.querySelectorAll<SVGPathElement>('svg .ink path')) {
      if (p.closest('mask, clipPath, defs') || p.classList.contains('fill')) continue;
      const m = mOf(p), len = p.getTotalLength(), pts: [number, number][] = [];
      for (let l = 0; l <= len; l += 2) {
        const q = new DOMPoint(p.getPointAtLength(l).x, p.getPointAtLength(l).y).matrixTransform(m);
        pts.push([q.x, q.y]);
      }
      strokes.push({ cls: (p.closest('.op') as Element).getAttribute('class')!, pts });
    }
    const textOf = (sel: string) => {
      const t = document.querySelector<SVGTextElement>(sel)!;
      return { size: Number(t.getAttribute('font-size')), bold: Number(t.getAttribute('stroke-width')) };
    };
    return { figs, labels, strokes, title: textOf('svg .ink text.title'), note: textOf('svg .ink text.note'), label: textOf('svg .ink text.label') };
  });
}

test('B2: 가로 칠판에서 그림 묶음이 가운데(좌우 여백 차 ≤ 칠판 폭 10%)', async ({ page }) => {
  await runLesson(page);
  await page.waitForTimeout(600); // 혹시 옮기는 중이면 끝까지
  const { figs } = await measureBoard(page);
  expect(figs.length).toBe(2); // 나무 + 달(실패한 별은 칸도 없다)
  const left = Math.min(...figs.map((f) => f.x)), right = 1280 - Math.max(...figs.map((f) => f.x + f.w));
  expect(Math.abs(left - right), JSON.stringify(figs)).toBeLessThanOrEqual(128);
  // 두 그림이 칠판 양쪽 절반에 하나씩
  const cx = figs.map((f) => f.x + f.w / 2).sort((a, b) => a - b);
  expect(cx[0]).toBeLessThan(640);
  expect(cx[1]).toBeGreaterThan(640);
});

test('D1: 이름표 상자는 어떤 선과도 겹치지 않고, 이름표끼리 겹치지 않으며 칠판 안', async ({ page }) => {
  await runLesson(page);
  await page.waitForTimeout(600);
  const { labels, strokes } = await measureBoard(page);
  expect(labels.map((l) => l.text).sort()).toEqual(['가까운 나무', '아주 먼 달', '엄청 멀다!'].sort());
  for (const { text, box: b } of labels) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(1280);
    expect(b.y + b.h).toBeLessThanOrEqual(720);
    for (const s of strokes) {
      const hit = s.pts.find(([x, y]) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      expect(hit, `${text} ${JSON.stringify(b)} x ${s.cls} at ${hit}`).toBeUndefined();
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].box, c = labels[j].box;
      const apart = a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y;
      expect(apart, `${labels[i].text} vs ${labels[j].text}`).toBe(true);
    }
  }
});

test('D4: 글씨 세 단계 — 제목 > 정리 > 이름표 (크기 1.3배 이상씩, 굵기도 같은 순서)', async ({ page }) => {
  await runLesson(page);
  const { title, note, label } = await measureBoard(page);
  expect(title.size / note.size).toBeGreaterThanOrEqual(1.3);
  expect(note.size / label.size).toBeGreaterThanOrEqual(1.3);
  expect(title.bold).toBeGreaterThan(note.bold);
  expect(note.bold).toBeGreaterThan(label.bold);
});

test('B2 대비: 그린 뒤에 같은 쪽 그림이 더 오면 그림·표시·연결선이 새 칸으로 옮겨 간다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const s = new AbortController().signal;
    const svg = document.querySelector('svg.ink-layer') as SVGSVGElement;
    const inv = svg.getScreenCTM()!.inverse();
    const bx = (el: SVGGraphicsElement) => {
      const b = el.getBBox(), m = inv.multiply(el.getScreenCTM()!);
      return Math.round(new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(m).x);
    };
    const a = { kind: 'figure', id: 'a', size: 'small', ink: 'black', strokes: ['M20 20 L80 80', 'M80 20 L20 80'], labels: [{ x: 50, y: 95, text: '가' }] };
    await board.draw(a, layout.place(a, 1), 0, s); // 혼자일 줄 알았다 → 가운데
    await board.draw({ kind: 'mark', target: 'a', style: 'circle', ink: 'red' }, { refs: [layout.rectOf('a')] }, 0, s);
    const before = bx(document.querySelector('svg .ink .op-figure') as SVGGraphicsElement);
    const b = { ...a, id: 'b', labels: [{ x: 50, y: 95, text: '나' }] };
    const pb = layout.place(b, 2); // 둘째가 왔다 → a 칸이 왼쪽으로
    const moved = layout.moved;
    board.relayout();
    await board.draw(b, pb, 0, s);
    await board.draw({ kind: 'connect', from: 'a', to: 'b', ink: 'blue', label: '이어요' }, { refs: [layout.rectOf('a'), layout.rectOf('b')] }, 0, s);
    await new Promise((res) => setTimeout(res, 700));
    const figs = [...document.querySelectorAll<SVGGraphicsElement>('svg .ink .op-figure')].map(bx);
    const mark = bx(document.querySelector('svg .ink .op-mark') as SVGGraphicsElement);
    const body = document.querySelector<SVGPathElement>('svg .ink .op-connect path')!;
    const p0 = body.getPointAtLength(0), p1 = body.getPointAtLength(body.getTotalLength());
    return { before, moved, figs, mark, ends: [Math.round(p0.x), Math.round(p1.x)], connects: document.querySelectorAll('svg .ink .op-connect').length };
  });
  expect(r.moved).toBe(true);
  expect(r.before).toBeGreaterThan(600); // 처음엔 가운데(칸 452~828)
  expect(r.before).toBeLessThan(680);
  expect(Math.abs(r.figs[0] - (184 + 188))).toBeLessThan(40); // 왼쪽 칸 가운데로 옮겨졌다
  expect(Math.abs(r.figs[1] - (720 + 188))).toBeLessThan(40);
  expect(Math.abs(r.mark - r.figs[0])).toBeLessThan(30); // 동그라미도 따라왔다
  expect(r.connects).toBe(1);
  expect(r.ends[0]).toBeGreaterThan(184 + 300); // 왼쪽 칸 오른쪽 변 근처에서
  expect(r.ends[1]).toBeLessThan(720 + 80); // 오른쪽 칸 왼쪽 변 근처로
});

test('B2 대비: 연결선 양 끝이 따로 옮겨지면 새 자리로 다시 긋고, 비운 칸에 붙은 연결선은 지운다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const s = new AbortController().signal;
    const f = (id: string) => ({ kind: 'figure', id, size: 'small', ink: 'black', strokes: ['M20 20 L80 80'] });
    const pa = layout.place(f('a'), 2);
    await board.draw(f('a'), pa, 0, s);
    const pb = layout.place({ kind: 'sketch', id: 'b', size: 'small' }, 2);
    await board.draw({ kind: 'connect', from: 'a', to: 'b', ink: 'blue' }, { refs: [layout.rectOf('a'), layout.rectOf('b')] }, 0, s);
    const pc = layout.place(f('c'), 3); // 셋째 → 세 칸으로: a·b가 서로 다르게 옮겨진다
    board.relayout();
    await board.draw(f('c'), pc, 0, s);
    await new Promise((res) => setTimeout(res, 700));
    const body = document.querySelector<SVGPathElement>('svg .ink .op-connect path')!;
    const x0 = Math.round(body.getPointAtLength(0).x);
    const n = document.querySelectorAll('svg .ink .op-connect').length;
    layout.release(pb.rect); // 주문 그림 b 실패
    board.relayout();
    await new Promise((res) => setTimeout(res, 700));
    return { x0, n, after: document.querySelectorAll('svg .ink .op-connect').length, a: pa.rect.x, c: pc.rect.x };
  });
  expect(r.n).toBe(1); // 바꿔 끼운 뒤 예전 선은 남지 않는다
  expect(r.x0).toBeGreaterThan(48 + 300); // 세 칸 자리의 a(48~424) 오른쪽 변 근처에서 다시 그었다
  expect(r.x0).toBeLessThan(48 + 376 + 10);
  expect(r.after).toBe(0); // 비운 칸을 가리키던 연결선은 사라졌다
  expect([r.a, r.c]).toEqual([184, 720]); // 남은 둘이 다시 가운데로
});

// ---------- QA2 2026-11-23(보드 그리기 2차) ----------

test('QA2: 그리는 중에 칸이 옮겨지면 펜과 쓰는 중 획도 그림과 함께 옮겨 간다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    await document.fonts.load('38px "Hi Melody"', '가나다');
    const s = new AbortController().signal;
    const a = { kind: 'figure', id: 'a', size: 'small', ink: 'black', strokes: Array.from({ length: 8 }, (_, i) => `M${10 + i * 10} 10 L${10 + i * 10} 90`) };
    const job = board.draw(a, layout.place(a, 1), 4000, s); // 가운데 칸(452~828)에서 4초 동안
    await new Promise((res) => setTimeout(res, 1200));
    layout.place({ ...a, id: 'b' }, 2); // 둘째가 왔다 → a 칸이 184로
    board.relayout();
    // 옮기는 동안(450ms) 매 프레임: 쓰는 중 획(따로 된 층)의 자리가 그림 묶음과 같아야 한다
    let frames = 0, apart = 0;
    const until = performance.now() + 500;
    await new Promise<void>((done) => {
      const tick = () => {
        const fig = document.querySelector('svg .op-figure')!.getAttribute('transform');
        const act = document.querySelector('.active-root > g > g');
        if (act) { frames++; if (act.getAttribute('transform') !== fig) apart++; }
        if (performance.now() < until) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    // 옮긴 뒤: 펜 끝이 옮겨 간 그림 칸(184~560, 자르기 여백 12) 안에 있다
    const pens: number[] = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const m = /translate\(([-\d.]+) /.exec(document.querySelector('.pen')!.getAttribute('transform')!)!;
      pens.push(Number(m[1]));
    }
    await job;
    return { frames, apart, pens };
  });
  expect(r.apart, JSON.stringify(r)).toBe(0);
  for (const x of r.pens) {
    expect(x).toBeGreaterThanOrEqual(184 - 12);
    expect(x).toBeLessThanOrEqual(184 + 376 + 12);
  }
});

test('QA2: 옮기는 중인 판서는 옮겨 갈 자리를 장애물로 친다(이름표·연결 라벨 자리 찾기)', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const s = new AbortController().signal;
    const a = { kind: 'figure', id: 'a', size: 'small', ink: 'black', strokes: ['M0 50 L100 50'] };
    await board.draw(a, layout.place(a, 1), 0, s); // 가운데(452~828)
    layout.place({ ...a, id: 'b' }, 2); // a → 184~560
    board.relayout(); // 막 옮기기 시작
    const xs = board.pageObstacles().points.map((p: [number, number]) => p[0]);
    return [Math.min(...xs), Math.max(...xs)];
  });
  expect(r[0]).toBeGreaterThanOrEqual(184 - 8);
  expect(r[1]).toBeLessThanOrEqual(560 + 8);
});

test('QA2: 그림 동그라미는 끝에 잉크 고임 점 없이 한 획이고, 보드 가장자리에서 납작해지지 않는다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const s = new AbortController().signal;
    const out: Record<string, { edge: number; pools: number }> = {};
    const measure = (key: string) => {
      const g = [...document.querySelectorAll<SVGGElement>('svg .ink .op-mark')].pop()!;
      const p = g.querySelector('path')!;
      let edge = 0;
      for (let l = 0, len = p.getTotalLength(); l <= len; l += 2) {
        const q = p.getPointAtLength(l);
        if (q.x <= 4.6 || q.x >= 1275.4 || q.y <= 4.6 || q.y >= 715.4) edge++;
      }
      out[key] = { edge, pools: g.querySelectorAll('circle.pool').length };
    };
    const sq = (id: string, size: string) => ({ kind: 'figure', id, size, ink: 'black', strokes: [size === 'wide' ? 'M0 0 L100 0 L100 37 L0 37 Z' : 'M0 0 L100 0 L100 100 L0 100 Z'] });
    await board.draw(sq('L', 'small'), layout.place(sq('L', 'small'), 3), 0, s); // 세 칸 중 왼쪽(48~424)
    await board.draw({ kind: 'mark', target: 'L', style: 'circle', ink: 'red' }, { refs: [layout.rectOf('L')] }, 0, s);
    measure('left');
    board.clear(); layout.reset();
    await board.draw(sq('W', 'wide'), layout.place(sq('W', 'wide')), 0, s);
    await board.draw({ kind: 'mark', target: 'W', style: 'circle', ink: 'red' }, { refs: [layout.rectOf('W')] }, 0, s);
    measure('wide');
    return out;
  });
  expect(r).toEqual({ left: { edge: 0, pools: 0 }, wide: { edge: 0, pools: 0 } });
});

test('QA2: 글꼴이 오래 안 오면(네트워크 느림) FONT_WAIT_MS(2.5초) 뒤에는 그린다', async ({ page }) => {
  await page.route('**/fonts.gstatic.com/**', async (route) => { await new Promise((res) => setTimeout(res, 9000)); await route.abort(); });
  await boardOnly(page);
  const ms = await page.evaluate(async () => {
    const { board, layout } = window as unknown as { board: any; layout: any };
    const t = { kind: 'text', role: 'title', text: '글꼴 기다리기', ink: 'black' };
    const t0 = performance.now();
    await board.draw(t, layout.place(t), 0, new AbortController().signal);
    return performance.now() - t0;
  });
  expect(ms).toBeLessThan(4500);
});

test('QA2: 기다림 질문(setThinking)을 연달아 바꿔도 새 질문은 남는다', async ({ page }) => {
  await boardOnly(page);
  const r = await page.evaluate(async () => {
    const { board } = window as unknown as { board: any };
    await document.fonts.load('80px "Hi Melody"', '가나다');
    board.setThinking(['생각 중'], '첫 질문이야');
    await new Promise((res) => setTimeout(res, 2000));
    board.setThinking(['생각 중'], '둘째 질문이야');
    await new Promise((res) => setTimeout(res, 2000));
    return [...document.querySelectorAll('svg text')].map((t) => t.textContent);
  });
  expect(r).toEqual(['둘째 질문이야']);
});

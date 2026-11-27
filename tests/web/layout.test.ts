import { Layout, NOTE_H, NOTE_Y } from '../../src/web/board/layout';
import { FONT_SIZE } from '../../src/web/board/items';
import { BOARD, SMALL_SIZE, SMALL_XS } from '../../src/web/board/layout';
import type { DrawOp } from '../../src/shared/script';

const fig = (size: 'small' | 'wide', id?: string) => ({ kind: 'figure', size, ink: 'black', strokes: ['M0 0 L10 10'], id }) as DrawOp;
const title = { kind: 'text', role: 'title', text: 't', ink: 'black' } as DrawOp;
const note = { kind: 'text', role: 'note', text: 'n', ink: 'black' } as DrawOp;

test('작은 그림 3개는 세 칸에, 4번째는 새 페이지 첫 칸', () => {
  const L = new Layout();
  expect([0, 1, 2].map(() => L.place(fig('small'))!.rect.x)).toEqual([48, 452, 856]);
  expect(L.place(fig('small'))).toMatchObject({ newPage: true, rect: { x: 48 } });
});
test('작은 그림 칸은 376 정사각, y 162, scale 3.76', () => {
  expect(new Layout().place(fig('small'))).toEqual({ rect: { x: 48, y: 162, w: 376, h: 376 }, newPage: false, scale: 3.76 });
});
test('작은 그림이 있는 페이지에 넓은 그림 → 새 페이지', () => {
  const L = new Layout(); L.place(fig('small'));
  expect(L.place(fig('wide'))).toMatchObject({ newPage: true, rect: { x: 48, y: 130, w: 1184, h: 438 }, scale: 11.84 });
});
test('넓은 그림 뒤 작은 그림 → 새 페이지', () => {
  const L = new Layout(); L.place(fig('wide'));
  expect(L.place(fig('small'))!.newPage).toBe(true);
});
test('넓은 그림 두 번 → 새 페이지', () => {
  const L = new Layout(); L.place(fig('wide'));
  expect(L.place(fig('wide'))!.newPage).toBe(true);
});
test('제목 두 번 → 새 페이지, 정리 3번째 → 새 페이지', () => {
  const L = new Layout(); expect(L.place(title)!.newPage).toBe(false); expect(L.place(title)!.newPage).toBe(true);
  const M = new Layout(); M.place(note); M.place(note); expect(M.place(note)!.newPage).toBe(true);
});
test('제목·정리 줄 좌표', () => {
  const L = new Layout();
  expect(L.place(title)).toMatchObject({ rect: { x: 48, y: 24, w: 1184, h: 90 }, scale: 1 });
  expect(L.place(note)!.rect).toEqual({ x: 48, y: 584, w: 1184, h: 60 });
  expect(L.place(note)!.rect).toEqual({ x: 48, y: 648, w: 1184, h: 60 });
});
test('새 페이지 후 제목은 유지되지 않고 상태가 리셋된다', () => {
  const L = new Layout(); L.place(title); L.place(note);
  L.place(title); // new page
  expect(L.place(note)!.rect.y).toBe(584);
});
test('id로 그림 칸을 찾고, 새 페이지에서 지워진다', () => {
  const L = new Layout(); L.place(fig('small', 'moon'));
  expect(L.rectOf('moon')).toMatchObject({ x: 48, w: 376 });
  L.reset(); expect(L.rectOf('moon')).toBeUndefined();
});
test('자동 새 페이지에서도 이전 id는 지워진다', () => {
  const L = new Layout(); L.place(fig('wide', 'a')); L.place(fig('wide', 'b'));
  expect(L.rectOf('a')).toBeUndefined(); expect(L.rectOf('b')).toMatchObject({ w: 1184 });
});
test('connect/mark는 null', () => {
  expect(new Layout().place({ kind: 'connect', from: 'a', to: 'b', ink: 'blue' })).toBeNull();
  expect(new Layout().place({ kind: 'mark', target: 'a', style: 'circle', ink: 'red' })).toBeNull();
});
test('sketch 보여 주기는 같은 크기 그림처럼 칸을 잡고 id를 등록한다', () => {
  const L = new Layout();
  expect(L.place({ kind: 'sketch', id: 'a', size: 'small' })).toEqual({ rect: { x: 48, y: 162, w: 376, h: 376 }, newPage: false, scale: 3.76 });
  expect(L.rectOf('a')).toMatchObject({ x: 48 });
  expect(L.place({ kind: 'sketch', id: 'b', size: 'wide' })).toMatchObject({ newPage: true, rect: { w: 1184 }, scale: 11.84 });
  expect(L.rectOf('a')).toBeUndefined();
  expect(L.rectOf('b')).toMatchObject({ w: 1184 });
});
test('id 있는 글씨도 rectOf로 찾는다(새 페이지에서 지워짐)', () => {
  const L = new Layout();
  L.place({ kind: 'text', id: 't1', role: 'title', text: 't', ink: 'black' });
  L.place({ kind: 'text', id: 'n1', role: 'note', text: 'n', ink: 'black' });
  expect(L.rectOf('t1')).toEqual({ x: 48, y: 24, w: 1184, h: 90 });
  expect(L.rectOf('n1')).toEqual({ x: 48, y: 584, w: 1184, h: 60 });
  L.place(title); // 제목 두 번째 → 새 페이지
  expect(L.rectOf('t1')).toBeUndefined();
});

test('정리 줄은 서로 겹치지 않는다: 줄 간격 ≥ 글자 크기, 칸 높이 ≥ 글자 크기, 보드 안', () => {
  expect(NOTE_Y[1] - NOTE_Y[0]).toBeGreaterThanOrEqual(FONT_SIZE.note);
  expect(NOTE_H).toBeGreaterThanOrEqual(FONT_SIZE.note);
  expect(NOTE_Y[0] + NOTE_H).toBeLessThanOrEqual(NOTE_Y[1]);
  expect(NOTE_Y[1] + NOTE_H).toBeLessThanOrEqual(BOARD.h);
});

// ---------- B2 2026-11-23: 한 쪽의 작은 그림 수에 맞춰 가운데 정렬 ----------

/** 칸 묶음의 왼쪽·오른쪽 여백(보드 가장자리에서). */
const margins = (xs: readonly number[]) => [Math.min(...xs), BOARD.w - (Math.max(...xs) + SMALL_SIZE)];

test('어느 개수든 작은 그림 묶음의 좌우 여백이 같고(가운데), 칸끼리 겹치지 않으며 보드 안', () => {
  for (const n of [1, 2, 3] as const) {
    const xs = SMALL_XS[n];
    expect(xs).toHaveLength(n);
    const [l, r] = margins(xs);
    expect(Math.abs(l - r)).toBeLessThanOrEqual(1);
    expect(l).toBeGreaterThanOrEqual(48);
    for (let i = 1; i < n; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(SMALL_SIZE + 20);
  }
});

test('앞을 내다본 수를 주면 처음부터 그 수의 자리: 1개면 가운데, 2개면 양쪽 균형', () => {
  const L = new Layout();
  expect(L.place(fig('small', 'a'), 1)!.rect.x).toBe(452);
  const M = new Layout();
  const a = M.place(fig('small', 'a'), 2)!.rect;
  expect(a.x).toBe(184);
  expect(M.moved).toBe(false);
  const b = M.place(fig('small', 'b'), 2)!.rect;
  expect([a.x, b.x]).toEqual([184, 720]);
  expect(M.moved).toBe(false); // 짐작이 맞았다: 옮긴 칸 없음
});

test('대비: 짐작보다 더 오면 이미 놓인 칸 객체를 옆으로 옮기고 moved로 알린다', () => {
  const L = new Layout();
  const a = L.place(fig('small', 'a'), 1)!.rect;
  expect(a.x).toBe(452);
  const b = L.place(fig('small', 'b'), 2)!.rect;
  expect(L.moved).toBe(true);
  expect([a.x, b.x]).toEqual([184, 720]);
  expect(L.rectOf('a')).toBe(a); // 같은 칸 객체(아직 안 그린 판서도 새 자리로)
  const c = L.place(fig('small', 'c'), 2)!.rect; // 짐작(2)보다 많아도 실제 수로
  expect([a.x, b.x, c.x]).toEqual([48, 452, 856]);
});

test('expectSmallOnPage: 쪽이 넘어가는 판서(page 규칙: 제목 둘째·넓은 그림·넷째 그림)에서 멈춘다', () => {
  const L = new Layout();
  L.place(title);
  const s = (id: string) => ({ kind: 'sketch', id, size: 'small' }) as DrawOp;
  expect(L.expectSmallOnPage([fig('small'), note, s('b'), { kind: 'connect', from: 'a', to: 'b', ink: 'red' }])).toBe(2);
  expect(L.expectSmallOnPage([fig('small'), title, fig('small')])).toBe(1); // 둘째 제목 → 새 쪽
  expect(L.expectSmallOnPage([fig('small'), fig('wide')])).toBe(1);
  expect(L.expectSmallOnPage([fig('small'), fig('small'), fig('small'), fig('small')])).toBe(3);
  L.place(fig('small'), 1);
  expect(L.expectSmallOnPage([fig('small')])).toBe(2); // 이미 놓인 것 포함
  // 맨 앞 판서가 쪽을 넘기면 새 쪽에서 센다
  const W = new Layout();
  W.place(fig('wide'));
  expect(W.expectSmallOnPage([fig('small'), fig('small')])).toBe(2);
});

test('release: 실패한 주문 그림 칸을 비우면(크기 0) 남은 칸이 다시 가운데로, id도 지운다', () => {
  const L = new Layout();
  const a = L.place(fig('small', 'a'), 2)!.rect;
  const b = L.place({ kind: 'sketch', id: 'b', size: 'small' }, 2)!.rect;
  expect(L.release(b)).toBe(true);
  expect(b).toMatchObject({ w: 0, h: 0 });
  expect(a.x).toBe(452);
  expect(L.rectOf('b')).toBeUndefined();
  expect(L.release(b)).toBe(false); // 두 번은 안 된다
  // 비운 자리만큼 다음 그림을 더 받을 수 있다
  L.place(fig('small', 'c'), 2);
  L.place(fig('small', 'd'), 3);
  expect(L.place(fig('small', 'e'), 3)!.newPage).toBe(true);
});

// QA2 2026-11-23: 앞을 내다볼 때 센 주문 그림이 칸을 잡기 전에 실패하면 첫 그림이 2개 자리(184)에 혼자 남았다.
test('recount: 남은(아직 칸 안 잡은) 판서로 다시 세면 짐작을 줄여 다시 가운데로, 쪽 넘김 뒤 판서는 세지 않는다', () => {
  const L = new Layout();
  const a = L.place(fig('small', 'a'), 2)!.rect;
  expect(a.x).toBe(184);
  expect(L.recount([note])).toBe(true); // 남은 작은 그림 없음 → 혼자 → 가운데
  expect(a.x).toBe(452);
  expect(L.recount([fig('small'), note])).toBe(true); // 하나 더 온다 → 다시 둘 자리
  expect(a.x).toBe(184);
  expect(L.recount([fig('wide'), fig('small')])).toBe(true); // 넓은 그림은 쪽을 넘긴다 → 그 뒤는 세지 않는다
  expect(a.x).toBe(452);
  expect(L.recount([])).toBe(false); // 그대로
  expect(new Layout().recount([fig('small')])).toBe(false); // 놓인 칸이 없으면 할 일 없음
});

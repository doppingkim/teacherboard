import type { DrawOp } from '../../shared/script';

export const BOARD = { w: 1280, h: 720 } as const;
export type Rect = { x: number; y: number; w: number; h: number };
export type Placement = { rect: Rect; newPage: boolean; scale: number /* 로컬 좌표 1당 px */ };

const TITLE: Rect = { x: 48, y: 24, w: 1184, h: 90 };
export const SMALL_SIZE = 376;
const SMALL_Y = 162; // 그림 줄(y130,h440) 안에서 세로 가운데
/** 한 쪽의 작은 그림 칸 수. */
export const SMALL_MAX = 3;
/**
 * 한 쪽에 놓일 작은 그림 수(n)에 따른 칸 x. 어느 경우든 그림 묶음이 칠판 가운데에 오고 좌우 여백이 같다
 * (B2 2026-11-23: 왼쪽부터 채우면 2개일 때 오른쪽 1/3이 비었다). 2개는 사이를 넓혀(160) 잇는 화살표·라벨 자리를 둔다.
 */
export const SMALL_XS: Record<1 | 2 | 3, readonly number[]> = {
  1: [452],
  2: [184, 720],
  3: [48, 452, 856],
};
const WIDE: Rect = { x: 48, y: 130, w: 1184, h: 438 };
export const NOTE_Y = [584, 648] as const;
export const NOTE_H = 60;

type Slots = { title: boolean; small: number; wide: boolean; notes: number };
const empty = (): Slots => ({ title: false, small: 0, wide: false, notes: 0 });

const isSmall = (op: DrawOp) => (op.kind === 'figure' || op.kind === 'sketch') && op.size !== 'wide';

/** op을 지금 쪽(s)에 놓으면 새 쪽으로 넘어가는가. connect·mark는 칸을 잡지 않으니 false. */
function breaks(s: Slots, op: DrawOp): boolean {
  switch (op.kind) {
    case 'text':
      return op.role === 'title' ? s.title : s.notes >= NOTE_Y.length;
    case 'figure':
    case 'sketch':
      return op.size === 'wide' ? s.wide || s.small > 0 : s.wide || s.small >= SMALL_MAX;
    default:
      return false;
  }
}

/** op이 칸을 차지한 뒤의 상태(s를 바꾼다). */
function occupy(s: Slots, op: DrawOp): void {
  if (op.kind === 'text') {
    if (op.role === 'title') s.title = true;
    else s.notes++;
  } else if (op.kind === 'figure' || op.kind === 'sketch') {
    if (op.size === 'wide') s.wide = true;
    else s.small++;
  }
}

export class Layout {
  private s: Slots = empty();
  /** 이 페이지에서 id로 찾을 수 있는 칸(그림·글씨·주문 그림). */
  private byId = new Map<string, Rect>();
  /** 이 쪽의 작은 그림 칸(놓인 순서). 칸 객체는 자리를 옮길 때 그대로 고친다(아직 안 그린 판서도 새 자리로 그린다). */
  private smalls: Rect[] = [];
  /** 이 쪽에 올 것으로 아는 작은 그림 수(앞을 내다본 값). 0이면 모른다 → 예전처럼 왼쪽부터 세 칸. */
  private expected = 0;
  /** 마지막 place가 이미 놓인 다른 칸을 옮겼는가(그렸던 판서를 보드가 따라 옮겨야 한다). */
  moved = false;

  /**
   * 칸 잡기. sketch(주문 그림 보여 주기)는 같은 크기 그림처럼 잡는다. connect·mark는 null.
   * expectSmall: 작은 그림이면 이 쪽에 모두 몇 개가 놓일지(이 그림 포함, expectSmallOnPage로 센 값).
   * 주면 그 수에 맞춰 가운데 정렬하고, 나중에 더 오면 이미 놓인 칸도 옆으로 옮긴다(칸 객체를 고친다 →
   * 그린 판서는 board.relayout()으로 따라 옮긴다). 안 주면 예전처럼 왼쪽부터 세 칸(데모·시험용).
   */
  place(op: DrawOp, expectSmall?: number): Placement | null {
    this.moved = false;
    if (op.kind !== 'text' && op.kind !== 'figure' && op.kind !== 'sketch') return null;
    const newPage = breaks(this.s, op);
    if (newPage) this.reset();
    occupy(this.s, op);
    let rect: Rect;
    let scale = 1;
    if (op.kind === 'text') {
      rect = op.role === 'title' ? { ...TITLE } : { x: 48, y: NOTE_Y[this.s.notes - 1], w: 1184, h: NOTE_H };
    } else if (op.size === 'wide') {
      rect = { ...WIDE };
      scale = 11.84;
    } else {
      rect = { x: 0, y: SMALL_Y, w: SMALL_SIZE, h: SMALL_SIZE };
      this.smalls.push(rect);
      this.expected = expectSmall === undefined ? SMALL_MAX : Math.max(this.expected, expectSmall);
      this.moved = this.arrange(rect);
      scale = 3.76;
    }
    if (op.id) this.byId.set(op.id, rect);
    return { rect, newPage, scale };
  }

  /**
   * 앞으로 올 판서(ops, 맨 앞은 지금 놓을 판서)를 지금 쪽에 차례로 놓는다고 치면 이 쪽에 작은 그림이 모두 몇 개인가.
   * 쪽이 넘어가는 판서에서 멈춘다(맨 앞 판서가 쪽을 넘기면 새 쪽부터 센다). 상태는 바꾸지 않는다.
   */
  expectSmallOnPage(ops: readonly DrawOp[]): number {
    let s = { ...this.s };
    let n = this.smalls.length;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (breaks(s, op)) {
        if (i > 0) break;
        s = empty();
        n = 0;
      }
      occupy(s, op);
      if (isSmall(op)) n++;
    }
    return Math.min(SMALL_MAX, n);
  }

  /**
   * 이 쪽에 올 작은 그림 수를 다시 센다(놓인 칸 + ops 중 쪽이 넘어가기 전의 작은 그림). 짐작을 줄일 수도 있다:
   * 앞을 내다볼 때 센 주문 그림이 칸을 잡기 전에 실패하면(QA2 2026-11-23) 첫 그림이 2개 자리(왼쪽)에 혼자 남았다.
   * ops: 아직 칸을 안 잡은 도착한 판서(순서대로). 이미 놓인 칸이 옮겨졌으면 true(보드가 따라 옮긴다).
   */
  recount(ops: readonly DrawOp[]): boolean {
    if (this.smalls.length === 0) {
      this.expected = 0;
      return false;
    }
    const s = { ...this.s };
    let n = this.smalls.length;
    for (const op of ops) {
      if (breaks(s, op)) break;
      occupy(s, op);
      if (isSmall(op)) n++;
    }
    this.expected = Math.min(SMALL_MAX, n);
    return this.arrange();
  }

  /**
   * 작은 그림 칸 하나를 비운다(주문 그림 실패·끝내 안 옴). 남은 칸은 그 수에 맞춰 다시 가운데로 모이고,
   * 비운 칸은 크기 0이 된다(그 칸을 가리키던 연결선은 보드가 지운다). 이 쪽의 칸이 아니면 false.
   */
  release(rect: Rect): boolean {
    const i = this.smalls.indexOf(rect);
    if (i < 0) return false;
    this.smalls.splice(i, 1);
    this.s.small--;
    this.expected = Math.max(this.smalls.length, this.expected - 1);
    for (const [id, r] of this.byId) if (r === rect) this.byId.delete(id);
    rect.w = 0;
    rect.h = 0;
    this.arrange();
    return true;
  }

  /** 작은 그림 칸을 개수에 맞춰 가운데 정렬로 놓는다(칸 객체를 그대로 고친다). fresh 말고 다른 칸이 옮겨졌으면 true. */
  private arrange(fresh?: Rect): boolean {
    const n = Math.min(SMALL_MAX, Math.max(this.smalls.length, this.expected)) as 1 | 2 | 3;
    if (n < 1) return false;
    const xs = SMALL_XS[n];
    let moved = false;
    this.smalls.forEach((r, i) => {
      const x = xs[Math.min(i, xs.length - 1)];
      if (r !== fresh && r.x !== x) moved = true;
      r.x = x;
    });
    return moved;
  }

  rectOf(id: string): Rect | undefined {
    return this.byId.get(id);
  }

  reset(): void {
    this.s = empty();
    this.byId.clear();
    this.smalls = [];
    this.expected = 0;
  }
}

// 판서 층 다루기: 그리는 중 묶음(live) → 지금 쓰는 획(active) → 다 그린 판서(ink, 정적).
// 마커 필터는 묶음마다 자기 영역만 건다(보드 전체에 하나를 걸면 조금만 바뀌어도 전체를 다시 계산한다).
import { BOARD } from './layout';
import { fx, liteEffects, svg } from './dom';

/** 마커 질감 필터 프리미티브(시안 그대로). 모든 층이 같은 것을 써서 층을 옮겨도 모양이 튀지 않는다. */
export const MARKER_PRIMS = `
  <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" result="wobble"/>
  <feDisplacementMap in="SourceGraphic" in2="wobble" scale="2.2" xChannelSelector="R" yChannelSelector="G" result="w"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="1" seed="9" result="streak"/>
  <feColorMatrix in="streak" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.5 0 0 0 1.15" result="streakA"/>
  <feComposite in="w" in2="streakA" operator="in"/>`;

export type Active = { activate(node: Element | null): void; deactivate(): void; close(): void };

export class Layers {
  /** 지금 '쓰는 중' 묶음들이 베낀 조상 transform·clip-path를 다시 베끼는 함수들. */
  private readonly syncs = new Set<() => void>();

  constructor(
    private readonly ink: SVGGElement, // 다 그린 판서
    private readonly liveRoot: SVGGElement, // 그리는 중인 판서
    private readonly activeRoot: SVGGElement, // 지금 쓰는 획 하나
    private readonly liveDefs: SVGDefsElement, // 층별 필터 정의
    private readonly nextId: (kind: string) => string,
  ) {}

  openLive(cls: string): { holder: SVGGElement; g: SVGGElement } {
    const holder = svg('g', { class: 'ink-live' });
    const g = svg('g', { class: cls });
    holder.appendChild(g);
    this.liveRoot.appendChild(holder);
    return { holder, g };
  }

  /**
   * 그리는 중 묶음에 정적 층과 같은 마커 필터를 자기 영역(+여백)만 걸어 비용을 줄인다.
   * (turbulence는 사용자 좌표 기준이라 영역이 달라도 무늬가 같다 → 정적 층으로 옮겨도 모양이 튀지 않는다.)
   */
  filterLive(holder: SVGGElement): SVGFilterElement | null {
    if (liteEffects()) return null; // 아이패드 등: 질감 없이 매끄럽게
    const id = this.nextId('lf');
    const f = svg('filter', { id, filterUnits: 'userSpaceOnUse' });
    f.innerHTML = MARKER_PRIMS; // 정적 문자열
    fitFilter(f, holder);
    this.liveDefs.appendChild(f);
    holder.setAttribute('filter', `url(#${id})`);
    return f;
  }

  /**
   * '쓰는 중' 묶음: 지금 그리는 획 하나만 여기로 옮겨(조상의 transform·clip-path를 그대로 베껴) 그 획 영역만
   * 매 프레임 필터한다. 판서 묶음 필터는 획이 들어오고 나갈 때만 다시 계산된다(WebKit은 바뀌지 않은 필터 결과를 재사용).
   */
  openActive(): Active {
    const holder = svg('g', { class: 'ink-live active' });
    this.activeRoot.appendChild(holder);
    const filter = this.filterLive(holder);
    let back: (() => void) | null = null;
    return {
      activate: (node) => {
        back?.();
        back = null;
        const parent = node?.parentNode;
        if (!node || !parent || !holder.isConnected) return;
        const chain: Element[] = [];
        for (let p: Element | null = parent as Element; p && !p.classList.contains('ink-live'); p = p.parentElement) chain.push(p);
        let host: Element = holder;
        const pairs: [Element, Element][] = [];
        const copy = (anc: Element, c: Element) => {
          for (const a of ['transform', 'clip-path']) {
            const v = anc.getAttribute(a);
            if (v) c.setAttribute(a, v);
            else c.removeAttribute(a);
          }
        };
        for (const anc of chain.reverse()) {
          const c = svg('g');
          copy(anc, c);
          pairs.push([anc, c]);
          host.appendChild(c);
          host = c;
        }
        // 쓰는 동안 판서 묶음이 옮겨지면(relayout) 베낀 transform도 따라 바꾼다(syncActive).
        const sync = () => {
          for (const [anc, c] of pairs) copy(anc, c);
        };
        this.syncs.add(sync);
        const mark = document.createComment('');
        parent.insertBefore(mark, node);
        host.appendChild(node);
        if (filter) fitFilter(filter, holder);
        const inner = host;
        back = () => {
          this.syncs.delete(sync);
          // 획과 그 사이 생긴 잉크 점을 원래 자리로
          if (mark.parentNode) for (const k of [...inner.childNodes]) mark.parentNode.insertBefore(k, mark);
          mark.remove();
          holder.replaceChildren();
        };
      },
      deactivate: () => {
        back?.();
        back = null;
      },
      close: () => {
        back?.();
        back = null;
        holder.remove();
        filter?.remove();
      },
    };
  }

  /** 판서 묶음의 transform이 바뀌었다(relayout): 쓰는 중 획의 베낀 조상도 맞춘다(QA2 2026-11-23: 옮기는 동안 그 획만 옛 자리에 남았다). */
  syncActive(): void {
    for (const s of this.syncs) s();
  }

  /**
   * 다 그린(또는 멈춘) 판서를 정적 층으로 옮긴다. 필터는 판서마다 자기 영역만(그리는 중에 쓰던 것 그대로) 건다.
   */
  settle(holder: SVGGElement, g: SVGGElement, filter: SVGFilterElement | null, live: () => boolean): void {
    // g가 이미 빠졌으면(writeIdle가 앞 문구를 치움) 되살리지 않는다
    if (live() && holder.isConnected && g.isConnected) {
      if (filter) g.setAttribute('filter', `url(#${filter.id})`);
      this.ink.appendChild(g);
    } else {
      filter?.remove();
    }
    holder.remove();
  }
}

/** 필터 영역을 묶음 상자(+여백)에 맞춘다. 못 재면 보드 전체. */
export function fitFilter(f: SVGFilterElement, holder: SVGGElement): void {
  let b = { x: -20, y: -20, width: BOARD.w + 40, height: BOARD.h + 40 };
  try {
    const bb = holder.getBBox();
    if ([bb.x, bb.y, bb.width, bb.height].every(Number.isFinite) && bb.width > 0 && bb.height > 0) {
      const pad = 28;
      const x0 = Math.max(-20, bb.x - pad), y0 = Math.max(-20, bb.y - pad);
      const x1 = Math.min(BOARD.w + 20, bb.x + bb.width + pad), y1 = Math.min(BOARD.h + 20, bb.y + bb.height + pad);
      if (x1 > x0 && y1 > y0) b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  } catch {
    /* 보드 전체 */
  }
  f.setAttribute('x', fx(b.x));
  f.setAttribute('y', fx(b.y));
  f.setAttribute('width', fx(b.width));
  f.setAttribute('height', fx(b.height));
}

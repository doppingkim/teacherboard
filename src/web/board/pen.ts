// 마커 펜 스프라이트: 끝이 선을 따라가고, 몸통·뚜껑은 지금 획 색. 쓰는 중엔 닿은 그림자, 들면 떠 있는 그림자.
import { BOARD } from './layout';
import { shadeInk } from './primitives';
import { clamp01, fx, lerp, smoothstep, tween } from './dom';

// C4(2026-11-23): 실사 'DRY ERASE' 흰 몸통 마커(길이 약 190, 52°)는 크고, 몸통이 방금 쓴 글자 아래쪽을 덮었다.
// 이제 몸통 전체가 쓰는 색인 작은 마커(길이 약 110)를 오른쪽 아래 32°로 눕힌다: 펜촉이 쓰는 점에 정확히 오고,
// 몸통은 늘 펜촉의 오른쪽·아래에만 있어 이미 쓴 글자(왼쪽)와 윗줄을 덮지 않는다(가로로 쓰는 다음 글자 자리 위에 눕는다).
const PEN_ANGLE = 32; // 마커 몸통 기울기(도, 오른쪽 아래로)
const PEN_HIDE_MS = 650; // 다 쓰고 이만큼 쉬면 마커를 치운다
/** 펜 크기(보드 px 배율). 길이 ≈ 124 × 0.9 ≈ 112 = 제목 글자 높이의 두 배쯤. */
const PEN_SCALE = 0.9;
/** 들었을 때 커지는 정도(가까워 보이게). 작게: 들어도 몸통이 펜촉 왼쪽·위로 넘어가지 않게. */
const PEN_LIFT_SCALE = 0.04;

/**
 * 펜 마크업(정적 문자열). u: 보드 uid(그라디언트 id 접두사).
 * 쓰는 색 마커: 펠트 촉(잉크 색) → 회색 받침 → 밝은 플라스틱 코 → 쓰는 색 몸통 → 조금 더 진한 뚜껑(클립).
 * 원통 느낌은 색 위에 겹친 명암 그라디언트 하나로 낸다(요소 수를 줄여 아이패드에서 매 프레임 합성만 하게). 글자(라벨)는 없다.
 */
export function penMarkup(u: string): string {
  const shade = `url(#${u}-cyl)`;
  const BODY = 'M21.6 -9 L96 -9 L96 9 L21.6 9 Z';
  const CAP = 'M95.5 -10 L119 -10 Q124 -10 124 -5 L124 5 Q124 10 119 10 L95.5 10 Z';
  const NIB = 'M0 0 C1 -2.6 3.5 -3.4 7 -3.4 L7 3.4 C3.5 3.4 1 2.6 0 0 Z';
  return `
            <g class="pen" style="opacity:0">
              <defs>
                <!-- 흐림 필터 대신 가장자리로 갈수록 옅어지는 그라디언트(필터는 아이패드에서 매 프레임 CPU로 계산돼 버벅였다) -->
                <linearGradient id="${u}-pshade" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#141821" stop-opacity="0"/>
                  <stop offset="0.5" stop-color="#141821" stop-opacity="1"/>
                  <stop offset="1" stop-color="#141821" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="${u}-cyl" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#000" stop-opacity="0.3"/>
                  <stop offset="0.14" stop-color="#fff" stop-opacity="0.12"/>
                  <stop offset="0.28" stop-color="#fff" stop-opacity="0.62"/>
                  <stop offset="0.42" stop-color="#fff" stop-opacity="0.1"/>
                  <stop offset="0.75" stop-color="#000" stop-opacity="0.05"/>
                  <stop offset="1" stop-color="#000" stop-opacity="0.42"/>
                </linearGradient>
                <linearGradient id="${u}-plastic" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#cfd4d9"/>
                  <stop offset="0.3" stop-color="#ffffff"/>
                  <stop offset="1" stop-color="#9aa2aa"/>
                </linearGradient>
              </defs>
              <g class="pen-shadow">
                <rect class="core" x="-3" y="-13" width="130" height="26" rx="12" fill="url(#${u}-pshade)"/>
              </g>
              <g class="pen-body">
                <!-- 펠트 촉: 잉크 색(조금 진하게), 끝이 둥글고 끝점이 원점(쓰는 점) -->
                <path class="pen-nib" d="${NIB}"/>
                <path d="${NIB}" fill="${shade}"/>
                <!-- 촉 받침 + 밝은 플라스틱 코 -->
                <rect x="6.6" y="-4" width="2.8" height="8" rx="0.7" fill="#4a5057"/>
                <path d="M9.2 -4 L22 -8.6 L22 8.6 L9.2 4 Z" fill="url(#${u}-plastic)"/>
                <!-- 몸통: 쓰는 색 -->
                <path class="pen-col" d="${BODY}"/>
                <path d="${BODY}" fill="${shade}"/>
                <rect x="23" y="-5.6" width="72" height="1.5" rx="0.75" fill="#fff" opacity="0.5"/>
                <!-- 뚜껑: 같은 색을 조금 진하게 + 흰 띠 한 줄 -->
                <path class="pen-col" d="${CAP}"/>
                <path d="${CAP}" fill="#000" opacity="0.18"/>
                <path d="${CAP}" fill="${shade}"/>
                <rect x="95.5" y="-10" width="2.2" height="20" fill="#fff" opacity="0.55"/>
                <!-- 뚜껑 클립 -->
                <path class="pen-col" d="M100 -12 L118 -12 Q121 -12 121 -9.6 L121 -8.6 L100 -8.6 Z"/>
                <path d="M100 -12 L118 -12 Q121 -12 121 -9.6 L121 -8.6 L100 -8.6 Z" fill="#fff" opacity="0.3"/>
              </g>
            </g>`;
}

export class MarkerPen {
  private readonly body: SVGGElement;
  private readonly shadow: SVGGElement;
  private readonly shadowCore: SVGElement;
  private readonly colored: SVGElement[];
  private readonly nib: SVGElement;
  private owner = 0; // 0이면 아무도 안 씀
  private seq = 0;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private color = '';
  visible = false;
  x = BOARD.w / 2;
  y = BOARD.h / 2;
  h = 1; // 0: 보드에 닿음, 1: 들림

  constructor(private readonly root: SVGGElement) {
    this.body = root.querySelector('.pen-body')!;
    this.shadow = root.querySelector('.pen-shadow')!;
    this.shadowCore = root.querySelector('.pen-shadow .core')!;
    this.nib = root.querySelector('.pen-nib')!;
    this.colored = [...root.querySelectorAll<SVGElement>('.pen-col')];
    this.place();
  }

  /** 펜을 잡는다(토큰). 다른 판서가 쓰는 중이면 0: 펜 없이 그린다. */
  take(): number {
    if (this.owner !== 0) return 0;
    this.owner = ++this.seq;
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    return this.owner;
  }

  /** 다 쓰면 마커를 살짝 들고, 한동안 안 쓰면 치운다. */
  release(token: number, live: () => boolean): void {
    if (this.owner !== token) return;
    this.owner = 0;
    const h0 = this.h;
    const still = () => live() && this.owner === 0 && this.seq === token;
    void tween(160, (p) => this.moveTo(this.x, this.y, lerp(h0, 1, smoothstep(p))), still).then(() => {
      if (!still()) return;
      this.hideTimer = setTimeout(() => {
        if (still()) this.hide();
      }, PEN_HIDE_MS);
    });
  }

  /** 보드가 비워질 때: 누가 잡고 있었든 놓는다. */
  reset(): void {
    this.owner = 0;
    this.hide(0);
  }

  show(): void {
    this.visible = true;
    this.root.style.opacity = '1';
    this.place();
  }

  hide(fadeMs = 220): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.visible = false;
    this.root.style.transition = fadeMs > 0 ? `opacity ${fadeMs}ms ease-out` : 'none';
    this.root.style.opacity = '0';
    this.h = 1;
  }

  setColor(color: string): void {
    if (color === this.color) return;
    this.color = color;
    for (const el of this.colored) el.style.fill = color;
    this.nib.style.fill = shadeInk(color, 0.18);
  }

  /** h: 0이면 보드에 닿음(짧고 진한 그림자), 1이면 들림(옅고 멀어진 그림자, 살짝 커짐). */
  moveTo(x: number, y: number, h: number, smooth = false): void {
    if (smooth) {
      x = lerp(this.x, x, 0.5);
      y = lerp(this.y, y, 0.5);
    }
    this.x = x;
    this.y = y;
    this.h = clamp01(h);
    this.place();
  }

  private place(): void {
    const h = this.h;
    if (this.visible) this.root.style.transition = 'opacity 180ms ease-out';
    this.root.setAttribute('transform', `translate(${fx(this.x)} ${fx(this.y)})`);
    // 들어도 몸통은 제자리(펜촉 = 그 점). 들린 느낌은 멀어지는 그림자와 살짝 커지는 크기로만 낸다.
    this.body.setAttribute('transform', `rotate(${PEN_ANGLE}) scale(${(PEN_SCALE + PEN_LIFT_SCALE * h).toFixed(3)})`);
    this.shadow.setAttribute(
      'transform',
      `translate(${fx(1.5 + 8 * h)} ${fx(2.5 + 11 * h)}) rotate(${(PEN_ANGLE - 3 - 5 * h).toFixed(1)}) scale(${(PEN_SCALE + PEN_LIFT_SCALE * h).toFixed(3)})`,
    );
    // 그림자는 작은 펜 모양 하나만 흐린다(필터 영역이 작아 매 프레임 다시 그려도 가볍다). 들리면 옅고 멀어진다.
    this.shadowCore.setAttribute('fill-opacity', (0.42 - 0.22 * h).toFixed(3));
  }
}

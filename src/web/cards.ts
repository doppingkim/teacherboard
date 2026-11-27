// 질문 카드(칠판 위에 붙는 누르는 카드).
// (빈 칠판 예시 질문 카드 A1은 2026-11-23 사용자 결정으로 뺐다 — 빈 칠판은 문구 한 줄만.)
// - 이어 묻기(E2): 수업이 끝나면 그 수업에 이어 물을 질문(모델이 대본 끝 next 줄로 준 것) 2~3개.
//   칠판 판서를 가리지 않게, 보드가 판서를 위쪽으로 살짝 줄여(setRoom) 아래 띠를 비우고 그 띠에 카드를 놓는다.
// 누르면 그 질문으로 바로 수업한다(onPick은 터치 핸들러 안에서 동기적으로 불린다 — 오디오 unlock용).
// 카드 글은 모두 textContent로만 넣는다(모델이 만든 질문도 마크업으로 해석하지 않는다).
import './cards.css';
import { pick } from './i18n';

export type CardKind = 'next';

/** 한 번에 보이는 이어 묻기 카드 수(최대). */
export const NEXT_COUNT = 3;
/** 이어 묻기 카드에 붙는 그림(모델이 준 질문에는 그림이 없다). */
export const NEXT_EMOJI = '💡';

/** 카드가 붙는 보드(판서 면과, 아래 띠를 비우는 기능). */
export type CardHost = { readonly surface: HTMLElement; setRoom(fraction: number): void };

/** 이어 묻기 띠 높이: 판서 면 높이의 이만큼(최소 NEXT_BAND_MIN_PX, 최대 NEXT_BAND_MAX). */
const NEXT_BAND = 0.2;
const NEXT_BAND_MIN_PX = 60; // 카드 44px + 위아래 여백: 아이 손가락으로 누를 수 있게
const NEXT_BAND_MAX = 0.4;

export class QuestionCards {
  private readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private shown: CardKind | null = null;
  private readonly onResize = () => {
    if (this.shown === 'next') this.fitNextBand();
  };

  constructor(private readonly host: CardHost, private readonly onPick: (question: string, kind: CardKind) => void) {
    this.root = document.createElement('div');
    this.root.className = 'q-cards';
    this.root.hidden = true;
    this.list = document.createElement('div');
    this.list.className = 'q-cards-list';
    this.list.setAttribute('role', 'group');
    this.root.append(this.list);
    host.surface.append(this.root);
    window.addEventListener('resize', this.onResize);
  }

  get kind(): CardKind | null {
    return this.shown;
  }

  /** 수업 끝 이어 묻기 카드. 질문이 없으면 아무것도 안 한다(카드 없이 지금처럼). */
  showNext(questions: readonly string[]): void {
    const qs = questions.filter((q) => typeof q === 'string' && q.trim()).slice(0, NEXT_COUNT);
    if (qs.length === 0) return this.hide();
    this.render('next', qs.map((text) => ({ emoji: NEXT_EMOJI, text: text.trim() })), pick('이어서 물어보기', 'Ask next'));
    this.fitNextBand();
  }

  hide(): void {
    if (this.shown === 'next') this.host.setRoom(0);
    this.shown = null;
    this.root.hidden = true;
    this.root.className = 'q-cards';
    this.list.replaceChildren();
  }

  private render(kind: CardKind, cards: { emoji: string; text: string }[], label: string): void {
    this.shown = kind;
    this.root.className = `q-cards q-cards-${kind}`;
    this.list.setAttribute('aria-label', label);
    this.list.replaceChildren(
      ...cards.map((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-card';
        b.style.setProperty('--i', String(i)); // 차례로 붙는 애니메이션
        const emoji = document.createElement('span');
        emoji.className = 'q-card-emoji';
        emoji.setAttribute('aria-hidden', 'true');
        emoji.textContent = c.emoji;
        const text = document.createElement('span');
        text.className = 'q-card-text';
        text.textContent = c.text;
        b.append(emoji, text);
        b.addEventListener('click', () => {
          if (this.shown !== kind) return; // 사라지는 중에 눌림
          // 키보드로 눌렀으면 초점이 사라지는 카드와 함께 body로 떨어지지 않게 칠판으로 옮긴다(다음 Tab은 질문창·스위치).
          const focused = this.root.contains(document.activeElement);
          this.hide();
          if (focused) this.focusBoard();
          this.onPick(c.text, kind);
        });
        return b;
      }),
    );
    this.root.hidden = false;
  }

  private focusBoard(): void {
    const board = this.host.surface.closest<HTMLElement>('.board');
    if (!board) return;
    if (board.tabIndex < 0 && !board.hasAttribute('tabindex')) board.tabIndex = -1; // 초점만 받을 수 있게(Tab 순서에는 안 듦)
    board.focus({ preventScroll: true });
  }

  /** 이어 묻기 띠: 판서를 그만큼 위로 줄이고, 카드는 비운 띠에 놓는다(판서를 가리지 않게). */
  private fitNextBand(): void {
    const h = this.host.surface.clientHeight;
    if (h <= 0) return;
    // 카드의 자연 높이(좁은 화면에선 글이 여러 줄)를 재서 띠를 그만큼 — 최소 NEXT_BAND·NEXT_BAND_MIN_PX, 최대 NEXT_BAND_MAX.
    this.root.style.setProperty('--band', 'auto');
    const natural = this.root.offsetHeight;
    const frac = Math.min(NEXT_BAND_MAX, Math.max(NEXT_BAND, NEXT_BAND_MIN_PX / h, natural / h));
    this.root.style.setProperty('--band', `${(frac * 100).toFixed(2)}%`);
    this.host.setRoom(frac);
  }
}

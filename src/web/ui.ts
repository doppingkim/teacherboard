// 화면 조각(프로필 고르기·시작, 질문 입력창, 상단 로고·프로필 칩). 흐름은 main.ts가 정한다.
import { LESSON_MODES, LEVELS, MAX_QUESTION_CHARS, type LessonMode, type Level } from '../shared/lesson';
import type { Profile } from '../shared/script';
import { PIN_LENGTH, PinEntry, type PinResult } from './pinClient';
import type { MicDevice } from './voice/mic';
import { LANG, pick, switchLang } from './i18n';

const COPY_KO = {
  idle: '궁금한 거 물어봐!',
  /** 질문 뒤 첫 말이 나오기 전(빠른 선생님: 약 3초, 신중한 선생님: 약 20초). */
  thinking: {
    quick: ['빠른 선생님이 생각하는 중', '칠판에 쓸 준비 중'],
    deep: [
      '신중한 선생님이 질문을 꼼꼼히 읽는 중',
      '답의 핵심을 한 문장으로 정리하는 중',
      '쏙 들어올 비유를 고르는 중',
      '칠판에 그릴 그림을 구상하는 중',
      '설명 순서를 차례차례 맞추는 중',
      '거의 다 됐어, 조금만 기다려 줘',
    ],
  },
  done: '또 궁금한 거 있어?',
  error: '앗, 잠깐 문제가 생겼어. 다시 물어봐 줄래?',
  /** 말로 물었는데 연달아 못 알아들었을 때 들은 말 말풍선에 한 번(E7, voiceController.ts). */
  misheard: '잘 못 들었어. 다시 말해 줄래?',
};
export const COPY: typeof COPY_KO = pick(COPY_KO, {
  idle: 'Ask me anything!',
  thinking: {
    quick: ['The quick teacher is thinking', 'Getting ready to write on the board'],
    deep: [
      'The careful teacher is reading your question closely',
      'Boiling the answer down to one sentence',
      'Picking an analogy that clicks',
      'Planning the pictures for the board',
      'Putting the steps in order',
      'Almost there, hang on a moment',
    ],
  },
  done: 'Anything else you wonder about?',
  error: 'Oops, something went wrong. Could you ask again?',
  misheard: "I didn't quite catch that. Could you say it again?",
});

/** 가족 비밀번호 화면 문구. */
const PIN_COPY_KO = {
  ask: '가족 비밀번호를 눌러 줘',
  wrong: '다시 해 볼까?',
  locked: (minutes: number) => `잠깐 쉬었다가 다시 해 줘 (${minutes}분)`,
  error: '앗, 연결이 안 돼. 다시 눌러 줄래?',
};
export const PIN_COPY: typeof PIN_COPY_KO = pick(PIN_COPY_KO, {
  ask: 'Enter the family PIN',
  wrong: 'Try again?',
  locked: (minutes: number) => `Take a short break and try again (${minutes} min)`,
  error: "Oops, can't connect. Could you try again?",
});

/** 설명 방식 스위치 문구. */
/** 설명 수준 스위치 문구. */
export const LEVEL_COPY: Record<Level, { label: string; hint: string }> = LANG === 'en' ? {
  elementary: { label: 'Easy', hint: 'Simple words and everyday analogies' },
  middle: { label: 'Medium', hint: 'Names of concepts and simple numbers' },
  adult: { label: 'Deep', hint: 'Precise terms, mechanisms, numbers, and research' },
} : {
  // 나이·실력이 아니라 '설명 방식'을 고르는 이름(2026-11-22 사용자 결정: 초등·중등·성인은 사람을 나누는 말이라 피함)
  elementary: { label: '쉽게', hint: '쉬운 낱말과 생활 속 비유로' },
  middle: { label: '보통', hint: '개념 이름과 간단한 수치까지' },
  adult: { label: '깊게', hint: '정확한 용어, 원리, 수치, 연구 이야기까지' },
};

export const MODE_COPY: Record<LessonMode, { label: string; hint: string }> = LANG === 'en' ? {
  quick: { label: 'Quick teacher', hint: 'Explains right away' },
  deep: { label: 'Careful teacher', hint: 'Thinks for about 15-25 seconds, explains in more detail, and draws the pictures itself' },
} : {
  quick: { label: '빠른 선생님', hint: '바로 설명해 줘요' },
  deep: { label: '신중한 선생님', hint: '15~25초쯤 생각하고 더 자세히, 그림도 직접 그려요' },
};

/**
 * 마이크 칩 상태(C5·A2). ask: 이 기기에서 아직 마이크를 쓴 적이 없다 — 경고 대신 "말로 물어볼래?" 버튼(누르면 허락 창).
 * 화면에는 아이콘 + 짧은 말, 화면 읽기에는 '마이크'를 붙인 이름(MIC_NAME).
 */
export type MicStatus = 'ask' | 'listening' | 'off' | 'denied' | 'error';
export const MIC_COPY: Record<MicStatus, string> = LANG === 'en' ? {
  ask: 'Ask out loud?',
  listening: 'Listening',
  off: 'Off',
  denied: 'Need permission',
  error: 'Not connected',
} : {
  ask: '말로 물어볼래?',
  listening: '듣는 중',
  off: '꺼짐',
  denied: '허락 필요',
  error: '연결 안 됨',
};
export const MIC_NAME: Record<MicStatus, string> = LANG === 'en' ? {
  ask: 'Ask out loud?',
  listening: 'Microphone listening',
  off: 'Microphone off',
  denied: 'Microphone needs permission',
  error: 'Microphone not connected',
} : {
  ask: '말로 물어볼래?',
  listening: '마이크 듣는 중',
  off: '마이크 꺼짐',
  denied: '마이크 허락 필요',
  error: '마이크 연결 안 됨',
};
const MIC_HINT: Record<MicStatus, string> = LANG === 'en' ? {
  ask: 'Tap to allow the microphone. You can also type your question',
  listening: 'Tap to turn the microphone off',
  off: 'Tap to turn the microphone on',
  denied: 'You can type your question. Tap to ask for microphone permission again',
  error: 'Tap to reconnect',
} : {
  ask: '누르면 마이크 허락 창이 떠요. 글로 물어봐도 돼요',
  listening: '누르면 마이크를 꺼요',
  off: '누르면 마이크를 켜요',
  denied: '글로 물어봐도 돼요. 누르면 마이크 허락을 다시 물어봐요',
  error: '누르면 다시 연결해 봐요',
};
/** 마이크 아이콘(빗금·느낌표는 상태에 따라 CSS가 보인다). 정적인 마크업. */
const MIC_ICON = `<svg class="mic-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" fill-opacity="0.18"/>
  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3.5M8.5 21h7"/>
  <path class="mi-slash" d="M4 3.5l16 17"/>
  <g class="mi-warn"><circle cx="18.5" cy="18.5" r="4.6" fill="currentColor" stroke="none"/><path d="M18.5 16.2v2.6M18.5 21v0.1" style="stroke: var(--mic-bg)" stroke-width="1.9"/></g>
</svg>`;
/** 듣는 중 막대 셋의 몫(가운데가 가장 크게 움직인다). */
const BAR_GAIN = [0.75, 1, 0.6];
/** 안전하지 않은 주소(http + LAN IP 등)라 브라우저가 마이크를 아예 안 줄 때의 설명. */
export const MIC_INSECURE_HINT = pick(
  '이 주소에서는 마이크를 쓸 수 없어요. https 주소나 이 컴퓨터(localhost)에서 열어 주세요',
  "The microphone can't be used at this address. Open it over https or on this computer (localhost)",
);
export const MIC_PICKER_TITLE = pick('마이크 고르기', 'Choose microphone');
/** 들은 말 말풍선에 보일 최대 글자 수(넘치면 앞을 줄인다). */
const HEARD_MAX = 40;

export const PROFILE_LABEL: Record<Profile, string> = pick({ kid: '🧒 아이', adult: '🙂 어른' }, { kid: '🧒 Kid', adult: '🙂 Adult' });
const PROFILE_EMOJI: Record<Profile, string> = { kid: '🧒', adult: '🙂' };
const PROFILE_WORD: Record<Profile, string> = pick({ kid: '아이', adult: '어른' }, { kid: 'Kid', adult: 'Adult' });
const START_WHO: Record<Profile, string> = pick(
  { kid: '🧒 아이로 시작해요', adult: '🙂 어른으로 시작해요' },
  { kid: '🧒 Starting as a kid', adult: '🙂 Starting as an adult' },
);
const LOGO_TEXT = pick('티처보드', 'Teacherboard');

/** 언어 바꾸기 버튼(한국어 ↔ English). 누르면 다시 불러온다. */
const makeLangToggle = (cls: string): HTMLButtonElement => {
  const b = el('button', `lang-toggle ${cls}`, LANG === 'en' ? '한국어' : 'English');
  b.type = 'button';
  b.lang = LANG === 'en' ? 'ko' : 'en';
  b.setAttribute('aria-label', LANG === 'en' ? '한국어로 보기' : 'Switch to English');
  b.addEventListener('click', () => switchLang(LANG === 'en' ? 'ko' : 'en'));
  return b;
};

export type UiHandlers = {
  /** 프로필 버튼 터치. 터치 핸들러 안에서 동기적으로 불린다(오디오 unlock용). */
  onPick(profile: Profile): void;
  /** 저장된 프로필로 "시작" 터치. 역시 동기적으로 불린다. */
  onStart(): void;
  onAsk(question: string): void;
  /** 상단 프로필 칩("프로필 바꾸기"). */
  onChangeProfile(): void;
  /** 상단 설명 방식 스위치(빠른 선생님 / 신중한 선생님). */
  onModeChange(mode: LessonMode): void;
  /** 상단 설명 수준 스위치(초등 / 중등 / 성인). */
  onLevelChange(level: Level): void;
  /** 마이크 상태 알약 터치(끄기·켜기). 터치 핸들러 안에서 동기적으로 불린다(마이크 열기용). */
  onToggleMic(): void;
  /** 마이크 고르기 창에서 장치를 골랐다. 역시 동기적으로 불린다. */
  onPickMic(deviceId: string): void;
  /** 마이크 고르기 창이 열렸다 — 장치 목록(setMicDevices)과 소리 크기(setMicLevel)를 채워 달라. */
  onOpenMicPicker(): void;
  /**
   * 가족 비밀번호 6자리를 다 눌렀다. 결과가 ok면 다음 화면은 main.ts가 띄운다.
   * 틀림·잠김·오류 표시는 Screens가 한다.
   */
  onPinSubmit(pin: string): Promise<PinResult>;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** 글자 로고 "티처보드": 글자마다 span(색·기울기는 CSS .logo span). 화면 읽기에는 한 낱말로. */
const makeLogo = (tag: 'div' | 'h1' | 'button', cls: string): HTMLElement => {
  const logo = el(tag, cls);
  logo.setAttribute('aria-label', LOGO_TEXT);
  for (const ch of LOGO_TEXT) logo.append(el('span', '', ch));
  return logo;
};

/** `<span class="emoji">🧒</span> 아이` — 공백을 남겨 접근성 이름이 "🧒 아이"가 되게 한다. */
const fillProfile = (target: HTMLElement, p: Profile): void => {
  target.replaceChildren(el('span', 'emoji', PROFILE_EMOJI[p]), document.createTextNode(` ${PROFILE_WORD[p]}`));
};

export class Screens {
  private readonly overlay: HTMLDivElement;
  private readonly picker: HTMLDivElement;
  private readonly start: HTMLDivElement;
  private readonly startWho: HTMLParagraphElement;
  private readonly corner: HTMLButtonElement;
  private readonly sides: HTMLElement[];
  private readonly modeSwitch: HTMLDivElement;
  private readonly levelSwitch: HTMLDivElement;
  private level: Level = 'elementary';
  private mode: LessonMode = 'quick';
  private readonly host: HTMLElement;
  private micStatusNow: MicStatus = 'off';
  private readonly micBars: HTMLElement[] = [];
  private readonly askForm: HTMLFormElement;
  private readonly askInput: HTMLInputElement;
  private readonly micPill: HTMLButtonElement;
  private readonly micLabel: HTMLSpanElement;
  private readonly micDesc: HTMLSpanElement;
  private readonly micMore: HTMLButtonElement;
  private readonly micPicker: HTMLDivElement;
  private readonly micList: HTMLDivElement;
  private readonly micFill: HTMLDivElement;
  private readonly heard: HTMLDivElement;
  private readonly heardText: HTMLSpanElement;
  private readonly pin: HTMLDivElement;
  private readonly pinDots: HTMLDivElement;
  private readonly pinMsg: HTMLParagraphElement;
  private readonly pinKeys: HTMLButtonElement[] = [];
  private readonly pinEntry = new PinEntry(PIN_LENGTH);
  /** 보내는 중이거나 잠긴 동안은 키를 받지 않는다. */
  private pinBusy = false;
  private pinLockTimer: ReturnType<typeof setTimeout> | undefined;

  /** host(#app)에는 이미 보드와 자막이 들어 있어야 한다 — 입력창은 그 아래에 붙는다. */
  constructor(host: HTMLElement, h: UiHandlers) {
    this.host = host;
    // 질문 입력창(예비 입력 — 말로 묻는 게 기본이고, 글자로도 물을 수 있다)
    this.askForm = el('form', 'ask');
    this.askForm.autocomplete = 'off';
    this.askInput = el('input', 'ask-input');
    this.askInput.type = 'text';
    this.askInput.setAttribute('aria-label', pick('질문', 'Question'));
    this.askInput.placeholder = pick('궁금한 걸 물어봐!', 'Ask me anything!');
    this.askInput.maxLength = MAX_QUESTION_CHARS;
    this.askInput.enterKeyHint = 'send';
    const askBtn = el('button', 'ask-btn', pick('물어보기!', 'Ask!'));
    askBtn.type = 'submit';

    // 마이크 상태 알약(누르면 끄기·켜기) + ▾(마이크 고르기 창)
    const mic = el('div', 'mic');
    this.micPill = el('button', 'mic-pill');
    this.micPill.type = 'button';
    this.micLabel = el('span', 'mic-label');
    const icon = document.createElement('span');
    icon.style.display = 'contents';
    icon.innerHTML = MIC_ICON;
    // 듣는 중 막대: 소리 크기에 따라 살짝 움직인다(setMicActivity)
    const bars = el('span', 'mic-bars');
    bars.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < BAR_GAIN.length; i++) {
      const b = el('i', '');
      this.micBars.push(b);
      bars.append(b);
    }
    // 상태 설명(누르면 무엇이 되는지·https 안내). 이름은 상태(MIC_NAME), 설명은 따로 붙인다.
    this.micDesc = el('span', 'sr-only');
    this.micDesc.id = 'mic-pill-desc';
    this.micPill.setAttribute('aria-describedby', this.micDesc.id);
    this.micPill.append(icon.firstElementChild!, this.micLabel, bars, this.micDesc);
    this.micPill.addEventListener('click', () => h.onToggleMic());
    this.micMore = el('button', 'mic-more', '▾');
    this.micMore.type = 'button';
    this.micMore.setAttribute('aria-label', MIC_PICKER_TITLE);
    this.micMore.title = MIC_PICKER_TITLE;
    this.micMore.setAttribute('aria-haspopup', 'dialog');
    this.micMore.setAttribute('aria-expanded', 'false');
    this.micMore.addEventListener('click', () => {
      if (this.micPickerOpen) {
        this.closeMicPicker(true);
        return;
      }
      this.openMicPicker();
      h.onOpenMicPicker();
    });
    mic.append(this.micPill, this.micMore);

    // 마이크 고르기 창: 장치 라디오 목록 + 소리 크기 막대. 질문창 위에 뜬다.
    this.micPicker = el('div', 'mic-picker');
    this.micPicker.hidden = true;
    this.micPicker.setAttribute('role', 'dialog');
    this.micPicker.setAttribute('aria-label', MIC_PICKER_TITLE);
    this.micList = el('div', 'mic-list');
    this.micList.setAttribute('role', 'radiogroup');
    this.micList.setAttribute('aria-label', MIC_PICKER_TITLE);
    const level = el('div', 'mic-level');
    const meter = el('div', 'mic-meter');
    meter.setAttribute('aria-hidden', 'true');
    this.micFill = el('div', 'mic-meter-fill');
    meter.append(this.micFill);
    level.append(el('span', 'mic-level-label', pick('소리 크기', 'Input level')), meter);
    this.micPicker.append(el('p', 'mic-picker-title', MIC_PICKER_TITLE), this.micList, level);
    this.micList.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.type === 'radio' && t.checked) h.onPickMic(t.value);
    });
    // 라디오에서 Enter를 눌러도 폼이 제출되지 않게(빈 질문이면 입력창으로 초점이 가 버린다)
    this.micPicker.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
    // 열린 동안 Esc는 어디서 눌러도 닫는다
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.micPickerOpen) return;
      e.preventDefault();
      this.closeMicPicker(true);
    });
    // 바깥을 누르면 닫힌다(▾ 버튼은 스스로 여닫는다)
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.micPickerOpen) return;
        const t = e.target as Node;
        if (this.micPicker.contains(t) || this.micMore.contains(t)) return;
        this.closeMicPicker(true);
      },
      true,
    );

    // 들은 말 말풍선: 질문창 바로 위, 판정이 나면 사라진다
    this.heard = el('div', 'heard');
    this.heard.hidden = true;
    this.heard.setAttribute('aria-live', 'polite');
    const ear = el('span', 'heard-ear', '👂');
    ear.setAttribute('aria-hidden', 'true');
    this.heardText = el('span', 'heard-text');
    this.heard.append(ear, document.createTextNode(' '), this.heardText);

    this.askForm.append(mic, this.askInput, askBtn, this.micPicker, this.heard);
    this.setMicStatus('off');
    this.askForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.askInput.value.trim();
      if (!q) {
        this.askInput.focus();
        return;
      }
      this.askInput.value = '';
      this.askInput.blur(); // 휴대폰 자판을 내려 보드가 보이게
      h.onAsk(q);
    });

    // 헤더에는 글자 로고만(2026-11-22 사용자 요청: 이름표를 빼고 헤더를 얇게). 로고를 누르면 프로필(누가 묻는지) 바꾸기.
    const topbar = el('div', 'topbar');
    this.corner = makeLogo('button', 'logo corner-menu') as HTMLButtonElement;
    this.corner.type = 'button';
    this.corner.setAttribute('aria-label', pick('프로필 바꾸기', 'Change profile'));
    this.corner.title = pick('프로필 바꾸기', 'Change profile');
    this.corner.addEventListener('click', () => h.onChangeProfile());
    // 설명 방식 스위치: 빠른 선생님(바로 설명) / 신중한 선생님(오래 생각하고 더 자세히)
    this.modeSwitch = el('div', 'mode-switch');
    this.modeSwitch.setAttribute('role', 'radiogroup');
    this.modeSwitch.setAttribute('aria-label', pick('설명 방식', 'Teacher'));
    this.modeSwitch.hidden = true;
    for (const m of LESSON_MODES) {
      // 칠판 옆 좁은 기둥: "빠른 / 선생님"처럼 두 줄로 맞춘다(화면 읽기에는 한 줄로 읽힌다).
      // 세로 화면의 칠판 아래 줄에서는 줄바꿈을 감춰 한 줄로 보인다(띄어쓰기는 그대로 남게 공백을 둔다).
      const [first, ...rest] = MODE_COPY[m].label.split(' ');
      const b = el('button', 'mode-opt');
      b.append(el('span', '', first), document.createTextNode(' '), document.createElement('br'), el('span', '', rest.join(' ')));
      b.setAttribute('aria-label', MODE_COPY[m].label);
      b.type = 'button';
      b.dataset.mode = m;
      b.setAttribute('role', 'radio');
      b.title = MODE_COPY[m].hint;
      b.addEventListener('click', () => {
        if (this.mode === m) return;
        this.setMode(m);
        h.onModeChange(m);
      });
      this.modeSwitch.appendChild(b);
    }
    // 설명 수준 스위치: 쉽게 / 보통 / 깊게
    this.levelSwitch = el('div', 'mode-switch level-switch');
    this.levelSwitch.setAttribute('role', 'radiogroup');
    this.levelSwitch.setAttribute('aria-label', pick('설명 수준', 'Explanation level'));
    this.levelSwitch.hidden = true;
    for (const lv of LEVELS) {
      const b = el('button', 'mode-opt', LEVEL_COPY[lv].label);
      b.type = 'button';
      b.dataset.level = lv;
      b.setAttribute('role', 'radio');
      b.title = LEVEL_COPY[lv].hint;
      b.addEventListener('click', () => {
        if (this.level === lv) return;
        this.setLevel(lv);
        h.onLevelChange(lv);
      });
      this.levelSwitch.appendChild(b);
    }
    // 두 스위치는 라디오 묶음: 고른 것만 Tab으로 들어가고(setLevel·setMode가 tabIndex를 고친다) 방향키로 고른다.
    radioKeys(this.levelSwitch);
    radioKeys(this.modeSwitch);
    this.setLevel(this.level);
    this.setMode(this.mode);
    topbar.append(this.corner, makeLangToggle('lang-topbar'));
    // 칠판 양옆: 왼쪽은 설명 수준, 오른쪽은 선생님(빠른·신중한).
    // 가로 화면에서는 칠판 높이만 한 기둥이라 스위치 위·아래(칠판 위·아래 모서리 높이)에 손글씨 장식을 하나씩 둔다.
    // 세로 화면에서는 기둥이 칠판 아래 한 줄이 되고 장식은 숨는다(styles.css).
    const doodle = (n: number, ch: string) => {
      const d = el('span', `doodle d${n}`, ch);
      d.setAttribute('aria-hidden', 'true');
      return d;
    };
    const sideLeft = el('div', 'side side-left');
    sideLeft.append(doodle(1, '✦'), this.levelSwitch, doodle(3, '〰'));
    const sideRight = el('div', 'side side-right');
    sideRight.append(doodle(2, '✿'), this.modeSwitch, doodle(4, '★'));
    this.sides = [sideLeft, sideRight];

    // 프로필 고르기 / 시작 화면(보드 위를 덮는다 — 보드는 그대로 렌더링된 채로 둔다)
    this.overlay = el('div', 'overlay');
    this.overlay.hidden = true;
    const card = el('div', 'overlay-card');
    card.append(makeLogo('h1', 'overlay-title logo logo-big'));

    this.picker = el('div', 'picker');
    this.picker.append(el('p', 'overlay-ask', pick('누가 물어볼까?', "Who's asking?")));
    const choices = el('div', 'choices');
    for (const p of ['kid', 'adult'] as const) {
      const b = el('button', `big-btn sticker sticker-${p}`);
      b.type = 'button';
      fillProfile(b, p);
      b.addEventListener('click', () => h.onPick(p));
      choices.append(b);
    }
    this.picker.append(choices);

    this.start = el('div', 'start');
    this.startWho = el('p', 'overlay-ask');
    const startBtn = el('button', 'big-btn sticker start-btn', pick('시작', 'Start'));
    startBtn.type = 'button';
    startBtn.addEventListener('click', () => h.onStart());
    const other = el('button', 'link-btn sticker', pick('다른 사람이에요', "It's someone else"));
    other.type = 'button';
    other.addEventListener('click', () => this.showPicker());
    this.start.append(this.startWho, startBtn, other);

    // 가족 비밀번호: 6칸 점 + 큰 스티커 숫자판(1~9, 0, ⌫). 6자리가 차면 바로 보낸다.
    this.pin = el('div', 'pin');
    this.pin.hidden = true;
    const pinHead = el('div', 'pin-head');
    pinHead.append(el('p', 'overlay-ask', PIN_COPY.ask));
    this.pinDots = el('div', 'pin-dots');
    this.pinDots.setAttribute('role', 'img');
    for (let i = 0; i < PIN_LENGTH; i++) this.pinDots.append(el('span', 'pin-dot'));
    this.pinMsg = el('p', 'pin-msg');
    this.pinMsg.setAttribute('role', 'status');
    pinHead.append(this.pinDots, this.pinMsg);
    const pad = el('div', 'pin-pad');
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back']) {
      if (k === '') {
        pad.append(el('span', 'pin-gap'));
        continue;
      }
      const b = el('button', k === 'back' ? 'sticker pin-key pin-back' : 'sticker pin-key', k === 'back' ? '⌫' : k);
      b.type = 'button';
      if (k === 'back') {
        b.setAttribute('aria-label', pick('지우기', 'Delete'));
        b.title = pick('지우기', 'Delete');
      }
      b.addEventListener('click', () => this.pinKey(k, h));
      this.pinKeys.push(b);
      pad.append(b);
    }
    this.pin.append(pinHead, pad);
    // 키보드 숫자·Backspace도 받는다(PIN 화면이 떠 있을 때만)
    document.addEventListener('keydown', (e) => {
      if (!this.pinOpen || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) this.pinKey(e.key, h);
      else if (e.key === 'Backspace') this.pinKey('back', h);
      else return;
      e.preventDefault();
    });
    this.renderPin();

    card.append(this.picker, this.start, this.pin);
    this.overlay.append(card, makeLangToggle('lang-overlay'));
    host.append(this.askForm, topbar, ...this.sides, this.overlay);
  }

  showPicker(): void {
    this.start.hidden = true;
    this.pin.hidden = true;
    this.picker.hidden = false;
    this.showOverlay();
  }

  /** 저장된 프로필로 다시 시작: 자동 재생을 풀기 위해 터치 한 번은 받는다. */
  showStart(profile: Profile): void {
    this.startWho.textContent = START_WHO[profile];
    this.picker.hidden = true;
    this.pin.hidden = true;
    this.start.hidden = false;
    this.showOverlay();
  }

  /** 가족 비밀번호 화면(프로필 화면보다 먼저). 이미 떠 있으면 그대로 둔다(잠김 표시 유지). */
  showPin(): void {
    if (this.pinOpen) return;
    this.picker.hidden = true;
    this.start.hidden = true;
    this.pin.hidden = false;
    if (!this.pinBusy) this.pinMsg.textContent = '';
    this.pinEntry.clear();
    this.renderPin();
    this.showOverlay();
  }

  /** PIN 화면이 떠 있나. */
  get pinOpen(): boolean {
    return !this.overlay.hidden && !this.pin.hidden;
  }

  private pinKey(k: string, h: UiHandlers): void {
    if (this.pinBusy || !this.pinOpen) return;
    if (k === 'back') {
      this.pinEntry.back();
      this.renderPin();
      return;
    }
    if (this.pinEntry.length === 0) this.pinMsg.textContent = ''; // 다시 누르기 시작하면 앞 안내를 지운다
    const full = this.pinEntry.push(k);
    this.renderPin();
    if (full) void this.submitPin(h);
  }

  private async submitPin(h: UiHandlers): Promise<void> {
    const pin = this.pinEntry.value;
    this.setPinBusy(true);
    let r: PinResult;
    try {
      r = await h.onPinSubmit(pin);
    } catch {
      r = { kind: 'error' };
    }
    this.pinEntry.clear();
    this.renderPin();
    if (r.kind === 'ok') {
      this.pinMsg.textContent = '';
      this.setPinBusy(false);
      return;
    }
    if (r.kind === 'locked') {
      this.pinMsg.textContent = PIN_COPY.locked(Math.max(1, Math.ceil(r.retryAfterSec / 60)));
      clearTimeout(this.pinLockTimer);
      this.pinLockTimer = setTimeout(() => {
        this.pinMsg.textContent = '';
        this.setPinBusy(false);
      }, r.retryAfterSec * 1000);
      return;
    }
    this.pinMsg.textContent = r.kind === 'wrong' ? PIN_COPY.wrong : PIN_COPY.error;
    if (r.kind === 'wrong') this.shakePin();
    this.setPinBusy(false);
  }

  private setPinBusy(on: boolean): void {
    this.pinBusy = on;
    for (const b of this.pinKeys) b.disabled = on;
    this.pin.setAttribute('aria-busy', String(on));
  }

  private shakePin(): void {
    this.pinDots.classList.remove('shake');
    void this.pinDots.offsetWidth; // 애니메이션을 처음부터 다시
    this.pinDots.classList.add('shake');
  }

  private renderPin(): void {
    const n = this.pinEntry.length;
    this.pinDots.querySelectorAll('.pin-dot').forEach((d, i) => d.classList.toggle('on', i < n));
    this.pinDots.setAttribute('aria-label', pick(`${PIN_LENGTH}자리 중 ${n}자리 눌렀어요`, `${n} of ${PIN_LENGTH} digits entered`));
  }

  hideOverlay(): void {
    const a = document.activeElement;
    const focusCovered = !a || a === document.body || this.overlay.contains(a);
    this.overlay.hidden = true;
    this.setBehindInert(false);
    this.askForm.classList.remove('concealed');
    this.corner.hidden = false;
    this.modeSwitch.hidden = false;
    this.levelSwitch.hidden = false;
    // 누른 프로필 버튼이 사라져 초점이 body로 떨어지지 않게 칠판으로 옮긴다. 입력칸이 아니라서 휴대폰 자판이 뜨지 않고,
    // 키보드로는 다음 Tab이 질문창·스위치로 간다.
    if (focusCovered) {
      const board = this.host.querySelector<HTMLElement>('.board');
      if (board) {
        board.tabIndex = -1;
        if (!board.hasAttribute('role')) board.setAttribute('role', 'region');
        if (!board.hasAttribute('aria-label')) board.setAttribute('aria-label', pick('칠판', 'Whiteboard'));
        board.focus({ preventScroll: true });
      }
    }
  }

  /** 설명 수준 스위치 표시. */
  setLevel(level: Level): void {
    this.level = level;
    this.levelSwitch.querySelectorAll<HTMLButtonElement>('.mode-opt').forEach((b) => {
      const on = b.dataset.level === level;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  /** 설명 방식 스위치 표시. */
  setMode(mode: LessonMode): void {
    this.mode = mode;
    this.modeSwitch.dataset.mode = mode;
    this.modeSwitch.querySelectorAll<HTMLButtonElement>('.mode-opt').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  setProfile(profile: Profile): void {
    this.corner.dataset.profile = profile;
    const label = pick(`프로필 바꾸기 (${PROFILE_LABEL[profile]})`, `Change profile (${PROFILE_LABEL[profile]})`);
    this.corner.setAttribute('aria-label', label);
    this.corner.title = label;
  }

  /** 마이크 상태. hint를 주면 기본 안내("누르면 …") 대신 그 설명을 붙인다(예: https가 필요함). */
  setMicStatus(s: MicStatus, hint?: string): void {
    this.micStatusNow = s;
    this.micPill.dataset.status = s;
    this.micLabel.textContent = MIC_COPY[s];
    this.micPill.setAttribute('aria-label', MIC_NAME[s]);
    this.micPill.title = hint ?? MIC_HINT[s];
    this.micDesc.textContent = this.micPill.title;
    if (s !== 'listening') this.setMicActivity(0);
  }

  /** 지금 마이크 칩 상태(main.ts가 듣는 중 막대를 계속 그릴지 본다). */
  get micStatus(): MicStatus {
    return this.micStatusNow;
  }

  /** 듣는 중 막대: 소리 크기 0..1. 조용해도 막대가 조금은 보인다(0.3). 듣는 중일 때만 움직인다. */
  setMicActivity(level: number): void {
    const v = this.micStatusNow === 'listening' && Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.micBars.forEach((b, i) => {
      b.style.transform = `scaleY(${(0.3 + 0.7 * Math.min(1, v * BAR_GAIN[i] * 1.4)).toFixed(2)})`;
    });
  }

  /** 마이크를 여는 중: 상태 문구는 두고 흐리게(빨강·초록 없이) 보인다. */
  setMicPending(on: boolean): void {
    if (on) this.micPill.dataset.pending = '';
    else delete this.micPill.dataset.pending;
    this.micPill.setAttribute('aria-busy', String(on));
  }

  /** 들은 말 말풍선. null이면 숨긴다. ''이면 듣기 시작(아직 글자 없음). */
  setHeard(text: string | null): void {
    if (text === null) {
      this.heard.hidden = true;
      this.heardText.textContent = '';
      return;
    }
    // 길어지면 앞을 줄여 방금 들은 끝부분이 보이게
    this.heardText.textContent = !text ? '…' : text.length > HEARD_MAX ? `…${text.slice(-HEARD_MAX)}` : text;
    this.heard.classList.toggle('waiting', !text);
    this.heard.hidden = false;
  }

  /** 마이크 고르기 창의 장치 목록. selectedId가 목록에 없으면 첫 장치(보통 '기본')에 표시한다. */
  setMicDevices(list: MicDevice[], selectedId: string | null): void {
    const chosen = list.some((d) => d.deviceId === selectedId) ? selectedId : (list[0]?.deviceId ?? null);
    // 같은 장치들이면 다시 만들지 않고 표시만 고친다(화살표로 고르는 중에 초점을 잃지 않게)
    const radios = [...this.micList.querySelectorAll<HTMLInputElement>('input.mic-radio')];
    if (radios.length > 0 && radios.length === list.length && radios.every((r, i) => r.value === list[i].deviceId)) {
      radios.forEach((r, i) => {
        r.checked = r.value === chosen;
        const label = r.nextElementSibling;
        if (label && label.textContent !== list[i].label) label.textContent = list[i].label;
      });
      return;
    }
    const rows: HTMLElement[] = list.map((d) => {
      const row = el('label', 'mic-option');
      const radio = el('input', 'mic-radio');
      radio.type = 'radio';
      radio.name = 'teacherboard-mic';
      radio.value = d.deviceId;
      radio.checked = d.deviceId === chosen;
      row.append(radio, el('span', 'mic-option-label', d.label));
      return row;
    });
    if (rows.length === 0) rows.push(el('p', 'mic-empty', pick('마이크를 찾지 못했어', "Couldn't find a microphone")));
    const hadFocus = this.micPicker.contains(document.activeElement);
    this.micList.replaceChildren(...rows);
    // 처음 채울 때(창은 이미 열림)나 초점이 있던 줄이 사라졌을 때 고른 장치로 초점을 옮긴다
    if (this.micPickerOpen && (hadFocus || !this.micPicker.contains(document.activeElement))) this.focusPickerRadio();
  }

  /** 소리 크기 0..1. 마이크 고르기 창이 열렸을 때만 그린다. */
  setMicLevel(level: number): void {
    if (!this.micPickerOpen) return;
    const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.micFill.style.transform = `scaleX(${v.toFixed(3)})`;
  }

  /** 마이크 고르기 창이 열려 있나(소리 크기 막대를 계속 그릴지 main.ts가 본다). */
  get micPickerOpen(): boolean {
    return !this.micPicker.hidden;
  }

  private openMicPicker(): void {
    this.micFill.style.transform = 'scaleX(0)';
    this.micPicker.hidden = false;
    this.micMore.setAttribute('aria-expanded', 'true');
    this.focusPickerRadio();
  }

  /** 고른 장치(없으면 첫 장치) 라디오로 초점. 목록이 아직 없으면 창 자체로. */
  private focusPickerRadio(): void {
    const r =
      this.micList.querySelector<HTMLInputElement>('input.mic-radio:checked') ??
      this.micList.querySelector<HTMLInputElement>('input.mic-radio');
    if (r) r.focus({ preventScroll: true });
    else {
      this.micPicker.tabIndex = -1;
      this.micPicker.focus({ preventScroll: true });
    }
  }

  /** returnFocus: 초점이 창 안에 있었으면 ▾로 돌려준다(키보드로 계속 쓸 수 있게). */
  private closeMicPicker(returnFocus = false): void {
    if (this.micPicker.hidden) return;
    const focusInside = this.micPicker.contains(document.activeElement);
    this.micPicker.hidden = true;
    this.micMore.setAttribute('aria-expanded', 'false');
    if (returnFocus && (focusInside || document.activeElement === document.body)) this.micMore.focus({ preventScroll: true });
  }

  private showOverlay(): void {
    this.closeMicPicker();
    this.setHeard(null);
    this.overlay.hidden = false;
    this.setBehindInert(true);
    // 덮인 동안 입력창·메뉴는 접근성 트리에서도 뺀다. 입력창은 자리는 지켜서 보드가 움직이지 않게.
    this.askForm.classList.add('concealed');
    this.corner.hidden = true;
    this.modeSwitch.hidden = true;
    this.levelSwitch.hidden = true;
  }

  /**
   * 덮개 뒤(칠판과 그 위 질문 카드·질문창·스위치)를 Tab·화면 읽기에서 뺀다. 덮개는 #app 안에 있으므로 그 형제들만.
   * (QA 2026-11-23: 프로필 화면을 덮어도 Tab이 뒤의 예시 질문 카드로 넘어갔다.)
   */
  private setBehindInert(on: boolean): void {
    for (const c of this.host.children) if (c !== this.overlay && c instanceof HTMLElement) c.inert = on;
  }
}

/**
 * 라디오 묶음(role=radiogroup) 방향키: ←↑ 앞, →↓ 다음(끝에서는 처음으로), Home·End.
 * 옮겨 간 버튼을 누른 것처럼 고른다(ARIA 라디오 패턴: 방향키가 곧 고르기). 누를 때와 같은 click 처리를 탄다.
 */
function radioKeys(group: HTMLElement): void {
  group.addEventListener('keydown', (e) => {
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const i = radios.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    let j: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % radios.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + radios.length) % radios.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = radios.length - 1;
    else return;
    e.preventDefault();
    radios[j].focus();
    radios[j].click();
  });
}

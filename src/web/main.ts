// 앱 진입점: (가족 비밀번호) → 프로필 → 대기 → 질문 → 수업 → 끝/오류 (스펙 §7 1~5).
// 질문은 말로(마이크 → 말소리 게이트 → /api/listen → 판정) 하거나 글자 질문창으로 한다.
// `?demo=1`이면 서버 없이 고정 판서 데모(demo.ts)만 돌린다. `?fps=1`이면 FPS를 보여 준다(Board가 띄운다).
import { LANG } from './i18n';
import {
  FOLLOW_UP_WINDOW_MS,
  MAX_CONTEXT_SPOKEN,
  MAX_QUESTION_CHARS,
  MAX_SPOKEN_CHARS,
  LESSON_MODES,
  LEVELS,
  defaultLevel,
  levelSpeed,
  type LessonContext,
  type LessonMode,
  type Level,
} from '../shared/lesson';
import type { Profile } from '../shared/script';
import { Board } from './board/board';
import { Layout } from './board/layout';
import { createAudioOut } from './player/audioOut';
import { streamLesson, watchServerError } from './player/lessonClient';
import { LessonPlayer } from './player/player';
import { apiFetch, checkPin, onUnauthorized, sendPin } from './pinClient';
import { COPY, MIC_INSECURE_HINT, Screens, type MicStatus } from './ui';
import { QuestionCards, type CardKind } from './cards';
import { ListenClient } from './voice/listenClient';
import { listMics, MicError, openMic, type Mic } from './voice/mic';
import { SpeechGate } from './voice/speechGate';
import { VoiceController } from './voice/voiceController';
import { ClientReporter, installErrorReporting, LessonTimer, tapMethod, tapStreamError, uaSummary } from './telemetry';

const PROFILE_KEY = 'teacherboard.profile';
const MODE_KEY = 'teacherboard.mode';
/** 설명 수준은 프로필(아이·어른)마다 따로 기억한다. */
const levelKey = (p: Profile) => `teacherboard.level.${p}`;
const MIC_KEY = 'teacherboard.mic';
/** 이 기기에서 마이크가 한 번이라도 열렸다(허락을 받은 적이 있다). 없으면 첫 마이크는 "말로 물어볼래?"를 눌러 연다(A2). */
const MIC_OK_KEY = 'teacherboard.micOk';
/** 듣는 중 막대를 고치는 간격(1초에 15번쯤: 아이패드 판서 프레임을 빼앗지 않게). */
const CHIP_METER_MS = 66;
/** 듣기 서버로 보내는 에코 가드용 최근 선생님 말 개수. */
const STATE_SPOKEN = 3;
/** 장치가 끊겼을 때(onEnded) 저절로 다시 여는 건 이 간격에 한 번까지. 넘으면 사용자가 누를 때까지 '연결이 안 돼'. */
const AUTO_REOPEN_MS = 5000;

const isProfile = (v: unknown): v is Profile => v === 'kid' || v === 'adult';

function loadProfile(): Profile | null {
  try {
    const v = localStorage.getItem(PROFILE_KEY);
    return isProfile(v) ? v : null;
  } catch {
    return null; // 저장소를 못 쓰는 브라우저(사생활 보호 모드 등)
  }
}

function loadMode(): LessonMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return LESSON_MODES.includes(v as LessonMode) ? (v as LessonMode) : 'quick';
  } catch {
    return 'quick';
  }
}

function saveMode(m: LessonMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // 기억은 못 해도 이번에는 그 방식으로 설명한다
  }
}

function loadLevel(p: Profile): Level {
  try {
    const v = localStorage.getItem(levelKey(p));
    return LEVELS.includes(v as Level) ? (v as Level) : defaultLevel(p);
  } catch {
    return defaultLevel(p);
  }
}

function saveLevel(p: Profile, lv: Level): void {
  try {
    localStorage.setItem(levelKey(p), lv);
  } catch {
    // 기억은 못 해도 이번에는 그 수준으로 설명한다
  }
}

function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, p);
  } catch {
    // 기억은 못 해도 앱은 돌아간다
  }
}

function loadMicId(): string | null {
  try {
    return localStorage.getItem(MIC_KEY) || null;
  } catch {
    return null;
  }
}

function loadMicOk(): boolean {
  try {
    return localStorage.getItem(MIC_OK_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMicOk(): void {
  try {
    localStorage.setItem(MIC_OK_KEY, '1');
  } catch {
    // 기억은 못 해도 지금은 듣는다
  }
}

function saveMicId(id: string): void {
  try {
    localStorage.setItem(MIC_KEY, id);
  } catch {
    // 기억은 못 해도 지금 장치로 듣는다
  }
}

const listenUrl = (p: Profile): string =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/listen?profile=${p}${LANG === 'ko' ? '' : `&lang=${LANG}`}`;

/** 마이크 RMS(말소리 ≈ 0.02~0.2)를 막대 길이 0..1로. 작은 소리도 보이게 제곱근으로 늘린다. */
const meterLevel = (rms: number): number => Math.min(1, Math.sqrt(Math.max(0, rms)) * 2.2);

function startApp(host: HTMLElement): void {
  // 운영 계측(telemetry.ts): 기기 오류와 수업 체감 시간을 서버 로그로. 화면은 바꾸지 않는다.
  const reporter = new ClientReporter({
    ua: uaSummary(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    state: () => (ui.pinOpen ? 'pin' : lesson ? 'lesson' : profile ? 'idle' : 'picker'),
  });
  installErrorReporting(window, document, reporter);
  const board = new Board(host);
  const audio = createAudioOut();
  // 칠판에 붙는 질문 카드(A1 예시·E2 이어 묻기). 누르면(터치 안) 소리를 깨우고 그 질문으로 바로 수업한다.
  const cards = new QuestionCards(board, (q, kind) => {
    void audio.unlock();
    ask(q, undefined, kind);
  });
  let profile: Profile | null = loadProfile();
  /** 설명 방식(빠른 선생님 / 신중한 선생님). 기기마다 기억한다. */
  let mode: LessonMode = loadMode();
  /** 고른 설명 수준(프로필마다). 저장소를 못 써도(사생활 보호·용량 초과) 이번 세션에는 고른 수준으로 묻는다. */
  const levels: Partial<Record<Profile, Level>> = {};
  const levelOf = (p: Profile): Level => levels[p] ?? loadLevel(p);
  let lesson: { player: LessonPlayer; ctl: AbortController } | null = null;
  /** 지금 수업의 질문과 그 수업에서 선생님이 한 말(최근 MAX_CONTEXT_SPOKEN개) — 끼어들기 문맥·에코 가드용. */
  let lessonQuestion: string | null = null;
  let recentSay: string[] = [];
  /** 지난 수업이 끝난 시각. FOLLOW_UP_WINDOW_MS 안에 온 질문은 그 수업에 이어 묻는 것으로 보고 문맥을 보낸다. */
  let lessonEndedAt = -Infinity;

  // 음성 입력: 마이크 → 게이트 → VoiceController → ListenClient. 프로필마다 듣기 연결 하나.
  const gate = new SpeechGate();
  let mic: Mic | null = null;
  /** 마이크 열기 요청 번호. 늦게 열린 예전 요청(장치를 또 바꿈·끔)은 바로 닫는다. */
  let micGen = 0;
  let micState: 'closed' | 'opening' | 'open' | 'denied' | 'insecure' | 'failed' = 'closed';
  /** 마지막으로 저절로 다시 연 시각(onEnded). */
  let lastAutoReopen = -Infinity;
  /** 사용자가 알약으로 끈 상태. 프로필을 바꿔도 유지한다. */
  let muted = false;
  let voice: { profile: Profile; client: ListenClient; ctl: VoiceController } | null = null;
  /** 듣기 연결이 끊긴 뒤 아직 ready가 안 됐다(다시 연결하는 동안에도 '연결이 안 돼'를 유지한다). */
  let linkDown = false;
  let meterOn = false;
  /** 브라우저가 아는 마이크 권한(Permissions API). 모르면 null. 프로필을 누르기 전에 미리 물어 둔다(누른 순간엔 기다릴 수 없다). */
  let micPerm: PermissionState | null = null;
  void navigator.permissions
    ?.query({ name: 'microphone' as PermissionName })
    .then((st) => {
      micPerm = st.state;
      st.onchange = () => (micPerm = st.state);
    })
    .catch(() => {}); // 'microphone'을 모르는 브라우저
  /** 허락 창 없이(또는 익숙한 흐름으로) 바로 열어도 되나: 이 기기에서 열린 적이 있거나 이미 허락됨.
   *  https가 아니라 마이크 기능이 아예 없으면 바로 열어 '허락 필요'(https 안내)를 보인다. */
  const micReady = () => loadMicOk() || micPerm === 'granted' || !navigator.mediaDevices?.getUserMedia;
  const showMic = (st: MicStatus, hint?: string) => {
    ui.setMicPending(false);
    ui.setMicStatus(st, hint);
  };

  /** 수업 중에는 게이트를 깐깐하게(선생님 목소리가 새어 들어와도 쉽게 열리지 않게). */
  const setLesson = (l: typeof lesson) => {
    lesson = l;
    gate.setStrict(l !== null);
  };

  const stopLesson = () => {
    if (!lesson) return;
    lesson.ctl.abort(); // 서버 요청·채움 음성
    lesson.player.abort(); // 음성·판서
    setLesson(null);
  };

  const rememberSay = (text: string) => {
    recentSay.push(text);
    if (recentSay.length > MAX_CONTEXT_SPOKEN) recentSay.shift();
  };

  // --- 마이크 상태 알약 ---
  const refreshMic = () => {
    let s: MicStatus;
    if (muted) s = 'off';
    else if (micState === 'insecure') return showMic('denied', MIC_INSECURE_HINT); // 허락으로는 못 푼다: https가 필요
    else if (micState === 'denied') s = 'denied';
    else if (micState === 'failed') s = 'error';
    else if (micState === 'open') s = linkDown ? 'error' : 'listening';
    else if (micState === 'opening') return ui.setMicPending(true); // 문구는 두고 흐리게: 결과가 나오면 바뀐다
    else return; // 닫힘(프로필 화면·말로 물어볼래?): 지금 표시를 둔다
    showMic(s);
    if (s === 'listening') runMeter();
  };

  const refreshDevices = () => {
    listMics().then(
      (list) => ui.setMicDevices(list, mic?.deviceId ?? loadMicId()),
      () => ui.setMicDevices([], null),
    );
  };

  /**
   * 소리 크기 표시: 마이크 고르기 창의 막대(열려 있는 동안 매 프레임)와 칩의 듣는 중 막대(듣는 동안 CHIP_METER_MS마다).
   * 둘 다 쉬면 멈춘다. 숨은 탭에서는 requestAnimationFrame이 서므로 따로 멈추지 않아도 된다.
   */
  const runMeter = () => {
    if (meterOn) return;
    meterOn = true;
    let chipAt = 0;
    const draw = (t: number) => {
      const picker = ui.micPickerOpen;
      const chip = ui.micStatus === 'listening';
      if (!picker && !chip) {
        meterOn = false;
        return;
      }
      const lv = meterLevel(mic?.level() ?? 0);
      if (picker) ui.setMicLevel(lv);
      if (chip && t - chipAt >= CHIP_METER_MS) {
        chipAt = t;
        ui.setMicActivity(lv);
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  };

  /** 말하던 중이면 서버 쪽 말을 마무리하고 덕킹·말풍선을 푼다(마이크를 닫거나 바꿀 때). */
  const flushVoice = () => {
    if (!voice) return;
    voice.ctl.setMuted(true);
    voice.ctl.setMuted(muted);
  };

  const closeMic = () => {
    micGen++;
    flushVoice();
    mic?.close(); // 트랙을 모두 멈춘다
    mic = null;
    micState = 'closed';
    gate.reset();
  };

  /**
   * 마이크를 연다. 터치 핸들러 안에서 다른 await 없이 불러야 한다(openMic를 동기적으로 부른다).
   * 저장된 장치가 없어졌으면 기본 장치로 한 번 더 연다. 열리면 듣기 연결을 시작한다.
   */
  const openMicNow = (deviceId: string | null = loadMicId()) => {
    closeMic();
    const gen = ++micGen;
    micState = 'opening';
    if (!muted) refreshMic(); // 여는 중 모양(흐리게). '허락이 필요해'는 실제로 거절됐을 때만
    const first = openMic(deviceId ?? undefined);
    let fellBack = false;
    const opened = deviceId
      ? first.catch((e: unknown) => {
          if (e instanceof MicError && e.kind === 'nodevice' && gen === micGen) {
            fellBack = true;
            return openMic();
          }
          throw e;
        })
      : first;
    opened.then(
      (m) => {
        if (gen !== micGen) {
          m.close(); // 그 사이 끄거나 다른 장치를 골랐다
          return;
        }
        mic = m;
        micState = 'open';
        saveMicOk(); // 다음부터는 프로필을 누르면 바로 연다
        if (fellBack && m.deviceId) saveMicId(m.deviceId); // 저장된 장치가 없어졌다: 지금 쓰는 장치로 바꿔 둔다
        gate.reset(); // 새 장치의 잡음 바닥부터 다시 잰다
        gate.setStrict(lesson !== null);
        m.onFrame((f) => {
          if (mic !== m || !voice) return;
          for (const ev of gate.push(f)) voice.ctl.handle(ev);
        });
        m.onEnded(() => {
          if (mic === m) reopenLostMic();
        });
        // 전화·다른 앱·화면 꺼짐으로 컨텍스트가 멈췄다: 보이는 화면이면 바로 깨워 본다(숨은 동안은 돌아올 때 visibilitychange에서).
        m.onSuspended(() => {
          if (mic === m && document.visibilityState === 'visible') recoverMic();
        });
        if (document.visibilityState !== 'hidden') voice?.client.connect(); // 이미 연결 중이면 아무것도 안 한다. 1008로 멈췄으면 다시 시도한다. 숨은 탭이면 돌아올 때 연결한다
        refreshMic();
        if (ui.micPickerOpen) refreshDevices(); // 허락을 받으면 장치 이름이 보인다
      },
      (e: unknown) => {
        if (gen !== micGen) return;
        const kind = e instanceof MicError ? e.kind : 'other';
        micState = kind === 'other' ? 'failed' : kind === 'insecure' ? 'insecure' : 'denied';
        if (kind === 'other') reporter.error('app', e, 'mic'); // 거절·https 아님은 오류가 아니라 상태
        voice?.client.close(); // 보낼 소리가 없다. 다시 열리면 다시 연결한다
        refreshMic();
        if (ui.micPickerOpen) refreshDevices();
      },
    );
  };

  /**
   * 마이크를 잃었다(장치가 뽑힘·깨울 수 없음): 먼저 '연결이 안 돼'를 보이고, 저장된 장치 → 기본 장치 순으로 다시 연다.
   * 되풀이해 끊기면(접촉 불량 등) AUTO_REOPEN_MS에 한 번까지만 저절로 열고, 그다음엔 사용자가 누를 때까지 둔다.
   */
  function reopenLostMic(): void {
    closeMic();
    micState = 'failed';
    showMic('error');
    const now = Date.now();
    if (now - lastAutoReopen < AUTO_REOPEN_MS) return;
    lastAutoReopen = now;
    openMicNow();
  }

  /** 열린 마이크의 컨텍스트가 멈췄으면 깨워 보고, 1초 안에 안 깨어나면 다시 연다. */
  function recoverMic(): void {
    const m = mic;
    if (!m || micState !== 'open') return;
    void m.resume().then((ok) => {
      if (!ok && mic === m) reopenLostMic();
    });
  }

  /**
   * 프로필로 들어올 때(터치 안): 그 프로필의 듣기 연결을 만들고, 꺼 두지 않았으면 마이크를 연다.
   * userAsked: 사용자가 마이크 칩·장치를 직접 눌렀다(처음 쓰는 기기여도 바로 연다 → 허락 창).
   */
  const startVoice = (p: Profile, userAsked = false) => {
    if (!voice || voice.profile !== p) {
      stopVoice();
      const client = new ListenClient({ url: listenUrl(p) });
      linkDown = false; // 새 연결: 예전 연결의 끊김은 잊는다
      const ctl = new VoiceController({
        client,
        audio,
        isReady: () => client.status === 'ready',
        lessonActive: () => lesson !== null,
        recentSpoken: () => recentSay.slice(-STATE_SPOKEN),
        onQuestion: (q, heard) => ask(q, heard),
        onHeard: (t) => ui.setHeard(t),
        misheard: COPY.misheard, // E7: 연달아 못 알아들으면 말풍선에 한 번
      });
      client.onStatus = (st) => {
        if (st === 'ready' || st === 'closed') linkDown = false;
        else if (st === 'error') {
          linkDown = true;
          reporter.error('app', 'listen link error', 'listen');
          recheckPin(); // 브라우저는 거절된 업그레이드의 401을 못 본다: 끊길 때 들어와 있는지 따로 묻는다
        }
        if (st !== 'ready') ctl.linkReset(); // 끊긴 연결로 보낸 말의 판정은 오지 않는다
        refreshMic();
      };
      client.onPartial = (t) => ctl.partial(t);
      client.onUtterance = (u) => ctl.utterance(u);
      ctl.setMuted(muted);
      voice = { profile: p, client, ctl };
    }
    if (muted) {
      refreshMic();
      return;
    }
    // 처음 쓰는 기기: 바로 허락 창을 띄우지 않고 "말로 물어볼래?"를 보인다(경고처럼 보이는 '허락 필요' 대신).
    // 누르면(onToggleMic) 그 터치 안에서 연다 → 허락 창.
    if (!userAsked && !micReady()) {
      closeMic();
      showMic('ask');
      return;
    }
    openMicNow();
  };

  const stopVoice = () => {
    closeMic();
    voice?.client.close();
    voice = null;
    ui.setHeard(null);
  };

  const setMuted = (m: boolean) => {
    muted = m;
    voice?.ctl.setMuted(m);
  };

  const begin = () => {
    if (!profile) return;
    startVoice(profile); // 터치 안에서 마이크를 연다
    ui.hideOverlay();
    ui.setProfile(profile);
    ui.setMode(mode);
    ui.setLevel(levelOf(profile));
    board.clear();
    board.setSubtitle('');
    showIdle(profile);
  };

  /** 빈 칠판: 가운데에 "궁금한 거 물어봐!" 한 줄만(2026-11-23 사용자 결정: 예시 질문 카드는 빼기). */
  const showIdle = (_p: Profile) => {
    cards.hide();
    board.writeIdle(COPY.idle);
  };

  /**
   * heard: 말로 물었으면 받아 적은 그대로의 말(수업 대본이 오인식을 바로잡는 데 쓴다).
   * card: 칠판 카드를 눌렀다. 'next'(수업 끝 이어 묻기, E2)는 시간이 지났어도 앞 수업에 이어 묻는 것으로 문맥을 보낸다.
   */
  const ask = (question: string, heard?: string, card?: CardKind) => {
    if (!profile) return;
    cards.hide();
    // 수업 중에 끼어들면 앞 수업의 질문과 지금까지 한 말을 함께 보낸다. 수업이 끝난 지 얼마 안 됐으면
    // 이어 묻는 것일 수 있으니 interrupted: false로 보낸다. 둘 다 아니면 보내지 않는다.
    const followUp = !lesson && (card === 'next' || Date.now() - lessonEndedAt <= FOLLOW_UP_WINDOW_MS);
    const context: LessonContext | undefined =
      lessonQuestion && (lesson || followUp)
        ? {
            previousQuestion: lessonQuestion.slice(0, MAX_QUESTION_CHARS),
            spoken: recentSay.slice(-MAX_CONTEXT_SPOKEN).map((t) => t.slice(0, MAX_SPOKEN_CHARS)),
            ...(lesson ? {} : { interrupted: false }),
          }
        : undefined;
    stopLesson();
    board.clear();
    board.setSubtitle('');
    lessonQuestion = question;
    recentSay = [];
    const ctl = new AbortController();
    // 체감 시간: 물어본 때 → 첫 소리 재생 시작(audio.play) → 첫 획(board.draw) → 끝.
    const timer = new LessonTimer(question, mode, heard !== undefined);
    // 쉽게(초등)는 말·판서를 0.9배로(levelSpeed). 보드의 손 빠르기도 같이 맞춘다.
    const speed = levelSpeed(levelOf(profile));
    board.setPace(1 / speed);
    const player = new LessonPlayer({
      speed,
      board: tapMethod(board, 'draw', timer.stroke),
      layout: new Layout(),
      audio: tapMethod(audio, 'play', timer.sound),
      onSay: (text) => {
        if (lesson === me) rememberSay(text);
      },
    });
    const me = { player, ctl };
    setLesson(me);

    // 채움 음성("음~ 좋은 질문이야!")은 두지 않는다: 1~2초 조용한 편이 더 자연스럽다(2026-11-22 사용자 요청).
    let serverError: string | null = null; // 서버가 보낸 안내문(거절 등). 네트워크 오류면 null
    // E1: 질문을 칠판에 먼저 손글씨로 쓰고, 그 아래 문구가 바뀌며 마커가 끄적인다. 첫 문장이 나오면 플레이어가 걷는다
    board.setThinking(COPY.thinking[mode], question);
    let streamError: unknown = null; // 네트워크·멈춤·HTTP 실패(오류 보고용)
    const stream = watchServerError(
      // timer.lessonId: 서버가 x-lesson-id로 알려 준 수업 id를 체감 시간 보고에 싣는다(같은 질문을 다시 물어도 뒤바뀌지 않게).
      tapStreamError(streamLesson(question, profile, ctl.signal, context, heard?.slice(0, MAX_QUESTION_CHARS), mode, levelOf(profile), timer.lessonId), (e) => (streamError = e)),
      (m) => (serverError = m),
    );

    void player.play(stream).then((r) => {
      const timing = timer.finish(r);
      if (timing) reporter.lesson(timing);
      // 사용자에게 오류 문구를 보여 준 수업은 그 이유를 보고한다(서버 안내문은 정해진 문구라 그대로 실어도 된다).
      if (r === 'error') reporter.error('app', serverError ? `server: ${serverError}` : (streamError ?? 'lesson playback failed'), 'lesson');
      if (lesson !== me) return; // 새 질문이나 프로필 변경으로 이미 끝난 수업
      setLesson(null);
      lessonEndedAt = Date.now();
      if (r === 'done') {
        board.setSubtitle(COPY.done); // 보드는 그대로 둔다
        cards.showNext(player.nextQuestions()); // E2: 이어 물을 질문 카드(서버가 안 보냈으면 없음)
      } else if (r === 'error') {
        ctl.abort();
        board.setSubtitle(serverError ?? COPY.error);
        if (recentSay.length === 0 && profile) showIdle(profile); // 한 문장도 못 했으면 빈 칠판 문구로 되돌린다
      }
    });
  };

  /** PIN을 맞힌 뒤(또는 필요 없을 때): 저장된 프로필이면 시작 화면, 아니면 프로필 고르기. */
  const showEntry = () => {
    if (profile) ui.showStart(profile);
    else ui.showPicker();
  };

  /** 서버가 "들어와 있지 않다"(401)고 했다: 하던 것을 모두 멈추고 PIN 화면으로. */
  const goToPin = () => {
    if (ui.pinOpen) return;
    leaveBoard();
    ui.showPin();
  };

  /**
   * 칠판을 덮는 화면(PIN·프로필 고르기)으로 갈 때: 수업·듣기를 멈추고, 앞 수업에 이어 묻지 않게 잊고, 칠판을 비운다.
   * 칠판을 비워야 생각 중(질문 글씨·낙서·문구 타이머)도 멈춘다 — 수업만 멈추면 덮인 화면 뒤에서 낙서가 끝없이 그려진다.
   * 돌아오면 begin()이 빈 칠판과 예시 카드를 다시 그린다.
   */
  function leaveBoard(): void {
    stopLesson();
    lessonQuestion = null;
    recentSay = [];
    lessonEndedAt = -Infinity;
    stopVoice();
    cards.hide();
    board.clear();
    board.setSubtitle('');
  }
  onUnauthorized(goToPin);

  /** 듣기 연결이 끊겼을 때: 쿠키가 무효가 됐는지 묻는다(한 번에 하나만). */
  let pinChecking = false;
  const recheckPin = () => {
    if (pinChecking || ui.pinOpen) return;
    pinChecking = true;
    void checkPin().then((st) => {
      pinChecking = false;
      if (st === 'need') goToPin();
    });
  };

  const ui = new Screens(host, {
    onPinSubmit: async (pin) => {
      const r = await sendPin(pin);
      if (r.kind === 'ok') showEntry();
      return r;
    },
    onPick: (p) => {
      void audio.unlock(); // 터치 안에서 먼저
      profile = p;
      saveProfile(p);
      begin();
    },
    onStart: () => {
      void audio.unlock();
      begin();
    },
    onAsk: (q) => {
      // 글자로 묻는 건 터치(클릭·Enter) 안이다: 전화·잠금 화면 뒤 멈춘 Web Audio를 여기서 다시 깨운다
      // (터치 밖 resume은 iOS가 막아 문장마다 크기 맞춤 없는 <audio>로만 나간다). 어차피 앞 수업 소리는 멈춘다.
      void audio.unlock();
      ask(q);
    },
    onLevelChange: (lv) => {
      if (!profile) return;
      levels[profile] = lv;
      saveLevel(profile, lv);
    },
    onModeChange: (m) => {
      mode = m;
      saveMode(m);
    },
    onChangeProfile: () => {
      // 다른 사람이다: 앞 수업에 이어 묻는 것으로 보지 않는다. 덮인 동안에는 듣지 않는다(프로필을 고르면 그 프로필로 다시 연결).
      leaveBoard();
      ui.showPicker();
    },
    onToggleMic: () => {
      if (!profile) return;
      if (!muted && micState === 'open' && linkDown && voice) {
        // 마이크는 되는데 듣기 연결이 끊김: 끄는 대신 지금 바로 다시 연결한다(기다리던 재시도 간격도 처음부터)
        voice.client.close();
        voice.client.connect();
        return;
      }
      if (!muted && (micState === 'open' || micState === 'opening')) {
        setMuted(true);
        closeMic();
        voice?.client.close(); // 끈 동안에는 서버 연결도 닫는다(요금·개인정보)
        refreshMic();
        return;
      }
      // 말로 물어볼래?·꺼짐·허락 필요·실패 → 켜 본다(이 터치 안에서 연다: 처음이면 허락 창이 뜬다)
      setMuted(false);
      if (!voice) startVoice(profile, true);
      else openMicNow();
    },
    onPickMic: (deviceId) => {
      saveMicId(deviceId);
      setMuted(false); // 장치를 골랐으면 그 장치로 듣고 싶은 것
      if (mic && mic.deviceId === deviceId) return refreshMic();
      if (!voice && profile) startVoice(profile, true);
      else openMicNow(deviceId); // 예전 마이크를 닫고 새로 연다
    },
    onOpenMicPicker: () => {
      refreshDevices();
      runMeter();
    },
  });

  // 탭이 숨으면 듣지 않는다: 데스크톱은 숨은 탭에서도 마이크가 돌아 TV 소리 등이 판정·수업 생성(유료)까지 갈 수 있다.
  // 마이크 장치는 열어 둔 채(다시 허락을 묻지 않게) 말 처리를 멈추고 듣기 연결을 닫는다. 돌아오면 사용자가 정한 상태로 되돌리고,
  // 멈춘 마이크를 깨운다(안 되면 다시 연다).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (!voice) return;
      voice.ctl.setMuted(true);
      voice.client.close();
      return;
    }
    if (voice) {
      voice.ctl.setMuted(muted);
      if (!muted && micState === 'open') voice.client.connect();
      refreshMic();
    }
    recoverMic();
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (ui.micPickerOpen) refreshDevices();
  });

  void checkPin().then((st) => (st === 'need' ? ui.showPin() : showEntry()));
}

const host = document.getElementById('app')!;
if (new URLSearchParams(location.search).get('demo') === '1') {
  void import('./demo').then((m) => m.runDemo(host));
} else {
  startApp(host);
}

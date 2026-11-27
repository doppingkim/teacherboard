// 음성 제어: 말소리 게이트(GateEvent)를 듣기 클라이언트로 흘리고, 누가 말을 시작하면 선생님 목소리를
// 줄였다가(덕킹) 판정이 오면 되돌린다. 받아들인 말은 질문으로 넘긴다(끼어들기). DOM에 기대지 않는다.
//
// 규칙
// - start: 듣기 연결이 ready가 아니면 무시한다(보낼 곳이 없으니 덕킹도 안 함 — 판정이 올 리 없다).
//   ready면 수업 상태를 서버에 보내고 pre-roll을 보낸다. 덕킹·말풍선은 아직 안 한다.
// - 말 확인(confirm): 큰 소리가 confirm.voicedMs(기본 350ms) 넘게 이어졌고 partial에 글자가 confirm.minLetters(기본 2)자 넘게
//   나왔을 때만 "진짜 말"로 보고 그때 덕킹하고 말풍선을 연다. 문 닫는 소리·달그락 같은 잡음으로는 선생님 목소리가 줄지 않는다.
//   확인되지 않은 말도 서버로는 보내고 판정도 받는다(짧은 "왜?"는 partial 없이 판정만 올 수 있다).
// - audio: 말하는 중일 때만 보낸다(start 없이 온 audio — 예: 음소거를 푼 순간 게이트가 말 중간 — 는 버린다).
// - end: 수업 상태를 다시 보내고(판정 때 recentSpoken이 최신이게) 서버에 end, 기다리는 판정 수 +1. 마지막 end에서 unduckAfterMs 안에 판정이 다 안 오면
//   셈을 0으로 하고 덕킹을 풀고 말풍선을 닫는다.
// - utterance: 기다리는 판정 수 −1(0 아래로는 안 감). 받아들인 말이면 onQuestion. 말하는 중이 아니고
//   기다리는 판정이 더 없을 때만 덕킹을 풀고 말풍선을 닫는다(지금·곧 판정될 말을 덮지 않게).
//   받아들인 말은 고쳐 알아들은 질문을 말풍선에 HEARD_LINGER_MS 동안 보여 준다(무엇을 들었는지 알게).
// - 음소거: 게이트 이벤트·판정을 무시하고, 덕킹을 푼다. 말하는 중이었으면 서버 쪽 말을 end로 마무리한다.
//   음소거·장치 바꾸기(flush = 음소거 후 바로 풀기)로 끝낸 말의 판정은 나중에 와도 무시한다: 세대(generation)를 올리고,
//   서버는 판정을 들은 순서대로 보내므로 보낸 end마다 그때 세대를 줄에 세워 두었다가 판정이 오면 맨 앞과 맞춘다.
//   듣기 연결이 끊기면(linkReset) 그 연결의 판정은 오지 않으니 줄을 비운다. STALE_MS 넘게 안 온 줄은 버린다.
// - 최대 덕킹 감시: MAX_DUCK_MS 동안 계속 덕킹이면 강제로 풀고, 말하는 중이면 end로 끝내고, 셈을 비운다.
// - 못 알아들음 안내(E7, deps.misheard가 있을 때만): 서버가 miss로 표시한 판정(받아 적었지만 질문이 아님)이
//   수업이 없을 때, 큰 소리가 confirm.voicedMs 넘게 이어진 말에서, 글자 1~MISS_MAX_LETTERS자로, MISS_WINDOW_MS 안에
//   MISS_COUNT번 오면 말풍선에 안내를 MISHEARD_LINGER_MS 동안 한 번 보인다. 시끄러운 TV가 계속 말해도 되풀이되지 않게
//   한 번 보인 뒤에는 질문을 받아들이기 전까지(또는 MISHEARD_COOLDOWN_MS 동안) 다시 보이지 않는다.
import type { AudioOut } from '../player/audioOut';
import type { ListenClient, ListenUtterance } from './listenClient';
import type { GateEvent } from './speechGate';

const DEFAULT_UNDUCK_AFTER_MS = 4000;
/** 기본 말 확인 기준(위 규칙). 2026-11-22 실사용 피드백: 주위 소음마다 말풍선이 뜨고 선생님 목소리가 줄었다. */
export const DEFAULT_CONFIRM = { voicedMs: 350, minLetters: 2 } as const;
/** 받아들인 질문을 말풍선에 남겨 두는 시간. */
export const HEARD_LINGER_MS = 2000;
/** 이만큼 계속 덕킹이면(게이트가 안 닫히는 잡음 등) 강제로 푼다. */
export const MAX_DUCK_MS = 20_000;
/** 이만큼 지나도 판정이 안 온 end는 잊는다(업스트림이 확정을 버린 경우 등). */
const STALE_MS = 15_000;
/** 못 알아들음 안내(E7): 이만큼 안에 이만큼 못 알아들으면. */
export const MISS_WINDOW_MS = 15_000;
export const MISS_COUNT = 2;
/** 이보다 긴 말(글자 수)은 아이가 묻다 만 말보다 TV·대화일 가능성이 커서 세지 않는다. */
export const MISS_MAX_LETTERS = 30;
/** 안내를 말풍선에 두는 시간, 한 번 보인 뒤 (질문을 받아들이지 않는 한) 다시 보이지 않는 시간. */
export const MISHEARD_LINGER_MS = 3500;
export const MISHEARD_COOLDOWN_MS = 5 * 60_000;

export type VoiceControllerDeps = {
  client: Pick<ListenClient, 'sendPcm' | 'end' | 'setState'>;
  audio: Pick<AudioOut, 'duck'>;
  /** 듣기 연결이 ready인가(ListenClient.status === 'ready'). */
  isReady(): boolean;
  lessonActive(): boolean;
  recentSpoken(): string[];
  /** question: 판정이 고쳐 적은 질문, heard: 받아 적은 그대로의 말(수업 대본이 오인식을 바로잡는 데 쓴다). */
  onQuestion(question: string, heard: string): void;
  /** 들은 말 말풍선: ''면 듣기 시작, 글이면 지금까지 들은 말, null이면 닫기. */
  onHeard(text: string | null): void;
  /** 연달아 못 알아들었을 때 말풍선에 보일 안내(E7). 없으면 안내하지 않는다. */
  misheard?: string;
  unduckAfterMs?: number;
  /** 말 확인 기준. { voicedMs: 0, minLetters: 0 }이면 start에서 바로 확인한다. */
  confirm?: { voicedMs: number; minLetters: number };
};

/** 글자(한글·영문 등) 수. 문장부호·공백·숫자는 뺀다. */
const letterCount = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;

export class VoiceController {
  private muted = false;
  private speaking = false;
  /** end를 보냈지만 아직 판정(utterance)이 안 온 말의 수. */
  private pending = 0;
  private unduckTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDuckTimer: ReturnType<typeof setTimeout> | null = null;
  /** 음소거·flush 때마다 오른다. 예전 세대의 판정은 무시한다. */
  private generation = 0;
  /** 보낸 end(판정이 올 차례대로)와 그때의 세대·시각. */
  /** voiced: 큰 소리가 confirm.voicedMs 넘게 이어진 말이었나(못 알아들음 안내는 이런 말만 센다). */
  private awaiting: Array<{ gen: number; at: number; voiced: boolean }> = [];
  /** 못 알아들은 말의 시각(MISS_WINDOW_MS 안의 것만), 마지막으로 안내를 보인 시각. */
  private misses: number[] = [];
  private lastMisheard = -Infinity;
  private readonly unduckAfterMs: number;
  private readonly confirmCfg: { voicedMs: number; minLetters: number };
  /** 지금 말이 진짜 말로 확인됐나. */
  private confirmed = false;
  /** 지금 말에서 큰 소리가 이어진 시간(ms). */
  private voicedMs = 0;
  /** 지금 말의 partial에 글자가 충분히 나왔나. */
  private words = false;
  private lastPartial = '';
  /** 덕킹 중(= 말풍선이 열려 있음). */
  private ducked = false;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: VoiceControllerDeps) {
    this.unduckAfterMs = deps.unduckAfterMs ?? DEFAULT_UNDUCK_AFTER_MS;
    this.confirmCfg = deps.confirm ?? DEFAULT_CONFIRM;
  }

  handle(ev: GateEvent): void {
    if (this.muted) return;
    const { client } = this.deps;
    switch (ev.type) {
      case 'start':
        if (!this.deps.isReady()) return;
        this.clearUnduck();
        this.speaking = true;
        this.confirmed = false;
        this.voicedMs = ev.voicedMs ?? 0;
        this.words = false;
        this.lastPartial = '';
        client.setState(this.deps.lessonActive(), this.deps.recentSpoken());
        this.maybeConfirm();
        for (const f of ev.preRoll) client.sendPcm(f);
        return;
      case 'audio':
        if (!this.speaking) return;
        client.sendPcm(ev.pcm);
        if (ev.voiced) {
          this.voicedMs += ev.pcm.length / 16; // 16kHz: 16샘플 = 1ms
          this.maybeConfirm();
        }
        return;
      case 'end':
        if (!this.speaking) return;
        this.speaking = false;
        this.pending++;
        client.setState(this.deps.lessonActive(), this.deps.recentSpoken());
        this.endUtterance();
        this.clearUnduck();
        this.unduckTimer = setTimeout(() => {
          this.unduckTimer = null;
          this.pending = 0;
          this.release();
        }, this.unduckAfterMs);
        return;
    }
  }

  /**
   * 확인 전이면 말 확인에 쓴다. 확인된 뒤에는 말하는 중이거나 판정을 기다리는 동안만 보여 준다
   * (늦게 온 partial이 닫힌 말풍선을 다시 열지 않게).
   */
  partial(text: string): void {
    if (this.muted) return;
    if (this.speaking && !this.confirmed) {
      this.lastPartial = text;
      if (letterCount(text) >= this.confirmCfg.minLetters) this.words = true;
      this.maybeConfirm();
      return;
    }
    if (!this.ducked || (!this.speaking && this.pending === 0)) return;
    this.deps.onHeard(text);
  }

  utterance(u: ListenUtterance): void {
    // 음소거 중에도 줄은 맞춰 둔다(판정은 보낸 end 순서대로 온다).
    const now = Date.now();
    while (this.awaiting.length > 0 && now - this.awaiting[0].at > STALE_MS) this.awaiting.shift();
    const head = this.awaiting.shift();
    if (this.muted) return;
    // 음소거·장치 바꾸기로 끝낸 말의 판정: 질문도, 지금 말의 대기 셈도 건드리지 않는다.
    if (head && head.gen !== this.generation) return;
    if (this.pending > 0) this.pending--;
    if (!this.speaking && this.pending === 0) {
      this.clearUnduck();
      this.release();
    }
    const q = u.question.trim();
    if (!u.accept || !q) {
      if (u.miss && head?.voiced) this.noteMiss(u.text, now);
      return;
    }
    // 말로 묻기가 통했다: 못 알아들은 셈과 안내 쉬는 시간을 처음부터
    this.misses = [];
    this.lastMisheard = -Infinity;
    if (!this.speaking && this.pending === 0) {
      // 무엇을 알아들었는지(고쳐 적은 질문) 잠깐 보여 준다.
      this.deps.onHeard(q);
      this.clearLinger();
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        if (!this.ducked) this.deps.onHeard(null);
      }, HEARD_LINGER_MS);
    }
    this.deps.onQuestion(q, u.text);
  }

  setMuted(m: boolean): void {
    if (m === this.muted) return;
    this.muted = m;
    if (!m) return;
    if (this.speaking) {
      this.speaking = false;
      this.endUtterance();
    }
    this.generation++; // 지금까지 보낸 말의 판정은 이제 무시한다
    this.pending = 0;
    this.clearUnduck();
    this.release();
    if (this.lingerTimer !== null) {
      this.clearLinger();
      this.deps.onHeard(null);
    }
  }

  /** 듣기 연결이 끊겼다(그 연결로 보낸 말의 판정은 오지 않는다). 기다리던 줄을 비운다. */
  linkReset(): void {
    this.awaiting = [];
  }

  /** 서버 쪽 말을 끝낸다. 연결이 ready일 때만 판정이 오므로 그때만 줄에 세운다. */
  private endUtterance(): void {
    if (this.deps.isReady()) this.awaiting.push({ gen: this.generation, at: Date.now(), voiced: this.voicedMs >= this.confirmCfg.voicedMs });
    this.deps.client.end();
  }

  /**
   * 못 알아들은 말 하나(E7). 수업 중이 아니고 짧은 말이면 세고, MISS_WINDOW_MS 안에 MISS_COUNT번이면 안내를 한 번 보인다.
   * 말하는 중이거나 다음 판정을 기다리는 중이면(벌써 다시 말하고 있다) 보이지 않는다.
   */
  private noteMiss(text: string, now: number): void {
    const msg = this.deps.misheard;
    // 글자가 하나도 없는 말(받아쓰기가 빈 큰 잡음)은 세지 않는다: 잡음으로는 안내가 뜨지 않게.
    const letters = letterCount(text);
    if (!msg || this.deps.lessonActive() || letters === 0 || letters > MISS_MAX_LETTERS) return;
    this.misses = this.misses.filter((t) => now - t <= MISS_WINDOW_MS);
    this.misses.push(now);
    if (this.misses.length < MISS_COUNT || now - this.lastMisheard < MISHEARD_COOLDOWN_MS) return;
    if (this.speaking || this.pending > 0) return;
    this.misses = [];
    this.lastMisheard = now;
    this.deps.onHeard(msg);
    this.clearLinger();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (!this.ducked) this.deps.onHeard(null);
    }, MISHEARD_LINGER_MS);
  }

  /** 진짜 말로 확인되면 덕킹하고 말풍선을 연다. */
  private maybeConfirm(): void {
    if (!this.speaking || this.confirmed) return;
    if (this.voicedMs < this.confirmCfg.voicedMs) return;
    if (this.confirmCfg.minLetters > 0 && !this.words) return;
    this.confirmed = true;
    this.clearLinger();
    this.duck();
    this.deps.onHeard(this.lastPartial);
  }

  private duck(): void {
    this.ducked = true;
    this.deps.audio.duck(true);
    if (this.maxDuckTimer !== null) return; // 이어진 덕킹은 처음부터 잰다
    this.maxDuckTimer = setTimeout(() => {
      this.maxDuckTimer = null;
      if (this.speaking) {
        this.speaking = false;
        this.endUtterance();
      }
      this.pending = 0;
      this.clearUnduck();
      this.release();
    }, MAX_DUCK_MS);
  }

  /** 덕킹을 풀고 말풍선을 닫는다(duck은 같은 값을 다시 불러도 괜찮다). */
  private release(): void {
    if (this.maxDuckTimer !== null) clearTimeout(this.maxDuckTimer);
    this.maxDuckTimer = null;
    if (!this.ducked) return; // 확인된 말이 없었다: 줄인 적도, 연 말풍선도 없다
    this.ducked = false;
    this.deps.audio.duck(false);
    this.deps.onHeard(null);
  }

  private clearLinger(): void {
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private clearUnduck(): void {
    if (this.unduckTimer !== null) clearTimeout(this.unduckTimer);
    this.unduckTimer = null;
  }
}

import type { DrawOp, FigureOp } from './script';

/**
 * 수업 언어. 화면 문구·선생님 대본·받아쓰기·판별·채움 말이 모두 이 언어를 따른다.
 * 요청에 없으면 'ko'(예전 클라이언트와 호환).
 */
export type Lang = 'ko' | 'en';
export const LANGS: readonly Lang[] = ['ko', 'en'];
export const isLang = (v: unknown): v is Lang => v === 'ko' || v === 'en';

/** 질문 글자 수 한도. 서버 검증(app.ts)과 입력창(ui.ts)이 함께 쓴다. */
export const MAX_QUESTION_CHARS = 500;

/** 끼어들기 문맥에 담는 선생님 말의 최대 개수와 한 줄 글자 수. */
// 수업 하나 전체(아이 15문장·어른 20문장 안팎)를 넘긴다: 8문장만 넘기면 "다시 설명해 줘"에 앞부분 비유를 몰라 되풀이했다.
export const MAX_CONTEXT_SPOKEN = 24;
export const MAX_SPOKEN_CHARS = 200;

/** 수업이 끝난 뒤 이만큼 안에 온 질문은 앞 수업에 이어 묻는 것으로 보고 문맥(interrupted: false)을 함께 보낸다. */
export const FOLLOW_UP_WINDOW_MS = 120_000;

/**
 * 수업 중에 끼어들어 새 질문을 할 때(또는 수업이 막 끝난 뒤 이어 물을 때) 함께 보내는 문맥.
 * previousQuestion은 1~MAX_QUESTION_CHARS자, spoken은 최대 MAX_CONTEXT_SPOKEN개·각 MAX_SPOKEN_CHARS자.
 * interrupted: 수업 중에 끊고 물었으면 true(없으면 true), 끝난 수업에 이어 물었으면 false.
 */
export type LessonContext = { previousQuestion: string; spoken: string[]; interrupted?: boolean };

/**
 * 수업 방식. quick(빠른 선생님): Gemini 3.8 Flash(생각 low)가 바로 쓰고 그림은 화가가 따로.
 * deep(신중한 선생님): Gemini 4 Neon(생각 high)이 생각해서 대본과 그림을 모두 직접.
 */
export type LessonMode = 'quick' | 'deep';

/**
 * 설명 수준(사용자 결정, 2026-11-22): 초등학생 / 중학생 / 성인. 말투(반말·존댓말)는 프로필이, 깊이는 수준이 정한다.
 * 요청에 없으면 프로필 기본값(아이 → 초등, 어른 → 성인).
 */
export type Level = 'elementary' | 'middle' | 'adult';
export const LEVELS: readonly Level[] = ['elementary', 'middle', 'adult'];
export const defaultLevel = (profile: 'kid' | 'adult'): Level => (profile === 'kid' ? 'elementary' : 'adult');
/**
 * 말·판서 빠르기(1 = 그대로). 쉽게(초등)는 0.9배: 저학년이 보기엔 너무 빠르다는 의견(2026-11-23 사용자 요청).
 * 목소리는 브라우저에서 음 높이 그대로 늘이고(stretch.ts), 판서는 그 길이에 맞춰 함께 늦춘다.
 */
export const levelSpeed = (level: Level): number => (level === 'elementary' ? 0.9 : 1);
export const LESSON_MODES: readonly LessonMode[] = ['quick', 'deep'];

/** 글자별 발화 시작/끝 시각(ms). 같은 인덱스가 같은 글자. */
export type SayTiming = { chars: string[]; startMs: number[]; endMs: number[] };
export type Speech = { audioBase64: string; mime: 'audio/mpeg'; timing: SayTiming; durationMs: number };

/** 서버 → 브라우저 메시지. API 키 같은 비밀은 절대 담지 않는다. */
export type LessonMessage =
  | { type: 'say'; id: number; text: string; speech: Speech | null }
  | { type: 'draw'; sayId: number; at?: string; op: DrawOp }
  | { type: 'page' }
  /**
   * 화가가 끝낸 주문 그림(실패면 figure: null). 말 순서와 무관하게 끼어 온다(보여 주기 전이든 후든).
   * 서버는 done/error 전에 모든 주문이 끝나기를 기다린다(화가 시간 초과·실패도 figure: null로 온다).
   * 메시지 없이 버리는 것은 연결이 끊긴 경우뿐이다. 그래서 done/error가 오면 브라우저는 아직 안 온 그림을
   * 모두 없는 것으로 보고 기다리지 않는다(예약한 칸은 빈 채로).
   */
  | { type: 'sketch'; id: string; figure: FigureOp | null }
  /**
   * 이어 물을 질문(E2, 1~3개, 파서가 다듬은 것). 수업이 잘 끝날 때만 done 바로 앞에 한 번 온다.
   * 모델이 이 줄을 안 쓰면 오지 않는다 — 브라우저는 카드 없이 지금처럼 끝낸다.
   */
  | { type: 'next'; questions: string[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

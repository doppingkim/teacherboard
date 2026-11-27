import { rms } from './pcm';

/**
 * start.voicedMs: 시작을 연 큰 소리 길이(ms). audio.voiced: 이 프레임이 시작 문턱을 넘었나.
 * 둘은 "진짜 말인가"를 가리는 데 쓴다(VoiceController가 말소리가 이어진 시간을 센다).
 */
export type GateEvent = { type: 'start'; preRoll: Int16Array[]; voicedMs: number } | { type: 'audio'; pcm: Int16Array; voiced: boolean } | { type: 'end' };

/** 말이 끝났다고 보는 조용한 시간. 한국어는 말 중간에 1초 가까이 쉬기도 해서 넉넉히(2026-11-22, 700ms → 1300ms). */
export const HANGOVER_MS = 1300;

const FLOOR_ALPHA = 0.05;
const SPEAKING_FLOOR_ALPHA = 0.005;
const START_MIN = 0.015;
const START_FACTOR = 3;
const END_MIN = 0.01;
const END_FACTOR = 2;
/** 수업 중(선생님 목소리·방 소음) 시작 문턱 배율. 1.5 → 2.0(2026-11-22: 소음마다 열린다는 실사용 피드백). */
const STRICT_FACTOR = 2;
const CALIBRATION_MS = 500;

export class SpeechGate {
  private readonly preRollFrames: number;
  private readonly hangoverFrames: number;
  private readonly minSpeechFrames: number;
  private readonly calibrationFrames: number;
  private readonly maxSpeechFrames: number;
  private readonly frameMs: number;
  private floor = 0;
  private strict = false;
  private speaking = false;
  private locked = false; // 최대 길이로 강제 종료된 뒤, 소리가 잦아들 때까지 시작 금지
  private loudRun = 0;
  private quietRun = 0;
  private speechFrames = 0;
  private calibrated = 0;
  private calibSum = 0;
  private ring: Int16Array[] = [];

  constructor(opts: { frameMs?: number; preRollMs?: number; hangoverMs?: number; minSpeechMs?: number; maxSpeechMs?: number } = {}) {
    const frameMs = opts.frameMs ?? 20;
    this.frameMs = frameMs;
    this.preRollFrames = Math.max(1, Math.round((opts.preRollMs ?? 500) / frameMs));
    this.hangoverFrames = Math.max(1, Math.round((opts.hangoverMs ?? HANGOVER_MS) / frameMs));
    this.minSpeechFrames = Math.max(1, Math.ceil((opts.minSpeechMs ?? 150) / frameMs));
    this.maxSpeechFrames = Math.max(1, Math.round((opts.maxSpeechMs ?? 15000) / frameMs));
    this.calibrationFrames = Math.max(1, Math.round(CALIBRATION_MS / frameMs));
  }

  setStrict(on: boolean): void {
    this.strict = on;
  }

  reset(): void {
    this.floor = 0;
    this.speaking = false;
    this.locked = false;
    this.loudRun = 0;
    this.quietRun = 0;
    this.speechFrames = 0;
    this.calibrated = 0;
    this.calibSum = 0;
    this.ring = [];
  }

  private startThreshold(): number {
    const t = Math.max(this.floor * START_FACTOR, START_MIN);
    return this.strict ? t * STRICT_FACTOR : t;
  }

  private endThreshold(): number {
    return Math.max(this.floor * END_FACTOR, END_MIN);
  }

  push(frame: Int16Array): GateEvent[] {
    const level = rms(frame);

    if (this.speaking) {
      this.floor += SPEAKING_FLOOR_ALPHA * (level - this.floor);
      this.speechFrames++;
      if (level < this.endThreshold()) this.quietRun++;
      else this.quietRun = 0;

      if (this.quietRun >= this.hangoverFrames) {
        this.finish(false);
        return [{ type: 'end' }];
      }
      if (this.speechFrames >= this.maxSpeechFrames) {
        this.finish(true);
        return [{ type: 'end' }];
      }
      return [{ type: 'audio', pcm: frame, voiced: level >= this.startThreshold() }];
    }

    // 시작 직후 500ms는 잡음 바닥만 잰다(말 시작 금지). 프레임은 pre-roll로 쌓아 둔다.
    if (this.calibrated < this.calibrationFrames) {
      this.calibSum += level;
      this.calibrated++;
      if (this.calibrated === this.calibrationFrames) this.floor = this.calibSum / this.calibrated;
      this.pushRing(frame);
      return [];
    }

    if (this.locked) {
      this.floor += SPEAKING_FLOOR_ALPHA * (level - this.floor);
      if (level < this.endThreshold()) {
        if (++this.quietRun >= this.hangoverFrames) {
          this.locked = false;
          this.quietRun = 0;
        }
      } else {
        this.quietRun = 0;
      }
      return [];
    }

    // 말 시작 전: 프레임을 미리 담아 두고, 문턱 아래일 때만 잡음 바닥을 갱신한다.
    this.pushRing(frame);

    if (level >= this.startThreshold()) {
      this.loudRun++;
      if (this.loudRun >= this.minSpeechFrames) {
        const preRoll = this.ring;
        const voicedMs = this.loudRun * this.frameMs;
        this.ring = [];
        this.speaking = true;
        this.loudRun = 0;
        this.quietRun = 0;
        this.speechFrames = 0;
        return [{ type: 'start', preRoll, voicedMs }];
      }
    } else {
      this.loudRun = 0;
      this.floor += FLOOR_ALPHA * (level - this.floor);
    }
    return [];
  }

  private pushRing(frame: Int16Array): void {
    this.ring.push(frame);
    if (this.ring.length > this.preRollFrames) this.ring.shift();
  }

  private finish(forced: boolean): void {
    this.speaking = false;
    this.locked = forced;
    this.loudRun = 0;
    this.quietRun = 0;
    this.speechFrames = 0;
    this.ring = [];
  }
}

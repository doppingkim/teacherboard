// voice*.spec.ts가 함께 쓰는 목업: 수업 API(page.route)와 /api/listen 웹소켓(page.routeWebSocket).
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';

const lessonNdjson = readFileSync(new URL('../fixtures/moon-lesson.ndjson', import.meta.url), 'utf8');
const silenceB64 = readFileSync(new URL('../fixtures/silence.mp3', import.meta.url)).toString('base64');

/** 실제 API 없이: /api/lesson은 픽스처(받은 요청 본문을 모은다), /api/filler/(kid|adult)는 무음 한 개. */
export async function mockApi(page: Page): Promise<{ lessons: unknown[] }> {
  const lessons: unknown[] = [];
  await page.route('**/api/lesson', (route) => {
    lessons.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lessonNdjson });
  });
  await page.route('**/api/filler/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        audioBase64: silenceB64, mime: 'audio/mpeg', durationMs: 300,
        timing: { chars: ['음'], startMs: [0], endMs: [300] },
      }]),
    }));
  return { lessons };
}

export type Listen = {
  sockets: WebSocketRoute[];
  urls: string[];
  /** 받은 소리 덩어리 수와 말 끝({type:'end'}) 수(모든 연결 합). */
  readonly binary: number;
  readonly ends: number;
  /** 첫 판정을 보냈다. */
  judged: Promise<void>;
  /** 첫 연결이 닫혔다. */
  closed: Promise<void>;
};

/**
 * 듣기 서버 흉내: 연결 즉시 ready. 진짜 서버처럼 첫 말의 소리가 오면 partial, 그 말이 끝나면(end) utterance를 한 번 보낸다.
 * manual이면 ready만 보낸다(시험이 sockets로 직접 보낸다).
 */
export async function mockListen(page: Page, mode: 'accept' | 'reject' | 'manual'): Promise<Listen> {
  const sockets: WebSocketRoute[] = [];
  const urls: string[] = [];
  let binary = 0;
  let ends = 0;
  let judgedResolve!: () => void;
  let closedResolve!: () => void;
  const judged = new Promise<void>((r) => (judgedResolve = r));
  const closed = new Promise<void>((r) => (closedResolve = r));
  let partialSent = false;
  let judgedOnce = false;
  await page.routeWebSocket('**/api/listen**', (ws) => {
    sockets.push(ws);
    urls.push(ws.url());
    ws.onClose(() => closedResolve());
    ws.onMessage((m) => {
      if (typeof m !== 'string') {
        binary++;
        if (mode !== 'manual' && !partialSent) {
          partialSent = true;
          ws.send(JSON.stringify({ type: 'partial', text: '달은 왜' }));
        }
        return;
      }
      if ((JSON.parse(m) as { type?: string }).type !== 'end') return;
      ends++;
      if (mode === 'manual' || judgedOnce) return;
      judgedOnce = true;
      ws.send(JSON.stringify(
        mode === 'accept'
          ? { type: 'utterance', text: '달은 왜 따라와?', accept: true, question: '달은 왜 따라와?' }
          : { type: 'utterance', text: '우와!', accept: false, question: '' },
      ));
      judgedResolve();
    });
    ws.send(JSON.stringify({ type: 'ready' }));
  });
  return {
    sockets,
    urls,
    judged,
    closed,
    get binary() {
      return binary;
    },
    get ends() {
      return ends;
    },
  };
}

/** getUserMedia로 연 스트림을 window.__streams에 모아 둔다(트랙이 멈췄는지 보려고). */
export async function recordStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const orig = md.getUserMedia.bind(md);
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    md.getUserMedia = async (c) => {
      const s = await orig(c);
      w.__streams.push(s);
      return s;
    };
  });
}

/**
 * 가짜 마이크용 말소리 비슷한 WAV(16kHz·16비트·모노)를 임시 폴더에 만들고 경로를 돌려준다.
 * 1초 조용함 → 1.2초 "말"(150Hz 배음 + 초당 4번 음절 떨림) → 3초 조용함을 크롬이 되풀이한다.
 * 조용한 틈이 길어서 판정 뒤 말풍선이 닫힌 걸 다음 말이 오기 전에 볼 수 있다.
 * 크롬 기본 가짜 장치의 짧은 삐 소리는 게이트의 최소 말 길이(150ms)를 못 넘는다.
 */
export function speechLikeWav(): string {
  const rate = 16000;
  const quiet1 = rate;
  const talk = Math.round(1.2 * rate);
  const quiet2 = 3 * rate;
  const n = quiet1 + talk + quiet2;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 모노
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.002;
  for (let i = 0; i < n; i++) {
    let v = noise();
    if (i >= quiet1 && i < quiet1 + talk) {
      const t = (i - quiet1) / rate;
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      let h = 0;
      for (let k = 1; k <= 6; k++) h += Math.sin(2 * Math.PI * 150 * k * t + k) / k;
      v += 0.22 * env * h;
    }
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  const path = join(tmpdir(), `teacherboard-speechlike-${process.pid}.wav`); // 작업자마다 따로(동시에 쓰지 않게)
  writeFileSync(path, buf);
  return path;
}

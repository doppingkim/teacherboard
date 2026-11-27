// 서버 로그(pino JSON 줄)에서 최근 N개 수업의 단계별 시간 중앙값·p90과 수업당 평균 원가(토큰·글자 수 × 단가)를 뽑는다.
// API를 부르지 않는다. .env를 읽지 않는다(단가는 src/server/pricing.ts — config.ts가 다시 내보내는 같은 상수).
//
//   npx tsx scripts/latency-report.ts server.log            # 파일
//   npx tsx scripts/latency-report.ts --last 100 < server.log  # stdin, 최근 100개
//   ... | npx tsx scripts/latency-report.ts --json           # 기계가 읽을 JSON
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { geminiPrice, ttsPrice, type Price } from '../src/server/pricing';

type Usage = { model: string; input: number; output: number; thoughts: number; cached: number };
export type LessonRec = {
  lessonId?: string;
  mode?: string;
  spoken?: boolean;
  firstSayMs: number | null;
  totalMs: number;
  stages?: Record<string, number | null>;
  usage?: {
    teacher: Usage | null;
    artist: { calls: number; input: number; output: number; thoughts: number; cached: number; model?: string };
    tts: { model: string; calls: number; chars: number };
  };
  error?: string;
};
export type ClientRec = { lessonId: string | null; mode?: string; firstSoundMs: number | null; firstStrokeMs: number | null; endMs: number | null; result?: string };
export type ListenRec = { accept: boolean; ms: number; sttMs?: number };
export type Parsed = { lessons: LessonRec[]; client: ClientRec[]; listen: ListenRec[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number => (isNum(v) && v > 0 ? v : 0);

/** 토큰 묶음 하나(모양이 틀리면 null). */
function cleanTokens(v: unknown): Omit<Usage, 'model'> | null {
  if (!isObj(v)) return null;
  if (![v.input, v.output, v.thoughts, v.cached].every((x) => x === undefined || isNum(x))) return null;
  return { input: num(v.input), output: num(v.output), thoughts: num(v.thoughts), cached: num(v.cached) };
}

/** 수업 줄의 원가 재료. 모양이 틀리면(예전 줄·깨진 줄) undefined — 그 줄은 시간만 쓴다. */
function cleanUsage(v: unknown): LessonRec['usage'] {
  if (!isObj(v) || !isObj(v.artist) || !isObj(v.tts)) return undefined;
  let teacher: Usage | null = null;
  if (v.teacher !== null && v.teacher !== undefined) {
    const t = cleanTokens(v.teacher);
    if (!t || !isObj(v.teacher) || typeof v.teacher.model !== 'string') return undefined;
    teacher = { model: v.teacher.model, ...t };
  }
  const a = cleanTokens(v.artist);
  if (!a || !isNum(v.artist.calls)) return undefined;
  const artist: NonNullable<LessonRec['usage']>['artist'] = { calls: num(v.artist.calls), ...a };
  if (typeof v.artist.model === 'string') artist.model = v.artist.model;
  if (typeof v.tts.model !== 'string' || !isNum(v.tts.calls) || !isNum(v.tts.chars)) return undefined;
  return { teacher, artist, tts: { model: v.tts.model, calls: num(v.tts.calls), chars: num(v.tts.chars) } };
}

const emptyParsed = (): Parsed => ({ lessons: [], client: [], listen: [] });

/** 로그 한 줄을 읽어 out에 더한다. JSON이 아니거나 모르는 줄·모양이 틀린 기록은 건너뛴다(죽지 않는다). */
function addLine(out: Parsed, line: string): void {
  const s = line.trim();
  if (!s.startsWith('{')) return;
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    return;
  }
  if (!isObj(o)) return;
  if (isObj(o.lesson)) {
    const l = o.lesson;
    out.lessons.push({ ...(l as LessonRec), stages: isObj(l.stages) ? (l.stages as LessonRec['stages']) : undefined, usage: cleanUsage(l.usage) });
  } else if (isObj(o.clientLesson)) {
    const c = o.clientLesson;
    out.client.push({ ...(c as ClientRec), lessonId: typeof c.lessonId === 'string' ? c.lessonId : null });
  } else if (isObj(o.listen) && typeof o.listen.accept === 'boolean') {
    out.listen.push(o.listen as ListenRec);
  }
}

/** 로그 글 → 수업·기기 체감·듣기 기록(시간 순). JSON이 아닌 줄과 다른 줄은 건너뛴다. */
export function parseLog(text: string): Parsed {
  const out = emptyParsed();
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // UTF-8 BOM
  for (const line of body.split(/\r?\n/)) addLine(out, line);
  return out;
}

/** 이보다 긴 한 줄은 서버 로그가 아니다: 끝(줄바꿈)까지 건너뛴다. */
const MAX_LINE = 1_000_000;

/**
 * 로그를 조각(파일·stdin 스트림)으로 읽는다: 파일 전체를 한 글자열로 만들지 않아 아주 큰 로그(수백 MB)도 읽는다.
 * 첫 바이트로 글자 방식을 고른다: FF FE(UTF-16LE — Windows PowerShell 5의 `>`·Out-File 기본), FE FF(UTF-16BE), 그 밖은 UTF-8(BOM은 뗀다).
 */
export async function readLog(src: AsyncIterable<Buffer | string>): Promise<Parsed> {
  const out = emptyParsed();
  let decoder: TextDecoder | null = null;
  let head = Buffer.alloc(0);
  let rest = '';
  let skipping = false; // 너무 긴 줄의 남은 부분을 버리는 중
  const feed = (text: string) => {
    rest += text;
    let at: number;
    while ((at = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (skipping) skipping = false;
      else addLine(out, line);
    }
    if (rest.length > MAX_LINE) {
      rest = '';
      skipping = true;
    }
  };
  for await (const chunk of src) {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (!decoder) {
      head = Buffer.concat([head, buf]);
      if (head.length < 2) continue;
      const enc = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8';
      decoder = new TextDecoder(enc); // BOM은 TextDecoder가 뗀다
      buf = head;
    }
    feed(decoder.decode(buf, { stream: true }));
  }
  if (!decoder && head.length > 0) {
    decoder = new TextDecoder('utf-8'); // 1바이트뿐인 입력
    feed(decoder.decode(head, { stream: true }));
  }
  if (decoder) feed(decoder.decode());
  if (!skipping) addLine(out, rest);
  return out;
}

/** 중앙값(짝수면 가운데 둘의 평균)과 p90(가장 가까운 순위). 값이 없으면 null. */
export function stats(values: (number | null | undefined)[]): { n: number; p50: number | null; p90: number | null } {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, p50: null, p90: null };
  const mid = v.length >> 1;
  const p50 = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const p90 = v[Math.max(0, Math.ceil(0.9 * v.length) - 1)];
  return { n: v.length, p50: Math.round(p50), p90 };
}

/** 단계: [표에 쓸 이름, 값 꺼내기]. 서버 단계는 요청을 받은 때부터, 기기 단계는 물어본 때부터. */
const SERVER_STAGES: [string, (l: LessonRec) => number | null | undefined][] = [
  ['서버: Gemini 첫 조각', (l) => l.stages?.firstChunkMs],
  ['서버: 첫 대본 줄', (l) => l.stages?.firstLineMs],
  ['서버: 첫 문장 TTS 끝', (l) => l.stages?.firstTtsMs],
  ['서버: 첫 문장 나감', (l) => l.firstSayMs],
  ['서버: 첫 판서 나감', (l) => l.stages?.firstDrawMs],
  ['서버: 대본 끝', (l) => l.stages?.scriptEndMs],
  ['서버: 수업 끝', (l) => l.totalMs],
];
const CLIENT_STAGES: [string, (c: ClientRec) => number | null | undefined][] = [
  ['기기: 첫 소리', (c) => c.firstSoundMs],
  ['기기: 첫 획', (c) => c.firstStrokeMs],
  ['기기: 끝', (c) => c.endMs],
];

type Cost = number | 'unknown';
const mul = (count: number, price: Price): Cost => (count === 0 ? 0 : price === 'unknown' ? 'unknown' : (count * price) / 1e6);
const add = (...xs: Cost[]): Cost => (xs.some((x) => x === 'unknown') ? 'unknown' : (xs as number[]).reduce((a, b) => a + b, 0));

/** Gemini 호출 토큰 → USD. 캐시로 읽은 입력은 캐시 단가, 생각 토큰은 출력 단가. */
export function geminiCost(u: Omit<Usage, 'model'>, model: string | undefined): Cost {
  if (u.input + u.output + u.thoughts === 0) return 0;
  const p = geminiPrice(model ?? '');
  return add(mul(Math.max(0, u.input - u.cached), p.input), mul(u.cached, p.cachedInput), mul(u.output + u.thoughts, p.output));
}

/** 수업 하나의 원가(USD). 단가를 모르는 항목이 하나라도 있으면 'unknown'. */
export function lessonCost(l: LessonRec): { teacher: Cost; artist: Cost; tts: Cost; total: Cost } | null {
  const u = l.usage;
  if (!u) return null;
  const teacher = u.teacher ? geminiCost(u.teacher, u.teacher.model) : 'unknown'; // 토큰을 못 받았으면 알 수 없음
  const artist = u.artist.calls === 0 ? 0 : geminiCost(u.artist, u.artist.model);
  const tp = ttsPrice(u.tts.model);
  const tts: Cost = u.tts.chars === 0 ? 0 : tp === 'unknown' ? 'unknown' : u.tts.chars * tp;
  return { teacher, artist, tts, total: add(teacher, artist, tts) };
}

const avg = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const avgCost = (xs: Cost[]): Cost | null => (xs.length === 0 ? null : xs.some((x) => x === 'unknown') ? 'unknown' : (xs as number[]).reduce((a, b) => a + b, 0) / xs.length);

export type Report = {
  lessons: number;
  byMode: Record<string, number>;
  stages: { name: string; n: number; p50: number | null; p90: number | null }[];
  listen: { name: string; n: number; p50: number | null; p90: number | null }[];
  usage: Record<string, number | null>;
  /** noTokens: 선생님 토큰을 못 받아(시작 전 실패·첫 조각 전 중단) 원가 평균에서 뺀 수업 수. */
  cost: { teacher: Cost | null; artist: Cost | null; tts: Cost | null; total: Cost | null; unknownPrices: string[]; noTokens: number };
};

/** 최근 last개 수업(mode를 주면 그 방식만)으로 보고서를 만든다. 기기 체감 줄은 그 수업들의 lessonId로 고른다. */
export function buildReport(p: Parsed, opts: { last?: number; mode?: string } = {}): Report {
  const last = opts.last ?? 50;
  const pool = p.lessons.filter((l) => !opts.mode || l.mode === opts.mode);
  const lessons = pool.slice(-last);
  const ids = new Set(lessons.map((l) => l.lessonId).filter(Boolean));
  const client = p.client.filter((c) => c.lessonId && ids.has(c.lessonId) && c.result !== 'aborted');
  const heard = p.listen.filter((x) => x.accept).slice(-last);
  const byMode: Record<string, number> = {};
  for (const l of lessons) byMode[l.mode ?? '?'] = (byMode[l.mode ?? '?'] ?? 0) + 1;

  const stages = [
    ...SERVER_STAGES.map(([name, f]) => ({ name, ...stats(lessons.map(f)) })),
    ...CLIENT_STAGES.map(([name, f]) => ({ name, ...stats(client.map(f)) })),
  ];
  const listen = [
    { name: '듣기: 말 끝 → 받아쓰기 확정', ...stats(heard.map((x) => x.sttMs)) },
    { name: '듣기: 질문 판정', ...stats(heard.map((x) => x.ms)) },
  ];

  const metered = lessons.filter((l) => l.usage);
  const usage = {
    teacherInput: avg(metered.flatMap((l) => (l.usage!.teacher ? [l.usage!.teacher.input] : []))),
    teacherCached: avg(metered.flatMap((l) => (l.usage!.teacher ? [l.usage!.teacher.cached] : []))),
    teacherOutput: avg(metered.flatMap((l) => (l.usage!.teacher ? [l.usage!.teacher.output] : []))),
    teacherThoughts: avg(metered.flatMap((l) => (l.usage!.teacher ? [l.usage!.teacher.thoughts] : []))),
    artistCalls: avg(metered.map((l) => l.usage!.artist.calls)),
    artistInput: avg(metered.map((l) => l.usage!.artist.input)),
    artistOutput: avg(metered.map((l) => l.usage!.artist.output + l.usage!.artist.thoughts)),
    ttsCalls: avg(metered.map((l) => l.usage!.tts.calls)),
    ttsChars: avg(metered.map((l) => l.usage!.tts.chars)),
  };
  // 선생님 토큰을 못 받은 수업 하나가 평균 전체를 unknown으로 만들지 않게 뺀다(그 수는 따로 알린다).
  const priced = metered.filter((l) => l.usage!.teacher);
  const costs = priced.map((l) => lessonCost(l)!);
  const unknownPrices = new Set<string>();
  for (const l of metered) {
    const u = l.usage!;
    for (const m of [u.teacher?.model, u.artist.calls ? u.artist.model : undefined]) {
      if (!m) continue;
      const pr = geminiPrice(m);
      if (pr.input === 'unknown' || pr.output === 'unknown' || pr.cachedInput === 'unknown') unknownPrices.add(`${m} (Gemini)`);
    }
    if (u.tts.chars > 0 && ttsPrice(u.tts.model) === 'unknown') unknownPrices.add(`${u.tts.model} (TTS)`);
  }
  return {
    lessons: lessons.length,
    byMode,
    stages,
    listen,
    usage,
    cost: {
      teacher: avgCost(costs.map((c) => c.teacher)),
      artist: avgCost(costs.map((c) => c.artist)),
      tts: avgCost(costs.map((c) => c.tts)),
      total: avgCost(costs.map((c) => c.total)),
      unknownPrices: [...unknownPrices],
      noTokens: metered.length - priced.length,
    },
  };
}

const fmt = (v: number | null) => (v === null ? '-' : String(v));
const money = (c: Cost | null) => (c === null ? '-' : c === 'unknown' ? 'unknown' : `$${c.toFixed(4)}`);
/** 터미널 폭(한글은 두 칸). */
const cols = (s: string) => [...s].reduce((w, c) => w + (/[ᄀ-ᇿ㄰-㆏가-힯]/.test(c) ? 2 : 1), 0);
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - cols(s)));
const padL = (s: string, w: number) => ' '.repeat(Math.max(0, w - cols(s))) + s;

/** 사람이 읽는 표. */
export function formatReport(r: Report): string {
  const lines: string[] = [];
  const modes = Object.entries(r.byMode).map(([m, n]) => `${m} ${n}`).join(' · ');
  lines.push(`최근 수업 ${r.lessons}개${modes ? ` (${modes})` : ''}`);
  lines.push('');
  lines.push(`${pad('단계(ms)', 32)}${padL('n', 5)}${padL('중앙값', 9)}${padL('p90', 9)}`);
  for (const s of [...r.stages, ...r.listen]) lines.push(`${pad(s.name, 32)}${padL(String(s.n), 5)}${padL(fmt(s.p50), 9)}${padL(fmt(s.p90), 9)}`);
  lines.push('');
  const u = r.usage;
  lines.push('수업당 평균 사용량');
  lines.push(`  선생님 토큰: 입력 ${fmt(u.teacherInput)} (캐시 ${fmt(u.teacherCached)}) · 출력 ${fmt(u.teacherOutput)} · 생각 ${fmt(u.teacherThoughts)}`);
  lines.push(`  화가: 호출 ${fmt(u.artistCalls)} · 입력 ${fmt(u.artistInput)} · 출력+생각 ${fmt(u.artistOutput)}`);
  lines.push(`  TTS: 호출 ${fmt(u.ttsCalls)} · 글자 ${fmt(u.ttsChars)}`);
  lines.push('');
  lines.push(`수업당 평균 원가 추정: ${money(r.cost.total)} (선생님 ${money(r.cost.teacher)} · 화가 ${money(r.cost.artist)} · TTS ${money(r.cost.tts)})`);
  if (r.cost.noTokens) lines.push(`  (선생님 토큰을 못 받은 수업 ${r.cost.noTokens}개는 빼고 — 시작 전에 실패했거나 첫 조각 전에 끊긴 수업)`);
  if (r.cost.unknownPrices.length) lines.push(`  단가 미정(src/server/pricing.ts에 넣으면 계산돼요): ${r.cost.unknownPrices.join(', ')}`);
  return lines.join('\n');
}

async function main(argv: string[]) {
  let last = 50;
  let mode: string | undefined;
  let json = false;
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') last = Math.max(1, Number(argv[++i]) || 50);
    else if (a === '--mode') mode = argv[++i];
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') {
      console.log('사용: npx tsx scripts/latency-report.ts [로그파일] [--last N] [--mode quick|deep] [--json]  (파일이 없으면 stdin)');
      return;
    } else file = a;
  }
  // 조각으로 읽는다(수백 MB 로그도 한 글자열로 만들지 않는다).
  const r = buildReport(await readLog(file ? createReadStream(file) : process.stdin), { last, mode });
  console.log(json ? JSON.stringify(r, null, 2) : formatReport(r));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

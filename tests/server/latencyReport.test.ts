// scripts/latency-report.ts: 로그 줄 읽기, 중앙값·p90, 수업당 원가(단가를 모르면 unknown), 표.
import { buildReport, formatReport, geminiCost, lessonCost, parseLog, readLog, stats, type LessonRec } from '../../scripts/latency-report';
import { GEMINI_PRICES, TTS_PRICES } from '../../src/server/pricing';

const lesson = (i: number, over: Partial<LessonRec> = {}): LessonRec => ({
  lessonId: `L${i}`,
  mode: i % 2 ? 'deep' : 'quick',
  spoken: false,
  firstSayMs: 1000 + i * 100,
  totalMs: 20000 + i,
  stages: { firstChunkMs: 500 + i * 10, firstLineMs: 600 + i * 10, firstTtsMs: 900 + i * 100, firstDrawMs: 1100 + i * 100, scriptEndMs: 8000 },
  usage: {
    teacher: { model: 'gemini-3.8-flash', input: 6000, output: 1500, thoughts: 300, cached: 4000 },
    artist: { calls: 2, input: 12000, output: 800, thoughts: 100, cached: 0, model: 'gemini-3.8-flash' },
    tts: { model: 'eleven_v4_turbo', calls: 18, chars: 400 },
  },
  ...over,
});
const line = (o: object) => JSON.stringify({ level: 30, time: 1, pid: 1, msg: 'x', ...o });

test('stats: 중앙값(짝수면 가운데 평균)과 p90(가까운 순위), null·NaN은 뺀다', () => {
  expect(stats([5, 1, 3])).toEqual({ n: 3, p50: 3, p90: 5 });
  expect(stats([1, 2, 3, 4, null, Number.NaN])).toEqual({ n: 4, p50: 3, p90: 4 });
  expect(stats(Array.from({ length: 10 }, (_, i) => i + 1))).toEqual({ n: 10, p50: 6, p90: 9 });
  expect(stats([])).toEqual({ n: 0, p50: null, p90: null });
});

test('parseLog: lesson·clientLesson·listen 줄만 고르고 JSON이 아닌 줄은 건너뛴다', () => {
  const text = [
    'not json',
    line({ lesson: lesson(1) }),
    line({ clientLesson: { lessonId: 'L1', firstSoundMs: 1500, firstStrokeMs: 1700, endMs: 21000, result: 'done' } }),
    line({ listen: { text: '들은 말', accept: true, ms: 400, sttMs: 300 } }),
    line({ req: { url: '/x' } }),
    '{broken',
  ].join('\r\n');
  const p = parseLog(text);
  expect(p.lessons).toHaveLength(1);
  expect(p.client).toHaveLength(1);
  expect(p.listen).toEqual([{ text: '들은 말', accept: true, ms: 400, sttMs: 300 }]);
});

test('buildReport: 최근 N개만, 기기 체감은 그 수업들의 id로(중단된 수업은 빼고), 듣기는 받은 말만', () => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) lines.push(line({ lesson: lesson(i) }));
  lines.push(line({ clientLesson: { lessonId: 'L0', firstSoundMs: 9999, firstStrokeMs: 9999, endMs: 9999, result: 'done' } })); // 최근 10개 밖
  lines.push(line({ clientLesson: { lessonId: 'L5', firstSoundMs: 1500, firstStrokeMs: 1800, endMs: 30000, result: 'done' } }));
  lines.push(line({ clientLesson: { lessonId: 'L6', firstSoundMs: 2500, firstStrokeMs: 2800, endMs: 31000, result: 'error' } }));
  lines.push(line({ clientLesson: { lessonId: 'L7', firstSoundMs: 100, firstStrokeMs: 100, endMs: 100, result: 'aborted' } }));
  lines.push(line({ clientLesson: { lessonId: null, firstSoundMs: 100, firstStrokeMs: 100, endMs: 100, result: 'done' } }));
  lines.push(line({ listen: { accept: true, ms: 400, sttMs: 200 } }), line({ listen: { accept: false, ms: 9000, sttMs: 9000 } }));
  const r = buildReport(parseLog(lines.join('\n')), { last: 10 });
  expect(r.lessons).toBe(10);
  expect(r.byMode).toEqual({ quick: 5, deep: 5 });
  const byName = Object.fromEntries([...r.stages, ...r.listen].map((s) => [s.name, s]));
  expect(byName['서버: 첫 문장 나감']).toEqual({ name: '서버: 첫 문장 나감', n: 10, p50: 1650, p90: 2000 });
  expect(byName['기기: 첫 소리']).toMatchObject({ n: 2, p50: 2000, p90: 2500 });
  expect(byName['듣기: 말 끝 → 받아쓰기 확정']).toMatchObject({ n: 1, p50: 200 });
  expect(buildReport(parseLog(lines.join('\n')), { last: 10, mode: 'deep' }).byMode).toEqual({ deep: 6 }); // 방식을 먼저 고른 뒤 최근 10개
  expect(r.usage).toMatchObject({ teacherInput: 6000, artistCalls: 2, ttsChars: 400 });
});

test('원가: 단가를 모르면 unknown(0이 아니다), 미정 단가 목록을 알려 준다', () => {
  const r = buildReport({ lessons: [lesson(0), lesson(2)], client: [], listen: [] });
  expect(r.cost.total).toBe('unknown');
  expect(r.cost.unknownPrices).toEqual(['gemini-3.8-flash (Gemini)', 'eleven_v4_turbo (TTS)']);
  expect(formatReport(r)).toContain('unknown');
});

test('원가: 단가가 있으면 캐시 입력·생각 토큰까지 계산한다', () => {
  const saved = { g: GEMINI_PRICES['gemini-3.8-flash'], t: TTS_PRICES.eleven_v4_turbo };
  try {
    GEMINI_PRICES['gemini-3.8-flash'] = { input: 1, cachedInput: 0.25, output: 4 };
    TTS_PRICES.eleven_v4_turbo = 0.0001;
    // (6000-4000)×1 + 4000×0.25 + (1500+300)×4 = 2000 + 1000 + 7200 = 10200 → /1e6
    expect(geminiCost({ input: 6000, output: 1500, thoughts: 300, cached: 4000 }, 'gemini-3.8-flash')).toBeCloseTo(0.0102, 8);
    const c = lessonCost(lesson(0))!;
    expect(c.artist).toBeCloseTo((12000 * 1 + 900 * 4) / 1e6, 8);
    expect(c.tts).toBeCloseTo(0.04, 8);
    expect(c.total).toBeCloseTo(0.0102 + 0.0156 + 0.04, 8);
    expect(buildReport({ lessons: [lesson(0)], client: [], listen: [] }).cost.unknownPrices).toEqual([]);
    // 선생님 토큰을 못 받은 수업은 알 수 없음
    expect(lessonCost(lesson(1, { usage: { ...lesson(1).usage!, teacher: null } }))!.total).toBe('unknown');
  } finally {
    GEMINI_PRICES['gemini-3.8-flash'] = saved.g;
    TTS_PRICES.eleven_v4_turbo = saved.t;
  }
});

test('formatReport: 단계 표와 사용량 줄', () => {
  const out = formatReport(buildReport({ lessons: [lesson(0)], client: [], listen: [] }));
  expect(out).toContain('최근 수업 1개 (quick 1)');
  expect(out).toMatch(/서버: 첫 문장 나감\s+1\s+1000\s+1000/);
  expect(out).toContain('TTS: 호출 18 · 글자 400');
});

test('원가 평균: 선생님 토큰을 못 받은 수업(시작 전 실패·첫 조각 전 중단)은 평균에서 빼고 그 수를 알린다', () => {
  const saved = { g: GEMINI_PRICES['gemini-3.8-flash'], t: TTS_PRICES.eleven_v4_turbo };
  try {
    GEMINI_PRICES['gemini-3.8-flash'] = { input: 1, cachedInput: 0.25, output: 4 };
    TTS_PRICES.eleven_v4_turbo = 0.0001;
    const all = buildReport({ lessons: [lesson(0), lesson(2)], client: [], listen: [] });
    const withFailed = buildReport({ lessons: [lesson(0), lesson(2), lesson(4, { usage: { ...lesson(4).usage!, teacher: null } })], client: [], listen: [] });
    expect(withFailed.cost.total).toBeCloseTo(all.cost.total as number, 8);
    expect(withFailed.cost.noTokens).toBe(1);
    expect(formatReport(withFailed)).toContain('선생님 토큰을 못 받은 수업 1개는 빼고');
  } finally {
    GEMINI_PRICES['gemini-3.8-flash'] = saved.g;
    TTS_PRICES.eleven_v4_turbo = saved.t;
  }
});

test('parseLog: 모양이 틀린 수업 줄(usage 일부 없음·숫자가 글자·배열)에도 죽지 않고, 그 줄의 원가 재료만 버린다', () => {
  const text = [
    line({ lesson: lesson(0) }),
    line({ lesson: { lessonId: 'b', totalMs: 5, usage: {} } }),
    line({ lesson: { lessonId: 'c', totalMs: 'x', usage: { teacher: { input: '5' }, artist: null, tts: 3 } } }),
    line({ lesson: { usage: { artist: { calls: 1 } } } }),
    line({ lesson: [1, 2] }),
    line({ clientLesson: [1] }),
    line({ listen: 'x' }),
    '{"lesson":',
  ].join('\n');
  const p = parseLog(text);
  expect(p.lessons).toHaveLength(4);
  expect(p.client).toHaveLength(0);
  expect(p.listen).toHaveLength(0);
  expect(p.lessons.filter((l) => l.usage)).toHaveLength(1);
  const r = buildReport(p);
  expect(r.lessons).toBe(4);
  expect(() => formatReport(r)).not.toThrow();
  expect(r.usage.ttsChars).toBe(400);
});

test('readLog: UTF-16(PowerShell `>`로 저장한 로그)·UTF-8 BOM·조각 경계에서 잘린 한글도 읽는다', async () => {
  const text = [line({ lesson: lesson(0, { error: '한글 오류' }) }), line({ listen: { accept: true, ms: 10, sttMs: 20 } })].join('\r\n') + '\r\n';
  const chunks = (buf: Buffer, n: number) => (async function* () { for (let i = 0; i < buf.length; i += n) yield buf.subarray(i, i + n); })();
  for (const buf of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), Buffer.from(text)]) {
    const p = await readLog(chunks(buf, 7));
    expect(p.lessons).toHaveLength(1);
    expect(p.lessons[0].error).toBe('한글 오류');
    expect(p.listen).toHaveLength(1);
  }
});

test('readLog: 끝없이 긴 한 줄(1MB 넘음)은 건너뛰고 그 뒤 줄은 읽는다', async () => {
  const src = (async function* () {
    yield Buffer.from(line({ lesson: lesson(0) }) + '\n{"lesson":{"x":"');
    for (let i = 0; i < 20; i++) yield Buffer.alloc(100_000, 0x61);
    yield Buffer.from('"}}\n' + line({ lesson: lesson(2) }) + '\n');
  })();
  const p = await readLog(src);
  expect(p.lessons.map((l) => l.lessonId)).toEqual(['L0', 'L2']);
});

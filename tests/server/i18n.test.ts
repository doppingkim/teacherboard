// English lessons: prompts, context, classifier, speech recognition, fillers, and the lang field on every route.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/server/app';
import { classifyUtterance, quickVerdict } from '../../src/server/classify';
import { FILLER_TEXTS_BY_LANG, getFillers } from '../../src/server/fillers';
import { buildUserMessage } from '../../src/server/lessonContext';
import { buildSystemPromptEn, EXAMPLE_END_EN as EXAMPLE_END, EXAMPLE_START_EN as EXAMPLE_START } from '../../src/server/prompts.en';
import { SCRIBE_URL, scribeUrl } from '../../src/server/stt';
import type { Speech } from '../../src/shared/lesson';
import { createParseState, parseScriptLine, type ScriptEvent } from '../../src/shared/script';

const sp = (t: string): Speech => ({ audioBase64: t, mime: 'audio/mpeg', timing: { chars: [...t], startMs: [], endMs: [] }, durationMs: 100 });

function exampleBlocks(prompt: string): string[][] {
  const out: string[][] = [];
  let from = 0;
  for (;;) {
    const a = prompt.indexOf(EXAMPLE_START, from);
    if (a < 0) return out;
    const b = prompt.indexOf(EXAMPLE_END, a);
    out.push(prompt.slice(a + EXAMPLE_START.length, b).split('\n').map((l) => l.trim()).filter(Boolean));
    from = b + EXAMPLE_END.length;
  }
}

describe('English prompts', () => {
  test.each([['kid', 'quick', 1], ['adult', 'quick', 2], ['kid', 'deep', 1], ['adult', 'deep', 1]] as const)('%s/%s: examples parse, English only', (p, m, n) => {
    const prompt = buildSystemPromptEn(p, m);
    expect(prompt).toContain('Speak and write in English only.');
    expect(prompt).not.toMatch(/[가-힣]/);
    const blocks = exampleBlocks(prompt);
    expect(blocks).toHaveLength(n);
    for (const lines of blocks) {
      const st = createParseState();
      const evs = lines.map((l) => parseScriptLine(l, st));
      expect(lines.filter((_, i) => evs[i] === null)).toEqual([]);
      const e = evs as ScriptEvent[];
      expect(e[0].t).toBe('say');
      expect(e[1]).toMatchObject({ t: 'draw', op: { kind: 'text', role: 'title' } });
      expect(e.at(-1)?.t).toBe('next');
    }
  });
  test('deep mode swaps picture orders for direct drawing', () => {
    const deep = buildSystemPromptEn('kid', 'deep');
    expect(deep).toContain('# Drawing pictures yourself (figure)');
    expect(deep).not.toContain('# Picture orders (sketch)');
  });
  test('levels change depth, profile keeps tone', () => {
    expect(buildSystemPromptEn('kid')).toContain('# Explanation level: elementary school');
    expect(buildSystemPromptEn('adult')).toContain('# Explanation level: adult');
    expect(buildSystemPromptEn('kid', 'quick', 'middle')).toContain('# Listener: a child');
  });
});

describe('English context', () => {
  test('voice note and follow-up context are in English', () => {
    const m = buildUserMessage('what is photosynthesis', { previousQuestion: 'why is the sky blue', spoken: ['Light scatters.'], interrupted: false }, 'what is photo synthesis', 'en');
    expect(m).toContain('Question of the lesson that just ended: why is the sky blue');
    expect(m).toContain('Exactly as transcribed: what is photo synthesis');
    expect(m).not.toMatch(/[가-힣]/);
  });
  test('Korean stays the default', () => {
    expect(buildUserMessage('q', { previousQuestion: 'p', spoken: [] })).toContain('방금 수업 질문');
  });
});

describe('English classifier', () => {
  const base = { profile: 'kid' as const, lessonActive: false, recentSpoken: [], lang: 'en' as const };
  test.each(['Wow!', 'cool', 'Hahaha', 'ohhh', 'okay'])('%s is an exclamation', (text) => {
    expect(quickVerdict({ ...base, text })).toMatchObject({ accept: false, reason: 'exclaim' });
  });
  test('the English filler coming back through the mic is an echo', () => {
    expect(quickVerdict({ ...base, text: FILLER_TEXTS_BY_LANG.en[0] })).toMatchObject({ reason: 'echo' });
  });
  test('a real question goes to the model', () => {
    expect(quickVerdict({ ...base, text: 'why is the sky blue' })).toBeNull();
  });
  test('without the model, an English request is accepted outside a lesson', async () => {
    const v = await classifyUtterance({ ...base, text: 'tell me about volcanoes' }, () => Promise.reject(new Error('down')));
    expect(v).toMatchObject({ accept: true, reason: 'fallback' });
    const no = await classifyUtterance({ ...base, text: 'the dog is outside' }, () => Promise.reject(new Error('down')));
    expect(no.accept).toBe(false);
  });
});

test('speech recognition language follows the lesson', () => {
  expect(scribeUrl()).toBe(SCRIBE_URL);
  expect(scribeUrl('en')).toContain('language_code=en');
  expect(scribeUrl('en')).not.toContain('language_code=ko');
});

describe('fillers and routes', () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-i18n-')); });
  afterEach(async () => { await app?.close(); app = undefined; await rm(dir, { recursive: true, force: true }); });

  test('English fillers are cached under their own names', async () => {
    const said: string[] = [];
    await getFillers('kid', 'v', async (t) => { said.push(t); return sp(t); }, dir, undefined, 'en');
    expect(said.sort()).toEqual([...FILLER_TEXTS_BY_LANG.en].sort());
    expect((await readdir(dir)).sort()).toEqual(['en-kid-0.json', 'en-kid-1.json', 'en-kid-2.json']);
  });

  const make = (over: Partial<AppDeps> = {}) =>
    (app = buildApp({
      scriptText: async function* () { yield JSON.stringify({ say: 'hi' }) + '\n'; },
      speak: async (t) => sp(t),
      voice: { kid: 'vk', adult: 'va' },
      fillerDir: dir,
      staticDir: join(dir, 'no-dist'),
      logLesson: () => {},
      ...over,
    }));

  test('lesson: lang reaches the script and the voice; unknown lang is 400', async () => {
    const seen: unknown[] = [];
    make({
      scriptText: async function* (...args) { seen.push(args[8]); yield JSON.stringify({ say: 'hi' }) + '\n'; },
      speak: async (t, _p, _s, _prev, lang) => { seen.push(`speak:${lang}`); return sp(t); },
    });
    const ok = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'why?', profile: 'kid', lang: 'en' } });
    expect(ok.statusCode).toBe(200);
    expect(seen).toEqual(['en', 'speak:en']);
    const bad = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'why?', profile: 'kid', lang: 'fr' } });
    expect(bad.statusCode).toBe(400);
  });

  test('lesson errors come back in the lesson language', async () => {
    make({ scriptText: async function* () { throw new Error('boom'); } });
    const res = await app!.inject({ method: 'POST', url: '/api/lesson', payload: { question: 'why?', profile: 'kid', lang: 'en' } });
    const last = JSON.parse(res.body.trim().split('\n').at(-1)!);
    expect(last).toEqual({ type: 'error', message: 'Something went wrong while making the lesson. Could you ask again?' });
  });

  test('filler: ?lang=en speaks English, other values are 400', async () => {
    const said: string[] = [];
    make({ speak: async (t, _p, _s, _prev, lang) => { said.push(`${lang}:${t}`); return sp(t); } });
    const res = await app!.inject({ method: 'GET', url: '/api/filler/kid?lang=en' });
    expect(res.statusCode).toBe(200);
    expect(said.sort()).toEqual(FILLER_TEXTS_BY_LANG.en.map((t) => `en:${t}`).sort());
    expect((await app!.inject({ method: 'GET', url: '/api/filler/kid?lang=xx' })).statusCode).toBe(400);
  });
});

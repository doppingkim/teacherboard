import { ThinkingLevel } from '@google/genai';
import type { GenAI } from '../../src/server/gemini';
import { streamScriptText, RefusalError } from '../../src/server/teacher';
import { buildUserMessage } from '../../src/server/lessonContext';
import { buildSystemPrompt } from '../../src/server/prompts';

type Chunk = { text?: string; promptFeedback?: { blockReason?: string }; candidates?: { finishReason?: string }[] };

function fakeClient(chunks: Chunk[]) {
  const calls: Record<string, any>[] = [];
  const client = {
    models: {
      async generateContentStream(params: Record<string, unknown>) {
        calls.push(params);
        return (async function* () { yield* chunks; })();
      },
      async generateContent() { throw new Error('not used'); },
    },
  };
  return { client: client as unknown as GenAI, calls };
}

async function collect(it: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const s of it) out.push(s);
  return out;
}

const chunks: Chunk[] = [{ text: '{"say":' }, { text: '"안녕"}\n' }, { text: '' }];

afterEach(() => {
  for (const k of ['QUICK_MODEL', 'DEEP_MODEL', 'DEEP_THINKING']) delete process.env[k];
});

test('빠른 선생님: Gemini 3.8 Flash, 생각 low, 글자 조각만 내보낸다', async () => {
  const { client, calls } = fakeClient(chunks);
  const signal = new AbortController().signal;
  expect(await collect(streamScriptText('달은 왜 나를 따라와?', 'kid', signal, client))).toEqual(['{"say":', '"안녕"}\n']);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    model: 'gemini-3.8-flash',
    contents: [{ role: 'user', parts: [{ text: '달은 왜 나를 따라와?' }] }],
    config: {
      systemInstruction: buildSystemPrompt('kid'),
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      maxOutputTokens: 16000,
      abortSignal: signal,
    },
  });
});

test('신중한 선생님: Gemini 4 Neon, 생각 high(DEEP_THINKING으로 바꿈), 그림을 직접 그리는 프롬프트', async () => {
  const { client, calls } = fakeClient(chunks);
  await collect(streamScriptText('번개는 왜 쳐?', 'adult', new AbortController().signal, client, undefined, undefined, 'deep'));
  expect(calls[0]).toMatchObject({
    model: 'gemini-4-neon',
    config: { systemInstruction: buildSystemPrompt('adult', 'deep'), thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH }, maxOutputTokens: 32000 },
  });
  process.env.DEEP_THINKING = 'medium';
  process.env.DEEP_MODEL = 'gemini-4-carbon';
  await collect(streamScriptText('q', 'kid', new AbortController().signal, client, undefined, undefined, 'deep'));
  expect(calls[1]).toMatchObject({ model: 'gemini-4-carbon', config: { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } } });
});

test.each([
  ['질문이 막힘', [{ promptFeedback: { blockReason: 'SAFETY' } }]],
  ['답이 도중에 막힘', [{ text: '{"say":"a"}\n' }, { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }]],
])('%s → RefusalError', async (_n, cs) => {
  const { client } = fakeClient(cs as Chunk[]);
  await expect(collect(streamScriptText('q', 'adult', new AbortController().signal, client))).rejects.toBeInstanceOf(RefusalError);
});

test('끼어들기 문맥이 있으면 user 내용은 buildUserMessage 결과', async () => {
  const { client, calls } = fakeClient(chunks);
  const context = { previousQuestion: '무지개는 왜 생겨?', spoken: ['햇빛이 물방울에 들어가면'] };
  await collect(streamScriptText('근데 왜?', 'kid', new AbortController().signal, client, context));
  expect(calls[0].contents).toEqual([{ role: 'user', parts: [{ text: buildUserMessage('근데 왜?', context) }] }]);
});

// QA 2026-11-22: 글자 하나 없이 끝난 응답(생각만 하다 MAX_TOKENS, RECITATION 등)은 조용히 끝나 이유를 알 수 없었다.
test.each([
  ['MAX_TOKENS', [{ candidates: [{ finishReason: 'MAX_TOKENS' }] }], /MAX_TOKENS/],
  ['RECITATION', [{ text: '' }, { candidates: [{ finishReason: 'RECITATION' }] }], /RECITATION/],
  ['아무 조각도 없음', [], /빈 응답/],
])('글자 없는 응답(%s) → 이유를 담아 던진다(거절은 아님)', async (_n, cs, re) => {
  const { client } = fakeClient(cs as Chunk[]);
  const err = await collect(streamScriptText('q', 'kid', new AbortController().signal, client)).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(RefusalError);
  expect(String(err.message)).toMatch(re);
});
test('글자가 있으면 MAX_TOKENS로 잘려도 던지지 않는다(잘린 마지막 줄은 파서가 버린다)', async () => {
  const { client } = fakeClient([{ text: '{"say":"a"}\n{"sa' }, { candidates: [{ finishReason: 'MAX_TOKENS' }] }]);
  expect(await collect(streamScriptText('q', 'kid', new AbortController().signal, client))).toEqual(['{"say":"a"}\n{"sa']);
});

test('스트림 도중 예외는 그대로 던진다(받은 조각은 먼저 내보냄)', async () => {
  const client = {
    models: {
      async generateContentStream() {
        return (async function* () { yield { text: '{"say":"a"}\n' }; throw new Error('network'); })();
      },
      async generateContent() { throw new Error('not used'); },
    },
  } as unknown as GenAI;
  const got: string[] = [];
  const err = await (async () => { for await (const s of streamScriptText('q', 'kid', new AbortController().signal, client)) got.push(s); })().catch((e) => e);
  expect(got).toEqual(['{"say":"a"}\n']);
  expect(err.message).toBe('network');
});
test('도중에 안전 정책으로 막히면(SAFETY) 받은 글자가 있어도 거절로 던진다', async () => {
  const { client } = fakeClient([{ text: '{"say":"a"}\n' }, { candidates: [{ finishReason: 'SAFETY' }] }]);
  await expect(collect(streamScriptText('q', 'kid', new AbortController().signal, client))).rejects.toBeInstanceOf(RefusalError);
});

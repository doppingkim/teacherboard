import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILLER_TEXTS, getFillers } from '../../src/server/fillers';
import type { Speech } from '../../src/shared/lesson';

const sp = (t: string): Speech => ({ audioBase64: t, mime: 'audio/mpeg', timing: { chars: [...t], startMs: [], endMs: [] }, durationMs: 100 });
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-filler-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('채움 문장은 정해진 세 문장 그대로', () => {
  expect(FILLER_TEXTS).toEqual(['음~ 좋은 질문이야!', '오, 그거 궁금했구나!', '자, 그려 볼까?']);
});
test('처음엔 TTS로 만들고 <profile>-<i>.json에 저장, 다음엔 캐시를 쓴다', async () => {
  const speak = vi.fn(async (t: string) => sp(t));
  const first = await getFillers('kid', 'v1', speak, dir);
  expect(first.map(s => s.audioBase64)).toEqual([...FILLER_TEXTS]);
  expect(speak).toHaveBeenCalledTimes(3);
  const cached = await readFile(join(dir, 'kid-0.json'), 'utf8');
  expect(cached).toContain('음~ 좋은 질문이야!');
  const again = await getFillers('kid', 'v1', speak, dir);
  expect(again).toEqual(first);
  expect(speak).toHaveBeenCalledTimes(3);
});
test('프로필마다 따로 캐시한다', async () => {
  const speak = vi.fn(async (t: string) => sp(t));
  await getFillers('kid', 'v1', speak, dir);
  await getFillers('adult', 'v1', speak, dir);
  expect(speak).toHaveBeenCalledTimes(6);
});
test('깨진 캐시 파일은 다시 만든다', async () => {
  await writeFile(join(dir, 'adult-1.json'), '{broken', 'utf8');
  const speak = vi.fn(async (t: string) => sp(t));
  const out = await getFillers('adult', 'v1', speak, dir);
  expect(out).toHaveLength(3);
  expect(speak).toHaveBeenCalledTimes(3);
});
test('없는 디렉터리는 만든다', async () => {
  const out = await getFillers('kid', 'v1', async t => sp(t), join(dir, 'a', 'b'));
  expect(out).toHaveLength(3);
});
test('일부 TTS 실패는 건너뛰고 캐시하지 않는다, 전부 실패면 던진다', async () => {
  const out = await getFillers('kid', 'v1', async t => { if (t === FILLER_TEXTS[1]) throw new Error('x'); return sp(t); }, dir);
  expect(out.map(s => s.audioBase64)).toEqual([FILLER_TEXTS[0], FILLER_TEXTS[2]]);
  const speak = vi.fn(async (t: string) => sp(t));
  await getFillers('kid', 'v1', speak, dir);
  expect(speak).toHaveBeenCalledTimes(1);
  await expect(getFillers('adult', 'v1', async () => { throw new Error('down'); }, dir)).rejects.toThrow();
});
test('동시에 불려도 TTS는 한 번만', async () => {
  const speak = vi.fn(async (t: string) => { await new Promise(r => setTimeout(r, 5)); return sp(t); });
  const [a, b] = await Promise.all([getFillers('kid', 'v1', speak, dir), getFillers('kid', 'v1', speak, dir)]);
  expect(a).toEqual(b);
  expect(speak).toHaveBeenCalledTimes(3);
});
test('목소리(voiceId)가 바뀌면 캐시를 버리고 다시 만든다', async () => {
  const speak = vi.fn(async (t: string) => sp(t));
  await getFillers('kid', 'v1', speak, dir);
  expect(await readFile(join(dir, 'kid-0.json'), 'utf8')).toContain('"voiceId":"v1"');
  await getFillers('kid', 'v1', speak, dir);
  expect(speak).toHaveBeenCalledTimes(3);
  await getFillers('kid', 'v2', speak, dir);
  expect(speak).toHaveBeenCalledTimes(6);
  expect(await readFile(join(dir, 'kid-0.json'), 'utf8')).toContain('"voiceId":"v2"');
});
test('voiceId 없는 옛 캐시 파일은 캐시 미스', async () => {
  await writeFile(join(dir, 'kid-0.json'), JSON.stringify({ text: FILLER_TEXTS[0], speech: sp('old') }), 'utf8');
  const speak = vi.fn(async (t: string) => sp(t));
  const out = await getFillers('kid', 'v1', speak, dir);
  expect(out[0].audioBase64).toBe(FILLER_TEXTS[0]);
  expect(speak).toHaveBeenCalledTimes(3);
});
test('채움 음성 TTS 실패 원인을 onError로 알린다', async () => {
  const onError = vi.fn();
  const boom = new Error('ElevenLabs 429: busy');
  const out = await getFillers('kid', 'v1', async t => { if (t === FILLER_TEXTS[0]) throw boom; return sp(t); }, dir, onError);
  expect(out).toHaveLength(2);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(boom, FILLER_TEXTS[0]);
});

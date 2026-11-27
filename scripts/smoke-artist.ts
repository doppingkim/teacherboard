// 실제 화가 호출 스모크: npx tsx scripts/smoke-artist.ts
// .env에 GEMINI_API_KEY만 있으면 된다. 모델을 바꾸려면 ARTIST_MODEL=gemini-4-hydrogen 처럼.
// SMOKE_TIMEOUT_MS로 시간 제한을 바꿀 수 있다(기본 60초).
// 주문 4개를 동시에 보내 각 소요 시간·획 수를 출력하고, data/artist/<n>.svg(1280×720 흰 배경)로 저장한다.
// 그 뒤 주문 하나를 더 보내 시스템 프롬프트 캐시가 읽히는지(cache_read_input_tokens > 0) 본다.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIST_TIMEOUT_MS, createArtist } from '../src/server/artist';
import { modelFor } from '../src/server/gemini';
import { inkColor } from '../src/web/board/primitives';
import type { FigureOp, SketchOrder } from '../src/shared/script';

const ORDERS: SketchOrder[] = [
  { id: '전투', size: 'wide', describe: '투구 쓴 병사 둘이 칼을 맞대고 싸우는 모습, 뒤에 성벽' },
  { id: '티라노', size: 'small', describe: '공룡 티라노사우루스가 울부짖는 모습' },
  { id: '무지개', size: 'small', describe: '비 온 뒤 하늘의 무지개와 해' },
  { id: '지구와 달', size: 'small', describe: '지구 둘레를 도는 달' },
];

const W = 1280;
const H = 720;

function toSvg(fig: FigureOp, title: string): string {
  const boxH = fig.size === 'wide' ? 37 : 100;
  const scale = Math.min((W - 80) / 100, (H - 120) / boxH);
  const ox = (W - 100 * scale) / 2;
  const oy = 70 + (H - 70 - boxH * scale) / 2;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const paths = fig.strokes
    .map((s) => {
      const d = typeof s === 'string' ? s : s.d;
      const color = inkColor(typeof s === 'string' ? fig.ink : (s.ink ?? fig.ink));
      const fill = typeof s !== 'string' && s.fill ? `fill="${color}" fill-opacity="0.25"` : 'fill="none"';
      return `    <path d="${d}" stroke="${color}" ${fill}/>`;
    })
    .join('\n');
  const labels = (fig.labels ?? [])
    .map((l) => `    <text x="${l.x}" y="${l.y}" font-size="5" text-anchor="middle" fill="${inkColor(l.ink ?? fig.ink)}">${esc(l.text)}</text>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="40" y="48" font-size="26" fill="#555">${esc(title)}</text>
  <g transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)}) scale(${scale.toFixed(3)})" stroke-width="${(5 / scale).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round">
    <rect width="100" height="${boxH}" fill="none" stroke="#eee" stroke-width="${(1 / scale).toFixed(3)}"/>
${paths}
${labels}
  </g>
</svg>
`;
}

const outDir = join('data', 'artist');
mkdirSync(outDir, { recursive: true });
// 실제 소요 시간을 재려고 시간 제한을 넉넉히(기본 60초) 두고, 서버 제한(12초) 안에 들었는지 따로 표시한다.
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const usage = new Map<string, { input: number; cached: number; output: number; thoughts: number }>();
const artist = createArtist({
  timeoutMs,
  onUsage: (o, u) =>
    usage.set(o.id, { input: u.promptTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thoughts: u.thoughtsTokenCount ?? 0 }),
});
const usageText = (id: string) => {
  const u = usage.get(id);
  return u ? `  [토큰 입력 ${u.input}(캐시 ${u.cached}), 출력 ${u.output} + 생각 ${u.thoughts}]` : '';
};
const model = modelFor('artist');
console.log(`화가 모델: ${model}, 주문 ${ORDERS.length}개 동시 호출, 시간 제한 ${timeoutMs}ms`);

const started = Date.now();
const results = await Promise.all(
  ORDERS.map(async (order, i) => {
    const t0 = Date.now();
    const fig = await artist(order, new AbortController().signal);
    const ms = Date.now() - t0;
    const within = ms <= ARTIST_TIMEOUT_MS ? '' : `  (서버 제한 ${ARTIST_TIMEOUT_MS}ms 초과)`;
    const n = i + 1;
    if (fig) {
      writeFileSync(join(outDir, `${n}.svg`), toSvg(fig, `${n}. [${order.size}] ${order.describe}`));
      writeFileSync(join(outDir, `${n}.json`), JSON.stringify(fig, null, 1));
      const inks = new Set(fig.strokes.map((s) => (typeof s === 'string' ? fig.ink : (s.ink ?? fig.ink))));
      const fills = fig.strokes.filter((s) => typeof s !== 'string' && s.fill).length;
      console.log(`  ${n}. ${order.id.padEnd(6)} ${String(ms).padStart(6)}ms  획 ${fig.strokes.length}개, 색 ${inks.size}개, 채우기 ${fills}개${within}${usageText(order.id)}`);
    } else {
      console.log(`  ${n}. ${order.id.padEnd(6)} ${String(ms).padStart(6)}ms  실패(null)`);
    }
    return fig;
  }),
);
console.log(`전체 ${Date.now() - started}ms, 성공 ${results.filter(Boolean).length}/${ORDERS.length} → ${outDir}/`);

// 캐시 확인: 위 호출들 뒤라 이번 호출은 시스템 지시문을 암묵적 캐시에서 읽을 수 있다(Gemini가 알아서).
const extra: SketchOrder = { id: '해바라기', size: 'small', describe: '화분에 핀 해바라기' };
const t1 = Date.now();
const extraFig = await artist(extra, new AbortController().signal);
const cacheRead = usage.get(extra.id)?.cached ?? 0;
console.log(`캐시 확인: ${extra.id} ${Date.now() - t1}ms ${extraFig ? `획 ${extraFig.strokes.length}개` : '실패(null)'}${usageText(extra.id)} → ${cacheRead > 0 ? '캐시 읽힘' : '캐시 안 읽힘'}`);

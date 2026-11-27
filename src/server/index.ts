import type { FastifyInstance } from 'fastify';
import { buildApp, type LessonLog, type ListenLog } from './app';
import { lessonLogWithoutText, listenLogWithoutText } from './telemetry';
import { createArtist } from './artist';
import { classifyUtterance, geminiAsk } from './classify';
import { streamScriptText } from './teacher';
import { loadConfig } from './config';
import { ScribeSession } from './stt';
import { synthesize } from './tts';

/** 실제 Gemini·ElevenLabs를 연결해 서버를 띄운다. 키는 서버 안에만 있고 응답에는 실리지 않는다. */
async function main() {
  const cfg = loadConfig();
  const ask = geminiAsk();
  let app: FastifyInstance | undefined;
  // 화가 실패 이유는 서버 로그에만(주문 id·크기와 오류 이름·메시지. 키·요청 본문은 남기지 않는다).
  // 수업이 멈추거나 연결이 끊겨 abort된 호출은 실패가 아니라 오지 않는다(12초 시간 초과는 온다).
  const drawSketch = createArtist({
    onError: (order, err) =>
      app?.log.warn(
        { sketch: order.id, size: order.size, artistError: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
        'artist failed',
      ),
  });
  app = buildApp({
    scriptText: (question, profile, signal, context, heard, mode, level, onUsage, lang) =>
      streamScriptText(question, profile, signal, undefined, context, heard, mode, level, onUsage, lang),
    speak: (text, profile, signal, prev, lang) =>
      synthesize(text, (lang === 'en' && cfg.voiceEn ? cfg.voiceEn : cfg.voice)[profile], cfg.elevenKey, signal, fetch, undefined, prev),
    drawSketch,
    voice: cfg.voice,
    ...(cfg.voiceEn ? { voiceEn: cfg.voiceEn } : {}),
    logger: true,
    familyPin: cfg.familyPin,
    pinSecret: cfg.pinSecret,
    trustProxy: cfg.trustProxy,
    listen: {
      openStt: (lang) => new ScribeSession({ apiKey: cfg.elevenKey, ...(lang ? { lang } : {}) }),
      classify: (input, signal) => classifyUtterance(input, ask, undefined, signal),
    },
    // LOG_TEXT=0: 수업 줄의 질문·듣기 줄의 들은 말 원문을 빼고 글자 수만(기본은 app.ts 기본 로거 — 원문을 남긴다).
    ...(cfg.logText
      ? {}
      : {
          logLesson: (entry: LessonLog) => app?.log.info({ lesson: lessonLogWithoutText(entry) }, 'lesson'),
          logListen: (entry: ListenLog) => app?.log.info({ listen: listenLogWithoutText(entry) }, 'listen'),
        }),
  });
  // 기동은 막지 않는 설정 경고(예: 알 수 없는 TRUST_PROXY 값 → 꺼짐).
  for (const w of cfg.warnings ?? []) app.log.warn(w);
  if (!cfg.familyPin) {
    app.log.warn('FAMILY_PIN이 비어 있어 가족 비밀번호 검사를 끕니다. 이 컴퓨터 밖(ngrok 등)에 열 거면 .env에 FAMILY_PIN을 정하세요');
  }
  // 기본은 이 컴퓨터에서만. 태블릿 등 다른 기기에서 쓰려면 HOST=0.0.0.0(FAMILY_PIN 필요)
  await app.listen({ port: cfg.port, host: cfg.host });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

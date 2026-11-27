import { defineConfig, devices } from '@playwright/test';

// 다른 체크아웃의 개발 서버(5173)를 잘못 재사용하지 않도록 PW_PORT로 포트를 바꿀 수 있다.
const port = Number(process.env.PW_PORT || 5173);
// 시험용 PIN 서버(tests/e2e/pinServer.ts). 진짜 .env와 상관없이 TEST_PIN으로 뜬다. vite가 /api를 여기로 넘긴다.
const apiPort = Number(process.env.PW_API_PORT || port + 1000);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 40_000,
  fullyParallel: true,
  reporter: 'list',
  // 화면 언어는 브라우저 언어를 따른다(i18n.ts): 기존 시험은 한국어 화면을 본다.
  use: { baseURL: `http://localhost:${port}`, locale: 'ko-KR' },
  webServer: [
    {
      command: `npx tsx tests/e2e/pinServer.ts ${apiPort}`,
      url: `http://127.0.0.1:${apiPort}/api/pin`, // 401도 "떴다"로 본다
      reuseExistingServer: false, // 잠금 기록 없이 매번 새로
    },
    {
      command: `npx vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: true, // 재사용한 vite가 다른 API로 가면 tests/e2e/pin.ts가 PIN을 보내기 전에 멈춘다
      env: { PORT: String(apiPort), PW_PORT: String(port) },
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});

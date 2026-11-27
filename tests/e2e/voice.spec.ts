// 음성 입력 화면 — chromium 전용(가짜 마이크 장치 플래그). /api/listen은 page.routeWebSocket으로 흉내 낸다.
import { expect, test } from '@playwright/test';
import { mockApi, mockListen, recordStreams, speechLikeWav } from './voiceMocks';
import { gotoUnlocked } from './pin';

test.skip(({ browserName }) => browserName !== 'chromium', '가짜 마이크 장치는 chromium만');

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${speechLikeWav()}`, // 게이트가 열리는 말소리
    ],
  },
  permissions: ['microphone'],
});

test.describe('마이크 있음', () => {
  test('말로 질문 → 수업 시작', async ({ page }) => {
    const api = await mockApi(page);
    const listen = await mockListen(page, 'accept');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 });
    expect(api.lessons[0]).toEqual({ question: '달은 왜 따라와?', profile: 'kid', mode: 'quick', level: 'elementary', heard: '달은 왜 따라와?' }); // 말로 물음: 받아 적은 말도 보낸다
    expect(listen.urls[0]).toMatch(/\/api\/listen\?profile=kid$/);
  });

  test('마이크 고르기 창에 장치가 1개 이상', async ({ page }) => {
    await mockApi(page);
    await mockListen(page, 'reject');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '마이크 고르기' }).click();
    const picker = page.getByRole('dialog', { name: '마이크 고르기' });
    await expect(picker).toBeVisible();
    await expect(picker.getByText('마이크 고르기')).toBeVisible();
    expect(await picker.getByRole('radio').count()).toBeGreaterThanOrEqual(1);
    await expect(picker.getByRole('radio', { checked: true })).toHaveCount(1);
    await expect(picker.locator('.mic-meter')).toBeVisible();
    // 바깥을 누르면 닫힌다
    await page.locator('.board').click();
    await expect(picker).toBeHidden();
  });

  test('마이크 고르기 창 키보드: 열면 고른 장치에 초점, Esc로 닫고 ▾로 초점', async ({ page }) => {
    await mockApi(page);
    await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    const more = page.getByRole('button', { name: '마이크 고르기' });
    await more.focus();
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: '마이크 고르기' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('radio', { checked: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  test('장치가 끊기면 연결이 안 돼 → 저절로 다시 연다, 5초 안에 또 끊기면 누를 때까지 둔다', async ({ page }) => {
    await recordStreams(page);
    await mockApi(page);
    await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    const streams = () => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length);
    const endLast = () =>
      page.evaluate(() => {
        const list = (window as unknown as { __streams: MediaStream[] }).__streams;
        list[list.length - 1].getAudioTracks()[0].dispatchEvent(new Event('ended'));
      });
    await endLast();
    await expect.poll(streams).toBe(2); // 저절로 다시 열었다
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await endLast(); // 5초 안에 또 끊김
    await expect(page.getByRole('button', { name: '마이크 연결 안 됨' })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(await streams()).toBe(2); // 이번엔 저절로 안 연다
    await page.getByRole('button', { name: '마이크 연결 안 됨' }).click();
    await expect.poll(streams).toBe(3);
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
  });

  test('프로필을 바꾸면 그 프로필로 다시 연결', async ({ page }) => {
    await mockApi(page);
    const listen = await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /프로필 바꾸기/ }).click();
    await listen.closed; // 프로필 화면에서는 듣지 않는다
    await page.getByRole('button', { name: '🙂 어른' }).click();
    await expect.poll(() => listen.sockets.length, { timeout: 15000 }).toBe(2);
    expect(listen.urls[1]).toMatch(/\/api\/listen\?profile=adult$/);
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
  });

  test('듣기 연결이 끊긴 채 알약을 누르면 끄지 않고 바로 다시 연결', async ({ page }) => {
    await mockApi(page);
    let n = 0;
    await page.routeWebSocket('**/api/listen**', (ws) => {
      n++;
      if (n === 1) ws.close({ code: 1008, reason: 'policy' }); // 다시 해도 소용없다고 멈추는 끊김
      else ws.send(JSON.stringify({ type: 'ready' }));
    });
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await page.getByRole('button', { name: '마이크 연결 안 됨' }).click({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    expect(n).toBe(2);
  });

  test('수업 중 장치를 바꾸면 예전 트랙이 멈추고 새 장치로 듣는다', async ({ page }) => {
    await recordStreams(page);
    await mockApi(page);
    await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
    await page.getByRole('button', { name: '물어보기' }).click();
    await expect(page.locator('.subtitle')).toHaveText(/달은/, { timeout: 10000 }); // 수업 중
    await page.getByRole('button', { name: '마이크 고르기' }).click();
    const other = page.getByRole('dialog', { name: '마이크 고르기' }).getByRole('radio', { checked: false }).first();
    const id = await other.getAttribute('value');
    await other.check();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('teacherboard.mic'))).toBe(id);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length)).toBe(2);
    const tracks = await page.evaluate(() =>
      (window as unknown as { __streams: MediaStream[] }).__streams.map((s) => s.getTracks().map((t) => t.readyState)));
    expect(tracks[0].every((r) => r === 'ended')).toBe(true);
    expect(tracks[1].every((r) => r === 'live')).toBe(true);
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 }); // 수업은 계속
  });

  test('수업 중 말로 끼어들면 앞 수업 문맥과 함께 새 수업', async ({ page }) => {
    const api = await mockApi(page);
    const listen = await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
    await page.getByRole('button', { name: '물어보기' }).click();
    await expect(page.locator('.subtitle')).toHaveText(/나무|멀리|칸이야|움직이/, { timeout: 10000 }); // 두 번째 문장 이후 아무 문장(짧은 문장은 순식간에 지나감)
    listen.sockets[0].send(JSON.stringify({ type: 'utterance', text: '해는?', accept: true, question: '해는 왜 안 따라와?' }));
    await expect.poll(() => api.lessons.length).toBe(2);
    const body = api.lessons[1] as { question: string; profile: string; context: { previousQuestion: string; spoken: string[] } };
    expect(body.question).toBe('해는 왜 안 따라와?');
    expect(body.context.previousQuestion).toBe('달은 왜 나를 따라와?');
    expect(body.context.spoken.length).toBeGreaterThanOrEqual(2);
    expect(body.context.spoken[0]).toContain('오늘의 질문');
  });

  test('말하는 동안 들은 말 말풍선에 부분 인식 글자', async ({ page }) => {
    await mockApi(page);
    const listen = await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    // 가짜 장치의 삐 소리로 게이트가 열리면 소리(바이너리)가 온다
    await expect.poll(() => listen.binary, { timeout: 15000 }).toBeGreaterThan(0);
    // 소리만으로는(글자가 아직 없음) 말풍선을 열지 않는다 — 잡음마다 뜨지 않게
    await page.waitForTimeout(300);
    await expect(page.locator('.heard')).toBeHidden();
    listen.sockets[0].send(JSON.stringify({ type: 'partial', text: '달은 왜' }));
    await expect(page.locator('.heard')).toHaveText('👂 달은 왜'); // 말소리가 이어졌고 글자가 나왔다 → 진짜 말
    await expect.poll(() => listen.ends, { timeout: 5000 }).toBe(1); // 말이 끝났다
    listen.sockets[0].send(JSON.stringify({ type: 'utterance', text: '달은 왜', accept: false, question: '' }));
    await expect(page.locator('.heard')).toBeHidden({ timeout: 1000 }); // 판정이 오면 바로 닫힌다
  });

  test('받아들인 말은 고쳐 알아들은 질문을 말풍선에 잠깐 보여 주고, 받아 적은 말은 수업 요청에 함께', async ({ page }) => {
    const api = await mockApi(page);
    const listen = await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect.poll(() => listen.ends, { timeout: 15000 }).toBe(1);
    listen.sockets[0].send(JSON.stringify({ type: 'utterance', text: '퀄리디스크가 뭐야', accept: true, question: '허리디스크가 뭐야?' }));
    await expect(page.locator('.heard')).toHaveText('👂 허리디스크가 뭐야?');
    await expect.poll(() => api.lessons.length).toBe(1);
    expect(api.lessons[0]).toEqual({ question: '허리디스크가 뭐야?', profile: 'kid', mode: 'quick', level: 'elementary', heard: '퀄리디스크가 뭐야' });
    await expect(page.locator('.heard')).toBeHidden({ timeout: 4000 });
  });

  test('거절 판정이면 수업이 시작되지 않음', async ({ page }) => {
    const api = await mockApi(page);
    const listen = await mockListen(page, 'reject');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await listen.judged;
    await expect(page.locator('.heard')).toBeHidden({ timeout: 1000 });
    await page.waitForTimeout(1000);
    expect(api.lessons).toHaveLength(0);
    await expect(page.locator('.subtitle')).toHaveText('');
  });

  test('듣는 중: 아이콘 + 짧은 말 + 소리 크기에 따라 움직이는 막대(C5), 선택됨 색', async ({ page }) => {
    await mockApi(page);
    await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    const pill = page.getByRole('button', { name: '마이크 듣는 중' });
    await expect(pill).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.mic-label')).toHaveText('듣는 중');
    await expect(page.locator('.mic-pill .mic-icon')).toBeVisible();
    await expect(page.locator('.mic-bars')).toBeVisible();
    // 가짜 마이크는 1초 조용함 → 1.2초 말소리를 되풀이한다: 4초 동안 가운데 막대 높이가 여러 값으로 바뀐다
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(await page.locator('.mic-bars i').nth(1).evaluate((e) => (e as HTMLElement).style.transform));
      await page.waitForTimeout(100);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    const sel = await page.evaluate(() => {
      const p = document.createElement('i');
      p.style.color = 'var(--c-selected)';
      document.body.append(p);
      return getComputedStyle(p).color;
    });
    await expect.poll(() => page.locator('.mic-pill').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(sel);
    // 끄면 막대는 숨는다
    await pill.click();
    await expect(page.getByRole('button', { name: '마이크 꺼짐' })).toBeVisible();
    await expect(page.locator('.mic-bars')).toBeHidden();
  });

  test('마이크 끄기 → 마이크 꺼짐', async ({ page }) => {
    await mockApi(page);
    const listen = await mockListen(page, 'reject');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await page.getByRole('button', { name: '듣는 중' }).click();
    await expect(page.getByRole('button', { name: '마이크 꺼짐' })).toBeVisible();
    await listen.closed; // 끄면 듣기 연결도 닫는다
    await page.getByRole('button', { name: '마이크 꺼짐' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => listen.sockets.length).toBe(2); // 켜면 다시 연결
  });

  test('듣기 연결이 끊기면 마이크 연결 안 됨', async ({ page }) => {
    await mockApi(page);
    await page.routeWebSocket('**/api/listen**', (ws) => ws.close({ code: 1011, reason: 'stt' }));
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '마이크 연결 안 됨' })).toBeVisible();
    // 글자 질문은 그대로 된다
    await page.getByRole('textbox').fill('달은 왜 나를 따라와?');
    await page.getByRole('button', { name: '물어보기' }).click();
    await expect(page.locator('.subtitle')).toHaveText('또 궁금한 거 있어?', { timeout: 20000 });
  });

  test('기억이 풀린 뒤 듣기 연결이 끊기면(업그레이드 거절) PIN 화면으로', async ({ page, context }) => {
    await mockApi(page);
    const listen = await mockListen(page, 'manual');
    await gotoUnlocked(page);
    await page.getByRole('button', { name: '🧒 아이' }).click();
    await expect(page.getByRole('button', { name: '듣는 중' })).toBeVisible({ timeout: 15000 });
    await context.clearCookies(); // 서버 쪽에서 보면 PIN을 바꿨거나 쿠키가 무효가 된 것과 같다
    listen.sockets[0].close({ code: 1011, reason: 'gone' });
    await expect(page.getByText('가족 비밀번호를 눌러 줘')).toBeVisible({ timeout: 10000 });
  });
});

test('?fps=1이면 FPS 표시', async ({ page }) => {
  await gotoUnlocked(page, '/?fps=1');
  await expect(page.locator('.fps-meter')).toHaveText(/\d+ fps/, { timeout: 5000 });
});

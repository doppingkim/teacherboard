import { loadConfig, requireEnv } from '../../src/server/config';

const full = {
  GEMINI_API_KEY: 'gm-test',
  ELEVENLABS_API_KEY: 'el-test',
  ELEVENLABS_VOICE_KID: 'voice-kid',
  ELEVENLABS_VOICE_ADULT: 'voice-adult',
  PORT: '9000',
};

test('환경 변수를 Config로 읽는다', () => {
  expect(loadConfig(full)).toEqual({
    geminiKey: 'gm-test',
    elevenKey: 'el-test',
    voice: { kid: 'voice-kid', adult: 'voice-adult' },
    port: 9000,
    familyPin: '',
    trustProxy: false,
    host: '127.0.0.1',
    logText: true,
  });
});
test('PORT가 없으면 8787', () => {
  const { PORT: _p, ...rest } = full;
  expect(loadConfig(rest).port).toBe(8787);
});
test('필수값이 없으면 없는 변수 이름을 모두 알려 준다', () => {
  const env = { ...full, GEMINI_API_KEY: '', ELEVENLABS_VOICE_KID: undefined };
  expect(() => loadConfig(env)).toThrow(/GEMINI_API_KEY.*ELEVENLABS_VOICE_KID/);
});
test('PORT가 숫자가 아니면 에러', () => {
  expect(() => loadConfig({ ...full, PORT: 'abc' })).toThrow(/PORT/);
});

test('requireEnv: 필요한 변수만 검사하고 값을 trim해 돌려준다', () => {
  expect(requireEnv(['ELEVENLABS_API_KEY'], { ELEVENLABS_API_KEY: ' el-test ' })).toEqual({ ELEVENLABS_API_KEY: 'el-test' });
  expect(requireEnv(['GEMINI_API_KEY'], { GEMINI_API_KEY: 'gm-test' })).toEqual({ GEMINI_API_KEY: 'gm-test' });
});
test('requireEnv: 목소리 ID가 없어도 ELEVENLABS_API_KEY만으로 통과한다(목소리 고르기 전)', () => {
  expect(() => requireEnv(['ELEVENLABS_API_KEY'], { ELEVENLABS_API_KEY: 'el' })).not.toThrow();
});
test('requireEnv: 요청한 것 중 빠진 변수 이름만 모두 알려 준다', () => {
  let msg = '';
  try {
    requireEnv(['GEMINI_API_KEY', 'ELEVENLABS_API_KEY'], { ELEVENLABS_VOICE_KID: 'v', GEMINI_API_KEY: '  ' });
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(/GEMINI_API_KEY, ELEVENLABS_API_KEY/);
  expect(msg).not.toContain('VOICE');
});
test('loadConfig는 여전히 네 변수를 모두 요구한다', () => {
  expect(() => loadConfig({ GEMINI_API_KEY: 'sk' })).toThrow(/ELEVENLABS_API_KEY, ELEVENLABS_VOICE_KID, ELEVENLABS_VOICE_ADULT/);
});

describe('가족 비밀번호(FAMILY_PIN)', () => {
  test('FAMILY_PIN·PIN_SECRET을 trim해 읽는다', () => {
    const secret = 'k'.repeat(32);
    const cfg = loadConfig({ ...full, FAMILY_PIN: ' 482915 ', PIN_SECRET: ` ${secret} ` });
    expect(cfg.familyPin).toBe('482915');
    expect(cfg.pinSecret).toBe(secret);
  });
  test('비어 있으면 빈 문자열(관문 끔), PIN_SECRET은 없음', () => {
    const cfg = loadConfig({ ...full, FAMILY_PIN: '  ', PIN_SECRET: '' });
    expect(cfg.familyPin).toBe('');
    expect(cfg.pinSecret).toBeUndefined();
  });
  test.each(['12345', '1234567', 'abcdef', '12-456'])('숫자 6자리가 아니면(%s) 시작을 거부하고 값은 알리지 않는다', (pin) => {
    let msg = '';
    try {
      loadConfig({ ...full, FAMILY_PIN: pin });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/FAMILY_PIN.*6자리/);
    expect(msg).not.toContain(pin);
  });
  test('ALLOWED_HOSTS가 있는데 FAMILY_PIN이 비면 시작을 거부한다', () => {
    expect(() => loadConfig({ ...full, ALLOWED_HOSTS: 'fam.ngrok-free.app' })).toThrow(/ALLOWED_HOSTS.*FAMILY_PIN/);
    expect(() => loadConfig({ ...full, ALLOWED_HOSTS: 'fam.ngrok-free.app', FAMILY_PIN: ' ' })).toThrow(/FAMILY_PIN/);
  });
  test('ALLOWED_HOSTS가 비어 있으면(공백뿐) PIN 없이도 시작한다', () => {
    expect(loadConfig({ ...full, ALLOWED_HOSTS: '  ' }).familyPin).toBe('');
  });
  test('ALLOWED_HOSTS + FAMILY_PIN이면 시작한다', () => {
    expect(loadConfig({ ...full, ALLOWED_HOSTS: 'fam.ngrok-free.app', FAMILY_PIN: '482915' }).familyPin).toBe('482915');
  });
});

test.each([
  ['1', true],
  [' 1 ', true],
  ['true', true],
  ['TRUE', true],
  ['yes', true],
  [' on ', true],
  ['\t1\n', true],
  ['Yes', true],
  ['', false],
  ['   ', false],
  ['0', false],
  ['false', false],
  ['no', false],
  ['off', false],
  [undefined, false],
])('TRUST_PROXY=%s → trustProxy %s, 경고 없음', (v, want) => {
  const cfg = loadConfig({ ...full, FAMILY_PIN: '482915', TRUST_PROXY: v });
  expect(cfg.trustProxy).toBe(want);
  expect(cfg).not.toHaveProperty('warnings');
});

test.each(['2', 'enable', 'ture', 'tru e', '１'])('TRUST_PROXY=%s(알 수 없는 값) → 꺼짐 + 기동 경고(기동은 막지 않는다)', (v) => {
  const cfg = loadConfig({ ...full, FAMILY_PIN: '482915', TRUST_PROXY: v });
  expect(cfg.trustProxy).toBe(false);
  expect(cfg.warnings).toEqual([expect.stringMatching(new RegExp(`TRUST_PROXY.*꺼짐.*"${v}"`))]);
});

describe('LOG_TEXT: 수업 줄의 질문·듣기 줄의 들은 말 원문을 로그에 남길지(기본 켜짐)', () => {
  test.each([
    [undefined, true],
    ['', true],
    ['  ', true],
    ['1', true],
    ['on', true],
    ['0', false],
    [' off ', false],
    ['false', false],
    ['no', false],
  ])('LOG_TEXT=%s → logText %s, 경고 없음', (v, want) => {
    const cfg = loadConfig({ ...full, LOG_TEXT: v });
    expect(cfg.logText).toBe(want);
    expect(cfg).not.toHaveProperty('warnings');
  });
  test('알 수 없는 값이면 기본(켜짐) 그대로 + 기동 경고', () => {
    const cfg = loadConfig({ ...full, LOG_TEXT: 'nope' });
    expect(cfg.logText).toBe(true);
    expect(cfg.warnings).toEqual([expect.stringMatching(/LOG_TEXT.*켜짐.*"nope"/)]);
  });
});

test('TRUST_PROXY=true인데 FAMILY_PIN이 없으면 1과 똑같이 시작을 거부한다', () => {
  expect(() => loadConfig({ ...full, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY.*FAMILY_PIN/);
});

describe('밖에 여는 설정인데 PIN이 없으면 시작을 거부한다', () => {
  test('TRUST_PROXY=1', () => {
    expect(() => loadConfig({ ...full, TRUST_PROXY: '1' })).toThrow(/TRUST_PROXY.*FAMILY_PIN/);
    expect(loadConfig({ ...full, TRUST_PROXY: '1', FAMILY_PIN: '482915' }).trustProxy).toBe(true);
  });
  test.each(['0.0.0.0', '::', '192.168.0.5', 'mypc.lan'])('HOST=%s(loopback 아님)', (host) => {
    expect(() => loadConfig({ ...full, HOST: host })).toThrow(/HOST.*FAMILY_PIN/);
    expect(loadConfig({ ...full, HOST: host, FAMILY_PIN: '482915' }).host).toBe(host);
  });
  test.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1', ' 127.0.0.1 ', ''])('HOST=%j(loopback)이면 PIN 없이도 시작', (host) => {
    expect(loadConfig({ ...full, HOST: host }).familyPin).toBe('');
  });
  test('HOST가 없으면 127.0.0.1', () => {
    expect(loadConfig(full).host).toBe('127.0.0.1');
  });
});

test('PIN_SECRET이 32자보다 짧으면 시작을 거부하고 값은 알리지 않는다', () => {
  const short = 'short-secret-123';
  let msg = '';
  try {
    loadConfig({ ...full, FAMILY_PIN: '482915', PIN_SECRET: short });
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(/PIN_SECRET.*32/);
  expect(msg).not.toContain(short);
  expect(loadConfig({ ...full, FAMILY_PIN: '482915', PIN_SECRET: 'x'.repeat(32) }).pinSecret).toBe('x'.repeat(32));
});

test.each(['1e3', '0x50', '80.0', '+80', '8787 9000', '0', '65536', '-1'])('PORT=%s처럼 10진 정수 1~65535가 아니면 시작을 거부한다(엉뚱한 포트로 뜨지 않게)', (port) => {
  expect(() => loadConfig({ ...full, PORT: port })).toThrow(/PORT/);
});
test.each([['  9001 ', 9001], ['65535', 65535], ['1', 1]])('PORT=%j → %d', (port, want) => {
  expect(loadConfig({ ...full, PORT: port }).port).toBe(want);
});
test('오류 문구에 키 값이 실리지 않는다', () => {
  let msg = '';
  try { loadConfig({ ...full, PORT: 'x', FAMILY_PIN: '12' }); } catch (e) { msg = String(e); }
  try { loadConfig({ ...full, FAMILY_PIN: '12' }); } catch (e) { msg += String(e); }
  expect(msg).not.toMatch(/gm-test|el-test|voice-kid/);
  expect(msg).not.toContain('FAMILY_PIN=12');
});

import { INKS, createParseState, parseFigure, parseScriptLine } from '../../src/shared/script';

const s = createParseState;
test('say는 1부터 번호가 붙는다', () => {
  const st = s();
  expect(parseScriptLine('{"say":"안녕"}', st)).toEqual({ t: 'say', id: 1, text: '안녕' });
  expect(parseScriptLine('{"say":"또"}', st)).toMatchObject({ id: 2 });
});
test('draw는 직전 say에 묶이고 at을 유지한다', () => {
  const st = s(); parseScriptLine('{"say":"달을 봐"}', st);
  const e = parseScriptLine('{"draw":{"kind":"figure","size":"small","ink":"blue","strokes":["M10 10 L90 90"]},"at":"달"}', st);
  expect(e).toMatchObject({ t: 'draw', sayId: 1, at: '달', op: { kind: 'figure' } });
});
test('say 전에 온 draw는 sayId 0', () => {
  expect(parseScriptLine('{"draw":{"kind":"text","role":"title","text":"제목","ink":"black"}}', s())).toMatchObject({ sayId: 0 });
});
test('page', () => expect(parseScriptLine('{"page":true}', s())).toEqual({ t: 'page' }));
test.each([
  ['깨진 JSON', '{"say":"안'],
  ['빈 줄', '   '],
  ['코드펜스', '```json'],
  ['모르는 kind', '{"draw":{"kind":"video","ink":"black"}}'],
  ['경로에 허용 안 된 문자', '{"draw":{"kind":"figure","size":"small","ink":"black","strokes":["javascript:alert(1)"]}}'],
  ['범위 밖 좌표', '{"draw":{"kind":"figure","size":"small","ink":"black","strokes":["M10 10 L500 20"]}}'],
  ['빈 say', '{"say":""}'],
  ['공백뿐인 say', '{"say":"   "}'],
  ['줄바꿈·탭뿐인 say', JSON.stringify({ say: '\n\t ' })],
  ['공백뿐인 text', '{"draw":{"kind":"text","role":"title","text":"  ","ink":"black"}}'],
])('%s → null', (_n, line) => expect(parseScriptLine(line, s())).toBeNull());
test('잘못된 줄은 say 번호를 소모하지 않는다', () => {
  const st = s(); parseScriptLine('{"say":', st);
  expect(parseScriptLine('{"say":"첫"}', st)).toMatchObject({ id: 1 });
});
test('공백뿐인 say는 say 번호를 소모하지 않는다', () => {
  const st = s(); parseScriptLine('{"say":"  "}', st);
  expect(parseScriptLine('{"say":"첫"}', st)).toMatchObject({ id: 1 });
});
test('앞뒤 공백이 있어도 내용이 있으면 통과', () => {
  expect(parseScriptLine('{"say":" 안녕 "}', s())).toMatchObject({ t: 'say', text: ' 안녕 ' });
  expect(parseScriptLine('{"draw":{"kind":"text","role":"note","text":" 끝 ","ink":"black"}}', s())).toMatchObject({ t: 'draw' });
});

test('새 색 13개 모두 허용', () => { for (const ink of INKS) expect(parseScriptLine(`{"draw":{"kind":"text","role":"note","text":"x","ink":"${ink}"}}`, s())).not.toBeNull(); });
test('INKS는 정확히 13색', () => expect([...INKS]).toEqual(['black', 'blue', 'red', 'green', 'orange', 'gold', 'purple', 'pink', 'brown', 'sky', 'navy', 'gray', 'lime']));
test('모르는 색은 검정으로', () => expect(parseScriptLine('{"draw":{"kind":"text","role":"note","text":"x","ink":"teal"}}', s())).toMatchObject({ op: { ink: 'black' } }));
test('색이 없어도 검정으로', () => expect(parseScriptLine('{"draw":{"kind":"connect","from":"a","to":"b"}}', s())).toMatchObject({ op: { kind: 'connect', ink: 'black' } }));
test('획별 색·채우기', () => expect(parseFigure({ kind:'figure', size:'small', ink:'black', strokes:['M0 0 L10 10', { d:'M10 10 L20 20 Z', ink:'red', fill:true }] })).toMatchObject({ strokes: [ 'M0 0 L10 10', { d:'M10 10 L20 20 Z', ink:'red', fill:true } ] }));
test('arrow: true는 남기고, false·채우기 획의 arrow는 버린다, 불리언 아니면 거부', () => {
  const f = parseFigure({ kind:'figure', size:'small', ink:'black', strokes:[{ d:'M0 0 L10 0', arrow:true }, { d:'M0 5 L10 5', arrow:false }, { d:'M0 0 L9 9 Z', fill:true, arrow:true }] });
  expect(f!.strokes).toEqual([{ d:'M0 0 L10 0', arrow:true }, { d:'M0 5 L10 5' }, { d:'M0 0 L9 9 Z', fill:true }]);
  expect(parseFigure({ kind:'figure', size:'small', ink:'black', strokes:[{ d:'M0 0 L10 0', arrow:'yes' }] })).toBeNull();
});
test('획 61개는 거부', () => expect(parseFigure({ kind:'figure', size:'small', ink:'black', strokes: Array(61).fill('M0 0 L1 1') })).toBeNull());
test('획 60개는 허용', () => expect(parseFigure({ kind:'figure', size:'small', ink:'black', strokes: Array(60).fill('M0 0 L1 1') })).not.toBeNull());
test.each([
  ['객체 획 경로에 허용 안 된 문자', { d: 'javascript:alert(1)' }],
  ['객체 획 범위 밖 좌표', { d: 'M0 0 L200 0' }],
  ['객체 획 d 없음', { ink: 'red' }],
  ['fill이 불리언 아님', { d: 'M0 0 L1 1', fill: 'yes' }],
  ['획이 숫자', 42],
])('%s → 그림 거부', (_n, stroke) => expect(parseFigure({ kind:'figure', size:'small', ink:'black', strokes: [stroke] })).toBeNull());
test('획의 모르는 색은 검정, 모르는 필드는 버린다', () => {
  const f = parseFigure({ kind:'figure', size:'small', ink:'blue', strokes:[{ d:'M0 0 L1 1', ink:'teal', onclick:'x' }], extra: 1 });
  expect(f?.strokes).toEqual([{ d:'M0 0 L1 1', ink:'black' }]);
  expect(f).not.toHaveProperty('extra');
});
test('parseFigure: figure가 아니면 null', () => expect(parseFigure({ kind:'text', role:'note', text:'x', ink:'black' })).toBeNull());
test('text에 id', () => expect(parseScriptLine('{"draw":{"kind":"text","id":"t1","role":"title","text":"제목","ink":"navy"}}', s())).toMatchObject({ op: { kind:'text', id:'t1', ink:'navy' } }));
test('mark: word 선택', () => expect(parseScriptLine('{"draw":{"kind":"mark","target":"t1","word":"멸종","style":"pigtail","ink":"red"}}', s())).toMatchObject({ op: { kind:'mark', style:'pigtail', word:'멸종' } }));
test('mark: 9가지 모양 모두', () => { for (const st of ['underline','double','wavy','circle','box','star','pigtail','check','exclaim']) expect(parseScriptLine(`{"draw":{"kind":"mark","target":"t1","style":"${st}","ink":"red"}}`, s())).not.toBeNull(); });
test.each([
  ['mark 모르는 모양', '{"draw":{"kind":"mark","target":"t1","style":"zigzag","ink":"red"}}'],
  ['mark target 없음', '{"draw":{"kind":"mark","style":"circle","ink":"red"}}'],
  ['mark word 너무 김', JSON.stringify({ draw: { kind: 'mark', target: 't1', word: 'x'.repeat(61), style: 'circle', ink: 'red' } })],
])('%s → null', (_n, line) => expect(parseScriptLine(line, s())).toBeNull());
test('예전 highlight는 mark로', () => expect(parseScriptLine('{"draw":{"kind":"highlight","target":"달","style":"circle","ink":"blue"}}', s())).toMatchObject({ op: { kind:'mark', target:'달', style:'circle' } }));
test('주문 → 보여 주기 size 채움', () => { const st = s(); expect(parseScriptLine('{"sketch":{"id":"병사","size":"wide","describe":"투구 쓴 병사"}}', st)).toEqual({ t:'sketch', order:{ id:'병사', size:'wide', describe:'투구 쓴 병사' } }); expect(parseScriptLine('{"draw":{"kind":"sketch","id":"병사"}}', st)).toMatchObject({ op:{ kind:'sketch', id:'병사', size:'wide' } }); });
test('보여 주기는 at과 직전 say를 유지', () => {
  const st = s(); parseScriptLine('{"sketch":{"id":"병사","size":"small","describe":"병사"}}', st); parseScriptLine('{"say":"병사가 있었어"}', st);
  expect(parseScriptLine('{"draw":{"kind":"sketch","id":"병사"},"at":"병사"}', st)).toEqual({ t:'draw', sayId: 1, at:'병사', op:{ kind:'sketch', id:'병사', size:'small' } });
});
test('주문 없는 보여 주기는 null', () => expect(parseScriptLine('{"draw":{"kind":"sketch","id":"없음"}}', s())).toBeNull());
test('주문 6번째부터 null', () => { const st = s(); for (let i = 0; i < 5; i++) expect(parseScriptLine(`{"sketch":{"id":"a${i}","size":"small","describe":"x"}}`, st)).not.toBeNull(); expect(parseScriptLine('{"sketch":{"id":"a5","size":"small","describe":"x"}}', st)).toBeNull(); });
test('거부된 주문은 보여 줄 수 없다', () => {
  const st = s(); for (let i = 0; i < 6; i++) parseScriptLine(`{"sketch":{"id":"a${i}","size":"small","describe":"x"}}`, st);
  expect(parseScriptLine('{"draw":{"kind":"sketch","id":"a5"}}', st)).toBeNull();
});
test.each([
  ['describe 빈 값', '{"sketch":{"id":"a","size":"small","describe":""}}'],
  ['describe 공백뿐', '{"sketch":{"id":"a","size":"small","describe":"   "}}'],
  ['describe 151자', JSON.stringify({ sketch: { id: 'a', size: 'small', describe: 'x'.repeat(151) } })],
  ['size 모름', '{"sketch":{"id":"a","size":"huge","describe":"x"}}'],
  ['id 없음', '{"sketch":{"size":"small","describe":"x"}}'],
  ['id 61자', JSON.stringify({ sketch: { id: 'x'.repeat(61), size: 'small', describe: 'x' } })],
])('주문 %s → null', (_n, line) => expect(parseScriptLine(line, s())).toBeNull());
test('describe 150자는 허용', () => expect(parseScriptLine(JSON.stringify({ sketch: { id: 'a', size: 'small', describe: 'x'.repeat(150) } }), s())).not.toBeNull());
test('같은 id 두 번 주문은 두 번째가 null', () => {
  const st = s();
  expect(parseScriptLine('{"sketch":{"id":"a","size":"small","describe":"x"}}', st)).not.toBeNull();
  expect(parseScriptLine('{"sketch":{"id":"a","size":"wide","describe":"y"}}', st)).toBeNull();
  expect(parseScriptLine('{"draw":{"kind":"sketch","id":"a"}}', st)).toMatchObject({ op: { size: 'small' } });
});

// QA 2026-11-22: 소문자(상대 좌표) 명령은 숫자 하나하나가 범위 안이어도 쌓이면 상자 밖(제목·다른 그림 위)으로 나간다.
describe('상대 좌표(소문자 명령)는 절대 위치로 바꿔 범위를 검사한다', () => {
  const fig = (d: string) => parseFigure({ kind: 'figure', size: 'small', ink: 'black', strokes: [d] });
  test('쌓여서 상자 밖으로 나가면 거부', () => {
    expect(fig('M50 50 l50 0 l50 0')).toBeNull();
    expect(fig('M90 10 c10 0 10 0 20 0')).toBeNull();
    expect(fig('M10 10 m100 0')).toBeNull();
    expect(fig('M10 90 q0 10 0 20')).toBeNull();
  });
  test('안에 머무는 상대 경로는 음수 변화량이어도 허용', () => {
    expect(fig('M50 50 l-30 0 l0 -40 z')).not.toBeNull();
    expect(fig('M10 10 q5 5 10 0 c10 10 20 10 30 0')).not.toBeNull();
    expect(fig('M10 10 L20 20 l5 5 L90 90')).not.toBeNull();
  });
  test('Z 다음 상대 명령은 하위 경로 시작점 기준', () => {
    expect(fig('M90 90 L95 95 Z l10 0')).not.toBeNull(); // 90+10 = 100
    expect(fig('M95 95 L10 10 Z l20 0')).toBeNull(); // 95+20 = 115
  });
  test('절대 좌표 검사는 그대로', () => {
    expect(fig('M0 0 L106 1')).toBeNull();
    expect(fig('M-5 0 L105 1')).not.toBeNull();
  });
});

// QA 2026-11-22: 모델이 JSON 배열처럼 줄 끝에 쉼표를 붙이면(`{...},`) 모든 줄이 버려져 수업이 통째로 실패했다.
test('줄 끝 쉼표·BOM·앞뒤 공백이 있어도 그 줄을 살린다', () => {
  const st = s();
  expect(parseScriptLine('{"say":"하나"},', st)).toEqual({ t: 'say', id: 1, text: '하나' });
  expect(parseScriptLine('﻿{"say":"둘"}', st)).toMatchObject({ id: 2 });
  expect(parseScriptLine('  {"page":true} ,  ', st)).toEqual({ t: 'page' });
  expect(parseScriptLine('[', st)).toBeNull();
  expect(parseScriptLine(']', st)).toBeNull();
  expect(parseScriptLine('{"say":"a"}{"say":"b"}', st)).toBeNull(); // 한 줄에 둘은 여전히 버린다
});

// QA 2026-11-22: 이름표 개수에 한도가 없어 그림 하나에 이름표 수백 개가 올 수 있었다(획은 60개 한도).
test('이름표는 12개까지: 넘으면 그림을 버린다', () => {
  const lb = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: 1, text: `이름${i}` }));
  const fig = (n: number) => parseFigure({ kind: 'figure', size: 'small', ink: 'black', strokes: ['M0 0 L1 1'], labels: lb(n) });
  expect(fig(12)?.labels).toHaveLength(12);
  expect(fig(13)).toBeNull();
});

describe('경계값(QA 2026-11-22)', () => {
  const st = () => s();
  test.each([
    ['say 201자', JSON.stringify({ say: 'x'.repeat(201) })],
    ['say가 숫자', '{"say":5}'],
    ['say가 배열', '{"say":["a"]}'],
    ['모르는 줄 종류', '{"wave":true}'],
    ['page:false', '{"page":false}'],
    ['JSON 배열 줄', '[{"say":"a"}]'],
    ['null 줄', 'null'],
    ['at이 61자', JSON.stringify({ draw: { kind: 'text', role: 'note', text: 'x', ink: 'red' }, at: 'x'.repeat(61) })],
  ])('%s → null', (_n, line) => expect(parseScriptLine(line, st())).toBeNull());
  test('say 200자는 통과', () => expect(parseScriptLine(JSON.stringify({ say: '가'.repeat(200) }), st())).toMatchObject({ t: 'say' }));
  test('이름표 좌표가 Infinity(1e400)·문자열·범위 밖이면 그림을 버린다', () => {
    for (const x of [1e400, -1e400, '10', 106, -6]) {
      expect(parseFigure({ kind: 'figure', size: 'small', ink: 'black', strokes: ['M0 0 L1 1'], labels: [{ x, y: 1, text: 'a' }] })).toBeNull();
    }
  });
  test('경로의 지수 표기·NaN 글자는 허용 글자 검사에서 떨어진다', () => {
    for (const d of ['M1e5 0', 'MNaN 0', 'M0 0 H10', 'M0 0 A1 1 0 0 1 2 2']) {
      expect(parseFigure({ kind: 'figure', size: 'small', ink: 'black', strokes: [d] })).toBeNull();
    }
  });
  test('경로 2000자는 통과, 2001자는 버림', () => {
    const d = (n: number) => 'M1 1' + ' L1 1'.repeat(Math.floor((n - 4) / 5)) + ' '.repeat((n - 4) % 5);
    expect(d(2000)).toHaveLength(2000);
    expect(parseFigure({ kind: 'figure', size: 'small', ink: 'black', strokes: [d(2000)] })).not.toBeNull();
    expect(parseFigure({ kind: 'figure', size: 'small', ink: 'black', strokes: [d(2001)] })).toBeNull();
  });
  test('__proto__ 키가 있어도 전역 객체가 오염되지 않고 모르는 필드는 버린다', () => {
    const e = parseScriptLine('{"draw":{"kind":"text","role":"note","text":"x","ink":"red","__proto__":{"polluted":1},"extra":1}}', st());
    expect(e).toEqual({ t: 'draw', sayId: 0, op: { kind: 'text', role: 'note', text: 'x', ink: 'red' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test('모르는 색은 검정으로(판서를 버리지 않음)', () => {
    expect(parseScriptLine('{"draw":{"kind":"text","role":"note","text":"x","ink":"rainbow"}}', st())).toMatchObject({ op: { ink: 'black' } });
  });
});

// E2(2026-11-23): 수업 끝 "이어 물을 질문" 줄. 모델이 안 보내도 수업은 그대로, 보내면 카드로 보인다.
describe('next(이어 물을 질문) 줄', () => {
  test('질문 2~3개를 받아 다듬어 돌려준다', () => {
    expect(parseScriptLine('{"next":["달은 왜 모양이 바뀌어?"," 해는 왜 뜨거워? "]}', s()))
      .toEqual({ t: 'next', questions: ['달은 왜 모양이 바뀌어?', '해는 왜 뜨거워?'] });
  });
  test('3개까지만, 같은 질문은 한 번만, 잘못된 것은 빼고 남은 것만', () => {
    const e = parseScriptLine(JSON.stringify({ next: ['하나는 뭐야?', '하나는 뭐야?', 7, '', '둘은 뭐야?', '셋은 뭐야?', '넷은 뭐야?'] }), s());
    expect(e).toEqual({ t: 'next', questions: ['하나는 뭐야?', '둘은 뭐야?', '셋은 뭐야?'] });
  });
  test('너무 길거나 짧은 질문, 줄바꿈·마크업·주소가 든 질문은 뺀다', () => {
    const long = '가'.repeat(41);
    const e = parseScriptLine(JSON.stringify({ next: [long, '왜', '줄\n바꿈은 왜?', '<b>굵게</b> 왜?', 'http://x.y 가 뭐야?', '별은 왜 반짝여?'] }), s());
    expect(e).toEqual({ t: 'next', questions: ['별은 왜 반짝여?'] });
    expect(parseScriptLine(JSON.stringify({ next: ['가'.repeat(40)] }), s())).toEqual({ t: 'next', questions: ['가'.repeat(40)] });
  });
  test.each([
    ['배열이 아님', '{"next":"달은 왜?"}'],
    ['빈 배열', '{"next":[]}'],
    ['쓸 만한 질문이 하나도 없음', '{"next":["", 3, null]}'],
    ['배열이 너무 김(폭주)', JSON.stringify({ next: Array.from({ length: 21 }, (_, i) => `질문 ${i}번은 뭐야?`) })],
  ])('%s → null', (_n, line) => expect(parseScriptLine(line, s())).toBeNull());
  test('한 수업에 한 번만(두 번째 next는 버린다), say 번호를 소모하지 않는다', () => {
    const st = s();
    expect(parseScriptLine('{"next":["달은 왜 모양이 바뀌어?"]}', st)).not.toBeNull();
    expect(parseScriptLine('{"next":["해는 왜 뜨거워?"]}', st)).toBeNull();
    expect(parseScriptLine('{"say":"안녕"}', st)).toMatchObject({ id: 1 });
  });
});

// QA 2026-11-23(lesson-flow): 카드에 보일 글이라 줄을 나누거나 방향을 뒤집는 보이지 않는 글자, 보이는 글자가 없는 질문은 받지 않는다.
describe('next: 보이지 않는 글자(QA 2026-11-23)', () => {
  test.each([
    ['줄 구분자(U+2028)', '달은\u2028왜 그래?'],
    ['문단 구분자(U+2029)', '달은\u2029왜 그래?'],
    ['방향 뒤집기(U+202E)', '\u202e달은 왜 그래?'],
    ['방향 고립(U+2066)', '\u2066달은 왜 그래?'],
    ['폭 없는 공백만', '\u200b\u200b\u200b'],
    ['폭 없는 공백 섞임', '달은\u200b왜 그래?'],
  ])('%s → 뺀다', (_n, q) => {
    expect(parseScriptLine(JSON.stringify({ next: [q, '별은 왜 반짝여?'] }), s())).toEqual({ t: 'next', questions: ['별은 왜 반짝여?'] });
  });
});

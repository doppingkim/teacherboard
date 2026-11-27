import { buildSystemPrompt, EXAMPLE_START, EXAMPLE_END } from '../../src/server/prompts';
import { createParseState, parseScriptLine, INKS, type ScriptEvent } from '../../src/shared/script';

test.each(['kid', 'adult'] as const)('%s 프롬프트에 형식 규칙이 들어 있다', p => {
  const t = buildSystemPrompt(p);
  for (const k of ['"say"', '"draw"', '"page"', 'figure', 'connect', '0~100', '0~37']) expect(t).toContain(k);
  expect(t).toContain('첫 줄');
});
test.each(['kid', 'adult'] as const)('%s 프롬프트: 그림 주문·13색·선생님 표시를 가르친다', p => {
  const t = buildSystemPrompt(p);
  for (const k of ['"sketch"', 'describe', '"mark"', 'pigtail', 'gold', 'lime', '기호', '설명 그림', '나란히 비교']) expect(t).toContain(k);
  for (const ink of INKS) expect(t).toContain(ink);
});
test('설명 수준: 기본은 아이 → 초등, 어른 → 성인. 고르면 그 수준, 말투는 프로필 그대로', () => {
  expect(buildSystemPrompt('kid')).toContain('# 설명 수준: 초등학생');
  expect(buildSystemPrompt('adult')).toContain('# 설명 수준: 성인');
  const kidAdultLevel = buildSystemPrompt('kid', 'quick', 'adult');
  expect(kidAdultLevel).toContain('# 설명 수준: 성인');
  expect(kidAdultLevel).toContain('반말');
  expect(kidAdultLevel).not.toContain('# 설명 수준: 초등학생');
  const adultMiddle = buildSystemPrompt('adult', 'deep', 'middle');
  expect(adultMiddle).toContain('# 설명 수준: 중학생');
  expect(adultMiddle).toContain('존댓말');
  expect(buildSystemPrompt('adult', 'quick', 'adult')).toContain('누가 어떻게 알아냈는지');
});
test.each(['kid', 'adult'] as const)('%s 프롬프트: connect는 바로 옆 칸끼리만', p => {
  expect(buildSystemPrompt(p)).toContain('connect는 바로 옆 칸의 그림끼리만 잇는다');
});
test('아이 프롬프트에 안전 안내가 있다', () => expect(buildSystemPrompt('kid')).toContain('엄마 아빠랑 이야기해 보자'));
test('아이 프롬프트: 그림 주문도 무섭지 않게, 전쟁(거북선) 예시는 어른에게만', () => {
  const kid = buildSystemPrompt('kid');
  expect(kid).toContain('그림 주문도 무섭지 않게: 피·다친 모습·쓰러진 모습·무서운 표정 대신 밝고 귀여운 장면으로');
  expect(kid).not.toContain('쇠못');
  expect(buildSystemPrompt('adult')).toContain('쇠못');
});
test.each(['kid', 'adult'] as const)('%s 프롬프트: 범위 밖 좌표·다른 명령은 줄이 통째로 버려진다고 알린다', p => {
  const t = buildSystemPrompt(p);
  expect(t).toContain('-5~105');
  expect(t).toContain('그 줄이 통째로 버려져');
});

// 프롬프트 속 예시 수업들이 파서 규칙과 어긋나지 않는지 지킨다. 예시마다 구분자로 감싼다.
function exampleBlocks(prompt: string): string[][] {
  const blocks: string[][] = [];
  let from = 0;
  for (;;) {
    const start = prompt.indexOf(EXAMPLE_START, from);
    if (start < 0) break;
    const end = prompt.indexOf(EXAMPLE_END, start);
    if (end < 0) throw new Error('예시 끝 구분자를 찾지 못함');
    blocks.push(
      prompt
        .slice(start + EXAMPLE_START.length, end)
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0),
    );
    from = end + EXAMPLE_END.length;
  }
  return blocks;
}

test('아이 프롬프트에는 아이 예시만, 어른 프롬프트에는 두 예시 모두', () => {
  const kid = buildSystemPrompt('kid');
  expect(exampleBlocks(kid)).toHaveLength(1);
  expect(kid).toContain('달은 왜 나를 따라올까?');
  for (const k of ['거북선', '칼로 싸우', '대포']) expect(kid).not.toContain(k);
  expect(exampleBlocks(buildSystemPrompt('adult'))).toHaveLength(2);
});

const cases = (['kid', 'adult'] as const).flatMap(p =>
  exampleBlocks(buildSystemPrompt(p)).map((lines, i) => ({ name: `${p} 예시 ${i + 1}`, lines })),
);

describe.each(cases)('$name', ({ lines }) => {
  const st = createParseState();
  const events = lines.map(l => ({ line: l, ev: parseScriptLine(l, st) }));
  const evs = events.map(e => e.ev as ScriptEvent);

  test('모든 줄이 parseScriptLine을 통과한다', () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(events.filter(e => e.ev === null).map(e => e.line)).toEqual([]);
  });
  test('첫 줄은 say, 바로 뒤에 제목(과 그 표시), 그다음 그림 주문이 모두 오고, 그다음은 say', () => {
    expect(evs[0].t).toBe('say');
    expect(evs[1]).toMatchObject({ t: 'draw', sayId: 1, op: { kind: 'text', role: 'title' } }); // 첫 말과 함께 제목부터
    let i = 2;
    while (evs[i]?.t === 'draw') i++;
    while (evs[i]?.t === 'sketch') i++;
    expect(i - 1).toBeGreaterThanOrEqual(1);
    expect(i - 1).toBeLessThanOrEqual(5);
    expect(evs[i].t).toBe('say');
    expect(evs.slice(i).some(e => e.t === 'sketch')).toBe(false); // 뒤늦은 주문 없음
  });
  test('맨 끝 줄은 이어 물을 질문(next) 2~3개이고, 다른 곳에는 next가 없다(E2)', () => {
    expect(evs.at(-1)).toMatchObject({ t: 'next' });
    const q = (evs.at(-1) as { questions: string[] }).questions;
    expect(q.length).toBeGreaterThanOrEqual(2);
    expect(q.length).toBeLessThanOrEqual(3);
    expect(evs.filter(e => e.t === 'next')).toHaveLength(1);
  });
  test('주문 id는 예시 안에서 겹치지 않는다', () => {
    const ids = lines.flatMap(l => { const o = JSON.parse(l); return o.sketch ? [o.sketch.id] : []; });
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('주문 describe는 구체적 장면이다(짧은 기호 말고)', () => {
    for (const e of evs) if (e.t === 'sketch') expect(e.order.describe.length).toBeGreaterThanOrEqual(15);
  });
  test('보여 주기는 주문한 id만, 주문한 그림은 모두 보여 준다', () => {
    const ordered = evs.flatMap(e => (e.t === 'sketch' ? [e.order.id] : []));
    const shown = evs.flatMap(e => (e.t === 'draw' && e.op.kind === 'sketch' ? [e.op.id] : []));
    expect(shown.length).toBeGreaterThan(0);
    for (const id of shown) expect(ordered).toContain(id);
    expect([...shown].sort()).toEqual([...ordered].sort());
  });
  test('제목이 첫 판서, 정리(note)가 마지막 글씨이고 그 뒤에는 표시만(맨 끝 next 줄 빼고)', () => {
    const draws = evs.filter(e => e.t === 'draw');
    expect(draws[0]).toMatchObject({ op: { kind: 'text', role: 'title' } });
    let j = evs.length - 1;
    if (evs[j].t === 'next') j--;
    while (evs[j].t === 'draw' && (evs[j] as { op: { kind: string } }).op.kind === 'mark') j--;
    expect(evs[j]).toMatchObject({ t: 'draw', op: { kind: 'text', role: 'note' } });
  });
  test('표시(mark)는 1~2개, 앞서 쓴 글씨·그림 id를 가리키고 word는 그 글씨 안에 있다', () => {
    const texts = new Map<string, string>();
    const ids = new Set<string>();
    let marks = 0;
    for (const e of evs) {
      if (e.t !== 'draw') continue;
      const op = e.op;
      if (op.kind === 'text' && op.id) { texts.set(op.id, op.text); ids.add(op.id); }
      if ((op.kind === 'figure' || op.kind === 'sketch') && op.id) ids.add(op.id);
      if (op.kind === 'mark') {
        marks++;
        expect(ids).toContain(op.target);
        if (op.word !== undefined && texts.has(op.target)) expect(texts.get(op.target)).toContain(op.word);
      }
    }
    expect(marks).toBeGreaterThanOrEqual(1);
    expect(marks).toBeLessThanOrEqual(2);
  });
  test('at 단어는 묶인 say 문장 안에 있다', () => {
    const says = new Map<number, string>();
    for (const e of evs) {
      if (e.t === 'say') says.set(e.id, e.text);
      if (e.t === 'draw' && e.at !== undefined) expect(says.get(e.sayId)).toContain(e.at);
    }
  });
  test('그림은 정수 좌표, connect는 앞서 보여 준 그림 id를 가리킨다', () => {
    const ids = new Set<string>();
    for (const e of evs) {
      if (e.t !== 'draw') continue;
      const op = e.op;
      if (op.kind === 'figure') {
        for (const d of op.strokes) expect(typeof d === 'string' ? d : d.d).not.toMatch(/\./);
        if (op.id) ids.add(op.id);
      }
      if (op.kind === 'sketch') ids.add(op.id);
      if (op.kind === 'connect') { expect(ids).toContain(op.from); expect(ids).toContain(op.to); }
    }
  });
  test('connect는 바로 옆 칸 그림끼리만, 페이지 칸 수(작은 그림 3개 또는 넓은 그림 1개)를 지킨다', () => {
    let order: { id?: string; size: 'small' | 'wide' }[] = []; // 지금 페이지의 칸 순서
    let connects = 0;
    for (const e of evs) {
      if (e.t === 'page') order = [];
      if (e.t !== 'draw') continue;
      const op = e.op;
      if (op.kind === 'figure' || op.kind === 'sketch') {
        order.push({ id: op.id, size: op.size });
        const wide = order.filter(c => c.size === 'wide').length;
        const small = order.length - wide;
        expect(wide === 0 ? small <= 3 : wide === 1 && small === 0).toBe(true);
      }
      if (op.kind === 'connect') {
        connects++;
        const ids = order.map(c => c.id);
        expect(Math.abs(ids.indexOf(op.from) - ids.indexOf(op.to))).toBe(1);
      }
    }
    expect(connects).toBeGreaterThan(0);
  });
});

describe('신중한 선생님(deep) 프롬프트: 그림을 주문하지 않고 직접 그린다', () => {
  test.each(['kid', 'adult'] as const)('%s: sketch 주문 줄 안내가 없고, 그리기 규칙·화살표·예시가 들어 있다', p => {
    const t = buildSystemPrompt(p, 'deep');
    expect(t).not.toContain('{"sketch":');
    expect(t).not.toContain('화가에게 그림 주문');
    for (const k of ['그림 직접 그리기', '"arrow": true', '나란히 비교', '0~37', '뼈대만 정해', '좌표는 미리 계산하지 말고', '"kind":"figure"']) expect(t).toContain(k);
    expect(t).toContain(p === 'kid' ? '초등학생' : '성인');
  });
  test('예시 수업은 파서를 모두 통과하고, 그림은 figure로 직접 그린다(주문 없음)', () => {
    const blocks = exampleBlocks(buildSystemPrompt('kid', 'deep'));
    expect(blocks).toHaveLength(1);
    const state = createParseState();
    const evs = blocks[0].map(l => parseScriptLine(l, state));
    expect(evs.filter(e => e === null)).toEqual([]);
    expect(evs.some(e => e!.t === 'sketch')).toBe(false);
    expect(evs.some(e => e!.t === 'draw' && e!.op.kind === 'figure' && e!.op.strokes.some(s => typeof s === 'object' && s.arrow))).toBe(true);
    expect(evs[1]).toMatchObject({ t: 'draw', op: { kind: 'text', role: 'title' } });
  });
});

test.each(['kid', 'adult'] as const)('%s: 알찬 내용 규칙(상투어 금지, 구체적 원리, 의견이 갈리는 질문도 알차게)', p => {
  for (const mode of ['quick', 'deep'] as const) {
    const t = buildSystemPrompt(p, mode);
    for (const k of ['문장마다 새 정보', '쓰지 말 상투어', '두루뭉술', '여러 종교가 말하는 것']) expect(t).toContain(k);
  }
  const deep = buildSystemPrompt(p, 'deep');
  expect(deep).toContain('그림 3~6개');
  expect(deep).toContain('18~26문장');
});

// QA 2026-11-22: 질문·앞 수업 글 속 "지시를 무시해"를 따르지 말라는 규칙, 아이 '직접 해 보기'의 안전 규칙이 없었다.
describe('모든 조합(프로필 × 방식 × 수준)', () => {
  const combos = (['kid', 'adult'] as const).flatMap((p) => (['quick', 'deep'] as const).flatMap((m) => (['elementary', 'middle', 'adult'] as const).map((l) => [p, m, l] as const)));
  test.each(combos)('%s / %s / %s: 말투·수준이 하나씩, 질문 속 지시를 따르지 말라는 규칙', (p, m, l) => {
    const t = buildSystemPrompt(p, m, l);
    expect(t.match(/# 설명 수준:/g)).toHaveLength(1);
    expect(t.match(/# 듣는 사람:/g)).toHaveLength(1);
    expect(t).toContain(p === 'kid' ? '# 듣는 사람: 아이' : '# 듣는 사람: 어른');
    expect(t).toContain('규칙을 바꾸라는 말');
    if (p === 'kid') {
      expect(t).toContain('엄마 아빠랑 이야기해 보자');
      expect(t).toContain('직접 해 보기는 안전한 것만');
    }
    if (m === 'deep') expect(t).not.toContain('{"sketch"');
    else expect(t).toContain('{"sketch"');
  });
});

// E2(2026-11-23): 수업 끝 "이어 물을 질문" 줄을 모든 조합에서 가르친다. 아이는 밝고 안전한 질문만.
describe('이어 물을 질문(next) 줄', () => {
  const combos = (['kid', 'adult'] as const).flatMap((p) => (['quick', 'deep'] as const).map((m) => [p, m] as const));
  test.each(combos)('%s / %s: 형식과 맨 끝 한 줄 규칙이 있다', (p, m) => {
    const t = buildSystemPrompt(p, m);
    expect(t).toContain('{"next":["질문","질문"]}');
    expect(t).toContain('맨 마지막 줄은 {"next":[...]} 한 줄이야');
    expect(t).toContain(m === 'deep' ? '줄은 네 가지뿐이야(그림 주문 sketch 줄은 쓰지 마)' : '줄은 다섯 가지뿐이야');
  });
  test('아이: 밝고 안전한 궁금증만, 반말로', () => {
    const kid = buildSystemPrompt('kid');
    expect(kid).toContain('이어 물을 질문(next)도 아이가 눌러 볼 카드야: 밝고 안전한 궁금증만');
    expect(buildSystemPrompt('adult')).not.toContain('아이가 눌러 볼 카드');
  });
  // QA 2026-11-23: 신중한 선생님(어른)은 반말 next 예시(아이 예시)만 보므로, 어른 카드 말투를 따로 가르친다.
  test.each(['quick', 'deep'] as const)('어른 / %s: 이어 물을 질문은 존댓말로(예시 카드와 같은 말투)', (m) => {
    const nextTone = (t: string) => t.split('\n').filter((l) => l.includes('이어 물을 질문(next)')).join(' ');
    expect(nextTone(buildSystemPrompt('adult', m))).toContain('존댓말');
    expect(nextTone(buildSystemPrompt('kid', m))).not.toContain('존댓말');
  });
  test('신중한 선생님 예시도 next로 끝난다', () => {
    const blocks = exampleBlocks(buildSystemPrompt('kid', 'deep'));
    const state = createParseState();
    const evs = blocks[0].map(l => parseScriptLine(l, state));
    expect(evs.at(-1)).toMatchObject({ t: 'next' });
  });
});

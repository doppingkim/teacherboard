import { describe, expect, test } from 'vitest';
import { waitingLines } from '../../src/web/board/board';

// E1(2026-11-23): 기다리는 동안 칠판에 먼저 쓰는 질문 줄 나누기.
describe('waitingLines', () => {
  test('짧은 질문은 한 줄 그대로(공백 정리)', () => {
    expect(waitingLines('  달은 왜   나를 따라와? ')).toEqual(['달은 왜 나를 따라와?']);
  });
  test('긴 질문은 가운데 가까운 띄어쓰기에서 두 줄로', () => {
    expect(waitingLines('공룡은 왜 다 사라졌고 지금은 없을까?')).toEqual(['공룡은 왜 다 사라졌고', '지금은 없을까?']);
  });
  test('띄어쓰기 없이 길면 가운데에서 자른다', () => {
    const q = '가'.repeat(20);
    expect(waitingLines(q)).toEqual(['가'.repeat(10), '가'.repeat(10)]);
  });
  test('아주 길면 앞부분만 쓰고 줄임표', () => {
    const lines = waitingLines('우리 집 강아지는 왜 밤마다 창문 밖을 보면서 짖고 꼬리를 흔들고 빙글빙글 돌까요 정말 궁금해요');
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect([...lines.join('')].length).toBeLessThanOrEqual(34);
  });
  test('이모지·결합 글자를 반으로 쪼개지 않는다', () => {
    const lines = waitingLines('🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙');
    expect(lines.join('')).toBe('🌙'.repeat(18));
  });
});

// QA2 2026-11-23: 줄 나누기·줄임을 코드 포인트로 세어, 가족 이모지(ZWJ 묶음) 가운데에서 잘라 깨진 글자가 칠판에 쓰였다.
describe('waitingLines 글자 묶음', () => {
  const fam = '👨‍👩‍👧';
  test('줄을 나눠도 ZWJ 이모지를 쪼개지 않는다', () => {
    const q = '가' + fam.repeat(4) + '나다라마바사아자차카';
    const lines = waitingLines(q);
    expect(lines.join('')).toBe(q);
    for (const l of lines) expect(l.replace(new RegExp(fam, 'g'), '')).not.toMatch(/‍/);
  });
  test('줄임표를 붙일 때도 이모지 가운데에서 자르지 않는다', () => {
    const q = fam.repeat(40);
    const lines = waitingLines(q);
    expect(lines.join('').replace(/…$/, '').split(fam).every((s) => s === '')).toBe(true);
  });
});

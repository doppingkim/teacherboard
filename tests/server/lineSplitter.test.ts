import { LineSplitter } from '../../src/server/lineSplitter';

test('조각을 줄로 모은다', () => {
  const sp = new LineSplitter();
  expect(sp.push('{"say":"안')).toEqual([]);
  expect(sp.push('녕"}\n{"pa')).toEqual(['{"say":"안녕"}']);
  expect(sp.push('ge":true}\n')).toEqual(['{"page":true}']);
  expect(sp.flush()).toEqual([]);
});
test('마지막 줄바꿈 없이 끝나도 flush가 돌려준다', () => {
  const sp = new LineSplitter(); sp.push('{"say":"끝"}');
  expect(sp.flush()).toEqual(['{"say":"끝"}']);
});
test('\\r\\n도 처리', () => expect(new LineSplitter().push('a\r\nb\n')).toEqual(['a', 'b']));

test('빈 줄과 공백뿐인 줄은 버린다', () => {
  const sp = new LineSplitter();
  expect(sp.push('a\n\n  \r\nb\n')).toEqual(['a', 'b']);
  sp.push('   ');
  expect(sp.flush()).toEqual([]);
});
test('\\r과 \\n이 다른 조각으로 와도 된다', () => {
  const sp = new LineSplitter();
  expect(sp.push('a\r')).toEqual([]);
  expect(sp.push('\nb')).toEqual(['a']);
  expect(sp.flush()).toEqual(['b']);
});
test('flush 후에는 버퍼가 비어 있다', () => {
  const sp = new LineSplitter(); sp.push('x');
  sp.flush();
  expect(sp.flush()).toEqual([]);
  expect(sp.push('y\n')).toEqual(['y']);
});

// QA 2026-11-22: 줄바꿈 없는 긴 줄을 잘게 받을 때 조각마다 버퍼 전체를 다시 나누면(O(n²)) 이벤트 루프가 멈춘다.
test('줄바꿈 없는 긴 줄(30만 자)을 10자씩 받아도 빠르다(조각마다 버퍼 전체를 다시 나누지 않음)', () => {
  const sp = new LineSplitter();
  const line = '{"say":"' + 'x'.repeat(300_000) + '"}';
  const t0 = performance.now();
  let early = 0;
  for (let i = 0; i < line.length; i += 10) early += sp.push(line.slice(i, i + 10)).length;
  const done = sp.push('\n{"a"');
  expect(performance.now() - t0).toBeLessThan(1000); // 고치기 전(O(n²))에는 수 초
  expect(early).toBe(0);
  expect(done).toEqual([line]);
  expect(sp.flush()).toEqual(['{"a"']);
});

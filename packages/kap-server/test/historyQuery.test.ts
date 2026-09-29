import { describe, expect, it } from 'vitest';
import { matchHistoryText, planHistoryQuery } from '../src/services/history/historyQuery';

const found = (text: string, query: string, mode: 'auto' | 'all' | 'any' | 'literal' | 'terms' = 'auto') =>
  matchHistoryText(text, planHistoryQuery(query, mode));

describe('history query planner', () => {
  const query = '输入框状态 A B C D 状态带 楼管';
  it('finds the two relevant Chinese clauses without single-letter English noise', () => {
    expect(found('输入框状态分为 A、B、C、D 四种。', query)?.matched).toContain('输入框状态');
    expect(found('状态带请放在输入框下面，楼管负责提示。', query)?.matched).toEqual(['状态带', '楼管']);
    expect(found('输入框状态 A B C D 状态带 楼管', query)?.matched).toHaveLength(7);
    expect(found('这里有一个输入文件和框架，输出状态正常。', query)).toBeUndefined();
    expect(found('A separate unrelated sentence.', query)).toBeUndefined();
    expect(found('状态带请放在输入框下面，楼管负责提示。', query, 'all')).toBeUndefined();
    expect(found('A separate unrelated sentence.', query, 'any')?.matched).toEqual(['a']);
    expect(found('输入框状态分为 A、B、C、D 四种。', query, 'terms')).toBeUndefined();
  });

  it('preserves literal substring semantics, ASCII word boundaries and CJK code points', () => {
    expect(found('foobar', 'foo')).toBeUndefined();
    expect(found('foobar', 'foo', 'literal')).toMatchObject({ start: 0, end: 3 });
    expect(found('ab/cd.ts path', 'ab/cd.ts')?.matched).toEqual(['ab/cd.ts']);
    expect(found('𠀀设文', '𠀀设')).toMatchObject({ start: 0, end: 3 });
    expect(found('甲楼管乙', '楼管', 'literal')).toMatchObject({ start: 1, end: 3 });
    expect(found('A B', 'A B')?.matched).toEqual(['a', 'b']);
  });

  it('maps normalized matches to original UTF-16 ranges', () => {
    const fullWidth = '前ＡＢＣ后';
    expect(found(fullWidth, 'abc')).toMatchObject({ start: 1, end: 4 });
    const ligature = 'pre ﬁnd post';
    expect(found(ligature, 'find')).toMatchObject({ start: 4, end: 7 });
    expect(found('e\u0301cho', 'écho')).toMatchObject({ start: 0, end: 5 });
  });

  it('keeps quotes as clauses and rejects unbounded/malformed queries', () => {
    expect(found('状态带旁有输入框状态', '"状态带" 楼管')?.matched).toEqual(['状态带']);
    expect(() => planHistoryQuery('"unfinished')).toThrow('unmatched quote');
    expect(() => planHistoryQuery('a '.repeat(33))).toThrow('too many clauses');
    expect(() => planHistoryQuery(' ')).toThrow('non-whitespace');
  });
});

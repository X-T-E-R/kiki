import { describe, expect, it } from 'vitest';

import { insertDroppedPaths, quoteDroppedPath } from './dropPaths';

describe('quoteDroppedPath', () => {
  it('wraps paths containing whitespace in double quotes', () => {
    expect(quoteDroppedPath('C:\\my dir\\note.txt')).toBe('"C:\\my dir\\note.txt"');
    expect(quoteDroppedPath('/home/user/my docs/a b.txt')).toBe('"/home/user/my docs/a b.txt"');
  });

  it('leaves plain paths untouched', () => {
    expect(quoteDroppedPath('C:\\work\\note.txt')).toBe('C:\\work\\note.txt');
    expect(quoteDroppedPath('/home/user/note.txt')).toBe('/home/user/note.txt');
    expect(quoteDroppedPath('D:/x/y-z.ts')).toBe('D:/x/y-z.ts');
  });
});

describe('insertDroppedPaths', () => {
  const caret = (at: number) => ({ start: at, end: at });

  it('inserts a bare path into an empty draft', () => {
    expect(insertDroppedPaths('', caret(0), ['C:\\work\\note.txt'])).toEqual({
      text: 'C:\\work\\note.txt',
      cursor: 'C:\\work\\note.txt'.length,
    });
  });

  it('inserts at the caret with separating spaces only where needed', () => {
    expect(insertDroppedPaths('fix this file', caret(3), ['/tmp/a.txt'])).toEqual({
      text: 'fix /tmp/a.txt this file',
      cursor: 'fix /tmp/a.txt'.length,
    });
    expect(insertDroppedPaths('fix this file', caret(4), ['/tmp/a.txt'])).toEqual({
      text: 'fix /tmp/a.txt this file',
      cursor: 'fix /tmp/a.txt '.length,
    });
    expect(insertDroppedPaths('see /tmp/a.txt', caret(14), ['/tmp/b.txt'])).toEqual({
      text: 'see /tmp/a.txt /tmp/b.txt',
      cursor: 'see /tmp/a.txt /tmp/b.txt'.length,
    });
  });

  it('quotes whitespace paths and joins several files in drop order', () => {
    expect(
      insertDroppedPaths('', caret(0), ['C:\\my dir\\a.txt', 'D:\\work\\b.txt', '/home/u/c d.sh']),
    ).toEqual({
      text: '"C:\\my dir\\a.txt" D:\\work\\b.txt "/home/u/c d.sh"',
      cursor: '"C:\\my dir\\a.txt" D:\\work\\b.txt "/home/u/c d.sh"'.length,
    });
  });

  it('replaces an active selection like a native text drop', () => {
    expect(insertDroppedPaths('keep [this] tail', { start: 5, end: 11 }, ['/tmp/a.txt'])).toEqual({
      text: 'keep /tmp/a.txt tail',
      cursor: 'keep /tmp/a.txt'.length,
    });
  });

  it('clamps out-of-range selections to the text bounds', () => {
    expect(insertDroppedPaths('ab', caret(99), ['/tmp/a.txt'])).toEqual({
      text: 'ab /tmp/a.txt',
      cursor: 'ab /tmp/a.txt'.length,
    });
    expect(insertDroppedPaths('ab', caret(-5), ['/tmp/a.txt'])).toEqual({
      text: '/tmp/a.txt ab',
      cursor: '/tmp/a.txt '.length,
    });
  });

  it('skips blank paths and leaves the draft untouched when nothing usable remains', () => {
    expect(insertDroppedPaths('text', caret(2), [])).toEqual({ text: 'text', cursor: 2 });
    expect(insertDroppedPaths('text', caret(2), ['', '   '])).toEqual({ text: 'text', cursor: 2 });
    expect(insertDroppedPaths('', caret(0), ['', '/tmp/a.txt'])).toEqual({
      text: '/tmp/a.txt',
      cursor: '/tmp/a.txt'.length,
    });
  });
});

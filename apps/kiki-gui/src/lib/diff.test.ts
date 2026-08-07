import { describe, expect, it } from 'vitest';

import { buildHunks, diffStat, extractEditSource, hunkGapLines, MAX_CONTEXT_LINES } from './diff';

describe('buildHunks', () => {
  it('returns no hunks for identical texts', () => {
    expect(buildHunks('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
  });

  it('builds a single-change hunk with at most 3 context lines each side', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n') + '\n';
    const after = before.replace('l5', 'CHANGED');
    const hunks = buildHunks(before, after);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    // 3 context + delete + insert + 3 context
    expect(hunk.map((l) => l.tag)).toEqual([
      'equal',
      'equal',
      'equal',
      'delete',
      'insert',
      'equal',
      'equal',
      'equal',
    ]);
    expect(hunk[0]!.text).toBe('l2');
    expect(hunk[0]!.ln).toBe(2);
    expect(hunk.filter((l) => l.tag === 'equal')).toHaveLength(2 * MAX_CONTEXT_LINES);
    const stat = diffStat(hunks);
    expect(stat).toEqual({ insertions: 1, deletions: 1 });
  });

  it('keeps small equal gaps inside one hunk, splits large ones with a gap count', () => {
    // 4 equal lines between changes (≤ 2×context) → one hunk.
    const mk = (gap: number) => {
      const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
      const before = lines.join('\n') + '\n';
      const after = before.replace('line5', 'A').replace(`line${5 + gap + 1}`, 'B');
      return buildHunks(before, after);
    };
    expect(mk(4)).toHaveLength(1);
    expect(mk(5)).toHaveLength(1); // 5 equals: windows still touch (3+3 ≥ 5)
    const split = mk(7);
    expect(split).toHaveLength(2);
    // gap = 7 unchanged lines minus 3 context kept on each side = 1 hidden.
    expect(hunkGapLines(split[0]!, split[1]!)).toBe(1);
  });

  it('trims blank equal lines at hunk edges', () => {
    const before = 'fn a() {\n\n  call();\n\n}\n';
    const after = 'fn a() {\n\n  callB();\n\n}\n';
    const hunks = buildHunks(before, after);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk[0]!.text.trim()).not.toBe('');
    expect(hunk.at(-1)!.text.trim()).not.toBe('');
    expect(hunk.some((l) => l.tag === 'delete' && l.text.includes('call();'))).toBe(true);
    expect(hunk.some((l) => l.tag === 'insert' && l.text.includes('callB();'))).toBe(true);
  });

  it('represents a whole-file create as one all-insert hunk numbered from 1', () => {
    const hunks = buildHunks('', 'one\ntwo\nthree\n');
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk.every((l) => l.tag === 'insert')).toBe(true);
    expect(hunk.map((l) => l.ln)).toEqual([1, 2, 3]);
    expect(diffStat(hunks)).toEqual({ insertions: 3, deletions: 0 });
  });

  it('handles pure deletions and keeps old-file line numbers', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nd\n';
    const hunks = buildHunks(before, after);
    expect(hunks).toHaveLength(1);
    const deleted = hunks[0]!.filter((l) => l.tag === 'delete');
    expect(deleted.map((l) => l.lo)).toEqual([2, 3]);
    expect(diffStat(hunks)).toEqual({ insertions: 0, deletions: 2 });
  });

  it('hunkGapLines is undefined when a hunk has no new-file rows', () => {
    const pureDelete = [{ text: 'x', lo: 1, ln: 0, tag: 'delete' as const }];
    const next = [{ text: 'y', lo: 2, ln: 2, tag: 'equal' as const }];
    expect(hunkGapLines(pureDelete, next)).toBeUndefined();
  });
});

describe('extractEditSource', () => {
  it('prefers the display diff payload (path + before/after)', () => {
    const source = extractEditSource(
      { kind: 'diff', path: 'src/a.ts', before: 'const x = 1\n', after: 'const x = 2\n' },
      undefined,
    );
    expect(source?.path).toBe('src/a.ts');
    expect(diffStat(source?.hunks ?? [])).toEqual({ insertions: 1, deletions: 1 });
  });

  it('reads file_io write creates (before defaults to empty)', () => {
    const source = extractEditSource(
      { kind: 'file_io', operation: 'write', path: 'README.md', content: 'hello\nworld\n' },
      undefined,
    );
    expect(source?.hunks[0]?.every((l) => l.tag === 'insert')).toBe(true);
  });

  it('falls back to Edit-style args', () => {
    const source = extractEditSource(undefined, {
      file_path: 'a.txt',
      old_string: 'foo',
      new_string: 'bar',
    });
    expect(source?.path).toBe('a.txt');
    expect(diffStat(source?.hunks ?? [])).toEqual({ insertions: 1, deletions: 1 });
  });

  it('expands MultiEdit args into per-edit hunks', () => {
    const source = extractEditSource(undefined, {
      file_path: 'a.txt',
      edits: [
        { old_string: 'one', new_string: '1' },
        { old_string: 'two', new_string: '2' },
      ],
    });
    expect(source?.hunks).toHaveLength(2);
    expect(diffStat(source?.hunks ?? [])).toEqual({ insertions: 2, deletions: 2 });
  });

  it('returns undefined for non-edit calls', () => {
    expect(extractEditSource({ kind: 'command', command: 'ls' }, undefined)).toBeUndefined();
    expect(extractEditSource(undefined, { command: 'ls' })).toBeUndefined();
    expect(extractEditSource(undefined, undefined)).toBeUndefined();
  });
});

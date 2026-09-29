import { describe, expect, it } from 'vitest';

import { executorDisplayName, parseUnifiedDiff } from './ExecutorNotes';

describe('parseUnifiedDiff', () => {
  it('splits files and numbers lines from the hunk headers', () => {
    const files = parseUnifiedDiff([
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -3,2 +3,2 @@', ' keep', '-old', '+new',
      'diff --git a/b.ts b/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/b.ts', '@@ -0,0 +1,1 @@', '+hello',
    ].join('\n'));
    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'b.ts']);
    expect(files[0]!.hunks[0]).toEqual([
      { lo: 3, ln: 3, tag: 'equal', text: 'keep' },
      { lo: 4, ln: 0, tag: 'delete', text: 'old' },
      { lo: 0, ln: 4, tag: 'insert', text: 'new' },
    ]);
    expect(files[1]!.hunks[0]).toEqual([{ lo: 0, ln: 1, tag: 'insert', text: 'hello' }]);
  });

  it('returns nothing for text without hunks', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('no changes')).toEqual([]);
  });
});

describe('executorDisplayName', () => {
  it('names known engines and capitalizes the rest', () => {
    expect(executorDisplayName('codex-app-server')).toBe('Codex');
    expect(executorDisplayName('grok')).toBe('Grok');
  });
});

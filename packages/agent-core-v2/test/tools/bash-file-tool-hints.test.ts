import { describe, expect, it } from 'vitest';

import { bashFileToolHint, classifyBashFileOperation } from '#/agent/tools/os/bash/bashFileToolHints';

describe('Bash file-tool hints', () => {
  it.each([
    ['cat src/a.ts', 'read'],
    ['head -n 20 src/a.ts', 'read'],
    ['tail -20 src/a.ts', 'read'],
    ["sed -n '2,8p' src/a.ts", 'read'],
    ['type README.md', 'read'],
    ['Get-Content -Path README.md', 'read'],
    ['cd src && cat a.ts', 'read'],
    ['rg TODO src', 'search'],
    ['grep -r TODO src', 'search'],
    ['findstr /s TODO src\\*.ts', 'search'],
    ["find src -name '*.ts'", 'search'],
    ['ls -R src', 'search'],
    ["printf 'x' > src/a.ts", 'write'],
    ['cat <<EOF > src/a.ts\nx\nEOF', 'write'],
    ["sed -i 's/a/b/' src/a.ts", 'write'],
    ["perl -pi -e 's/a/b/' src/a.ts", 'write'],
    ["Set-Content src/a.ts 'hello'", 'write'],
  ] as const)('classifies %s as %s', (command, kind) => {
    expect(classifyBashFileOperation(command)).toBe(kind);
  });

  it.each([
    'npm test | grep FAIL',
    'cat src/a.ts | wc -l',
    'pnpm build',
    'git diff',
    'wc -l src/a.ts',
    'ls src',
    'node scripts/write.js > build.log',
    'echo hello > build.log',
    'git status && npm test',
  ])('ignores a compound or non-file-tool command: %s', (command) => {
    expect(classifyBashFileOperation(command)).toBeUndefined();
  });

  it('limits each category to three hints per session, not per command', () => {
    const session = {};
    for (let count = 0; count < 3; count++) {
      expect(bashFileToolHint(`cat ${count}.txt`, session)).toContain('Read');
    }
    expect(bashFileToolHint('cat fourth.txt', session)).toBeUndefined();
    expect(bashFileToolHint('rg needle src', session)).toContain('Grep or Glob');
    expect(bashFileToolHint('cat fifth.txt', {})).toContain('Read');
  });

  it('disables hints without consuming the session budget', () => {
    const session = {};
    expect(bashFileToolHint('cat one.txt', session, false)).toBeUndefined();
    expect(bashFileToolHint('cat one.txt', session, true)).toContain('Read');
  });
});

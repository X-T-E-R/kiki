import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { codeHighlightTheme } from '#/tui/theme/highlight-theme';
import { currentTheme } from '#/tui/theme/theme';

import { captureProcessWrite } from '../../../helpers/process';

const ESC = String.fromCodePoint(27);

describe('code-highlight', () => {
  it('maps known file extensions to supported highlight languages', () => {
    expect(langFromPath('src/foo.ts')).toBe('typescript');
    expect(langFromPath('src/foo.TS')).toBe('typescript');
    expect(langFromPath('Cargo.toml')).toBe('toml');
  });

  it('treats unsupported file extensions as plain text', () => {
    expect(langFromPath('src/foo.abcxyz')).toBeUndefined();
  });

  it('falls back to plain text for unsupported languages without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      expect(highlightLines('hello\nworld', 'abcxyz')).toEqual(['hello', 'world']);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('resets string and regexp tokens to plain styling', () => {
    for (const token of ['string', 'regexp'] as const) {
      expect(codeHighlightTheme[token]?.('code')).toBe('code');
    }
  });

  it('emits no red SGR for strings and regexps while highlighting keywords with theme tokens', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const js = highlightLines("const s = 'str';\nconst r = /re+/g;", 'javascript').join('\n');
      expect(js).not.toContain(`${ESC}[31m`);
      expect(js).toContain(chalk.hex(currentTheme.color('primary'))('const'));
      expect(js).toContain("'str'");
      expect(js).toContain('/re+/g');
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('colors diff deletions and additions with the palette diff colors', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      expect(highlightLines('- removed\n+ added', 'diff')).toEqual([
        chalk.hex(currentTheme.color('diffRemoved'))('- removed'),
        chalk.hex(currentTheme.color('diffAdded'))('+ added'),
      ]);
    } finally {
      chalk.level = previousLevel;
    }
  });
});

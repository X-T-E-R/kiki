import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = dirname(SRC_DIR);
const LAUNCHER_CSS = join(GUI_ROOT, 'mobile', 'launcher', 'launcher.css');
const WORDMARK_REL = 'src/components/Wordmark.tsx';

const FORBIDDEN_TW_WEIGHT = /\bfont-(?:thin|extralight|light|medium|semibold|extrabold|black)\b|\bfont-\[\s*\d+\s*\]/g;
const FORBIDDEN_CSS_WEIGHT = /\b(?:font-weight\s*:\s*(?:100|200|300|500|510|550|560|600|650|800|900)|font\s*:\s*(?:italic\s+)?(?:100|200|300|500|510|550|560|600|650|800|900))\b/g;
const FORBIDDEN_STYLE_WEIGHT = /\bfontWeight\s*:\s*['"]?(?:100|200|300|500|510|550|560|600|650|800|900)['"]?\b/g;
const FORBIDDEN_NEGATIVE_TRACKING = /\btracking-(?:tight|tighter)\b|\btracking-\[-|letter-spacing\s*:\s*-/g;

function collectProductionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'test' || entry === '__tests__') continue;
      collectProductionFiles(full, out);
    } else if (/\.(?:ts|tsx|css)$/.test(entry) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/** Replace `@font-face { ... }` blocks with matching newline counts so line numbers stay accurate. */
function stripFontFaceBlocks(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/g, (block) => block.replace(/[^\r\n]/g, ' '));
}

function scanFile(filePath: string): string[] {
  const rel = relative(GUI_ROOT, filePath).replace(/\\/g, '/');
  if (rel === WORDMARK_REL) return [];

  const isCss = filePath.endsWith('.css');
  const raw = readFileSync(filePath, 'utf8');
  const content = isCss ? stripFontFaceBlocks(raw) : raw;
  const lines = content.split(/\r?\n/);
  const violations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const checks: Array<[string, RegExp]> = isCss
      ? [
          ['forbidden-css-weight', FORBIDDEN_CSS_WEIGHT],
          ['forbidden-negative-tracking', FORBIDDEN_NEGATIVE_TRACKING],
        ]
      : [
          ['forbidden-tw-weight', FORBIDDEN_TW_WEIGHT],
          ['forbidden-style-weight', FORBIDDEN_STYLE_WEIGHT],
          ['forbidden-negative-tracking', FORBIDDEN_NEGATIVE_TRACKING],
        ];

    for (const [kind, pattern] of checks) {
      pattern.lastIndex = 0;
      let match = pattern.exec(line);
      while (match !== null) {
        violations.push(`${rel}:${lineNo} [${kind}] ${match[0]}`);
        match = pattern.exec(line);
      }
    }
  }

  return violations;
}

describe('Paper-and-Ink two-weight typography contract', () => {
  it('forbids mid/extreme font weights and negative tracking across first-party GUI production files', () => {
    const files = [...collectProductionFiles(SRC_DIR), LAUNCHER_CSS];
    expect(files.length).toBeGreaterThan(100);

    const violations = files.flatMap(scanFile);
    expect(violations).toEqual([]);
  });

  it('preserves the two-weight token definitions and sole Wordmark 600 exception', () => {
    const indexCss = readFileSync(join(SRC_DIR, 'index.css'), 'utf8');
    expect(indexCss).toContain('--font-weight-normal: 400;');
    expect(indexCss).toContain('--font-weight-bold: 700;');
    expect(indexCss).not.toMatch(/--font-weight-medium\s*:/);

    const wordmark = readFileSync(join(GUI_ROOT, WORDMARK_REL), 'utf8');
    expect(wordmark).toContain('font-serif');
    expect(wordmark).toContain('font-semibold');
    expect(wordmark).toContain('tracking-tight');
  });
});

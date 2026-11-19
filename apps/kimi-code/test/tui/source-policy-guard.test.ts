import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPrintableChar, printableChar } from '#/tui/utils/printable-key';

const SRC_ROOT = join(__dirname, '..', '..', 'src');
const CHALK_NAMED = /\bchalk\.(red|green|yellow|blue|magenta|cyan|white|gray|grey|black|blackBright|whiteBright|redBright|greenBright|yellowBright|blueBright|magentaBright|cyanBright)\(/;
const BARE_PRINTABLE = /\bdata\s*===\s*'([\u0020-\u007E])'/;

function scanSourcePolicies(relPosix: string, content: string): string[] {
  const checkChalk = relPosix.endsWith('.ts') && !relPosix.endsWith('.test.ts') && !relPosix.endsWith('.spec.ts');
  const checkPrintable = relPosix.startsWith('tui/components/') && (relPosix.endsWith('.ts') || relPosix.endsWith('.tsx'));
  if (!checkChalk && !checkPrintable) return [];
  const hits: string[] = [];
  let inBlock = false;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trimStart();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (checkChalk && CHALK_NAMED.test(trimmed)) hits.push(`chalk:${relPosix}:${i + 1}`);
    if (checkPrintable && BARE_PRINTABLE.test(trimmed)) hits.push(`printable:${relPosix}:${i + 1}`);
  }
  return hits;
}

describe('TUI source policy guard & printable-key contract', () => {
  it('flags positive violations and ignores allowed tokens/comments on fixtures', () => {
    expect(scanSourcePolicies('tui/foo.ts', 'const s = chalk.red("bad");\n// chalk.cyan("ok")')).toEqual(['chalk:tui/foo.ts:1']);
    expect(scanSourcePolicies('tui/foo.ts', '/* chalk.yellow("ok")\nchalk.blue("ok") */\nchalk.hex("#ff0000")("ok");')).toEqual([]);
    expect(scanSourcePolicies('tui/components/box.ts', "if (data === 'q') return;\nif (data === '\\t') return;")).toEqual(['printable:tui/components/box.ts:1']);
    expect(scanSourcePolicies('tui/components/box.ts', "const k = printableChar(data); if (k === 'q' || data === '[A') return;")).toEqual([]);
    expect(printableChar('\x1b[113u')).toBe('q');
    expect(printableChar('q')).toBe('q');
    expect(isPrintableChar(' ')).toBe(true);
    expect(isPrintableChar('\t')).toBe(false);
  });

  it('enforces chalk semantic-token and printableChar rules in one source walk', () => {
    const offenders: string[] = [];
    const stack = [SRC_ROOT];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const rel = relative(SRC_ROOT, full).replaceAll('\\', '/');
          offenders.push(...scanSourcePolicies(rel, readFileSync(full, 'utf8')));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

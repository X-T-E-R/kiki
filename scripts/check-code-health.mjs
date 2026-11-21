#!/usr/bin/env node
/* eslint-disable no-console -- Command-line deterministic code-health gate. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  findIntraMonorepoMocks,
  LEGACY_INTRA_MONOREPO_MOCK_ALLOWLIST,
} from './ccp-chaos/check-test-hygiene.mjs';

const DEFAULT_ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_BASELINE_REL = 'scripts/code-health-baseline.json';
export const DEFAULT_MAX_NEW_FILE_LINES = 600;

const WALK_SKIP_DIRS = new Set([
  '.git',
  '.gradle',
  '.next',
  '.tmp',
  '.vitepress-cache',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const PROD_EXCLUDE_SEGMENTS = new Set(['__tests__', '__fixtures__', 'test', 'tests', 'fixtures']);
const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx)$/u;
const PROD_EXT_RE = /\.(?:ts|tsx)$/u;
const NATIVE_DIALOG_RE = /\bwindow\.(alert|confirm|prompt)\s*\(/gu;
const BARE_RANDOM_UUID_RE = /(?:^|[^\w$.?])(?:(?:globalThis|window)\.)?crypto\.randomUUID\s*\(/gu;
const DECORATIVE_EMOJI_RE = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)/gu;
const CATALOG_PATH_PREFIX_RE = /^(?:src|apps|packages|scripts|docs|config|\.agents|\.github)\//u;

export const BANNED_DEFENSIVE_PHRASES = [
  { text: '数据可能已过期', caseInsensitive: false },
  { text: '结果可能不完整', caseInsensitive: false },
  { text: '部分用量或费用仍不完整', caseInsensitive: false },
  { text: '暂停状态可能已过期', caseInsensitive: false },
  { text: 'Data may be stale', caseInsensitive: true },
  { text: 'Results may be incomplete', caseInsensitive: true },
  { text: 'may be outdated', caseInsensitive: true },
];

function toPosix(filePath) {
  return filePath.split(sep).join('/');
}

function relPosix(root, absPath) {
  return toPosix(relative(root, absPath));
}

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(entry.name)) walkFiles(abs, predicate, out);
    } else if (entry.isFile() && predicate(abs, entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

function countLinesBuffer(buf) {
  if (buf.length === 0) return 0;
  let lines = 1;
  let idx = -1;
  while ((idx = buf.indexOf(10, idx + 1)) !== -1) {
    lines += 1;
  }
  return lines;
}

function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 1;
  let idx = -1;
  while ((idx = text.indexOf('\n', idx + 1)) !== -1) {
    lines += 1;
  }
  return lines;
}

function stripCommentsPreservingLines(code) {
  if (!code.includes('//') && !code.includes('/*')) return code;
  const out = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code.codePointAt(i);
    const next = i + 1 < n ? code.codePointAt(i + 1) : 0;
    if (ch === 47 && next === 47) {
      i += 2;
      while (i < n && code.codePointAt(i) !== 10) i += 1;
      continue;
    }
    if (ch === 47 && next === 42) {
      i += 2;
      while (i < n && !(code.codePointAt(i) === 42 && code.codePointAt(i + 1) === 47)) {
        if (code.codePointAt(i) === 10) out.push('\n');
        i += 1;
      }
      if (i < n) i += 2;
      continue;
    }
    if (ch === 34 || ch === 39 || ch === 96) {
      const quote = ch;
      out.push(code[i]);
      i += 1;
      while (i < n && code.codePointAt(i) !== quote) {
        if (code.codePointAt(i) === 92 && i + 1 < n) {
          out.push(code[i], code[i + 1]);
          i += 2;
          continue;
        }
        out.push(code[i]);
        i += 1;
      }
      if (i < n) {
        out.push(code[i]);
        i += 1;
      }
      continue;
    }
    out.push(code[i]);
    i += 1;
  }
  return out.join('');
}

function isProductionSource(rel) {
  if (!PROD_EXT_RE.test(rel)) return false;
  if (rel.endsWith('.d.ts') || TEST_FILE_RE.test(rel)) return false;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (PROD_EXCLUDE_SEGMENTS.has(parts[i])) return false;
  }
  return true;
}

function sortRecord(record) {
  const sorted = {};
  for (const key of Object.keys(record).toSorted((a, b) => a.localeCompare(b))) {
    sorted[key] = record[key];
  }
  return sorted;
}

function addViolation(violations, rule, file, line, message, fix) {
  violations.push({
    rule,
    file: toPosix(file),
    line: line ?? 1,
    message: message.replace(/\.+$/u, ''),
    fix: fix.replace(/\.+$/u, ''),
  });
}

export function formatCodeHealthViolation(v) {
  return `[${v.rule}] ${v.file}:${v.line} — ${v.message}. Fix: ${v.fix}.`;
}

function loadBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    return {
      schema: 1,
      maxNewFileLines: DEFAULT_MAX_NEW_FILE_LINES,
      monolithMaxLines: {},
      internalTestMocks: {},
      emojiAllowedFiles: {},
      bareRandomUuidFiles: {},
    };
  }
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  return {
    schema: parsed.schema ?? 1,
    maxNewFileLines:
      typeof parsed.maxNewFileLines === 'number' && parsed.maxNewFileLines > 0
        ? parsed.maxNewFileLines
        : DEFAULT_MAX_NEW_FILE_LINES,
    monolithMaxLines: parsed.monolithMaxLines ?? {},
    internalTestMocks: parsed.internalTestMocks ?? {},
    emojiAllowedFiles: parsed.emojiAllowedFiles ?? {},
    bareRandomUuidFiles: parsed.bareRandomUuidFiles ?? {},
  };
}

function isBuildOutputPlaceholder(repoRoot, cleanPath) {
  if (!/(?:^|\/)dist(?:\/|$)/u.test(cleanPath)) return false;
  return existsSync(dirname(resolve(repoRoot, cleanPath)));
}

function isExplicitNonExistenceContext(line, tokenIndex, tokenLength) {
  const after = line.slice(tokenIndex + tokenLength, tokenIndex + tokenLength + 48);
  return /^\s*`?\s*(?:does not exist|no longer exists|was removed|is removed|was deleted)/iu.test(after);
}

function splitOutsideFences(markdown) {
  const lines = markdown.split(/\r?\n/u);
  let fence;
  return lines.map((line, index) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
    if (match) {
      const marker = match[1][0];
      const width = match[1].length;
      if (fence === undefined) fence = { marker, width };
      else if (marker === fence.marker && width >= fence.width) fence = undefined;
      return { line: index + 1, text: '' };
    }
    return { line: index + 1, text: fence === undefined ? line : '' };
  });
}

function lineNumberAtOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.codePointAt(i) === 10) line += 1;
  }
  return line;
}

export function checkCodeHealth(root = DEFAULT_ROOT, options = {}) {
  const repoRoot = resolve(root);
  const baselinePath = options.baselinePath
    ? resolve(options.baselinePath)
    : join(repoRoot, DEFAULT_BASELINE_REL);
  const baseline = options.baseline ?? loadBaseline(baselinePath);
  const maxNewFileLines = options.maxNewFileLines ?? baseline.maxNewFileLines ?? DEFAULT_MAX_NEW_FILE_LINES;

  const violations = [];
  const observedMonoliths = {};
  const observedInternalMocks = {};
  const observedEmojiFiles = {};
  const observedBareRandomUuid = {};

  const sourceRoots = ['apps', 'packages'];
  const agentsFiles = [];
  const rootAgents = join(repoRoot, 'AGENTS.md');
  if (existsSync(rootAgents)) agentsFiles.push(rootAgents);
  const docsAgents = join(repoRoot, 'docs', 'AGENTS.md');
  if (existsSync(docsAgents)) agentsFiles.push(docsAgents);

  let prodFilesScanned = 0;
  let testFilesScanned = 0;

  for (const base of sourceRoots) {
    const baseDir = join(repoRoot, base);
    const files = walkFiles(
      baseDir,
      (_abs, name) => PROD_EXT_RE.test(name) || name === 'AGENTS.md',
    );
    files.sort((a, b) => a.localeCompare(b));

    for (const abs of files) {
      if (abs.endsWith(`${sep}AGENTS.md`) || abs.endsWith('/AGENTS.md')) {
        agentsFiles.push(abs);
        continue;
      }
      const rel = relPosix(repoRoot, abs);

      if (TEST_FILE_RE.test(rel)) {
        testFilesScanned += 1;
        const raw = readFileSync(abs, 'utf8');
        let relativeMocks = [];
        if (raw.includes('vi.mock') || raw.includes('vi.doMock') || raw.includes('mock.module')) {
          const stripped = stripCommentsPreservingLines(raw);
          const allMocks = findIntraMonorepoMocks(stripped, (offset) => lineNumberAtOffset(stripped, offset));
          relativeMocks = allMocks.filter(
            (hit) => hit.target.startsWith('./') || hit.target.startsWith('../'),
          );
        }
        if (relativeMocks.length > 0) {
          observedInternalMocks[rel] = relativeMocks.length;
        }
        const allowed = baseline.internalTestMocks[rel] ?? 0;
        if (relativeMocks.length > allowed) {
          const targets = [...new Set(relativeMocks.map((h) => h.target))].slice(0, 4).join(', ');
          const firstLine = relativeMocks[0]?.line ?? 1;
          addViolation(
            violations,
            'internal-test-mock-ratchet',
            rel,
            firstLine,
            allowed === 0
              ? `Found ${relativeMocks.length} relative internal vi.mock call(s) (${targets}) in test file with 0 baseline allowance`
              : `Relative internal vi.mock count grew from ${allowed} to ${relativeMocks.length} (${targets})`,
            'Test real production wiring (DI/Scope or real component tree) or extract a clean boundary adapter instead of mocking internal relative modules',
          );
        }
        continue;
      }

      if (!isProductionSource(rel)) continue;
      prodFilesScanned += 1;

      const isGuiProd = rel.startsWith('apps/kiki-gui/src/');
      const isSessionCoreProd = rel.startsWith('packages/session-core/src/');
      const isSessionI18n = rel.startsWith('packages/session-core/src/i18n/');
      const needsTextScan = isGuiProd || isSessionCoreProd;
      const raw = needsTextScan ? readFileSync(abs, 'utf8') : null;
      const lines = raw !== null ? countLines(raw) : countLinesBuffer(readFileSync(abs));
      if (lines > maxNewFileLines) {
        observedMonoliths[rel] = lines;
      }
      const frozenMax = baseline.monolithMaxLines[rel];
      if (typeof frozenMax === 'number') {
        if (lines > frozenMax) {
          addViolation(
            violations,
            'monolith-ratchet',
            rel,
            lines,
            `Baselined monolith grew by +${lines - frozenMax} line(s) (${lines} > frozen ${frozenMax})`,
            'Extract the new behavior into a focused cohesive sibling module instead of growing this frozen file (or split responsibilities out and run --ratchet)',
          );
        }
      } else if (lines > maxNewFileLines) {
        addViolation(
          violations,
          'monolith-ratchet',
          rel,
          lines,
          `New production source file has ${lines} lines, exceeding the ${maxNewFileLines}-line ceiling`,
          `Split ${rel} by cohesive responsibility into focused sibling modules <= ${maxNewFileLines} lines each`,
        );
      }

      if (!needsTextScan) continue;

      const stripped = stripCommentsPreservingLines(raw);
      const strippedLines = stripped.split(/\r?\n/u);

      if (isGuiProd || (isSessionCoreProd && rel.endsWith('.ts'))) {
        const uuidHits = [];
        for (let i = 0; i < strippedLines.length; i += 1) {
          BARE_RANDOM_UUID_RE.lastIndex = 0;
          while (BARE_RANDOM_UUID_RE.exec(strippedLines[i]) !== null) {
            uuidHits.push(i + 1);
          }
        }
        if (uuidHits.length > 0) {
          observedBareRandomUuid[rel] = uuidHits.length;
        }
        const allowedUuid = baseline.bareRandomUuidFiles[rel] ?? 0;
        if (uuidHits.length > allowedUuid) {
          addViolation(
            violations,
            'client-bare-random-uuid',
            rel,
            uuidHits[0],
            `Bare crypto.randomUUID() call (${uuidHits.length} > allowed ${allowedUuid}) crashes in Non-Secure Contexts (e.g. LAN http://192.168.x.x)`,
            'Use a crypto.getRandomValues()-backed randomUuid() helper (or optional-chained fallback) instead of bare crypto.randomUUID()',
          );
        }
      }

      if (!isGuiProd && !isSessionI18n) continue;

      if (isGuiProd) {
        for (let i = 0; i < strippedLines.length; i += 1) {
          const line = strippedLines[i];
          NATIVE_DIALOG_RE.lastIndex = 0;
          const match = NATIVE_DIALOG_RE.exec(line);
          if (match) {
            addViolation(
              violations,
              'gui-native-dialog',
              rel,
              i + 1,
              `Forbidden native browser dialog "window.${match[1]}(" in GUI source`,
              'Use ConfirmDialog, Dialog, or pushUndoToast from apps/kiki-gui/src/components/ instead of blocking browser dialogs',
            );
          }
        }
      }

      for (let i = 0; i < strippedLines.length; i += 1) {
        const line = strippedLines[i];
        const lower = line.toLowerCase();
        for (const phrase of BANNED_DEFENSIVE_PHRASES) {
          const hit = phrase.caseInsensitive
            ? lower.includes(phrase.text.toLowerCase())
            : line.includes(phrase.text);
          if (hit) {
            addViolation(
              violations,
              'gui-banned-defensive-copy',
              rel,
              i + 1,
              `Banned defensive boundary disclaimer "${phrase.text}" found in UI copy`,
              'Fix the underlying freshness/completeness contract or remove the hedging disclaimer from visible UI text',
            );
          }
        }
      }

      if (
        (rel.startsWith('apps/kiki-gui/src/components/') || rel.startsWith('apps/kiki-gui/src/mobile/')) &&
        rel.endsWith('.tsx')
      ) {
        const emojiHits = [];
        for (let i = 0; i < strippedLines.length; i += 1) {
          DECORATIVE_EMOJI_RE.lastIndex = 0;
          let m;
          while ((m = DECORATIVE_EMOJI_RE.exec(strippedLines[i])) !== null) {
            emojiHits.push({ line: i + 1, glyph: m[0] });
          }
        }
        if (emojiHits.length > 0) {
          observedEmojiFiles[rel] = emojiHits.length;
        }
        const allowedEmojis = baseline.emojiAllowedFiles[rel] ?? 0;
        if (emojiHits.length > allowedEmojis) {
          const sample = [...new Set(emojiHits.map((h) => h.glyph))].slice(0, 6).join(' ');
          addViolation(
            violations,
            'gui-decorative-emoji',
            rel,
            emojiHits[0].line,
            `Decorative UI emoji (${sample}) found in GUI component (${emojiHits.length} > allowed ${allowedEmojis})`,
            'Use canonical icon glyphs from apps/kiki-gui/src/components/icons.tsx or typographic labels instead of emojis in UI controls/labels',
          );
        }
      }
    }
  }

  agentsFiles.sort((a, b) => a.localeCompare(b));
  let agentsDocsChecked = 0;

  for (const abs of agentsFiles) {
    agentsDocsChecked += 1;
    const rel = relPosix(repoRoot, abs);
    const dirAbs = dirname(abs);
    const lines = splitOutsideFences(readFileSync(abs, 'utf8'));

    for (const { line, text } of lines) {
      if (!text || text.includes('<!-- historical -->')) continue;
      for (const match of text.matchAll(/`([^`\r\n]+)`/gu)) {
        const rawToken = match[1].trim();
        if (!CATALOG_PATH_PREFIX_RE.test(rawToken)) continue;
        if (/[*<>{}[\]\s,|]/u.test(rawToken) || rawToken.includes('...') || rawToken.includes('…')) {
          continue;
        }
        const clean = rawToken.split('#', 1)[0].split('?', 1)[0].replace(/[),.;:]+$/u, '');
        if (!clean || !CATALOG_PATH_PREFIX_RE.test(clean)) continue;
        if (isExplicitNonExistenceContext(text, match.index ?? 0, match[0].length)) continue;
        if (isBuildOutputPlaceholder(repoRoot, clean)) continue;

        const fromDir = resolve(dirAbs, clean);
        const fromRoot = resolve(repoRoot, clean);
        if (!existsSync(fromDir) && !existsSync(fromRoot)) {
          addViolation(
            violations,
            'catalog-link-integrity',
            rel,
            line,
            `Catalog path \`${rawToken}\` does not exist on disk`,
            `Update \`${rawToken}\` in ${rel} to the current path or remove the stale catalog entry`,
          );
        }
      }
    }
  }

  const ratchetSavings = {
    monolithShrinks: [],
    mockShrinks: [],
    emojiShrinks: [],
    bareRandomUuidShrinks: [],
    retiredLegacyMockAllowlist: [],
  };

  for (const [rel, frozen] of Object.entries(baseline.monolithMaxLines)) {
    const current = observedMonoliths[rel] ?? 0;
    if (current === 0 || current < frozen) {
      ratchetSavings.monolithShrinks.push({ file: rel, from: frozen, to: current });
    }
  }
  for (const [rel, frozen] of Object.entries(baseline.internalTestMocks)) {
    const current = observedInternalMocks[rel] ?? 0;
    if (current < frozen) {
      ratchetSavings.mockShrinks.push({ file: rel, from: frozen, to: current });
    }
  }
  for (const [rel, frozen] of Object.entries(baseline.emojiAllowedFiles)) {
    const current = observedEmojiFiles[rel] ?? 0;
    if (current < frozen) {
      ratchetSavings.emojiShrinks.push({ file: rel, from: frozen, to: current });
    }
  }
  for (const [rel, frozen] of Object.entries(baseline.bareRandomUuidFiles)) {
    const current = observedBareRandomUuid[rel] ?? 0;
    if (current < frozen) {
      ratchetSavings.bareRandomUuidShrinks.push({ file: rel, from: frozen, to: current });
    }
  }
  if (options.baseline === undefined) {
    for (const rel of LEGACY_INTRA_MONOREPO_MOCK_ALLOWLIST) {
      if (!existsSync(join(repoRoot, ...rel.split('/')))) {
        ratchetSavings.retiredLegacyMockAllowlist.push(rel);
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    stats: {
      prodFilesScanned,
      testFilesScanned,
      agentsDocsChecked,
      monolithCount: Object.keys(observedMonoliths).length,
      internalMockFileCount: Object.keys(observedInternalMocks).length,
      internalMockCallCount: Object.values(observedInternalMocks).reduce((sum, n) => sum + n, 0),
      emojiFileCount: Object.keys(observedEmojiFiles).length,
      bareRandomUuidFileCount: Object.keys(observedBareRandomUuid).length,
    },
    observed: {
      monolithMaxLines: sortRecord(observedMonoliths),
      internalTestMocks: sortRecord(observedInternalMocks),
      emojiAllowedFiles: sortRecord(observedEmojiFiles),
      bareRandomUuidFiles: sortRecord(observedBareRandomUuid),
    },
    baseline,
    ratchetSavings,
  };
}

function mergeRatchetSection(prevSection, observedSection, allowIncrease) {
  const next = {};
  const blockedIncreases = [];
  const allKeys = new Set([...Object.keys(prevSection), ...Object.keys(observedSection)]);
  for (const key of [...allKeys].toSorted((a, b) => a.localeCompare(b))) {
    const prev = prevSection[key];
    const curr = observedSection[key];
    if (curr === undefined) {
      continue;
    }
    if (prev === undefined) {
      if (allowIncrease) {
        next[key] = curr;
      } else {
        blockedIncreases.push({ file: key, from: 0, to: curr });
      }
      continue;
    }
    if (curr <= prev) {
      next[key] = curr;
    } else if (allowIncrease) {
      next[key] = curr;
    } else {
      next[key] = prev;
      blockedIncreases.push({ file: key, from: prev, to: curr });
    }
  }
  return { next, blockedIncreases };
}

export function applyRatchet(root = DEFAULT_ROOT, options = {}) {
  const repoRoot = resolve(root);
  const baselinePath = options.baselinePath
    ? resolve(options.baselinePath)
    : join(repoRoot, DEFAULT_BASELINE_REL);
  const allowIncrease = Boolean(options.allowIncreaseReason && options.allowIncreaseReason.trim().length > 0);
  const report = checkCodeHealth(repoRoot, {
    baselinePath,
    maxNewFileLines: options.maxNewFileLines,
  });

  const monolith = mergeRatchetSection(
    report.baseline.monolithMaxLines,
    report.observed.monolithMaxLines,
    allowIncrease,
  );
  const mocks = mergeRatchetSection(
    report.baseline.internalTestMocks,
    report.observed.internalTestMocks,
    allowIncrease,
  );
  const emojis = mergeRatchetSection(
    report.baseline.emojiAllowedFiles,
    report.observed.emojiAllowedFiles,
    allowIncrease,
  );
  const bareRandomUuid = mergeRatchetSection(
    report.baseline.bareRandomUuidFiles,
    report.observed.bareRandomUuidFiles,
    allowIncrease,
  );

  const blockedIncreases = [
    ...monolith.blockedIncreases.map((item) => ({ section: 'monolithMaxLines', ...item })),
    ...mocks.blockedIncreases.map((item) => ({ section: 'internalTestMocks', ...item })),
    ...emojis.blockedIncreases.map((item) => ({ section: 'emojiAllowedFiles', ...item })),
    ...bareRandomUuid.blockedIncreases.map((item) => ({ section: 'bareRandomUuidFiles', ...item })),
  ];

  const nextBaseline = {
    schema: 1,
    maxNewFileLines: report.baseline.maxNewFileLines,
    monolithMaxLines: monolith.next,
    internalTestMocks: mocks.next,
    emojiAllowedFiles: emojis.next,
    bareRandomUuidFiles: bareRandomUuid.next,
  };

  if (blockedIncreases.length === 0 || options.writePartial === true) {
    writeFileSync(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, 'utf8');
  }

  return {
    ok: blockedIncreases.length === 0,
    baselinePath,
    nextBaseline,
    blockedIncreases,
    stats: report.stats,
  };
}

function parseCliArgs(argv) {
  const parsed = {
    ratchet: false,
    allowIncreaseReason: '',
    hasAllowIncreaseFlag: false,
    root: DEFAULT_ROOT,
    baselinePath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ratchet') {
      parsed.ratchet = true;
    } else if (arg === '--allow-baseline-increase') {
      parsed.hasAllowIncreaseFlag = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.allowIncreaseReason = next;
        i += 1;
      }
    } else if (arg.startsWith('--allow-baseline-increase=')) {
      parsed.hasAllowIncreaseFlag = true;
      parsed.allowIncreaseReason = arg.slice('--allow-baseline-increase='.length);
    } else if (arg === '--root' && argv[i + 1]) {
      parsed.root = resolve(argv[++i]);
    } else if (arg === '--baseline' && argv[i + 1]) {
      parsed.baselinePath = resolve(argv[++i]);
    }
  }
  return parsed;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.hasAllowIncreaseFlag && cli.allowIncreaseReason.trim().length === 0) {
    console.error('check-code-health: --allow-baseline-increase requires a non-empty reason string');
    process.exit(1);
  }
  if (cli.hasAllowIncreaseFlag && !cli.ratchet) {
    console.error('check-code-health: --allow-baseline-increase can only be used together with --ratchet');
    process.exit(1);
  }

  if (cli.ratchet) {
    const res = applyRatchet(cli.root, {
      baselinePath: cli.baselinePath,
      allowIncreaseReason: cli.allowIncreaseReason,
    });
    if (!res.ok) {
      console.error(
        `check-code-health: --ratchet refuses to increase ${res.blockedIncreases.length} baseline entry(ies) without --allow-baseline-increase <reason>:`,
      );
      for (const item of res.blockedIncreases) {
        console.error(`  [${item.section}] ${item.file}: ${item.from} -> ${item.to}`);
      }
      process.exit(1);
    }
    if (cli.allowIncreaseReason.trim().length > 0) {
      console.error(
        `check-code-health: baseline updated with --allow-baseline-increase (${cli.allowIncreaseReason.trim()})`,
      );
    }
    console.log(
      `check-code-health: ratcheted baseline (${Object.keys(res.nextBaseline.monolithMaxLines).length} monoliths, ${Object.keys(res.nextBaseline.internalTestMocks).length} mock test files, ${Object.keys(res.nextBaseline.bareRandomUuidFiles).length} bare-randomUUID files, ${Object.keys(res.nextBaseline.emojiAllowedFiles).length} emoji files)`,
    );
    process.exit(0);
  }

  const startedAt = performance.now();
  const report = checkCodeHealth(cli.root, { baselinePath: cli.baselinePath });
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (!report.ok) {
    for (const v of report.violations) {
      console.error(formatCodeHealthViolation(v));
    }
    console.error(
      `check-code-health: FAILED with ${report.violations.length} violation(s) in ${elapsedMs}ms`,
    );
    process.exit(1);
  }

  const shrinkCount =
    report.ratchetSavings.monolithShrinks.length +
    report.ratchetSavings.mockShrinks.length +
    report.ratchetSavings.emojiShrinks.length +
    report.ratchetSavings.bareRandomUuidShrinks.length;
  const shrinkHint = shrinkCount > 0 ? ` (${shrinkCount} baseline(s) can be tightened via --ratchet)` : '';
  console.log(
    `check-code-health: OK (${report.stats.prodFilesScanned} prod files, ${report.stats.testFilesScanned} test files, ${report.stats.agentsDocsChecked} AGENTS.md, ${report.stats.monolithCount} frozen monoliths, ${elapsedMs}ms)${shrinkHint}`,
  );
}

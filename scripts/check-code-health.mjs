#!/usr/bin/env node
/* eslint-disable no-console -- Command-line deterministic code-health gate. */
import { spawnSync } from 'node:child_process';
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
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const PROD_EXCLUDE_SEGMENTS = new Set(['__tests__', '__fixtures__', 'test', 'tests', 'fixtures']);
const TEST_FILE_RE = /\.(?:test|spec|integration|e2e)\.[cm]?tsx?$/u;
const PROD_EXT_RE = /\.[cm]?tsx?$/u;
const NATIVE_DIALOG_RE = /(?<![\w$.])(?<!\.\s*)(?:(?:window|globalThis)\s*\.\s*)?(alert|confirm|prompt)\s*\(/gu;
const UUID_CALL_RE = /(?<![\w$.?])((?:(?:globalThis|window)\s*\.\s*)?crypto)\s*\.\s*randomUUID\s*\(/gu;
// Recognize a feature test only when it directly controls the guarded return.
const GUARDED_UUID_RE = /\bif\s*\(\s*typeof\s+((?:(?:globalThis|window)\s*\.\s*)?crypto)\s*(?:\?\.|\.)\s*randomUUID\s*===\s*(['"])function\2\s*\)\s*(?:\{\s*)?return[^\S\r\n]+$/u;
const DECORATIVE_EMOJI_RE = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)/gu;
const CATALOG_PATH_RE = /^(?:src|apps|packages|scripts|docs|config|\.agents|\.github|\.{1,2})[/\\]/u;

export const BANNED_DEFENSIVE_PHRASES = [
  { text: '数据可能已过期', caseInsensitive: false },
  { text: '结果可能不完整', caseInsensitive: false },
  { text: '部分用量或费用仍不完整', caseInsensitive: false },
  { text: '暂停状态可能已过期', caseInsensitive: false },
  { text: 'Data may be stale', caseInsensitive: true },
  { text: 'Results may be incomplete', caseInsensitive: true },
  { text: 'may be outdated', caseInsensitive: true },
];

const DEFENSIVE_COPY_PATTERNS = BANNED_DEFENSIVE_PHRASES.map(({ text, caseInsensitive }) => ({
  text,
  pattern: new RegExp(caseInsensitive ? text.replaceAll(' ', '\\s+') : Array.from(text).join('\\s*'), caseInsensitive ? 'giu' : 'gu'),
}));

function toPosix(filePath) {
  return filePath.split(sep).join('/');
}

function relPosix(root, absPath) {
  return toPosix(relative(root, absPath));
}

function walkFiles(dir, predicate, out = [], inSource = false) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(entry.name) && (entry.name !== 'build' || inSource)) {
        walkFiles(abs, predicate, out, inSource || entry.name === 'src');
      }
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
  return code.replaceAll(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (token) => token.startsWith('/') ? token.replaceAll(/[^\r\n]/gu, ' ') : token);
}

function isProductionSource(rel) {
  if (!PROD_EXT_RE.test(rel)) return false;
  if (/\.d\.[cm]?ts$/u.test(rel) || TEST_FILE_RE.test(rel)) return false;
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
  return parseBaseline(readFileSync(baselinePath, 'utf8'));
}

function parseBaseline(text) {
  const parsed = JSON.parse(text);
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

function gitOutput(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function baseBaselines(root, baselinePath, explicitPath) {
  if (explicitPath) return [parseBaseline(readFileSync(resolve(explicitPath), 'utf8'))];
  if (!existsSync(join(root, '.git'))) return [];
  const rel = relPosix(root, baselinePath);
  const prBase = process.env.GITHUB_BASE_REF?.trim();
  const refs = [process.env.KIKI_DIFF_BASE?.trim(), prBase && `origin/${prBase}`, prBase, 'origin/kiki'];
  const readAt = (ref) => gitOutput(root, ['show', `${ref}:${rel}`]);
  for (const ref of refs.filter(Boolean)) {
    const mergeBase = gitOutput(root, ['merge-base', '--', 'HEAD', ref]);
    if (!mergeBase) continue;
    const base = readAt(mergeBase);
    // Introducing the baseline on a branch with no baseline on its target is a bootstrap.
    if (base === undefined) return [];
    return [...new Set([base, readAt('HEAD')])].filter(Boolean).map(parseBaseline);
  }
  return [...new Set([readAt('HEAD^'), readAt('HEAD')])].filter(Boolean).map(parseBaseline);
}

function checkBaselineMonotonicity(baseline, bases, file, violations) {
  const report = (section, key, prev, next) => addViolation(
    violations, 'baseline-monotonicity', file, 1,
    `${section}${key ? ` for ${key}` : ''} increased from ${prev} to ${next}`,
    'Restore the prior allowance or tighten it with --ratchet',
  );
  const strictestCeiling = Math.min(baseline.maxNewFileLines, ...bases.map((base) => base.maxNewFileLines));
  if (baseline.maxNewFileLines > strictestCeiling) {
    report('maxNewFileLines', '', strictestCeiling, baseline.maxNewFileLines);
  }
  for (const section of ['monolithMaxLines', 'internalTestMocks', 'emojiAllowedFiles', 'bareRandomUuidFiles']) {
    const keys = new Set([...Object.keys(baseline[section]), ...bases.flatMap((base) => Object.keys(base[section]))]);
    for (const key of keys) {
      const next = baseline[section][key] ?? (section === 'monolithMaxLines' ? baseline.maxNewFileLines : 0);
      const prev = Math.min(...bases.map((base) => base[section][key] ?? (
        section === 'monolithMaxLines' ? Math.min(base.maxNewFileLines, baseline.maxNewFileLines) : 0
      )));
      if (next > prev) report(section, key, prev, next);
    }
  }
}

function isBuildOutputPlaceholder(dir, cleanPath) {
  if (!/(?:^|\/)dist(?:\/|$)/u.test(cleanPath)) return false;
  return existsSync(dirname(resolve(dir, cleanPath)));
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
  const bases = baseBaselines(repoRoot, baselinePath, options.baseBaselinePath);
  const baselineRel = relPosix(repoRoot, baselinePath);
  checkBaselineMonotonicity(baseline, bases, baselineRel, violations);
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
        if (raw.includes('mock') || raw.includes('doMock')) {
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
      const isMobileProd = rel.startsWith('apps/kiki-gui/mobile/src/');
      const isSessionCoreProd = rel.startsWith('packages/session-core/src/');
      const isSessionI18n = rel.startsWith('packages/session-core/src/i18n/');
      const needsTextScan = isGuiProd || isMobileProd || isSessionCoreProd;
      const raw = needsTextScan ? readFileSync(abs, 'utf8') : null;
      const lines = raw !== null ? countLines(raw) : countLinesBuffer(readFileSync(abs));
      const frozenMax = baseline.monolithMaxLines[rel];
      if (frozenMax !== undefined || lines > maxNewFileLines) {
        observedMonoliths[rel] = lines;
      }
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

      if (!needsTextScan || (!isGuiProd && !isMobileProd && !isSessionI18n && !raw.includes('randomUUID'))) continue;

      const stripped = stripCommentsPreservingLines(raw);
      if (isGuiProd || isMobileProd || (isSessionCoreProd && rel.endsWith('.ts'))) {
        const uuidHits = [...stripped.matchAll(UUID_CALL_RE)].filter((match) => {
          const guard = GUARDED_UUID_RE.exec(stripped.slice(0, match.index));
          return !guard || guard[1].replaceAll(/\s/gu, '') !== match[1].replaceAll(/\s/gu, '');
        });
        if (uuidHits.length > 0) observedBareRandomUuid[rel] = uuidHits.length;
        const allowedUuid = baseline.bareRandomUuidFiles[rel] ?? 0;
        if (uuidHits.length > allowedUuid) {
          addViolation(
            violations,
            'client-bare-random-uuid',
            rel,
            lineNumberAtOffset(stripped, uuidHits[allowedUuid].index),
            `Bare crypto.randomUUID() call (${uuidHits.length} > allowed ${allowedUuid}) crashes in Non-Secure Contexts (e.g. LAN http://192.168.x.x)`,
            'Use a crypto.getRandomValues()-backed randomUuid() helper (or optional-chained fallback) instead of bare crypto.randomUUID()',
          );
        }
      }

      if (!isGuiProd && !isMobileProd && !isSessionI18n) continue;
      if (isGuiProd || isMobileProd) {
        for (const match of stripped.matchAll(NATIVE_DIALOG_RE)) {
          addViolation(
            violations,
            'gui-native-dialog',
            rel,
            lineNumberAtOffset(stripped, match.index),
            `Forbidden native browser dialog "${match[1]}(" in GUI source`,
            'Use ConfirmDialog, Dialog, or pushUndoToast from apps/kiki-gui/src/components/ instead of blocking browser dialogs',
          );
        }
      }

      // Whitespace between words (or Han characters) can come from JSX layout or a template literal.
      const copy = stripped.replaceAll(/\{\s*['"]\s+['"]\s*\}|\{\s*\}/gu, (token) => token.replaceAll(/[^\r\n]/gu, ' '));
      for (const { text, pattern } of DEFENSIVE_COPY_PATTERNS) {
        for (const match of copy.matchAll(pattern)) {
          addViolation(
            violations,
            'gui-banned-defensive-copy',
            rel,
            lineNumberAtOffset(copy, match.index),
            `Banned defensive boundary disclaimer "${text}" found in UI copy`,
            'Fix the underlying freshness/completeness contract or remove the hedging disclaimer from visible UI text',
          );
        }
      }

      if (isGuiProd || isMobileProd) {
        const emojiHits = [...stripped.matchAll(DECORATIVE_EMOJI_RE)].map((match) => ({
          line: lineNumberAtOffset(stripped, match.index), glyph: match[0],
        }));
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
        if (!CATALOG_PATH_RE.test(rawToken)) continue;
        if (/[*<>{}[\]\s,|]/u.test(rawToken) || rawToken.includes('...') || rawToken.includes('…')) {
          continue;
        }
        if (rawToken.includes('\\')) {
          addViolation(violations, 'catalog-link-integrity', rel, line,
            `Catalog path \`${rawToken}\` uses Windows path separators`, 'Use POSIX / separators');
          continue;
        }
        const clean = rawToken.split(/[?#]/u, 1)[0].replace(/[),.;:]+$/u, '').replace(/:\d+(?::\d+)?$/u, '');
        if (isExplicitNonExistenceContext(text, match.index, match[0].length)) continue;
        const localSrc = clean.startsWith('src/');
        const pathRoot = localSrc || clean.startsWith('./') || clean.startsWith('../') ? dirAbs : repoRoot;
        const target = resolve(pathRoot, clean);
        const targetRel = relPosix(pathRoot, target);
        const escapesRoot = relPosix(repoRoot, target).startsWith('../');
        if (escapesRoot || (localSrc && !targetRel.startsWith('src/') && targetRel !== 'src') ||
            (!existsSync(target) &&
              !(clean.startsWith('docs/') && existsSync(resolve(dirAbs, clean))) &&
              !isBuildOutputPlaceholder(pathRoot, clean))) {
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
    if (current < frozen && (Object.hasOwn(observedMonoliths, rel) || frozen > maxNewFileLines)) {
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
    bases,
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
    baseBaselinePath: options.baseBaselinePath,
  });

  const monolith = mergeRatchetSection(
    report.baseline.monolithMaxLines,
    {
      ...Object.fromEntries(Object.entries(report.baseline.monolithMaxLines)
        .filter(([, cap]) => cap < report.baseline.maxNewFileLines)),
      ...report.observed.monolithMaxLines,
    },
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

  const baselineViolations = [];
  checkBaselineMonotonicity(nextBaseline, report.bases, relPosix(repoRoot, baselinePath), baselineViolations);
  if (baselineViolations.length === 0 && (blockedIncreases.length === 0 || options.writePartial === true)) {
    writeFileSync(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, 'utf8');
  }

  return {
    ok: blockedIncreases.length === 0 && baselineViolations.length === 0,
    baselineViolations,
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
    baseBaselinePath: undefined,
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
    } else if (arg === '--base-baseline' && argv[i + 1]) {
      parsed.baseBaselinePath = resolve(argv[++i]);
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
      baseBaselinePath: cli.baseBaselinePath,
      allowIncreaseReason: cli.allowIncreaseReason,
    });
    if (!res.ok) {
      for (const v of res.baselineViolations) console.error(formatCodeHealthViolation(v));
      if (res.blockedIncreases.length > 0) console.error(
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
  const report = checkCodeHealth(cli.root, cli);
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

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOT = path.resolve(import.meta.dirname, '..', '..');

const WALK_SKIP_DIRS = new Set([
  '.git',
  '.tmp',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

export const LEGACY_DISABLED_TEST_ALLOWLIST = new Set([
  'packages/kaos/test/internal.test.ts',
  'packages/node-sdk/test/session-plan-compact-usage-resume.test.ts',
]);

export const LEGACY_INTRA_MONOREPO_MOCK_ALLOWLIST = new Set([
  'packages/kap-server/test/documentPreview.officeRender.test.ts',
  'packages/kap-server/test/externalDelegationRouteProjection.test.ts',
  'packages/kap-server/test/externalDelegationSeats.test.ts',
  'packages/kap-server/test/notifications.integration.ts',
  'packages/kap-server/test/pluginOutboundIm.test.ts',
  'packages/kap-server/test/prompts.delivery.integration.ts',
  'packages/kap-server/test/prompts.integration.ts',
  'packages/kap-server/test/prompts.lifecycle.integration.ts',
  'packages/kap-server/test/prompts.media.integration.ts',
  'packages/kap-server/test/prompts.queue.integration.ts',
  'packages/kap-server/test/services/imSession/visibleReply.test.ts',
]);

const TEST_FILE_RE = /\.(?:test|spec|integration|e2e)\.[cm]?[jt]sx?$/u;
const INTEGRATION_TEST_FILE_RE = /\.integration\.[cm]?[jt]sx?$/u;
const DISABLED_TEST_RE = /^\s*(?:it|test|describe)\.(?:skip|todo)\s*\(/u;
const INTRA_MONOREPO_MOCK_GLOBAL_RE = /\b(?:vi\.(?:doM|m)ock|mock\.module)\s*\(\s*(?:import\s*\(\s*)?['"`]((?:#\/|@kiki\/|@nb-corp\/|\.\.?\/)[^'"`]+)['"`]/gu;
const SPY_OPTION_RE = /,\s*\{\s*spy\s*:\s*true\s*\}\s*\)$/u;
const IMPORT_ORIGINAL_FACTORY_RE = /,\s*(?:async\s*)?\(?\s*(?:importOriginal|original)\b/u;
const FAKE_OVERRIDE_IN_FACTORY_RE = /\bvi\.fn\s*\(|\bclass\s*\{/u;
const PURE_SPY_ON_EXPR_RE = /^vi\.spyOn\s*\(/u;
const WEAK_ASSERTION_RE = /\bexpect\.anything\s*\(\s*\)/u;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function extractBalancedCall(text, openParenIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openParenIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openParenIndex, i + 1);
    }
  }
  return text.slice(openParenIndex, Math.min(text.length, openParenIndex + 400));
}

function extractBalancedBraces(text, openBraceIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }
  return null;
}

function splitTopLevelObjectProps(objectLiteral) {
  const inner = objectLiteral.slice(1, -1);
  const props = [];
  let start = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;
    else if (ch === ',' && paren === 0 && brace === 0 && bracket === 0) {
      const piece = inner.slice(start, i).trim();
      if (piece.length > 0) props.push(piece);
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail.length > 0) props.push(tail);
  return props;
}

function hasDisallowedReturnedObjectOverride(callExpr) {
  const returnRe = /(?:\breturn\s*\(?|=>\s*\()\s*\{/gu;
  let match;
  while ((match = returnRe.exec(callExpr)) !== null) {
    const braceIdx = match.index + match[0].length - 1;
    const obj = extractBalancedBraces(callExpr, braceIdx);
    if (obj === null) return true;
    for (const prop of splitTopLevelObjectProps(obj)) {
      if (prop.startsWith('...')) continue;
      const colon = prop.indexOf(':');
      if (colon < 0) return true;
      const valueExpr = prop.slice(colon + 1).trim();
      if (!PURE_SPY_ON_EXPR_RE.test(valueExpr)) return true;
    }
  }
  return false;
}

function isExemptMockCall(callExpr) {
  if (SPY_OPTION_RE.test(callExpr)) return true;
  if (IMPORT_ORIGINAL_FACTORY_RE.test(callExpr)) {
    if (FAKE_OVERRIDE_IN_FACTORY_RE.test(callExpr)) return false;
    if (hasDisallowedReturnedObjectOverride(callExpr)) return false;
    return true;
  }
  return false;
}

function findIntraMonorepoMocks(text, lineNumberAtOffset) {
  const hits = [];
  INTRA_MONOREPO_MOCK_GLOBAL_RE.lastIndex = 0;
  let match;
  while ((match = INTRA_MONOREPO_MOCK_GLOBAL_RE.exec(text)) !== null) {
    const openParen = text.indexOf('(', match.index);
    const callExpr = openParen >= 0 ? extractBalancedCall(text, openParen) : match[0];
    if (isExemptMockCall(callExpr)) continue;
    hits.push({
      line: lineNumberAtOffset(match.index),
      target: match[1],
      text: match[0].replace(/\s+/gu, ' ').trim(),
    });
  }
  return hits;
}

const registeredContracts = [];

const TRIVIAL_INVARIANT_RE = /^\s*(?:tests?|checks?|verifies?)\s+(?:that\s+)?(?:internal\s+)?(?:helper|function|method)\b[\s\S]*\breturns?\b/iu;
const COVERS_REPO_FILE_RE = /^(?:packages|apps|scripts)\/[^\s:]+\.[cm]?[jt]sx?$/u;

export function defineTestContract(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('defineTestContract requires a specification object');
  }
  if (typeof spec.invariant !== 'string' || spec.invariant.trim().length < 12) {
    throw new Error('defineTestContract requires a non-empty @invariant description (>= 12 chars)');
  }
  if (TRIVIAL_INVARIANT_RE.test(spec.invariant)) {
    throw new Error('defineTestContract @invariant must state a user-perceivable invariant or physical boundary, not an internal helper return value');
  }
  if (typeof spec.mechanism !== 'string' || spec.mechanism.trim().length < 12) {
    throw new Error('defineTestContract requires a non-empty @mechanism description (>= 12 chars)');
  }
  const rawCovers = Array.isArray(spec.covers)
    ? spec.covers
    : typeof spec.covers === 'string'
      ? [spec.covers]
      : [];
  const covers = rawCovers.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean);
  if (covers.length === 0) {
    throw new Error('defineTestContract requires @covers binding to at least one public route or entrypoint path');
  }
  const sunsetWhen = typeof spec.sunset_when === 'string' ? spec.sunset_when.trim() : '';
  if (sunsetWhen.length < 12) {
    throw new Error('defineTestContract requires a non-empty @sunset_when physical deletion condition (>= 12 chars)');
  }
  const sunset = spec.sunset;
  if (!sunset || typeof sunset !== 'object' || typeof sunset.kind !== 'string') {
    throw new Error('defineTestContract requires a typed sunset trigger');
  }
  switch (sunset.kind) {
    case 'flagRemoved':
      if (typeof sunset.flag !== 'string' || sunset.flag.trim().length === 0) {
        throw new Error('flagRemoved sunset requires a non-empty flag id');
      }
      break;
    case 'symbolRemoved':
      if (typeof sunset.file !== 'string' || typeof sunset.symbol !== 'string' || !sunset.file || !sunset.symbol) {
        throw new Error('symbolRemoved sunset requires { file, symbol }');
      }
      break;
    case 'routeRemoved':
      if (typeof sunset.method !== 'string' || typeof sunset.path !== 'string' || !sunset.method || !sunset.path) {
        throw new Error('routeRemoved sunset requires { method, path }');
      }
      break;
    case 'expires':
      if (typeof sunset.date !== 'string' || !ISO_DATE_RE.test(sunset.date)) {
        throw new Error('expires sunset requires ISO date YYYY-MM-DD');
      }
      if (typeof sunset.ticket !== 'string' || sunset.ticket.trim().length === 0) {
        throw new Error('expires sunset requires a non-empty ticket reference');
      }
      break;
    case 'permanent':
      break;
    default:
      throw new Error(`Unsupported sunset trigger kind: ${String(sunset.kind)}`);
  }

  const normalized = Object.freeze({
    invariant: spec.invariant.trim(),
    mechanism: spec.mechanism.trim(),
    covers: Object.freeze(covers),
    sunset_when: sunsetWhen,
    sunset: Object.freeze({ ...sunset }),
    tags: Object.freeze(Array.isArray(spec.tags) ? [...spec.tags] : []),
  });
  registeredContracts.push(normalized);
  return normalized;
}

export function getRegisteredTestContracts() {
  return [...registeredContracts];
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(entry.name)) walkFiles(abs, predicate, out);
    } else if (entry.isFile() && predicate(abs, entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

export function collectRegisteredFlagIds(repoRoot = DEFAULT_ROOT) {
  const srcDir = path.join(repoRoot, 'packages', 'agent-core-v2', 'src');
  const flagIds = new Set();
  if (!fs.existsSync(srcDir)) return flagIds;

  const files = walkFiles(srcDir, (_abs, name) => name.endsWith('.ts'));
  for (const abs of files) {
    const content = fs.readFileSync(abs, 'utf8');
    if (!content.includes('registerFlagDefinition')) continue;

    const constMap = new Map();
    for (const m of content.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*['"]([a-z0-9_.-]+)['"]/gu)) {
      constMap.set(m[1], m[2]);
    }
    for (const m of content.matchAll(/\bid\s*:\s*['"]([a-z0-9_.-]+)['"]/gu)) {
      flagIds.add(m[1]);
    }
    for (const m of content.matchAll(/\bid\s*:\s*([A-Z][A-Z0-9_]+)/gu)) {
      const resolved = constMap.get(m[1]);
      if (resolved) flagIds.add(resolved);
    }
  }
  return flagIds;
}

export function collectRegisteredRoutes(repoRoot = DEFAULT_ROOT) {
  const routesDir = path.join(repoRoot, 'packages', 'kap-server', 'src', 'routes');
  const routes = new Set();
  if (!fs.existsSync(routesDir)) return routes;

  const files = walkFiles(routesDir, (_abs, name) => name.endsWith('.ts'));
  for (const abs of files) {
    const content = fs.readFileSync(abs, 'utf8');
    for (const m of content.matchAll(/method\s*:\s*['"]([A-Z]+)['"][\s\S]{0,120}?path\s*:\s*['"]([^'"]+)['"]/gu)) {
      routes.add(`${m[1].toUpperCase()} ${m[2]}`);
      if (!m[2].startsWith('/api/')) {
        routes.add(`${m[1].toUpperCase()} /api${m[2].startsWith('/') ? '' : '/'}${m[2]}`);
      }
    }
    for (const m of content.matchAll(/\bapp\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gu)) {
      routes.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return routes;
}

function fileExportsSymbol(repoRoot, relFile, symbolName) {
  const abs = path.resolve(repoRoot, relFile);
  if (!fs.existsSync(abs)) return false;
  const content = fs.readFileSync(abs, 'utf8');
  const escaped = symbolName.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const directRe = new RegExp(
    `\\bexport\\s+(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b`,
    'u',
  );
  if (directRe.test(content)) return true;
  const namedExportRe = new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, 'u');
  return namedExportRe.test(content);
}

export function validateSunsetTrigger(trigger, { repoRoot = DEFAULT_ROOT, nowDate = new Date().toISOString().slice(0, 10), flagIds, routes } = {}) {
  if (!trigger || typeof trigger !== 'object') {
    return { valid: false, reason: 'Missing sunset trigger object' };
  }
  switch (trigger.kind) {
    case 'permanent':
      return { valid: true };
    case 'expires': {
      if (!ISO_DATE_RE.test(trigger.date ?? '')) {
        return { valid: false, reason: `Invalid ISO expiry date: ${String(trigger.date)}` };
      }
      if (trigger.date < nowDate) {
        return { valid: false, reason: `Sunset expired on ${trigger.date} (today ${nowDate}, ticket ${trigger.ticket})` };
      }
      return { valid: true };
    }
    case 'flagRemoved': {
      const knownFlags = flagIds ?? collectRegisteredFlagIds(repoRoot);
      if (!knownFlags.has(trigger.flag)) {
        return { valid: false, reason: `Flag "${trigger.flag}" no longer exists in registerFlagDefinition — delete or retire this test` };
      }
      return { valid: true };
    }
    case 'symbolRemoved': {
      if (!fileExportsSymbol(repoRoot, trigger.file, trigger.symbol)) {
        return { valid: false, reason: `Symbol "${trigger.symbol}" is no longer exported by "${trigger.file}" — delete or retire this test` };
      }
      return { valid: true };
    }
    case 'routeRemoved': {
      const knownRoutes = routes ?? collectRegisteredRoutes(repoRoot);
      const key = `${String(trigger.method).toUpperCase()} ${trigger.path}`;
      if (!knownRoutes.has(key)) {
        return { valid: false, reason: `Route "${key}" no longer exists in kap-server routes — delete or retire this test` };
      }
      return { valid: true };
    }
    default:
      return { valid: false, reason: `Unknown sunset kind: ${String(trigger.kind)}` };
  }
}

export function extractInlineContracts(filePath, content) {
  const found = [];
  const headRe = /(?:^|\n)[ \t]*defineTestContract\s*\(\s*\{/gu;
  let match;
  while ((match = headRe.exec(content)) !== null) {
    const braceStart = content.indexOf('{', match.index);
    let depth = 0;
    let inQuote = null;
    let end = -1;
    for (let i = braceStart; i < content.length; i += 1) {
      const ch = content[i];
      if (inQuote) {
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (ch === inQuote) inQuote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inQuote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    const snippet = content.slice(braceStart, end);
    const line = content.slice(0, match.index).split('\n').length;
    const invariant = /\binvariant\s*:\s*['"`]([^'"`]+)['"`]/u.exec(snippet)?.[1]?.trim() ?? '';
    const mechanism = /\bmechanism\s*:\s*['"`]([^'"`]+)['"`]/u.exec(snippet)?.[1]?.trim() ?? '';
    const sunsetWhen = /\bsunset_when\s*:\s*['"`]([^'"`]+)['"`]/u.exec(snippet)?.[1]?.trim() ?? '';
    const covers = [];
    const coversArrMatch = /\bcovers\s*:\s*\[([\s\S]*?)\]/u.exec(snippet);
    if (coversArrMatch) {
      for (const item of coversArrMatch[1].matchAll(/['"`]([^'"`]+)['"`]/gu)) {
        if (item[1].trim()) covers.push(item[1].trim());
      }
    } else {
      const singleCover = /\bcovers\s*:\s*['"`]([^'"`]+)['"`]/u.exec(snippet)?.[1]?.trim();
      if (singleCover) covers.push(singleCover);
    }
    const kind = /\bkind\s*:\s*['"]([a-zA-Z]+)['"]/u.exec(snippet)?.[1] ?? '';
    const trigger = kind ? { kind } : null;
    if (trigger && kind === 'flagRemoved') {
      trigger.flag = /\bflag\s*:\s*['"]([^'"]+)['"]/u.exec(snippet)?.[1] ?? '';
    } else if (trigger && kind === 'symbolRemoved') {
      trigger.file = /\bfile\s*:\s*['"]([^'"]+)['"]/u.exec(snippet)?.[1] ?? '';
      trigger.symbol = /\bsymbol\s*:\s*['"]([^'"]+)['"]/u.exec(snippet)?.[1] ?? '';
    } else if (trigger && kind === 'routeRemoved') {
      trigger.method = /\bmethod\s*:\s*['"]([^'"]+)['"]/u.exec(snippet)?.[1] ?? '';
      trigger.path = /\bpath\s*:\s*['"]([^'"]+)['"]/u.exec(snippet)?.[1] ?? '';
    } else if (trigger && kind === 'expires') {
      trigger.date = /\bdate\s*:\s*['"]([^'"]+)['"]/u.exec(snippet)?.[1] ?? '';
      trigger.ticket = /\bticket\s*:\s*['"]([^'"]+)['"]/u.exec(snippet)?.[1] ?? '';
    }
    found.push({ file: filePath, line, invariant, mechanism, covers, sunsetWhen, trigger });
  }
  return found;
}

export function scanDisabledTests(repoRoot = DEFAULT_ROOT, { allowlist = LEGACY_DISABLED_TEST_ALLOWLIST, roots = ['packages', 'apps', 'scripts'] } = {}) {
  const violations = [];
  const legacyExempted = [];
  for (const sub of roots) {
    const dir = path.join(repoRoot, sub);
    const files = walkFiles(dir, (_abs, name) => TEST_FILE_RE.test(name));
    for (const abs of files) {
      const rel = toPosix(path.relative(repoRoot, abs));
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/u);
      for (let i = 0; i < lines.length; i += 1) {
        if (DISABLED_TEST_RE.test(lines[i])) {
          const hit = { file: rel, line: i + 1, text: lines[i].trim() };
          if (allowlist.has(rel)) legacyExempted.push(hit);
          else violations.push(hit);
        }
      }
    }
  }
  return { violations, legacyExempted };
}

export function scanIntraMonorepoMocks(
  repoRoot = DEFAULT_ROOT,
  { allowlist = LEGACY_INTRA_MONOREPO_MOCK_ALLOWLIST, roots = ['packages', 'apps', 'scripts'] } = {},
) {
  const violations = [];
  const legacyExempted = [];
  for (const sub of roots) {
    const dir = path.join(repoRoot, sub);
    const files = walkFiles(dir, (abs, name) => {
      if (!TEST_FILE_RE.test(name)) return false;
      const rel = toPosix(path.relative(repoRoot, abs));
      return rel.startsWith('packages/kap-server/test/') || INTEGRATION_TEST_FILE_RE.test(name);
    });
    for (const abs of files) {
      const rel = toPosix(path.relative(repoRoot, abs));
      const content = fs.readFileSync(abs, 'utf8');
      const lineNumberAtOffset = (offset) => content.slice(0, offset).split('\n').length;
      for (const found of findIntraMonorepoMocks(content, lineNumberAtOffset)) {
        const hit = { file: rel, line: found.line, target: found.target, text: found.text };
        if (allowlist.has(rel)) legacyExempted.push(hit);
        else violations.push(hit);
      }
    }
  }
  return { violations, legacyExempted };
}

export function checkDiffMockRatchet({ repoRoot = DEFAULT_ROOT, baseRef, diffText } = {}) {
  let rawDiff = diffText;
  if (rawDiff === undefined) {
    const args = baseRef ? ['diff', '-U0', `${baseRef}...HEAD`] : ['diff', '-U0', 'HEAD'];
    const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    rawDiff = res.status === 0 ? res.stdout : '';
  }

  const mockViolations = [];
  const weakAssertionViolations = [];
  const disabledAddedViolations = [];

  let currentFile = null;
  let currentLine = 0;
  let addedHunk = [];
  const flushHunk = () => {
    if (!currentFile || addedHunk.length === 0) {
      addedHunk = [];
      return;
    }
    const hunkText = addedHunk.map((entry) => entry.text).join('\n');
    const offsets = [];
    let cursor = 0;
    for (const entry of addedHunk) {
      offsets.push({ start: cursor, line: entry.line });
      cursor += entry.text.length + 1;
    }
    const lineNumberAtOffset = (offset) => {
      let line = addedHunk[0].line;
      for (const item of offsets) {
        if (item.start <= offset) line = item.line;
        else break;
      }
      return line;
    };
    for (const found of findIntraMonorepoMocks(hunkText, lineNumberAtOffset)) {
      mockViolations.push({
        file: currentFile,
        line: found.line,
        target: found.target,
        text: found.text,
      });
    }
    addedHunk = [];
  };

  for (const rawLine of rawDiff.split(/\r?\n/u)) {
    if (rawLine.startsWith('+++ b/')) {
      flushHunk();
      currentFile = rawLine.slice('+++ b/'.length).trim();
      continue;
    }
    if (rawLine.startsWith('@@ ')) {
      flushHunk();
      const m = /\+(\d+)/u.exec(rawLine);
      currentLine = m ? Number.parseInt(m[1], 10) - 1 : 0;
      continue;
    }
    if (!currentFile || !TEST_FILE_RE.test(currentFile) || currentFile === 'scripts/ccp-chaos/ccp-chaos.test.mjs') continue;
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      currentLine += 1;
      const added = rawLine.slice(1);
      addedHunk.push({ line: currentLine, text: added });
      if (WEAK_ASSERTION_RE.test(added)) {
        weakAssertionViolations.push({
          file: currentFile,
          line: currentLine,
          text: added.trim(),
        });
      }
      if (DISABLED_TEST_RE.test(added)) {
        disabledAddedViolations.push({
          file: currentFile,
          line: currentLine,
          text: added.trim(),
        });
      }
    } else {
      flushHunk();
    }
  }
  flushHunk();

  return {
    mockViolations,
    weakAssertionViolations,
    disabledAddedViolations,
  };
}

export function runTestHygieneCheck({ repoRoot = DEFAULT_ROOT, baseRef, diffText, nowDate = new Date().toISOString().slice(0, 10), scanRoots = ['packages', 'apps', 'scripts'] } = {}) {
  const flagIds = collectRegisteredFlagIds(repoRoot);
  const routes = collectRegisteredRoutes(repoRoot);
  const contractFailures = [];
  let contractsChecked = 0;

  for (const sub of scanRoots) {
    const dir = path.join(repoRoot, sub);
    const files = walkFiles(dir, (_abs, name) => TEST_FILE_RE.test(name));
    for (const abs of files) {
      const rel = toPosix(path.relative(repoRoot, abs));
      const content = fs.readFileSync(abs, 'utf8');
      if (!content.includes('defineTestContract')) continue;
      for (const entry of extractInlineContracts(rel, content)) {
        contractsChecked += 1;
        const missing = [];
        if (entry.invariant.length < 12) missing.push('@invariant (>=12 chars)');
        else if (TRIVIAL_INVARIANT_RE.test(entry.invariant)) missing.push('@invariant (must state user-visible invariant, not internal helper return)');
        if (entry.mechanism.length < 12) missing.push('@mechanism (>=12 chars)');
        if (entry.covers.length === 0) missing.push('@covers (public route or entrypoint)');
        if (entry.sunsetWhen.length < 12) missing.push('@sunset_when (>=12 chars deletion rule)');
        if (!entry.trigger) missing.push('sunset trigger');
        if (missing.length > 0) {
          contractFailures.push({
            file: entry.file,
            line: entry.line,
            trigger: entry.trigger,
            reason: `Incomplete defineTestContract — missing/invalid ${missing.join(', ')}`,
          });
          continue;
        }
        for (const coverTarget of entry.covers) {
          if (COVERS_REPO_FILE_RE.test(coverTarget) && !fs.existsSync(path.resolve(repoRoot, coverTarget))) {
            contractFailures.push({
              file: entry.file,
              line: entry.line,
              trigger: entry.trigger,
              reason: `@covers target "${coverTarget}" was removed — @sunset_when: ${entry.sunsetWhen} (physically delete obsolete test instead of shimming)`,
            });
          }
        }
        const result = validateSunsetTrigger(entry.trigger, { repoRoot, nowDate, flagIds, routes });
        if (!result.valid) {
          contractFailures.push({
            file: entry.file,
            line: entry.line,
            trigger: entry.trigger,
            reason: `${result.reason} — @sunset_when: ${entry.sunsetWhen}`,
          });
        }
      }
    }
  }

  const disabled = scanDisabledTests(repoRoot, { roots: scanRoots });
  const intraMonorepoMocks = scanIntraMonorepoMocks(repoRoot, { roots: scanRoots });
  const diffRatchet = checkDiffMockRatchet({ repoRoot, baseRef, diffText });

  const ok =
    contractFailures.length === 0 &&
    disabled.violations.length === 0 &&
    intraMonorepoMocks.violations.length === 0 &&
    diffRatchet.mockViolations.length === 0 &&
    diffRatchet.disabledAddedViolations.length === 0;

  return {
    ok,
    nowDate,
    discoveredFlagsCount: flagIds.size,
    discoveredRoutesCount: routes.size,
    contractsChecked,
    contractFailures,
    disabledTests: disabled,
    intraMonorepoMocks,
    diffRatchet,
  };
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  let baseRef;
  let enforce = false;
  let asJson = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--base' && args[i + 1]) baseRef = args[++i];
    else if (args[i] === '--enforce') enforce = true;
    else if (args[i] === '--json') asJson = true;
  }
  const report = runTestHygieneCheck({ repoRoot: DEFAULT_ROOT, baseRef });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[test-hygiene] ok=${report.ok} flags=${report.discoveredFlagsCount} routes=${report.discoveredRoutesCount} contracts=${report.contractsChecked} contractFailures=${report.contractFailures.length} unexemptedDisabled=${report.disabledTests.violations.length} legacyDisabled=${report.disabledTests.legacyExempted.length} unexemptedTreeMocks=${report.intraMonorepoMocks.violations.length} legacyTreeMocks=${report.intraMonorepoMocks.legacyExempted.length} diffMocks=${report.diffRatchet.mockViolations.length}\n`,
    );
    for (const f of report.contractFailures) {
      process.stderr.write(`  [SUNSET] ${f.file}:${f.line} ${f.reason}\n`);
    }
    for (const d of report.disabledTests.violations) {
      process.stderr.write(`  [DISABLED] ${d.file}:${d.line} ${d.text}\n`);
    }
    for (const m of report.intraMonorepoMocks.violations) {
      process.stderr.write(`  [TREE-MOCK] ${m.file}:${m.line} intra-monorepo mock "${m.target}"\n`);
    }
    for (const m of report.diffRatchet.mockViolations) {
      process.stderr.write(`  [VI.MOCK] ${m.file}:${m.line} intra-monorepo mock "${m.target}"\n`);
    }
  }
  if (enforce && !report.ok) {
    process.exit(1);
  }
}

#!/usr/bin/env node
/* eslint-disable no-console -- This file is a command-line checker. */
/**
 * Deterministic repository meta-information anti-rot gate.
 * Runs 8 fast checks covering CLAUDE.md pointer, workspace parity, retired
 * scopes, meta-doc links, MAINTAINERS.md routing, word budgets, package
 * dependency/global boundaries, and workspace sync + scratch-file hygiene.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as defaultBoundaries from '../config/repo-boundaries.mjs';
import {
  buildWorkspacePackages,
  checkNixWorkspace,
  expandWorkspaceGlobs,
  getWorkspaceGlobs,
  normalizeWorkspaceDir,
} from './check-nix-workspace.mjs';
import { runTestHygieneCheck } from './ccp-chaos/check-test-hygiene.mjs';

const DEFAULT_ROOT = resolve(import.meta.dirname, '..');
const READ_CONCURRENCY = 64;

const WALK_SKIP_DIRS = new Set([
  '.git',
  '.gradle',
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

const REPO_PATH_PREFIX_RE = /^(?:apps|packages|scripts|docs|config|\.agents|\.github)\//;
const SINGLE_LINE_FROM_RE =
  /^\s*(?:import|export)\s+(?:type\s+)?[^'"\r\n]*?\bfrom\s+['"]([^'"\r\n]+)['"]/;
const MULTILINE_CLOSE_FROM_RE = /^\s*\}\s*from\s+['"]([^'"\r\n]+)['"]/;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"\r\n]+)['"]/;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g;

function toPosix(filePath) {
  return filePath.split(sep).join('/');
}

function relPosix(root, absPath) {
  return toPosix(relative(root, absPath));
}

function addViolation(errors, rule, file, line, message, fix) {
  errors.push({
    rule,
    file: toPosix(file),
    line: line ?? 1,
    message: message.replace(/\.+$/, ''),
    fix: fix.replace(/\.+$/, ''),
  });
}

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(entry.name)) walkFiles(abs, predicate, out);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && predicate(abs, entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

function listGitFiles(root, extraArgs = []) {
  if (!existsSync(join(root, '.git'))) return null;
  const result = spawnSync('git', ['ls-files', '-z', ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stdout === undefined) return null;
  return result.stdout.split('\0').filter(Boolean);
}

function collectRepoInventory(root, providedTracked) {
  const trackedList = providedTracked !== undefined ? providedTracked : listGitFiles(root);
  const trackedSet = trackedList === null ? null : new Set(trackedList);

  let allFiles;
  if (trackedSet !== null && providedTracked === undefined) {
    const liveList = listGitFiles(root, ['--cached', '--others', '--exclude-standard']);
    allFiles = liveList ?? [...trackedSet];
  } else {
    allFiles = walkFiles(root, () => true).map((abs) => relPosix(root, abs));
  }
  allFiles.sort((a, b) => a.localeCompare(b));

  const claudeFiles = [];
  const agentsAndMaintainers = [];
  const scopeScanDocs = [];

  for (const rel of allFiles) {
    const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    if (base === 'CLAUDE.md') {
      claudeFiles.push(rel);
      scopeScanDocs.push(rel);
    } else if (base === 'AGENTS.md' || base === 'MAINTAINERS.md') {
      agentsAndMaintainers.push(rel);
      scopeScanDocs.push(rel);
    } else if (rel.startsWith('docs/maintainer/') && base.endsWith('.md')) {
      scopeScanDocs.push(rel);
    }
  }

  return {
    trackedSet,
    allFiles,
    claudeFiles,
    agentsAndMaintainers,
    scopeScanDocs,
  };
}

function splitOutsideFences(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence;
  return lines.map((line, index) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      const marker = match[1][0];
      const width = match[1].length;
      if (fence === undefined) fence = { marker, width };
      else if (marker === fence.marker && width >= fence.width) fence = undefined;
      return { line: index + 1, text: '', fenced: true };
    }
    return { line: index + 1, text: fence === undefined ? line : '', fenced: fence !== undefined };
  });
}

function findLineNumber(text, needle) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return 1;
}

function checkClaudeMdPointer(root, inventory, errors) {
  const rootClaude = join(root, 'CLAUDE.md');
  if (!existsSync(rootClaude)) {
    addViolation(
      errors,
      'claude-md-pointer',
      'CLAUDE.md',
      1,
      'Root CLAUDE.md is missing',
      'Create CLAUDE.md containing `@AGENTS.md`',
    );
  }

  for (const rel of inventory.claudeFiles) {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(abs);
      const resolvedTarget = resolve(dirname(abs), target);
      const expectedTarget = join(dirname(abs), 'AGENTS.md');
      if (resolvedTarget !== expectedTarget) {
        addViolation(
          errors,
          'claude-md-pointer',
          rel,
          1,
          `CLAUDE.md symlink points to "${target}" instead of sibling AGENTS.md`,
          'Point the CLAUDE.md symlink to AGENTS.md or replace it with `@AGENTS.md`',
        );
      }
      continue;
    }

    const content = readFileSync(abs, 'utf8').trim();
    if (content !== '@AGENTS.md') {
      addViolation(
        errors,
        'claude-md-pointer',
        rel,
        1,
        `CLAUDE.md must be a single-source include directive "@AGENTS.md" (found "${content.slice(0, 60)}")`,
        'Set CLAUDE.md content to `@AGENTS.md`',
      );
    }
  }
}

function parseWorkspaceMapEntries(agentsContent) {
  const lines = agentsContent.split(/\r?\n/);
  let sectionLine = -1;
  let endLine = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Workspace Map\s*$/.test(lines[i])) {
      sectionLine = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s+/.test(lines[j])) {
          endLine = j;
          break;
        }
      }
      break;
    }
  }

  const entries = new Map();
  if (sectionLine === -1) return { sectionLine, entries };

  for (let i = sectionLine; i < endLine; i++) {
    const line = lines[i];
    const tableMatch = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (tableMatch) {
      entries.set(normalizeWorkspaceDir(tableMatch[1]), i + 1);
      continue;
    }
    const bulletMatch = line.match(/^\s*-\s+`([^`]+)`\s*:/);
    if (bulletMatch) {
      entries.set(normalizeWorkspaceDir(bulletMatch[1]), i + 1);
    }
  }

  return { sectionLine, entries };
}

function hasRealNonNodeModulesContent(dirAbs, root, trackedSet) {
  if (existsSync(join(dirAbs, 'package.json'))) return true;
  if (trackedSet !== null) {
    const prefix = `${relPosix(root, dirAbs)}/`;
    for (const file of trackedSet) {
      if (file.startsWith(prefix)) return true;
    }
    return false;
  }
  const entries = readdirSync(dirAbs, { withFileTypes: true });
  return entries.some((entry) => entry.name !== 'node_modules');
}

function checkWorkspaceAgentsParity(root, boundaries, inventory, errors) {
  const yamlPath = join(root, 'pnpm-workspace.yaml');
  const agentsPath = join(root, 'AGENTS.md');
  if (!existsSync(yamlPath) || !existsSync(agentsPath)) {
    if (!existsSync(agentsPath)) {
      addViolation(
        errors,
        'workspace-agents-parity',
        'AGENTS.md',
        1,
        'Root AGENTS.md is missing',
        'Create AGENTS.md with a ## Workspace Map section',
      );
    }
    return;
  }

  const dirs = expandWorkspaceGlobs(root, getWorkspaceGlobs(root));
  const workspacePackages = buildWorkspacePackages(root, dirs);
  const nonNpmSurfaces = (boundaries.NON_NPM_SURFACES ?? []).map(normalizeWorkspaceDir);
  const ignoredDirs = boundaries.IGNORED_NON_WORKSPACE_DIRS ?? new Set();

  const expectedDirs = new Set([
    ...workspacePackages.map((pkg) => pkg.dir),
    ...nonNpmSurfaces,
  ]);

  const agentsContent = readFileSync(agentsPath, 'utf8');
  const { sectionLine, entries } = parseWorkspaceMapEntries(agentsContent);
  if (sectionLine === -1) {
    addViolation(
      errors,
      'workspace-agents-parity',
      'AGENTS.md',
      1,
      'Root AGENTS.md is missing a "## Workspace Map" section',
      'Add a "## Workspace Map" section listing every workspace package and non-npm surface',
    );
    return;
  }

  for (const dir of [...expectedDirs].toSorted((a, b) => a.localeCompare(b))) {
    if (!existsSync(join(root, ...dir.split('/')))) {
      addViolation(
        errors,
        'workspace-agents-parity',
        'config/repo-boundaries.mjs',
        1,
        `Registered surface "${dir}" does not exist on disk`,
        `Remove "${dir}" from NON_NPM_SURFACES or restore the directory`,
      );
      continue;
    }
    if (!entries.has(dir)) {
      addViolation(
        errors,
        'workspace-agents-parity',
        'AGENTS.md',
        sectionLine,
        `Workspace project or surface "${dir}" is missing from ## Workspace Map`,
        `Add a row for \`${dir}\` to ## Workspace Map in AGENTS.md`,
      );
    }
  }

  for (const [dir, line] of entries.entries()) {
    const abs = join(root, ...dir.split('/'));
    if (!existsSync(abs)) {
      addViolation(
        errors,
        'workspace-agents-parity',
        'AGENTS.md',
        line,
        `Workspace Map entry "${dir}" does not exist on disk`,
        `Remove stale entry \`${dir}\` from ## Workspace Map in AGENTS.md`,
      );
    } else if (!expectedDirs.has(dir)) {
      addViolation(
        errors,
        'workspace-agents-parity',
        'AGENTS.md',
        line,
        `Workspace Map entry "${dir}" is not in pnpm-workspace.yaml or NON_NPM_SURFACES`,
        `Remove \`${dir}\` from ## Workspace Map or register it in pnpm-workspace.yaml / config/repo-boundaries.mjs`,
      );
    }
  }

  for (const base of ['apps', 'packages']) {
    const baseAbs = join(root, base);
    if (!existsSync(baseAbs)) continue;
    for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relDir = `${base}/${entry.name}`;
      if (expectedDirs.has(relDir) || ignoredDirs.has(relDir)) continue;
      if (!hasRealNonNodeModulesContent(join(baseAbs, entry.name), root, inventory.trackedSet)) {
        continue;
      }
      addViolation(
        errors,
        'workspace-agents-parity',
        relDir,
        1,
        `Unregistered directory "${relDir}" is neither a workspace package nor listed in NON_NPM_SURFACES`,
        `Add a named package.json, register "${relDir}" in NON_NPM_SURFACES / IGNORED_NON_WORKSPACE_DIRS, or remove the stale directory`,
      );
    }
  }
}

function checkBannedStaleScopes(root, boundaries, inventory, errors) {
  const patterns = boundaries.RETIRED_SCOPE_PATTERNS ?? [];
  for (const rel of inventory.scopeScanDocs) {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
    const lines = splitOutsideFences(readFileSync(abs, 'utf8'));
    for (const { line, text } of lines) {
      if (!text || text.includes('<!-- historical -->')) continue;
      for (const { pattern, fix } of patterns) {
        const re = new RegExp(pattern.source, pattern.flags);
        const matches = [...text.matchAll(re)];
        if (matches.length === 0) continue;
        const found = [...new Set(matches.map((m) => m[0]))].join(', ');
        addViolation(
          errors,
          'banned-stale-scopes',
          rel,
          line,
          `Retired scope or removed path reference found: ${found}`,
          fix,
        );
      }
    }
  }
}

function isBuildOutputPlaceholder(root, cleanPath) {
  if (!/(?:^|\/)dist(?:\/|$)/.test(cleanPath)) return false;
  const parent = dirname(resolve(root, cleanPath));
  return existsSync(parent);
}

function checkMetaDocLinks(root, inventory, errors) {
  const repoAbs = resolve(root);

  for (const rel of inventory.agentsAndMaintainers) {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    const dirAbs = dirname(abs);
    const lines = splitOutsideFences(readFileSync(abs, 'utf8'));

    for (const { line, text } of lines) {
      if (!text) continue;

      const withoutInlineCode = text.replaceAll(/`[^`\r\n]*`/g, '');
      const linkTargets = [];
      const inlineRe =
        /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
      for (const match of withoutInlineCode.matchAll(inlineRe)) linkTargets.push(match[1]);
      const defRe = /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/g;
      for (const match of withoutInlineCode.matchAll(defRe)) linkTargets.push(match[1]);

      for (const rawTarget of linkTargets) {
        let target = rawTarget.trim();
        if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
        if (
          !target ||
          target.startsWith('#') ||
          target.startsWith('/') ||
          target.startsWith('//') ||
          /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
        ) {
          continue;
        }
        const stripped = target.split('#', 1)[0].split('?', 1)[0];
        let decoded;
        try {
          decoded = decodeURIComponent(stripped);
        } catch {
          addViolation(
            errors,
            'meta-doc-links',
            rel,
            line,
            `Invalid URL encoding in relative link "${target}"`,
            `Fix or remove the malformed link "${target}"`,
          );
          continue;
        }
        const resolved = resolve(dirAbs, decoded);
        if (resolved !== repoAbs && !resolved.startsWith(`${repoAbs}${sep}`)) {
          addViolation(
            errors,
            'meta-doc-links',
            rel,
            line,
            `Relative link "${target}" escapes the repository root`,
            `Point "${target}" to an in-repo file or remove the stale link`,
          );
          continue;
        }
        if (!existsSync(resolved)) {
          addViolation(
            errors,
            'meta-doc-links',
            rel,
            line,
            `Broken relative Markdown link "${target}"`,
            `Update "${target}" to an existing path or wrap illustrative syntax in inline code`,
          );
        }
      }

      for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
        const token = match[1].trim();
        if (!REPO_PATH_PREFIX_RE.test(token)) continue;
        if (/[*<>{}[\]\s,|]/.test(token) || token.includes('...')) continue;
        const clean = token.split('#', 1)[0].split('?', 1)[0].replace(/[),.;:]+$/, '');
        if (!clean || !REPO_PATH_PREFIX_RE.test(clean)) continue;
        if (isBuildOutputPlaceholder(repoAbs, clean)) continue;
        const fromRoot = resolve(repoAbs, clean);
        const fromFile = resolve(dirAbs, clean);
        if (!existsSync(fromRoot) && !existsSync(fromFile)) {
          addViolation(
            errors,
            'meta-doc-links',
            rel,
            line,
            `Referenced repo path \`${token}\` does not exist on disk`,
            `Correct \`${token}\` to its real repository path or remove the stale reference`,
          );
        }
      }
    }
  }
}

function checkMaintainersRouterParity(root, errors) {
  const maintainersPath = join(root, 'MAINTAINERS.md');
  if (!existsSync(maintainersPath)) {
    addViolation(
      errors,
      'maintainers-router-parity',
      'MAINTAINERS.md',
      1,
      'MAINTAINERS.md is missing',
      'Create MAINTAINERS.md routing all apps/*/AGENTS.md and packages/*/AGENTS.md files',
    );
    return;
  }

  const content = readFileSync(maintainersPath, 'utf8');
  const linkedPaths = new Set();
  const lines = splitOutsideFences(content);
  const inlineRe = /\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const { text } of lines) {
    if (!text) continue;
    for (const match of text.matchAll(inlineRe)) {
      const raw = match[1].replaceAll(/^<|>$/g, '').split('#', 1)[0].split('?', 1)[0];
      if (!raw || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) continue;
      linkedPaths.add(normalizeWorkspaceDir(raw));
    }
  }

  const subtreeAgents = [];
  for (const base of ['apps', 'packages']) {
    const baseAbs = join(root, base);
    if (!existsSync(baseAbs)) continue;
    for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${base}/${entry.name}/AGENTS.md`;
      if (existsSync(join(root, ...rel.split('/')))) subtreeAgents.push(rel);
    }
  }
  subtreeAgents.sort((a, b) => a.localeCompare(b));

  for (const agentDoc of subtreeAgents) {
    if (!linkedPaths.has(agentDoc)) {
      addViolation(
        errors,
        'maintainers-router-parity',
        'MAINTAINERS.md',
        1,
        `Subtree guide "${agentDoc}" is not linked from MAINTAINERS.md`,
        `Add a row linking [\`${agentDoc}\`](${agentDoc}) to MAINTAINERS.md`,
      );
    }
  }

  const rawLines = content.split(/\r?\n/);
  let inGenerated = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^##\s+Generated contracts\s*$/.test(line)) {
      inGenerated = true;
      continue;
    }
    if (inGenerated && /^##\s+/.test(line)) break;
    if (!inGenerated) continue;
    const rowMatch = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/);
    if (!rowMatch) continue;
    const [, projection, generator] = rowMatch;
    for (const [label, target] of [
      ['Projection', projection],
      ['Generator', generator],
    ]) {
      const normalized = normalizeWorkspaceDir(target);
      if (!existsSync(join(root, ...normalized.split('/')))) {
        addViolation(
          errors,
          'maintainers-router-parity',
          'MAINTAINERS.md',
          i + 1,
          `${label} path \`${target}\` in ## Generated contracts does not exist on disk`,
          `Update or remove the missing ${label.toLowerCase()} \`${target}\` in MAINTAINERS.md`,
        );
      }
    }
  }
}

function checkDocWordBudgets(root, budgets, inventory, errors) {
  if (!budgets) return;
  const fileRules = budgets.files ?? {};
  const defaultSubtreeMaxWords = budgets.defaults?.subtreeAgentsMaxWords ?? 1600;

  for (const rel of inventory.agentsAndMaintainers) {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const lines = text.split(/\r?\n/).length;
    const budget =
      fileRules[rel] ?? (rel.endsWith('/AGENTS.md') ? { maxWords: defaultSubtreeMaxWords } : null);
    if (!budget) continue;

    if (typeof budget.maxWords === 'number' && words > budget.maxWords) {
      addViolation(
        errors,
        'doc-word-budgets',
        rel,
        1,
        `Document has ${words} words, exceeding budget of ${budget.maxWords} words`,
        `Trim ${rel} or move reference details into linked package/maintainer docs to stay <= ${budget.maxWords} words`,
      );
    }
    if (typeof budget.maxLines === 'number' && lines > budget.maxLines) {
      addViolation(
        errors,
        'doc-word-budgets',
        rel,
        1,
        `Document has ${lines} lines, exceeding budget of ${budget.maxLines} lines`,
        `Condense ${rel} to stay <= ${budget.maxLines} lines`,
      );
    }
  }
}

function stripTsSource(code, stripStrings) {
  if (!stripStrings && !code.includes('//') && !code.includes('/*')) return code;

  const chunks = [];
  let segStart = 0;
  let i = 0;
  const n = code.length;

  function flush(end) {
    if (end > segStart) chunks.push(code.slice(segStart, end));
  }

  while (i < n) {
    const ch = code.codePointAt(i);
    if (ch === 47) {
      const next = code.codePointAt(i + 1);
      if (next === 47) {
        flush(i);
        i += 2;
        while (i < n && code.codePointAt(i) !== 10) i++;
        segStart = i;
        continue;
      }
      if (next === 42) {
        flush(i);
        i += 2;
        let newlines = 0;
        while (i < n && !(code.codePointAt(i) === 42 && code.codePointAt(i + 1) === 47)) {
          if (code.codePointAt(i) === 10) newlines++;
          i++;
        }
        if (i < n) i += 2;
        if (newlines > 0) chunks.push('\n'.repeat(newlines));
        segStart = i;
        continue;
      }
    } else if (ch === 34 || ch === 39 || ch === 96) {
      const quote = ch;
      if (stripStrings) flush(i);
      i++;
      let newlines = 0;
      while (i < n && code.codePointAt(i) !== quote) {
        if (code.codePointAt(i) === 92 && i + 1 < n) {
          if (code.codePointAt(i + 1) === 10) newlines++;
          i += 2;
          continue;
        }
        if (code.codePointAt(i) === 10) newlines++;
        i++;
      }
      if (i < n) i++;
      if (stripStrings) {
        chunks.push(newlines > 0 ? ` ${'\n'.repeat(newlines)} ` : ' ');
        segStart = i;
      }
      continue;
    }
    i++;
  }
  flush(n);
  return chunks.join('');
}

function extractImportSpecifiers(noComments) {
  const results = [];
  const lines = noComments.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (!lineText.includes('import') && !lineText.includes('from')) continue;

    let match = lineText.match(SINGLE_LINE_FROM_RE);
    if (match) {
      results.push({ spec: match[1], line: i + 1 });
    } else if ((match = lineText.match(MULTILINE_CLOSE_FROM_RE))) {
      results.push({ spec: match[1], line: i + 1 });
    } else if ((match = lineText.match(SIDE_EFFECT_IMPORT_RE))) {
      results.push({ spec: match[1], line: i + 1 });
    }

    if (lineText.includes('import(') || lineText.includes('import (')) {
      DYNAMIC_IMPORT_RE.lastIndex = 0;
      for (const dyn of lineText.matchAll(DYNAMIC_IMPORT_RE)) {
        results.push({ spec: dyn[1], line: i + 1 });
      }
    }
  }
  return results;
}

function isProdTsFile(rel) {
  if (!/\.(?:ts|tsx|mts|cts)$/.test(rel)) return false;
  if (/\.(?:d|test|spec|integration|e2e)\.(?:ts|tsx|mts|cts)$/.test(rel)) return false;
  return !/(?:^|\/)(?:__tests__|test|tests)\//.test(rel);
}

function internalScopeName(specifier) {
  if (!specifier.startsWith('@kiki/')) return null;
  const parts = specifier.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
}

async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx]);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

async function checkPkgBoundaryGraph(root, boundaries, inventory, errors) {
  const rules = boundaries.BOUNDARY_RULES ?? [];
  const repoAbs = resolve(root);
  const scanJobs = [];

  for (const rule of rules) {
    const pkgRoot = resolve(repoAbs, ...rule.root.split('/'));
    const pkgJsonPath = join(pkgRoot, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    const pkgJsonText = readFileSync(pkgJsonPath, 'utf8');
    const pkgJson = JSON.parse(pkgJsonText);
    const selfPkgName = pkgJson.name;
    const pkgJsonRel = `${rule.root}/package.json`;

    const runtimeDeps = new Set([
      ...Object.keys(pkgJson.dependencies ?? {}),
      ...Object.keys(pkgJson.peerDependencies ?? {}),
    ]);
    const allDeclaredDeps = new Set([
      ...runtimeDeps,
      ...Object.keys(pkgJson.optionalDependencies ?? {}),
      ...Object.keys(pkgJson.devDependencies ?? {}),
    ]);

    for (const dep of runtimeDeps) {
      const depLine = findLineNumber(pkgJsonText, `"${dep}"`);
      if (rule.forbiddenInternal?.has(dep)) {
        addViolation(
          errors,
          'pkg-boundary-graph',
          pkgJsonRel,
          depLine,
          `Forbidden internal dependency "${dep}" in ${rule.id}`,
          `Remove "${dep}" from ${pkgJsonRel} and depend only on allowed contract layers`,
        );
      } else if (
        rule.allowedInternal &&
        dep.startsWith('@kiki/') &&
        !rule.allowedInternal.has(dep)
      ) {
        addViolation(
          errors,
          'pkg-boundary-graph',
          pkgJsonRel,
          depLine,
          `Internal dependency "${dep}" is not in allowedInternal for ${rule.id}`,
          `Remove "${dep}" from ${pkgJsonRel} or justify and register it in config/repo-boundaries.mjs`,
        );
      }

      for (const extRe of rule.forbiddenExternal ?? []) {
        if (extRe.test(dep)) {
          addViolation(
            errors,
            'pkg-boundary-graph',
            pkgJsonRel,
            depLine,
            `Forbidden external dependency "${dep}" in ${rule.id}`,
            `Remove "${dep}" from ${pkgJsonRel} to keep ${rule.id} decoupled from host/UI frameworks`,
          );
        }
      }
    }

    const srcPrefix = `${rule.root}/src/`;
    const isTestTsFile = (rel) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(rel);
    const srcFiles = inventory.allFiles.filter(
      (rel) => rel.startsWith(srcPrefix) && (isProdTsFile(rel) || (rule.id === '@kiki/gui' && isTestTsFile(rel))),
    );
    const globalRegexes = (rule.forbiddenGlobals ?? []).map((g) => ({
      name: g,
      re: new RegExp(`(?<![.\\w$])${g}(?=\\s*[.\\[(])`),
    }));
    const flagRegexes = (rule.forbiddenPlatformFlags ?? []).map((f) => ({
      name: f,
      re: new RegExp(`\\b${f}\\b`),
    }));

    const ctx = {
      rule,
      pkgRoot,
      pkgJsonRel,
      selfPkgName,
      allDeclaredDeps,
      globalRegexes,
      flagRegexes,
    };
    for (const fileRel of srcFiles) {
      scanJobs.push({ fileRel, ctx });
    }
  }

  const jobErrors = [];
  await mapWithConcurrency(scanJobs, READ_CONCURRENCY, async ({ fileRel, ctx }) => {
    const { rule, pkgRoot, pkgJsonRel, selfPkgName, allDeclaredDeps, globalRegexes, flagRegexes } =
      ctx;
    const fileAbs = join(repoAbs, ...fileRel.split('/'));
    let raw;
    try {
      raw = await readFile(fileAbs, 'utf8');
    } catch {
      return;
    }

    const noComments = stripTsSource(raw, false);

    for (const { spec, line } of extractImportSpecifiers(noComments)) {
      if (spec.startsWith('.')) {
        const targetAbs = resolve(dirname(fileAbs), spec);
        if (targetAbs !== pkgRoot && !targetAbs.startsWith(`${pkgRoot}${sep}`)) {
          const targetRel = relPosix(repoAbs, targetAbs);
          const allowedEscape = (rule.allowedRelativeEscapePatterns ?? []).some((re) =>
            re.test(targetRel),
          );
          if (!allowedEscape) {
            addViolation(
              jobErrors,
              'pkg-boundary-graph',
              fileRel,
              line,
              `Relative import "${spec}" escapes package root "${rule.root}"`,
              `Import from a declared workspace package export instead of relative path "${spec}"`,
            );
          }
        }
        continue;
      }

      const internalPkg = internalScopeName(spec);
      if (internalPkg && internalPkg !== selfPkgName) {
        if (
          rule.forbiddenInternal?.has(internalPkg) &&
          !rule.allowedForbiddenImportFiles?.has(fileRel)
        ) {
          addViolation(
            jobErrors,
            'pkg-boundary-graph',
            fileRel,
            line,
            `Forbidden internal import "${spec}" in ${rule.id}`,
            `Remove the import of "${internalPkg}" from ${fileRel} and route through an allowed contract package`,
          );
        } else if (rule.allowedInternal && !rule.allowedInternal.has(internalPkg)) {
          addViolation(
            jobErrors,
            'pkg-boundary-graph',
            fileRel,
            line,
            `Internal import "${spec}" is not in allowedInternal for ${rule.id}`,
            `Replace "${internalPkg}" with an allowed dependency or update config/repo-boundaries.mjs`,
          );
        }

        if (!allDeclaredDeps.has(internalPkg)) {
          addViolation(
            jobErrors,
            'pkg-boundary-graph',
            fileRel,
            line,
            `Undeclared internal package import "${spec}" (missing "${internalPkg}" in ${pkgJsonRel})`,
            `Declare "${internalPkg}" in ${pkgJsonRel} or remove the import from ${fileRel}`,
          );
        }
      }

      for (const extRe of rule.forbiddenExternal ?? []) {
        if (extRe.test(spec)) {
          addViolation(
            jobErrors,
            'pkg-boundary-graph',
            fileRel,
            line,
            `Forbidden external import "${spec}" in ${rule.id}`,
            `Remove "${spec}" from ${fileRel} and inject host capabilities via a narrow port`,
          );
        }
      }
    }

    if (globalRegexes.length > 0 || flagRegexes.length > 0) {
      const allowGlobals = rule.allowedForbiddenGlobalFiles?.has(fileRel) ?? false;
      const allowFlags = rule.allowedPlatformFlagFiles?.has(fileRel) ?? false;
      if (allowGlobals && allowFlags) return;

      const codeOnly = stripTsSource(raw, true);
      const codeLines = codeOnly.split('\n');

      for (let i = 0; i < codeLines.length; i++) {
        const codeLine = codeLines[i];
        if (!codeLine) continue;
        if (!allowGlobals) {
          for (const { name, re } of globalRegexes) {
            if (re.test(codeLine)) {
              addViolation(
                jobErrors,
                'pkg-boundary-graph',
                fileRel,
                i + 1,
                `Forbidden host/DOM global "${name}" accessed in ${rule.id}`,
                `Inject host/storage behavior through a port interface instead of reading "${name}" directly in ${fileRel}`,
              );
            }
          }
        }
        if (!allowFlags) {
          for (const { name, re } of flagRegexes) {
            if (re.test(codeLine)) {
              addViolation(
                jobErrors,
                'pkg-boundary-graph',
                fileRel,
                i + 1,
                `Forbidden runtime platform flag "${name}" in shared layer ${rule.id}`,
                `Replace "${name}" with explicit capability flags injected by the host adapter`,
              );
            }
          }
        }
      }
    }
  });

  jobErrors.sort((a, b) => {
    const cmp = a.file.localeCompare(b.file);
    return cmp !== 0 ? cmp : a.line - b.line;
  });
  errors.push(...jobErrors);
}

function checkWorkspaceSyncAndHygiene(root, boundaries, inventory, errors) {
  if (existsSync(join(root, 'flake.nix')) && existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const nixResult = checkNixWorkspace(root);
    if (!nixResult.ok) {
      for (const name of nixResult.missingNames) {
        addViolation(
          errors,
          'workspace-sync-and-hygiene',
          'flake.nix',
          1,
          `Workspace package "${name}" is missing from flake.nix workspaceNames`,
          `Add "${name}" to workspaceNames in flake.nix`,
        );
      }
      for (const { name, path } of nixResult.missingPaths) {
        addViolation(
          errors,
          'workspace-sync-and-hygiene',
          'flake.nix',
          1,
          `Workspace path "${path}" (${name}) is missing from flake.nix workspacePaths`,
          `Add ${path} to workspacePaths in flake.nix`,
        );
      }
      for (const name of nixResult.extraNames) {
        addViolation(
          errors,
          'workspace-sync-and-hygiene',
          'flake.nix',
          1,
          `Stale entry "${name}" in flake.nix workspaceNames has no matching workspace package`,
          `Remove "${name}" from workspaceNames in flake.nix`,
        );
      }
      for (const path of nixResult.extraPaths) {
        addViolation(
          errors,
          'workspace-sync-and-hygiene',
          'flake.nix',
          1,
          `Stale path "${path}" in flake.nix workspacePaths has no matching workspace package`,
          `Remove ${path} from workspacePaths in flake.nix`,
        );
      }
    }
  }

  const candidateFiles =
    inventory.trackedSet !== null
      ? [...inventory.trackedSet].toSorted((a, b) => a.localeCompare(b))
      : inventory.allFiles;

  const throwawayPatterns = boundaries.THROWAWAY_FILE_PATTERNS ?? [];
  for (const rel of candidateFiles) {
    for (const { pattern, reason } of throwawayPatterns) {
      if (pattern.test(rel)) {
        addViolation(
          errors,
          'workspace-sync-and-hygiene',
          rel,
          1,
          `Disallowed ${reason} "${rel}" is tracked in the repository`,
          `Remove "${rel}" from git and keep scratch artifacts under .tmp/`,
        );
      }
    }
  }
}

const PII_SCAN_EXTENSIONS = /\.(?:[cm]?[jt]sx?|md|json|ya?ml|toml|ps1|sh)$/iu;
const ALLOWED_USER_NAMES = new Set([
  'public', 'default', 'administrator', 'runneradmin', 'runner', 'user', 'users',
  'alice', 'bob', 'carol', 'dave', 'dev', 'developer', 'test', 'tester', 'example',
  'foo', 'bar', 'someone', 'me', 'name', 'you', 'yourname', 'username', 'owner',
  'admin', 'demo', 'jane', 'john', 'kiki', 'guest', 'shared', 'ci', 'build', 'app',
  'fixture', 'ada', 'sender', 'examplex', 'getlong', 'private',
]);
const WINDOWS_USER_PATH_RE = /\b[A-Za-z]:[/\\]Users[/\\]([A-Za-z0-9._-]{2,})[/\\]/gu;
const MACOS_USER_PATH_RE = /(?:^|[\s"'`(])\/Users\/([A-Za-z0-9._-]{2,})\//gu;
const NON_EXAMPLE_PRIVATE_LAN_RE = /\b192\.168\.(?!1\.(?:1|2|10|100)\b|0\.(?:0|1)\b)\d{1,3}\.\d{1,3}\b/gu;

function checkTrackedPiiAndInternalHosts(repoRoot, inventory, errors) {
  const candidateFiles =
    inventory.trackedSet !== null
      ? [...inventory.trackedSet].toSorted((a, b) => a.localeCompare(b))
      : inventory.allFiles;
  for (const rel of candidateFiles) {
    if (!PII_SCAN_EXTENSIONS.test(rel)) continue;
    if (rel === 'scripts/check-repo-meta.mjs' || rel === 'scripts/check-repo-meta.test.mjs') continue;
    let text;
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      WINDOWS_USER_PATH_RE.lastIndex = 0;
      let match;
      while ((match = WINDOWS_USER_PATH_RE.exec(line)) !== null) {
        if (!ALLOWED_USER_NAMES.has(match[1].toLowerCase())) {
          addViolation(
            errors,
            'pii-and-internal-hosts',
            rel,
            index + 1,
            `Tracked file contains non-placeholder Windows user profile path ("${match[0]}")`,
            'Replace with a neutral placeholder such as C:/Users/alice/ or an environment variable',
          );
        }
      }
      MACOS_USER_PATH_RE.lastIndex = 0;
      while ((match = MACOS_USER_PATH_RE.exec(line)) !== null) {
        if (!ALLOWED_USER_NAMES.has(match[1].toLowerCase())) {
          addViolation(
            errors,
            'pii-and-internal-hosts',
            rel,
            index + 1,
            `Tracked file contains non-placeholder macOS user profile path ("${match[0].trim()}")`,
            'Replace with a neutral placeholder such as /Users/alice/ or $HOME',
          );
        }
      }
      if (rel.startsWith('scripts/') && !rel.endsWith('.test.mjs')) {
        NON_EXAMPLE_PRIVATE_LAN_RE.lastIndex = 0;
        while ((match = NON_EXAMPLE_PRIVATE_LAN_RE.exec(line)) !== null) {
          addViolation(
            errors,
            'pii-and-internal-hosts',
            rel,
            index + 1,
            `Tracked script contains non-placeholder private LAN IP ("${match[0]}")`,
            'Replace with a neutral placeholder IP such as 192.168.1.10 or RFC 5737 203.0.113.10',
          );
        }
      }
    }
  }
}

function readMetaDiffText(repoRoot) {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.status !== 0) return '';
  const workingDiff = spawnSync('git', ['diff', '--unified=0', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (workingDiff.status === 0 && workingDiff.stdout.trim().length > 0) {
    return workingDiff.stdout;
  }
  const baseCandidates = [
    process.env.KIKI_DIFF_BASE?.trim(),
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF.trim()}` : '',
    'HEAD~1',
  ].filter((candidate) => Boolean(candidate));
  for (const baseRef of baseCandidates) {
    const verify = spawnSync('git', ['rev-parse', '--verify', '--quiet', baseRef], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (verify.status !== 0) continue;
    const rangeDiff = spawnSync('git', ['diff', '--unified=0', `${baseRef}...HEAD`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (rangeDiff.status === 0) return rangeDiff.stdout;
  }
  return '';
}

export function formatViolation(error) {
  return `[${error.rule}] ${error.file}:${error.line} — ${error.message}. Fix: ${error.fix}.`;
}

export async function checkRepoMeta(root = DEFAULT_ROOT, options = {}) {
  const repoRoot = resolve(root);
  const boundaries = options.boundaries ?? defaultBoundaries;
  let budgets = options.budgets;
  if (budgets === undefined) {
    const budgetPath = join(repoRoot, 'config', 'doc-budgets.json');
    budgets = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : null;
  }

  const inventory = collectRepoInventory(repoRoot, options.trackedFiles);
  const errors = [];

  checkClaudeMdPointer(repoRoot, inventory, errors);
  checkWorkspaceAgentsParity(repoRoot, boundaries, inventory, errors);
  checkBannedStaleScopes(repoRoot, boundaries, inventory, errors);
  checkMetaDocLinks(repoRoot, inventory, errors);
  checkMaintainersRouterParity(repoRoot, errors);
  checkDocWordBudgets(repoRoot, budgets, inventory, errors);
  await checkPkgBoundaryGraph(repoRoot, boundaries, inventory, errors);
  checkWorkspaceSyncAndHygiene(repoRoot, boundaries, inventory, errors);
  checkTrackedPiiAndInternalHosts(repoRoot, inventory, errors);
  if (
    options.boundaries === undefined &&
    options.trackedFiles === undefined &&
    existsSync(join(repoRoot, 'scripts', 'ccp-chaos', 'check-test-hygiene.mjs'))
  ) {
    const hygiene = runTestHygieneCheck({ repoRoot, diffText: readMetaDiffText(repoRoot) });
    for (const failure of hygiene.contractFailures) {
      addViolation(
        errors,
        'test-contract-hygiene',
        failure.file,
        failure.line,
        failure.reason,
        'Complete all 4 defineTestContract fields (@invariant, @mechanism, @covers, @sunset_when + sunset) or physically delete tests whose @covers/@sunset target was removed',
      );
    }
    for (const disabled of hygiene.disabledTests.violations) {
      addViolation(
        errors,
        'test-contract-hygiene',
        disabled.file,
        disabled.line,
        `Unexempted disabled test (${disabled.text}) violates Zero-Skip Gate`,
        'Enable the test in a self-contained harness or physically delete obsolete tests',
      );
    }
    for (const mock of [...hygiene.intraMonorepoMocks.violations, ...hygiene.diffRatchet.mockViolations]) {
      addViolation(
        errors,
        'test-contract-hygiene',
        mock.file,
        mock.line,
        `Unexempted intra-monorepo mock ("${mock.target}") violates real-seam test hygiene`,
        'Test against the real production module via DI/Scope or remove the internal vi.mock',
      );
    }
  }

  return errors;
}

export async function main() {
  const start = performance.now();
  const positionalArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const targetRoot = positionalArg ? resolve(positionalArg) : DEFAULT_ROOT;
  const errors = await checkRepoMeta(targetRoot);
  const elapsedMs = Math.round(performance.now() - start);

  if (errors.length === 0) {
    console.log(`check-repo-meta: OK (9 checks passed in ${elapsedMs}ms)`);
    return;
  }

  for (const error of errors) {
    console.error(formatViolation(error));
  }
  console.error(`check-repo-meta: FAILED (${errors.length} violation(s) in ${elapsedMs}ms)`);
  process.exitCode = 1;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  await main();
}

#!/usr/bin/env node
/**
 * Out-of-band Kiki-Ops switch conductor for managing EasyAgent\Kiki desktop runtime switches.
 * Commands: bootstrap-ops | inspect | switch | rollback | reconcile
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertEvidenceRef,
  assertFullCommit,
  DESKTOP_EXE,
  FULL_COMMIT_RE,
  FULL_HASH_RE,
  RECEIPT_FILE_NAME,
  RECEIPT_SCHEMA_VERSION,
  SERVER_EXE,
} from './desktop-receipt-contract.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RELEASE_ID_RE = /^[0-9a-f]{24}-[0-9a-f]{24}$/;
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ACTIVE_ACTIVITY_STATUSES = new Set(['running', 'approval', 'question', 'cleanup_pending']);
const DEFAULT_NUDGE_PROMPT =
  'The Kiki runtime finished hot-switching to the updated build. Please inspect your in-flight task state and continue any interrupted work.';

export function defaultRuntimeRoot(env = process.env) {
  if (!env.LOCALAPPDATA || env.LOCALAPPDATA.trim() === '') {
    throw new Error('LOCALAPPDATA is not set; pass --runtime-root explicitly.');
  }
  return join(env.LOCALAPPDATA, 'EasyAgent', 'Kiki');
}

export function defaultOpsRuntimeRoot(env = process.env) {
  if (!env.LOCALAPPDATA || env.LOCALAPPDATA.trim() === '') {
    throw new Error('LOCALAPPDATA is not set; pass --ops-runtime explicitly.');
  }
  return join(env.LOCALAPPDATA, 'EasyAgent', 'Kiki-Ops');
}

export function defaultKikiHome() {
  return join(homedir(), '.kiki');
}

export function defaultOpsHome() {
  return join(homedir(), '.kiki-ops');
}

export function normalizeComparePath(value) {
  const normalized = resolve(value).replace(/[/\\]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function sha256File(filePath) {
  const info = statSync(filePath);
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`Expected a non-empty file: ${filePath}`);
  }
  const sha256 = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  return { sha256, bytes: info.size };
}

export function writeTextAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tempPath, content, 'utf8');
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonIfExists(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw new Error(`Failed to read JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function assertNotSymlinkOrReparse(targetPath, label) {
  if (!existsSync(targetPath)) return;
  const stats = lstatSync(targetPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink or junction: ${targetPath}`);
  }
}

export function copyFileVerified(sourcePath, destinationPath) {
  const sourceInfo = sha256File(sourcePath);
  const destDir = dirname(destinationPath);
  assertNotSymlinkOrReparse(destDir, 'Destination directory');
  mkdirSync(destDir, { recursive: true });
  assertNotSymlinkOrReparse(destinationPath, 'Destination file');
  const tempPath = join(destDir, `.${basename(destinationPath)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    copyFileSync(sourcePath, tempPath);
    const copiedInfo = sha256File(tempPath);
    if (copiedInfo.sha256 !== sourceInfo.sha256 || copiedInfo.bytes !== sourceInfo.bytes) {
      throw new Error(`SHA-256 verification failed after copying ${sourcePath} to ${destinationPath}`);
    }
    renameSync(tempPath, destinationPath);
    return copiedInfo;
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

const OPS_DISABLED_CONFIG_SECTIONS = new Set([
  'search',
  'mcp',
  'plugins',
  'plugin_settings',
  'hooks',
  'external_hooks',
  'cron',
  'bot',
  'browser_control',
  'computer_control',
]);

function parseTomlFirstKeySegment(src, startIndex) {
  let i = startIndex;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;
  if (i >= src.length) return null;
  if (src[i] === '"') {
    i += 1;
    let out = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') return out;
      out += ch;
      i += 1;
    }
    return null;
  }
  if (src[i] === "'") {
    i += 1;
    const start = i;
    while (i < src.length && src[i] !== "'") i += 1;
    return i < src.length ? src.slice(start, i) : null;
  }
  const start = i;
  while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) i += 1;
  return i > start ? src.slice(start, i) : null;
}

function advanceTomlTokenState(line, state) {
  let i = 0;
  while (i < line.length) {
    if (state.mode === 'ml_basic') {
      if (line[i] === '\\') {
        i += 2;
        continue;
      }
      if (line.startsWith('"""', i)) {
        i += 3;
        while (i < line.length && line[i] === '"') i += 1;
        state.mode = 'code';
        continue;
      }
      i += 1;
      continue;
    }
    if (state.mode === 'ml_literal') {
      if (line.startsWith("'''", i)) {
        i += 3;
        while (i < line.length && line[i] === "'") i += 1;
        state.mode = 'code';
        continue;
      }
      i += 1;
      continue;
    }
    const ch = line[i];
    if (ch === '#') break;
    if (line.startsWith('"""', i)) {
      state.mode = 'ml_basic';
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      state.mode = 'ml_literal';
      i += 3;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < line.length && line[i] !== "'") i += 1;
      if (i < line.length) i += 1;
      continue;
    }
    if (ch === '[' || ch === '{') {
      state.depth += 1;
    } else if ((ch === ']' || ch === '}') && state.depth > 0) {
      state.depth -= 1;
    }
    i += 1;
  }
}

export function sanitizeOpsConfigToml(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = [];
  const state = { mode: 'code', depth: 0 };
  let inTopLevel = true;
  let skipSection = false;
  let skipStatement = false;

  for (const line of lines) {
    const atStatementBoundary = state.mode === 'code' && state.depth === 0;
    if (atStatementBoundary) {
      skipStatement = false;
      const trimmed = line.trimStart();
      if (trimmed === '' || trimmed.startsWith('#')) {
        if (!skipSection) kept.push(line);
        continue;
      }
      if (trimmed.startsWith('[')) {
        inTopLevel = false;
        const headerStart = trimmed.startsWith('[[') ? 2 : 1;
        const firstSeg = parseTomlFirstKeySegment(trimmed, headerStart);
        const rootSection = firstSeg !== null ? firstSeg.trim().toLowerCase() : '';
        skipSection = OPS_DISABLED_CONFIG_SECTIONS.has(rootSection);
        if (!skipSection) kept.push(line);
        continue;
      }
      if (skipSection) {
        skipStatement = true;
      } else if (inTopLevel) {
        const firstSeg = parseTomlFirstKeySegment(trimmed, 0);
        const rootKey = firstSeg !== null ? firstSeg.trim().toLowerCase() : '';
        if (OPS_DISABLED_CONFIG_SECTIONS.has(rootKey)) {
          skipStatement = true;
        }
      }
    }
    advanceTomlTokenState(line, state);
    if (!skipSection && !skipStatement) {
      kept.push(line);
    }
  }

  const body = kept.join(eol).replace(/[\r\n]+$/, '');
  const overrides = ['[search]', 'enabled = false', '', '[mcp]'].join(eol);
  return body === '' ? `${overrides}${eol}` : `${body}${eol}${eol}${overrides}${eol}`;
}

function resolveCanonicalPathForIsolation(targetPath) {
  const resolved = resolve(targetPath);
  const missingSegments = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  const canonicalBase = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return normalizeComparePath(join(canonicalBase, ...missingSegments));
}

function assertIsolatedOpsPath(opsPath, livePath, label) {
  assertNotSymlinkOrReparse(opsPath, label);
  const canonicalOps = resolveCanonicalPathForIsolation(opsPath);
  const canonicalLive = resolveCanonicalPathForIsolation(livePath);
  if (canonicalOps === canonicalLive) {
    throw new Error(`Refusing to bootstrap Kiki-Ops into the live ${label}: ${opsPath} resolves to ${livePath}`);
  }
  const relFromLive = relative(canonicalLive, canonicalOps);
  if (relFromLive !== '' && !relFromLive.startsWith('..') && !/^[a-zA-Z]:/.test(relFromLive)) {
    throw new Error(`Refusing to bootstrap Kiki-Ops inside the live ${label}: ${opsPath}`);
  }
}

function copyDirectoryTreeSafe(sourceDir, destinationDir) {
  if (!existsSync(sourceDir)) return 0;
  const srcStats = lstatSync(sourceDir);
  if (srcStats.isSymbolicLink() || !srcStats.isDirectory()) return 0;
  assertNotSymlinkOrReparse(destinationDir, 'Destination directory');
  mkdirSync(destinationDir, { recursive: true });
  let copiedCount = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (
      entry.name.endsWith('.lock') ||
      entry.name.endsWith('.lock-target') ||
      entry.name.endsWith('.tmp') ||
      entry.name.endsWith('.bak')
    ) {
      continue;
    }
    const srcPath = join(sourceDir, entry.name);
    const dstPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copiedCount += copyDirectoryTreeSafe(srcPath, dstPath);
    } else if (entry.isFile()) {
      const info = statSync(srcPath);
      if (info.size > 0) {
        copyFileVerified(srcPath, dstPath);
      } else {
        assertNotSymlinkOrReparse(dstPath, 'Destination file');
        writeTextAtomic(dstPath, '');
      }
      copiedCount += 1;
    }
  }
  return copiedCount;
}

export function ensureSearchDisabledConfig(configPath) {
  if (!existsSync(configPath)) {
    writeTextAtomic(configPath, '[search]\nenabled = false\n');
    return configPath;
  }
  const raw = readFileSync(configPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const sectionRe = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  let searchStart = -1;
  let searchEnd = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const match = sectionRe.exec(lines[i]);
    if (!match) continue;
    const sectionName = match[1].trim();
    if (searchStart === -1 && sectionName === 'search') {
      searchStart = i;
    } else if (searchStart !== -1) {
      searchEnd = i;
      break;
    }
  }
  if (searchStart === -1) {
    const trimmed = raw.replace(/[\r\n]+$/, '');
    const prefix = trimmed === '' ? '' : `${trimmed}${eol}${eol}`;
    writeTextAtomic(configPath, `${prefix}[search]${eol}enabled = false${eol}`);
    return configPath;
  }
  let replaced = false;
  for (let i = searchStart + 1; i < searchEnd; i += 1) {
    if (/^\s*enabled\s*=/.test(lines[i])) {
      lines[i] = 'enabled = false';
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    lines.splice(searchStart + 1, 0, 'enabled = false');
  }
  const next = lines.join(eol).replace(/[\r\n]*$/, '') + eol;
  writeTextAtomic(configPath, next);
  return configPath;
}

export function callLocalApi({ port, token, path, method = 'GET', body, timeoutMs }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: path.startsWith('/') ? path : `/api/${path}`,
        method,
        headers,
        ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? { timeout: timeoutMs }
          : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          let parsed;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : undefined;
          } catch {
            parsed = undefined;
          }
          if (status < 200 || status >= 300) {
            const envelopeMsg = parsed && typeof parsed === 'object'
              ? (parsed.msg ?? parsed.error?.message ?? parsed.message)
              : undefined;
            const err = new Error(`HTTP ${status} for ${method} ${path}: ${envelopeMsg ?? text}`);
            err.statusCode = status;
            err.rawBody = text;
            if (parsed && typeof parsed === 'object') {
              if ('code' in parsed) err.apiCode = parsed.code;
              if ('details' in parsed) err.details = parsed.details;
              if ('request_id' in parsed) err.requestId = parsed.request_id;
              err.envelope = parsed;
            }
            rejectRequest(err);
            return;
          }
          if (parsed === undefined) {
            const err = new Error(`Invalid JSON response for ${method} ${path}`);
            err.statusCode = status;
            err.rawBody = text;
            rejectRequest(err);
            return;
          }
          if (parsed && typeof parsed === 'object' && 'code' in parsed) {
            if (parsed.code !== 0) {
              const err = new Error(`${path}: ${parsed.msg ?? 'error'} (${parsed.code})`);
              err.statusCode = status;
              err.apiCode = parsed.code;
              if ('details' in parsed) err.details = parsed.details;
              if ('request_id' in parsed) err.requestId = parsed.request_id;
              err.envelope = parsed;
              rejectRequest(err);
              return;
            }
            resolveRequest(parsed.data);
            return;
          }
          resolveRequest(parsed);
        });
      },
    );
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${path}`));
      });
    }
    req.on('error', rejectRequest);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function defaultResolveProcessPath(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const ps = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const output = execFileSync(
        ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($null -ne $p -and $p.ExecutablePath) { Write-Output $p.ExecutablePath }`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      return output === '' ? null : output;
    } catch (error) {
      throw new Error(
        `Failed to query executable path for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const procExe = `/proc/${pid}/exe`;
  if (existsSync('/proc')) {
    try {
      return readlinkSync(procExe);
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ESRCH')) {
        return null;
      }
      throw new Error(
        `Failed to read ${procExe}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') {
      return null;
    }
    throw new Error(
      `Failed to probe PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function resolveActiveReleaseId(runtimeRoot) {
  const activeDir = join(resolve(runtimeRoot), 'active');
  const desktopPath = join(activeDir, 'kiki-desktop.exe');
  const serverPath = join(activeDir, 'kiki-server.exe');
  if (!existsSync(desktopPath) || !existsSync(serverPath)) {
    throw new Error(
      `Active runtime binaries are missing under ${activeDir} (expected kiki-desktop.exe and kiki-server.exe).`,
    );
  }
  const desktop = sha256File(desktopPath);
  const server = sha256File(serverPath);
  const computed = `${desktop.sha256.slice(0, 24)}-${server.sha256.slice(0, 24)}`;
  const activeManifest = readJsonIfExists(join(activeDir, 'active-release.json'));
  if (
    activeManifest !== null &&
    (activeManifest.schemaVersion !== 1 || activeManifest.releaseId !== computed)
  ) {
    throw new Error(
      `Active release manifest mismatch under ${activeDir}: active-release.json reports ${JSON.stringify(activeManifest.releaseId)}, verified binaries hash to ${computed}.`,
    );
  }
  return computed;
}

export function classifyRuntimeServerPath(runtimeRoot, executablePath) {
  if (!executablePath) return null;
  const cleanedExe = executablePath.replace(/^\\\\\?\\/, '');
  const normRoot = resolve(runtimeRoot);
  const normExe = normalizeComparePath(cleanedExe);
  const expectedActive = normalizeComparePath(join(normRoot, 'active', 'kiki-server.exe'));
  if (normExe === expectedActive) {
    const releaseId = resolveActiveReleaseId(normRoot);
    return { layout: 'active', releaseId, executablePath: cleanedExe };
  }
  const releasesDir = join(normRoot, 'releases');
  const releasesPrefix = normalizeComparePath(releasesDir) + (process.platform === 'win32' ? '\\' : '/');
  if (normExe.startsWith(releasesPrefix)) {
    const rel = relative(releasesDir, resolve(cleanedExe));
    const parts = rel.split(/[/\\]+/);
    if (parts.length === 2 && RELEASE_ID_RE.test(parts[0]) && parts[1].toLowerCase() === 'kiki-server.exe') {
      if (existsSync(cleanedExe)) {
        const server = sha256File(cleanedExe);
        const expectedServerPrefix = parts[0].split('-')[1];
        if (server.sha256.slice(0, 24) !== expectedServerPrefix) {
          throw new Error(
            `Release server binary digest mismatch at ${cleanedExe}: expected prefix ${expectedServerPrefix}, got ${server.sha256.slice(0, 24)}.`,
          );
        }
      }
      return { layout: 'releases', releaseId: parts[0], executablePath: cleanedExe };
    }
  }
  return null;
}

export function validateCandidateReceipt(candidateRoot, expectedCommit) {
  const fullCandidate = resolve(candidateRoot);
  const receiptPath = join(fullCandidate, RECEIPT_FILE_NAME);
  if (!existsSync(receiptPath)) {
    throw new Error(`Build receipt is missing: ${receiptPath}`);
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`Build receipt is invalid: ${receiptPath}`);
  }
  let sourceCommit;
  try {
    sourceCommit = assertFullCommit(receipt.sourceCommit);
  } catch {
    throw new Error(`Build receipt is invalid: ${receiptPath}`);
  }
  if (expectedCommit && sourceCommit !== expectedCommit) {
    throw new Error(`Build receipt source ${sourceCommit} does not match expected commit ${expectedCommit}.`);
  }
  const acceptanceRef = assertEvidenceRef(receipt.acceptanceRef, 'acceptanceRef');
  const checkRef = assertEvidenceRef(receipt.checkRef, 'checkRef');
  const desktopPath = join(fullCandidate, DESKTOP_EXE);
  const serverPath = join(fullCandidate, SERVER_EXE);
  const desktop = sha256File(desktopPath);
  const server = sha256File(serverPath);
  for (const [name, actual] of [
    [DESKTOP_EXE, desktop],
    [SERVER_EXE, server],
  ]) {
    const expected = receipt.files?.[name];
    if (
      !expected ||
      !FULL_HASH_RE.test(String(expected.sha256 ?? '')) ||
      Number(expected.bytes) !== actual.bytes ||
      expected.sha256 !== actual.sha256
    ) {
      throw new Error(`${name} does not match build receipt.`);
    }
  }
  return {
    candidateRoot: fullCandidate,
    sourceCommit,
    acceptanceRef,
    checkRef,
    releaseId: `${desktop.sha256.slice(0, 24)}-${server.sha256.slice(0, 24)}`,
    desktop,
    server,
  };
}

export async function discoverLiveServer({
  runtimeRoot,
  kikiHome,
  resolveProcessPath = defaultResolveProcessPath,
  callApi = callLocalApi,
}) {
  const homeDir = resolve(kikiHome);
  const ownerPath = join(homeDir, 'server.local-owner');
  if (!existsSync(ownerPath)) {
    return { server: null, tokenError: 'No local-owner capability file found.' };
  }
  const token = readFileSync(ownerPath, 'utf8').trim();
  if (!OWNER_TOKEN_RE.test(token)) {
    return { server: null, tokenError: 'The local-owner capability is invalid.' };
  }
  const instancesDir = join(homeDir, 'server', 'instances');
  if (!existsSync(instancesDir)) {
    return { server: null, tokenError: null };
  }
  const matches = [];
  for (const entry of readdirSync(instancesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const baseName = entry.name.slice(0, -'.json'.length);
    const instance = readJsonIfExists(join(instancesDir, entry.name));
    if (!instance || instance.server_id !== baseName) continue;
    if (!['127.0.0.1', 'localhost'].includes(instance.host) || !(Number(instance.port) > 0)) continue;
    const pid = Number(instance.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const executablePath = await resolveProcessPath(pid);
    const classified = classifyRuntimeServerPath(runtimeRoot, executablePath);
    if (!classified) continue;
    const meta = await callApi({ port: Number(instance.port), token, path: '/api/meta', method: 'GET' });
    if (meta.server_id !== instance.server_id || meta.build_id !== instance.build_id) {
      throw new Error(`Live server identity mismatch for ${instance.server_id}.`);
    }
    matches.push({
      instance,
      meta,
      token,
      pid,
      port: Number(instance.port),
      executablePath: classified.executablePath,
      layout: classified.layout,
      releaseId: classified.releaseId,
    });
  }
  if (matches.length > 1) {
    throw new Error('More than one managed service is active in this home.');
  }
  return { server: matches[0] ?? null, tokenError: null };
}

export function bootstrapOps({
  opsRuntime = defaultOpsRuntimeRoot(),
  opsHome = defaultOpsHome(),
  sourceCli,
  sourceRuntime = defaultRuntimeRoot(),
  sourceHome,
  targetRuntime = defaultRuntimeRoot(),
  targetHome = defaultKikiHome(),
  syncConfig = true,
} = {}) {
  const resolvedOpsRuntime = resolve(opsRuntime);
  const resolvedOpsHome = resolve(opsHome);
  const resolvedTargetRuntime = resolve(targetRuntime);
  const resolvedTargetHome = resolve(targetHome);
  const resolvedSourceHome = resolve(sourceHome ?? targetHome);

  assertIsolatedOpsPath(resolvedOpsRuntime, resolvedTargetRuntime, 'target runtime');
  assertIsolatedOpsPath(resolvedOpsHome, resolvedTargetHome, 'target home');
  if (normalizeComparePath(resolvedSourceHome) !== normalizeComparePath(resolvedTargetHome)) {
    assertIsolatedOpsPath(resolvedOpsHome, resolvedSourceHome, 'source home');
  }

  let resolvedSourceCli = sourceCli ? resolve(sourceCli) : null;
  if (!resolvedSourceCli) {
    const srcRoot = resolve(sourceRuntime);
    const current = readJsonIfExists(join(srcRoot, 'current.json'));
    const candidates = [
      join(srcRoot, 'cli', 'kiki.exe'),
      join(srcRoot, 'active', 'kiki-server.exe'),
    ];
    if (current?.schemaVersion === 1 && RELEASE_ID_RE.test(String(current.releaseId ?? ''))) {
      candidates.push(join(srcRoot, 'releases', current.releaseId, 'kiki-server.exe'));
    }
    resolvedSourceCli = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile() && statSync(candidate).size > 0) ?? null;
  }
  if (!resolvedSourceCli || !existsSync(resolvedSourceCli)) {
    throw new Error('Could not locate a verified kiki.exe / kiki-server.exe source binary; pass --source-cli.');
  }

  const activeDir = join(resolvedOpsRuntime, 'active');
  const cliDest = join(activeDir, 'kiki.exe');
  const copied = copyFileVerified(resolvedSourceCli, cliDest);
  const manifestPath = join(activeDir, 'ops-manifest.json');
  const manifest = {
    schemaVersion: 1,
    syncedAtUtc: new Date().toISOString(),
    sourcePath: resolvedSourceCli,
    sha256: copied.sha256,
    bytes: copied.bytes,
  };
  writeJsonAtomic(manifestPath, manifest);

  assertNotSymlinkOrReparse(resolvedOpsHome, 'Ops home directory');
  mkdirSync(resolvedOpsHome, { recursive: true });
  const configPath = join(resolvedOpsHome, 'config.toml');
  const mcpConfigPath = join(resolvedOpsHome, 'mcp.json');
  assertNotSymlinkOrReparse(configPath, 'Ops config.toml');
  assertNotSymlinkOrReparse(mcpConfigPath, 'Ops mcp.json');
  let syncedConfig = false;
  let syncedCredentials = false;
  let syncedCredentialFiles = 0;
  let syncedOAuthFiles = 0;
  let syncedAgentsCount = 0;
  let syncedPromptFiles = 0;
  let syncedRecipeFiles = 0;

  if (syncConfig !== false) {
    const sourceConfigPath = join(resolvedSourceHome, 'config.toml');
    if (existsSync(sourceConfigPath) && statSync(sourceConfigPath).isFile()) {
      const sanitized = sanitizeOpsConfigToml(readFileSync(sourceConfigPath, 'utf8'));
      writeTextAtomic(configPath, sanitized);
      syncedConfig = true;
    } else {
      ensureSearchDisabledConfig(configPath);
    }
    writeJsonAtomic(mcpConfigPath, { mcpServers: {} });

    const sourceCredDir = join(resolvedSourceHome, 'credentials');
    if (existsSync(sourceCredDir)) {
      syncedCredentialFiles = copyDirectoryTreeSafe(sourceCredDir, join(resolvedOpsHome, 'credentials'));
      if (syncedCredentialFiles > 0) syncedCredentials = true;
    }
    const legacySourceCredPath = join(resolvedSourceHome, 'credentials.toml');
    const destCredTomlPath = join(resolvedOpsHome, 'credentials', 'credentials.toml');
    if (
      !existsSync(destCredTomlPath) &&
      existsSync(legacySourceCredPath) &&
      !lstatSync(legacySourceCredPath).isSymbolicLink() &&
      statSync(legacySourceCredPath).isFile() &&
      statSync(legacySourceCredPath).size > 0
    ) {
      copyFileVerified(legacySourceCredPath, destCredTomlPath);
      syncedCredentials = true;
      syncedCredentialFiles += 1;
    }
    const sourceOAuthDir = join(resolvedSourceHome, 'oauth');
    if (existsSync(sourceOAuthDir)) {
      syncedOAuthFiles = copyDirectoryTreeSafe(sourceOAuthDir, join(resolvedOpsHome, 'oauth'));
    }
    const sourceAgentsDir = join(resolvedSourceHome, 'agents');
    if (existsSync(sourceAgentsDir)) {
      syncedAgentsCount = copyDirectoryTreeSafe(sourceAgentsDir, join(resolvedOpsHome, 'agents'));
    }
    const sourcePromptDir = join(resolvedSourceHome, 'prompt');
    if (existsSync(sourcePromptDir)) {
      syncedPromptFiles = copyDirectoryTreeSafe(sourcePromptDir, join(resolvedOpsHome, 'prompt'));
    }
    const sourceRecipesDir = join(resolvedSourceHome, 'recipes');
    if (existsSync(sourceRecipesDir)) {
      syncedRecipeFiles = copyDirectoryTreeSafe(sourceRecipesDir, join(resolvedOpsHome, 'recipes'));
    }
  } else {
    ensureSearchDisabledConfig(configPath);
  }

  if (/["%&|<>^\r\n]/.test(resolvedOpsHome)) {
    throw new Error(`ops-home path contains unsupported shell characters: ${resolvedOpsHome}`);
  }
  const launcherPath = join(activeDir, 'kiki-ops.cmd');
  const launcherBody = [
    '@echo off',
    'setlocal',
    `set "KIKI_HOME=${resolvedOpsHome}"`,
    'set "KIKI_SEARCH_DISABLED=1"',
    `"%~dp0kiki.exe" --home "${resolvedOpsHome}" %*`,
    '',
  ].join('\r\n');
  writeTextAtomic(launcherPath, launcherBody);

  return {
    ok: true,
    opsRuntime: resolvedOpsRuntime,
    opsHome: resolvedOpsHome,
    sourceHome: resolvedSourceHome,
    cliPath: cliDest,
    launcherPath,
    invocation: `"${launcherPath}"`,
    manifestPath,
    configPath,
    mcpConfigPath: syncConfig !== false ? mcpConfigPath : null,
    syncedConfig,
    syncedCredentials,
    syncedCredentialFiles,
    syncedOAuthFiles,
    syncedAgentsCount,
    syncedPromptFiles,
    syncedRecipeFiles,
    sha256: copied.sha256,
    bytes: copied.bytes,
  };
}

async function queryActiveSessionsPaginated({ port, token, callApi }) {
  const items = [];
  const seenTokens = new Set();
  let pageToken;
  while (true) {
    const queryPath = pageToken
      ? `/api/sessions/query?page_size=100&archived=false&page_token=${encodeURIComponent(pageToken)}`
      : '/api/sessions/query?page_size=100&archived=false';
    const resp = await callApi({ port, token, path: queryPath, method: 'GET' });
    const pageItems = Array.isArray(resp?.items) ? resp.items : [];
    items.push(...pageItems);
    const nextToken = resp?.next_page_token ?? resp?.page_token;
    if (!nextToken || pageItems.length === 0) break;
    const tokenKey = String(nextToken);
    if (seenTokens.has(tokenKey)) {
      throw new Error(`Repeated continuation token from /api/sessions/query: ${tokenKey}`);
    }
    seenTokens.add(tokenKey);
    pageToken = tokenKey;
  }
  return items;
}

async function readSessionActiveTaskCount({ port, token, sessionId, callApi }) {
  const encodedSid = encodeURIComponent(sessionId);
  try {
    let total = 0;
    const seenTokens = new Set();
    let pageToken;
    while (true) {
      const path = pageToken
        ? `/api/sessions/${encodedSid}/agent-tasks?page_size=100&page_token=${encodeURIComponent(pageToken)}`
        : `/api/sessions/${encodedSid}/agent-tasks?page_size=100`;
      const data = await callApi({ port, token, path, method: 'GET' });
      const items = Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        if (item?.status === 'running' && (item.source === undefined || item.source === 'live')) {
          total += 1;
        }
      }
      if (!data?.has_more || !data?.next_page_token || items.length === 0) break;
      const tokenKey = String(data.next_page_token);
      if (seenTokens.has(tokenKey)) {
        throw new Error(`Repeated continuation token from /agent-tasks: ${tokenKey}`);
      }
      seenTokens.add(tokenKey);
      pageToken = tokenKey;
    }
    return { activeTaskCount: total, scope: 'all_owners', error: null };
  } catch (agentTasksError) {
    const allOwnerError = agentTasksError instanceof Error ? agentTasksError.message : String(agentTasksError);
    try {
      let total = 0;
      let offset = 0;
      while (true) {
        const tasksResp = await callApi({
          port,
          token,
          path: `/api/sessions/${encodedSid}/tasks?status=running&page_size=100&offset=${offset}`,
          method: 'GET',
        });
        const items = Array.isArray(tasksResp?.items) ? tasksResp.items : [];
        total += items.length;
        if (!tasksResp?.has_more || items.length === 0) break;
        const nextOffset = typeof tasksResp.next_offset === 'number' ? tasksResp.next_offset : offset + items.length;
        if (nextOffset <= offset) {
          throw new Error(`Non-advancing task pagination offset (${nextOffset} <= ${offset})`);
        }
        offset = nextOffset;
      }
      return {
        activeTaskCount: total,
        scope: 'partial_main_only',
        error: allOwnerError,
      };
    } catch (tasksError) {
      const fallbackError = tasksError instanceof Error ? tasksError.message : String(tasksError);
      return {
        activeTaskCount: null,
        scope: 'unavailable',
        error: `${allOwnerError}; fallback /tasks failed: ${fallbackError}`,
      };
    }
  }
}

async function readSessionSubagentRoster({ port, token, sessionId, callApi }) {
  try {
    const items = [];
    let total = null;
    let offset = 0;
    while (true) {
      const resp = await callApi({
        port,
        token,
        path: `/api/sessions/${encodeURIComponent(sessionId)}/subagents?limit=100&offset=${offset}`,
        method: 'GET',
      });
      const pageItems = Array.isArray(resp?.items) ? resp.items : [];
      if (typeof resp?.total === 'number') total = resp.total;
      for (const row of pageItems) {
        items.push({
          id: row.agent_id ?? row.id,
          name: row.name ?? null,
          status: row.status ?? null,
          profile: row.profile ?? null,
        });
      }
      if (pageItems.length === 0 || (total !== null && items.length >= total) || pageItems.length < 100) {
        break;
      }
      offset += pageItems.length;
    }
    return {
      total: total ?? items.length,
      items,
      error: null,
    };
  } catch (error) {
    return {
      total: null,
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectRuntime({
  runtimeRoot = defaultRuntimeRoot(),
  kikiHome = defaultKikiHome(),
  candidateRoot,
  expectedCommit,
  ledgerPath,
  resolveProcessPath = defaultResolveProcessPath,
  callApi = callLocalApi,
} = {}) {
  const resolvedRuntime = resolve(runtimeRoot);
  const resolvedHome = resolve(kikiHome);
  const resolvedLedger = resolve(ledgerPath ?? join(resolvedRuntime, 'hot-switch-ledger.json'));

  const currentManifest = readJsonIfExists(join(resolvedRuntime, 'current.json'));
  const activeManifest = readJsonIfExists(join(resolvedRuntime, 'active', 'active-release.json'));
  const discovered = await discoverLiveServer({
    runtimeRoot: resolvedRuntime,
    kikiHome: resolvedHome,
    resolveProcessPath,
    callApi,
  });

  let candidate = null;
  if (candidateRoot) {
    try {
      const validated = validateCandidateReceipt(candidateRoot, expectedCommit);
      candidate = { valid: true, ...validated, error: null };
    } catch (error) {
      candidate = {
        valid: false,
        candidateRoot: resolve(candidateRoot),
        sourceCommit: expectedCommit ?? null,
        releaseId: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let lifecycle = null;
  let activeSessions = null;
  let activeSessionsError = null;
  const workPendingDetails = [];

  if (discovered.server) {
    const { port, token } = discovered.server;
    lifecycle = await callApi({ port, token, path: '/api/desktop-lifecycle', method: 'GET' });
    try {
      const items = await queryActiveSessionsPaginated({ port, token, callApi });
      activeSessions = items
        .filter((item) => item?.activity?.status && item.activity.status !== 'idle')
        .map((item) => ({
          sessionId: item.id,
          status: item.activity.status,
          title: item.meta?.title ?? null,
        }));
    } catch (error) {
      activeSessionsError = error instanceof Error ? error.message : String(error);
    }

    const inspectIds = new Set(Array.isArray(lifecycle?.work_pending) ? lifecycle.work_pending : []);
    for (const session of activeSessions ?? []) {
      if (ACTIVE_ACTIVITY_STATUSES.has(session.status)) {
        inspectIds.add(session.sessionId);
      }
    }

    for (const sessionId of inspectIds) {
      let control = null;
      let readError = null;
      try {
        control = await callApi({
          port,
          token,
          path: '/api/klient/call',
          method: 'POST',
          body: {
            procedure: { scope: 'session', sessionId, service: 'sessionExecutionControl', method: 'read' },
            params: [],
          },
        });
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
      }
      const [taskSummary, subagentRoster] = await Promise.all([
        readSessionActiveTaskCount({ port, token, sessionId, callApi }),
        readSessionSubagentRoster({ port, token, sessionId, callApi }),
      ]);
      const participants = Array.isArray(control?.agents) ? control.agents : [];
      const activityStatus = (activeSessions ?? []).find((item) => item.sessionId === sessionId)?.status ?? null;
      workPendingDetails.push({
        sessionId,
        inWorkPending: Array.isArray(lifecycle?.work_pending) && lifecycle.work_pending.includes(sessionId),
        activityStatus,
        phase: control?.phase ?? 'unknown',
        pauseOperationId: control?.pauseOperationId ?? null,
        activeTaskCount: taskSummary.activeTaskCount,
        activeTaskScope: taskSummary.scope,
        activeTaskError: taskSummary.error,
        subagentCount: subagentRoster.total,
        subagents: subagentRoster.items,
        subagentError: subagentRoster.error,
        pauseParticipantCount: participants.length,
        pauseParticipants: participants.map((agent) => ({
          agentId: agent.agentId,
          state: agent.state,
          resumable: Boolean(agent.resumable),
        })),
        error: readError,
      });
    }
  }

  let readiness = 'ready';
  if (candidate && !candidate.valid) readiness = 'candidate_invalid';
  else if (!discovered.server) readiness = 'no_live_server';
  else if ((lifecycle?.work_pending?.length ?? 0) > 0) readiness = 'busy_will_pause';
  else if (activeSessionsError !== null) readiness = 'session_inventory_unavailable';

  const ledger = {
    schemaVersion: 1,
    inspectedAtUtc: new Date().toISOString(),
    runtimeRoot: resolvedRuntime,
    kikiHome: resolvedHome,
    readiness,
    tokenError: discovered.tokenError,
    liveServer: discovered.server
      ? {
          server_id: discovered.server.meta.server_id,
          pid: discovered.server.pid,
          port: discovered.server.port,
          executablePath: discovered.server.executablePath,
          layout: discovered.server.layout,
          releaseId: discovered.server.releaseId,
          build_id: discovered.server.meta.build_id,
          server_version: discovered.server.meta.server_version ?? null,
          desktop_managed: Boolean(discovered.server.meta.desktop_managed),
        }
      : null,
    lifecycle,
    activeSessions,
    activeSessionsError,
    workPendingDetails,
    currentManifest,
    activeManifest,
    candidate,
  };

  writeJsonAtomic(resolvedLedger, ledger);
  return { ...ledger, ledgerPath: resolvedLedger };
}

export async function reconcileSwitch({
  runtimeRoot = defaultRuntimeRoot(),
  kikiHome = defaultKikiHome(),
  reportPath,
  sessions,
  nudge = false,
  prompt = DEFAULT_NUDGE_PROMPT,
  resolveProcessPath = defaultResolveProcessPath,
  callApi = callLocalApi,
} = {}) {
  const resolvedRuntime = resolve(runtimeRoot);
  const resolvedHome = resolve(kikiHome);
  const resolvedReportPath = resolve(reportPath ?? join(resolvedRuntime, 'hot-switch-report.json'));
  const report = readJsonIfExists(resolvedReportPath);

  const targets = [];
  const seen = new Set();
  const addTarget = (sessionId, targetHome) => {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return;
    const effectiveHome = resolve(
      typeof targetHome === 'string' && targetHome.trim() !== '' ? targetHome : resolvedHome,
    );
    const dedupKey = `${effectiveHome.toLowerCase()}|${sessionId}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      targets.push({ sessionId, kikiHome: effectiveHome });
    }
  };
  if (Array.isArray(sessions) && sessions.length > 0) {
    for (const id of sessions) addTarget(id, resolvedHome);
  } else if (report) {
    const defaultReportHome =
      typeof report.kikiHome === 'string' && report.kikiHome.trim() !== '' ? report.kikiHome : resolvedHome;
    const hasStructuredInterrupted =
      Array.isArray(report.interruptedSessionRecords) && report.interruptedSessionRecords.length > 0;
    const spaceInterrupted = Array.isArray(report.spaces)
      ? report.spaces.flatMap((sp) =>
          Array.isArray(sp?.interruptedSessions)
            ? sp.interruptedSessions.map((id) => ({ sessionId: id, kikiHome: sp.kikiHome ?? defaultReportHome }))
            : [],
        )
      : [];
    if (hasStructuredInterrupted) {
      for (const rec of report.interruptedSessionRecords) {
        addTarget(rec?.sessionId ?? rec?.id, rec?.kikiHome ?? defaultReportHome);
      }
    } else if (spaceInterrupted.length > 0) {
      for (const rec of spaceInterrupted) {
        addTarget(rec.sessionId, rec.kikiHome);
      }
    } else {
      for (const id of Array.isArray(report.interruptedSessions) ? report.interruptedSessions : []) {
        addTarget(id, defaultReportHome);
      }
    }
    for (const fail of Array.isArray(report.resumeFailures) ? report.resumeFailures : []) {
      addTarget(fail?.sessionId, fail?.kikiHome ?? defaultReportHome);
    }
  }

  const primaryDiscovered = await discoverLiveServer({
    runtimeRoot: resolvedRuntime,
    kikiHome: resolvedHome,
    resolveProcessPath,
    callApi,
  });
  if (!primaryDiscovered.server && targets.length === 0) {
    throw new Error(`No live Kiki server found for reconcile (${primaryDiscovered.tokenError ?? 'not running'}).`);
  }

  const serverContextCache = new Map();
  const getServerContext = async (targetHome) => {
    const homeKey = targetHome.toLowerCase();
    if (serverContextCache.has(homeKey)) return serverContextCache.get(homeKey);
    const discovered =
      homeKey === resolvedHome.toLowerCase()
        ? primaryDiscovered
        : await discoverLiveServer({
            runtimeRoot: resolvedRuntime,
            kikiHome: targetHome,
            resolveProcessPath,
            callApi,
          });
    if (!discovered.server) {
      throw new Error(
        `No live Kiki server found for reconcile in home ${targetHome} (${discovered.tokenError ?? 'not running'}).`,
      );
    }
    const { port, token } = discovered.server;
    let workPendingSet = new Set();
    let lifecycleState = 'ok';
    let lifecycleError = null;
    try {
      const lifecycle = await callApi({ port, token, path: '/api/desktop-lifecycle', method: 'GET' });
      if (Array.isArray(lifecycle?.work_pending)) {
        workPendingSet = new Set(lifecycle.work_pending);
      }
    } catch (error) {
      if (error?.statusCode === 404 || error?.apiCode === 40404) {
        lifecycleState = 'unsupported';
      } else {
        lifecycleState = 'error';
        lifecycleError = error instanceof Error ? error.message : String(error);
      }
    }
    const activityStatusBySession = new Map();
    let activityQueryState = 'ok';
    let activityQueryError = null;
    try {
      const items = await queryActiveSessionsPaginated({ port, token, callApi });
      for (const item of items) {
        if (item?.id && item?.activity?.status) {
          activityStatusBySession.set(item.id, item.activity.status);
        }
      }
    } catch (error) {
      if (error?.statusCode === 404 || error?.apiCode === 40404) {
        activityQueryState = 'unsupported';
      } else {
        activityQueryState = 'error';
        activityQueryError = error instanceof Error ? error.message : String(error);
      }
    }
    const ctx = {
      server: discovered.server,
      port,
      token,
      workPendingSet,
      lifecycleState,
      lifecycleError,
      activityStatusBySession,
      activityQueryState,
      activityQueryError,
    };
    serverContextCache.set(homeKey, ctx);
    return ctx;
  };

  const results = [];
  for (const target of targets) {
    const { sessionId, kikiHome: targetHome } = target;
    let ctx;
    try {
      ctx = await getServerContext(targetHome);
    } catch (error) {
      results.push({
        sessionId,
        kikiHome: targetHome,
        activityStatus: null,
        controlPhase: 'unknown',
        nudged: false,
        reason: 'server_unavailable',
        error: error instanceof Error ? error.message : String(error),
        readError: null,
      });
      continue;
    }
    const {
      port,
      token,
      workPendingSet,
      lifecycleState,
      lifecycleError,
      activityStatusBySession,
      activityQueryState,
      activityQueryError,
    } = ctx;

    let controlPhase = 'unknown';
    let readError = null;
    try {
      const control = await callApi({
        port,
        token,
        path: '/api/klient/call',
        method: 'POST',
        body: {
          procedure: { scope: 'session', sessionId, service: 'sessionExecutionControl', method: 'read' },
          params: [],
        },
      });
      controlPhase = control?.phase ?? 'unknown';
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }

    const activityStatus = activityStatusBySession.get(sessionId) ?? null;
    const isActuallyActive =
      workPendingSet.has(sessionId) ||
      (activityStatus !== null && ACTIVE_ACTIVITY_STATUSES.has(activityStatus)) ||
      controlPhase === 'resuming' ||
      controlPhase === 'pausing';

    if (!nudge) {
      results.push({ sessionId, kikiHome: targetHome, activityStatus, controlPhase, nudged: false, reason: 'dry_run', readError });
      continue;
    }
    if (isActuallyActive) {
      results.push({ sessionId, kikiHome: targetHome, activityStatus, controlPhase, nudged: false, reason: 'already_active', readError });
      continue;
    }
    if (controlPhase === 'paused') {
      results.push({ sessionId, kikiHome: targetHome, activityStatus, controlPhase, nudged: false, reason: 'still_paused', readError });
      continue;
    }
    if (lifecycleState === 'error') {
      results.push({
        sessionId,
        kikiHome: targetHome,
        activityStatus,
        controlPhase,
        nudged: false,
        reason: 'lifecycle_unknown',
        error: lifecycleError,
        readError,
      });
      continue;
    }
    if (activityStatus === null && activityQueryState === 'error') {
      results.push({
        sessionId,
        kikiHome: targetHome,
        activityStatus,
        controlPhase,
        nudged: false,
        reason: 'activity_unknown',
        error: activityQueryError,
        readError,
      });
      continue;
    }

    const promptId = `hot-switch-reconcile-${Date.now()}-${randomBytes(4).toString('hex')}`;
    try {
      const receipt = await callApi({
        port,
        token,
        path: `/api/sessions/${encodeURIComponent(sessionId)}/prompts?receipt=true`,
        method: 'POST',
        body: {
          prompt_id: promptId,
          admission: 'durable',
          append_timing: 'agent_idle',
          content: [{ type: 'text', text: prompt }],
        },
      });
      results.push({ sessionId, kikiHome: targetHome, activityStatus, controlPhase, nudged: true, promptId, receipt, readError });
    } catch (error) {
      results.push({
        sessionId,
        kikiHome: targetHome,
        activityStatus,
        controlPhase,
        nudged: false,
        promptId,
        error: error instanceof Error ? error.message : String(error),
        readError,
      });
    }
  }

  const failedNudges = results.filter((item) => item.error);
  const reportingServer = primaryDiscovered.server ?? [...serverContextCache.values()][0]?.server ?? null;
  return {
    ok: failedNudges.length === 0,
    reportPath: resolvedReportPath,
    liveServer: reportingServer
      ? {
          server_id: reportingServer.meta.server_id,
          pid: reportingServer.pid,
          executablePath: reportingServer.executablePath,
          build_id: reportingServer.meta.build_id,
        }
      : null,
    interruptedCount: targets.length,
    nudgeEnabled: Boolean(nudge),
    results,
  };
}

export function defaultRunHotSwitch(scriptPath, args) {
  return new Promise((resolveRun, rejectRun) => {
    const ps = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun({ code: 0, stdout, stderr });
        return;
      }
      rejectRun(new Error(`desktop-hot-switch.ps1 exited with ${code ?? signal}:\n${stderr || stdout}`));
    });
  });
}

export async function defaultInspectSpaces({
  hotSwitchScript = join(SCRIPT_DIR, 'desktop-hot-switch.ps1'),
  runtimeRoot,
  kikiHome,
  runHotSwitch = defaultRunHotSwitch,
}) {
  const res = await runHotSwitch(resolve(hotSwitchScript), [
    '-RuntimeRoot',
    resolve(runtimeRoot),
    '-KikiHome',
    resolve(kikiHome),
    '-InspectOnly',
    '-AppScopeOnly',
  ]);
  const parsed = JSON.parse(String(res.stdout ?? '').trim());
  return Array.isArray(parsed?.spaces) ? parsed.spaces : [];
}

export async function verifySpaceHealth({
  runtimeRoot,
  kikiHome,
  expectedCommit,
  expectedReleaseId,
  expectedPort = null,
  previousPid,
  allowSamePid = false,
  resolveProcessPath = defaultResolveProcessPath,
  callApi = callLocalApi,
}) {
  const resolvedRuntime = resolve(runtimeRoot);
  const resolvedHome = resolve(kikiHome);
  const expectedActiveServer = join(resolvedRuntime, 'active', 'kiki-server.exe');
  let discovered;
  try {
    discovered = await discoverLiveServer({
      runtimeRoot: resolvedRuntime,
      kikiHome: resolvedHome,
      resolveProcessPath,
      callApi,
    });
  } catch (error) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: null,
      healthz: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!discovered.server) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: null,
      healthz: 'unreachable',
      error: `Post-switch verification failed for ${resolvedHome}: no live managed Kiki server found (${discovered.tokenError ?? 'not running'}).`,
    };
  }
  const srv = discovered.server;
  if (normalizeComparePath(srv.executablePath) !== normalizeComparePath(expectedActiveServer)) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: srv,
      healthz: 'skipped',
      error: `Post-switch verification failed: server is running from '${srv.executablePath}' instead of '${expectedActiveServer}'.`,
    };
  }
  if (expectedCommit && srv.meta.build_id !== expectedCommit) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: srv,
      healthz: 'skipped',
      error: `Post-switch verification failed: build_id '${srv.meta.build_id}' !== expected '${expectedCommit}'.`,
    };
  }
  if (expectedReleaseId && srv.releaseId !== expectedReleaseId) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: srv,
      healthz: 'skipped',
      error: `Post-switch verification failed: releaseId '${srv.releaseId}' !== expected '${expectedReleaseId}'.`,
    };
  }
  if (!allowSamePid && previousPid && srv.pid === previousPid) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: srv,
      healthz: 'skipped',
      error: `Post-switch verification failed: server PID did not change (${srv.pid}).`,
    };
  }
  if (Number.isInteger(expectedPort) && expectedPort > 0 && srv.port !== expectedPort) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: srv,
      healthz: 'skipped',
      error: `Post-switch verification failed for ${resolvedHome}: server bound port ${srv.port} instead of required fixed port ${expectedPort}.`,
    };
  }
  let healthz = 'ok';
  try {
    const hz = await callApi({
      port: srv.port,
      token: srv.token,
      path: '/api/healthz',
      method: 'GET',
      timeoutMs: 5000,
    });
    if (!hz || typeof hz !== 'object' || hz.ok !== true) {
      return {
        ok: false,
        kikiHome: resolvedHome,
        server: srv,
        healthz: 'unhealthy',
        error: `Post-switch verification failed for ${resolvedHome}: /api/healthz did not return ok=true.`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      kikiHome: resolvedHome,
      server: srv,
      healthz: 'error',
      error: `Post-switch verification failed for ${resolvedHome}: /api/healthz failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    kikiHome: resolvedHome,
    server: srv,
    healthz,
    error: null,
  };
}

function summarizeSpaceCheck(check) {
  return {
    ok: check.ok,
    kikiHome: check.kikiHome,
    healthz: check.healthz,
    error: check.error,
    server: check.server
      ? {
          server_id: check.server.meta.server_id,
          pid: check.server.pid,
          port: check.server.port,
          executablePath: check.server.executablePath,
          layout: check.server.layout,
          releaseId: check.server.releaseId,
          build_id: check.server.meta.build_id,
          desktop_managed: Boolean(check.server.meta.desktop_managed),
        }
      : null,
  };
}

function parseExplicitPortFromArgs(launchArgs) {
  if (typeof launchArgs !== 'string' || launchArgs.trim() === '') return null;
  const re = /(?:^|\s)(?:--port|-p)(?:=|\s+)(?:"(\d+)"|'([^']+)'|(\d+))(?=\s|$)/gi;
  let last = null;
  let match;
  while ((match = re.exec(launchArgs)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3];
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      last = parsed;
    }
  }
  return last;
}

function resolveExpectedHeadlessPort(hadDesktop, headlessLaunchArgs, originalPort) {
  if (hadDesktop !== false) return null;
  const explicit = parseExplicitPortFromArgs(headlessLaunchArgs);
  if (explicit !== null) {
    return explicit === 0 ? null : explicit;
  }
  if (Number.isInteger(originalPort) && originalPort > 0 && originalPort <= 65535) {
    return originalPort;
  }
  return null;
}

function normalizeSpaceSnapshots(rawSpaces, primaryHome, primaryServer) {
  const byKey = new Map();
  const add = (sp) => {
    if (!sp || typeof sp.kikiHome !== 'string' || sp.kikiHome.trim() === '') return;
    const normHome = resolve(sp.kikiHome);
    const key = normalizeComparePath(normHome);
    const existing = byKey.get(key);
    const srv = sp.liveServer ?? sp.preServerMeta ?? sp.server ?? null;
    const hadDesktop = sp.hadDesktop ?? existing?.hadDesktop ?? true;
    const headlessLaunchArgs = sp.headlessLaunchArgs ?? existing?.headlessLaunchArgs ?? null;
    const rawOriginalPort =
      sp.headlessOriginalPort ??
      sp.originalPort ??
      (hadDesktop === false ? (srv?.port ?? sp.port ?? null) : null) ??
      existing?.headlessOriginalPort ??
      null;
    const headlessOriginalPort =
      Number.isInteger(rawOriginalPort) && rawOriginalPort > 0 && rawOriginalPort <= 65535 ? rawOriginalPort : null;
    const headlessExplicitPort =
      sp.headlessExplicitPort ??
      (hadDesktop === false ? parseExplicitPortFromArgs(headlessLaunchArgs) : null) ??
      existing?.headlessExplicitPort ??
      null;
    const rawExpectedPort =
      sp.expectedPort ??
      existing?.expectedPort ??
      resolveExpectedHeadlessPort(hadDesktop, headlessLaunchArgs, headlessOriginalPort);
    const expectedPort =
      Number.isInteger(rawExpectedPort) && rawExpectedPort > 0 && rawExpectedPort <= 65535 ? rawExpectedPort : null;
    const merged = {
      kikiHome: normHome,
      isPrimary: sp.isPrimary ?? key === normalizeComparePath(primaryHome),
      passHomeArg: sp.passHomeArg ?? key !== normalizeComparePath(primaryHome),
      hadDesktop,
      headlessLaunchArgs,
      headlessOriginalPort,
      headlessExplicitPort,
      expectedPort,
      desktopManaged: sp.desktopManaged ?? srv?.desktop_managed ?? existing?.desktopManaged ?? true,
      oldReleaseId: sp.oldReleaseId ?? srv?.releaseId ?? existing?.oldReleaseId ?? null,
      oldBuildId: sp.oldBuildId ?? srv?.build_id ?? existing?.oldBuildId ?? null,
      oldServerId: sp.oldServerId ?? srv?.server_id ?? existing?.oldServerId ?? null,
      serverHomeId: sp.serverHomeId ?? srv?.server_home_id ?? existing?.serverHomeId ?? null,
      spaceId: sp.spaceId ?? srv?.current_space_id ?? existing?.spaceId ?? null,
      pid: sp.pid ?? srv?.pid ?? existing?.pid ?? null,
      fenceOperationId: sp.fenceOperationId ?? existing?.fenceOperationId ?? null,
      sessions: Array.isArray(sp.sessions) ? sp.sessions : (existing?.sessions ?? []),
    };
    byKey.set(key, merged);
  };
  for (const sp of Array.isArray(rawSpaces) ? rawSpaces : []) add(sp);
  if (!byKey.has(normalizeComparePath(primaryHome))) {
    add({
      kikiHome: primaryHome,
      isPrimary: true,
      passHomeArg: false,
      hadDesktop: true,
      liveServer: primaryServer,
    });
  }
  return [...byKey.values()];
}

export async function rollbackRuntime({
  runtimeRoot = defaultRuntimeRoot(),
  kikiHome = defaultKikiHome(),
  releaseId,
  expectedCommit,
  hotSwitchScript = join(SCRIPT_DIR, 'desktop-hot-switch.ps1'),
  startupSeconds = 90,
  stopGraceSeconds = 30,
  ledgerPath,
  spaces,
  resolveProcessPath = defaultResolveProcessPath,
  callApi = callLocalApi,
  runHotSwitch = defaultRunHotSwitch,
} = {}) {
  const resolvedRuntime = resolve(runtimeRoot);
  const resolvedHome = resolve(kikiHome);
  const resolvedLedger = resolve(ledgerPath ?? join(resolvedRuntime, 'hot-switch-ledger.json'));
  const statePath = join(resolvedRuntime, 'hot-switch.json');
  const existingState = readJsonIfExists(statePath);
  const existingLedger = readJsonIfExists(resolvedLedger);

  const resolvedReleaseId =
    releaseId ??
    existingState?.oldReleaseId ??
    existingLedger?.switchSnapshot?.previousReleaseId ??
    existingLedger?.liveServer?.releaseId ??
    null;
  const resolvedBuildId =
    expectedCommit ??
    existingState?.oldBuildId ??
    existingLedger?.switchSnapshot?.previousBuildId ??
    existingLedger?.liveServer?.build_id ??
    null;

  if (!resolvedReleaseId || !RELEASE_ID_RE.test(String(resolvedReleaseId))) {
    throw new Error('Cannot determine a valid previous releaseId to roll back to; pass --release-id.');
  }

  const candidateSpaces = normalizeSpaceSnapshots(
    spaces ?? existingState?.spaces ?? existingLedger?.switchSnapshot?.spaces ?? [],
    resolvedHome,
    existingLedger?.liveServer ?? null,
  );

  // Ensure hot-switch.json is in an unfinished state pointing to resolvedReleaseId so -Recover -Rollback can execute cleanly.
  const needsRollbackStateSeed =
    !existingState ||
    existingState.schemaVersion !== 1 ||
    existingState.phase === 'complete' ||
    existingState.oldReleaseId !== resolvedReleaseId ||
    normalizeComparePath(existingState.kikiHome ?? '') !== normalizeComparePath(resolvedHome);

  if (needsRollbackStateSeed) {
    const existingSpacesByKey = new Map();
    for (const esp of Array.isArray(existingState?.spaces) ? existingState.spaces : []) {
      if (esp && typeof esp.kikiHome === 'string' && esp.kikiHome.trim() !== '') {
        existingSpacesByKey.set(normalizeComparePath(esp.kikiHome), esp);
      }
    }
    const primarySnap = candidateSpaces.find((s) => normalizeComparePath(s.kikiHome) === normalizeComparePath(resolvedHome)) ?? candidateSpaces[0];
    const primaryExisting = existingSpacesByKey.get(normalizeComparePath(resolvedHome));
    const seededState = {
      schemaVersion: 1,
      phase: 'starting_failed',
      kikiHome: resolvedHome,
      oldReleaseId: resolvedReleaseId,
      oldBuildId: resolvedBuildId ?? primarySnap?.oldBuildId ?? '',
      oldServerId: primarySnap?.oldServerId ?? 'rollback-prior-server',
      serverHomeId: primarySnap?.serverHomeId ?? existingState?.serverHomeId ?? '',
      spaceId: primarySnap?.spaceId ?? existingState?.spaceId ?? 'main',
      priorPointerReleaseId: resolvedReleaseId,
      targetReleaseId: existingState?.targetReleaseId ?? existingLedger?.switchSnapshot?.targetReleaseId ?? resolvedReleaseId,
      targetBuildId: existingState?.targetBuildId ?? existingLedger?.switchSnapshot?.targetCommit ?? resolvedBuildId ?? '',
      hadDesktop: primarySnap?.hadDesktop ?? true,
      headlessLaunchArgs: primarySnap?.headlessLaunchArgs ?? null,
      headlessOriginalPort: primarySnap?.headlessOriginalPort ?? existingState?.headlessOriginalPort ?? null,
      headlessExplicitPort: primarySnap?.headlessExplicitPort ?? existingState?.headlessExplicitPort ?? null,
      expectedPort: primarySnap?.expectedPort ?? existingState?.expectedPort ?? null,
      desktopManaged: primarySnap?.desktopManaged ?? true,
      fenceOperationId: primaryExisting?.fenceOperationId ?? primarySnap?.fenceOperationId ?? existingState?.fenceOperationId ?? null,
      sessions: Array.isArray(primaryExisting?.sessions) ? primaryExisting.sessions : (Array.isArray(existingState?.sessions) ? existingState.sessions : []),
      spaces: candidateSpaces.map((sp) => {
        const esp = existingSpacesByKey.get(normalizeComparePath(sp.kikiHome));
        const spFence =
          esp?.fenceOperationId ??
          sp.fenceOperationId ??
          (sp.isPrimary ? (existingState?.fenceOperationId ?? null) : null);
        const spSessions = Array.isArray(esp?.sessions) ? esp.sessions : (Array.isArray(sp.sessions) ? sp.sessions : []);
        return {
          kikiHome: sp.kikiHome,
          isPrimary: sp.isPrimary,
          passHomeArg: sp.passHomeArg,
          oldReleaseId: resolvedReleaseId,
          oldBuildId: resolvedBuildId ?? sp.oldBuildId ?? '',
          oldServerId: sp.oldServerId ?? 'rollback-prior-server',
          serverHomeId: sp.serverHomeId ?? '',
          spaceId: sp.spaceId ?? 'main',
          hadDesktop: sp.hadDesktop,
          headlessLaunchArgs: sp.headlessLaunchArgs,
          headlessOriginalPort: sp.headlessOriginalPort ?? esp?.headlessOriginalPort ?? null,
          headlessExplicitPort: sp.headlessExplicitPort ?? esp?.headlessExplicitPort ?? null,
          expectedPort: sp.expectedPort ?? esp?.expectedPort ?? null,
          desktopManaged: sp.desktopManaged,
          fenceOperationId: spFence,
          sessions: spSessions,
        };
      }),
    };
    writeJsonAtomic(statePath, seededState);
  }

  const psArgs = [
    '-RuntimeRoot',
    resolvedRuntime,
    '-KikiHome',
    resolvedHome,
    '-Recover',
    '-Rollback',
    '-StartupSeconds',
    String(startupSeconds),
    '-StopGraceSeconds',
    String(stopGraceSeconds),
  ];

  const rollbackRun = await runHotSwitch(resolve(hotSwitchScript), psArgs);
  const checks = [];
  for (const sp of candidateSpaces) {
    checks.push(
      await verifySpaceHealth({
        runtimeRoot: resolvedRuntime,
        kikiHome: sp.kikiHome,
        expectedCommit: resolvedBuildId ?? undefined,
        expectedReleaseId: resolvedReleaseId,
        expectedPort: sp.expectedPort ?? null,
        allowSamePid: true,
        resolveProcessPath,
        callApi,
      }),
    );
  }
  const failedChecks = checks.filter((c) => !c.ok);
  const summaryChecks = checks.map(summarizeSpaceCheck);
  const rollbackResult = {
    schemaVersion: 1,
    rolledBackAtUtc: new Date().toISOString(),
    ok: failedChecks.length === 0,
    runtimeRoot: resolvedRuntime,
    kikiHome: resolvedHome,
    releaseId: resolvedReleaseId,
    buildId: resolvedBuildId,
    spaces: summaryChecks,
    stdout: rollbackRun.stdout?.trim() ?? '',
  };
  writeJsonAtomic(resolvedLedger, { ...(existingLedger ?? {}), lastRollback: rollbackResult });
  if (failedChecks.length > 0) {
    const err = new Error(
      `Rollback verification failed for ${failedChecks.length} space(s): ${failedChecks.map((f) => `${f.kikiHome}: ${f.error}`).join('; ')}`,
    );
    err.failureReport = rollbackResult;
    throw err;
  }
  return rollbackResult;
}

export async function switchRuntime({
  runtimeRoot = defaultRuntimeRoot(),
  kikiHome = defaultKikiHome(),
  candidateRoot,
  expectedCommit,
  hotSwitchScript = join(SCRIPT_DIR, 'desktop-hot-switch.ps1'),
  settleSeconds = 600,
  startupSeconds = 90,
  stopGraceSeconds = 30,
  canaryTimeoutSeconds,
  skipCanary = false,
  background = false,
  noInterruptAfterSettle = false,
  nudgeInterrupted = false,
  nudgePrompt = DEFAULT_NUDGE_PROMPT,
  autoRollback = true,
  ledgerPath,
  resolveProcessPath = defaultResolveProcessPath,
  callApi = callLocalApi,
  runHotSwitch = defaultRunHotSwitch,
  inspectSpaces,
} = {}) {
  const resolvedRuntime = resolve(runtimeRoot);
  const resolvedHome = resolve(kikiHome);
  const resolvedLedger = resolve(ledgerPath ?? join(resolvedRuntime, 'hot-switch-ledger.json'));

  let resolvedCandidate = candidateRoot;
  let resolvedCommit = expectedCommit;
  if (!resolvedCandidate) {
    const settings = readJsonIfExists(join(resolvedRuntime, 'controller', 'settings.json'));
    if (settings?.schemaVersion === 1 && settings.candidateRoot) {
      resolvedCandidate = settings.candidateRoot;
      if (!resolvedCommit && settings.expectedCommit) resolvedCommit = settings.expectedCommit;
    }
  }
  if (!resolvedCandidate) {
    throw new Error('--candidate-root is required (or configure controller/settings.json).');
  }

  const preInspect = await inspectRuntime({
    runtimeRoot: resolvedRuntime,
    kikiHome: resolvedHome,
    candidateRoot: resolvedCandidate,
    expectedCommit: resolvedCommit,
    ledgerPath: resolvedLedger,
    resolveProcessPath,
    callApi,
  });
  if (preInspect.candidate && !preInspect.candidate.valid) {
    throw new Error(`Candidate validation failed: ${preInspect.candidate.error}`);
  }
  const targetCommit = resolvedCommit ?? preInspect.candidate?.sourceCommit;
  const targetReleaseId = preInspect.candidate?.releaseId ?? null;
  const previousReleaseId =
    preInspect.liveServer?.releaseId ??
    preInspect.activeManifest?.releaseId ??
    preInspect.currentManifest?.releaseId ??
    null;
  const previousBuildId =
    preInspect.liveServer?.build_id ??
    preInspect.activeManifest?.gitSha ??
    preInspect.currentManifest?.gitSha ??
    null;

  let discoveredPreSpaces = [];
  const spaceInspector =
    typeof inspectSpaces === 'function'
      ? inspectSpaces
      : runHotSwitch === defaultRunHotSwitch
        ? () => defaultInspectSpaces({ hotSwitchScript, runtimeRoot: resolvedRuntime, kikiHome: resolvedHome })
        : null;
  if (spaceInspector) {
    try {
      discoveredPreSpaces = await spaceInspector();
    } catch {
      discoveredPreSpaces = [];
    }
  }
  const preSpaces = normalizeSpaceSnapshots(discoveredPreSpaces, resolvedHome, preInspect.liveServer);
  const switchSnapshot = {
    capturedAtUtc: new Date().toISOString(),
    previousReleaseId,
    previousBuildId,
    targetReleaseId,
    targetCommit,
    spaces: preSpaces,
  };
  writeJsonAtomic(resolvedLedger, { ...preInspect, switchSnapshot });

  const psArgs = [
    '-RuntimeRoot',
    resolvedRuntime,
    '-KikiHome',
    resolvedHome,
    '-CandidateRoot',
    resolve(resolvedCandidate),
    '-SettleSeconds',
    String(settleSeconds),
    '-StartupSeconds',
    String(startupSeconds),
    '-StopGraceSeconds',
    String(stopGraceSeconds),
  ];
  if (targetCommit) {
    psArgs.push('-ExpectedCommit', targetCommit);
  }
  if (!skipCanary) {
    psArgs.push('-CanaryCheck');
    if (canaryTimeoutSeconds !== undefined && canaryTimeoutSeconds > 0) {
      psArgs.push('-CanaryTimeoutSeconds', String(canaryTimeoutSeconds));
    }
  }
  if (background) psArgs.push('-Background');
  if (noInterruptAfterSettle) psArgs.push('-NoInterruptAfterSettle');

  const reportPath = join(resolvedRuntime, 'hot-switch-report.json');
  let switchRun;
  let stage = 'hot_switch_exec';
  let spaceChecks = [];

  try {
    switchRun = await runHotSwitch(resolve(hotSwitchScript), psArgs);
    stage = 'post_switch_verify';
    const report = readJsonIfExists(reportPath);
    const verifyTargets = normalizeSpaceSnapshots(
      [...preSpaces, ...(Array.isArray(report?.spaces) ? report.spaces : [])],
      resolvedHome,
      preInspect.liveServer,
    );
    const preByKey = new Map(preSpaces.map((sp) => [normalizeComparePath(sp.kikiHome), sp]));
    for (const sp of verifyTargets) {
      const preSp = preByKey.get(normalizeComparePath(sp.kikiHome));
      const check = await verifySpaceHealth({
        runtimeRoot: resolvedRuntime,
        kikiHome: sp.kikiHome,
        expectedCommit: targetCommit,
        expectedPort: preSp?.expectedPort ?? sp.expectedPort ?? null,
        previousPid: preSp?.pid ?? null,
        allowSamePid: report?.outcome === 'already_running',
        resolveProcessPath,
        callApi,
      });
      spaceChecks.push(check);
    }
    const failedVerify = spaceChecks.filter((c) => !c.ok);
    if (failedVerify.length > 0) {
      throw new Error(failedVerify.map((f) => f.error).join('; '));
    }

    const primaryCheck = spaceChecks.find((c) => normalizeComparePath(c.kikiHome) === normalizeComparePath(resolvedHome)) ?? spaceChecks[0];
    const postServer = primaryCheck.server;
    const reconcile = await reconcileSwitch({
      runtimeRoot: resolvedRuntime,
      kikiHome: resolvedHome,
      reportPath,
      nudge: nudgeInterrupted,
      prompt: nudgePrompt,
      resolveProcessPath,
      callApi,
    });

    const result = {
      schemaVersion: 1,
      completedAtUtc: new Date().toISOString(),
      ok: true,
      runtimeRoot: resolvedRuntime,
      kikiHome: resolvedHome,
      previousReleaseId,
      previousBuildId,
      preSwitch: preInspect.liveServer,
      postSwitch: {
        server_id: postServer.meta.server_id,
        pid: postServer.pid,
        port: postServer.port,
        executablePath: postServer.executablePath,
        layout: postServer.layout,
        releaseId: postServer.releaseId,
        build_id: postServer.meta.build_id,
      },
      spaceChecks: spaceChecks.map(summarizeSpaceCheck),
      reportPath,
      report,
      reconcile,
      switchStdout: switchRun.stdout?.trim() ?? '',
    };
    writeJsonAtomic(resolvedLedger, { ...preInspect, switchSnapshot, lastSwitch: result });
    return result;
  } catch (switchError) {
    const report = readJsonIfExists(reportPath);
    let rollbackInfo = { triggered: false, ok: false, reason: 'disabled_or_no_previous_release' };
    const shouldAttemptRollback =
      autoRollback !== false &&
      Boolean(previousReleaseId) &&
      RELEASE_ID_RE.test(String(previousReleaseId));

    if (shouldAttemptRollback) {
      let alreadyRolledBack = false;
      if (report?.outcome === 'rolled_back') {
        const internalChecks = [];
        for (const sp of preSpaces) {
          internalChecks.push(
            await verifySpaceHealth({
              runtimeRoot: resolvedRuntime,
              kikiHome: sp.kikiHome,
              expectedCommit: previousBuildId ?? undefined,
              expectedReleaseId: previousReleaseId,
              expectedPort: sp.expectedPort ?? null,
              allowSamePid: true,
              resolveProcessPath,
              callApi,
            }),
          );
        }
        if (internalChecks.length > 0 && internalChecks.every((c) => c.ok)) {
          alreadyRolledBack = true;
          rollbackInfo = {
            triggered: true,
            source: 'hot_switch_internal',
            ok: true,
            releaseId: previousReleaseId,
            buildId: previousBuildId,
            spaces: internalChecks.map(summarizeSpaceCheck),
            error: null,
          };
        }
      }
      if (!alreadyRolledBack) {
        try {
          const rb = await rollbackRuntime({
            runtimeRoot: resolvedRuntime,
            kikiHome: resolvedHome,
            releaseId: previousReleaseId,
            expectedCommit: previousBuildId ?? undefined,
            hotSwitchScript,
            startupSeconds,
            stopGraceSeconds,
            ledgerPath: resolvedLedger,
            spaces: preSpaces,
            resolveProcessPath,
            callApi,
            runHotSwitch,
          });
          rollbackInfo = {
            triggered: true,
            source: 'conductor_auto_rollback',
            ok: rb.ok,
            releaseId: rb.releaseId,
            buildId: rb.buildId,
            spaces: rb.spaces,
            error: null,
          };
        } catch (rollbackError) {
          rollbackInfo = {
            triggered: true,
            source: 'conductor_auto_rollback',
            ok: false,
            releaseId: previousReleaseId,
            buildId: previousBuildId,
            spaces: rollbackError?.failureReport?.spaces ?? [],
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          };
        }
      }
    }

    const failureReport = {
      schemaVersion: 1,
      ok: false,
      failedAtUtc: new Date().toISOString(),
      stage,
      error: switchError instanceof Error ? switchError.message : String(switchError),
      runtimeRoot: resolvedRuntime,
      kikiHome: resolvedHome,
      previousReleaseId,
      previousBuildId,
      targetReleaseId,
      targetCommit,
      spaceChecks: spaceChecks.map(summarizeSpaceCheck),
      rollback: rollbackInfo,
      reportPath,
      report,
    };
    writeJsonAtomic(resolvedLedger, { ...preInspect, switchSnapshot, lastSwitch: failureReport });
    const wrapped = switchError instanceof Error ? switchError : new Error(String(switchError));
    wrapped.failureReport = failureReport;
    throw wrapped;
  }
}

export function parseConductorArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    return { command: 'help', options: {} };
  }
  if (!['bootstrap-ops', 'inspect', 'switch', 'rollback', 'reconcile'].includes(command)) {
    throw new Error(`Unknown command '${command}'. Expected one of: bootstrap-ops, inspect, switch, rollback, reconcile.`);
  }
  const booleanFlags = new Set([
    '--json',
    '--skip-canary',
    '--background',
    '--no-interrupt-after-settle',
    '--no-auto-rollback',
    '--no-sync-config',
    '--nudge',
    '--nudge-interrupted',
  ]);
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${flag}`);
    }
    if (booleanFlags.has(flag)) {
      options[flag.slice(2)] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option ${flag} requires a value.`);
    }
    options[flag.slice(2)] = value;
    i += 1;
  }
  return { command, options };
}

function parsePositiveInt(raw, fallback, label) {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function formatSummary(command, result) {
  if (command === 'bootstrap-ops') {
    return [
      `Kiki-Ops bootstrapped:`,
      `  Launcher:    ${result.launcherPath} (forces KIKI_HOME=${result.opsHome})`,
      `  CLI:         ${result.cliPath} (${result.bytes} bytes, sha256=${result.sha256.slice(0, 12)}...)`,
      `  Home:        ${result.opsHome}`,
      `  Config:      ${result.configPath} (synced=${result.syncedConfig}, creds=${result.syncedCredentials}, agents=${result.syncedAgentsCount}, [search] enabled=false, [mcp] empty)`,
    ].join('\n');
  }
  if (command === 'inspect') {
    const srv = result.liveServer;
    const lines = [
      `Readiness: ${result.readiness}`,
      srv
        ? `  Server:  ${srv.server_id} (pid=${srv.pid}, layout=${srv.layout}, build=${srv.build_id}, exe=${srv.executablePath})`
        : `  Server:  none (${result.tokenError ?? 'not running'})`,
      `  Pending: ${result.workPendingDetails.length} session(s)`,
    ];
    if (result.activeSessionsError) {
      lines.push(`  Sessions: unavailable (${result.activeSessionsError})`);
    }
    lines.push(`  Ledger:  ${result.ledgerPath}`);
    return lines.join('\n');
  }
  if (command === 'rollback') {
    return [
      `Rollback complete: ${result.releaseId}`,
      `  Build:   ${result.buildId ?? 'unknown'}`,
      `  Spaces:  ${result.spaces.length} verified`,
    ].join('\n');
  }
  if (command === 'reconcile') {
    return [
      `Reconcile (${result.nudgeEnabled ? 'nudge' : 'report-only'}): ${result.interruptedCount} session(s)`,
      `  Server:  ${result.liveServer.server_id} (pid=${result.liveServer.pid}, build=${result.liveServer.build_id})`,
      ...result.results.map(
        (r) => `  - ${r.sessionId}: activity=${r.activityStatus ?? 'unknown'}, control=${r.controlPhase}, nudged=${r.nudged}${r.reason ? ` (${r.reason})` : ''}${r.error ? ` [error: ${r.error}]` : ''}`,
      ),
    ].join('\n');
  }
  return [
    `Switch complete: ${result.postSwitch.releaseId}`,
    `  Server:  ${result.postSwitch.server_id} (pid=${result.postSwitch.pid}, build=${result.postSwitch.build_id})`,
    `  Binary:  ${result.postSwitch.executablePath}`,
    `  Spaces:  ${(result.spaceChecks ?? []).length} verified`,
    `  Interrupted sessions: ${result.reconcile.interruptedCount}`,
  ].join('\n');
}

async function main() {
  const { command, options } = parseConductorArgs(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(
      [
        'Usage: node kiki-ops-conductor.mjs <bootstrap-ops|inspect|switch|rollback|reconcile> [options]',
        '  bootstrap-ops  --ops-runtime <dir> --ops-home <dir> [--source-cli <exe>] [--source-runtime <dir>] [--source-home <dir>] [--no-sync-config] [--json]',
        '  inspect        [--runtime-root <dir>] [--kiki-home <dir>] [--candidate-root <dir>] [--expected-commit <sha>] [--ledger-path <file>] [--json]',
        '  switch         [--runtime-root <dir>] [--kiki-home <dir>] --candidate-root <dir> [--expected-commit <sha>] [--settle-seconds <n>] [--skip-canary] [--no-auto-rollback] [--nudge-interrupted] [--json]',
        '  rollback       [--runtime-root <dir>] [--kiki-home <dir>] [--release-id <id>] [--expected-commit <sha>] [--startup-seconds <n>] [--stop-grace-seconds <n>] [--json]',
        '  reconcile      [--runtime-root <dir>] [--kiki-home <dir>] [--report-path <file>] [--sessions <id1,id2>] [--nudge] [--prompt <text>] [--json]',
      ].join('\n') + '\n',
    );
    return;
  }

  let result;
  try {
    if (command === 'bootstrap-ops') {
      result = bootstrapOps({
        opsRuntime: options['ops-runtime'],
        opsHome: options['ops-home'],
        sourceCli: options['source-cli'],
        sourceRuntime: options['source-runtime'],
        sourceHome: options['source-home'],
        targetRuntime: options['runtime-root'],
        targetHome: options['kiki-home'],
        syncConfig: !options['no-sync-config'],
      });
    } else if (command === 'inspect') {
      result = await inspectRuntime({
        runtimeRoot: options['runtime-root'],
        kikiHome: options['kiki-home'],
        candidateRoot: options['candidate-root'],
        expectedCommit: options['expected-commit'],
        ledgerPath: options['ledger-path'],
      });
    } else if (command === 'rollback') {
      result = await rollbackRuntime({
        runtimeRoot: options['runtime-root'],
        kikiHome: options['kiki-home'],
        releaseId: options['release-id'],
        expectedCommit: options['expected-commit'],
        hotSwitchScript: options['hot-switch-script'],
        startupSeconds: parsePositiveInt(options['startup-seconds'], 90, '--startup-seconds'),
        stopGraceSeconds: parsePositiveInt(options['stop-grace-seconds'], 30, '--stop-grace-seconds'),
        ledgerPath: options['ledger-path'],
      });
    } else if (command === 'reconcile') {
      const sessions = options.sessions ? String(options.sessions).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      result = await reconcileSwitch({
        runtimeRoot: options['runtime-root'],
        kikiHome: options['kiki-home'],
        reportPath: options['report-path'],
        sessions,
        nudge: Boolean(options.nudge),
        prompt: options.prompt,
      });
    } else if (command === 'switch') {
      result = await switchRuntime({
        runtimeRoot: options['runtime-root'],
        kikiHome: options['kiki-home'],
        candidateRoot: options['candidate-root'],
        expectedCommit: options['expected-commit'],
        hotSwitchScript: options['hot-switch-script'],
        settleSeconds: parsePositiveInt(options['settle-seconds'], 600, '--settle-seconds'),
        startupSeconds: parsePositiveInt(options['startup-seconds'], 90, '--startup-seconds'),
        stopGraceSeconds: parsePositiveInt(options['stop-grace-seconds'], 30, '--stop-grace-seconds'),
        canaryTimeoutSeconds:
          options['canary-timeout-seconds'] === undefined
            ? undefined
            : parsePositiveInt(options['canary-timeout-seconds'], 0, '--canary-timeout-seconds'),
        skipCanary: Boolean(options['skip-canary']),
        background: Boolean(options.background),
        noInterruptAfterSettle: Boolean(options['no-interrupt-after-settle']),
        autoRollback: !options['no-auto-rollback'],
        nudgeInterrupted: Boolean(options['nudge-interrupted']),
        nudgePrompt: options['nudge-prompt'],
        ledgerPath: options['ledger-path'],
      });
    }
  } catch (error) {
    if (options.json && error?.failureReport) {
      process.stdout.write(`${JSON.stringify(error.failureReport, null, 2)}\n`);
    }
    throw error;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(command, result)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`kiki-ops-conductor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

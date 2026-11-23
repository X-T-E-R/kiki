#!/usr/bin/env node
/**
 * Out-of-band Kiki-Ops switch conductor for managing EasyAgent\Kiki desktop runtime switches.
 * Commands: bootstrap-ops | inspect | switch | reconcile
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
  targetRuntime = defaultRuntimeRoot(),
  targetHome = defaultKikiHome(),
} = {}) {
  const resolvedOpsRuntime = resolve(opsRuntime);
  const resolvedOpsHome = resolve(opsHome);
  const resolvedTargetRuntime = resolve(targetRuntime);
  const resolvedTargetHome = resolve(targetHome);

  if (normalizeComparePath(resolvedOpsRuntime) === normalizeComparePath(resolvedTargetRuntime)) {
    throw new Error(`Refusing to bootstrap Kiki-Ops into the live target runtime: ${resolvedOpsRuntime}`);
  }
  if (normalizeComparePath(resolvedOpsHome) === normalizeComparePath(resolvedTargetHome)) {
    throw new Error(`Refusing to bootstrap Kiki-Ops into the live target home: ${resolvedOpsHome}`);
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

  mkdirSync(resolvedOpsHome, { recursive: true });
  const configPath = ensureSearchDisabledConfig(join(resolvedOpsHome, 'config.toml'));

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
    cliPath: cliDest,
    launcherPath,
    invocation: `"${launcherPath}"`,
    manifestPath,
    configPath,
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
  ledgerPath,
  resolveProcessPath = defaultResolveProcessPath,
  callApi = callLocalApi,
  runHotSwitch = defaultRunHotSwitch,
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

  const switchRun = await runHotSwitch(resolve(hotSwitchScript), psArgs);
  const reportPath = join(resolvedRuntime, 'hot-switch-report.json');
  const report = readJsonIfExists(reportPath);

  const postDiscovered = await discoverLiveServer({
    runtimeRoot: resolvedRuntime,
    kikiHome: resolvedHome,
    resolveProcessPath,
    callApi,
  });
  if (!postDiscovered.server) {
    throw new Error('Post-switch verification failed: no live managed Kiki server found.');
  }
  const expectedActiveServer = join(resolvedRuntime, 'active', 'kiki-server.exe');
  if (normalizeComparePath(postDiscovered.server.executablePath) !== normalizeComparePath(expectedActiveServer)) {
    throw new Error(
      `Post-switch verification failed: server is running from '${postDiscovered.server.executablePath}' instead of '${expectedActiveServer}'.`,
    );
  }
  if (targetCommit && postDiscovered.server.meta.build_id !== targetCommit) {
    throw new Error(
      `Post-switch verification failed: build_id '${postDiscovered.server.meta.build_id}' !== expected '${targetCommit}'.`,
    );
  }
  if (
    preInspect.liveServer &&
    report?.outcome !== 'already_running' &&
    postDiscovered.server.pid === preInspect.liveServer.pid
  ) {
    throw new Error(`Post-switch verification failed: server PID did not change (${postDiscovered.server.pid}).`);
  }

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
    preSwitch: preInspect.liveServer,
    postSwitch: {
      server_id: postDiscovered.server.meta.server_id,
      pid: postDiscovered.server.pid,
      port: postDiscovered.server.port,
      executablePath: postDiscovered.server.executablePath,
      layout: postDiscovered.server.layout,
      releaseId: postDiscovered.server.releaseId,
      build_id: postDiscovered.server.meta.build_id,
    },
    reportPath,
    report,
    reconcile,
    switchStdout: switchRun.stdout?.trim() ?? '',
  };
  writeJsonAtomic(resolvedLedger, { ...preInspect, lastSwitch: result });
  return result;
}

export function parseConductorArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    return { command: 'help', options: {} };
  }
  if (!['bootstrap-ops', 'inspect', 'switch', 'reconcile'].includes(command)) {
    throw new Error(`Unknown command '${command}'. Expected one of: bootstrap-ops, inspect, switch, reconcile.`);
  }
  const booleanFlags = new Set([
    '--json',
    '--skip-canary',
    '--background',
    '--no-interrupt-after-settle',
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
      `  Launcher: ${result.launcherPath} (forces KIKI_HOME=${result.opsHome})`,
      `  CLI:      ${result.cliPath} (${result.bytes} bytes, sha256=${result.sha256.slice(0, 12)}...)`,
      `  Home:     ${result.opsHome}`,
      `  Config:   ${result.configPath} ([search] enabled = false)`,
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
    `  Interrupted sessions: ${result.reconcile.interruptedCount}`,
  ].join('\n');
}

async function main() {
  const { command, options } = parseConductorArgs(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(
      [
        'Usage: node kiki-ops-conductor.mjs <bootstrap-ops|inspect|switch|reconcile> [options]',
        '  bootstrap-ops  --ops-runtime <dir> --ops-home <dir> [--source-cli <exe>] [--source-runtime <dir>] [--json]',
        '  inspect        [--runtime-root <dir>] [--kiki-home <dir>] [--candidate-root <dir>] [--expected-commit <sha>] [--ledger-path <file>] [--json]',
        '  switch         [--runtime-root <dir>] [--kiki-home <dir>] --candidate-root <dir> [--expected-commit <sha>] [--settle-seconds <n>] [--skip-canary] [--nudge-interrupted] [--json]',
        '  reconcile      [--runtime-root <dir>] [--kiki-home <dir>] [--report-path <file>] [--sessions <id1,id2>] [--nudge] [--prompt <text>] [--json]',
      ].join('\n') + '\n',
    );
    return;
  }

  let result;
  if (command === 'bootstrap-ops') {
    result = bootstrapOps({
      opsRuntime: options['ops-runtime'],
      opsHome: options['ops-home'],
      sourceCli: options['source-cli'],
      sourceRuntime: options['source-runtime'],
      targetRuntime: options['runtime-root'],
      targetHome: options['kiki-home'],
    });
  } else if (command === 'inspect') {
    result = await inspectRuntime({
      runtimeRoot: options['runtime-root'],
      kikiHome: options['kiki-home'],
      candidateRoot: options['candidate-root'],
      expectedCommit: options['expected-commit'],
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
      nudgeInterrupted: Boolean(options['nudge-interrupted']),
      nudgePrompt: options['nudge-prompt'],
      ledgerPath: options['ledger-path'],
    });
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

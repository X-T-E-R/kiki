import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { atomicCreate, atomicWrite, syncDir } from '#/_base/utils/fs';
import { acquireFileLock } from '#/persistence/backends/node-fs/fileLock';

import { HomeRuntimeError } from './errors';

export interface DirectoryIdentity {
  readonly canonicalHomeDir: string;
  readonly runtimeDir: string;
  readonly token: string;
  readonly hostId: string;
}

export interface PersistedOwnerRecord {
  readonly ownerHostId?: string;
  readonly epoch?: number;
  readonly commitToken?: string;
}

export interface CommittedOwnerRecord {
  readonly ownerHostId: string;
  readonly epoch: number;
  readonly commitToken: string;
}

export interface OwnerCommitGuard {
  readonly signal: AbortSignal;
  readonly commitToken: string;
}

export const RUNTIME_HOST_REL_PARTS = ['store', 'runtime-host'] as const;

export const TOKEN_FILENAME = 'token';

export const OWNER_FILENAME = 'owner.json';

export const STAGING_PREFIX = '.staging-';

export const PIPE_PREFIX = 'kimi-home-runtime-';

export const SOCK_PREFIX = 'kimi-home-runtime-';

const MODE_DIR = 0o700;
const MODE_PRIVATE_FILE = 0o600;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const STALE_PROBE_TIMEOUT_MS = 500;
const OWNER_LOCK_FILENAME = 'owner.lock';
const OWNER_LOCK_WAIT_MS = 5_000;
const CORRUPT_SUFFIX = '.corrupt-';

export function runtimeDirFor(canonicalHomeDir: string): string {
  return join(canonicalHomeDir, ...RUNTIME_HOST_REL_PARTS);
}

export function canonicalizeHomeDir(platform: NodeJS.Platform, homeDir: string): string {
  if (!isAbsolute(homeDir)) {
    throw new HomeRuntimeError('runtime.invalid_config', `homeDir must be absolute: ${homeDir}`);
  }
  const normalized = resolve(stripTrailingSep(resolve(homeDir)));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function stripTrailingSep(path: string): string {
  if (path.length > 1) return path.replace(/[\\/]+$/, '');
  return path;
}

export async function realpathHomeDir(platform: NodeJS.Platform, homeDir: string): Promise<string> {
  const resolved = await realpath(homeDir).catch(() => undefined);
  if (resolved === undefined) return canonicalizeHomeDir(platform, homeDir);
  return canonicalizeHomeDir(platform, resolved);
}

function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

function endpointId(canonicalHomeDir: string): string {
  return createHash('sha256').update(canonicalHomeDir).digest('hex');
}

export function namedPipePath(canonicalHomeDir: string): string {
  return `\\\\.\\pipe\\${PIPE_PREFIX}${endpointId(canonicalHomeDir).slice(0, 40)}`;
}

export function unixSocketPath(canonicalHomeDir: string): string {
  return join(runtimeDirFor(canonicalHomeDir), 'runtime.sock');
}

export function endpointPathFor(platform: NodeJS.Platform, canonicalHomeDir: string): string {
  if (platform === 'win32') return namedPipePath(canonicalHomeDir);
  const endpoint = unixSocketPath(canonicalHomeDir);
  const limit = platform === 'linux' ? 107 : 103;
  const bytes = Buffer.byteLength(endpoint, 'utf8');
  if (bytes > limit) {
    throw new HomeRuntimeError(
      'runtime.invalid_config',
      `runtime socket path is ${bytes} UTF-8 bytes; ${platform} supports at most ${limit}; use a shorter canonical KIKI_HOME`,
    );
  }
  return endpoint;
}

export function runtimeTokenPath(canonicalHomeDir: string): string {
  return join(runtimeDirFor(canonicalHomeDir), TOKEN_FILENAME);
}

export function runtimeOwnerPath(canonicalHomeDir: string): string {
  return join(runtimeDirFor(canonicalHomeDir), OWNER_FILENAME);
}

export function isEndpointInRuntimeHostDir(canonicalHomeDir: string, candidate: string): boolean {
  const base = runtimeDirFor(canonicalHomeDir);
  const rel = relative(resolve(base), resolve(candidate));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export function isEndpointPathRecognized(canonicalHomeDir: string, endpointPath: string): boolean {
  if (endpointPath.startsWith('\\\\.\\pipe\\')) return endpointPath === namedPipePath(canonicalHomeDir);
  if (!isEndpointInRuntimeHostDir(canonicalHomeDir, endpointPath)) return false;
  const rel = relative(resolve(runtimeDirFor(canonicalHomeDir)), resolve(endpointPath));
  return rel === 'runtime.sock' || rel === `${SOCK_PREFIX}${endpointId(canonicalHomeDir)}.sock`;
}

export function isAddrInUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function mapRuntimeIoError(error: unknown, path: string, op: string): HomeRuntimeError {
  return new HomeRuntimeError('runtime.io_failed', `runtime ${op} failed for ${path}`, { cause: error });
}

function readOptionalFile(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

function validToken(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed !== undefined && TOKEN_PATTERN.test(trimmed) ? trimmed : undefined;
}

function corruptBackupPath(path: string): string {
  return `${path}${CORRUPT_SUFFIX}${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function acquireOwnerLock(runtimeDir: string, owner: Readonly<Record<string, unknown>>): ReturnType<typeof acquireFileLock> {
  return acquireFileLock(join(runtimeDir, OWNER_LOCK_FILENAME), { waitForMs: OWNER_LOCK_WAIT_MS, owner });
}

async function unlinkQuietly(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function chmodIfSupported(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, mode).catch(() => undefined);
}

async function ensurePrivateDir(runtimeDir: string): Promise<void> {
  await mkdir(runtimeDir, { recursive: true, mode: MODE_DIR });
  await chmodIfSupported(runtimeDir, MODE_DIR);
}

export async function bootstrapHomeIdentity(
  platform: NodeJS.Platform,
  homeDir: string,
): Promise<DirectoryIdentity> {
  const canonicalHomeDir = await realpathHomeDir(platform, homeDir);
  const runtimeDir = runtimeDirFor(canonicalHomeDir);
  try {
    await ensurePrivateDir(runtimeDir);
    const token = await ensureToken(canonicalHomeDir);
    const hostId = `runtime-${randomUUID()}`;
    return { canonicalHomeDir, runtimeDir, token, hostId };
  } catch (error) {
    if (error instanceof HomeRuntimeError) throw error;
    throw mapRuntimeIoError(error, runtimeDir, 'bootstrap');
  }
}

async function ensureToken(canonicalHomeDir: string): Promise<string> {
  const path = runtimeTokenPath(canonicalHomeDir);
  const existing = await readOptionalFile(path);
  if (existing === undefined) {
    try {
      await atomicCreate(path, randomToken(), MODE_PRIVATE_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const created = validToken(await readOptionalFile(path));
    if (created !== undefined) return created;
  } else {
    const valid = validToken(existing);
    if (valid !== undefined) return valid;
  }
  return repairToken(canonicalHomeDir, path);
}

async function repairToken(canonicalHomeDir: string, path: string): Promise<string> {
  const runtimeDir = runtimeDirFor(canonicalHomeDir);
  const lock = await acquireOwnerLock(runtimeDir, { kind: 'runtime-token' });
  try {
    const current = await readOptionalFile(path);
    const valid = validToken(current);
    if (valid !== undefined) return valid;
    if (current !== undefined) {
      await atomicWrite(corruptBackupPath(path), current, undefined, MODE_PRIVATE_FILE);
    }
    await atomicWrite(path, randomToken(), undefined, MODE_PRIVATE_FILE);
    await syncDir(runtimeDir);
    const repaired = validToken(await readOptionalFile(path));
    if (repaired !== undefined) return repaired;
    throw new HomeRuntimeError('runtime.io_failed', `runtime token at ${path} is unreadable`);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

function parseOwnerRecord(raw: string): PersistedOwnerRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const record = parsed as Record<string, unknown>;
  return {
    ownerHostId: typeof record['ownerHostId'] === 'string' ? record['ownerHostId'] : undefined,
    epoch:
      typeof record['epoch'] === 'number' && Number.isSafeInteger(record['epoch']) && record['epoch'] >= 0
        ? record['epoch']
        : undefined,
    commitToken: typeof record['commitToken'] === 'string' ? record['commitToken'] : undefined,
  };
}

export async function readPersistedOwner(
  canonicalHomeDir: string,
): Promise<PersistedOwnerRecord> {
  const path = runtimeOwnerPath(canonicalHomeDir);
  try {
    const raw = await readOptionalFile(path);
    if (raw === undefined) return {};
    return parseOwnerRecord(raw) ?? (await quarantineCorruptOwner(canonicalHomeDir, path));
  } catch (error) {
    if (error instanceof HomeRuntimeError) throw error;
    throw mapRuntimeIoError(error, path, 'read-owner');
  }
}

async function quarantineCorruptOwner(canonicalHomeDir: string, path: string): Promise<PersistedOwnerRecord> {
  const runtimeDir = runtimeDirFor(canonicalHomeDir);
  const lock = await acquireOwnerLock(runtimeDir, { kind: 'runtime-owner-repair' });
  try {
    const raw = await readOptionalFile(path);
    if (raw === undefined) return {};
    const record = parseOwnerRecord(raw);
    if (record !== undefined) return record;
    await rename(path, corruptBackupPath(path));
    await syncDir(runtimeDir);
    return {};
  } finally {
    await lock.release().catch(() => undefined);
  }
}

export async function writePersistedOwner(
  canonicalHomeDir: string,
  record: CommittedOwnerRecord,
  guard: OwnerCommitGuard,
): Promise<void> {
  if (record.commitToken !== guard.commitToken) {
    throw new HomeRuntimeError('runtime.invalid_request', 'runtime owner commit token mismatch');
  }
  throwIfOwnerCommitAborted(guard.signal);
  const path = runtimeOwnerPath(canonicalHomeDir);
  const runtimeDir = runtimeDirFor(canonicalHomeDir);
  const payload = `${JSON.stringify(record)}\n`;
  let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
  try {
    lock = await acquireOwnerLock(runtimeDir, { kind: 'runtime-owner', ownerHostId: record.ownerHostId, epoch: record.epoch });
    throwIfOwnerCommitAborted(guard.signal);
    await atomicWrite(path, payload, undefined, MODE_PRIVATE_FILE, guard.signal, true);
    await syncDir(runtimeDir);
  } catch (error) {
    if (guard.signal.aborted) throwIfOwnerCommitAborted(guard.signal);
    if (error instanceof HomeRuntimeError) throw error;
    throw mapRuntimeIoError(error, path, 'write-owner');
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

function throwIfOwnerCommitAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new HomeRuntimeError('runtime.detached', 'runtime owner commit was cancelled');
}

type StaleEndpointDecision = 'removed' | 'live' | 'empty' | 'foreign' | 'pipe';

export async function tryRemoveStaleEndpoint(
  platform: NodeJS.Platform,
  canonicalHomeDir: string,
  endpointPath: string,
): Promise<StaleEndpointDecision> {
  if (platform === 'win32' || endpointPath.startsWith('\\\\.\\pipe\\')) return 'pipe';
  if (!isEndpointPathRecognized(canonicalHomeDir, endpointPath)) return 'foreign';
  const st = await lstat(endpointPath).catch(() => undefined);
  if (st === undefined) return 'empty';
  if (!st.isFile() && !st.isSocket()) return 'foreign';
  if (await isEndpointLive(endpointPath)) return 'live';
  await unlinkQuietly(endpointPath);
  return 'removed';
}

export async function removeOwnedEndpoint(platform: NodeJS.Platform, canonicalHomeDir: string, endpointPath: string): Promise<void> {
  if (platform === 'win32' || endpointPath.startsWith('\\\\.\\pipe\\')) return;
  if (!isEndpointPathRecognized(canonicalHomeDir, endpointPath)) return;
  await unlinkQuietly(endpointPath);
}

export function isEndpointLive(endpointPath: string): Promise<boolean> {
  return new Promise<boolean>((resolveLive) => {
    try {
      const socket = createConnection(endpointPath);
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolveLive(result);
      };
      socket.setTimeout(STALE_PROBE_TIMEOUT_MS, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    } catch {
      resolveLive(false);
    }
  });
}

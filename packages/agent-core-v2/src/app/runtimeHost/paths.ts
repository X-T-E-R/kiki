import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { chmod, lstat, link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  const digest = createHash('sha256').update(canonicalHomeDir).digest('hex');
  return process.platform === 'win32' ? digest.slice(0, 40) : digest;
}

export function namedPipePath(canonicalHomeDir: string): string {
  return `\\\\.\\pipe\\${PIPE_PREFIX}${endpointId(canonicalHomeDir)}`;
}

export function unixSocketPath(canonicalHomeDir: string): string {
  return join(runtimeDirFor(canonicalHomeDir), `${SOCK_PREFIX}${endpointId(canonicalHomeDir)}.sock`);
}

export function endpointPathFor(platform: NodeJS.Platform, canonicalHomeDir: string): string {
  return platform === 'win32' ? namedPipePath(canonicalHomeDir) : unixSocketPath(canonicalHomeDir);
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
  if (endpointPath.startsWith('\\\\.\\pipe\\')) return true;
  if (!isEndpointInRuntimeHostDir(canonicalHomeDir, endpointPath)) return false;
  const base = endpointPath.slice(endpointPath.lastIndexOf(sep) + 1);
  return base.startsWith(PIPE_PREFIX) || base.startsWith(SOCK_PREFIX);
}

export function isAddrInUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function mapRuntimeIoError(error: unknown, path: string, op: string): HomeRuntimeError {
  return new HomeRuntimeError('runtime.io_failed', `runtime ${op} failed for ${path}`, { cause: error });
}

function readTrimmedFile(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8')
    .then((text) => {
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
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

async function installStable(pending: string, target: string): Promise<void> {
  try {
    await link(pending, target);
    await unlinkQuietly(pending);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await unlinkQuietly(pending);
      return;
    }
    if (process.platform === 'win32') {
      try {
        await rename(pending, target);
      } catch (renameError) {
        await unlinkQuietly(pending);
        if ((renameError as NodeJS.ErrnoException).code !== 'EEXIST') throw renameError;
      }
      return;
    }
    throw error;
  }
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
  const existing = await readTrimmedFile(path);
  if (existing !== undefined) {
    if (!TOKEN_PATTERN.test(existing)) {
      throw new HomeRuntimeError('runtime.io_failed', `runtime token at ${path} is malformed`);
    }
    return existing;
  }
  const pending = `${path}${STAGING_PREFIX}${process.pid}-${randomUUID()}`;
  const value = randomToken();
  try {
    await writeFile(pending, value, { mode: MODE_PRIVATE_FILE, flag: 'wx' });
    await chmodIfSupported(pending, MODE_PRIVATE_FILE);
    await installStable(pending, path);
  } catch (error) {
    await unlinkQuietly(pending);
    throw error;
  }
  return finalizeToken(path, value);
}

async function finalizeToken(path: string, written: string): Promise<string> {
  const value = await readTrimmedFile(path);
  if (value !== undefined && TOKEN_PATTERN.test(value)) return value;
  if (TOKEN_PATTERN.test(written)) return written;
  throw new HomeRuntimeError('runtime.io_failed', `runtime token at ${path} is unreadable`);
}

export async function readPersistedOwner(
  canonicalHomeDir: string,
): Promise<PersistedOwnerRecord> {
  const path = runtimeOwnerPath(canonicalHomeDir);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw mapRuntimeIoError(error, path, 'read-owner');
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
  const pending = `${path}${STAGING_PREFIX}${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify(record)}\n`;
  try {
    await writeFile(pending, payload, { mode: MODE_PRIVATE_FILE, flag: 'wx' });
    await chmodIfSupported(pending, MODE_PRIVATE_FILE);
    throwIfOwnerCommitAborted(guard.signal);
    renameSync(pending, path);
  } catch (error) {
    await unlinkQuietly(pending);
    if (error instanceof HomeRuntimeError) throw error;
    throw mapRuntimeIoError(error, path, 'write-owner');
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

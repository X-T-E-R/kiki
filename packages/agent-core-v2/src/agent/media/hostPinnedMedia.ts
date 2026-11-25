import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

/** Protocol prefix for explicit non-archived local host-pinned media references. */
export const HOSTREF_PROTOCOL = 'hostref:';

/** Minimum byte size (4 MiB) eligible for explicit host-pinned A/V references. */
export const HOST_PINNED_MIN_BYTES = 4 * 1024 * 1024;

/** Session sub-scope storing opaque host-pinned media reference manifests. */
export const HOST_PINNED_SUBSCOPE = 'host-pinned';

const HOST_PINNED_REF_ID_RE = /^hp_[0-9a-f]{32}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

/** Durable session-scoped descriptor for an explicit non-archived local host A/V reference. */
export interface HostPinnedRefRecord {
  readonly version: 1;
  readonly refId: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly fileIdentity: string;
  readonly allowedRoots: readonly string[];
  readonly createdAt: number;
}

/** Input required to register an explicit local host-pinned A/V reference in a session. */
export interface RegisterHostPinnedRefInput {
  readonly sessionScope: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly path: string;
  readonly mimeType: string;
  readonly allowedRoots: readonly string[];
  readonly signal?: AbortSignal;
}

/** Result of inspecting a local host file under a write-deny read handle. */
export interface PinnedHostInspection {
  readonly realPath: string;
  readonly sha256: string;
  readonly size: number;
  readonly fileIdentity: string;
  readonly verifiedBytes: number;
}

/** Verified exclusive-read stream opened from the exact handle that passed full-file digest verification. */
export interface VerifiedPinnedHostStream {
  readonly size: number;
  readonly sha256: string;
  readonly fileIdentity: string;
  readonly verifiedBytes: number;
  readonly stream: Readable;
  readonly close: () => void;
}

/** Error raised when a host-pinned media source is missing, altered, replaced, or cannot obtain a stable write-deny read handle. */
export class HostPinnedSourceChangedError extends Error {
  readonly code = 'media_source_changed_or_missing' as const;

  constructor(readonly reason: string) {
    super(`media_source_changed_or_missing: ${reason}`);
    this.name = 'HostPinnedSourceChangedError';
  }
}

/** Error raised when the current platform or runtime cannot guarantee an exclusive write-deny read handle for host-pinned media. */
export class HostPinnedUnsupportedError extends Error {
  readonly code = 'host_pinned_unsupported' as const;

  constructor(reason: string) {
    super(reason);
    this.name = 'HostPinnedUnsupportedError';
  }
}

/** Parses `hostref:hp_<32hex>` into its opaque ref ID. */
export function parseHostPinnedUrl(url: string): { readonly refId: string } | undefined {
  if (!url.startsWith(HOSTREF_PROTOCOL)) return undefined;
  const refId = url.slice(HOSTREF_PROTOCOL.length);
  return HOST_PINNED_REF_ID_RE.test(refId) ? { refId } : undefined;
}

/** Validates an opaque host-pinned ref ID (`hp_<32hex>`). */
export function isHostPinnedRefId(value: string): boolean {
  return HOST_PINNED_REF_ID_RE.test(value);
}

/** Formats a host-pinned ref ID into a `hostref:` URL. */
export function formatHostPinnedUrl(refId: string): string {
  return `${HOSTREF_PROTOCOL}${refId}`;
}

let cachedDefaultHelperPath: string | undefined | null = null;

function resolvePinnedReaderHelperPath(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const configured = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
  if (configured !== undefined) {
    return configured.length > 0 && existsSync(configured) ? configured : undefined;
  }
  if (cachedDefaultHelperPath !== null) {
    return cachedDefaultHelperPath;
  }
  cachedDefaultHelperPath = [
    './windows-process-helper.exe',
    './native/windows-process-helper.exe',
    '../../../dist/windows-process-helper.exe',
    '../../../../dist/windows-process-helper.exe',
  ]
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find(existsSync);
  return cachedDefaultHelperPath;
}

/** Returns true when this platform and runtime can acquire an OS write-deny read lease for host-pinned media. */
export function isHostPinnedSupported(): boolean {
  return resolvePinnedReaderHelperPath() !== undefined;
}

function normalizedForCompare(value: string): string {
  const norm = normalize(value).replaceAll('\\', '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizedForCompare(targetPath);
  const normRoot = normalizedForCompare(rootPath);
  if (normTarget === normRoot) return true;
  const rel = relative(normRoot, normTarget);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function isPathWithinAnyRoot(targetPath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  return roots.some((root) => root.length > 0 && isPathWithinRoot(targetPath, root));
}

function isValidRecord(value: unknown): value is HostPinnedRefRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<HostPinnedRefRecord>;
  return (
    candidate.version === 1 &&
    typeof candidate.refId === 'string' &&
    HOST_PINNED_REF_ID_RE.test(candidate.refId) &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    typeof candidate.path === 'string' &&
    isAbsolute(candidate.path) &&
    typeof candidate.mimeType === 'string' &&
    (candidate.mimeType.startsWith('video/') || candidate.mimeType.startsWith('audio/')) &&
    typeof candidate.size === 'number' &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= HOST_PINNED_MIN_BYTES &&
    typeof candidate.sha256 === 'string' &&
    SHA256_RE.test(candidate.sha256) &&
    typeof candidate.fileIdentity === 'string' &&
    candidate.fileIdentity.length > 0 &&
    Array.isArray(candidate.allowedRoots) &&
    candidate.allowedRoots.every((root) => typeof root === 'string' && isAbsolute(root)) &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt)
  );
}

async function runPinnedHelper(input: {
  readonly mode: 'inspect' | 'stream';
  readonly path: string;
  readonly expectedSha256?: string;
  readonly expectedSize?: number;
  readonly expectedIdentity?: string;
  readonly start: number;
  readonly end: number;
  readonly signal?: AbortSignal;
}): Promise<VerifiedPinnedHostStream> {
  input.signal?.throwIfAborted();
  const helperPath = resolvePinnedReaderHelperPath();
  if (helperPath === undefined) {
    throw new HostPinnedUnsupportedError('Host-pinned media references are unsupported on this platform without an exclusive write-deny read helper.');
  }
  const child = spawn(helperPath, ['--pinned-reader', 'v1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    input.signal?.removeEventListener('abort', onAbort);
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
  };
  const onAbort = (): void => {
    close();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  const requestLine = [
    input.mode,
    Buffer.from(input.path, 'utf8').toString('base64'),
    input.expectedSha256 ?? '-',
    input.expectedSize === undefined ? '-' : String(input.expectedSize),
    input.expectedIdentity ?? '-',
    String(input.start),
    String(input.end),
  ].join('\t');

  return new Promise<VerifiedPinnedHostStream>((resolve, reject) => {
    let settled = false;
    let childClosed = false;
    const childExited = new Promise<void>((resolveExit) => {
      child.once('close', () => {
        childClosed = true;
        resolveExit();
      });
    });
    const rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      rl.close();
      close();
      if (childClosed) {
        reject(error);
      } else {
        void childExited.then(() => reject(error));
      }
    };

    child.once('error', (error) => {
      fail(new HostPinnedSourceChangedError(error.message));
    });
    child.once('close', (code) => {
      if (!settled) {
        if (code === 2) {
          fail(new HostPinnedUnsupportedError('Host-pinned media helper does not support --pinned-reader v1.'));
        } else {
          fail(new HostPinnedSourceChangedError(`helper_exited_${String(code)}`));
        }
      } else {
        input.signal?.removeEventListener('abort', onAbort);
      }
    });
    rl.once('line', (line) => {
      if (settled) return;
      const parts = line.split('\t');
      if (parts[0] === 'ok' && parts.length >= 5) {
        settled = true;
        rl.close();
        const sha256 = parts[1]!;
        const size = Number(parts[2]);
        const fileIdentity = parts[3]!;
        const verifiedBytes = Number(parts[4]);
        if (!SHA256_RE.test(sha256) || !Number.isSafeInteger(size) || size < 0) {
          close();
          void childExited.then(() => reject(new HostPinnedSourceChangedError('invalid_verification_receipt')));
          return;
        }
        const receipt = {
          sha256,
          size,
          fileIdentity,
          verifiedBytes: Number.isSafeInteger(verifiedBytes) ? verifiedBytes : size,
          stream: child.stdout,
          close,
        };
        if (input.mode === 'inspect') {
          void childExited.then(() => resolve(receipt));
        } else {
          resolve(receipt);
        }
        return;
      }
      const code = parts[1] ?? 'verification_failed';
      const detail = parts[2] ?? '';
      fail(new HostPinnedSourceChangedError(detail.length > 0 ? `${code}:${detail}` : code));
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(`${requestLine}\n`);
  });
}

/** Inspects a local file under an exclusive write-deny handle and computes its full raw SHA-256 and file identity. */
export async function inspectPinnedHostFile(
  filePath: string,
  allowedRoots: readonly string[],
  signal?: AbortSignal,
): Promise<PinnedHostInspection> {
  if (!isHostPinnedSupported()) {
    throw new HostPinnedUnsupportedError('Host-pinned media references require a platform write-deny read lease; archive the file instead.');
  }
  const resolvedRoots: string[] = [];
  for (const root of allowedRoots) {
    if (!isAbsolute(root)) continue;
    const realRoot = await realpath(root).catch(() => root);
    resolvedRoots.push(realRoot);
  }
  let realPath: string;
  try {
    realPath = await realpath(filePath);
  } catch {
    throw new HostPinnedSourceChangedError('not_found');
  }
  if (!isPathWithinAnyRoot(realPath, resolvedRoots)) {
    throw new HostPinnedSourceChangedError('outside_allowed_roots');
  }
  const opened = await runPinnedHelper({
    mode: 'inspect',
    path: realPath,
    start: 0,
    end: -1,
    signal,
  });
  opened.close();
  return {
    realPath,
    sha256: opened.sha256,
    size: opened.size,
    fileIdentity: opened.fileIdentity,
    verifiedBytes: opened.verifiedBytes,
  };
}

/** Registers an explicit non-archived host-pinned A/V reference (>= 4 MiB) in the session's private manifest scope. */
export async function registerHostPinnedRef(
  documents: IAtomicDocumentStore,
  input: RegisterHostPinnedRefInput,
): Promise<HostPinnedRefRecord> {
  if (!input.mimeType.startsWith('video/') && !input.mimeType.startsWith('audio/')) {
    throw new HostPinnedUnsupportedError('Host-pinned references are only supported for unmodified local audio or video files.');
  }
  const resolvedRoots: string[] = [];
  for (const root of input.allowedRoots) {
    if (!isAbsolute(root)) continue;
    resolvedRoots.push(await realpath(root).catch(() => root));
  }
  const inspected = await inspectPinnedHostFile(input.path, resolvedRoots, input.signal);
  if (inspected.size < HOST_PINNED_MIN_BYTES) {
    throw new HostPinnedUnsupportedError(
      `Host-pinned references require files >= ${String(HOST_PINNED_MIN_BYTES)} bytes; archive smaller files into CAS.`,
    );
  }
  const refId = `hp_${randomBytes(16).toString('hex')}`;
  const record: HostPinnedRefRecord = {
    version: 1,
    refId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    path: inspected.realPath,
    mimeType: input.mimeType,
    size: inspected.size,
    sha256: inspected.sha256,
    fileIdentity: inspected.fileIdentity,
    allowedRoots: resolvedRoots,
    createdAt: Date.now(),
  };
  await documents.set(`${input.sessionScope}/${HOST_PINNED_SUBSCOPE}`, `${refId}.json`, record);
  return record;
}

/** Reads and validates a session-scoped host-pinned media manifest without crossing session boundaries. */
export async function readHostPinnedRefRecord(
  documents: IAtomicDocumentStore,
  sessionScope: string,
  sessionId: string,
  refId: string,
): Promise<HostPinnedRefRecord | undefined> {
  if (!HOST_PINNED_REF_ID_RE.test(refId)) return undefined;
  const raw = await documents.get<unknown>(`${sessionScope}/${HOST_PINNED_SUBSCOPE}`, `${refId}.json`);
  if (!isValidRecord(raw)) return undefined;
  if (raw.sessionId !== sessionId || raw.refId !== refId) return undefined;
  return raw;
}

async function assertPinnedPathStillAdmitted(record: HostPinnedRefRecord): Promise<void> {
  let currentReal: string;
  try {
    currentReal = await realpath(record.path);
  } catch {
    throw new HostPinnedSourceChangedError('not_found');
  }
  if (normalizedForCompare(currentReal) !== normalizedForCompare(record.path)) {
    throw new HostPinnedSourceChangedError('symlink_redirected');
  }
  if (!isPathWithinAnyRoot(currentReal, record.allowedRoots)) {
    throw new HostPinnedSourceChangedError('outside_allowed_roots');
  }
}

/** Lightweight host-pinned file fingerprint captured after full hash verification. */
export interface HostPinnedStatFingerprint {
  readonly path: string;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ino: bigint;
}

/** Captures the current stat fingerprint of an admitted host-pinned file. */
export async function statHostPinnedRef(record: HostPinnedRefRecord): Promise<HostPinnedStatFingerprint> {
  await assertPinnedPathStillAdmitted(record);
  let info;
  try {
    info = await stat(record.path, { bigint: true });
  } catch {
    throw new HostPinnedSourceChangedError('not_found');
  }
  if (Number(info.size) !== record.size) {
    throw new HostPinnedSourceChangedError('size_mismatch');
  }
  return {
    path: record.path,
    size: record.size,
    mtimeNs: info.mtimeNs,
    ino: info.ino,
  };
}

/** Verifies a registered host-pinned reference under a write-deny handle without streaming payload bytes. */
export async function verifyHostPinnedRef(
  record: HostPinnedRefRecord,
  signal?: AbortSignal,
): Promise<PinnedHostInspection> {
  if (!isHostPinnedSupported()) {
    throw new HostPinnedSourceChangedError('unsupported_platform');
  }
  await assertPinnedPathStillAdmitted(record);
  const opened = await runPinnedHelper({
    mode: 'inspect',
    path: record.path,
    expectedSha256: record.sha256,
    expectedSize: record.size,
    expectedIdentity: record.fileIdentity,
    start: 0,
    end: -1,
    signal,
  });
  opened.close();
  return {
    realPath: record.path,
    sha256: opened.sha256,
    size: opened.size,
    fileIdentity: opened.fileIdentity,
    verifiedBytes: opened.verifiedBytes,
  };
}

/** Opens a verified write-deny read stream for a registered host-pinned reference; rejects fail-closed before emitting any bytes if changed. */
export async function openVerifiedHostPinnedStream(
  record: HostPinnedRefRecord,
  options: { readonly range?: { readonly start: number; readonly end: number }; readonly signal?: AbortSignal } = {},
): Promise<VerifiedPinnedHostStream> {
  if (!isHostPinnedSupported()) {
    throw new HostPinnedSourceChangedError('unsupported_platform');
  }
  await assertPinnedPathStillAdmitted(record);
  const start = options.range?.start ?? 0;
  const end = options.range?.end ?? (record.size - 1);
  return runPinnedHelper({
    mode: 'stream',
    path: record.path,
    expectedSha256: record.sha256,
    expectedSize: record.size,
    expectedIdentity: record.fileIdentity,
    start,
    end,
    signal: options.signal,
  });
}

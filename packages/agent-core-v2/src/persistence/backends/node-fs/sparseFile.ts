import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { abortable } from '#/_base/utils/abort';
import { registerWin32MoveFileReplace, replaceFileNonDestructive } from '#/_base/utils/fs';

export const SPARSE_UNIT_BYTES = 64 * 1024;
export const DEFAULT_KEEP_HEAD_BYTES = 64 * 1024;
const PROTECTED_BOUNDARY_BYTES = 4 * 1024;
const SPARSE_PROBE_BYTES = 64;
const FALLBACK_SPARSE_PROBE_OFFSETS = [
  0,
  64 * 1024,
  128 * 1024,
  192 * 1024,
  256 * 1024,
] as const;
const WORKER_IDLE_TIMEOUT_MS = 2_000;
const SPARSE_MARKER_RETRY_BASE_MS = 25;
const SPARSE_MARKER_RETRY_MAX_MS = 100;
const PENDING_SPARSE_MARKER_UNLINKS = new Set<string>();
let sparseMarkerRetryTimer: ReturnType<typeof setTimeout> | undefined;
let sparseMarkerRetryDelayMs = SPARSE_MARKER_RETRY_BASE_MS;
let sparseMarkerExitHooked = false;

export interface SparseRange {
  readonly start: number;
  readonly end: number;
}

export type SparsePunchOutcome =
  | 'punched'
  | 'noop'
  | 'unsupported_before_mutation'
  | 'mutated_or_unknown';

export interface SparsePunchResult {
  readonly status: SparsePunchOutcome;
  readonly supported: boolean;
  readonly punchedRanges: readonly SparseRange[];
  readonly allocatedBytesBefore?: number;
  readonly allocatedBytesAfter?: number;
  readonly error?: string;
}

export type SavedFileTimes =
  | {
      readonly kind: 'win32';
      readonly creationTime: string;
      readonly lastAccessTime: string;
      readonly lastWriteTime: string;
      readonly changeTime: string;
      readonly expectedMtimeNs: bigint;
    }
  | {
      readonly kind: 'posix';
      readonly atime: Date;
      readonly mtime: Date;
      readonly expectedMtimeNs: bigint;
    };

class SparseHelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SparseHelperUnavailableError';
  }
}

export function sparseMarkerPath(filePath: string): string {
  return `${filePath}.sparse`;
}

export function mergeSparseRanges(ranges: readonly SparseRange[]): SparseRange[] {
  const valid = ranges
    .filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start)
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: SparseRange[] = [];
  for (const range of valid) {
    const last = merged.at(-1);
    if (last === undefined || range.start > last.end) {
      merged.push({ start: range.start, end: range.end });
    } else if (range.end > last.end) {
      merged[merged.length - 1] = { start: last.start, end: range.end };
    }
  }
  return merged;
}

export function clipSparseRanges(ranges: readonly SparseRange[], maxEnd: number): SparseRange[] {
  if (!Number.isSafeInteger(maxEnd) || maxEnd <= 0) return [];
  const clipped: SparseRange[] = [];
  for (const range of mergeSparseRanges(ranges)) {
    if (range.start >= maxEnd) continue;
    const end = Math.min(range.end, maxEnd);
    if (end > range.start) clipped.push({ start: range.start, end });
  }
  return clipped;
}

export function subtractSparseRanges(
  base: readonly SparseRange[],
  removed: readonly SparseRange[],
): SparseRange[] {
  let current = mergeSparseRanges(base);
  for (const cut of mergeSparseRanges(removed)) {
    const next: SparseRange[] = [];
    for (const item of current) {
      if (cut.end <= item.start || cut.start >= item.end) {
        next.push(item);
        continue;
      }
      if (cut.start > item.start) {
        next.push({ start: item.start, end: cut.start });
      }
      if (cut.end < item.end) {
        next.push({ start: cut.end, end: item.end });
      }
    }
    current = next;
  }
  return current;
}

export function planSparseRanges(
  sealedCut: number,
  keepHeadBytes = DEFAULT_KEEP_HEAD_BYTES,
  preserveOffsets: readonly number[] = [],
): SparseRange[] {
  const alignedStart = Math.ceil(Math.max(0, keepHeadBytes) / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
  const alignedEnd = Math.floor(Math.max(0, sealedCut) / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
  if (alignedEnd <= alignedStart) return [];

  let candidates: SparseRange[] = [{ start: alignedStart, end: alignedEnd }];
  for (const offset of preserveOffsets) {
    if (!Number.isSafeInteger(offset) || offset <= 0) continue;
    const protectStart = Math.max(0, offset - PROTECTED_BOUNDARY_BYTES);
    const unitStart = Math.floor(protectStart / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
    const unitEnd = Math.ceil(offset / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
    if (unitEnd <= unitStart) continue;
    candidates = subtractSparseRanges(candidates, [{ start: unitStart, end: unitEnd }]);
  }

  return candidates.filter((range) => range.end - range.start >= SPARSE_UNIT_BYTES);
}

interface Win32SparseWorker {
  readonly proc: ChildProcessByStdio<Writable, Readable, null>;
  readonly rl: ReadlineInterface;
  readonly nextLine: () => Promise<string>;
  ready: Promise<void>;
}

let activeWorker: Win32SparseWorker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let workerQueue: Promise<void> = Promise.resolve();
let pendingCommands = 0;
let exitHookRegistered = false;
let punchOverrideForTests:
  | ((filePath: string, ranges: readonly SparseRange[], defaultPunch: typeof defaultPunchSparseRanges) => Promise<SparsePunchResult>)
  | undefined;

export function _setSparsePunchOverrideForTests(
  override:
    | ((filePath: string, ranges: readonly SparseRange[], defaultPunch: typeof defaultPunchSparseRanges) => Promise<SparsePunchResult>)
    | undefined,
): void {
  punchOverrideForTests = override;
}

export function closeSparseFileWorker(): void {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const current = activeWorker;
  activeWorker = undefined;
  if (current === undefined) return;
  try {
    current.rl.close();
  } catch {}
  try {
    current.proc.stdin.end();
  } catch {}
  try {
    current.proc.kill();
  } catch {}
}

function armIdleClose(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    closeSparseFileWorker();
  }, WORKER_IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function resolveSparseHelperPath(): string | undefined {
  const configured = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
  if (configured !== undefined) {
    return configured.length > 0 && existsSync(configured) ? configured : undefined;
  }
  return [
    './windows-process-helper.exe',
    './native/windows-process-helper.exe',
    '../../../../dist/windows-process-helper.exe',
  ]
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find(existsSync);
}

function ensureWin32Worker(): Win32SparseWorker {
  if (activeWorker !== undefined && activeWorker.proc.exitCode === null && !activeWorker.proc.killed) {
    return activeWorker;
  }
  closeSparseFileWorker();
  const helperPath = resolveSparseHelperPath();
  if (helperPath === undefined) {
    throw new SparseHelperUnavailableError('windows-process-helper.exe is missing');
  }
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', () => closeSparseFileWorker());
  }
  const proc = spawn(helperPath, ['--sparse-worker', 'v1'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  proc.unref();
  (proc.stdin as unknown as { unref?: () => void }).unref?.();
  (proc.stdout as unknown as { unref?: () => void }).unref?.();
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const buffered: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(line);
    else buffered.push(line);
  });
  const failAll = (error: Error): void => {
    if (activeWorker?.proc === proc) activeWorker = undefined;
    while (waiters.length > 0) waiters.shift()!.reject(error);
  };
  proc.once('error', (error) => failAll(error instanceof Error ? error : new Error(String(error))));
  proc.once('close', (code) => failAll(new Error(`win32 sparse helper exited (${String(code)})`)));
  const nextLine = (): Promise<string> => {
    if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
    return new Promise<string>((resolvePromise, rejectPromise) => {
      waiters.push({ resolve: resolvePromise, reject: rejectPromise });
    });
  };
  const ready = nextLine().then(
    (banner) => {
      if (banner !== 'ready\tsparse-v1') {
        closeSparseFileWorker();
        throw new SparseHelperUnavailableError(`incompatible windows-process-helper banner: ${banner}`);
      }
    },
    (error) => {
      closeSparseFileWorker();
      throw new SparseHelperUnavailableError(error instanceof Error ? error.message : String(error));
    },
  );
  void ready.catch(() => {});
  const worker: Win32SparseWorker = {
    proc,
    rl,
    nextLine,
    ready,
  };
  activeWorker = worker;
  return worker;
}

function setWorkerRef(worker: Win32SparseWorker, referenced: boolean): void {
  const stdoutHandle = worker.proc.stdout as unknown as { ref?: () => void; unref?: () => void };
  if (referenced) {
    worker.proc.ref();
    stdoutHandle.ref?.();
  } else {
    worker.proc.unref();
    stdoutHandle.unref?.();
  }
}

function runWin32Raw(command: string): Promise<string[]> {
  pendingCommands += 1;
  const result = workerQueue.then(async () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    const worker = ensureWin32Worker();
    setWorkerRef(worker, true);
    try {
      await worker.ready;
      worker.proc.stdin.write(`${command}\n`);
      const response = await worker.nextLine();
      return response.split('\t');
    } finally {
      pendingCommands = Math.max(0, pendingCommands - 1);
      if (pendingCommands === 0) {
        if (activeWorker === worker) setWorkerRef(worker, false);
        armIdleClose();
      }
    }
  });
  workerQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function runWin32Command(command: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const promise = runWin32Raw(command);
  const parts = signal === undefined ? await promise : await abortable(promise, signal);
  if (parts[0] !== 'ok') {
    throw new Error(parts.slice(1).join('\t') || 'win32 sparse operation failed');
  }
  return parts.slice(1);
}

function encodePath(filePath: string): string {
  return Buffer.from(filePath, 'utf8').toString('base64');
}

if (process.platform === 'win32') {
  registerWin32MoveFileReplace(async (srcPath, destPath, signal) => {
    await runWin32Command(`replace\t${encodePath(srcPath)}\t${encodePath(destPath)}`, signal);
  });
}

export async function warmSparseFileWorker(signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await runWin32Command('ping', signal);
  } catch (error) {
    if (error instanceof SparseHelperUnavailableError) return;
    throw error;
  }
}

export interface SparseMarkerInput {
  readonly confirmedRanges?: readonly SparseRange[];
  readonly pendingRanges?: readonly SparseRange[];
}

function normalizeOffsets(values: Iterable<unknown>): number[] {
  const unique = new Set<number>();
  for (const item of values) {
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) {
      unique.add(item);
    }
  }
  return [...unique].toSorted((a, b) => a - b);
}

async function readExistingConfirmedOffsets(filePath: string): Promise<number[]> {
  try {
    const raw = await readFile(sparseMarkerPath(filePath), 'utf8');
    const parsed = JSON.parse(raw) as {
      confirmedOffsets?: unknown;
    } | null;
    if (Array.isArray(parsed?.confirmedOffsets)) {
      return normalizeOffsets(parsed.confirmedOffsets);
    }
  } catch {}
  return [];
}

export function clearSparseAttributeCache(): void {}

function hookSparseMarkerExit(): void {
  if (sparseMarkerExitHooked) return;
  sparseMarkerExitHooked = true;
  const flushSync = (): void => {
    for (const markerPath of [...PENDING_SPARSE_MARKER_UNLINKS]) {
      try {
        unlinkSync(markerPath);
        PENDING_SPARSE_MARKER_UNLINKS.delete(markerPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          PENDING_SPARSE_MARKER_UNLINKS.delete(markerPath);
        }
      }
    }
  };
  process.on('beforeExit', flushSync);
  process.on('exit', flushSync);
}

async function flushPendingSparseMarkerUnlinks(): Promise<void> {
  if (PENDING_SPARSE_MARKER_UNLINKS.size === 0) return;
  for (const markerPath of [...PENDING_SPARSE_MARKER_UNLINKS]) {
    try {
      await unlink(markerPath);
      PENDING_SPARSE_MARKER_UNLINKS.delete(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        PENDING_SPARSE_MARKER_UNLINKS.delete(markerPath);
      }
    }
  }
  if (PENDING_SPARSE_MARKER_UNLINKS.size === 0) {
    sparseMarkerRetryDelayMs = SPARSE_MARKER_RETRY_BASE_MS;
    if (sparseMarkerRetryTimer !== undefined) {
      clearTimeout(sparseMarkerRetryTimer);
      sparseMarkerRetryTimer = undefined;
    }
  }
}

function scheduleSparseMarkerUnlinkRetry(): void {
  if (PENDING_SPARSE_MARKER_UNLINKS.size === 0 || sparseMarkerRetryTimer !== undefined) return;
  hookSparseMarkerExit();
  const delayMs = sparseMarkerRetryDelayMs;
  sparseMarkerRetryDelayMs = Math.min(SPARSE_MARKER_RETRY_MAX_MS, sparseMarkerRetryDelayMs * 2);
  sparseMarkerRetryTimer = setTimeout(() => {
    sparseMarkerRetryTimer = undefined;
    void flushPendingSparseMarkerUnlinks().finally(() => {
      if (PENDING_SPARSE_MARKER_UNLINKS.size > 0) {
        scheduleSparseMarkerUnlinkRetry();
      } else {
        sparseMarkerRetryDelayMs = SPARSE_MARKER_RETRY_BASE_MS;
      }
    });
  }, delayMs);
  sparseMarkerRetryTimer.unref?.();
}

export async function writeSparseMarker(
  filePath: string,
  input: number | SparseMarkerInput,
  signal?: AbortSignal,
): Promise<void> {
  PENDING_SPARSE_MARKER_UNLINKS.delete(sparseMarkerPath(filePath));
  const priorConfirmed = await readExistingConfirmedOffsets(filePath);
  const confirmedOffsets = typeof input === 'number'
    ? priorConfirmed
    : normalizeOffsets([
        ...priorConfirmed,
        ...(input.confirmedRanges ?? []).map((range) => range.start),
      ]);
  const confirmedSet = new Set(confirmedOffsets);
  const pendingOffsets = typeof input === 'number'
    ? (confirmedSet.has(input) ? [] : normalizeOffsets([input]))
    : normalizeOffsets((input.pendingRanges ?? []).map((range) => range.start)).filter(
        (offset) => !confirmedSet.has(offset),
      );
  const probeOffset = confirmedOffsets[0] ?? pendingOffsets[0] ?? DEFAULT_KEEP_HEAD_BYTES;
  const payload = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      probeOffset,
      confirmedOffsets,
      pendingOffsets,
    }),
  );
  await writeFileAtomicNoUnlink(sparseMarkerPath(filePath), payload, signal);
}

export async function removeSparseMarker(filePath: string): Promise<void> {
  await flushPendingSparseMarkerUnlinks();
  const markerPath = sparseMarkerPath(filePath);
  try {
    await unlink(markerPath);
    PENDING_SPARSE_MARKER_UNLINKS.delete(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      PENDING_SPARSE_MARKER_UNLINKS.delete(markerPath);
      return;
    }
    PENDING_SPARSE_MARKER_UNLINKS.add(markerPath);
    scheduleSparseMarkerUnlinkRetry();
    throw error;
  }
}

async function hasNulByteAtEverySparseUnit(
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await open(filePath, 'r');
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (info.size <= 0) return undefined;
    const buf = Buffer.alloc(SPARSE_PROBE_BYTES);
    for (let offset = 0; offset < info.size; offset += SPARSE_UNIT_BYTES) {
      signal?.throwIfAborted();
      const probeLen = Math.min(SPARSE_PROBE_BYTES, info.size - offset);
      if (probeLen <= 0) break;
      const { bytesRead } = await handle.read(buf, 0, probeLen, offset);
      if (bytesRead > 0 && buf.subarray(0, bytesRead).includes(0)) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hasNulByteAtAnyOffset(
  filePath: string,
  offsets: readonly number[],
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await open(filePath, 'r');
    signal?.throwIfAborted();
    const info = await handle.stat();
    let checkedAny = false;
    const buf = Buffer.alloc(SPARSE_PROBE_BYTES);
    for (const offset of offsets) {
      signal?.throwIfAborted();
      if (offset < 0 || info.size <= offset) continue;
      const probeLen = Math.min(SPARSE_PROBE_BYTES, info.size - offset);
      if (probeLen <= 0) continue;
      checkedAny = true;
      const { bytesRead } = await handle.read(buf, 0, probeLen, offset);
      if (bytesRead > 0 && buf.subarray(0, bytesRead).includes(0)) {
        return true;
      }
    }
    return checkedAny ? false : undefined;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type Win32SparseAttributeState = 'sparse' | 'dense' | 'unknown';

export async function detectOrphanedSparseJournal(
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  await flushPendingSparseMarkerUnlinks();
  signal?.throwIfAborted();
  let markerFound = false;
  let confirmedOffsets: number[] = [];
  let markerProbeOffsets: number[] = [];
  try {
    const raw = await readFile(sparseMarkerPath(filePath), { encoding: 'utf8', signal });
    markerFound = true;
    const parsed = JSON.parse(raw) as {
      probeOffset?: unknown;
      confirmedOffsets?: unknown;
      pendingOffsets?: unknown;
    } | null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return true;
    }
    confirmedOffsets = Array.isArray(parsed.confirmedOffsets)
      ? normalizeOffsets(parsed.confirmedOffsets)
      : [];
    markerProbeOffsets = normalizeOffsets([
      ...confirmedOffsets,
      ...(Array.isArray(parsed.pendingOffsets) ? parsed.pendingOffsets : []),
      parsed.probeOffset,
    ]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
  }

  if (markerFound) {
    const probes = confirmedOffsets.length > 0
      ? confirmedOffsets
      : markerProbeOffsets.length > 0
        ? markerProbeOffsets
        : FALLBACK_SPARSE_PROBE_OFFSETS;
    const nul = await hasNulByteAtAnyOffset(filePath, probes, signal);
    if (nul === true) return true;
    const win32Attr = await queryWin32SparseAttribute(filePath, signal);
    if (win32Attr === 'sparse') return true;
    if (win32Attr === 'dense') return false;
    const unitScan = await hasNulByteAtEverySparseUnit(filePath, signal);
    if (unitScan === true) return true;
    if (unitScan === false) return false;
    return confirmedOffsets.length > 0;
  }

  signal?.throwIfAborted();
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const size = info.size;
  if (size < SPARSE_UNIT_BYTES) return false;
  if (
    process.platform !== 'win32' &&
    typeof info.blocks === 'number' &&
    info.blocks > 0 &&
    info.blocks * 512 >= size
  ) {
    return false;
  }
  const lastAlignedOffset = Math.floor((size - SPARSE_UNIT_BYTES) / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
  const fallbackOffsets = normalizeOffsets([...FALLBACK_SPARSE_PROBE_OFFSETS, lastAlignedOffset]).filter(
    (offset) => offset >= 0 && offset < size,
  );
  const nul = await hasNulByteAtAnyOffset(filePath, fallbackOffsets, signal);
  if (nul === true) return true;
  const win32Attr = await queryWin32SparseAttribute(filePath, signal);
  if (win32Attr === 'sparse') return true;
  if (win32Attr === 'dense') return false;
  const fullUnitScan = await hasNulByteAtEverySparseUnit(filePath, signal);
  return fullUnitScan === true;
}

export async function queryWin32ProcessCreationFileTime(
  pid: number,
  signal?: AbortSignal,
): Promise<bigint | 'dead' | 'unknown'> {
  if (process.platform !== 'win32') return 'unknown';
  try {
    const [raw] = await runWin32Command(`proctime\t${pid}`, signal);
    if (raw === 'dead') return 'dead';
    if (raw === 'denied' || raw === undefined || raw.length === 0) return 'unknown';
    return BigInt(raw);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return 'unknown';
  }
}

export async function queryWin32SparseAttribute(
  filePath: string,
  signal?: AbortSignal,
): Promise<Win32SparseAttributeState> {
  if (process.platform !== 'win32') return 'unknown';
  try {
    const [flag] = await runWin32Command(`attrs\t${encodePath(filePath)}`, signal);
    if (flag === '1') return 'sparse';
    if (flag === '0') return 'dense';
    return 'unknown';
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof SparseHelperUnavailableError) return 'unknown';
    throw error;
  }
}

export async function writeFileAtomicNoUnlink(
  destPath: string,
  content: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const hex = randomBytes(6).toString('hex');
  const tmpPath = `${destPath}.stage.${process.pid}.${hex}`;
  let replaced = false;
  try {
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      signal?.throwIfAborted();
      let written = 0;
      while (written < content.byteLength) {
        const { bytesWritten } = await handle.write(content, written, content.byteLength - written);
        if (bytesWritten <= 0) throw new Error('short write on stage file');
        written += bytesWritten;
      }
      signal?.throwIfAborted();
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    await replaceFileNonDestructive(tmpPath, destPath, signal);
    replaced = true;
  } finally {
    if (!replaced) {
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}

export async function allocatedFileBytes(filePath: string, signal?: AbortSignal): Promise<number | undefined> {
  if (process.platform === 'win32') {
    try {
      const [raw] = await runWin32Command(`size\t${encodePath(filePath)}`, signal);
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const info = await stat(filePath).catch(() => undefined);
      return info?.size;
    }
  }
  try {
    const info = await stat(filePath);
    return typeof info.blocks === 'number' && info.blocks >= 0 ? info.blocks * 512 : info.size;
  } catch {
    return undefined;
  }
}

async function defaultPunchSparseRanges(filePath: string, ranges: readonly SparseRange[]): Promise<SparsePunchResult> {
  const normalized = mergeSparseRanges(
    ranges.map((range) => ({
      start: Math.ceil(range.start / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES,
      end: Math.floor(range.end / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES,
    })),
  );
  if (process.platform !== 'win32') {
    const allocated = await allocatedFileBytes(filePath);
    return {
      status: 'unsupported_before_mutation',
      supported: false,
      punchedRanges: [],
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
    };
  }
  if (normalized.length === 0) {
    const allocated = await allocatedFileBytes(filePath);
    return {
      status: 'noop',
      supported: true,
      punchedRanges: [],
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
    };
  }
  const statBefore = await stat(filePath, { bigint: true });
  const spec = normalized.map((range) => `${range.start}:${range.end}`).join(',');
  let parts: string[];
  try {
    parts = await runWin32Raw(`punch\t${encodePath(filePath)}\t${spec}`);
  } catch (error) {
    const allocated = await allocatedFileBytes(filePath);
    if (error instanceof SparseHelperUnavailableError) {
      return {
        status: 'unsupported_before_mutation',
        supported: false,
        punchedRanges: [],
        allocatedBytesBefore: allocated,
        allocatedBytesAfter: allocated,
        error: error.message,
      };
    }
    return {
      status: 'mutated_or_unknown',
      supported: true,
      punchedRanges: normalized,
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const tag = parts[0];
  if (tag === 'pre_err') {
    const allocated = await allocatedFileBytes(filePath);
    return {
      status: 'unsupported_before_mutation',
      supported: false,
      punchedRanges: [],
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
      error: parts.slice(1).join('\t'),
    };
  }
  if (tag !== 'ok') {
    const allocated = await allocatedFileBytes(filePath);
    return {
      status: 'mutated_or_unknown',
      supported: true,
      punchedRanges: normalized,
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
      error: parts.slice(1).join('\t') || 'win32 punch failed after sparse open',
    };
  }
  const before = Number(parts[1]);
  const after = Number(parts[2]);
  const statAfter = await stat(filePath, { bigint: true });
  if (statAfter.mtimeNs !== statBefore.mtimeNs || statAfter.size !== statBefore.size) {
    return {
      status: 'mutated_or_unknown',
      supported: true,
      punchedRanges: normalized,
      allocatedBytesBefore: Number.isSafeInteger(before) ? before : undefined,
      allocatedBytesAfter: Number.isSafeInteger(after) ? after : undefined,
      error: 'file timestamp or size drifted after punch',
    };
  }
  return {
    status: 'punched',
    supported: true,
    punchedRanges: normalized,
    allocatedBytesBefore: Number.isSafeInteger(before) ? before : undefined,
    allocatedBytesAfter: Number.isSafeInteger(after) ? after : undefined,
  };
}

export function punchSparseRanges(filePath: string, ranges: readonly SparseRange[]): Promise<SparsePunchResult> {
  if (punchOverrideForTests !== undefined) {
    return punchOverrideForTests(filePath, ranges, defaultPunchSparseRanges);
  }
  return defaultPunchSparseRanges(filePath, ranges);
}

export async function captureFileBasicTimes(filePath: string): Promise<SavedFileTimes> {
  const info = await stat(filePath, { bigint: true });
  if (process.platform === 'win32') {
    try {
      const [creationTime, lastAccessTime, lastWriteTime, changeTime] = await runWin32Command(`gettimes\t${encodePath(filePath)}`);
      if (
        creationTime === undefined ||
        lastAccessTime === undefined ||
        lastWriteTime === undefined ||
        changeTime === undefined
      ) {
        throw new Error('win32 gettimes returned incomplete timestamps');
      }
      return {
        kind: 'win32',
        creationTime,
        lastAccessTime,
        lastWriteTime,
        changeTime,
        expectedMtimeNs: info.mtimeNs,
      };
    } catch (error) {
      if (!(error instanceof SparseHelperUnavailableError)) throw error;
    }
  }
  return {
    kind: 'posix',
    atime: new Date(Number(info.atimeMs)),
    mtime: new Date(Number(info.mtimeMs)),
    expectedMtimeNs: info.mtimeNs,
  };
}

export async function restoreFileBasicTimes(filePath: string, saved: SavedFileTimes): Promise<void> {
  if (saved.kind === 'win32') {
    await runWin32Command(
      `settimes\t${encodePath(filePath)}\t${saved.creationTime}\t${saved.lastAccessTime}\t${saved.lastWriteTime}\t${saved.changeTime}`,
    );
    const after = await stat(filePath, { bigint: true });
    if (after.mtimeNs !== saved.expectedMtimeNs) {
      throw new Error('failed to restore exact file modification timestamp');
    }
    return;
  }
  await utimes(filePath, saved.atime, saved.mtime);
}

import { availableParallelism } from 'node:os';
import type { Readable } from 'node:stream';

import { unwrapErrorCause } from '#/_base/errors/errors';
import { BugIndicatingError } from '#/errors';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import { rgUnavailableMessage } from './rgLocator';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const SIGTERM_GRACE_MS = 5_000;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_CONCURRENT_RG_PROCESSES = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4)));
const RG_THREADS_PER_PROCESS = String(Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4))));

let activeRgProcesses = 0;
let rgSpawnChain: Promise<void> = Promise.resolve();
const rgWaitQueue: Array<() => void> = [];

function releaseRgSlotCount(): void {
  const next = rgWaitQueue.shift();
  if (next !== undefined) {
    next();
  } else {
    activeRgProcesses = Math.max(0, activeRgProcesses - 1);
  }
}

async function acquireRgSlot(signal: AbortSignal): Promise<(() => void) | undefined> {
  if (signal.aborted) return undefined;
  if (activeRgProcesses >= MAX_CONCURRENT_RG_PROCESSES) {
    const acquired = await new Promise<boolean>((resolve) => {
      const onWake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = (): void => {
        const idx = rgWaitQueue.indexOf(onWake);
        if (idx !== -1) rgWaitQueue.splice(idx, 1);
        resolve(false);
      };
      rgWaitQueue.push(onWake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    if (!acquired) return undefined;
    if (signal.aborted) {
      releaseRgSlotCount();
      return undefined;
    }
  } else {
    activeRgProcesses += 1;
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseRgSlotCount();
  };
  const prev = rgSpawnChain;
  let releasePace!: () => void;
  rgSpawnChain = new Promise<void>((resolve) => { releasePace = resolve; });
  await prev;
  if (signal.aborted) {
    releasePace();
    release();
    return undefined;
  }
  setImmediate(releasePace);
  return release;
}

export interface RunRgResult {
  readonly kind: 'result';
  readonly exitCode: number;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly bufferTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

export type RunRgOutcome = RunRgResult | { readonly kind: 'aborted' };

async function disposeProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
  }
}

export async function runRgOnce(
  processService: IHostProcessService,
  rgArgs: readonly string[],
  signal: AbortSignal,
  options?: { readonly cwd?: string },
): Promise<RunRgOutcome> {
  if (signal.aborted) {
    return { kind: 'aborted' };
  }

  const [command, ...rawArgs] = rgArgs;
  if (command === undefined) {
    throw new BugIndicatingError('runRgOnce: rgArgs must not be empty');
  }
  const hasThreadFlag = rawArgs.some((arg) => arg === '-j' || arg === '--threads' || arg.startsWith('--threads='));
  const contended = activeRgProcesses > 1 || rgWaitQueue.length > 0;
  const args = !hasThreadFlag && contended ? ['-j', RG_THREADS_PER_PROCESS, ...rawArgs] : rawArgs;
  const releaseSlot = await acquireRgSlot(signal);
  if (releaseSlot === undefined) {
    return { kind: 'aborted' };
  }
  let proc: IHostProcess;
  try {
    proc = await processService.spawn(command, args, { cwd: options?.cwd, signal });
  } catch (error) {
    releaseSlot();
    throw error;
  }

  try {
    proc.stdin.end();
  } catch {
  }

  let timedOut = false;
  let aborted = false;
  let killed = false;

  const killProc = async (): Promise<void> => {
    if (killed) return;
    killed = true;
    try {
      await proc.kill('SIGTERM');
    } catch {
    }
    const exited = proc
      .wait()
      .then(() => true)
      .catch(() => true);
    const raced = await Promise.race([
      exited,
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
      }),
    ]);
    if (!raced && proc.exitCode === null) {
      try {
        await proc.kill('SIGKILL');
      } catch {
      }
    }
    await disposeProcess(proc);
  };

  const onAbort = (): void => {
    aborted = true;
    void killProc();
  };
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) onAbort();

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    void killProc();
  }, DEFAULT_TIMEOUT_MS);

  let exitCode = 0;
  let stdoutText = '';
  let stderrText = '';
  let bufferTruncated = false;
  let stderrTruncated = false;

  try {
    const isTerminating = (): boolean => timedOut || aborted || killed;
    const [stdoutResult, stderrResult, code] = await Promise.all([
      readStreamWithCap(proc.stdout, MAX_OUTPUT_BYTES, isTerminating),
      readStreamWithCap(proc.stderr, MAX_OUTPUT_BYTES, isTerminating),
      proc.wait(),
    ]);
    stdoutText = stdoutResult.text;
    stderrText = stderrResult.text;
    bufferTruncated = stdoutResult.truncated;
    stderrTruncated = stderrResult.truncated;
    exitCode = code;
  } catch (error) {
    if (!(isPrematureCloseError(error) && (timedOut || aborted || killed))) {
      throw error;
    }
  } finally {
    clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', onAbort);
    await disposeProcess(proc);
    releaseSlot();
  }

  if (aborted) {
    return { kind: 'aborted' };
  }

  return {
    kind: 'result',
    exitCode,
    stdoutText,
    stderrText,
    bufferTruncated,
    stderrTruncated,
    timedOut,
  };
}

export function rgErrorCode(error: unknown): string | undefined {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped !== null && typeof unwrapped === 'object' && 'code' in unwrapped) {
    const code = (unwrapped as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function formatRgSpawnError(error: unknown): string {
  return rgErrorCode(error) === 'ENOENT'
    ? rgUnavailableMessage(error)
    : error instanceof Error
      ? error.message
      : String(error);
}

export function shouldRetryRipgrepEagain(result: RunRgResult): boolean {
  return (
    result.exitCode !== 0 &&
    result.exitCode !== 1 &&
    !result.timedOut &&
    isEagainRipgrepError(result.stderrText)
  );
}

function isEagainRipgrepError(stderr: string): boolean {
  return stderr.includes('os error 11') || stderr.includes('Resource temporarily unavailable');
}

function isPrematureCloseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

interface CappedStreamResult {
  readonly text: string;
  readonly truncated: boolean;
}

async function readStreamWithCap(
  stream: Readable,
  maxBytes: number,
  suppressPrematureClose?: () => boolean,
): Promise<CappedStreamResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf: Buffer =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
      if (truncated) continue;
      if (total + buf.length > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        continue;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } catch (error) {
    if (!isPrematureCloseError(error) || suppressPrematureClose?.() !== true) {
      throw error;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

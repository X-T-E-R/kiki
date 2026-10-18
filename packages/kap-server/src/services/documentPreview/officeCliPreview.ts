import type { IHostProcess, IHostProcessService } from '@kiki/agent-core-v2/os/interface/hostProcess';

const STDOUT_CAP = 256 * 1024;
const STDERR_CAP = 8 * 1024;

const OFFICE_ENV = {
  OFFICECLI_SKIP_UPDATE: '1',
  OFFICECLI_NO_AUTO_RESIDENT: '1',
  OFFICECLI_RESIDENT_FLUSH: 'each',
};

export interface OfficeCliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: 'ENOENT';
}

export class OfficePreviewCleanupError extends Error {
  readonly cleanupUnconfirmed = true;

  constructor(message = 'Document renderer cleanup was not confirmed.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OfficePreviewCleanupError';
  }
}

export function officeScreenshotArgs(input: {
  readonly path: string;
  readonly out: string;
  readonly extension: string;
  readonly page: number;
  readonly range?: string;
}): readonly string[] {
  const args = ['view', input.path, 'screenshot', '--out', input.out];
  if (input.extension === 'xlsx') {
    if (input.range !== undefined) args.push('--range', input.range);
    return args;
  }
  args.push('--render', 'html', '--page', String(input.page));
  return args;
}

export function officePageCount(stdout: string, extension: string): number | undefined {
  const key = extension === 'pptx' ? 'slides' : extension === 'docx' ? 'pages' : undefined;
  if (key === undefined) return undefined;
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const data = asRecord(record?.['data']) ?? record;
  return positiveInt(data?.[key]);
}

export function officeSheetNames(stdout: string): readonly string[] | undefined {
  const names = [...stdout.matchAll(/── "([^"\r\n]+)"/gu)].map((match) => match[1]!.trim()).filter((name) => name.length > 0);
  const unique = [...new Set(names)];
  return unique.length === 0 ? undefined : unique;
}

export function runOfficeCli(
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  host: Pick<IHostProcessService, 'spawn'>,
): Promise<OfficeCliRun> {
  if (signal.aborted) return Promise.reject(new Error('Document preview cancelled'));
  return runOwnedOfficeCli(binary, args, signal, timeoutMs, host);
}

async function runOwnedOfficeCli(
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  host: Pick<IHostProcessService, 'spawn'>,
): Promise<OfficeCliRun> {
  let proc: IHostProcess;
  try {
    proc = await host.spawn(binary, [...args], {
      windowsHide: true,
      env: OFFICE_ENV,
      ownedProcessTree: true,
      ownedProcessLifetime: 'process',
    });
  } catch (error) {
    if (spawnErrno(error) === 'ENOENT') {
      return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : 'ENOENT', spawnError: 'ENOENT' };
    }
    throw error;
  }

  let stdout = '';
  let stderr = '';
  const onStdout = (chunk: Uint8Array | string): void => {
    if (stdout.length >= STDOUT_CAP) return;
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    stdout += text.slice(0, STDOUT_CAP - stdout.length);
  };
  const onStderr = (chunk: Uint8Array | string): void => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    stderr = `${stderr}${text}`.slice(-STDERR_CAP);
  };
  proc.stdout.on('data', onStdout);
  proc.stderr.on('data', onStderr);

  let preferred: Error | undefined;
  let stopping: Promise<void> | undefined;
  let settled = false;
  let stopRequested = false;
  const finish = (error?: Error, result?: OfficeCliRun): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    proc.stdout.off('data', onStdout);
    proc.stderr.off('data', onStderr);
    if (error !== undefined) rejectFinish(error);
    else resolveFinish(result!);
  };
  let resolveFinish: (result: OfficeCliRun) => void = () => {};
  let rejectFinish: (error: Error) => void = () => {};
  const done = new Promise<OfficeCliRun>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  const afterStop = (result?: OfficeCliRun): void => {
    void stopping!.then(
      () => { finish(preferred, preferred === undefined ? result : undefined); },
      (error: unknown) => { finish(error instanceof OfficePreviewCleanupError ? error : new OfficePreviewCleanupError('Document renderer cleanup was not confirmed.', { cause: error })); },
    );
  };
  const stop = (error: Error): void => {
    preferred ??= error;
    stopRequested = true;
    if (stopping === undefined) stopping = killOwnedTree(proc);
    afterStop();
  };
  const onAbort = (): void => { stop(new Error('Document preview cancelled')); };
  const timer = setTimeout(() => { stop(new Error('Document renderer timed out')); }, timeoutMs);
  signal.addEventListener('abort', onAbort, { once: true });
  void proc.wait().then(
    (code) => {
      if (settled || stopping !== undefined) return;
      stopping = releaseAfterExit(proc, () => stopRequested, () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      });
      afterStop({ code, stdout, stderr });
    },
    (error: unknown) => {
      if (settled || stopping !== undefined) return;
      stop(error instanceof Error ? error : new Error(String(error)));
    },
  );
  if (signal.aborted) onAbort();
  return done;
}

async function killOwnedTree(proc: IHostProcess): Promise<void> {
  await proc.kill();
  await Promise.resolve(proc.dispose());
}

async function releaseAfterExit(proc: IHostProcess, stopRequested: () => boolean, beginRelease: () => void): Promise<void> {
  await Promise.resolve();
  if (stopRequested()) await proc.kill();
  beginRelease();
  await Promise.resolve(proc.dispose());
}

function spawnErrno(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const details = 'details' in error ? (error as { details?: { errno?: unknown } }).details : undefined;
  if (typeof details?.errno === 'string') return details.errno;
  const cause = 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code;
  }
  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

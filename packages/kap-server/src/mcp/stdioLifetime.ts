import type { Readable } from 'node:stream';

const DEFAULT_CLOSE_BUDGET_MS = 2_000;
const DEFAULT_PARENT_POLL_MS = 500;

export interface StdioClientLifetime {
  readonly stdin?: Readable;
  readonly parentPid?: number;
  readonly pollMs?: number;
  readonly closeBudgetMs?: number;
  readonly isParentAlive?: (pid: number) => boolean;
  readonly close: () => Promise<void> | void;
  readonly exit?: (code: number) => void;
}

type CloseOutcome = { readonly kind: 'ok' } | { readonly kind: 'timeout' } | { readonly kind: 'error'; readonly error: unknown };

export function retainUntilStdioClientEnds(options: StdioClientLifetime): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const parentPid = options.parentPid ?? process.ppid;
  const pollMs = options.pollMs ?? DEFAULT_PARENT_POLL_MS;
  const closeBudgetMs = options.closeBudgetMs ?? DEFAULT_CLOSE_BUDGET_MS;
  const isParentAlive = options.isParentAlive ?? parentProcessAlive;
  let settled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stdin.off('end', finish);
      stdin.off('close', finish);
      if (timer !== undefined) clearInterval(timer);
      let budget: ReturnType<typeof setTimeout> | undefined;
      const closed = new Promise<CloseOutcome>((settle) => {
        try {
          const result = options.close();
          Promise.resolve(result).then(
            () => settle({ kind: 'ok' }),
            (error: unknown) => settle({ kind: 'error', error }),
          );
        } catch (error) {
          settle({ kind: 'error', error });
        }
      });
      const timed = new Promise<CloseOutcome>((settle) => {
        budget = setTimeout(() => settle({ kind: 'timeout' }), closeBudgetMs);
      });
      void Promise.race([closed, timed]).then((outcome) => {
        if (budget !== undefined) clearTimeout(budget);
        if (outcome.kind === 'ok') {
          options.exit?.(0);
          resolve();
          return;
        }
        const diagnostic = cleanupDiagnostic(outcome, closeBudgetMs);
        process.stderr.write(`${diagnostic}\n`);
        process.exitCode = 1;
        options.exit?.(1);
        reject(new Error(diagnostic));
      });
    };
    if (stdin.readableEnded === true) {
      finish();
      return;
    }
    stdin.on('end', finish);
    stdin.on('close', finish);
    if (parentPid > 0) {
      timer = setInterval(() => {
        if (!isParentAlive(parentPid)) finish();
      }, pollMs);
      timer.unref?.();
    }
  });
}

function cleanupDiagnostic(outcome: Exclude<CloseOutcome, { readonly kind: 'ok' }>, closeBudgetMs: number): string {
  const record: {
    event: 'stdio-cleanup';
    reason: 'timeout' | 'close-error';
    closeBudgetMs: number;
    exitCode: 1;
    message?: string;
  } = {
    event: 'stdio-cleanup',
    reason: outcome.kind === 'timeout' ? 'timeout' : 'close-error',
    closeBudgetMs,
    exitCode: 1,
  };
  if (outcome.kind === 'error') {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    record.message = message.replace(/[\r\n]+/g, ' ');
  }
  return JSON.stringify(record);
}

function parentProcessAlive(pid: number): boolean {
  if (pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

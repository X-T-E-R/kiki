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

export function retainUntilStdioClientEnds(options: StdioClientLifetime): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const parentPid = options.parentPid ?? process.ppid;
  const pollMs = options.pollMs ?? DEFAULT_PARENT_POLL_MS;
  const closeBudgetMs = options.closeBudgetMs ?? DEFAULT_CLOSE_BUDGET_MS;
  const isParentAlive = options.isParentAlive ?? parentProcessAlive;
  let settled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Promise((resolve) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stdin.off('end', finish);
      stdin.off('close', finish);
      if (timer !== undefined) clearInterval(timer);
      let budget: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        Promise.resolve(options.close()).then(() => undefined, () => undefined),
        new Promise<void>((release) => {
          budget = setTimeout(release, closeBudgetMs);
        }),
      ]).then(() => {
        if (budget !== undefined) clearTimeout(budget);
        options.exit?.(0);
        resolve();
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

function parentProcessAlive(pid: number): boolean {
  if (pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

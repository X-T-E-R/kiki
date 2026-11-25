import type { Worker } from 'node:worker_threads';

export const WORKER_CLOSE_TIMEOUT_MS = 5_000;

/** Drains a worker close request and forces termination if the worker does not exit within timeoutMs. */
export async function closeWorkerWithTimeout(
  worker: Worker,
  drain: Promise<unknown>,
  exited: Promise<void>,
  timeoutMs = WORKER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  let timedOut = false;
  let onTimeout!: () => void;
  const timedOutPromise = new Promise<void>((resolve) => {
    onTimeout = resolve;
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    void worker.terminate().catch(() => undefined);
    onTimeout();
  }, timeoutMs);
  deadline.unref();
  const forceExit = timedOutPromise.then(() => exited);
  try {
    await Promise.race([drain, forceExit]);
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    if (timedOut) {
      drain.catch(() => undefined);
    }
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
}

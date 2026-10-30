import { abortable, createDeadlineAbortSignal } from '@kiki/agent-core-v2/_base/utils/abort';

export async function withImDeadline<T>(source: AbortSignal, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = createDeadlineAbortSignal(source, timeoutMs);
  try {
    deadline.signal.throwIfAborted();
    return await abortable(work(deadline.signal), deadline.signal);
  } finally {
    deadline.clear();
  }
}

export interface VisiblePollOptions {
  readonly intervalMs: number;
  readonly task: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly visibility?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

export function startVisiblePoll(options: VisiblePollOptions): () => void {
  const visibility =
    options.visibility ?? (typeof document === 'undefined' ? undefined : document);
  let stopped = false;
  let running = false;
  let rerunRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hidden = () => visibility?.visibilityState === 'hidden';
  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (delay: number) => {
    if (stopped || running || hidden()) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  const run = async () => {
    if (stopped || hidden()) return;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      await options.task();
    } catch (error) {
      try {
        options.onError?.(error);
      } catch (observerError) {
        void observerError;
      }
    } finally {
      running = false;
      if (!stopped && !hidden()) {
        if (rerunRequested) {
          rerunRequested = false;
          schedule(0);
        } else {
          schedule(options.intervalMs);
        }
      }
    }
  };

  const onVisibilityChange = () => {
    if (hidden()) {
      clearTimer();
      return;
    }
    if (running) rerunRequested = true;
    else schedule(0);
  };

  visibility?.addEventListener('visibilitychange', onVisibilityChange);
  schedule(options.intervalMs);

  return () => {
    stopped = true;
    rerunRequested = false;
    clearTimer();
    visibility?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
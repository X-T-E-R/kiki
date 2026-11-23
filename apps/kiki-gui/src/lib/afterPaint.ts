export function afterPaint(task: () => void): () => void {
  let done = false;
  let frame: number | undefined;
  let cancelDeferred: (() => void) | undefined;

  const cleanupVisibility = () => {
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };

  const cancelPending = () => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    cancelDeferred?.();
    cancelDeferred = undefined;
  };

  const run = () => {
    if (done) return;
    done = true;
    cleanupVisibility();
    task();
  };

  const scheduleHidden = () => {
    cancelPending();
    const timer = setTimeout(run, 0);
    cancelDeferred = () => { clearTimeout(timer); };
  };

  const onVisibilityChange = () => {
    if (!done && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      scheduleHidden();
    }
  };

  if (typeof document !== 'undefined') {
    if (document.visibilityState === 'hidden') {
      scheduleHidden();
      return () => {
        done = true;
        cancelPending();
      };
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (typeof requestIdleCallback === 'function') {
        const idle = requestIdleCallback(() => { run(); });
        cancelDeferred = () => { cancelIdleCallback(idle); };
      } else {
        const timer = setTimeout(run, 0);
        cancelDeferred = () => { clearTimeout(timer); };
      }
    });
  });

  return () => {
    done = true;
    cleanupVisibility();
    cancelPending();
  };
}

export function afterPaint(task: () => void): () => void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    const timer = setTimeout(task, 0);
    return () => { clearTimeout(timer); };
  }

  let cancelIdle: (() => void) | undefined;
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      clearTimeout(paintDeadline);
      if (typeof requestIdleCallback === 'function') {
        const idle = requestIdleCallback(task, { timeout: 1000 });
        cancelIdle = () => { cancelIdleCallback(idle); };
      } else {
        const timer = setTimeout(task, 0);
        cancelIdle = () => { clearTimeout(timer); };
      }
    });
  });
  const paintDeadline = setTimeout(() => {
    cancelAnimationFrame(frame);
    task();
  }, 250);
  return () => {
    clearTimeout(paintDeadline);
    cancelAnimationFrame(frame);
    cancelIdle?.();
  };
}

export function afterPaint(task: () => void): () => void {
  let cancelIdle: (() => void) | undefined;
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (typeof requestIdleCallback === 'function') {
        const idle = requestIdleCallback(task);
        cancelIdle = () => { cancelIdleCallback(idle); };
      } else {
        const timer = setTimeout(task, 0);
        cancelIdle = () => { clearTimeout(timer); };
      }
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    cancelIdle?.();
  };
}

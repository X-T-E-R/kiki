/**
 * `AbortSignal.any` with a fallback. The static method arrived in Safari 17.4;
 * the desktop app runs in the system WebKit on macOS, which the bundle allows
 * back to 13.5, and a phone browser can be older still. There the native call
 * throws a TypeError in the middle of an ordinary request, so callers go
 * through this instead.
 *
 * The result aborts when the first input does, with that input's reason. An
 * input that is already aborted yields an already-aborted signal.
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals]);
  const controller = new AbortController();
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted !== undefined) {
    controller.abort(aborted.reason);
    return controller.signal;
  }
  const release = (): void => {
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
  };
  function onAbort(this: AbortSignal): void {
    release();
    controller.abort(this.reason);
  }
  for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

export function abortError(message = 'Aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && !isDefaultAbortReason(signal.reason)) {
    return signal.reason;
  }
  return abortError();
}

function isDefaultAbortReason(reason: Error): boolean {
  return reason.name === 'AbortError' && reason.message === 'This operation was aborted';
}

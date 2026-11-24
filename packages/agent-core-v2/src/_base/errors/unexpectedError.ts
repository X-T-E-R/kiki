export type UnexpectedErrorHandler = (err: unknown) => void;

const defaultHandler: UnexpectedErrorHandler = (err) => {
  console.error('[unexpected]', err);
};

let currentHandler: UnexpectedErrorHandler = defaultHandler;
const listeners = new Set<UnexpectedErrorHandler>();

export function setUnexpectedErrorHandler(handler: UnexpectedErrorHandler): void {
  currentHandler = handler;
}

export function resetUnexpectedErrorHandler(): void {
  currentHandler = defaultHandler;
}

/** Registers an additive observer invoked on unexpected errors; returns a disposer. */
export function addUnexpectedErrorListener(listener: UnexpectedErrorHandler): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function onUnexpectedError(err: unknown): void {
  try {
    currentHandler(err);
  } catch (handlerErr) {
    console.error('[unexpected] handler threw', handlerErr, 'while reporting', err);
  }
  for (const listener of [...listeners]) {
    try {
      listener(err);
    } catch {
    }
  }
}

export function safelyCallListener(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    onUnexpectedError(err);
  }
}

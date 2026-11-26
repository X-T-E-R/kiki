export type UnexpectedErrorHandler = (err: unknown) => void;

function safeConsoleError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
  }
}

const defaultHandler: UnexpectedErrorHandler = (err) => {
  safeConsoleError('[unexpected]', err);
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
    safeConsoleError('[unexpected] handler threw', handlerErr, 'while reporting', err);
  }
  for (const listener of Array.from(listeners)) {
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

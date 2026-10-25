interface ReplyCloseSource {
  readonly raw: {
    readonly writableFinished: boolean;
    readonly destroyed?: boolean;
    once(event: 'close', listener: () => void): void;
    off(event: 'close', listener: () => void): void;
  };
}

interface RequestAbortSource {
  readonly aborted?: boolean;
  once(event: 'aborted', listener: () => void): void;
  off(event: 'aborted', listener: () => void): void;
}

function requestAbortSource(request: object | undefined): RequestAbortSource | undefined {
  if (typeof request !== 'object' || request === null || !('raw' in request)) return undefined;
  const raw = request.raw;
  if (typeof raw !== 'object' || raw === null) return undefined;
  if (!('once' in raw) || typeof raw.once !== 'function') return undefined;
  if (!('off' in raw) || typeof raw.off !== 'function') return undefined;
  return raw as RequestAbortSource;
}

export async function withReplyCloseSignal<T>(
  reply: ReplyCloseSource,
  call: (signal: AbortSignal) => Promise<T>,
  request?: object,
): Promise<T> {
  const disconnect = new AbortController();
  const requestRaw = requestAbortSource(request);
  const onClose = (): void => {
    if (reply.raw.writableFinished) return;
    disconnect.abort();
  };
  const onRequestAbort = (): void => {
    disconnect.abort();
  };
  reply.raw.once('close', onClose);
  requestRaw?.once('aborted', onRequestAbort);
  if (reply.raw.destroyed || requestRaw?.aborted === true) onClose();
  try {
    return await call(disconnect.signal);
  } finally {
    reply.raw.off('close', onClose);
    requestRaw?.off('aborted', onRequestAbort);
  }
}

interface ReplyCloseSource {
  readonly raw: {
    readonly writableFinished: boolean;
    once(event: 'close', listener: () => void): void;
    off(event: 'close', listener: () => void): void;
  };
}

export async function withReplyCloseSignal<T>(
  reply: ReplyCloseSource,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const disconnect = new AbortController();
  const onClose = (): void => {
    if (reply.raw.writableFinished) return;
    disconnect.abort();
  };
  reply.raw.once('close', onClose);
  try {
    return await call(disconnect.signal);
  } finally {
    reply.raw.off('close', onClose);
  }
}

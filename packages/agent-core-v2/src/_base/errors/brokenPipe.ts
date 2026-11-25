const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ECONNRESET', 'EOF', 'ERR_STREAM_DESTROYED']);

/** Returns true when an error indicates a broken or already-destroyed socket/pipe. */
export function isBrokenPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && BROKEN_PIPE_CODES.has(code);
}

/** Returns true when a writable stream or socket is open and not errored or destroyed. */
export function isWritableStreamOpen(stream: {
  readonly writable: boolean;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  readonly errored?: unknown;
  readonly writableErrored?: unknown;
}): boolean {
  return (
    stream.writable &&
    !stream.destroyed &&
    !stream.writableEnded &&
    (stream.errored === undefined || stream.errored === null) &&
    (stream.writableErrored === undefined || stream.writableErrored === null)
  );
}

const STDIO_GUARD_INSTALLED = Symbol.for('kiki.stdioEpipeGuardInstalled');

const BENIGN_STDIO_ERROR_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'EOF']);

/** Returns true when a stream error indicates the parent pipe closed cleanly. */
export function isBenignStdioError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && BENIGN_STDIO_ERROR_CODES.has(code);
}

/** Installs an idempotent error listener and write guard absorbing closed-pipe errors on stdio streams. */
export function installStdioEpipeGuard(
  streams: readonly NodeJS.WritableStream[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    const tagged = stream as NodeJS.WritableStream & {
      [STDIO_GUARD_INSTALLED]?: boolean;
      write: (...args: unknown[]) => boolean;
    };
    if (tagged[STDIO_GUARD_INSTALLED] === true) continue;
    tagged[STDIO_GUARD_INSTALLED] = true;
    stream.on('error', (error: unknown) => {
      if (isBenignStdioError(error)) return;
      if (stream.listenerCount('error') <= 1) throw error;
    });
    const originalWrite = tagged.write.bind(stream);
    tagged.write = (...args: unknown[]): boolean => {
      try {
        return originalWrite(...args);
      } catch (error) {
        if (isBenignStdioError(error)) {
          const maybeCallback = args.at(-1);
          if (typeof maybeCallback === 'function') {
            queueMicrotask(() => {
              (maybeCallback as (err?: Error | null) => void)(null);
            });
          }
          return false;
        }
        throw error;
      }
    };
  }
}

/** Writes to a writable stream without propagating closed-pipe errors. */
export function safeWriteStream(stream: NodeJS.WritableStream, chunk: string | Uint8Array): void {
  const candidate = stream as NodeJS.WritableStream & {
    readonly destroyed?: boolean;
    readonly writableEnded?: boolean;
    readonly writableErrored?: unknown;
  };
  if (
    candidate.destroyed === true ||
    candidate.writableEnded === true ||
    (candidate.writableErrored !== undefined && candidate.writableErrored !== null) ||
    !candidate.writable
  ) {
    return;
  }
  try {
    stream.write(chunk, (error) => {
      if (error !== null && error !== undefined && !isBenignStdioError(error) && stream.listenerCount('error') === 0) {
        return;
      }
    });
  } catch (error) {
    if (!isBenignStdioError(error)) throw error;
  }
}

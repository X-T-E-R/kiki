import type { Readable } from 'node:stream';

import type { IHostProcessService } from '#/os/interface/hostProcess';

export interface EgoDetectionOutput {
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
}

export function readEgoStream(stream: Readable, chunks: Buffer[]): Promise<string> {
  const start = chunks.length;
  return new Promise((resolve, reject) => {
    const collect = (chunk: Buffer | string): void => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); };
    const cleanup = (): void => {
      stream.removeListener('data', collect);
      stream.removeListener('end', finish);
      stream.removeListener('close', finish);
      stream.removeListener('error', fail);
    };
    const finish = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks.slice(start)).toString('utf8'));
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', fail);
    stream.on('data', collect);
  });
}

export async function runEgoDetectionCommand(
  processes: IHostProcessService,
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
  output: EgoDetectionOutput = { stdout: [], stderr: [] },
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  signal?.throwIfAborted();
  const child = await processes.spawn(command, args, {
    shell: false, windowsHide: true, ownedProcessTree: signal === undefined ? undefined : true,
    ownedProcessLifetime: signal !== undefined && process.platform === 'win32' ? 'owner' : undefined,
  });
  const stdout = readEgoStream(child.stdout, output.stdout);
  const stderr = readEgoStream(child.stderr, output.stderr);
  child.stdin?.end?.();
  let cleanup: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  const work = Promise.all([child.wait(), stdout, stderr]);
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => {
      cleanup ??= child.kill().then(() => child.dispose());
      void cleanup.then(() => { reject(signal?.reason ?? new Error('Ego Lite detection cancelled')); }, reject);
    };
    if (signal?.aborted === true) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    const [code, stdoutText, stderrText] = await Promise.race([work, cancelled]);
    signal?.throwIfAborted();
    return { code, stdout: stdoutText, stderr: stderrText };
  } catch (error) {
    if (signal?.aborted === true) {
      await cleanup;
      throw signal.reason;
    }
    throw error;
  } finally {
    if (stop !== undefined) signal?.removeEventListener('abort', stop);
    if (cleanup !== undefined) await cleanup;
    else await child.dispose();
  }
}

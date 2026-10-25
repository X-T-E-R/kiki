import type { Readable } from 'node:stream';

import type { IHostProcessService } from '#/os/interface/hostProcess';

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runEgoDetectionCommand(
  processes: IHostProcessService,
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  signal?.throwIfAborted();
  const child = await processes.spawn(command, args, {
    shell: false, windowsHide: true, ownedProcessTree: signal === undefined ? undefined : true,
    ownedProcessLifetime: signal !== undefined && process.platform === 'win32' ? 'owner' : undefined,
  });
  child.stdin?.end?.();
  let cleanup: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  const work = Promise.all([child.wait(), readStream(child.stdout), readStream(child.stderr)]);
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => {
      cleanup ??= child.kill().then(() => child.dispose());
      void cleanup.then(() => { reject(signal?.reason ?? new Error('Ego Lite detection cancelled')); }, reject);
    };
    if (signal?.aborted === true) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    const [code, stdout, stderr] = await Promise.race([work, cancelled]);
    signal?.throwIfAborted();
    return { code, stdout, stderr };
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

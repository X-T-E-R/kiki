import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { runCommand } from '#/app/capability/host';
import { runCronScript } from '#/app/cron/runCronScript';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { runAutoModelScript } from '#/session/subagent/autoModelScript';

function createHangingProcess(): { readonly proc: IHostProcess; readonly disposed: () => boolean } {
  const stdin = new PassThrough();
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  let wasDisposed = false;
  let resolveExit: ((code: number) => void) | undefined;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    pid: 4242,
    exitCode: null,
    stdin,
    stdout,
    stderr,
    wait: () => exitPromise,
    kill: async () => {
      resolveExit?.(-1);
    },
    dispose: async () => {
      wasDisposed = true;
      stdout.destroy();
      stderr.destroy();
      stdin.destroy();
      resolveExit?.(-1);
    },
  };
  return { proc, disposed: () => wasDisposed };
}

function hostServiceFor(factory: () => IHostProcess): IHostProcessService {
  return {
    _serviceBrand: undefined,
    spawn: async () => factory(),
  } as unknown as IHostProcessService;
}

describe('BufferedReadable process timeout/abort disposal emits zero unhandledRejection', () => {
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
    rejections.length = 0;
  });

  it('runCommand absorbs ERR_STREAM_PREMATURE_CLOSE when timing out and disposing', async () => {
    process.on('unhandledRejection', onUnhandledRejection);
    const hanging = createHangingProcess();
    await expect(
      runCommand(hostServiceFor(() => hanging.proc), 'node', ['-e', ''], { timeout: 25 }),
    ).rejects.toThrow('command timed out');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hanging.disposed()).toBe(true);
    expect(rejections).toEqual([]);
  });

  it('runCronScript absorbs ERR_STREAM_PREMATURE_CLOSE when aborted and disposing', async () => {
    process.on('unhandledRejection', onUnhandledRejection);
    const hanging = createHangingProcess();
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('cancelled')), 20);
    const result = await runCronScript(
      hostServiceFor(() => hanging.proc),
      { command: 'node', args: [], cwd: process.cwd(), timeout: 5, environment: 'isolated' },
      { jobId: 'job-1', cron: '* * * * *', coalescedCount: 1 },
      ac.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(result.outcome).toBe('error');
    expect(result.reason).toBe('cancelled');
    expect(hanging.disposed()).toBe(true);
    expect(rejections).toEqual([]);
  });

  it('runAutoModelScript absorbs ERR_STREAM_PREMATURE_CLOSE when aborted and disposing', async () => {
    process.on('unhandledRejection', onUnhandledRejection);
    const hanging = createHangingProcess();
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('cancelled')), 20);
    await expect(
      runAutoModelScript(
        hostServiceFor(() => hanging.proc),
        { kind: 'script', id: 'sel', command: 'node', args: [], cwd: process.cwd(), timeout: 5 },
        {
          profile: 'worker',
          description: 'test',
          prompt: 'hello',
          candidates: [],
        } as unknown as Parameters<typeof runAutoModelScript>[2],
        ac.signal,
      ),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hanging.disposed()).toBe(true);
    expect(rejections).toEqual([]);
  });
});

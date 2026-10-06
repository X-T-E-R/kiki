import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('HostProcessService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('spawns a process and captures stdout + exit code', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('passes env overrides to the child', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write(process.env.FOO ?? "")'], {
      env: { FOO: 'bar' },
    });
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });

  it('throws a coded error when the command does not exist', async () => {
    const svc = ix.get(IHostProcessService);
    await expect(svc.spawn('definitely-not-a-real-command-42')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(HostProcessError);
      const error = err as HostProcessError;
      expect(error.code).toBe(HostProcessErrorCode.SpawnFailed);
      expect(error.code).toBe('os.process.spawn_failed');
      expect(error.details).toMatchObject({
        command: 'definitely-not-a-real-command-42',
        errno: 'ENOENT',
      });
      expect(error.cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it.skipIf(process.platform === 'win32').each([false, true])('delivers SIGTERM and observes actual exit with detached=%s on POSIX', async (detached) => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn(process.execPath, ['-e',
      'process.on("SIGTERM", () => process.exit(23)); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    ], { detached });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => { reject(new Error('child readiness timed out')); }, 1_500);
        proc.stdout.once('data', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      await proc.kill('SIGTERM');
      const code = await Promise.race([
        proc.wait(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error('kill returned without child exit')); }, 1_500);
        }),
      ]);
      expect(code).toBe(23);
      expect(proc.exitCode).toBe(23);
    } finally {
      clearTimeout(timeout);
      if (proc.exitCode === null) process.kill(proc.pid, 'SIGKILL');
      await proc.wait();
      await proc.dispose();
    }
  });

  it('terminates a running process with kill()', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    expect(proc.pid).toBeGreaterThan(0);
    await proc.kill('SIGTERM');
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });
});

describe('HostProcessService Windows taskkill settlement', () => {
  let platform: NodeJS.Platform;
  let killer: EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
  let disposables: DisposableStore;
  let service: IHostProcessService;
  let commands: string[];

  beforeEach(async () => {
    platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    commands = [];
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn: (command: string, args: readonly string[]) => {
        commands.push([command, ...args].join(' '));
        const child = Object.assign(new EventEmitter(), {
          pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          kill: vi.fn(() => true), unref: vi.fn(),
        });
        if (command === 'taskkill') killer = child;
        else queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    }));
    vi.resetModules();
    const { HostProcessService: WindowsHostProcessService } = await import('#/os/backends/node-local/hostProcessService');
    const { IHostProcessService: WindowsProcessId } = await import('#/os/interface/hostProcess');
    const { createServices: createWindowsServices } = await import('#/_base/di/test');
    disposables = new DisposableStore();
    const ix = createWindowsServices(disposables, {
      additionalServices: (reg) => reg.define(WindowsProcessId, WindowsHostProcessService),
    });
    service = ix.get(WindowsProcessId);
    vi.useFakeTimers();
  });

  afterEach(() => {
    disposables.dispose();
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('bounds a taskkill that never emits close and terminates the owned killer', async () => {
    const process = await service.spawn('node', ['-e', 'owned-test']);
    let settled = false;
    const pending = process.kill().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(commands).toContain('taskkill /T /F /PID 4242');
    expect(killer.kill).toHaveBeenCalledOnce();
    expect(killer.unref).toHaveBeenCalledOnce();
    await pending;
    process.dispose();
  });

  it.each(['close', 'error'])('settles an early taskkill %s without killing it or leaving a deadline', async (event) => {
    const process = await service.spawn('node', ['-e', 'owned-test']);
    const pending = process.kill();
    killer.emit(event, event === 'error' ? new Error('missing taskkill') : 0);
    await pending;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killer.kill).not.toHaveBeenCalled();
    expect(killer.unref).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    process.dispose();
  });
});

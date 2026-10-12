import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
  type HostProcessOptions,
  type IHostProcess,
} from '#/os/interface/hostProcess';

import { spawnWindowsProcessTree } from './windowsProcessTree';

const isWindows: boolean = process.platform === 'win32';
const TASKKILL_TIMEOUT_MS = 5_000;

function buildSpawnOptions(options: HostProcessOptions): SpawnOptions {
  const detached = options.detached ?? !isWindows;
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: buildEnv(options.env, options.envUnset),
    stdio: options.mergeStderr ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    detached,
    windowsHide: options.windowsHide ?? true,
  };

  if (options.shell !== undefined) {
    spawnOptions.shell = options.shell;
  }

  return spawnOptions;
}

function buildEnv(overrides: Record<string, string> | undefined, unset: readonly string[] | undefined): Record<string, string> | undefined {
  if (overrides === undefined && unset === undefined) return undefined;
  const env = { ...(process.env as Record<string, string>), ...overrides };
  for (const key of unset ?? []) delete env[key];
  return env;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

class HostProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private _disposed = false;

  constructor(child: ChildProcess, mergeStderr: boolean, private readonly detached: boolean) {
    if (child.stdin === null || child.stdout === null) {
      throw new HostProcessError(
        HostProcessErrorCode.SpawnFailed,
        'Process must be created with stdin/stdout pipes.',
      );
    }
    if (!mergeStderr && child.stderr === null) {
      throw new HostProcessError(
        HostProcessErrorCode.SpawnFailed,
        'Process must be created with stderr pipe unless mergeStderr is set.',
      );
    }

    this._child = child;
    this.stdin = child.stdin;
    this.stdout = new BufferedReadable(child.stdout);
    this.stderr = mergeStderr
      ? this.stdout
      : new BufferedReadable(child.stderr as Readable);
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  async kill(signal?: NodeJS.Signals): Promise<void> {
    if (this.pid <= 0) {
      return;
    }

    if (isWindows) {
      if (this._exitCode !== null) return;
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(this.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const failure = (phase: string, cause?: unknown, exitCode?: number | null): void => {
            reject(new HostProcessError(HostProcessErrorCode.KillFailed, `Failed to terminate process ${this.pid} with taskkill.`, {
              details: { cleanupComplete: false, phase, pid: this.pid, exitCode }, cause,
            }));
          };
          killer.once('error', (error) => { failure('control', error); });
          killer.once('close', (code) => { if (code === 0) resolve(); else failure('terminate', undefined, code); });
          timeout = setTimeout(() => {
            killer.kill();
            killer.unref();
            failure('deadline');
          }, TASKKILL_TIMEOUT_MS);
        });
      } finally { clearTimeout(timeout); }
      return;
    }

    try {
      process.kill(this.detached ? -this.pid : this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') return;
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal ?? 'SIGTERM');
        } catch {
        }
        return;
      }
      throw new HostProcessError(
        HostProcessErrorCode.KillFailed,
        `Failed to kill process ${this.pid}: ${err.message}`,
        {
          details: { pid: this.pid, signal: signal ?? 'SIGTERM', errno: err.code },
          cause: error,
        },
      );
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    if (this.stderr !== this.stdout) {
      this.stderr.destroy();
    }
  }
}

export class HostProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptions = {},
  ): Promise<IHostProcess> {
    const spawnOptions = buildSpawnOptions(options);
    if (isWindows && options.ownedProcessTree === true) {
      return spawnWindowsProcessTree(command, args, spawnOptions, options.mergeStderr ?? false);
    }
    const child = spawn(command, args as string[], spawnOptions);
    try {
      await waitForSpawn(child);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      throw new HostProcessError(
        HostProcessErrorCode.SpawnFailed,
        `Failed to spawn "${command}": ${err.message}`,
        {
          details: { command, args: [...args], cwd: options.cwd, errno: err.code },
          cause: error,
        },
      );
    }
    return new HostProcess(child, options.mergeStderr ?? false, spawnOptions.detached === true);
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostProcessService,
  HostProcessService,
  ScopeActivation.OnScopeCreated,
  'hostProcess',
);

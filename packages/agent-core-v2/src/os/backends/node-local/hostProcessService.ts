import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';
import { mergeChildEnv } from '#/_base/execEnv/childEnv';

import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
  type HostProcessOptions,
  type IHostProcess,
} from '#/os/interface/hostProcess';

import { prepareWindowsSpawn } from './windowsCommandLine';
import { spawnWindowsProcessTree } from './windowsProcessTree';

const isWindows: boolean = process.platform === 'win32';
const TASKKILL_TIMEOUT_MS = 5_000;

function buildSpawnOptions(options: HostProcessOptions, defaults: Readonly<Record<string, string>>): SpawnOptions {
  const detached = options.detached ?? !isWindows;
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: mergeChildEnv(process.env, defaults, options.env, options.envUnset),
    stdio: options.mergeStderr ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    detached,
    windowsHide: options.windowsHide ?? true,
  };

  if (options.shell !== undefined) {
    spawnOptions.shell = options.shell;
  }

  return spawnOptions;
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

    const signalCode: string | null | undefined = child.signalCode;
    const alreadyExited = typeof child.exitCode === 'number' || (signalCode !== undefined && signalCode !== null);
    if (alreadyExited) {
      this._exitCode = child.exitCode ?? -1;
      this._exitPromise = Promise.resolve(this._exitCode);
    } else {
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
  private readonly ownedTrees = new Set<Awaited<ReturnType<typeof spawnWindowsProcessTree>>>();
  private readonly pendingTrees = new Set<ReturnType<typeof spawnWindowsProcessTree>>();
  private closing = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly childDefaults: Readonly<Record<string, string>> = {}) {}

  dispose(): Promise<void> {
    this.closing = true;
    if (this.disposePromise === undefined) {
      this.disposePromise = this.shutdownOwnedTrees();
      void this.disposePromise.catch(() => { this.disposePromise = undefined; });
    }
    return this.disposePromise;
  }

  private async shutdownOwnedTrees(): Promise<void> {
    await Promise.allSettled(this.pendingTrees);
    const outcomes = await Promise.allSettled([...this.ownedTrees].map((tree) => tree.shutdownOwner()));
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason as unknown);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Failed to stop owned Windows process trees.');
  }

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptions = {},
  ): Promise<IHostProcess> {
    if (this.closing) throw new HostProcessError(HostProcessErrorCode.SpawnFailed, 'Host process service is shutting down.', { details: { command, phase: 'owner' } });
    const ownerLifetime = options.ownedProcessLifetime === 'owner';
    if (ownerLifetime && (!isWindows || options.ownedProcessTree !== true)) {
      throw new HostProcessError(HostProcessErrorCode.SpawnFailed, 'Owner lifetime requires an owned Windows process tree.', { details: { command, phase: 'owner' } });
    }
    const initialOptions = buildSpawnOptions(options, this.childDefaults);
    const launch = isWindows ? prepareWindowsSpawn(command, args, initialOptions) : { command, args, options: initialOptions };
    const spawnOptions = launch.options;
    if (isWindows && options.ownedProcessTree === true) {
      const pending = spawnWindowsProcessTree(launch.command, launch.args, spawnOptions, options.mergeStderr ?? false, ownerLifetime);
      if (!ownerLifetime) return pending;
      this.pendingTrees.add(pending);
      try {
        const tree = await pending;
        this.ownedTrees.add(tree);
        tree.onRelease(() => { this.ownedTrees.delete(tree); });
        if (this.closing) throw new HostProcessError(HostProcessErrorCode.SpawnFailed, 'Host process service shut down during launch.', { details: { command, phase: 'owner' } });
        return tree;
      } finally { this.pendingTrees.delete(pending); }
    }
    const child = spawn(launch.command, launch.args as string[], spawnOptions);
    const processHandle = new HostProcess(child, options.mergeStderr ?? false, spawnOptions.detached === true);
    const observedExit = processHandle.wait().catch(() => undefined);
    try {
      await waitForSpawn(child);
    } catch (error) {
      await observedExit;
      processHandle.dispose();
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
    return processHandle;
  }
}

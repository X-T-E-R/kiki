import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type {
  HostProcessLike,
  HostProcessOptionsLike,
  HostProcessServiceLike,
} from '../../src/types';

class NodeHostProcess implements HostProcessLike {
  readonly #child: ChildProcess;
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly #wait: Promise<number>;

  constructor(child: ChildProcess) {
    if (child.pid === undefined || child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Child process did not expose piped stdio');
    }
    this.#child = child;
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.#wait = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        resolve(code ?? -1);
      });
    });
  }

  get exitCode(): number | null {
    return this.#child.exitCode;
  }

  wait(): Promise<number> {
    return this.#wait;
  }

  async kill(signal?: NodeJS.Signals): Promise<void> {
    this.#child.kill(signal);
  }

  dispose(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }
}

export class NodeHostProcessService implements HostProcessServiceLike {
  readonly spawns: Array<{ command: string; args: readonly string[] }> = [];

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptionsLike = {},
  ): Promise<HostProcessLike> {
    this.spawns.push({ command, args: [...args] });
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      shell: options.shell,
      detached: options.detached,
      windowsHide: options.windowsHide,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return new NodeHostProcess(child);
  }
}

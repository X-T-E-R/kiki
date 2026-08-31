import { spawn } from 'node:child_process';

import type {
  HostProcessLike,
  HostProcessOptionsLike,
  HostProcessServiceLike,
} from '../src/types';

export class NodeProcessService implements HostProcessServiceLike {
  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptionsLike = {},
  ): Promise<HostProcessLike> {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      shell: options.shell,
      detached: options.detached,
      windowsHide: options.windowsHide,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const wait = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? -1));
    });
    return {
      pid: child.pid!,
      get exitCode() {
        return child.exitCode;
      },
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      wait: () => wait,
      kill: async (signal = 'SIGTERM') => {
        child.kill(signal);
      },
      dispose: () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      },
    };
  }
}

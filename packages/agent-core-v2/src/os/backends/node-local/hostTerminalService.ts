import type { IPty } from 'node-pty';

import { Service } from '#/_base/di/service';
import { mergeChildEnv } from '#/_base/execEnv/childEnv';

import { IHostTerminalService, type TerminalProcess, type TerminalSpawnOptions } from '#/os/interface/terminal';

export class HostTerminalService extends Service implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly processes = new Set<TerminalProcess>();

  constructor(private readonly childDefaults: Readonly<Record<string, string>> = {}) { super(); }

  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const pty = await import('node-pty');
    const proc: IPty = pty.spawn(options.shell, [], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: mergeChildEnv(globalThis.process.env, this.childDefaults),
    });
    const terminalProcess: TerminalProcess = {
      onProcessData: (listener) => proc.onData(listener),
      onProcessExit: (listener) => proc.onExit((event) => listener({ exitCode: event.exitCode })),
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
    this.processes.add(terminalProcess);
    return terminalProcess;
  }

  override dispose(): void | Promise<void> {
    for (const process of this.processes) {
      try {
        process.kill();
      } catch {
      }
    }
    this.processes.clear();
    return super.dispose();
  }
}

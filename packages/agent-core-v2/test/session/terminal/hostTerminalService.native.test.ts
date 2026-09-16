import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IHostTerminalService } from '#/os/interface/terminal';
import { HostTerminalService } from '#/os/backends/node-local/hostTerminalService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionTerminalService,
  SessionTerminalService,
} from '#/session/terminal/terminalService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

describe('native Windows terminal lifecycle', () => {
  let disposables: DisposableStore | undefined;

  afterEach(() => {
    disposables?.dispose();
  });

  it.runIf(process.platform === 'win32')(
    'creates the default PTY, accepts input and resize, emits output, and closes it',
    async () => {
      disposables = new DisposableStore();
      const cwd = process.cwd();
      const ix: TestInstantiationService = createServices(disposables, {
        additionalServices: (reg) => {
          reg.define(IHostTerminalService, HostTerminalService);
          reg.define(ISessionTerminalService, SessionTerminalService);
          reg.defineInstance(IRuntimeResolver, {
            _serviceBrand: undefined,
            inspect: () => {
              throw new Error('inspect is not used by this smoke test');
            },
            acquire: () => {
              const base = new FakeRuntime(
                {
                  workspaceId: 'native-terminal-workspace',
                  runtimeId: 'local',
                  generation: 'native-smoke',
                },
                {
                  capabilities: ['terminal'],
                  pathClass: process.platform === 'win32' ? 'win32' : 'posix',
                },
              );
              const runtime = Object.assign(base, {
                terminal: new HostTerminalService(),
                environment: {
                  ...base.environment,
                  shellPath: process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe',
                },
              });
              let active = true;
              return {
                runtime,
                track: <T extends { dispose(): void | Promise<void> }>(resource: T): T => resource,
                dispose: () => {
                  if (!active) return;
                  active = false;
                },
              };
            },
          } satisfies IRuntimeResolver);
          reg.defineInstance(ISessionWorkspaceContext, {
            _serviceBrand: undefined,
            workDir: cwd,
            additionalDirs: [],
            resolve: (rel) => resolve(cwd, rel),
            isWithin: () => true,
            assertAllowed: (path) => resolve(cwd, path),
          });
          reg.defineInstance(
            ISessionContext,
            makeSessionContext({
              sessionId: 'native-terminal-smoke',
              workspaceId: 'native-terminal-workspace',
              sessionDir: resolve(cwd, '.native-terminal-smoke'),
              sessionScope: 'session:native-terminal-smoke',
              metaScope: 'session:native-terminal-smoke',
              cwd,
            }),
          );
        },
      });

      const service = ix.get(ISessionTerminalService);
      const terminal = await service.create({ runtime_id: 'local', cols: 90, rows: 28 });
      expect((await stat(terminal.shell)).isFile()).toBe(true);

      let output = '';
      let resolveOutput!: () => void;
      const outputReady = new Promise<void>((resolveReady) => {
        resolveOutput = resolveReady;
      });
      let resolveExit!: () => void;
      const exitReady = new Promise<void>((resolveReady) => {
        resolveExit = resolveReady;
      });
      const marker = 'KIKI_NATIVE_PTY_SMOKE';
      await service.attach(terminal.id, {
        id: 'native-smoke',
        send: (frame) => {
          if (frame.type === 'terminal_exit') {
            resolveExit();
            return;
          }
          output += frame.payload.data;
          if (output.includes(marker)) resolveOutput();
        },
      });

      await service.resize(terminal.id, 100, 32);
      const shellName = basename(terminal.shell).toLowerCase();
      await service.write(
        terminal.id,
        shellName === 'cmd.exe' ? `echo ${marker}\r` : `Write-Output ${marker}\r`,
      );
      await withTimeout(outputReady, 5000, () =>
        `timed out waiting for native PTY output: ${output}`,
      );

      expect(output).toContain(marker);
      await service.write(terminal.id, 'exit\r');
      await withTimeout(exitReady, 5000, () => `timed out waiting for native PTY exit: ${output}`);
      expect(await service.close(terminal.id)).toEqual({ closed: true });
      expect(await service.get(terminal.id)).toMatchObject({
        cols: 100,
        rows: 32,
        status: 'exited',
      });
    },
    10_000,
  );
});

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message()));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

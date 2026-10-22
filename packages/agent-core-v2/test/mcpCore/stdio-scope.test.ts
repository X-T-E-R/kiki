import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { FakeRuntime } from '#/runtime/fakeRuntime';

import { cwdStdioFixture, hostProcessPathClass } from './stubs';

const leftovers: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of leftovers.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function directory(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kiki-mcp-scope-')));
  directories.push(dir);
  return dir;
}

function manager(workspaceId: string, stdioCwd: string): McpConnectionManager {
  const runtime = Object.assign(
    new FakeRuntime(
      { workspaceId, runtimeId: 'local', generation: 'test' },
      { capabilities: ['process'], pathClass: hostProcessPathClass },
    ),
    { process: new HostProcessService() },
  );
  return new McpConnectionManager({
    runtimeResolver: {
      _serviceBrand: undefined,
      inspect: () => runtime,
      acquire: () => ({ runtime, track: <T>(resource: T) => resource, dispose: () => {} }),
    },
    workspaceId,
    runtimeId: 'local',
    stdioCwd,
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error('timed out waiting for process state');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('stdio MCP process scope', () => {
  it('shares one process for the same config and cwd, isolates a different cwd or env, and releases only its own tree', async () => {
    const spawnSpy = vi.spyOn(HostProcessService.prototype, 'spawn');
    const home = directory();
    const other = directory();
    const same = manager('workspace-a', home);
    const differentCwd = manager('workspace-b', other);
    const differentEnv = manager('workspace-a', home);
    const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
    leftovers.push(sentinel);
    const config = { transport: 'stdio' as const, command: process.execPath, args: [cwdStdioFixture] };
    try {
      await same.connect('colab', config);
      await same.connect('colab', config);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      await differentCwd.connect('colab', config);
      await differentEnv.connect('colab', { ...config, env: { KIKI_FIXTURE_SCOPE: 'other' } });
      expect(spawnSpy).toHaveBeenCalledTimes(3);
      const processes = await Promise.all(spawnSpy.mock.results.map((result) => result.value as Promise<IHostProcess>));
      const cwdValues = spawnSpy.mock.calls.map((call) => call[2]?.cwd);
      expect(cwdValues[0]).toBe(home);
      expect(cwdValues[1]).toBe(other);
      expect(cwdValues[2]).toBe(home);
      expect(new Set(processes.map((child) => child.pid)).size).toBe(3);
      for (const child of processes) expect(alive(child.pid)).toBe(true);
      expect(alive(sentinel.pid)).toBe(true);
      await same.shutdown();
      await waitUntil(() => !alive(processes[0]?.pid));
      expect(alive(processes[1]?.pid)).toBe(true);
      expect(alive(processes[2]?.pid)).toBe(true);
      expect(alive(sentinel.pid)).toBe(true);
      await differentCwd.shutdown();
      await differentEnv.shutdown();
      await waitUntil(() => !alive(processes[1]?.pid) && !alive(processes[2]?.pid));
      expect(alive(sentinel.pid)).toBe(true);
    } finally {
      spawnSpy.mockRestore();
      await same.shutdown().catch(() => undefined);
      await differentCwd.shutdown().catch(() => undefined);
      await differentEnv.shutdown().catch(() => undefined);
    }
  }, 20_000);
});

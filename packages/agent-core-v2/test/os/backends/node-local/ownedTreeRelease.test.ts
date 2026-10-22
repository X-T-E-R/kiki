import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { AgentTaskService } from '#/agent/task/taskService';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { IConfigService } from '#/app/config/config';
import { ITaskService } from '#/app/task/task';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { stubContextMemory } from '../../../agent/contextMemory/stubs';
import { stubLoopWithHooks } from '../../../agent/loop/stubs';
import { registerTestAgentWireServices } from '../../../wire/stubs';

const exec = promisify(execFile);

function alive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readPids(file: string): Promise<number[]> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    if (text.length === 0) return [];
    return text.split(/\r?\n/u).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

describe.skipIf(process.platform !== 'win32')('owned Windows process tree release', () => {
  let directory: string;
  let helper: string;
  let treeScript: string;
  let tasks: IAgentTaskService;
  let service: HostProcessService;
  let disposables: DisposableStore;
  const owned: IHostProcess[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kiki-owned-tree-'));
    helper = join(directory, 'process-helper.exe');
    treeScript = join(directory, 'tree.cjs');
    const source = fileURLToPath(new URL('../../../../src/os/backends/node-local/windowsProcessHelper.cs', import.meta.url));
    await exec(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/platform:anycpu', `/out:${helper}`, source], { timeout: 30_000, windowsHide: true });
    await writeFile(treeScript, `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const file = process.argv[2];
      const role = process.argv[3] || 'root';
      fs.appendFileSync(file, String(process.pid) + '\\n');
      if (role === 'exit' || role === 'gone') {
        spawn(process.execPath, [__filename, file, 'leaf'], { stdio: 'ignore', detached: true });
        setTimeout(() => process.exit(0), role === 'exit' ? 200 : 100);
        return;
      }
      if (role === 'root' || role === 'brief') {
        spawn(process.execPath, [__filename, file, role === 'brief' ? 'gone' : 'mid'], { stdio: 'ignore', detached: true });
      } else if (role === 'mid') {
        spawn(process.execPath, [__filename, file, 'leaf'], { stdio: 'ignore', detached: true });
      }
      setInterval(() => {}, 1000);
    `);
  }, 40_000);

  beforeEach(() => {
    disposables = new DisposableStore();
    const loop = stubLoopWithHooks();
    loop.hooks.onWillBeginStep.register('context-injector', async (_ctx, next) => next());
    const ix = createServices(disposables, {
      base: [registerTestAgentWireServices],
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
        reg.define(IAgentTaskService, AgentTaskService);
        reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
        reg.defineInstance(IAgentLoopService, loop);
        reg.definePartialInstance(IAgentLifecycleService, { get: () => undefined });
        reg.definePartialInstance(IAgentConversationUndoParticipantRegistry, { register: () => toDisposable(() => {}) });
        reg.definePartialInstance(IAgentContextInjectorService, { register: () => toDisposable(() => {}) });
        reg.definePartialInstance(IConfigService, { get: (() => ({ killGracePeriodMs: 50 })) as IConfigService['get'] });
        reg.definePartialInstance(ITaskService, {});
        reg.definePartialInstance(IAtomicDocumentStore, { get: async () => undefined, set: async () => {}, list: async () => [] });
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 'owned-tree', workspaceId: 'owned-tree', sessionDir: directory, sessionScope: 'owned-tree', cwd: directory,
        }));
      },
    });
    service = ix.get(IHostProcessService) as HostProcessService;
    tasks = ix.get(IAgentTaskService);
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', helper);
  });

  afterEach(async () => {
    for (const proc of owned.splice(0)) {
      try { await proc.kill(); } catch { undefined; }
      try { await proc.dispose(); } catch { undefined; }
    }
    vi.unstubAllEnvs();
    await disposables.dispose();
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function spawnTree(file: string, lifetime?: 'owner'): Promise<IHostProcess> {
    const proc = await service.spawn(process.execPath, [treeScript, file], {
      ownedProcessTree: true,
      ownedProcessLifetime: lifetime,
    });
    owned.push(proc);
    proc.stdin.end();
    return proc;
  }

  async function waitForTree(file: string): Promise<number[]> {
    let pids: number[] = [];
    await vi.waitFor(async () => {
      pids = await readPids(file);
      expect(pids.filter(alive)).toHaveLength(3);
    }, { timeout: 4_000 });
    return pids;
  }

  it('timeout terminates the owned node tree and leaves an unrelated process', async () => {
    const file = join(directory, 'timeout-pids.txt');
    const sentinel = await service.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    owned.push(sentinel);
    const proc = await spawnTree(file, 'owner');
    const taskId = tasks.registerTask(new ProcessTask(proc, 'timeout-tree', 'timeout'), {
      detached: true,
      timeoutMs: 2_500,
    });
    const pids = await waitForTree(file);
    const result = await tasks.wait(taskId, 8_000);
    expect(result?.status).toBe('timed_out');
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(proc.pid)).toBe(false);
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({ case: 'timeout', descendants: pids.length, aliveAfter: 0, sentinelAlive: true }));
  }, 15_000);

  it('cancel terminates the owned node tree and leaves an unrelated process', async () => {
    const file = join(directory, 'cancel-pids.txt');
    const sentinel = await service.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    owned.push(sentinel);
    const proc = await spawnTree(file, 'owner');
    const taskId = tasks.registerTask(new ProcessTask(proc, 'cancel-tree', 'cancel'), { detached: true });
    const pids = await waitForTree(file);
    const result = await tasks.stop(taskId, 'TaskStop');
    expect(result?.status).toBe('killed');
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({ case: 'cancel', descendants: pids.length, aliveAfter: 0, sentinelAlive: true }));
  }, 15_000);

  it('session close stops a running owned tree and leaves an unrelated process', async () => {
    const file = join(directory, 'session-pids.txt');
    const sentinel = await service.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    owned.push(sentinel);
    const proc = await spawnTree(file, 'owner');
    tasks.registerTask(new ProcessTask(proc, 'session-tree', 'session'), { detached: true });
    const pids = await waitForTree(file);
    const stopped = await tasks.stopAllOnExit('Session closed');
    expect(stopped.map((info) => info.status)).toEqual(['killed']);
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({ case: 'session-close', descendants: pids.length, aliveAfter: 0, sentinelAlive: true }));
  }, 15_000);

  it('successful exit keeps owner-lifetime residents inside the job until the backend stops', async () => {
    const file = join(directory, 'success-pids.txt');
    const sentinel = await service.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    owned.push(sentinel);
    const rootScript = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});fs.writeFileSync(process.argv[1],String(child.pid));process.exit(0);`;
    const proc = await service.spawn(process.execPath, ['-e', rootScript, file], {
      ownedProcessTree: true,
      ownedProcessLifetime: 'owner',
    });
    owned.push(proc);
    proc.stdin.end();
    const taskId = tasks.registerTask(new ProcessTask(proc, 'success-tree', 'success'), { detached: true });
    const result = await tasks.wait(taskId, 8_000);
    expect(result?.status).toBe('completed');
    const leaf = Number((await readFile(file, 'utf8')).trim());
    const helperPid = (proc as unknown as { child: { pid?: number } }).child.pid;
    expect(alive(leaf)).toBe(true);
    expect(alive(helperPid)).toBe(true);
    expect(alive(sentinel.pid)).toBe(true);
    await service.dispose();
    expect(alive(leaf)).toBe(false);
    expect(alive(helperPid)).toBe(false);
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({ case: 'success-then-backend-stop', leafAliveUntilBackendStop: true, aliveAfterBackendStop: 0, sentinelAlive: true }));
  }, 15_000);

  const bash = 'C:/Program Files/Git/bin/bash.exe';

  function bashQuote(text: string): string {
    return `'${text.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  }

  async function spawnBash(command: string): Promise<IHostProcess> {
    const proc = await service.spawn(bash, ['-c', command], {
      ownedProcessTree: true,
      ownedProcessLifetime: 'owner',
    });
    owned.push(proc);
    proc.stdin.end();
    return proc;
  }

  it('timeout zeroes a Bash pipeline after an intermediate parent has exited', async () => {
    const file = join(directory, 'bash-timeout-pids.txt');
    const sentinel = await service.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    owned.push(sentinel);
    const command = `${bashQuote(process.execPath)} ${bashQuote(treeScript)} ${bashQuote(file)} brief | cat`;
    const proc = await spawnBash(command);
    const taskId = tasks.registerTask(new ProcessTask(proc, command, 'bash timeout'), {
      detached: true,
      timeoutMs: 3_000,
    });
    let pids: number[] = [];
    await vi.waitFor(async () => {
      pids = await readPids(file);
      expect(pids).toHaveLength(3);
      expect(pids.filter(alive)).toHaveLength(2);
    }, { timeout: 4_000 });
    expect(alive(proc.pid)).toBe(true);
    const result = await tasks.wait(taskId, 8_000);
    expect(result?.status).toBe('timed_out');
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(proc.pid)).toBe(false);
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({ case: 'bash-timeout', descendants: pids.length, aliveAfter: 0, sentinelAlive: true }));
  }, 20_000);

  it('cancel zeroes a Bash pipeline after an intermediate parent has exited', async () => {
    const file = join(directory, 'bash-cancel-pids.txt');
    const sentinel = await service.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    owned.push(sentinel);
    const command = `${bashQuote(process.execPath)} ${bashQuote(treeScript)} ${bashQuote(file)} brief | cat`;
    const proc = await spawnBash(command);
    const taskId = tasks.registerTask(new ProcessTask(proc, command, 'bash cancel'), { detached: true });
    let pids: number[] = [];
    await vi.waitFor(async () => {
      pids = await readPids(file);
      expect(pids).toHaveLength(3);
      expect(pids.filter(alive)).toHaveLength(2);
    }, { timeout: 4_000 });
    const result = await tasks.stop(taskId, 'TaskStop');
    expect(result?.status).toBe('killed');
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({ case: 'bash-cancel', descendants: pids.length, aliveAfter: 0, sentinelAlive: true }));
  }, 20_000);

  it('kills grandchildren through the job after the parent Bash has already exited', async () => {
    const file = join(directory, 'bash-shell-exit-pids.txt');
    const sentinel = await service.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    owned.push(sentinel);
    const command = `${bashQuote(process.execPath)} ${bashQuote(treeScript)} ${bashQuote(file)} exit >/dev/null 2>&1 & exit 0`;
    const proc = await spawnBash(command);
    const taskId = tasks.registerTask(new ProcessTask(proc, command, 'bash shell exit'), { detached: true });
    const result = await tasks.wait(taskId, 8_000);
    expect(result?.status).toBe('completed');
    expect(proc.exitCode).toBe(0);
    expect(alive(proc.pid)).toBe(false);
    let grandchildren: number[] = [];
    await vi.waitFor(async () => {
      const pids = await readPids(file);
      grandchildren = pids.filter(alive);
      expect(pids.length).toBeGreaterThanOrEqual(2);
      expect(grandchildren).toHaveLength(1);
    }, { timeout: 4_000 });
    const helperPid = (proc as unknown as { child: { pid?: number } }).child.pid;
    expect(alive(helperPid)).toBe(true);
    await proc.kill();
    expect(grandchildren.filter(alive)).toEqual([]);
    await vi.waitFor(() => { expect(alive(helperPid)).toBe(false); }, { timeout: 3_000 });
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({
      case: 'bash-shell-exited-first',
      grandchildrenBeforeKill: grandchildren.length,
      aliveAfterJobKill: 0,
      sentinelAlive: true,
    }));
  }, 20_000);
});

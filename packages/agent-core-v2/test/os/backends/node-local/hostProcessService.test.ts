import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import type { IHostProcess } from '#/os/interface/hostProcess';

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { IAgentTaskService } from '#/agent/task/task';
import { AgentTaskService } from '#/agent/task/taskService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IConfigService } from '#/app/config/config';
import { ITaskService } from '#/app/task/task';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { registerTestAgentWireServices } from '../../../wire/stubs';
import { stubContextMemory } from '../../../agent/contextMemory/stubs';
import { stubLoopWithHooks } from '../../../agent/loop/stubs';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

async function collectBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function collect(stream: Readable): Promise<string> {
  return (await collectBytes(stream)).toString('utf8');
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

  afterEach(async () => {
    await disposables.dispose();
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

  afterEach(async () => {
    await disposables.dispose();
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('bounds a taskkill that never emits close and terminates the owned killer', async () => {
    const process = await service.spawn('node', ['-e', 'owned-test']);
    let settled = false;
    const pending = process.kill().catch((error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(commands).toContain('taskkill /T /F /PID 4242');
    expect(killer.kill).toHaveBeenCalledOnce();
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(await pending).toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'deadline', pid: 4242 } });
    await process.dispose();
  });

  it.each(['close', 'error'])('settles an early taskkill %s without killing it or leaving a deadline', async (event) => {
    const process = await service.spawn('node', ['-e', 'owned-test']);
    const pending = process.kill();
    const check = event === 'error'
      ? expect(pending).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control' } })
      : expect(pending).resolves.toBeUndefined();
    killer.emit(event, event === 'error' ? new Error('missing taskkill') : 0);
    await check;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killer.kill).not.toHaveBeenCalled();
    expect(killer.unref).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await process.dispose();
  });
});


describe.skipIf(process.platform !== 'win32')('Windows owned process tree', () => {
  let directory: string;
  let helper: string;
  let failingKillHelper: string;
  let failingReleaseHelper: string;
  let tasks: IAgentTaskService;
  let svc: IHostProcessService;
  let disposables: DisposableStore;
  const owned: IHostProcess[] = [];
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  const spawnOwned = async (command: string, args: readonly string[] = [], options: Parameters<IHostProcessService['spawn']>[2] = {}): Promise<IHostProcess> => {
    const proc = await svc.spawn(command, args, { ...options, ownedProcessTree: true });
    owned.push(proc);
    return proc;
  };
  const readPids = async (file: string): Promise<number[]> => (await readFile(file, 'utf8')).trim().split('\n').map(Number);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kiki-process-tests-'));
    helper = join(directory, 'process-helper.exe');
    const source = fileURLToPath(new URL('../../../../src/os/backends/node-local/windowsProcessHelper.cs', import.meta.url));
    await promisify(execFile)(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/platform:anycpu', `/out:${helper}`, source], { timeout: 30_000, windowsHide: true });
    const canonical = await readFile(source, 'utf8');
    for (const [name, expression, injected] of [
      ['fail-kill', 'Check(TerminateJobObject(job, 1), "TerminateJobObject");', 'if (failures-- > 0) throw new Win32Exception(5, "Injected termination failure");'],
      ['fail-release', 'limits.limits.flags = 0;', 'if (failures-- > 0) throw new Win32Exception(5, "Injected release failure");'],
    ]) {
      const fixtureSource = join(directory, `${name}.cs`);
      const fixtureHelper = join(directory, `${name}.exe`);
      const modified = canonical.replace('Thread waiter = null;', `Thread waiter = null; int failures = ${name === 'fail-kill' ? 2 : 1};`).replace(expression!, `${injected} ${expression}`);
      await writeFile(fixtureSource, modified);
      await promisify(execFile)(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', '/platform:anycpu', `/out:${fixtureHelper}`, fixtureSource], { timeout: 30_000, windowsHide: true });
      if (name === 'fail-kill') failingKillHelper = fixtureHelper;
      else failingReleaseHelper = fixtureHelper;
    }
    await writeFile(join(directory, 'tree.cjs'), `
      const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const file=process.argv[2]; fs.appendFileSync(file,process.pid+'\\n');
      if(process.argv[3]==='leaf') { setTimeout(()=>{},15000); }
      else {
        const child=spawn(process.execPath,[__filename,file,'leaf'],{stdio:'ignore',detached:true});
        if(process.argv[3]==='middle') setTimeout(()=>process.exit(),100);
        else {spawn(process.execPath,[__filename,file,'middle'],{stdio:'ignore',detached:true});setTimeout(()=>{},15000);}
      }
    `);
  }, 40_000);

  beforeEach(() => {
    disposables = new DisposableStore();
    const ix = createServices(disposables, {
      base: [registerTestAgentWireServices],
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
        reg.define(IAgentTaskService, AgentTaskService);
        reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
        reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
        reg.definePartialInstance(IAgentLifecycleService, { get: () => undefined });
        reg.definePartialInstance(IAgentConversationUndoParticipantRegistry, { register: () => toDisposable(() => {}) });
        reg.definePartialInstance(IAgentContextInjectorService, { register: () => toDisposable(() => {}) });
        reg.definePartialInstance(IConfigService, { get: (() => ({ killGracePeriodMs: 50 })) as IConfigService['get'] });
        reg.definePartialInstance(ITaskService, {});
        reg.definePartialInstance(IAtomicDocumentStore, { get: async () => undefined, set: async () => {}, list: async () => [] });
        reg.defineInstance(ISessionContext, makeSessionContext({ sessionId: 'process-test', workspaceId: 'process-test', sessionDir: directory, sessionScope: 'process-test', cwd: directory }));
      },
    });
    svc = ix.get(IHostProcessService);
    tasks = ix.get(IAgentTaskService);
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', helper);
  });

  afterEach(async () => {
    for (const proc of owned.splice(0)) {
      try { await proc.kill(); } catch { }
      try { await proc.dispose(); } catch { }
    }
    vi.unstubAllEnvs();
    await disposables.dispose();
  });

  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it('preserves binary stdin/stdout/stderr, EOF, cwd, env, argv and actual exit status', async () => {
    const proc = await spawnOwned(process.execPath, ['-e',
      `process.stdin.on('data',chunk=>process.stdout.write(chunk)); process.stdin.on('end',()=>{process.stderr.write(Buffer.from([0,255,128,13,10]));process.stdout.write(JSON.stringify([process.cwd(),process.env.TREE_TEST,process.env.TREE_UNSET,process.argv[1],process.argv[2].length]));process.exitCode=23;});`,
      'space "quoted" trailing\\', 'x'.repeat(26_000),
    ], { cwd: directory, env: { TREE_TEST: 'owned env', TREE_UNSET: 'remove' }, envUnset: ['TREE_UNSET'] });
    const stdout = collectBytes(proc.stdout);
    const stderr = collectBytes(proc.stderr);
    proc.stdin.end(Buffer.from([0, 255, 128, 13, 10]));
    expect(await proc.wait()).toBe(23);
    const output = await stdout;
    expect(output.subarray(0, 5)).toEqual(Buffer.from([0, 255, 128, 13, 10]));
    expect(output.subarray(5).toString('utf8')).toBe(JSON.stringify([directory, 'owned env', undefined, 'space "quoted" trailing\\', 26_000]));
    expect(await stderr).toEqual(Buffer.from([0, 255, 128, 13, 10]));
    await proc.dispose();
  });

  it.each(['timeout', 'TaskStop'])('cleans a real Git Bash pipeline with short-lived intermediate parents after %s', async (reason) => {
    const file = join(directory, `${reason}-pids.txt`);
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} | cat | cat`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    const taskId = tasks.registerTask(new ProcessTask(proc, command, reason), {
      detached: true,
      timeoutMs: reason === 'timeout' ? 1000 : undefined,
    });
    await vi.waitFor(async () => { expect((await readPids(file)).length).toBe(4); }, { timeout: 3000 });
    const pids = await readPids(file);
    await new Promise<void>((resolve) => { setTimeout(resolve, 150); });
    expect(pids.filter(alive).length).toBe(3);
    const result = reason === 'TaskStop' ? await tasks.stop(taskId, 'TaskStop') : await tasks.wait(taskId, 5000);
    expect(result?.status).toBe(reason === 'timeout' ? 'timed_out' : 'killed');
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(proc.pid)).toBe(false);
    console.log(JSON.stringify({ reason, root: proc.pid, descendants: pids, allGone: true }));
  }, 10_000);

  it('retains kernel ownership after the root exits and leaves an unrelated process alive', async () => {
    const file = join(directory, 'orphan-pids.txt');
    const sentinel = await svc.spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)']);
    owned.push(sentinel);
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    expect(pids.some(alive)).toBe(true);
    await proc.kill();
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(sentinel.pid)).toBe(true);
    console.log(JSON.stringify({ rootExited: proc.pid, descendants: pids, allGone: true, unrelatedAlive: sentinel.pid }));
  });

  it('normal completion releases the job without killing resident descendants', async () => {
    const file = join(directory, 'resident-pids.txt');
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    try {
      await proc.dispose();
      expect(pids.filter(alive).length).toBe(3);
      await expect(proc.kill()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control' } });
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await vi.waitFor(() => { expect(pids.filter(alive)).toEqual([]); });
    }
  });

  it('keeps a failed termination nonterminal with a typed diagnostic and reaps the tree on retry', async () => {
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', failingKillHelper);
    const proc = await spawnOwned(process.execPath, ['-e', 'process.stdout.write("ready");setTimeout(()=>{},15000)']);
    proc.stdin.end();
    const taskId = tasks.registerTask(new ProcessTask(proc, 'owned fixture', 'injected kill failure'), { detached: true });
    await expect(tasks.stop(taskId)).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'terminate', win32Error: 5, pid: proc.pid } });
    expect(tasks.getTask(taskId)?.status).toBe('running');
    expect(tasks.getTask(taskId)?.stopReason).toContain('"cleanupComplete":false');
    expect(alive(proc.pid)).toBe(true);
    const result = await tasks.stop(taskId);
    expect(result?.status).toBe('killed');
    expect(alive(proc.pid)).toBe(false);
    console.log(JSON.stringify({ case: 'kill-failure-retry', pid: proc.pid, firstCleanupComplete: false, retryAllGone: true }));
  });

  it('retains residents and reports a failed normal release, then cleans them on TaskStop retry', async () => {
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', failingReleaseHelper);
    const file = join(directory, 'failed-release-pids.txt');
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    const taskId = tasks.registerTask(new ProcessTask(proc, command, 'injected release failure'), { detached: true });
    await vi.waitFor(() => { expect(tasks.getTask(taskId)?.stopReason).toContain('"phase":"release"'); });
    const pids = await readPids(file);
    expect(tasks.getTask(taskId)?.status).toBe('running');
    expect(pids.filter(alive).length).toBe(3);
    const result = await tasks.stop(taskId);
    expect(result?.status).toBe('killed');
    expect(pids.filter(alive)).toEqual([]);
    console.log(JSON.stringify({ case: 'normal-release-failure-retry', root: proc.pid, descendants: pids, residentsPreservedUntilStop: true, retryAllGone: true }));
  });

  it('fails explicitly when the helper is missing or exits before its control channel opens', async () => {
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', '');
    await expect(spawnOwned(process.execPath)).rejects.toMatchObject({ code: 'os.process.spawn_failed', details: { helperMissing: true } });
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', process.execPath);
    await expect(spawnOwned(process.execPath)).rejects.toMatchObject({ code: 'os.process.spawn_failed', details: { phase: 'launch' } });
  });
});

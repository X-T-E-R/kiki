import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
import { AppHostProcessService } from '#/app/bootstrap/hostChildServices';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { StdioMcpClient } from '#/mcpCore/client-stdio';
import { LocalRuntime } from '#/runtime/localRuntime';

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

  it('resolves the App process service with the selected bootstrap home', async () => {
    ix.stub(IBootstrapService, { homeDir: 'selected-space' });
    ix.set(IHostProcessService, new SyncDescriptor(AppHostProcessService));
    const child = await ix.get(IHostProcessService).spawn(process.execPath, ['-e', 'process.stdout.write(process.env.KIKI_HOME??"")']);
    expect(await collect(child.stdout)).toBe('selected-space');
    expect(await child.wait()).toBe(0);
  });

  it('keeps per-App home defaults between ambient env and explicit overrides', async () => {
    vi.stubEnv('KIKI_HOME', 'ambient-main');
    vi.stubEnv('KIMI_CODE_HOME', 'vendor-kimi');
    const first = new HostProcessService({ KIKI_HOME: 'space A' });
    const second = new HostProcessService({ KIKI_HOME: 'space B' });
    const read = async (service: HostProcessService, options = {}) => {
      const child = await service.spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({home:process.env.KIKI_HOME??null,vendor:process.env.KIMI_CODE_HOME}))'], options);
      const value = JSON.parse(await collect(child.stdout));
      expect(await child.wait()).toBe(0);
      return value;
    };
    try {
      expect(await read(first)).toEqual({ home: 'space A', vendor: 'vendor-kimi' });
      expect(await read(second)).toEqual({ home: 'space B', vendor: 'vendor-kimi' });
      expect(await read(first, { env: { KIKI_HOME: 'explicit' } })).toEqual({ home: 'explicit', vendor: 'vendor-kimi' });
      expect(await read(first, { envUnset: ['KIKI_HOME'] })).toEqual({ home: null, vendor: 'vendor-kimi' });
      if (process.platform === 'win32') expect(await read(first, { env: { kiki_home: 'case override' } })).toEqual({ home: 'case override', vendor: 'vendor-kimi' });
      expect(process.env['KIKI_HOME']).toBe('ambient-main');
    } finally {
      vi.unstubAllEnvs();
      await first.dispose();
      await second.dispose();
    }
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
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
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
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
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
  let root: EventEmitter;
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
        else {
          root = child;
          queueMicrotask(() => child.emit('spawn'));
        }
        return child;
      },
    }));
    vi.doMock('#/os/backends/node-local/windowsCommandLine', async (importOriginal) => ({
      ...(await importOriginal<typeof import('#/os/backends/node-local/windowsCommandLine')>()),
      prepareWindowsSpawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => ({ command, args, options }),
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
    vi.doUnmock('#/os/backends/node-local/windowsCommandLine');
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

  it.each([false, true])('preserves taskkill 128 when root exit was observed=%s because descendants may survive', async (exited) => {
    const proc = await service.spawn('node', ['-e', 'owned-test']);
    const pending = proc.kill();
    const check = expect(pending).rejects.toMatchObject({
      code: 'os.process.kill_failed',
      details: { cleanupComplete: false, phase: 'terminate', pid: proc.pid, exitCode: 128 },
    });
    if (exited) {
      root.emit('exit', 0);
      expect(await proc.wait()).toBe(0);
    }
    killer.emit('close', 128);
    await check;
    expect(vi.getTimerCount()).toBe(0);
    await proc.dispose();
  });

  it('preserves taskkill EPERM even if the root exits during cleanup', async () => {
    const proc = await service.spawn('node', ['-e', 'owned-test']);
    const denied = Object.assign(new Error('access denied'), { code: 'EPERM' });
    const pending = proc.kill();
    const check = expect(pending).rejects.toMatchObject({
      code: 'os.process.kill_failed',
      details: { cleanupComplete: false, phase: 'control', pid: proc.pid },
      cause: denied,
    });
    root.emit('exit', 0);
    killer.emit('error', denied);
    await check;
    expect(vi.getTimerCount()).toBe(0);
    await proc.dispose();
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
  let legacyHelper: string;
  let previousProtocolHelper: string;
  let unknownReleaseExitHelper: string;
  let deadPipeReleaseHelper: string;
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
    const legacySource = join(directory, 'legacy.cs');
    legacyHelper = join(directory, 'legacy.exe');
    await writeFile(legacySource, canonical.replace('if (launch.Length != 4 && !ownerLifetime)', 'if (launch.Length != 4)'));
    await promisify(execFile)(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/platform:anycpu', `/out:${legacyHelper}`, legacySource], { timeout: 30_000, windowsHide: true });
    const compileFixture = async (name: string, sourceText: string): Promise<string> => {
      const fixtureSource = join(directory, `${name}.cs`);
      const fixtureHelper = join(directory, `${name}.exe`);
      await writeFile(fixtureSource, sourceText);
      await promisify(execFile)(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', '/platform:anycpu', `/out:${fixtureHelper}`, fixtureSource], { timeout: 30_000, windowsHide: true });
      return fixtureHelper;
    };
    previousProtocolHelper = await compileFixture('previous-protocol', canonical.replace(' + ":release-exit-v2"', '').replace('return releaseCompleted ? 0 : UnreleasedExit;', 'return 0;'));
    unknownReleaseExitHelper = await compileFixture('unknown-release-exit', canonical.replace('return releaseCompleted ? 0 : UnreleasedExit;', 'return 1;'));
    deadPipeReleaseHelper = await compileFixture('dead-pipe-release', canonical.replace('Send(writer, "released")', 'throw new IOException("injected release ack failure")'));
    await writeFile(join(directory, 'owner.mjs'), `
      import { HostProcessService } from ${JSON.stringify(new URL('../../../../src/os/backends/node-local/hostProcessService.ts', import.meta.url).href)};
      const service = new HostProcessService();
      const proc = await service.spawn(process.execPath, ['-e', process.argv[2]], { ownedProcessTree: true, ownedProcessLifetime: 'owner' });
      proc.stdin.end(); await proc.wait(); await proc.dispose();
      console.log(JSON.stringify({ helper: proc.child.pid, root: proc.pid }));
      setInterval(()=>{}, 1000);
    `);
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

  it('resolves a bare node executable for an owned Host launch', async () => {
    const proc = await spawnOwned('node', ['-e', 'process.stdout.write(process.version)'], { env: { Path: dirname(process.execPath) } });
    expect(await collect(proc.stdout)).toBe(process.version);
    expect(await proc.wait()).toBe(0);
  });

  it.each(['cmd', 'bat'])('launches a %s shim through the owned Host path with literal arguments', async (extension) => {
    const bin = join(directory, 'bin & shims');
    await mkdir(bin, { recursive: true });
    const shim = join(bin, `host launcher.${extension}`);
    const script = join(directory, 'argv fixture.cjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify([process.cwd(),process.env.HOST_LAUNCH_VALUE,process.argv.slice(2)]));');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const args = ['two words', 'say "hello" & echo INJECTED', 'trailing\\', '', 'a&b', '^()<>|', '%HOST_LAUNCH_VALUE%', '!HOST_LAUNCH_VALUE!', 'backslash\\"quote', '中文'];
    for (const ownedProcessTree of [true, false]) {
      for (const invalid of ['line1\nline2', 'line1\rline2', '\0']) {
        await expect(svc.spawn(shim, [invalid], { ownedProcessTree })).rejects.toMatchObject({
          code: 'os.process.spawn_failed', details: { errno: 'EINVAL', phase: 'arguments', argumentIndex: 0 },
        });
      }
      const proc = await svc.spawn('host launcher', args, {
        ownedProcessTree, cwd: directory, env: { Path: 'bin & shims', pathext: `.${extension}`, HOST_LAUNCH_VALUE: 'EXPANDED' },
      });
      owned.push(proc);
      expect(await collect(proc.stdout)).toBe(JSON.stringify([directory, 'EXPANDED', args]));
      expect(await proc.wait()).toBe(0);
      await proc.dispose();
    }
  });

  it('resolves bare executables from PATH before cwd while preserving explicit paths and Windows env overrides', async () => {
    const bin = join(directory, 'binary path');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'fixture.exe');
    await copyFile(process.execPath, executable);
    await writeFile(join(directory, 'fixture.cmd'), '@echo off\r\necho CWD_SHADOW\r\n');
    const args = ['-e', 'process.stdout.write(JSON.stringify([process.cwd(),process.env.HOST_CASE_TEST,process.env.HOST_REMOVE_TEST,process.argv.slice(1)]));', 'space "quoted" & literal'];
    vi.stubEnv('HOST_CASE_TEST', 'inherited');
    vi.stubEnv('HOST_REMOVE_TEST', 'remove');
    for (const command of ['fixture', executable, relative(directory, executable)]) {
      const proc = await spawnOwned(command, args, {
        cwd: directory,
        env: { Path: '"binary path"', PaThExT: '.CMD;.EXE', host_case_test: 'overridden' },
        envUnset: ['host_remove_test'],
      });
      expect(await collect(proc.stdout)).toBe(JSON.stringify([directory, 'overridden', undefined, [args[2]]]));
      expect(await proc.wait()).toBe(0);
    }
    await expect(spawnOwned('fixture', args, { cwd: bin, env: { Path: '', PATHEXT: '.EXE' } })).rejects.toMatchObject({
      code: 'os.process.spawn_failed', details: { command: 'fixture', errno: 'ENOENT', phase: 'resolve' },
    });
    const local = await spawnOwned('.\\fixture', args, { cwd: bin, env: { Path: '', PATHEXT: '.EXE' } });
    expect(await collect(local.stdout)).toBe(JSON.stringify([bin, 'inherited', 'remove', [args[2]]]));
    expect(await local.wait()).toBe(0);
    const explicit = await spawnOwned('.\\fixture.cmd', [], { cwd: directory, env: { Path: '' } });
    expect((await collect(explicit.stdout)).trim()).toBe('CWD_SHADOW');
    expect(await explicit.wait()).toBe(0);
  });

  it('reports ENOENT before launching a helper when an owned command is missing', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(spawnOwned('missing-owned-command')).rejects.toMatchObject({
        code: 'os.process.spawn_failed', details: { command: 'missing-owned-command', errno: 'ENOENT', phase: 'resolve' }, cause: { code: 'ENOENT' },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });

  it('cancels descendants of a PATH-resolved cmd shim through Job ownership', async () => {
    const file = join(directory, 'shim-tree-pids.txt');
    const shim = join(directory, 'resident.cmd');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${join(directory, 'tree.cjs')}" %*\r\n`);
    const proc = await spawnOwned('resident', [file], { env: { Path: directory }, ownedProcessLifetime: 'owner' });
    proc.stdin.end();
    await vi.waitFor(async () => { expect((await readPids(file)).length).toBe(4); }, { timeout: 3_000 });
    const pids = await readPids(file);
    const helperPid = (proc as unknown as { child: { pid: number } }).child.pid;
    const taskId = tasks.registerTask(new ProcessTask(proc, 'resident', 'shim cancel'), { detached: true });
    expect((await tasks.stop(taskId, 'TaskStop'))?.status).toBe('killed');
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(proc.pid)).toBe(false);
    expect(alive(helperPid)).toBe(false);
  });

  it('round-trips near-end MCP stdio through LocalRuntime with bare node and a PATH cmd shim', async () => {
    const bin = join(directory, 'mcp launchers');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'fixture-launch.cmd'), `@echo off\r\n"${process.execPath}" %*\r\n`);
    await writeFile(join(directory, 'node.cmd'), '@echo off\r\necho CWD_SHADOW\r\n');
    const fixture = fileURLToPath(new URL('../../../mcpCore/fixtures/cwd-stdio-server.mjs', import.meta.url));
    const runtime = new LocalRuntime('host-launch', {
      _serviceBrand: undefined, osKind: 'Windows', osArch: process.arch, osVersion: 'fixture',
      shellName: 'bash', shellPath: 'C:/Program Files/Git/bin/bash.exe', pathClass: 'win32', homeDir: directory, ready: Promise.resolve(),
    }, undefined, svc, undefined, undefined);
    const spawn = vi.spyOn(svc, 'spawn');
    try {
      for (const command of ['node', 'fixture-launch']) {
        const client = new StdioMcpClient({
          transport: 'stdio', command, args: [fixture], env: { Path: `${bin};${dirname(process.execPath)}` },
        }, {
          workspaceId: 'host-launch', runtimeId: 'local', defaultCwd: directory,
          runtimeResolver: {
            _serviceBrand: undefined, inspect: () => runtime,
            acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
          },
        });
        let child: IHostProcess | undefined;
        try {
          await client.connect();
          expect((await client.listTools()).map((tool) => tool.name)).toEqual(['get_cwd', 'get_home']);
          expect((await client.callTool('get_cwd', {})).content).toEqual([{ type: 'text', text: directory }]);
          child = await spawn.mock.results.at(-1)!.value;
          expect(alive(child!.pid)).toBe(true);
        } finally { await client.close(); }
        expect(alive(child!.pid)).toBe(false);
        expect(alive((child as unknown as { child: { pid: number } }).child.pid)).toBe(false);
      }
    } finally { spawn.mockRestore(); runtime.dispose(); }
  });

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

  it.each([true, 'C:/Program Files/Git/bin/bash.exe'])('preserves shell syntax, quoted paths, argv, env and stdin with owned shell=%s', async (shell) => {
    const script = join(directory, 'shell fixture.cjs');
    await writeFile(script, 'let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify([process.cwd(),process.env.TREE_TEST,process.argv.slice(2),input]));process.stderr.write("shell stderr");process.exitCode=23;});');
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
    const proc = await spawnOwned(command, ['"two words"'], { shell, cwd: directory, env: { TREE_TEST: 'owned shell' } });
    const stdout = collect(proc.stdout);
    const stderr = collect(proc.stderr);
    proc.stdin.end('input');
    expect(await proc.wait()).toBe(23);
    expect(await stdout).toBe(JSON.stringify([directory, 'owned shell', ['two words'], 'input']));
    expect(await stderr).toBe('shell stderr');
    await proc.dispose();
  });

  it.each(['racing', 'exited'])('settles concurrent and repeated Job kills for a %s shell root', async (state) => {
    const script = join(directory, 'exit fixture.cjs');
    await writeFile(script, 'process.stdin.once("data",()=>process.exit(0));process.stdout.write("ready");');
    const proc = await spawnOwned(`"${process.execPath}" "${script}"`, [], { shell: true });
    await new Promise<void>((resolve) => proc.stdout.once('data', () => resolve()));
    proc.stdin.end('exit');
    if (state === 'exited') expect(await proc.wait()).toBe(0);
    else expect(proc.exitCode).toBeNull();
    await Promise.all([proc.kill(), proc.kill()]);
    expect([0, 1]).toContain(await proc.wait());
    expect(alive(proc.pid)).toBe(false);
    await expect(proc.kill()).resolves.toBeUndefined();
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

  it('settles completed owner-lifetime tasks promptly, then App disposal reaps residents and active trees only', async () => {
    const file = join(directory, 'owner-residents.txt');
    const sentinel = await svc.spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)']);
    owned.push(sentinel);
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command], { ownedProcessLifetime: 'owner' });
    proc.stdin.end();
    const taskId = tasks.registerTask(new ProcessTask(proc, command, 'owner resident'), { detached: true });
    const result = await tasks.wait(taskId, 2_000);
    expect(result?.status).toBe('completed');
    expect(proc.exitCode).toBe(0);
    const pids = await readPids(file);
    expect(pids.filter(alive).length).toBe(3);
    await Promise.all([proc.dispose(), proc.dispose()]);
    const active = await spawnOwned(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { ownedProcessLifetime: 'owner' });
    await disposables.dispose();
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(active.pid)).toBe(false);
    expect(alive(sentinel.pid)).toBe(true);
    await proc.dispose();
    await expect(proc.kill()).resolves.toBeUndefined();
    await expect(svc.spawn(process.execPath)).rejects.toMatchObject({ code: 'os.process.spawn_failed', details: { phase: 'owner' } });
  });

  it('reclaims the helper and owner entry when retained descendants naturally empty their Job', async () => {
    const completed = join(directory, 'short-resident-completed.txt');
    const leafScript = `process.stdout.write('ready');setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(completed)},'natural exit');},800);`;
    const rootScript = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leafScript)}],{stdio:['ignore','pipe','ignore'],detached:true});child.stdout.once('data',()=>{process.stdout.write(String(child.pid));process.exit(0);});`;
    const sentinel = await svc.spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)']);
    owned.push(sentinel);
    const proc = await spawnOwned(process.execPath, ['-e', rootScript], { ownedProcessLifetime: 'owner' });
    const leaf = Number(await collect(proc.stdout));
    const helperPid = (proc as unknown as { child: { pid: number } }).child.pid;
    const retained = (svc as unknown as { ownedTrees: ReadonlySet<unknown> }).ownedTrees;
    expect(await proc.wait()).toBe(0);
    await proc.dispose();
    expect(alive(leaf)).toBe(true);
    expect(alive(helperPid)).toBe(true);
    expect(retained.has(proc)).toBe(true);
    await vi.waitFor(async () => { expect(await readFile(completed, 'utf8')).toBe('natural exit'); }, { timeout: 2_000 });
    await vi.waitFor(() => {
      expect(alive(leaf)).toBe(false);
      expect(alive(helperPid)).toBe(false);
      expect(retained.has(proc)).toBe(false);
    }, { timeout: 2_000 });
    expect(alive(sentinel.pid)).toBe(true);
    await Promise.all([proc.dispose(), proc.kill(), proc.kill()]);
  });

  it('preserves owner shutdown failure diagnostics and retries all retained Jobs', async () => {
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', failingKillHelper);
    const proc = await spawnOwned(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { ownedProcessLifetime: 'owner' });
    const service = svc as HostProcessService;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(service.dispose()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { phase: 'terminate', cleanupComplete: false, win32Error: 5 } });
      expect(alive(proc.pid)).toBe(true);
    }
    await Promise.all([service.dispose(), service.dispose()]);
    expect(alive(proc.pid)).toBe(false);
    await proc.dispose();
  });

  it('retains a failed owner release for retry after successful tree termination', async () => {
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', failingReleaseHelper);
    const proc = await spawnOwned(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { ownedProcessLifetime: 'owner' });
    const service = svc as HostProcessService;
    await expect(service.dispose()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { phase: 'release', cleanupComplete: false, win32Error: 5 } });
    expect(alive(proc.pid)).toBe(false);
    await service.dispose();
    await proc.dispose();
  });

  it('closes launch admission and reaps an owner tree launched concurrently with App disposal', async () => {
    const pending = spawnOwned(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { ownedProcessLifetime: 'owner' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'os.process.spawn_failed', details: { phase: 'owner' } });
    await (svc as HostProcessService).dispose();
    await rejected;
  });

  it('rejects owner lifetime without a Job and with an old helper while preserving legacy process mode', async () => {
    await expect(svc.spawn(process.execPath, [], { ownedProcessLifetime: 'owner' })).rejects.toMatchObject({ code: 'os.process.spawn_failed', details: { phase: 'owner' } });
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', legacyHelper);
    await expect(spawnOwned(process.execPath, [], { ownedProcessLifetime: 'owner' })).rejects.toMatchObject({ code: 'os.process.spawn_failed', details: { phase: 'launch' } });
    const proc = await spawnOwned(process.execPath, ['-e', 'process.exit(0)']);
    expect(await proc.wait()).toBe(0);
    await proc.dispose();
  });

  it('reaps retained residents and the helper when their backend owner crashes and closes its control pipe', async () => {
    const file = join(directory, 'crash-residents.txt');
    const script = `const {spawn}=require('node:child_process');spawn(process.execPath,[${JSON.stringify(join(directory, 'tree.cjs'))},${JSON.stringify(file)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>process.exit(0),400);`;
    const parent = await svc.spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(directory, 'owner.mjs'), script]);
    owned.push(parent);
    const diagnostic = collect(parent.stderr);
    let output = '';
    parent.stdout.on('data', (chunk) => { output += String(chunk); });
    await vi.waitFor(() => { expect(output, 'owner should report ready; parent exit=' + parent.exitCode).toContain('helper'); }, { timeout: 5_000 });
    const identities = JSON.parse(output.trim()) as { helper: number; root: number };
    const pids = await readPids(file);
    expect(alive(identities.root)).toBe(false);
    expect(alive(identities.helper)).toBe(true);
    expect(pids.filter(alive).length).toBe(3);
    process.kill(parent.pid, 'SIGKILL');
    await parent.wait();
    expect(await diagnostic).toBe('');
    await vi.waitFor(() => {
      expect(alive(identities.helper)).toBe(false);
      expect(pids.filter(alive)).toEqual([]);
    }, { timeout: 3_000 });
  }, 10_000);

  it('normal completion releases the job without killing resident descendants', async () => {
    const file = join(directory, 'resident-pids.txt');
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    try {
      await proc.dispose();
      expect((proc as unknown as { child: { exitCode: number | null } }).child.exitCode).toBe(0);
      expect(pids.filter(alive).length).toBe(3);
      await expect(proc.kill()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control' } });
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await vi.waitFor(() => { expect(pids.filter(alive)).toEqual([]); });
    }
  });

  it('completes an exited command once its unreleased helper closed the Job after control EPIPE, without writing the destroyed pipe', async () => {
    const proc = await spawnOwned(process.execPath, ['-e', 'process.exit(0)']);
    expect(await proc.wait()).toBe(0);
    const control = (proc as unknown as { control: { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean; destroy: () => void } }).control;
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    let writes = 0;
    vi.spyOn(control, 'write').mockImplementation((chunk, cb) => {
      writes += 1;
      if (writes === 1) {
        cb?.(epipe);
        queueMicrotask(() => control.destroy());
        return false;
      }
      throw new Error(`control write after EPIPE (${String(chunk)})`);
    });
    const helper = (proc as unknown as { child: { pid?: number; exitCode: number | null } }).child;
    const taskId = tasks.registerTask(new ProcessTask(proc, 'ffprobe', 'media info'), { detached: true });
    await vi.waitFor(() => {
      expect(helper.exitCode).toBe(6);
      expect(tasks.getTask(taskId)).toMatchObject({ status: 'completed', exitCode: 0 });
      expect(tasks.getTask(taskId)?.endedAt).toEqual(expect.any(Number));
    }, { timeout: 5_000 });
    expect(alive(helper.pid!)).toBe(false);
    expect(writes).toBe(1);
    expect((await tasks.stop(taskId))?.status).toBe('completed');
    expect((await tasks.stop(taskId))?.status).toBe('completed');
    expect(writes).toBe(1);
  }, 15_000);

  it('confirms termination of retained descendants when the unreleased helper closes their Job, and TaskStop then succeeds', async () => {
    const file = join(directory, 'unreleased-close-pids.txt');
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    expect(pids.filter(alive).length).toBe(3);
    const raw = proc as unknown as { control: { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean; destroy: () => void }; child: { pid?: number; exitCode: number | null } };
    let writes = 0;
    vi.spyOn(raw.control, 'write').mockImplementation((chunk, cb) => {
      writes += 1;
      if (writes > 1) throw new Error(`control write after EPIPE (${String(chunk)})`);
      cb?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      queueMicrotask(() => raw.control.destroy());
      return false;
    });
    const taskId = tasks.registerTask(new ProcessTask(proc, command, 'release write lost'), { detached: true });
    try {
      await vi.waitFor(() => {
        expect(raw.child.exitCode).toBe(6);
        expect(tasks.getTask(taskId)).toMatchObject({ status: 'completed', exitCode: 0 });
      }, { timeout: 5_000 });
      await vi.waitFor(() => { expect(pids.filter(alive)).toEqual([]); }, { timeout: 5_000 });
      expect((await tasks.stop(taskId))?.status).toBe('completed');
      await expect(proc.kill()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { phase: 'control' } });
      expect(writes).toBe(1);
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 15_000);

  const dropReleaseAck = async (file: string): Promise<{
    proc: IHostProcess;
    pids: number[];
    taskId: string;
    writes: { count: number };
    dropped: { released: number };
    held: Array<(error?: Error | null) => void>;
    helper: { pid?: number; exitCode: number | null };
  }> => {
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    expect(pids.filter(alive).length).toBe(3);
    const raw = proc as unknown as {
      control: {
        write: (chunk: string, cb?: (error?: Error | null) => void) => boolean;
        on: (event: 'data', listener: (chunk: string) => void) => void;
        listeners: (event: 'data') => Array<(chunk: string) => void>;
        removeAllListeners: (event: 'data') => void;
      };
      child: { pid?: number; exitCode: number | null };
    };
    const control = raw.control;
    const deliver = control.write.bind(control);
    const listeners = control.listeners('data');
    const dropped = { released: 0 };
    let pending = '';
    control.removeAllListeners('data');
    control.on('data', (chunk) => {
      pending += String(chunk);
      let newline: number;
      let kept = '';
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim() === 'released') {
          dropped.released += 1;
          continue;
        }
        kept += `${line}\n`;
      }
      if (kept.length === 0) return;
      for (const listener of listeners) listener.call(control, kept);
    });
    const writes = { count: 0 };
    const held: Array<(error?: Error | null) => void> = [];
    vi.spyOn(control, 'write').mockImplementation((chunk, cb) => {
      writes.count += 1;
      if (writes.count > 1) throw new Error(`control write after release attempt (${String(chunk)})`);
      if (cb !== undefined) held.push(cb);
      return deliver(chunk, () => {});
    });
    const taskId = tasks.registerTask(new ProcessTask(proc, 'ffprobe', 'media info'), { detached: true });
    return { proc, pids, taskId, writes, dropped, held, helper: raw.child };
  };

  it('confirms release from the helper exit code when the wire ack is lost and keeps residents', async () => {
    const run = await dropReleaseAck(join(directory, 'release-exit-confirmed.txt'));
    try {
      await vi.waitFor(() => {
        expect(run.helper.exitCode).toBe(0);
        expect(tasks.getTask(run.taskId)).toMatchObject({ status: 'completed', exitCode: 0 });
        expect(tasks.getTask(run.taskId)?.endedAt).toEqual(expect.any(Number));
      });
      expect(run.dropped.released).toBe(1);
      expect(run.writes.count).toBe(1);
      expect(run.pids.filter(alive).length).toBe(3);
      for (const callback of run.held) callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      expect(tasks.getTask(run.taskId)?.status).toBe('completed');
      await expect(run.proc.kill()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control' } });
      expect(run.writes.count).toBe(1);
      expect(run.pids.filter(alive).length).toBe(3);
    } finally {
      for (const pid of run.pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 15_000);

  it('confirms release when the helper throws IOException while sending the acknowledgement', async () => {
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', deadPipeReleaseHelper);
    const file = join(directory, 'dead-pipe-release.txt');
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    expect(pids.filter(alive).length).toBe(3);
    const raw = proc as unknown as { control: { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean }; child: { exitCode: number | null } };
    const deliver = raw.control.write.bind(raw.control);
    let writes = 0;
    vi.spyOn(raw.control, 'write').mockImplementation((chunk, cb) => {
      writes += 1;
      if (writes > 1) throw new Error(`control write after release (${String(chunk)})`);
      return deliver(chunk, cb);
    });
    const taskId = tasks.registerTask(new ProcessTask(proc, 'ffprobe', 'media info'), { detached: true });
    try {
      await vi.waitFor(() => {
        expect(raw.child.exitCode).toBe(0);
        expect(tasks.getTask(taskId)).toMatchObject({ status: 'completed', exitCode: 0 });
      });
      expect(writes).toBe(1);
      expect(pids.filter(alive).length).toBe(3);
      await expect(proc.kill()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control' } });
      expect((await tasks.stop(taskId))?.status).toBe('completed');
      expect((await tasks.stop(taskId))?.status).toBe('completed');
      expect(writes).toBe(1);
      expect(pids.filter(alive).length).toBe(3);
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 15_000);

  it('does not confirm release from an older helper exit or an unknown exit code', async () => {
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', previousProtocolHelper);
    const older = await dropReleaseAck(join(directory, 'old-helper-ack-lost.txt'));
    try {
      await vi.waitFor(() => {
        expect(older.helper.exitCode).toBe(0);
        expect(tasks.getTask(older.taskId)).toMatchObject({ status: 'running', exitCode: 0, endedAt: null });
        expect(tasks.getTask(older.taskId)?.stopReason).toContain('"cleanupComplete":false');
      });
      expect(older.dropped.released).toBe(1);
      expect(older.pids.filter(alive).length).toBe(3);
      for (const callback of older.held) callback();
      await expect(older.proc.kill()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control' } });
      expect(tasks.getTask(older.taskId)?.status).toBe('running');
      expect(older.writes.count).toBe(1);
    } finally {
      for (const pid of older.pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', unknownReleaseExitHelper);
    const unknown = await dropReleaseAck(join(directory, 'unknown-release-exit.txt'));
    try {
      await vi.waitFor(() => {
        expect(unknown.helper.exitCode).toBe(1);
        expect(tasks.getTask(unknown.taskId)).toMatchObject({ status: 'running', exitCode: 0, endedAt: null });
        expect(tasks.getTask(unknown.taskId)?.stopReason).toContain('"cleanupComplete":false');
      });
      expect(unknown.dropped.released).toBe(1);
      expect(unknown.pids.filter(alive).length).toBe(3);
      await expect(unknown.proc.kill()).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control' } });
      expect(tasks.getTask(unknown.taskId)?.status).toBe('running');
      expect(unknown.writes.count).toBe(1);
    } finally {
      for (const pid of unknown.pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);

  it('does not confirm release when the helper is killed before its exit proof', async () => {
    const file = join(directory, 'kill-before-ack.txt');
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    expect(pids.filter(alive).length).toBe(3);
    const raw = proc as unknown as { control: { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean }; child: { pid?: number; exitCode: number | null } };
    const helperPid = raw.child.pid;
    expect(helperPid).toEqual(expect.any(Number));
    let writes = 0;
    vi.spyOn(raw.control, 'write').mockImplementation((chunk, cb) => {
      writes += 1;
      if (writes > 1) throw new Error(`control write after kill (${String(chunk)})`);
      process.kill(helperPid!, 'SIGKILL');
      cb?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      return false;
    });
    const taskId = tasks.registerTask(new ProcessTask(proc, 'ffprobe', 'media info'), { detached: true });
    try {
      await vi.waitFor(() => {
        expect(alive(helperPid!)).toBe(false);
        expect(raw.child.exitCode).not.toBe(0);
        expect(tasks.getTask(taskId)).toMatchObject({ status: 'running', exitCode: 0, endedAt: null });
        expect(tasks.getTask(taskId)?.stopReason).toContain('"cleanupComplete":false');
      });
      expect(writes).toBe(1);
      await expect(tasks.stop(taskId)).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control', controlClosed: true } });
      await expect(tasks.stop(taskId)).rejects.toMatchObject({ code: 'os.process.kill_failed', details: { cleanupComplete: false, phase: 'control', controlClosed: true } });
      expect(writes).toBe(1);
      expect(tasks.getTask(taskId)?.status).toBe('running');
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 15_000);

  it('finishes kill and retain through the job when the helper exits before any release', async () => {
    const commandFor = (file: string): string => `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const open = async (file: string, owner: boolean): Promise<{ proc: IHostProcess; pids: number[]; writes: { count: number } }> => {
      const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', commandFor(file)], owner ? { ownedProcessLifetime: 'owner' } : {});
      proc.stdin.end();
      expect(await proc.wait()).toBe(0);
      const pids = await readPids(file);
      expect(pids.filter(alive).length).toBe(3);
      const control = (proc as unknown as { control: { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean; destroy: () => void } }).control;
      const writes = { count: 0 };
      vi.spyOn(control, 'write').mockImplementation(() => {
        writes.count += 1;
        throw new Error('unexpected control write');
      });
      control.destroy();
      return { proc, pids, writes };
    };
    const killed = await open(join(directory, 'never-release.txt'), false);
    try {
      const helperPid = (killed.proc as unknown as { child: { pid?: number } }).child.pid;
      await vi.waitFor(async () => { await killed.proc.kill(); }, { timeout: 5_000 });
      expect(alive(helperPid!)).toBe(false);
      expect(killed.writes.count).toBe(0);
      await vi.waitFor(() => { expect(killed.pids.filter(alive)).toEqual([]); }, { timeout: 5_000 });
      await killed.proc.dispose();
      expect(killed.writes.count).toBe(0);
    } finally {
      for (const pid of killed.pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    const retained = await open(join(directory, 'never-retain.txt'), true);
    try {
      const helperPid = (retained.proc as unknown as { child: { pid?: number } }).child.pid;
      await vi.waitFor(async () => { await retained.proc.dispose(); }, { timeout: 5_000 });
      expect(alive(helperPid!)).toBe(false);
      expect(retained.writes.count).toBe(0);
      await vi.waitFor(() => { expect(retained.pids.filter(alive)).toEqual([]); }, { timeout: 5_000 });
    } finally {
      for (const pid of retained.pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);

  it('does not treat root exit as a clean tree while a job descendant is still alive', async () => {
    const file = join(directory, 'live-descendant.txt');
    const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(join(directory, 'tree.cjs').replaceAll('\\', '/'))} ${quote(file.replaceAll('\\', '/'))} >/dev/null 2>&1 & sleep 0.4`;
    const proc = await spawnOwned('C:/Program Files/Git/bin/bash.exe', ['-c', command]);
    proc.stdin.end();
    expect(await proc.wait()).toBe(0);
    const pids = await readPids(file);
    expect(proc.exitCode).toBe(0);
    expect(alive(proc.pid)).toBe(false);
    expect(pids.some(alive)).toBe(true);
    await proc.kill();
    expect(pids.filter(alive)).toEqual([]);
    await proc.dispose();
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

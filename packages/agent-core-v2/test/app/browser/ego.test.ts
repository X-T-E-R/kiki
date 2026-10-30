import { PassThrough, Readable } from 'node:stream';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IBrowserControlService } from '#/app/browser/browser';
import { BrowserControlService } from '#/app/browser/browserControlService';
import { IBrowserBackendFactory } from '#/app/browser/browserBackend';
import { browserConnectionRecord, type BrowserResolvedConnection } from '#/app/browser/browserConfig';
import { BrowserError } from '#/app/browser/errors';
import type { BrowserRequestContext } from '#/app/browser/codexBrowser';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { AgentBrowserService, BrowserEgoRunTool, egoRunExecution, type IAgentBrowserService } from '#/agent/tools/browser/browserTools';
import { toolApprovalRule } from '#/agent/tools/os/sshToolTarget';
import type { Runtime } from '#/runtime/runtime';
import { egoPathHits, parseEgoUninstallExport } from '#/app/browser/ego/hints';
import {
  classifyEgoCheck, egoSpaceName, resolveEgoCli, type EgoUninstallRecord,
} from '#/app/browser/ego/resolveCli';
import { EgoBrowserRuntime, egoArgv, egoPrelude, egoProgram, egoReadyScript, egoTabBody } from '#/app/browser/ego/runtime';
import { runEgoDetectionCommand } from '#/app/browser/ego/process';

const EXE = 'ego-browser.exe';
const root = 'C:/EgoLite';
const versioned = join(root, '0.6.0.16', EXE);
const child = join(root, 'app', EXE);
const other = join('D:/Other', EXE);
const saved = join('E:/saved', EXE);

function record(patch: Partial<EgoUninstallRecord> = {}): EgoUninstallRecord {
  return { displayName: 'ego (lite)', publisher: 'Citro Labs, Inc.', installLocation: root, displayVersion: '0.6.0.16', ...patch };
}

describe('Ego Lite CLI resolution', () => {
  const exists = (files: readonly string[]) => (file: string) => files.includes(file);
  const children = () => ['app', 'unused'];

  it('prefers a saved absolute cli, then a versioned install, then one child, and asks when two paths tie', () => {
    expect(resolveEgoCli({ cliPath: saved, exists: exists([saved, versioned, other]), children, records: [record()], pathHits: [other] })).toEqual({ kind: 'found', path: saved });
    expect(resolveEgoCli({ exists: exists([versioned, child, other]), children, records: [record()], pathHits: [other] })).toEqual({ kind: 'found', path: versioned });
    expect(resolveEgoCli({ exists: exists([child]), children, records: [record({ displayVersion: undefined })], pathHits: [] })).toEqual({ kind: 'found', path: child });
    expect(resolveEgoCli({ exists: exists([child, other]), children, records: [record({ displayVersion: undefined })], pathHits: [other] })).toEqual({ kind: 'choose', paths: [child, other].sort() });
    expect(resolveEgoCli({ exists: exists([]), children: () => [], records: [record({ displayName: 'Ego Lite', publisher: 'Citro Labs' })], pathHits: [] })).toEqual({ kind: 'missing' });
    expect(resolveEgoCli({ exists: exists([versioned]), children, records: [record({ publisher: 'Other' })], pathHits: [] })).toEqual({ kind: 'missing' });
  });

  it('parses uninstall export text without a live registry', () => {
    const text = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Ego',
      '    DisplayName    REG_SZ    ego (lite)',
      '    Publisher    REG_SZ    Citro Labs',
      '    InstallLocation    REG_SZ    C:\\Ego',
      '    DisplayVersion    REG_SZ    0.6.0.16',
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other',
      '    DisplayName    REG_SZ    Something else',
      '    Publisher    REG_SZ    Citro Labs',
      '    InstallLocation    REG_SZ    C:\\Other',
    ].join('\r\n');
    expect(parseEgoUninstallExport(text)).toEqual([
      { displayName: 'ego (lite)', publisher: 'Citro Labs', installLocation: 'C:\\Ego', displayVersion: '0.6.0.16' },
    ]);
  });

  it('treats the onboarding sentence as not ready even when the marker is present', () => {
    expect(classifyEgoCheck('kiki-ego-ready')).toBe('ready');
    expect(classifyEgoCheck('Please complete the onboarding process first')).toBe('onboarding');
    expect(classifyEgoCheck('kiki-ego-ready\nPlease complete the onboarding process first')).toBe('onboarding');
    expect(classifyEgoCheck('')).toBe('not_ready');
    expect(egoSpaceName('session', 'agent').length).toBeLessThanOrEqual(80);
    expect(egoSpaceName('session', 'agent').startsWith('kiki-')).toBe(true);
  });
});

function memoryFs(present: readonly string[]) {
  const files = new Map<string, string>();
  const known = new Set(present);
  const fs = {
    readText: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    writeText: async (path: string, data: string) => { files.set(path, data); },
    stat: async (path: string) => ({ isFile: known.has(path) || files.has(path), isDirectory: false, size: 0 }),
    readdir: async () => [],
    mkdir: async () => undefined,
    remove: async () => undefined,
  } satisfies Partial<IHostFileSystem>;
  return { files, fs: fs as unknown as IHostFileSystem };
}

function release(kill: ReturnType<typeof vi.fn> | undefined): void {
  if (kill !== undefined) void (kill as unknown as () => void)();
}

function scripted(handler: (command: string, args: readonly string[]) => { code?: number; stdout?: string; stderr?: string; hang?: boolean }) {
  const calls: { command: string; args: readonly string[]; options?: { shell?: boolean; windowsHide?: boolean; timeout?: number } }[] = [];
  const kills: ReturnType<typeof vi.fn>[] = [];
  let active = 0;
  let maxActive = 0;
  const spawn = vi.fn(async (command: string, args: readonly string[] = [], options?: { shell?: boolean; windowsHide?: boolean; timeout?: number }) => {
    calls.push({ command, args, options });
    const plan = handler(command, args);
    active += 1;
    maxActive = Math.max(maxActive, active);
    let settle: (code: number) => void = () => undefined;
    const kill = vi.fn(async () => { settle(1); });
    kills.push(kill);
    const wait = plan.hang === true ? new Promise<number>((resolve) => { settle = (code) => { active -= 1; resolve(code); }; }) : Promise.resolve(plan.code ?? 0).finally(() => { active -= 1; });
    return {
      pid: 1, exitCode: null, stdin: Readable.from([]),
      stdout: Readable.from([plan.stdout ?? '']), stderr: Readable.from([plan.stderr ?? '']),
      wait: () => wait, kill, dispose: async () => undefined,
    };
  });
  return { spawn, calls, kills, max: () => maxActive, service: { spawn } as unknown as IHostProcessService };
}

function marked(spaceId: string, closed = false, extra = ''): string {
  return `KIKI_EGO_PRELUDE ${JSON.stringify({ spaceId, name: 'kept', closed: false })}\n${extra}KIKI_EGO_FINISH ${JSON.stringify({ spaceId, closed })}\n`;
}

const connection = { id: 'ego-lite', type: 'ego-lite' as const, name: 'Ego Lite', enabled: true, cliPath: versioned, serverName: 'desk' };

describe('Ego Lite runtime', () => {
  it('writes a quoted prelude and retries a rejected sdk path once', async () => {
    const label = 'p"1\n;break';
    const source = egoProgram({ name: 'kiki-a', connectionId: 'ego-lite', label, profileId: 'pro"file' }, 'console.log("body")');
    const bound = { name: 'kiki-a', connectionId: 'ego-lite', label, profileId: 'pro"file' };
    expect(source.startsWith(`const __kikiBound = JSON.parse(${JSON.stringify(JSON.stringify(bound))});\nconst task = await taskSpace(__kikiBound.name, { profileId: __kikiBound.profileId });\nconst page = task.page(__kikiBound.label);`)).toBe(true);
    const resumed = egoPrelude({ ...bound, spaceId: '7' });
    expect(resumed).toContain('const task = await taskSpace(__kikiBound.spaceId ?? __kikiBound.name);');
    expect(resumed).not.toContain('{ profileId:');
    expect(egoTabBody('open')).toContain('const opened = await task.newPage();');
    expect(egoTabBody('open')).toContain('if (__kikiBound.url) await opened.goto(__kikiBound.url);');
    expect(egoTabBody('open')).not.toContain('newPage(__kikiBound.url)');
    expect(source).toContain('console.log("body")');
    expect(source.indexOf('console.log("body")')).toBeGreaterThan(source.indexOf('const page = task.page'));
    expect(egoReadyScript()).toBe('console.log("kiki-ego-ready");\n');
    expect(egoReadyScript()).not.toContain('taskSpace');
    const sdk = join(root, 'sdk.js');
    expect(egoArgv(connection.serverName, 'C:/script.mjs', sdk)).toEqual(['--ego-server-name', 'desk', '--sdk-path', sdk, 'nodejs', '-e', expect.stringMatching(/^await import\("file:\/\//)]);
    const { files, fs } = memoryFs([versioned, sdk]);
    let seen = 0;
    const proc = scripted(() => {
      seen += 1;
      return seen === 1 ? { code: 1, stderr: 'unknown option --sdk-path' } : { code: 0, stdout: marked('space-1') };
    });
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: root, KIKI_EGO_SDK_PATH: sdk }, 'linux');
    const ran = await runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'console.log(1)' });
    expect(proc.calls).toHaveLength(2);
    expect(proc.calls[0]?.args).toContain('--sdk-path');
    expect(proc.calls[1]?.args).not.toContain('--sdk-path');
    expect(proc.calls[0]?.options).toEqual({ shell: false, windowsHide: true });
    expect(ran.binding.spaceId).toBe('space-1');
    expect(files.get(join('C:/session', 'browser-ego-spaces.json'))).toContain('space-1');
  });

  it('resumes the same space when successful native help mentions an ownership error', async () => {
    const { files, fs } = memoryFs([versioned]);
    const help = 'Reuse or create an Agent-owned task space; a name held by a user-owned space fails with EGO_TASK_SPACE_NAME_IN_USE.';
    let round = 0;
    const proc = scripted(() => ({ stdout: marked('32', false, ++round === 1 ? '' : `${help}\nEGO_TASK_SPACE_USER_IN_CONTROL\n`) }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '' }, 'linux');
    const input = { connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a' };
    const first = await runtime.runAgent({ ...input, body: 'console.log({ spaceId: task.spaceId }); help("profiles");' });
    const second = await runtime.runAgent({ ...input, body: 'console.log(await profiles()); help("taskSpace");' });
    expect(first.binding.spaceId).toBe('32');
    expect(second.binding).toEqual(first.binding);
    expect(second.result.code).toBe(0);
    expect(second.result.stdout).toContain(help);
    expect(proc.calls).toHaveLength(2);
    const scripts = [...files.values()].filter((value) => value.startsWith('const __kikiBound'));
    expect(scripts[1]).toContain(JSON.stringify(JSON.stringify({ spaceId: '32', name: egoSpaceName('s', 'a'), connectionId: connection.id })));
    expect(scripts[1]).not.toContain('claimTaskSpace');
  });

  it('does not replay an entered script when its failure mentions a rejected sdk option', async () => {
    const sdk = join(root, 'sdk.js');
    const { fs } = memoryFs([versioned, sdk]);
    const proc = scripted(() => ({ code: 1, stdout: 'KIKI_EGO_PRELUDE {"spaceId":32}\n', stderr: 'Error: unknown option --sdk-path from script' }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '', KIKI_EGO_SDK_PATH: sdk }, 'linux');
    const ran = await runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'throw new Error("unknown option --sdk-path from script");' });
    expect(ran.result.code).toBe(1);
    expect(ran.binding.spaceId).toBe('32');
    expect(proc.calls).toHaveLength(1);
  });

  it('does not claim a name in use or a user-controlled space, and keeps a newer binding', async () => {
    const sdk = join(root, 'sdk.js');
    const { files, fs } = memoryFs([versioned, sdk]);
    const sessionDir = 'C:/session';
    const nameInUse = scripted(() => ({ code: 1, stderr: 'EGO_TASK_SPACE_NAME_IN_USE' }));
    const runtime = new EgoBrowserRuntime(nameInUse.service, fs, { PATH: '', KIKI_EGO_SDK_PATH: sdk }, 'linux');
    await expect(runtime.runAgent({ connection, sessionDir, sessionId: 's', agentId: 'a', body: 'x' })).rejects.toMatchObject({ message: 'EGO_TASK_SPACE_NAME_IN_USE' });
    expect(nameInUse.calls).toHaveLength(1);
    expect(files.has(join(sessionDir, 'browser-ego-spaces.json'))).toBe(false);
    const user = scripted(() => ({ code: 1, stdout: 'EGO_TASK_SPACE_USER_IN_CONTROL' }));
    const userRuntime = new EgoBrowserRuntime(user.service, fs, { PATH: '' }, 'linux');
    await expect(userRuntime.runAgent({ connection, sessionDir, sessionId: 's', agentId: 'a', body: 'x' })).rejects.toMatchObject({ message: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
    expect(user.calls).toHaveLength(1);
    const spaceFile = join(sessionDir, 'browser-ego-spaces.json');
    const agent = egoSpaceName('s', 'a');
    files.set(spaceFile, `${JSON.stringify({ a: { connectionId: 'ego-lite', name: agent, spaceId: 'old' } })}\n`);
    const newer = scripted(() => {
      files.set(spaceFile, `${JSON.stringify({ a: { connectionId: 'ego-lite', name: agent, spaceId: 'newer' } })}\n`);
      return { code: 0, stdout: marked('parsed', true) };
    });
    const newerRuntime = new EgoBrowserRuntime(newer.service, fs, { PATH: '' }, 'linux');
    const kept = await newerRuntime.runAgent({ connection, sessionDir, sessionId: 's', agentId: 'a', body: 'x' });
    expect(JSON.parse(files.get(spaceFile) ?? '{}')).toMatchObject({ a: { spaceId: 'newer' } });
    expect(kept.binding.spaceId).toBe('newer');
  });

  it('deletes a closed space only for the lease this call started with', async () => {
    const { files, fs } = memoryFs([versioned]);
    const sessionDir = 'C:/session';
    const spaceFile = join(sessionDir, 'browser-ego-spaces.json');
    const agent = egoSpaceName('s', 'a');
    files.set(spaceFile, `${JSON.stringify({ a: { connectionId: 'ego-lite', name: agent, spaceId: 'old' } })}\n`);
    const proc = scripted(() => ({ code: 0, stdout: marked('old', true) }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '' }, 'linux');
    await runtime.runAgent({ connection, sessionDir, sessionId: 's', agentId: 'a', body: 'x' });
    expect(JSON.parse(files.get(spaceFile) ?? '{}').a).toBeUndefined();
    files.set(spaceFile, `${JSON.stringify({ a: { connectionId: 'ego-lite', name: agent, spaceId: 'old' } })}\n`);
    const noisy = scripted(() => ({ code: 1, stdout: 'not json' }));
    const noisyRuntime = new EgoBrowserRuntime(noisy.service, fs, { PATH: '' }, 'linux');
    const failed = await noisyRuntime.runAgent({ connection, sessionDir, sessionId: 's', agentId: 'a', body: 'x' });
    expect(failed.result.code).toBe(1);
    expect(JSON.parse(files.get(spaceFile) ?? '{}')).toMatchObject({ a: { spaceId: 'old' } });
  });

  it('serializes one space and lets two spaces run together', async () => {
    const { fs } = memoryFs([versioned]);
    const proc = scripted(() => ({ hang: true, stdout: marked('space') }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '' }, 'linux');
    const first = runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'x' });
    const second = runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'b', body: 'y' });
    const third = runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'z' });
    try {
      await vi.waitFor(() => expect(proc.calls.length).toBe(2));
      expect(proc.max()).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(proc.calls.length).toBe(2);
      release(proc.kills[0]);
      await vi.waitFor(() => expect(proc.calls.length).toBe(3));
    } finally {
      proc.kills.forEach((kill) => release(kill));
      await Promise.allSettled([first, second, third]);
    }
  });

  it('reads the completed binding inside a stable queue before resuming a configured profile', async () => {
    const { files, fs } = memoryFs([versioned]);
    const proc = scripted(() => ({ hang: true, stdout: marked('32') }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '' }, 'linux');
    const input = { connection: { ...connection, profileId: 'fixture-profile' }, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'console.log(task.spaceId);' };
    const pending = [runtime.runAgent(input)];
    try {
      await vi.waitFor(() => expect(proc.calls).toHaveLength(1));
      pending.push(runtime.runAgent(input));
      await new Promise((resolve) => setTimeout(resolve, 20));
      release(proc.kills[0]);
      await pending[0];
      await vi.waitFor(() => expect(proc.calls).toHaveLength(2));
      const scripts = [...files.values()].filter((value) => value.startsWith('const __kikiBound'));
      expect(scripts[1]).toContain('\\"spaceId\\":\\"32\\"');
      expect(scripts[1]).not.toContain('{ profileId: __kikiBound.profileId }');
      pending.push(runtime.runAgent(input));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(proc.calls).toHaveLength(2);
      release(proc.kills[1]);
      await vi.waitFor(() => expect(proc.calls).toHaveLength(3));
      expect(proc.max()).toBe(1);
    } finally {
      proc.kills.forEach((kill) => release(kill));
      await Promise.allSettled(pending);
    }
  });

  it('kills only the aborted call', async () => {
    const { files, fs } = memoryFs([versioned]);
    const proc = scripted(() => ({ hang: true, stdout: marked('space-x') }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '' }, 'linux');
    const signal = new AbortController();
    const pending = runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'x', signal: signal.signal });
    await vi.waitFor(() => expect(proc.calls.length).toBe(1));
    signal.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(proc.kills[0]).toHaveBeenCalled();
    expect(files.has(join('C:/session', 'browser-ego-spaces.json'))).toBe(false);
  });

  it('reports png files written in the injected shot directory', async () => {
    const { files, fs } = memoryFs([versioned]);
    const proc = scripted(() => ({ code: 0, stdout: marked('space-1') }));
    const runtime = new EgoBrowserRuntime(proc.service, {
      ...fs,
      readdir: async () => [{ name: 'one.png', isFile: true, isDirectory: false }, { name: 'note.txt', isFile: true, isDirectory: false }],
    } as IHostFileSystem, { PATH: '' }, 'linux');
    const ran = await runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'x' });
    expect(ran.shots).toEqual([expect.stringMatching(/[\\/]one\.png$/)]);
    const script = [...files.values()].find((value) => value.includes('const shotDir'));
    expect(script).toContain('const shotDir = "');
    expect(script).not.toContain('one.png');
  });
});

describe('Ego Lite control', () => {
  it('does not open the managed backend, refuses window and frame, and leaves a running call alive when admission changes', async () => {
    const exe = versioned;
    const { fs } = memoryFs([exe]);
    let native = true;
    const configs = new Map<string, BrowserResolvedConnection>([[
      'ego-lite', { id: 'ego-lite', type: 'ego-lite', name: 'Ego Lite', enabled: true, cliPath: exe },
    ]]);
    const proc = scripted((command, args) => {
      if (args.includes('nodejs') && args.some((arg) => arg.includes('kiki-ego') || true)) {
        return { code: 0, stdout: command.includes('nope') ? '' : 'kiki-ego-ready\n' };
      }
      return { code: 0, stdout: '' };
    });
    const factory = { open: vi.fn(async () => { throw new Error('factory'); }) };
    const ix = new TestInstantiationService();
    ix.stub(IFlagService, { enabled: () => native });
    ix.stub(IHostProcessService, proc.service);
    ix.stub(IHostFileSystem, fs);
    ix.stub(IBrowserBackendFactory, factory);
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({ connections: [...configs.values()].map(({ id, name, type, enabled }) => ({ id, name, type, enabled })) }),
      resolve: async (id: string) => {
        const found = configs.get(id);
        if (found === undefined) throw new Error('missing');
        return found;
      },
      upsert: async () => { throw new Error('unused'); },
      remove: async () => undefined,
      setDefault: async () => undefined,
      revealEndpoint: async () => undefined,
    });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = ix.get(IBrowserControlService);
    const caller = { sessionId: 's', agentId: 'a' };
    const context = { caller, sessionDir: 'C:/session', turnId: 0, toolCallId: 't', elicit: async () => { throw new Error('unused'); } } satisfies BrowserRequestContext;
    try {
      await expect(control.invoke({ browser: 'ego-lite', tool: 'agent_browser_window_new', args: {}, caller })).rejects.toMatchObject({ code: 'browser.unsupported', message: expect.stringContaining('no window or frame method') });
      await expect(control.invoke({ browser: 'ego-lite', tool: 'agent_browser_frame_switch', args: {}, caller })).rejects.toMatchObject({ code: 'browser.unsupported' });
      expect(await control.catalog('ego-lite')).toEqual([]);
      expect(factory.open).not.toHaveBeenCalled();
      expect(proc.calls.some((call) => call.args.includes('nodejs'))).toBe(false);
      proc.spawn.mockImplementation(async (command: string, args: readonly string[] = [], options?: { shell?: boolean }) => {
        proc.calls.push({ command, args, options });
        const nodeIndex = proc.calls.filter((call) => call.args.includes('nodejs')).length;
        const stdout = nodeIndex === 1
          ? 'kiki-ego-ready\n'
          : `KIKI_EGO_TABS ${JSON.stringify([{ label: 'p1', title: 'One', openedBy: 'agent' }])}\n${marked('space-9')}`;
        return {
          pid: 1, exitCode: null, stdin: Readable.from([]), stdout: Readable.from([stdout]), stderr: Readable.from(['']),
          wait: async () => 0, kill: vi.fn(async () => undefined), dispose: async () => undefined,
        };
      });
      expect((await control.connect('ego-lite')).state).toBe('ready');
      expect(factory.open).not.toHaveBeenCalled();
      const tabs = await control.tabs('ego-lite', undefined, context);
      expect(tabs.map((tab) => tab.tabId)).toEqual(['p1']);
      const hung = scripted((_command, args) => args.includes('nodejs') ? { hang: true, stdout: marked('space-9') } : { code: 0, stdout: '' });
      proc.spawn.mockImplementation(hung.spawn);
      const signal = new AbortController();
      const pending = control.invoke({ browser: 'ego-lite', tool: 'browser__ego_run', args: { script: 'console.log(1)' }, caller, requestContext: context }, signal.signal);
      await vi.waitFor(() => expect(hung.calls.some((call) => call.args.includes('nodejs'))).toBe(true));
      const scriptKill = hung.kills[hung.calls.findIndex((call) => call.args.includes('nodejs'))];
      native = false;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(scriptKill).not.toHaveBeenCalled();
      const spawned = hung.calls.filter((call) => call.args.includes('nodejs')).length;
      await control.disconnect('ego-lite');
      expect(scriptKill).toHaveBeenCalledTimes(1);
      await expect(pending).rejects.toBeTruthy();
      expect(hung.calls.filter((call) => call.args.includes('nodejs')).length).toBe(spawned);
      await expect(control.invoke({ browser: 'ego-lite', tool: 'browser__ego_run', args: { script: 'next' }, caller, requestContext: context })).rejects.toMatchObject({ code: 'browser.disabled' });
      expect(browserConnectionRecord(configs.get('ego-lite')!)).toEqual({ id: 'ego-lite', name: 'Ego Lite', enabled: true, type: 'ego-lite', cliPath: exe, profileId: undefined, serverName: undefined });
      expect(browserConnectionRecord(configs.get('ego-lite')!)).not.toHaveProperty('endpointDisplay');
    } finally { await ix.dispose(); }
  });

  it('times out a direct connect probe, kills once, and removes its temporary script', async () => {
    vi.useFakeTimers();
    const { files, fs } = memoryFs([versioned]);
    const remove = vi.fn(async (path: string) => { files.delete(path); });
    const trackedFs = { ...fs, remove } as IHostFileSystem;
    const proc = scripted((_command, args) => args.includes('nodejs') ? { hang: true } : { code: 0 });
    const configs = new Map<string, BrowserResolvedConnection>([['ego-lite', connection]]);
    const ix = new TestInstantiationService();
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IHostProcessService, proc.service);
    ix.stub(IHostFileSystem, trackedFs);
    ix.stub(IBrowserBackendFactory, { open: vi.fn(async () => { throw new Error('unused'); }) });
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({ connections: [browserConnectionRecord(connection)] }),
      resolve: async (id: string) => {
        const found = configs.get(id);
        if (found === undefined) throw new Error('missing');
        return found;
      },
    });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = ix.get(IBrowserControlService);
    let settled = false;
    let result: unknown;
    let failure: unknown;
    let pending: Promise<unknown> | undefined;
    try {
      pending = control.connect('ego-lite').then((value) => { settled = true; result = value; }, (error: unknown) => { settled = true; failure = error; });
      await vi.advanceTimersByTimeAsync(0);
      expect(proc.calls.filter((call) => call.args.includes('nodejs'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(proc.kills[0]).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(settled).toBe(true);
      expect(failure).toBeUndefined();
      expect(result).toMatchObject({ state: 'failed', failure: { code: 'browser.execution_failed' }, error: expect.stringContaining('5000ms') });
      expect(result).toMatchObject({ error: expect.stringMatching(/started|onboarding|retry/i) });
      expect(proc.kills[0]).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[0]).toMatch(/[\\/]ego-scripts[\\/]/);
      expect([...files.keys()].some((path) => /ego-scripts/.test(path))).toBe(false);
    } finally {
      proc.kills.forEach((kill) => release(kill));
      await Promise.allSettled([pending]);
      vi.useRealTimers();
      await ix.dispose();
    }
  });
});

describe('Ego Lite successful status recovery', () => {
  it.each(['script', 'tabs'] as const)('clears only the starting failure on %s success and preserves newer failures', async (action) => {
    const { fs } = memoryFs([versioned]);
    let healthy = true;
    const proc = scripted(() => ({ stdout: healthy ? 'kiki-ego-ready\n' : '' }));
    const ix = new TestInstantiationService();
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IHostProcessService, proc.service);
    ix.stub(IHostFileSystem, fs);
    ix.stub(IBrowserBackendFactory, { open: vi.fn(async () => { throw new Error('unused'); }) });
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({ connections: [browserConnectionRecord(connection)] }),
      resolve: async () => connection,
    });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = ix.get(IBrowserControlService);
    const caller = { sessionId: 's', agentId: 'a' };
    const context = { caller, sessionDir: 'C:/session', turnId: 0, toolCallId: 't', elicit: async () => { throw new Error('unused'); } } satisfies BrowserRequestContext;
    const invoke = () => control.invoke({ browser: connection.id, tool: 'browser__ego_run', args: { script: 'console.log(task.spaceId);' }, caller, requestContext: context });
    const succeed = () => action === 'script' ? invoke() : control.tabs(connection.id, undefined, context);
    const success = {
      result: { code: 0, stdout: '32', stderr: '', aborted: false, scriptPath: 'C:/fixture.mjs', argv: [] },
      binding: { connectionId: connection.id, name: egoSpaceName('s', 'a'), spaceId: '32' },
      tabs: [{ tabId: 'p1', targetId: 'p1' }], refused: false, shots: [],
    };
    const run = vi.spyOn(EgoBrowserRuntime.prototype, 'runAgent');
    try {
      await control.connect(connection.id);
      run.mockRejectedValueOnce(new BrowserError('browser.execution_failed', 'EGO_TASK_SPACE_NAME_IN_USE'));
      await expect(invoke()).rejects.toMatchObject({ message: 'EGO_TASK_SPACE_NAME_IN_USE' });
      run.mockResolvedValueOnce(success);
      await succeed();
      expect(await control.status(connection.id)).toMatchObject({ state: 'ready', generation: 1, error: undefined, failure: undefined });
      for (const reconnect of [false, true]) {
        await control.connect(connection.id);
        run.mockRejectedValueOnce(new BrowserError('browser.execution_failed', 'starting failure'));
        await expect(invoke()).rejects.toMatchObject({ message: 'starting failure' });
        let resolve: (value: typeof success) => void = () => undefined;
        run.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
        const before = run.mock.calls.length;
        const pending = succeed();
        const settled = pending.then(() => undefined, (error: unknown) => error);
        await vi.waitFor(() => expect(run.mock.calls.length).toBe(before + 1));
        if (reconnect) {
          await control.disconnect(connection.id);
          await control.connect(connection.id);
          run.mockRejectedValueOnce(new BrowserError('browser.execution_failed', 'newer failure'));
          await expect(invoke()).rejects.toMatchObject({ message: 'newer failure' });
        } else {
          healthy = false;
          await control.check(connection.id);
          healthy = true;
        }
        const newer = await control.status(connection.id);
        expect(newer.failure).toMatchObject({ code: 'browser.execution_failed' });
        resolve(success);
        if (reconnect) expect(await settled).toMatchObject({ code: 'browser.disconnected' });
        else expect(await settled).toBeUndefined();
        expect(await control.status(connection.id)).toEqual(newer);
      }
    } finally {
      run.mockRestore();
      await ix.dispose();
    }
  });
});

describe('Ego Lite discovered connection admission', () => {
  it.each(['win32', 'linux'] as const)('lists and checks an installed CLI on %s, then saves only on explicit selection without changing default or allow state', async (platform) => {
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    const previousPath = process.env['PATH'];
    const fixtureRoot = platform === 'win32' ? root : '/EgoLite';
    const fixtureVersioned = join(fixtureRoot, '0.6.0.16', EXE);
    process.env['PATH'] = join(fixtureRoot, '0.6.0.16');
    const { fs } = memoryFs([fixtureVersioned]);
    const configs = new Map<string, BrowserResolvedConnection>([
      ['other', { id: 'other', type: 'agent-browser-profile', name: 'Other', enabled: true }],
    ]);
    let native = true;
    let allowed: readonly string[] | undefined;
    const setDefault = vi.fn(async () => undefined);
    const upsert = vi.fn(async (id: string, input: Parameters<IBrowserConnectionStore['upsert']>[1]) => {
      if (input.type !== 'ego-lite') throw new Error('fixture only admits Ego Lite');
      const record: Extract<BrowserResolvedConnection, { type: 'ego-lite' }> = { ...input, id };
      configs.set(id, record);
      return browserConnectionRecord(record);
    });
    const proc = scripted((_command, args) => args.includes('nodejs') ? { code: 0, stdout: 'kiki-ego-ready\n' } : { code: 0, stdout: '' });
    const ix = new TestInstantiationService();
    ix.stub(IFlagService, { enabled: () => native });
    ix.stub(IHostProcessService, proc.service);
    ix.stub(IHostFileSystem, fs);
    ix.stub(IBrowserBackendFactory, { open: vi.fn(async () => { throw new Error('managed backend must not open'); }) });
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({ connections: [...configs.values()].map(({ id, name, type, enabled }) => ({ id, name, type, enabled })), defaultBrowser: 'other', ...(allowed !== undefined ? { allowedBrowsers: allowed } : {}) }),
      resolve: async (id: string) => {
        const found = configs.get(id);
        if (found === undefined) throw new BrowserError('browser.not_found', `Unknown browser connection "${id}"`);
        return found;
      },
      upsert, remove: async (id: string) => { configs.delete(id); }, setDefault, revealEndpoint: async () => undefined,
    });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = ix.get(IBrowserControlService);
    try {
      expect(await control.discover()).toEqual([expect.objectContaining({ id: 'ego-lite', type: 'ego-lite', cliPath: fixtureVersioned, status: expect.objectContaining({ state: 'idle' }) })]);
      expect(await control.probeDiscovered(false)).toMatchObject({ browser: 'ego-lite', state: 'idle' });
      expect(configs.has('ego-lite')).toBe(false);
      const beforeDenied = proc.calls.length;
      allowed = [];
      await expect(control.probeDiscovered(true)).rejects.toMatchObject({ code: 'browser.disabled', details: { reason: 'not_allowed' } });
      expect(proc.calls.length).toBe(beforeDenied);
      expect(upsert).not.toHaveBeenCalled();
      expect((await control.list()).allowedBrowsers).toEqual([]);
      expect((await control.list()).defaultBrowser).toBe('other');
      allowed = undefined;
      native = false;
      await expect(control.probeDiscovered(true)).rejects.toMatchObject({ code: 'browser.disabled', details: { reason: 'feature_disabled' } });
      expect(upsert).not.toHaveBeenCalled();
      native = true;
      expect(await control.probeDiscovered(true)).toMatchObject({ browser: 'ego-lite', state: 'ready' });
      expect(upsert).toHaveBeenCalledWith('ego-lite', expect.objectContaining({ type: 'ego-lite', cliPath: fixtureVersioned }));
      expect(setDefault).not.toHaveBeenCalled();
      expect((await control.list()).defaultBrowser).toBe('other');
      expect((await control.list()).allowedBrowsers).toBeUndefined();
    } finally {
      await ix.dispose();
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
      if (previousPlatform !== undefined) Object.defineProperty(process, 'platform', previousPlatform);
    }
  });
});

describe('Ego Lite discovery from the environment registry', () => {
  it('reads the current user and system Path when the process environment is stale', async () => {
    const exe = join('C:/ego-root/ego-registry', EXE);
    const { fs } = memoryFs([exe]);
    const proc = scripted((command, args) => {
      expect(command).toBe('reg.exe');
      const key = args[1] ?? '';
      if (key === 'HKCU\\Environment') return { stdout: 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %SystemRoot%\\ego-registry\r\n' };
      if (key.includes('Session Manager\\Environment')) return { stdout: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_SZ    C:\\Windows\\system32\r\n' };
      return { stdout: '' };
    });
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: 'C:\\stale', SystemRoot: 'C:\\ego-root' }, 'win32');
    await expect(runtime.resolve(undefined)).resolves.toEqual({ kind: 'found', path: exe });
    expect(proc.calls.map((call) => call.args[1])).toEqual(expect.arrayContaining([
      'HKCU\\Environment',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    ]));
    expect(proc.calls.every((call) => call.options?.shell === false && call.options?.windowsHide === true)).toBe(true);
  });

  it('keeps the process Path when the environment registry does not answer', async () => {
    const exe = join('C:/stale', EXE);
    const { fs } = memoryFs([exe]);
    const proc = scripted(() => { throw new Error('reg unavailable'); });
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: 'C:\\stale' }, 'win32');
    await expect(runtime.resolve(undefined)).resolves.toEqual({ kind: 'found', path: exe });
  });

  it('splits a win32 Path on semicolons and keeps the drive letter', async () => {
    const first = join('C:/ego-a', EXE);
    const second = join('C:/ego-b', EXE);
    const hits = await egoPathHits('C:\\ego-a;C:\\ego-b', async (file) => file === first || file === second, 'win32');
    expect(hits).toEqual([first, second]);
  });

  it('splits a linux PATH on colons when that platform is injected on any host', async () => {
    const exe = join('/opt/ego-a', EXE);
    const { fs } = memoryFs([exe]);
    const proc = scripted(() => { throw new Error('reg unavailable'); });
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '/opt/ego-a:/opt/ego-b' }, 'linux');
    await expect(runtime.resolve(undefined)).resolves.toEqual({ kind: 'found', path: exe });
  });
});

describe('browser__ego_run on the service computer', () => {
  it('describes an absolute screenshot file under shotDir', () => {
    const tool = new BrowserEgoRunTool({} as IAgentBrowserService);
    expect(tool.description).toContain("shotDir + '/shot.png'");
    expect(tool.description).toContain('Omitting `path`');
  });

  it('refuses an SSH runtime instead of running the script locally', async () => {
    const prepareFor = vi.fn();
    const service = Object.create(AgentBrowserService.prototype) as AgentBrowserService;
    Object.assign(service, { runtime: { inspect: () => ({ identity: { runtimeId: 'ssh:desk' } }), prepareFor } });
    const result = await service.egoExecution({ script: 'console.log(1)' });
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty('execute');
    expect(prepareFor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ output: expect.stringContaining('SSH') });
    expect(JSON.stringify(result)).not.toContain('console.log(1)');
  });

  it('keeps a local runtime on the script approval', async () => {
    const prepareFor = vi.fn();
    const service = Object.create(AgentBrowserService.prototype) as AgentBrowserService;
    Object.assign(service, { runtime: { inspect: () => ({ identity: { runtimeId: 'local' } }), prepareFor } });
    const result = await service.egoExecution({ script: 'console.log(1)' });
    const runtime = { identity: { runtimeId: 'local' } } as Runtime;
    expect(prepareFor).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      display: { kind: 'command', command: 'console.log(1)', language: 'bash' },
      approvalRule: toolApprovalRule('browser__ego_run', 'console.log(1)', runtime),
    });
  });
});

describe('browser__ego_run approval', () => {
  it('uses the script text as the command subject', () => {
    const runtime = { identity: { runtimeId: 'local' } } as Runtime;
    const first = egoRunExecution('console.log(1)', runtime, async () => ({ output: '' }));
    const second = egoRunExecution('console.log(2)', runtime, async () => ({ output: '' }));
    if (!('approvalRule' in first) || !('approvalRule' in second) || !('display' in first)) throw new Error('expected a runnable execution');
    expect(first.approvalRule).toBe(toolApprovalRule('browser__ego_run', 'console.log(1)', runtime));
    expect(first.approvalRule).not.toBe(second.approvalRule);
    expect(first.display).toEqual({ kind: 'command', command: 'console.log(1)', language: 'bash' });
    expect(first).not.toHaveProperty('accesses');
  });
});

it('enumerates uninstall hives and registered PATH in parallel under one discovery deadline', async () => {
  vi.useFakeTimers();
  const calls: string[][] = [];
  const started = Date.now();
  const spawn = vi.fn(async (command: string, args: readonly string[] = []) => {
    expect(command).toMatch(/^[A-Za-z]:\\.*\\reg\.exe$/i);
    calls.push([...args]);
    return { stdout: Readable.from(['']), stderr: Readable.from(['']), wait: () => new Promise<number>((resolve) => { setTimeout(() => { resolve(0); }, 300); }), dispose: async () => {}, kill: async () => {} };
  });
  const { fs } = memoryFs([]);
  const runtime = new EgoBrowserRuntime({ spawn } as never, fs, { PATH: '' }, 'win32');
  try {
    const result = runtime.resolve(undefined, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toEqual({ kind: 'missing' });
    expect(Date.now() - started).toBe(300);
  } finally { vi.useRealTimers(); }
});

it('waits for owned detection cleanup after an abort, including abort during spawn', async () => {
  const controller = new AbortController();
  let spawned: (() => void) | undefined;
  let cleaned: (() => void) | undefined;
  const dispose = vi.fn(async () => {});
  const kill = vi.fn(() => new Promise<void>((resolve) => { cleaned = resolve; }));
  const spawn = vi.fn(() => new Promise((resolve) => { spawned = () => { resolve({ stdout: Readable.from(['']), stderr: Readable.from(['']), wait: () => new Promise(() => {}), kill, dispose }); }; }));
  const pending = runEgoDetectionCommand({ spawn } as never, 'fixture-cli', [], controller.signal);
  const observed = pending.catch((error: unknown) => error);
  controller.abort(new Error('fixture cancellation'));
  spawned?.();
  await vi.waitFor(() => { expect(kill).toHaveBeenCalledOnce(); });
  expect(dispose).not.toHaveBeenCalled();
  cleaned?.();
  expect(await observed).toBe(controller.signal.reason);
  expect(dispose).toHaveBeenCalledOnce();
});

it('reports the detection deadline instead of a stream error caused by confirmed cancellation', async () => {
  const controller = new AbortController();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const dispose = vi.fn(async () => { stdout.destroy(); stderr.destroy(); });
  const kill = vi.fn(async () => { stdout.destroy(); stderr.destroy(); });
  const spawn = vi.fn(async () => ({ stdout, stderr, wait: () => new Promise(() => {}), kill, dispose }));
  const pending = runEgoDetectionCommand({ spawn } as never, 'fixture-cli', [], controller.signal);
  const observed = pending.catch((error: unknown) => error);
  await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce(); });
  const deadline = new Error('fixture detection deadline');
  controller.abort(deadline);
  expect(await observed).toBe(deadline);
  expect(dispose).toHaveBeenCalledOnce();
});

it('keeps detection cleanup failures visible instead of reporting cancellation success', async () => {
  const controller = new AbortController();
  const failure = new Error('fixture cleanup unconfirmed');
  const dispose = vi.fn();
  const kill = vi.fn(async () => { throw failure; });
  const spawn = vi.fn(async () => ({ stdout: Readable.from(['']), stderr: Readable.from(['']), wait: () => new Promise(() => {}), kill, dispose }));
  const pending = runEgoDetectionCommand({ spawn } as never, 'fixture-cli', [], controller.signal);
  const observed = pending.catch((error: unknown) => error);
  await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce(); });
  controller.abort();
  expect(await observed).toBe(failure);
  expect(dispose).not.toHaveBeenCalled();
});

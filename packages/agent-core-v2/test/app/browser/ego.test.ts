import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
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
import { HostFsError } from '#/os/interface/hostFsErrors';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { AgentBrowserService, BrowserEgoRunTool, IAgentBrowserService, egoRunExecution } from '#/agent/tools/browser/browserTools';
import { toolApprovalRule } from '#/agent/tools/os/sshToolTarget';
import type { Runtime } from '#/runtime/runtime';
import { egoPathHits, parseEgoUninstallExport } from '#/app/browser/ego/hints';
import {
  classifyEgoCheck, egoNotReadyMessage, egoSpaceName, extractEgoDiagnostic, resolveEgoCli, type EgoUninstallRecord,
} from '#/app/browser/ego/resolveCli';
import {
  EGO_RUN_TIMEOUT_MS, EgoBrowserRuntime, EgoProbeTimeoutError, EgoRunTimeoutError,
  egoArgv, egoNumericSpaceId, egoPrelude, egoProgram, egoReadyScript, egoTabBody,
} from '#/app/browser/ego/runtime';
import { analyzeEgoScriptBindings } from '#/app/browser/ego/scriptBindings';
import { runEgoDetectionCommand } from '#/app/browser/ego/process';
import { createDecorator } from '#/_base/di/instantiation';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService, type PromptSnapshot } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IConfigService } from '#/app/config/config';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { FakeRuntime } from '#/runtime/fakeRuntime';

const EXE = 'ego-browser.exe';
const root = 'C:/EgoLite';
const versioned = join(root, '0.6.0.16', EXE);
const child = join(root, 'app', EXE);
const other = join('D:/Other', EXE);
const saved = join('E:/saved', EXE);
const administratorDiagnostic = 'ego lite closed the connection because ego-browser is running as administrator. Run ego-browser from a terminal that is not elevated.';

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
    expect(resolveEgoCli({ exists: exists([child, other]), children, records: [record({ displayVersion: undefined })], pathHits: [other] })).toEqual({ kind: 'choose', paths: [child, other].toSorted() });
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

  it('extracts concise diagnostics without terminal noise, ready markers, or internal script paths', () => {
    const output = [
      '\u001B]0;probe\u0007\u001B[31mkiki-ego-ready\u001B[0m\r',
      `\u0000\u001B[31m${administratorDiagnostic}\u001B[0m\u0007`,
      administratorDiagnostic,
      '    at execute (file:///C:/Temp/ego-scripts/probe.mjs:1:1)',
      'C:\\Temp Folder\\ego-scripts\\probe.mjs:1',
      '/tmp/ego-scripts/probe.mjs:1',
      'file:///C:/Temp%20Folder/ego-scripts%2Fprobe.mjs:1',
      '    at processTicksAndRejections (node:internal/process/task_queues:105:5)',
      'Node.js v24.22.2',
      '^^^^^^',
      'probe.mjs:1:1',
    ].join('\n');
    expect(extractEgoDiagnostic(output)).toBe(administratorDiagnostic);
    expect(egoNotReadyMessage(output)).toBe(`Ego Lite is not ready: ${administratorDiagnostic}`);
    expect(extractEgoDiagnostic('\n\u001B[32mkiki-ego-ready\u001B[0m\n\u0000')).toBeUndefined();
    expect(egoNotReadyMessage('')).toBe('Ego Lite is not ready');
    const long = extractEgoDiagnostic(`${'x'.repeat(398)}😀${'y'.repeat(20)}`);
    expect(long).toBe(`${'x'.repeat(398)}…`);
    expect(long?.length).toBeLessThanOrEqual(400);
  });

  it.each([
    'file:///C:/Temp%20Folder/ego-scripts/probe.mjs:1:1',
    'C:\\Users\\Example User\\Temp\\ego-scripts\\probe.mjs',
    'C:/Users/Example User/Temp/ego-scripts/probe.mjs',
    '/tmp/ego-scripts/probe.mjs',
    '/var/folders/fixture/ego-scripts/probe.mjs',
    '/Users/Example User/Temp/ego-scripts/probe.mjs',
    '/home/example/ego-scripts/probe.mjs',
    'ego-scripts/probe.mjs',
    '"C:\\Users\\Example User\\config file.json"',
    '"/home/example/config file.json"',
  ])('redacts the inline path %s without losing the error or recovery text', (path) => {
    expect(extractEgoDiagnostic(`Error: cannot open ${path}; restart the browser`)).toBe('Error: cannot open <path>; restart the browser');
  });

  it('replaces lone surrogates before returning or truncating diagnostic text', () => {
    expect(extractEgoDiagnostic('Error: \uD800bad \uDC00input')).toBe('Error: �bad �input');
    const output = extractEgoDiagnostic(`${'x'.repeat(398)}\uD800tail`);
    expect(output).toBe(`${'x'.repeat(398)}�…`);
    expect(output?.isWellFormed()).toBe(true);
    expect(output?.length).toBeLessThanOrEqual(400);
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
      if (value === undefined) throw new HostFsError('os.fs.not_found', `missing ${path}`);
      return value;
    },
    writeText: async (path: string, data: string) => { files.set(path, data); },
    replaceText: async (path: string, data: string) => { files.set(path, data); },
    createExclusive: async (path: string, data: Uint8Array) => {
      if (files.has(path)) return false;
      files.set(path, new TextDecoder().decode(data));
      return true;
    },
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
  it.each(['stdout', 'stderr'] as const)('keeps administrator diagnostics from a fast non-zero exit on %s', async (stream) => {
    const { fs } = memoryFs([versioned]);
    const proc = scripted(() => ({ code: 1, [stream]: administratorDiagnostic }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '' }, 'linux');
    expect(await runtime.probe(connection)).toMatchObject({ kind: 'not_ready', output: expect.stringContaining(administratorDiagnostic) });
  });

  it.each(['stdout', 'stderr'] as const)('includes partial %s diagnostics in a probe timeout after closing the owned process', async (stream) => {
    vi.useFakeTimers();
    const { files, fs } = memoryFs([versioned]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(async () => { stdout.destroy(); stderr.destroy(); });
    const dispose = vi.fn(async () => {});
    const spawn = vi.fn(async () => ({ stdout, stderr, wait: () => new Promise<number>(() => {}), kill, dispose }));
    const runtime = new EgoBrowserRuntime({ spawn } as unknown as IHostProcessService, {
      ...fs, remove: async (file: string) => { files.delete(file); },
    }, { PATH: '' }, 'linux');
    const observed = runtime.probe(connection).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const target = stream === 'stdout' ? stdout : stderr;
      target.write('\u001B[31m');
      target.write(administratorDiagnostic.slice(0, 65));
      target.write(`${administratorDiagnostic.slice(65)}\u001B[0m\n    at file:///C:/Temp/ego-scripts/probe.mjs:1:1`);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await observed).toMatchObject({ code: 'browser.execution_failed', message: expect.stringContaining(`: ${administratorDiagnostic}`) });
      expect(await observed).toMatchObject({ message: expect.stringContaining('5000ms') });
      expect(String(await observed)).not.toContain('ego-scripts');
      expect(String(await observed)).not.toContain('retry.:');
      expect(kill).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect([...files.keys()].some((file) => file.includes('ego-scripts'))).toBe(false);
    } finally {
      stdout.destroy();
      stderr.destroy();
      vi.useRealTimers();
    }
  });

  it.each(['', administratorDiagnostic])('keeps only the second attempt output when the SDK fallback times out: %s', async (diagnostic) => {
    vi.useFakeTimers();
    const sdk = join(root, 'sdk.js');
    const { fs } = memoryFs([versioned, sdk]);
    const proc = scripted((_command, args) => args.includes('--sdk-path')
      ? { code: 1, stdout: 'unknown option --sdk-path', stderr: 'superseded first attempt' }
      : { hang: true, stderr: diagnostic });
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '', KIKI_EGO_SDK_PATH: sdk }, 'linux');
    const observed = runtime.probe(connection).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(proc.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await observed;
      expect(error).toMatchObject({ code: 'browser.execution_failed', message: expect.stringContaining('5000ms') });
      expect(String(error)).not.toMatch(/sdk-path|superseded|retry\.:/);
      if (diagnostic !== '') expect(error).toMatchObject({ message: expect.stringContaining(`: ${diagnostic}`) });
    } finally { vi.useRealTimers(); }
  });

  it('writes a quoted prelude, materializes task/page lazily, and retries a rejected sdk path once', async () => {
    const label = 'p"1\n;break';
    const bound = { name: 'kiki-a', label, profileId: 'pro"file', connectionId: 'ego-lite' };
    const source = egoProgram(bound, 'await page.goto("https://example.com");\nconsole.log("body")');
    expect(source.startsWith(`const __kikiBound = JSON.parse(${JSON.stringify(JSON.stringify(bound))});`)).toBe(true);
    expect(source).toContain('const task = await __kikiOpenTask();');
    expect(source).toContain('const page = task.page(__kikiBound.label);');
    const lazySource = egoProgram(bound, 'console.log("body")');
    expect(lazySource.startsWith(`const __kikiBound = JSON.parse(${JSON.stringify(JSON.stringify(bound))});`)).toBe(true);
    expect(lazySource).not.toContain('__kikiOpenTask');
    expect(lazySource).not.toContain('const page = task.page');
    const resumed = egoPrelude({ ...bound, spaceId: '7' });
    expect(resumed).toContain('\\"spaceId\\":7');
    expect(resumed).not.toContain('\\"spaceId\\":\\"7\\"');
    expect(resumed).toContain('const spaces = typeof listTaskSpaces === "function" ? await listTaskSpaces() : undefined;');
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
    expect(proc.calls[0]?.options).toEqual({ shell: false, windowsHide: true, ownedProcessTree: true, ownedProcessLifetime: undefined });
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
    expect(scripts[1]).toContain(JSON.stringify(JSON.stringify({ spaceId: 32, name: egoSpaceName('s', 'a'), connectionId: connection.id })));
    expect(scripts[1]).not.toContain('__kikiOpenTask');
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

  it('preserves a corrupt bindings file before rewriting and refuses to overwrite after an unreadable read', async () => {
    const { files, fs } = memoryFs([versioned]);
    const sessionDir = 'C:/session';
    const spaceFile = join(sessionDir, 'browser-ego-spaces.json');
    const truncated = '{"other":{"connectionId":"ego-lite","name":"kiki-other","spaceId":"9"';
    files.set(spaceFile, truncated);
    const backup = `${spaceFile}.corrupt-${createHash('sha256').update(truncated).digest('hex').slice(0, 16)}`;
    files.set(backup, truncated.slice(0, 10));
    const warn = vi.fn();
    const proc = scripted(() => ({ code: 0, stdout: marked('space-1') }));
    const runtime = new EgoBrowserRuntime(proc.service, fs, { PATH: '' }, 'linux', { warn });
    await runtime.runAgent({ connection, sessionDir, sessionId: 's', agentId: 'a', body: 'x' });
    const backups = [...files.keys()].filter((path) => path.startsWith(`${spaceFile}.corrupt-`));
    expect(backups).toEqual([backup]);
    expect(files.get(backup)).toBe(truncated);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(files.get(spaceFile) ?? '{}')).toMatchObject({ a: { spaceId: 'space-1' } });

    const before = files.get(spaceFile);
    const denied = { ...fs, readText: async () => { throw new HostFsError('os.fs.permission_denied', 'denied'); } } as IHostFileSystem;
    const deniedRuntime = new EgoBrowserRuntime(scripted(() => ({ code: 0, stdout: marked('space-2') })).service, denied, { PATH: '' }, 'linux');
    await deniedRuntime.runAgent({ connection, sessionDir, sessionId: 's', agentId: 'b', body: 'x' }).catch(() => undefined);
    expect(files.get(spaceFile)).toBe(before);
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
      expect(scripts[1]).toContain('\\"spaceId\\":32');
      expect(scripts[1]).not.toContain('\\"spaceId\\":\\"32\\"');
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

  it.each(['connect', 'check', 'discovered'] as const)('reports administrator stderr from a fast non-zero %s probe', async (action) => {
    const previous = process.env['PATH'];
    process.env['PATH'] = join(root, '0.6.0.16');
    const { fs } = memoryFs([versioned]);
    const proc = scripted((_command, args) => args.includes('nodejs') ? { code: 1, stderr: `\u001B[31m${administratorDiagnostic}\u001B[0m` } : {});
    const ix = new TestInstantiationService();
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IHostProcessService, proc.service);
    ix.stub(IHostFileSystem, fs);
    ix.stub(IBrowserBackendFactory, { open: vi.fn() });
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({ connections: action === 'discovered' ? [] : [browserConnectionRecord(connection)] }),
      resolve: async () => connection,
    });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = ix.get(IBrowserControlService);
    try {
      const result = await (action === 'discovered' ? control.probeDiscovered(false) : control[action](connection.id));
      expect(result).toMatchObject({ error: `Ego Lite is not ready: ${administratorDiagnostic}` });
      expect(result.state).toBe(action === 'discovered' ? 'requires_action' : 'failed');
    } finally {
      await ix.dispose();
      if (previous === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previous;
    }
  });

  it('returns structured failures for unsaved discovered probes and preserves caller cancellation', async () => {
    const ix = new TestInstantiationService();
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IHostProcessService, { spawn: vi.fn() });
    ix.stub(IHostFileSystem, memoryFs([versioned]).fs);
    ix.stub(IBrowserBackendFactory, { open: vi.fn() });
    const upsert = vi.fn();
    ix.stub(IBrowserConnectionStore, { list: async () => ({ connections: [] }), upsert });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = ix.get(IBrowserControlService);
    const resolution = vi.spyOn(EgoBrowserRuntime.prototype, 'resolve').mockResolvedValue({ kind: 'found', path: versioned });
    const probe = vi.spyOn(EgoBrowserRuntime.prototype, 'probe');
    try {
      for (const error of [new EgoProbeTimeoutError(`Ego Lite probe timed out after 5000ms: ${administratorDiagnostic}`), new Error('fixture spawn failed')]) {
        probe.mockRejectedValueOnce(error);
        expect(await control.probeDiscovered(true)).toMatchObject({
          browser: 'ego-lite', state: 'failed', generation: 0, ownership: 'external-browser', checkedAt: expect.any(String),
          failure: { code: 'browser.execution_failed' }, error: error.message,
        });
      }
      const caller = new AbortController();
      const reason = new Error('fixture caller cancellation');
      probe.mockImplementationOnce(async () => { caller.abort(reason); throw reason; });
      await expect(control.probeDiscovered(true, caller.signal)).rejects.toBe(reason);
      expect(upsert).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
      resolution.mockRestore();
      await ix.dispose();
    }
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
  const captured = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const pending = runEgoDetectionCommand({ spawn } as never, 'fixture-cli', [], controller.signal, captured);
  const observed = pending.catch((error: unknown) => error);
  await vi.waitFor(() => { expect(stdout.listenerCount('data')).toBe(1); expect(stderr.listenerCount('data')).toBe(1); });
  const deadline = new Error('fixture detection deadline');
  stdout.write('fixture output');
  stderr.write(administratorDiagnostic);
  controller.abort(deadline);
  expect(await observed).toBe(deadline);
  expect(Buffer.concat(captured.stdout).toString('utf8')).toBe('fixture output');
  expect(Buffer.concat(captured.stderr).toString('utf8')).toBe(administratorDiagnostic);
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

interface SimulatedTab {
  targetId: string;
  label?: string;
  url: string;
  title?: string;
  active?: boolean;
  openedBy: 'agent' | 'unknown' | 'user';
}

interface SimulatedSpace {
  id: number;
  name: string;
  profileId?: string;
  ownership: 'agent' | 'user' | 'agentDelegatedToUser';
  closed: boolean;
  tabs: SimulatedTab[];
}

function createEgoSimulator(seed: readonly SimulatedSpace[] = []) {
  let nextId = Math.max(200, ...seed.map((item) => item.id)) + 1;
  const spaces = new Map<number, SimulatedSpace>(seed.map((item) => [item.id, { ...item, tabs: item.tabs.map((tab) => ({ ...tab })) }]));
  const taskSpaceCalls: { target: unknown; options?: unknown }[] = [];
  const cdpCalls: { spaceId: number; method: string; params?: unknown }[] = [];
  const finishCalls: { spaceId: number; options?: unknown }[] = [];

  const handleFor = (space: SimulatedSpace) => {
    const pageHandle = (label: string) => ({
      label,
      spaceId: space.id,
      goto: async (url: string) => {
        const existing = space.tabs.find((item) => item.label === label);
        if (existing !== undefined) existing.url = url;
        else space.tabs.push({ targetId: `target-${String(space.id)}-${label}`, label, url, openedBy: 'agent', active: true });
      },
      title: async () => space.tabs.find((item) => item.label === label)?.title ?? 'Example',
      close: async () => {
        space.tabs = space.tabs.filter((item) => item.label !== label);
      },
    });
    return {
      id: space.id,
      spaceId: space.id,
      name: space.name,
      get ownership() { return space.ownership; },
      get closed() { return space.closed; },
      page: (label: string) => pageHandle(label),
      pages: async () => space.tabs.filter((tab) => tab.label !== undefined).map((tab) => ({ label: tab.label, url: tab.url, title: tab.title })),
      tabs: async () => space.tabs.map((tab) => ({ ...tab })),
      newPage: async () => {
        const label = `p${String(space.tabs.filter((tab) => tab.label !== undefined).length + 1)}`;
        space.tabs.push({ targetId: `target-${String(space.id)}-${label}`, label, url: 'about:blank', openedBy: 'agent', active: true });
        return pageHandle(label);
      },
      cdp: async (method: string, params?: { targetId?: string }) => {
        if (space.ownership !== 'agent') throw new Error(EGO_USER_IN_CONTROL_TEXT);
        cdpCalls.push({ spaceId: space.id, method, params });
        if (method === 'Target.closeTarget' && typeof params?.targetId === 'string') {
          space.tabs = space.tabs.filter((tab) => tab.targetId !== params.targetId);
          if (space.tabs.length === 0) space.closed = true;
        }
        return {};
      },
      finish: async (options?: { keep?: readonly string[] }) => {
        if (space.closed) throw new Error(`TaskSpace ${String(space.id)} is already closed`);
        if (space.ownership !== 'agent') throw new Error(EGO_USER_IN_CONTROL_TEXT);
        finishCalls.push({ spaceId: space.id, options });
        const keep = new Set(options?.keep ?? []);
        space.tabs = space.tabs.filter((tab) => tab.openedBy !== 'agent' || (tab.label !== undefined && keep.has(tab.label)));
        for (const tab of space.tabs) delete tab.label;
        if (space.tabs.length === 0) {
          space.closed = true;
          return { closed: true };
        }
        space.ownership = 'user';
        return { closed: false };
      },
    };
  };

  const listTaskSpaces = async () =>
    [...spaces.values()]
      .filter((space) => !space.closed)
      .map((space) => ({ id: space.id, name: space.name, ownership: space.ownership, profileId: space.profileId }));

  const openTaskSpace = async (target: unknown, options?: { profileId?: string; name?: string }) => {
    taskSpaceCalls.push({ target, options });
    if (typeof target === 'number') {
      const found = spaces.get(target);
      if (found === undefined || found.closed) throw new Error(`Dead numeric space ${String(target)}`);
      if (found.ownership !== 'agent') throw new Error(EGO_USER_IN_CONTROL_TEXT);
      return handleFor(found);
    }
    const name = typeof target === 'string'
      ? target
      : target !== null && typeof target === 'object' && typeof (target as { name?: unknown }).name === 'string'
        ? (target as { name: string }).name
        : undefined;
    const profileId = options?.profileId ?? (target !== null && typeof target === 'object' && typeof (target as { profileId?: unknown }).profileId === 'string'
      ? (target as { profileId: string }).profileId
      : undefined);
    if (name === undefined || name === '') throw new Error('Invalid taskSpace argument');
    const existing = [...spaces.values()].find((item) => !item.closed && item.name === name);
    if (existing !== undefined) {
      if (profileId !== undefined && profileId !== '') throw new Error('profileId applies only when creating a new space');
      if (existing.ownership === 'user') throw new Error('EGO_TASK_SPACE_NAME_IN_USE');
      if (existing.ownership !== 'agent') throw new Error(EGO_USER_IN_CONTROL_TEXT);
      return handleFor(existing);
    }
    const id = nextId++;
    const created: SimulatedSpace = {
      id,
      name,
      profileId,
      ownership: 'agent',
      closed: false,
      tabs: [{ targetId: `nt-${String(id)}`, url: 'chrome://newtab/', openedBy: 'unknown', active: true }],
    };
    spaces.set(id, created);
    return handleFor(created);
  };

  const runModule = async (source: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    const logs: string[] = [];
    const globals = globalThis as Record<string, unknown>;
    const prevTaskSpace = globals['taskSpace'];
    const prevListTaskSpaces = globals['listTaskSpaces'];
    const prevEgo = globals['ego'];
    const origLog = console.log;
    globals['taskSpace'] = openTaskSpace;
    globals['listTaskSpaces'] = listTaskSpaces;
    globals['ego'] = { taskSpace: openTaskSpace, listTaskSpaces };
    console.log = (...items: unknown[]) => {
      logs.push(items.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(' '));
    };
    try {
      const encoded = Buffer.from(`${source}\nexport const __kikiNonce = ${JSON.stringify(Math.random())};\n`, 'utf8').toString('base64');
      await import(`data:text/javascript;base64,${encoded}`);
      return { code: 0, stdout: `${logs.join('\n')}\n`, stderr: '' };
    } catch (error) {
      return { code: 1, stdout: `${logs.join('\n')}\n`, stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      console.log = origLog;
      if (prevTaskSpace === undefined) delete globals['taskSpace'];
      else globals['taskSpace'] = prevTaskSpace;
      if (prevListTaskSpaces === undefined) delete globals['listTaskSpaces'];
      else globals['listTaskSpaces'] = prevListTaskSpaces;
      if (prevEgo === undefined) delete globals['ego'];
      else globals['ego'] = prevEgo;
    }
  };

  return { spaces, taskSpaceCalls, cdpCalls, finishCalls, runModule };
}

const EGO_USER_IN_CONTROL_TEXT = 'EGO_TASK_SPACE_USER_IN_CONTROL';

function simulatedProcessService(files: Map<string, string>, sim: ReturnType<typeof createEgoSimulator>): IHostProcessService {
  const spawn = vi.fn(async (_command: string, args: readonly string[] = []) => {
    const evalArg = args[args.indexOf('-e') + 1] ?? '';
    if (!evalArg.startsWith('await import(')) {
      return { pid: 1, exitCode: 0, stdin: Readable.from([]), stdout: Readable.from(['']), stderr: Readable.from(['']), wait: async () => 0, kill: async () => undefined, dispose: async () => undefined };
    }
    const urlLiteral = /^await import\((".*")\)$/.exec(evalArg)?.[1];
    const href = urlLiteral === undefined ? '' : JSON.parse(urlLiteral) as string;
    const filePath = href === '' ? '' : join(fileURLToPath(href));
    const source = files.get(filePath) ?? [...files.entries()].find(([key]) => key.toLowerCase() === filePath.toLowerCase())?.[1] ?? '';
    if (source.trim() === 'console.log("kiki-ego-ready");') {
      return { pid: 1, exitCode: 0, stdin: Readable.from([]), stdout: Readable.from(['kiki-ego-ready\n']), stderr: Readable.from(['']), wait: async () => 0, kill: async () => undefined, dispose: async () => undefined };
    }
    const outcome = await sim.runModule(source);
    return {
      pid: 1, exitCode: outcome.code, stdin: Readable.from([]),
      stdout: Readable.from([outcome.stdout]), stderr: Readable.from([outcome.stderr]),
      wait: async () => outcome.code, kill: async () => undefined, dispose: async () => undefined,
    };
  });
  return { spawn } as unknown as IHostProcessService;
}

describe('Ego Lite numeric spaceId liveness and zombie-window prevention', () => {
  it('coerces numeric spaceId strings and rejects non-numeric spaceIds', () => {
    expect(egoNumericSpaceId(177)).toBe(177);
    expect(egoNumericSpaceId('177')).toBe(177);
    expect(egoNumericSpaceId(' 0 ')).toBe(0);
    expect(egoNumericSpaceId('space-1')).toBeUndefined();
    expect(egoNumericSpaceId('-7')).toBeUndefined();
    expect(egoNumericSpaceId('12.5')).toBeUndefined();
    expect(egoNumericSpaceId('')).toBeUndefined();
    expect(egoNumericSpaceId(undefined)).toBeUndefined();
  });

  it('reattaches a live space numerically and recreates under Kiki name when numeric spaceId 177 was closed', async () => {
    const sessionDir = 'C:/session';
    const spaceFile = join(sessionDir, 'browser-ego-spaces.json');
    const expectedName = egoSpaceName('s', 'a');
    const profileConnection = { ...connection, profileId: 'Profile 10' };
    const sim = createEgoSimulator([
      { id: 177, name: expectedName, profileId: 'Profile 10', ownership: 'agent', closed: false, tabs: [{ targetId: 't-177', label: 'p1', url: 'https://example.com', openedBy: 'agent' }] },
      { id: 153, name: 'other-user-space', profileId: 'Profile 6', ownership: 'agentDelegatedToUser', closed: false, tabs: [{ targetId: 't-153', url: 'https://example.test', openedBy: 'unknown' }] },
    ]);
    const { files, fs } = memoryFs([versioned]);
    files.set(spaceFile, `${JSON.stringify({ a: { connectionId: 'ego-lite', name: expectedName, spaceId: '177' } })}\n`);
    const runtime = new EgoBrowserRuntime(simulatedProcessService(files, sim), fs, { PATH: '' }, 'linux');

    const attached = await runtime.runAgent({
      connection: profileConnection, sessionDir, sessionId: 's', agentId: 'a', label: 'p1',
      body: 'await page.goto("https://example.com/one"); console.log(task.spaceId);',
    });
    expect(attached.result.code).toBe(0);
    expect(attached.binding.spaceId).toBe('177');
    expect(sim.taskSpaceCalls).toEqual([{ target: 177, options: undefined }]);
    expect(sim.taskSpaceCalls.some((call) => call.target === '177')).toBe(false);

    sim.spaces.get(177)!.closed = true;
    sim.taskSpaceCalls.length = 0;

    const recreated = await runtime.runAgent({
      connection: profileConnection, sessionDir, sessionId: 's', agentId: 'a',
      body: 'const p = await task.newPage(); await p.goto("https://example.com/recreated"); console.log(task.spaceId);',
    });
    expect(recreated.result.code).toBe(0);
    expect(sim.taskSpaceCalls).toEqual([{ target: expectedName, options: { profileId: 'Profile 10' } }]);
    expect(sim.taskSpaceCalls.some((call) => call.target === '177' || call.target === 177)).toBe(false);
    expect([...sim.spaces.values()].some((space) => space.name === '177')).toBe(false);
    expect(recreated.binding.spaceId).toBe('201');
    expect(JSON.parse(files.get(spaceFile) ?? '{}')).toEqual({
      a: { connectionId: 'ego-lite', name: expectedName, spaceId: '201' },
    });
  });

  it('reattaches by numeric id when the Kiki space name already exists on a profileId connection and preserves user-control errors', async () => {
    const sessionDir = 'C:/session';
    const expectedName = egoSpaceName('s', 'a');
    const profileConnection = { ...connection, profileId: 'Profile 10' };
    const sim = createEgoSimulator([
      { id: 88, name: expectedName, profileId: 'Profile 10', ownership: 'agent', closed: false, tabs: [{ targetId: 't-88', url: 'chrome://newtab/', openedBy: 'unknown' }] },
    ]);
    const { files, fs } = memoryFs([versioned]);
    const runtime = new EgoBrowserRuntime(simulatedProcessService(files, sim), fs, { PATH: '' }, 'linux');

    const attached = await runtime.runAgent({
      connection: profileConnection, sessionDir, sessionId: 's', agentId: 'a',
      body: 'console.log(task.spaceId);',
    });
    expect(attached.result.code).toBe(0);
    expect(attached.binding.spaceId).toBe('88');
    expect(sim.taskSpaceCalls).toEqual([{ target: 88, options: undefined }]);

    sim.spaces.get(88)!.ownership = 'agentDelegatedToUser';
    await expect(runtime.runAgent({
      connection: profileConnection, sessionDir, sessionId: 's', agentId: 'a',
      body: 'console.log(task.spaceId);',
    })).rejects.toMatchObject({ code: 'browser.execution_failed', message: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
  });
});

describe('Ego Lite lazy script binding and subagent disposal cleanup', () => {
  it('detects free task/page bindings accurately across comments, strings, regexes, member access, object keys, arrows, and shadowing', () => {
    expect(analyzeEgoScriptBindings('const s = await taskSpace("tmp", { profileId: "Profile 6" }); const p = s.page("main");')).toMatchObject({
      usesFreeTask: false, usesFreePage: false, declaresTopLevelTask: false, declaresTopLevelPage: false,
    });
    expect(analyzeEgoScriptBindings('const s = await ego.taskSpace({ name: "tmp", profileId: "Profile 6" });')).toMatchObject({
      usesFreeTask: false, usesFreePage: false,
    });
    expect(analyzeEgoScriptBindings('const task = await taskSpace("custom"); const page = task.page("p1"); await page.goto("https://example.com");')).toMatchObject({
      usesFreeTask: false, usesFreePage: false, declaresTopLevelTask: true, declaresTopLevelPage: true,
    });
    expect(analyzeEgoScriptBindings('const found = (await listTaskSpaces()).find((task) => !task.closed); console.log({ task: found, page: 1 }); if (found) /task|page/.test("task");')).toMatchObject({
      usesFreeTask: false, usesFreePage: false,
    });
    expect(analyzeEgoScriptBindings('const page = task.page("p1"); await page.goto("https://example.com");')).toMatchObject({
      usesFreeTask: true, usesFreePage: false, declaresTopLevelTask: false, declaresTopLevelPage: true,
    });
    expect(analyzeEgoScriptBindings('await page.goto("https://example.com");')).toMatchObject({
      usesFreeTask: false, usesFreePage: true, declaresTopLevelPage: false,
    });
    expect(analyzeEgoScriptBindings('console.log(`${task.spaceId}`);')).toMatchObject({
      usesFreeTask: true,
    });
  });

  it('does not open a default kiki-* window when a script manages its own profileId space and cleans pure blank tabs on finish', async () => {
    const sessionDir = 'C:/session';
    const sim = createEgoSimulator();
    const { files, fs } = memoryFs([versioned]);
    const runtime = new EgoBrowserRuntime(simulatedProcessService(files, sim), fs, { PATH: '' }, 'linux');

    const customFinished = await runtime.runAgent({
      connection, sessionDir, sessionId: 's', agentId: 'sub-1',
      body: [
        'const custom = await taskSpace("tmp-p10-check", { profileId: "Profile 10" });',
        'try {',
        '  const p = await custom.newPage();',
        '  await p.goto("https://example.com/check");',
        '} finally {',
        '  await custom.finish({ keep: [] });',
        '}',
      ].join('\n'),
    });
    expect(customFinished.result.code).toBe(0);
    expect(sim.taskSpaceCalls).toEqual([{ target: 'tmp-p10-check', options: { profileId: 'Profile 10' } }]);
    expect([...sim.spaces.values()].some((space) => space.name.startsWith('kiki-'))).toBe(false);
    expect([...sim.spaces.values()].every((space) => space.closed)).toBe(true);
    expect(sim.cdpCalls).toEqual([{ spaceId: 201, method: 'Target.closeTarget', params: { targetId: 'nt-201' } }]);
    expect(files.has(join(sessionDir, 'browser-ego-spaces.json'))).toBe(false);

    const egoNamespaceRun = await runtime.runAgent({
      connection, sessionDir, sessionId: 's', agentId: 'sub-2', label: 'p1',
      body: [
        'const custom = await ego.taskSpace({ name: "tmp-ego-ns", profileId: "Profile 6" });',
        'await custom.finish({ keep: [] });',
      ].join('\n'),
    });
    expect(egoNamespaceRun.result.code).toBe(0);
    expect([...sim.spaces.values()].some((space) => space.name.startsWith('kiki-'))).toBe(false);
    expect([...sim.spaces.values()].every((space) => space.closed)).toBe(true);

    const shadowedPageRun = await runtime.runAgent({
      connection, sessionDir, sessionId: 's', agentId: 'main', label: 'p1',
      body: 'const page = await task.newPage(); await page.goto("https://example.com/main"); console.log(await page.title());',
    });
    expect(shadowedPageRun.result.code).toBe(0);
    expect(shadowedPageRun.binding.spaceId).toBe('203');
  });

  it('never closes non-blank unknown user tabs during finish({ keep: [] })', async () => {
    const sessionDir = 'C:/session';
    const expectedName = egoSpaceName('s', 'a');
    const sim = createEgoSimulator([{
      id: 55,
      name: expectedName,
      ownership: 'agent',
      closed: false,
      tabs: [
        { targetId: 'user-doc', url: 'https://example.com/user-work', openedBy: 'unknown', active: true },
        { targetId: 'agent-tab', label: 'p1', url: 'https://example.com/agent', openedBy: 'agent', active: false },
      ],
    }]);
    const { files, fs } = memoryFs([versioned]);
    files.set(join(sessionDir, 'browser-ego-spaces.json'), `${JSON.stringify({ a: { connectionId: 'ego-lite', name: expectedName, spaceId: '55' } })}\n`);
    const runtime = new EgoBrowserRuntime(simulatedProcessService(files, sim), fs, { PATH: '' }, 'linux');
    const ran = await runtime.runAgent({
      connection, sessionDir, sessionId: 's', agentId: 'a',
      body: 'await task.finish({ keep: [] });',
    });
    expect(ran.result.code).toBe(0);
    expect(sim.cdpCalls).toEqual([]);
    expect(sim.spaces.get(55)?.closed).toBe(false);
    expect(sim.spaces.get(55)?.tabs.map((tab) => tab.targetId)).toEqual(['user-doc']);
  });

  it('cleans up subagent-owned default and custom Ego spaces on subagent disposal while keeping main, user, and delegated spaces open', async () => {
    const defaults = createDecorator<{ readonly _serviceBrand: undefined; ready: Promise<string | undefined> }>('sessionBrowserDefault');
    const sessionDir = 'C:/session';
    const sim = createEgoSimulator([
      { id: 10, name: 'user-personal-space', ownership: 'user', closed: false, tabs: [{ targetId: 'nt-10', url: 'chrome://newtab/', openedBy: 'unknown' }] },
      { id: 11, name: 'delegated-3d-studio', ownership: 'agentDelegatedToUser', closed: false, tabs: [{ targetId: 'nt-11', url: 'chrome://newtab/', openedBy: 'unknown' }] },
    ]);
    const { files, fs } = memoryFs([versioned]);
    const configs = new Map<string, BrowserResolvedConnection>([['ego-lite', connection]]);
    const appIx = new TestInstantiationService();
    appIx.stub(IFlagService, { enabled: () => true });
    appIx.stub(IHostProcessService, simulatedProcessService(files, sim));
    appIx.stub(IHostFileSystem, fs);
    appIx.stub(IBrowserBackendFactory, { open: vi.fn() });
    appIx.stub(IBrowserConnectionStore, {
      list: async () => ({ connections: [browserConnectionRecord(connection)], defaultBrowser: 'ego-lite' }),
      resolve: async (id: string) => {
        const found = configs.get(id);
        if (found === undefined) throw new BrowserError('browser.not_found', id);
        return found;
      },
      upsert: async () => browserConnectionRecord(connection),
      remove: async () => undefined,
      setDefault: async () => undefined,
      revealEndpoint: async () => undefined,
    });
    appIx.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = appIx.get(IBrowserControlService);

    const makeAgentService = (agentId: string) => {
      const agentIx = new TestInstantiationService();
      const fakeRuntime = new FakeRuntime({ workspaceId: 'w', runtimeId: 'local', generation: '1' }, { pathClass: 'win32' });
      agentIx.stub(IBrowserControlService, control);
      agentIx.stub(IBrowserConnectionStore, appIx.get(IBrowserConnectionStore));
      agentIx.stub(defaults, { ready: Promise.resolve('ego-lite') });
      agentIx.stub(IAgentScopeContext, { agentId });
      agentIx.stub(ISessionContext, { sessionId: 's', sessionDir });
      agentIx.stub(ISessionWorkspaceContext, { workDir: sessionDir, additionalDirs: [] });
      agentIx.stub(IAgentRuntimeService, { inspect: () => fakeRuntime, prepareFor: async () => fakeRuntime });
      agentIx.stub(ISessionMediaStore, {});
      agentIx.stub(ISessionInteractionService, { hasConsumer: () => false });
      agentIx.stub(IFlagService, { enabled: () => true });
      agentIx.stub(IConfigService, { get: <T>() => ({ connections: { 'ego-lite': connection } }) as T });
      agentIx.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
      agentIx.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
      agentIx.set(IEventBus, new SyncDescriptor(EventBusService));
      agentIx.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
      return { agentIx, browser: agentIx.get(IAgentBrowserService) as AgentBrowserService };
    };

    const mainScope = makeAgentService('main');
    const subScope = makeAgentService('agent-7');
    try {
      expect((await control.connect('ego-lite')).state).toBe('ready');
      const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };

      const mainRun = await mainScope.browser.egoRun({
        browser: 'ego-lite',
        script: 'const p = await task.newPage(); await p.goto("https://example.com/main-dashboard");',
      }, ctx.signal, ctx);
      expect(mainRun.isError, JSON.stringify(mainRun.output)).not.toBe(true);

      const subDefaultRun = await subScope.browser.egoRun({
        browser: 'ego-lite',
        script: 'const p = await task.newPage(); await p.goto("https://example.com/sub-work");',
      }, ctx.signal, ctx);
      expect(subDefaultRun.isError).not.toBe(true);

      const subCustomRun = await subScope.browser.egoRun({
        browser: 'ego-lite',
        script: 'const leaked = await taskSpace("sub-unfinished-p6", { profileId: "Profile 6" }); console.log(leaked.spaceId);',
      }, ctx.signal, ctx);
      expect(subCustomRun.isError).not.toBe(true);

      const mainSpace = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'main'))!;
      const subDefaultSpace = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'agent-7'))!;
      const subCustomSpace = [...sim.spaces.values()].find((space) => space.name === 'sub-unfinished-p6')!;
      expect(mainSpace.closed).toBe(false);
      expect(subDefaultSpace.closed).toBe(false);
      expect(subCustomSpace.closed).toBe(false);

      await subScope.browser.dispose();

      expect(subDefaultSpace.closed).toBe(true);
      expect(subCustomSpace.closed).toBe(true);
      expect(mainSpace.closed).toBe(false);
      expect(sim.spaces.get(10)?.closed).toBe(false);
      expect(sim.spaces.get(11)?.closed).toBe(false);
      const savedAfterSub = JSON.parse(files.get(join(sessionDir, 'browser-ego-spaces.json')) ?? '{}') as Record<string, unknown>;
      expect(savedAfterSub['agent-7']).toBeUndefined();
      expect(savedAfterSub['main']).toMatchObject({ spaceId: String(mainSpace.id) });

      await mainScope.browser.dispose();
      expect(mainSpace.closed).toBe(false);
      const savedAfterMain = JSON.parse(files.get(join(sessionDir, 'browser-ego-spaces.json')) ?? '{}') as Record<string, unknown>;
      expect(savedAfterMain['main']).toMatchObject({ spaceId: String(mainSpace.id) });
    } finally {
      await subScope.agentIx.dispose();
      await mainScope.agentIx.dispose();
      await appIx.dispose();
    }
  });

  it('releases idle subagent Ego spaces immediately on TurnEnded while resident, keeping main, branches, queued follow-ups, and delegated spaces', async () => {
    const defaults = createDecorator<{ readonly _serviceBrand: undefined; ready: Promise<string | undefined> }>('sessionBrowserDefault');
    const sessionDir = 'C:/session';
    const sim = createEgoSimulator();
    const { files, fs } = memoryFs([versioned]);
    const configs = new Map<string, BrowserResolvedConnection>([['ego-lite', connection]]);
    const appIx = new TestInstantiationService();
    appIx.stub(IFlagService, { enabled: () => true });
    appIx.stub(IHostProcessService, simulatedProcessService(files, sim));
    appIx.stub(IHostFileSystem, fs);
    appIx.stub(IBrowserBackendFactory, { open: vi.fn() });
    appIx.stub(IBrowserConnectionStore, {
      list: async () => ({ connections: [browserConnectionRecord(connection)], defaultBrowser: 'ego-lite' }),
      resolve: async (id: string) => {
        const found = configs.get(id);
        if (found === undefined) throw new BrowserError('browser.not_found', id);
        return found;
      },
      upsert: async () => browserConnectionRecord(connection),
      remove: async () => undefined,
      setDefault: async () => undefined,
      revealEndpoint: async () => undefined,
    });
    appIx.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = appIx.get(IBrowserControlService);

    const makeResidentAgent = (options: {
      readonly agentId: string;
      readonly isBranch?: boolean;
      readonly metadataBranch?: boolean;
      readonly hasQueued?: () => boolean;
      readonly isActive?: () => boolean;
      readonly loopSettled?: () => Promise<void>;
    }) => {
      const agentIx = new TestInstantiationService();
      const fakeRuntime = new FakeRuntime({ workspaceId: 'w', runtimeId: 'local', generation: '1' }, { pathClass: 'win32' });
      agentIx.stub(IBrowserControlService, control);
      agentIx.stub(IBrowserConnectionStore, appIx.get(IBrowserConnectionStore));
      agentIx.stub(defaults, { ready: Promise.resolve('ego-lite') });
      agentIx.stub(IAgentScopeContext, { agentId: options.agentId, isBranch: options.isBranch });
      agentIx.stub(ISessionContext, { sessionId: 's', sessionDir });
      agentIx.stub(ISessionWorkspaceContext, { workDir: sessionDir, additionalDirs: [] });
      agentIx.stub(IAgentRuntimeService, { inspect: () => fakeRuntime, prepareFor: async () => fakeRuntime });
      agentIx.stub(ISessionMediaStore, {});
      agentIx.stub(ISessionInteractionService, { hasConsumer: () => false });
      agentIx.stub(IFlagService, { enabled: () => true });
      agentIx.stub(IConfigService, { get: <T>() => ({ connections: { 'ego-lite': connection } }) as T });
      agentIx.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
      agentIx.stub(ISessionMetadata, {
        snapshot: () => ({
          id: 's',
          createdAt: 1,
          updatedAt: 1,
          archived: false,
          agents: options.metadataBranch === true
            ? { [options.agentId]: { type: 'main', labels: { branch: 'true' } } }
            : { [options.agentId]: { type: options.agentId === 'main' ? 'main' : 'sub' } },
        }),
      });
      agentIx.stub(IAgentLoopService, {
        settled: () => options.loopSettled?.() ?? Promise.resolve(),
        status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false, activeTurnId: undefined, finalizing: false }),
      });
      const activePlaceholder = { id: 'p-finishing' } as PromptSnapshot;
      const queuedPlaceholder = { id: 'p-next' } as PromptSnapshot;
      agentIx.stub(IAgentPromptService, {
        hasQueuedWork: () => options.hasQueued?.() === true,
        list: () => ({
          active: options.isActive?.() === true ? activePlaceholder : undefined,
          pending: options.hasQueued?.() === true ? [queuedPlaceholder] : [],
        }),
      });
      agentIx.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
      agentIx.set(IEventBus, new SyncDescriptor(EventBusService));
      agentIx.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
      return {
        agentIx,
        bus: agentIx.get(IEventBus),
        browser: agentIx.get(IAgentBrowserService) as AgentBrowserService,
      };
    };

    let subHasQueuedFollowUp = true;
    let subActiveDuringFinalization = false;
    const mainScope = makeResidentAgent({ agentId: 'main' });
    const branchScope = makeResidentAgent({ agentId: 'agent-branch-1', isBranch: true });
    const metadataBranchScope = makeResidentAgent({ agentId: 'agent-branch-2', metadataBranch: true });
    const subScope = makeResidentAgent({
      agentId: 'agent-9',
      hasQueued: () => subHasQueuedFollowUp,
      isActive: () => subActiveDuringFinalization,
      loopSettled: async () => {
        await Promise.resolve();
        subActiveDuringFinalization = false;
      },
    });
    const delegatedSubScope = makeResidentAgent({ agentId: 'agent-10' });

    try {
      expect((await control.connect('ego-lite')).state).toBe('ready');
      const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };

      await mainScope.browser.egoRun({ browser: 'ego-lite', script: 'const p = await task.newPage(); await p.goto("https://example.com/main");' }, ctx.signal, ctx);
      await branchScope.browser.egoRun({ browser: 'ego-lite', script: 'const p = await task.newPage(); await p.goto("https://example.com/branch-1");' }, ctx.signal, ctx);
      await metadataBranchScope.browser.egoRun({ browser: 'ego-lite', script: 'const p = await task.newPage(); await p.goto("https://example.com/branch-2");' }, ctx.signal, ctx);
      await subScope.browser.egoRun({ browser: 'ego-lite', script: 'const p = await task.newPage(); await p.goto("https://example.com/sub-turn-1");' }, ctx.signal, ctx);

      const mainSpace = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'main'))!;
      const branchSpace = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'agent-branch-1'))!;
      const metadataBranchSpace = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'agent-branch-2'))!;
      const subSpaceTurn1 = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'agent-9'))!;

      mainScope.bus.publish(new TurnEnded({ turnId: 1, reason: 'completed' }));
      branchScope.bus.publish(new TurnEnded({ turnId: 1, reason: 'completed' }));
      metadataBranchScope.bus.publish(new TurnEnded({ turnId: 1, reason: 'completed' }));
      subScope.bus.publish(new TurnEnded({ turnId: 1, reason: 'completed' }));
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });

      expect(mainSpace.closed).toBe(false);
      expect(branchSpace.closed).toBe(false);
      expect(metadataBranchSpace.closed).toBe(false);
      expect(subSpaceTurn1.closed).toBe(false);

      const reuseInTurn2 = await subScope.browser.egoRun({
        browser: 'ego-lite',
        script: 'await task.page("p1").goto("https://example.com/sub-turn-2");',
      }, ctx.signal, { ...ctx, turnId: 2 });
      expect(reuseInTurn2.isError).not.toBe(true);
      expect([...sim.spaces.values()].filter((space) => space.name === egoSpaceName('s', 'agent-9'))).toHaveLength(1);

      subHasQueuedFollowUp = false;
      subActiveDuringFinalization = true;
      subScope.bus.publish(new TurnEnded({ turnId: 2, reason: 'completed' }));
      await vi.waitFor(() => {
        expect(subSpaceTurn1.closed).toBe(true);
      });
      expect(mainSpace.closed).toBe(false);
      expect(branchSpace.closed).toBe(false);
      expect(metadataBranchSpace.closed).toBe(false);
      const savedAfterTurn2 = JSON.parse(files.get(join(sessionDir, 'browser-ego-spaces.json')) ?? '{}') as Record<string, unknown>;
      expect(savedAfterTurn2['agent-9']).toBeUndefined();
      expect(savedAfterTurn2['main']).toMatchObject({ spaceId: String(mainSpace.id) });
      expect(savedAfterTurn2['agent-branch-1']).toMatchObject({ spaceId: String(branchSpace.id) });
      expect(savedAfterTurn2['agent-branch-2']).toMatchObject({ spaceId: String(metadataBranchSpace.id) });

      const resumedTurn3 = await subScope.browser.egoRun({
        browser: 'ego-lite',
        script: 'const p = await task.newPage(); await p.goto("https://example.com/sub-resumed");',
      }, ctx.signal, { ...ctx, turnId: 3 });
      expect(resumedTurn3.isError).not.toBe(true);
      const subSpaceTurn3 = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'agent-9') && !space.closed)!;
      expect(subSpaceTurn3).toBeDefined();
      expect(subSpaceTurn3.id).not.toBe(subSpaceTurn1.id);

      subScope.bus.publish(new TurnEnded({ turnId: 3, reason: 'completed' }));
      await vi.waitFor(() => {
        expect(subSpaceTurn3.closed).toBe(true);
      });

      await delegatedSubScope.browser.egoRun({
        browser: 'ego-lite',
        script: 'const p = await task.newPage(); await p.goto("https://example.com/login"); const scratch = await taskSpace("sub-scratch-space"); console.log(scratch.spaceId);',
      }, ctx.signal, ctx);
      const delegatedPrimary = [...sim.spaces.values()].find((space) => space.name === egoSpaceName('s', 'agent-10'))!;
      const delegatedScratch = [...sim.spaces.values()].find((space) => space.name === 'sub-scratch-space')!;
      delegatedPrimary.ownership = 'agentDelegatedToUser';

      delegatedSubScope.bus.publish(new TurnEnded({ turnId: 1, reason: 'completed' }));
      await vi.waitFor(() => {
        expect(delegatedScratch.closed).toBe(true);
      });
      expect(delegatedPrimary.closed).toBe(false);
      const savedAfterDelegated = JSON.parse(files.get(join(sessionDir, 'browser-ego-spaces.json')) ?? '{}') as Record<string, unknown>;
      expect(savedAfterDelegated['agent-10']).toEqual({
        connectionId: 'ego-lite',
        name: egoSpaceName('s', 'agent-10'),
        spaceId: String(delegatedPrimary.id),
      });
    } finally {
      await delegatedSubScope.agentIx.dispose();
      await subScope.agentIx.dispose();
      await metadataBranchScope.agentIx.dispose();
      await branchScope.agentIx.dispose();
      await mainScope.agentIx.dispose();
      await appIx.dispose();
    }
  });
});

describe('Ego Lite runAgent execution timeout and process-tree abort', () => {
  it('enforces the default execution timeout, terminates the owned process tree, and surfaces partial diagnostics', async () => {
    vi.useFakeTimers();
    const { fs } = memoryFs([versioned]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(async () => { stdout.destroy(); stderr.destroy(); });
    const dispose = vi.fn(async () => {});
    const spawn = vi.fn(async () => ({ pid: 74680, exitCode: null, stdin: Readable.from([]), stdout, stderr, wait: () => new Promise<number>(() => {}), kill, dispose }));
    const runtime = new EgoBrowserRuntime({ spawn } as unknown as IHostProcessService, fs, { PATH: '' }, 'linux');
    const observed = runtime.runAgent({
      connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a',
      body: 'await page.goto("https://example.com");', label: 'p1',
    }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledWith(versioned, expect.any(Array), expect.objectContaining({
        shell: false,
        windowsHide: true,
        ownedProcessTree: true,
      }));
      stderr.write('Waiting on unresponsive space 166\n    at file:///C:/Temp/ego-scripts/hung.mjs:1:1');
      await vi.advanceTimersByTimeAsync(EGO_RUN_TIMEOUT_MS - 1);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const error = await observed;
      expect(error).toBeInstanceOf(EgoRunTimeoutError);
      expect(error).toMatchObject({
        code: 'browser.execution_failed',
        message: `Ego Lite script timed out after ${String(EGO_RUN_TIMEOUT_MS)}ms: Waiting on unresponsive space 166`,
      });
      expect(kill).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      stdout.destroy();
      stderr.destroy();
      vi.useRealTimers();
    }
  });

  it('supports env/explicit timeout overrides and settles caller AbortSignal even when wait() never resolves', async () => {
    vi.useFakeTimers();
    const { fs } = memoryFs([versioned]);
    const killA = vi.fn(async () => {});
    const disposeA = vi.fn(async () => {});
    const killB = vi.fn(async () => {});
    const disposeB = vi.fn(async () => {});
    let callCount = 0;
    const spawn = vi.fn(async () => {
      callCount += 1;
      const first = callCount === 1;
      return {
        pid: callCount, exitCode: null, stdin: Readable.from([]),
        stdout: new PassThrough(), stderr: new PassThrough(),
        wait: () => new Promise<number>(() => {}),
        kill: first ? killA : killB,
        dispose: first ? disposeA : disposeB,
      };
    });
    const runtime = new EgoBrowserRuntime({ spawn } as unknown as IHostProcessService, fs, { PATH: '', KIKI_EGO_RUN_TIMEOUT_MS: '3500' }, 'linux');
    try {
      const envTimed = runtime.runAgent({ connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'a', body: 'console.log(1)' }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(3_499);
      expect(killA).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await envTimed).toMatchObject({ code: 'browser.execution_failed', message: 'Ego Lite script timed out after 3500ms' });
      expect(killA).toHaveBeenCalledOnce();
      expect(disposeA).toHaveBeenCalledOnce();

      const caller = new AbortController();
      const abortReason = new Error('caller aborted hung ego-browser');
      const aborted = runtime.runAgent({
        connection, sessionDir: 'C:/session', sessionId: 's', agentId: 'b',
        body: 'console.log(2)', signal: caller.signal, timeoutMs: 60_000,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      caller.abort(abortReason);
      expect(await aborted).toBe(abortReason);
      expect(killB).toHaveBeenCalledOnce();
      expect(disposeB).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pluginStore from '#/app/plugin/store';

import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginService } from '#/app/plugin/pluginService';
import { IPluginHostService, PluginHostService } from '#/app/plugin/pluginHostService';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { LifecycleScope } from '#/app/scopes';
import { IProviderService } from '#/kosong/provider/provider';
import { IAgentPluginToolService, AgentPluginToolService } from '#/agent/userTool/pluginToolService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { PluginTool } from '#/app/plugin/contributions';
import type { RunnableToolExecution, ToolUpdate } from '#/tool/toolContract';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';

const scratch = fileURLToPath(new URL('../../../../../.tmp/plugin-live-reload/', import.meta.url));
let root: string;
let host: ScopedTestHost;
const cleanups: (() => Promise<void>)[] = [];

async function daemonCommands(plugins: IPluginService) {
  const modulePath = fileURLToPath(new URL('../../../../../apps/kimi-code/src/tui/daemon/daemon-tui.ts', import.meta.url));
  const { DaemonTUI } = await import(modulePath);
  const { DEFAULT_TUI_CONFIG } = await import(fileURLToPath(new URL('../../../../../apps/kimi-code/src/tui/config.ts', import.meta.url)));
  const tui = new DaemonTUI({ url: 'http://127.0.0.1:1', token: 'fixture-token' }, {
    cliOptions: { continue: false, yolo: false, auto: false, plan: false, agentFiles: [], skillsDirs: [] },
    tuiConfig: DEFAULT_TUI_CONFIG, version: '0.0.0-test', workDir: root,
  });
  const internal = tui as {
    client: { klient: { global: { plugins: unknown; config: { reload(): Promise<void> } }; close(): Promise<void> } };
    controller: { sessionId: string; resync(): Promise<void> };
    handleSlash(command: string): Promise<void>;
    refreshAgentCommands(): Promise<void>;
    refreshSkillCommands(sessionId: string): Promise<void>;
    showStatus(text: string): void;
    state: { footer: { dispose(): void } };
  };
  const original = internal.client.klient;
  internal.client.klient = {
    global: { plugins: {
      preview: (input: { source: string }) => plugins.previewPlugin(input),
      install: (input: Parameters<IPluginService['installPlugin']>[0]) => plugins.installPlugin(input),
      reload: () => plugins.reloadPlugins(),
    }, config: { reload: vi.fn(async () => {}) } },
    close: () => original.close(),
  };
  internal.controller = { sessionId: 'continuing-session', resync: vi.fn(async () => {}) };
  internal.refreshAgentCommands = vi.fn(async () => {});
  internal.refreshSkillCommands = vi.fn(async () => {});
  internal.showStatus = vi.fn();
  cleanups.push(async () => { internal.state.footer.dispose(); await internal.client.klient.close(); });
  return internal;
}

function definition(version: number): PluginTool {
  return {
    schemaVersion: 1, name: 'echo', description: `Echo v${version}`,
    parameters: { type: 'object', properties: { [version === 1 ? 'value' : 'message']: { type: 'string' } } },
    accesses: [{ kind: 'all' }], disclosure: 'inline',
  };
}

async function writePlugin(source: string, id: string, version: number) {
  await mkdir(source, { recursive: true });
  const tool = definition(version);
  await writeFile(path.join(source, 'kimi.plugin.json'), JSON.stringify({
    name: id, version: `${version}.0.0`,
    'x-kiki': { engines: { kiki: '^0.4.0' }, permissions: {}, entry: './entry.mjs', tools: [tool] },
  }));
  await writeFile(path.join(source, 'asset.txt'), `asset-v${version}`);
  await writeFile(path.join(source, 'entry.mjs'), `
import { access, readFile } from 'node:fs/promises';
export function register(api) {
  api.registerTool(${JSON.stringify(tool)}, async (args, ctx) => {
    ctx.progress({ kind: 'progress', text: 'started' });
    if (args.gate) {
      const until = Date.now() + 5000;
      while (await access(args.gate).then(() => false, () => true)) {
        if (Date.now() > until) throw new Error('fixture gate timed out');
        ctx.signal.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return { output: JSON.stringify({ version: ${version}, value: args.${version === 1 ? 'value' : 'message'}, pid: process.pid,
      asset: await readFile(new URL('./asset.txt', import.meta.url), 'utf8') }) };
  });
}
`);
}

async function install(plugins: IPluginService, source: string, consent?: boolean) {
  const plan = await plugins.previewPlugin({ source });
  await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent });
  return plan;
}

function liveAgent() {
  const session = host.child(LifecycleScope.Session, 'continuing-session');
  const agent = host.childOf(session, LifecycleScope.Agent, 'continuing-agent');
  return {
    registry: agent.accessor.get(IAgentToolRegistryService),
    pluginTools: agent.accessor.get(IAgentPluginToolService),
  };
}

async function invoke(registry: IAgentToolRegistryService, id: string, args: unknown, onUpdate?: (update: ToolUpdate) => void) {
  const tool = registry.resolve(`plugin__${id.replaceAll('-', '_')}__echo`)!;
  expect(tool).toBeDefined();
  const execution = await tool.resolveExecution(args) as RunnableToolExecution;
  expect(execution.accesses).toEqual([{ kind: 'all' }]);
  return execution.execute({ turnId: 1, toolCallId: 'continuing-call', signal: new AbortController().signal, onUpdate });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  _clearScopedRegistryForTests();
  registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.Agent, IAgentToolRegistryService, AgentToolRegistryService, ScopeActivation.OnDemand, 'toolRegistry');
  registerScopedService(LifecycleScope.Agent, IAgentPluginToolService, AgentPluginToolService, ScopeActivation.OnDemand, 'plugin');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, 'run-'));
  const runtime = new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' },
    { pathClass: process.platform === 'win32' ? 'win32' : 'posix' });
  Object.assign(runtime, { fs: new HostFileSystem() });
  host = createScopedTestHost([
    stubPair(IBootstrapService, stubBootstrap(path.join(root, 'home'))),
    stubPair(IProviderService, stubProviderService()),
    stubPair(IConfigService, { _serviceBrand: undefined, ready: Promise.resolve(), get: () => ({}), replace: async () => {} } as unknown as IConfigService),
    stubPair(ISkillDiscovery, { _serviceBrand: undefined, discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }) } satisfies ISkillDiscovery),
    stubPair(IAgentRuntimeService, { inspect: () => runtime, acquire: () => ({ runtime, dispose() {} }) } as unknown as IAgentRuntimeService),
    stubPair(ISessionWorkspaceContext, { workDir: root, additionalDirs: [] } as unknown as ISessionWorkspaceContext),
    stubPair(IAgentProfileService, { getModelCapabilities: () => ({ image_in: true }) } as unknown as IAgentProfileService),
  ]);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  host?.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

describe('plugin changes in an existing live agent', () => {
  it('installs, enables, applies source and schema edits, disables and removes without recreating the agent', async () => {
    const plugins = host.app.accessor.get(IPluginService);
    const { registry, pluginTools } = liveAgent();
    await pluginTools.ready();
    expect(registry.list()).toEqual([]);
    const source = path.join(root, 'source');
    await writePlugin(source, 'live-tool', 1);
    const first = await install(plugins, source, true);
    expect(first.consentRequired).toBe(true);
    expect(registry.list()).toEqual([]);
    await plugins.setPluginEnabled({ id: 'live-tool', enabled: true });
    expect(registry.list()).toMatchObject([{ name: 'plugin__live_tool__echo', description: 'Echo v1', parameters: definition(1).parameters }]);
    const v1 = await invoke(registry, 'live-tool', { value: 'first' });
    expect(JSON.parse(String(v1.output))).toMatchObject({ version: 1, value: 'first', asset: 'asset-v1' });
    const oldExecution = await registry.resolve('plugin__live_tool__echo')!.resolveExecution({ value: 'stale' }) as RunnableToolExecution;
    await writePlugin(source, 'live-tool', 2);
    await plugins.reloadPlugins();
    expect(registry.list()[0]?.parameters).toEqual(definition(1).parameters);
    expect(JSON.parse(String((await invoke(registry, 'live-tool', { value: 'managed' })).output))).toMatchObject({ version: 1 });
    const update = await install(plugins, source);
    expect(update.consentRequired).toBe(false);
    expect(registry.list()[0]?.parameters).toEqual(definition(2).parameters);
    expect(JSON.parse(String((await invoke(registry, 'live-tool', { message: 'next' })).output))).toMatchObject({ version: 2, value: 'next', asset: 'asset-v2' });
    await expect(oldExecution.execute({ turnId: 1, toolCallId: 'stale-call', signal: new AbortController().signal })).rejects.toThrow('changed');
    const managed = (await plugins.getPluginInfo({ id: 'live-tool' })).root;
    await writeFile(path.join(source, 'kimi.plugin.json'), '{bad manifest');
    await expect(plugins.previewPlugin({ source })).rejects.toThrow();
    expect(await readFile(path.join(managed, 'asset.txt'), 'utf8')).toBe('asset-v2');
    expect(JSON.parse(String((await invoke(registry, 'live-tool', { message: 'still works' })).output))).toMatchObject({ version: 2 });
    await plugins.setPluginEnabled({ id: 'live-tool', enabled: false });
    expect(registry.resolve('plugin__live_tool__echo')).toBeUndefined();
    await expect(host.app.accessor.get(IPluginHostService).execute('live-tool', 'echo', {}, new AbortController().signal)).rejects.toThrow('not enabled');
    await plugins.setPluginEnabled({ id: 'live-tool', enabled: true });
    expect(JSON.parse(String((await invoke(registry, 'live-tool', { message: 'again' })).output))).toMatchObject({ version: 2 });
    await plugins.removePlugin({ id: 'live-tool' });
    expect(registry.resolve('plugin__live_tool__echo')).toBeUndefined();
    await expect(host.app.accessor.get(IPluginHostService).execute('live-tool', 'echo', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'plugin.not_found' });
  });

  it('finishes a started v1 call before replacing its files while another plugin keeps the same host', async () => {
    const plugins = host.app.accessor.get(IPluginService);
    const { registry, pluginTools } = liveAgent();
    await pluginTools.ready();
    const source = path.join(root, 'source');
    const other = path.join(root, 'other');
    await writePlugin(source, 'live-tool', 1);
    await writePlugin(other, 'other-tool', 1);
    await install(plugins, source, true);
    await plugins.setPluginEnabled({ id: 'live-tool', enabled: true });
    await install(plugins, other, true);
    await plugins.setPluginEnabled({ id: 'other-tool', enabled: true });
    const daemon = await daemonCommands(plugins);
    const otherPid = JSON.parse(String((await invoke(registry, 'other-tool', { value: 'before' })).output)).pid;
    const started = deferred();
    const gate = path.join(root, 'release');
    const active = invoke(registry, 'live-tool', { value: 'in flight', gate }, () => started.resolve());
    const activeResult = active.then((value) => value, (error: unknown) => error);
    await started.promise;
    await writePlugin(source, 'live-tool', 2);
    const changing = deferred();
    const listener = plugins.onWillChange(() => changing.resolve());
    let applied = false;
    const update = daemon.handleSlash(`/plugins install ${source}`).then(() => { applied = true; });
    await changing.promise;
    listener.dispose();
    expect(applied).toBe(false);
    expect(registry.list().find((tool) => tool.name === 'plugin__live_tool__echo')?.parameters).toEqual(definition(1).parameters);
    let queuedStarted = false;
    const queued = invoke(registry, 'live-tool', { value: 'queued' }, () => { queuedStarted = true; })
      .then((value) => value, (error: unknown) => error);
    const during = await invoke(registry, 'other-tool', { value: 'during' });
    expect(JSON.parse(String(during.output))).toMatchObject({ pid: otherPid, value: 'during' });
    expect(queuedStarted).toBe(false);
    await writeFile(gate, 'release');
    const result = await activeResult;
    expect(result).not.toBeInstanceOf(Error);
    expect(JSON.parse(String((result as { output: string }).output))).toMatchObject({ version: 1, value: 'in flight', asset: 'asset-v1' });
    await update;
    expect(await queued).toMatchObject({ message: expect.stringContaining('definition changed') });
    expect(queuedStarted).toBe(false);
    expect(applied).toBe(true);
    expect(registry.list().find((tool) => tool.name === 'plugin__live_tool__echo')?.parameters).toEqual(definition(2).parameters);
    expect(JSON.parse(String((await invoke(registry, 'live-tool', { message: 'after' })).output))).toMatchObject({ version: 2, asset: 'asset-v2' });
    expect(JSON.parse(String((await invoke(registry, 'other-tool', { value: 'after' })).output))).toMatchObject({ pid: otherPid });
    expect(daemon.controller.resync).toHaveBeenCalledOnce();
    expect(daemon.refreshAgentCommands).toHaveBeenCalledOnce();
    expect(daemon.refreshSkillCommands).toHaveBeenCalledWith('continuing-session');
  }, 30_000);

  it.each(['disable', 'reload'] as const)('waits for an admitted call before %s', async (operation) => {
    const plugins = host.app.accessor.get(IPluginService);
    const { registry, pluginTools } = liveAgent();
    await pluginTools.ready();
    const source = path.join(root, 'source');
    await writePlugin(source, 'live-tool', 1);
    await install(plugins, source, true);
    await plugins.setPluginEnabled({ id: 'live-tool', enabled: true });
    const started = deferred();
    const gate = path.join(root, 'release');
    const active = invoke(registry, 'live-tool', { value: operation, gate }, () => started.resolve())
      .then((value) => value, (error: unknown) => error);
    await started.promise;
    const changing = deferred();
    const listener = plugins.onWillChange(() => changing.resolve());
    let applied = false;
    const mutation = (operation === 'disable'
      ? plugins.setPluginEnabled({ id: 'live-tool', enabled: false })
      : plugins.reloadPlugins()).then(() => { applied = true; });
    await changing.promise;
    listener.dispose();
    expect(applied).toBe(false);
    await writeFile(gate, 'release');
    const result = await active;
    expect(result).not.toBeInstanceOf(Error);
    expect(JSON.parse(String((result as { output: string }).output))).toMatchObject({ version: 1, value: operation });
    await mutation;
    expect(applied).toBe(true);
    if (operation === 'disable') expect(registry.list()).toEqual([]);
    else expect(JSON.parse(String((await invoke(registry, 'live-tool', { value: 'continued' })).output))).toMatchObject({ version: 1, value: 'continued' });
  });

  it('releases the change gate and resumes the restored managed version after an install persistence failure', async () => {
    const plugins = host.app.accessor.get(IPluginService);
    const { registry, pluginTools } = liveAgent();
    await pluginTools.ready();
    const source = path.join(root, 'source');
    await writePlugin(source, 'live-tool', 1);
    await install(plugins, source, true);
    await plugins.setPluginEnabled({ id: 'live-tool', enabled: true });
    await invoke(registry, 'live-tool', { value: 'before' });
    await writePlugin(source, 'live-tool', 2);
    const plan = await plugins.previewPlugin({ source });
    vi.spyOn(pluginStore, 'writeInstalled').mockRejectedValueOnce(new Error('fixture persistence failed'));
    await expect(plugins.installPlugin({ source, fingerprint: plan.fingerprint })).rejects.toThrow('fixture persistence failed');
    expect((await plugins.getPluginInfo({ id: 'live-tool' })).version).toBe('1.0.0');
    expect(registry.list()[0]?.parameters).toEqual(definition(1).parameters);
    expect(JSON.parse(String((await invoke(registry, 'live-tool', { value: 'restored' })).output))).toMatchObject({ version: 1, value: 'restored', asset: 'asset-v1' });
  });
});

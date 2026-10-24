import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { AgentBrowserService, IAgentBrowserService, IBrowserTabsTool, BrowserTabsTool } from '#/agent/tools/browser/browserTools';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IBrowserControlService, type BrowserCaller } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { BrowserControlService } from '#/app/browser/browserControlService';
import { IBrowserBackendFactory } from '#/app/browser/browserBackend';
import { BROWSER_CONFIG_SECTION, type BrowserConfig, type BrowserResolvedConnection } from '#/app/browser/browserConfig';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const url = 'https://example.test/invoice';
const browser = 'webbridge-command';
const sessionBrowserDefault = createDecorator<{ readonly _serviceBrand: undefined; readonly ready: Promise<string | undefined> }>('sessionBrowserDefault');
interface Posted { action: string; args: Record<string, unknown>; session: string }
const envelope = (data: Record<string, unknown>) => new Response(JSON.stringify({ ok: true, data: { success: true, ...data } }));
const textOf = (result: ExecutableToolResult): string => typeof result.output === 'string' ? result.output : result.output.map((part) => 'text' in part ? part.text : '').join('\n');
function targetOf(result: ExecutableToolResult): string {
  const target = /"targetId":"(wb:\d+)"/.exec(textOf(result))?.[1];
  if (target === undefined) throw new Error(`No command tab in ${textOf(result)}`);
  return target;
}
afterEach(() => { vi.unstubAllGlobals(); });

function controlFixture() {
  const row: BrowserResolvedConnection = { id: browser, type: 'webbridge-command', name: 'Kimi', enabled: true };
  const ix = new TestInstantiationService();
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IHostProcessService, {});
  ix.stub(IHostFileSystem, {});
  ix.stub(IBrowserConnectionStore, { list: async () => ({ connections: [row] }), resolve: async () => row });
  ix.stub(IBrowserBackendFactory, { open: vi.fn(async () => { throw new Error('Command connections must not open agent-browser'); }) });
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  return { ix, control: ix.get(IBrowserControlService), factory: ix.get(IBrowserBackendFactory) };
}

function installPeer(loseAfterSnapshots?: number) {
  const requests: Posted[] = [];
  const owner = new Map<string, number>();
  const known: { tabId: number; url: string }[] = [];
  let nextId = 1622118901;
  let snapshots = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith('/status')) return new Response(JSON.stringify({ running: true, extension_connected: true, version: '1.11.4' }));
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON command body');
    const body = JSON.parse(init.body) as Posted;
    requests.push(body);
    if (body.action === 'list_tabs') return envelope({ tabs: [...known] });
    if (body.action === 'navigate') {
      const created = body.args['newTab'] === true || !owner.has(body.session);
      const id = created ? nextId++ : owner.get(body.session)!;
      if (created) { owner.set(body.session, id); known.push({ tabId: id, url }); }
      return envelope({ tabId: id, url });
    }
    if (body.action === 'snapshot') {
      snapshots += 1;
      if (loseAfterSnapshots !== undefined && snapshots > loseAfterSnapshots) throw Object.assign(new Error('lost'), { name: 'AbortError' });
      return envelope({ tree: owner.get(body.session) === 1622118901 ? 'button @e12' : 'button @e34' });
    }
    return envelope({ closed: true });
  }));
  return { requests, posts: (action: string) => requests.filter((r) => r.action === action) };
}

async function execute(work: ToolExecution | Promise<ToolExecution>): Promise<ExecutableToolResult> {
  const execution = await work;
  return 'execute' in execution ? execution.execute({ turnId: 1, toolCallId: 'fixture', signal: new AbortController().signal }) : execution;
}

function agentFixture(control: IBrowserControlService, directory: string, caller: BrowserCaller) {
  const sections = new Emitter<ConfigSectionChangedEvent>();
  const config: BrowserConfig = { connections: { [browser]: { type: 'webbridge-command', name: 'Kimi', enabled: true } } };
  const ix = new TestInstantiationService();
  const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' }, { pathClass: process.platform === 'win32' ? 'win32' : 'posix' }), { fs: new HostFileSystem() });
  ix.stub(IBrowserControlService, control);
  ix.stub(sessionBrowserDefault, { ready: Promise.resolve(undefined) });
  ix.stub(IBrowserConnectionStore, { list: async () => ({ connections: [{ id: browser, ...config.connections[browser]! }] }), resolve: async () => ({ id: browser, ...config.connections[browser]! }) });
  ix.stub(IAgentScopeContext, { agentId: caller.agentId });
  ix.stub(ISessionContext, { sessionId: caller.sessionId, sessionDir: directory });
  ix.stub(ISessionWorkspaceContext, { workDir: directory, additionalDirs: [] });
  ix.stub(IAgentRuntimeService, { inspect: () => runtime, prepareFor: async () => runtime });
  ix.stub(ISessionMediaStore, { materialize: vi.fn(async () => 'fixture-media') });
  ix.stub(ISessionInteractionService, { hasConsumer: () => false });
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IConfigService, { onDidSectionChange: sections.event, get: <T>(domain: string) => (domain === BROWSER_CONFIG_SECTION ? config : undefined) as T });
  ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
  ix.set(IBrowserTabsTool, new SyncDescriptor(BrowserTabsTool));
  const registry = ix.get(IAgentToolRegistryService);
  return { ix, service: ix.get(IAgentBrowserService), tabs: ix.get(IBrowserTabsTool), registry,
    open: () => execute(ix.get(IBrowserTabsTool).resolveExecution({ action: 'open', browser, url })),
    select: (target: string) => execute(ix.get(IBrowserTabsTool).resolveExecution({ action: 'select', browser, target })),
    close: (target: string) => execute(ix.get(IBrowserTabsTool).resolveExecution({ action: 'close', browser, target })),
    snapshot: () => execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({})),
    click: (selector: string) => execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector })),
  };
}

describe('webbridge command through BrowserTabs and page tools', () => {
  it('keeps interleaved same-URL callers on their own sessions, targets and refs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-webbridge-tools-'));
    const f = controlFixture(); const peer = installPeer();
    const a = agentFixture(f.control, directory, { sessionId: 'session-a', agentId: 'agent-a' });
    const b = agentFixture(f.control, directory, { sessionId: 'session-b', agentId: 'agent-b' });
    try {
      await f.control.connect(browser);
      for (const agent of [a, b]) {
        const catalog = await agent.service.connections({ action: 'tools', browser, tools: ['agent_browser_snapshot', 'agent_browser_click'] });
        expect(textOf(catalog)).toContain('Each caller has its own command session');
      }
      const tabA = targetOf(await a.open()); const tabB = targetOf(await b.open());
      expect([tabA, tabB]).toEqual(['wb:1622118901', 'wb:1622118902']);
      const listed = await execute(a.tabs.resolveExecution({ action: 'list', browser }));
      expect(JSON.parse(textOf(listed)).tabs.map((t: { targetId: string }) => t.targetId)).toEqual([tabA, tabB]);
      expect((await a.select(tabA)).isError).not.toBe(true);
      expect((await b.select(tabB)).isError).not.toBe(true);
      expect(textOf(await a.select(tabB))).toContain('was not selected');
      expect(textOf(await a.close(tabB))).toContain('was not closed');
      expect((await a.snapshot()).isError).not.toBe(true);
      expect((await b.snapshot()).isError).not.toBe(true);
      expect(textOf(await a.click('@e34'))).toContain('Element references');
      expect(textOf(await b.click('@e12'))).toContain('Element references');
      expect(peer.posts('click')).toHaveLength(0);
      expect((await a.click('@e12')).isError).not.toBe(true);
      expect((await b.click('@e34')).isError).not.toBe(true);
      expect((await a.click('@e12')).isError).toBe(true);
      expect((await a.close(tabA)).isError).not.toBe(true);
      expect((await b.close(tabB)).isError).not.toBe(true);
      const sessions = peer.posts('navigate').map((r) => r.session);
      expect(new Set([peer.posts('list_tabs')[0]?.session, ...sessions]).size).toBe(3);
      expect(peer.posts('snapshot').map((r) => r.session)).toEqual(sessions);
      expect(peer.posts('click').map((r) => ({ session: r.session, args: r.args }))).toEqual([{ session: sessions[0], args: { selector: '@e12' } }, { session: sessions[1], args: { selector: '@e34' } }]);
      expect(peer.posts('close_tab').map((r) => r.session)).toEqual(sessions);
      expect(peer.posts('find_tab')).toHaveLength(0);
      expect(peer.requests.some((r) => 'tabId' in r.args || '_tabId' in r.args)).toBe(false);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await a.ix.dispose(); await b.ix.dispose(); await f.ix.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  it('does not reuse a generation or caller observation after an unconfirmed command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-webbridge-tools-'));
    const f = controlFixture(); const peer = installPeer(2);
    const callerA = { sessionId: 'session-a', agentId: 'agent-a' };
    const callerB = { sessionId: 'session-b', agentId: 'agent-b' };
    const a = agentFixture(f.control, directory, callerA); const b = agentFixture(f.control, directory, callerB);
    try {
      await f.control.connect(browser);
      for (const agent of [a, b]) await agent.service.connections({ action: 'tools', browser, tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      const tabA = targetOf(await a.open()); const tabB = targetOf(await b.open());
      await a.snapshot(); await b.snapshot();
      expect((await a.snapshot()).isError).toBe(true);
      expect((await f.control.status(browser)).state).toBe('unconfirmed');
      await f.control.check(browser); await f.control.connect(browser);
      await expect(f.control.invoke({ browser, caller: callerA, tool: 'agent_browser_click', args: { selector: '@e12' }, tab: tabA, generation: 1 })).rejects.toMatchObject({ code: 'browser.target' });
      await expect(f.control.invoke({ browser, caller: callerB, tool: 'agent_browser_click', args: { selector: '@e34' }, tab: tabB })).rejects.toMatchObject({ code: 'browser.target' });
      expect(peer.posts('click')).toHaveLength(0);
      expect(peer.posts('snapshot')).toHaveLength(3);
      expect(peer.posts('find_tab')).toHaveLength(0);
    } finally { await a.ix.dispose(); await b.ix.dispose(); await f.ix.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});

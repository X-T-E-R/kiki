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

const SAME_URL = 'https://example.test/invoice';
const browserId = 'webbridge-command';
const sessionBrowserDefault = createDecorator<{ readonly _serviceBrand: undefined; readonly ready: Promise<string | undefined> }>('sessionBrowserDefault');

interface Posted { url: string; method: string; body?: { action?: string; args?: Record<string, unknown>; session?: string } }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function envelope(data: Record<string, unknown>): Response {
  return json({ ok: true, data: { success: true, ...data } });
}

function posts(requests: readonly Posted[], action?: string): Posted[] {
  return requests.filter((item) => item.url.endsWith('/command') && (action === undefined || item.body?.action === action));
}

function textOf(result: ExecutableToolResult): string {
  const output = result.output;
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return output.map((part) => (part !== null && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('\n');
}

function targetOf(result: ExecutableToolResult): string {
  const target = /"targetId":"(wb:\d+)"/.exec(textOf(result))?.[1];
  if (target === undefined) throw new Error(`No command tab in ${textOf(result)}`);
  return target;
}

afterEach(() => { vi.unstubAllGlobals(); });

function controlFixture() {
  const row: BrowserResolvedConnection = { id: browserId, type: 'webbridge-command', name: 'Kimi browser extension', enabled: true };
  const ix = new TestInstantiationService();
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IHostProcessService, { spawn: async () => { throw new Error('unused'); } } as never);
  ix.stub(IHostFileSystem, {} as never);
  ix.stub(IBrowserConnectionStore, {
    list: async () => ({ connections: [{ id: row.id, name: row.name, type: row.type, enabled: row.enabled }] }),
    resolve: async (id: string) => {
      if (id !== row.id) throw new Error('Unknown browser');
      return row;
    },
  });
  ix.stub(IBrowserBackendFactory, { open: vi.fn(async () => { throw new Error('command connection must not open agent-browser'); }) });
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  return { ix, control: ix.get(IBrowserControlService), factory: ix.get(IBrowserBackendFactory) };
}

function installSessionPeer(options: { loseAfterSnapshots?: number } = {}) {
  const requests: Posted[] = [];
  const owner = new Map<string, number>();
  const known: { tabId: number; url: string; title: string; active: boolean }[] = [];
  let nextId = 1622118901;
  let snapshots = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Posted['body'] : undefined;
    requests.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/status')) return json({ running: true, extension_connected: true, version: '1.11.4' });
    if (body?.action === 'list_tabs') return envelope({ tabs: known.map((tab) => ({ ...tab })) });
    if (body?.action === 'navigate') {
      const session = body.session ?? '';
      const created = body.args?.['newTab'] === true || !owner.has(session);
      const id = created ? nextId++ : owner.get(session)!;
      if (created) {
        owner.set(session, id);
        known.push({ tabId: id, url: SAME_URL, title: `Invoice ${id}`, active: known.length === 0 });
      }
      return envelope({ url: body.args?.['url'], tabId: id });
    }
    if (body?.action === 'snapshot') {
      snapshots += 1;
      if (options.loseAfterSnapshots !== undefined && snapshots > options.loseAfterSnapshots) {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      const id = owner.get(body.session ?? '');
      return envelope({ url: SAME_URL, title: 'Invoice', tree: id === 1622118901 ? 'button @e12' : 'button @e34' });
    }
    if (body?.action === 'click' || body?.action === 'close_tab') return envelope({ ok: true });
    return envelope({});
  }));
  return requests;
}

async function execute(work: ToolExecution | Promise<ToolExecution>): Promise<ExecutableToolResult> {
  const execution = await work;
  return 'execute' in execution ? execution.execute({ turnId: 1, toolCallId: 'test-call', signal: new AbortController().signal }) : execution;
}

function agentFixture(control: IBrowserControlService, directory: string, caller: BrowserCaller) {
  const sections = new Emitter<ConfigSectionChangedEvent>();
  const config: BrowserConfig = { connections: { [browserId]: { type: 'webbridge-command', name: 'Kimi browser extension', enabled: true } } };
  const ix = new TestInstantiationService();
  const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' }, { pathClass: process.platform === 'win32' ? 'win32' : 'posix' }), { fs: new HostFileSystem() });
  ix.stub(IBrowserControlService, control);
  ix.stub(sessionBrowserDefault, { ready: Promise.resolve(undefined) });
  ix.stub(IBrowserConnectionStore, {
    list: async () => ({ connections: [{ id: browserId, name: 'Kimi browser extension', type: 'webbridge-command' as const, enabled: true }] }),
    resolve: async () => ({ id: browserId, name: 'Kimi browser extension', type: 'webbridge-command' as const, enabled: true }),
  });
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
  return { ix, service: ix.get(IAgentBrowserService), tabs: ix.get(IBrowserTabsTool), registry: ix.get(IAgentToolRegistryService) };
}

describe('webbridge command through BrowserTabs and page tools', () => {
  it('selects and closes each same-URL tab for the caller that opened it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-webbridge-tools-'));
    const f = controlFixture();
    const requests = installSessionPeer();
    const a = agentFixture(f.control, directory, { sessionId: 'session-a', agentId: 'agent-a' });
    const b = agentFixture(f.control, directory, { sessionId: 'session-b', agentId: 'agent-b' });
    try {
      await f.control.connect(browserId);
      const openedA = await execute(a.tabs.resolveExecution({ action: 'open', browser: browserId, url: SAME_URL }));
      const openedB = await execute(b.tabs.resolveExecution({ action: 'open', browser: browserId, url: SAME_URL }));
      const tabA = targetOf(openedA);
      const tabB = targetOf(openedB);
      expect(tabA).toBe('wb:1622118901');
      expect(tabB).toBe('wb:1622118902');
      const listed = JSON.parse(textOf(await execute(a.tabs.resolveExecution({ action: 'list', browser: browserId })))) as { tabs: { targetId: string; url?: string }[] };
      expect(listed.tabs.map((tab) => tab.targetId)).toEqual(['wb:1622118901', 'wb:1622118902']);
      expect(listed.tabs[0]?.url).toBe(SAME_URL);
      expect(listed.tabs[1]?.url).toBe(SAME_URL);
      expect((await execute(a.tabs.resolveExecution({ action: 'select', browser: browserId, target: tabA }))).isError).not.toBe(true);
      expect((await execute(b.tabs.resolveExecution({ action: 'select', browser: browserId, target: tabB }))).isError).not.toBe(true);
      const wrongSelect = await execute(a.tabs.resolveExecution({ action: 'select', browser: browserId, target: tabB }));
      const wrongClose = await execute(a.tabs.resolveExecution({ action: 'close', browser: browserId, target: tabB }));
      expect(wrongSelect.isError).toBe(true);
      expect(textOf(wrongSelect)).toContain('was not selected');
      expect(wrongClose.isError).toBe(true);
      expect(textOf(wrongClose)).toContain('was not closed');
      expect(posts(requests, 'find_tab')).toHaveLength(0);
      expect(posts(requests, 'close_tab')).toHaveLength(0);
      expect((await execute(a.tabs.resolveExecution({ action: 'close', browser: browserId, target: tabA }))).isError).not.toBe(true);
      expect((await execute(b.tabs.resolveExecution({ action: 'close', browser: browserId, target: tabB }))).isError).not.toBe(true);
      const navigations = posts(requests, 'navigate');
      const sessionA = navigations[0]?.body?.session;
      const sessionB = navigations[1]?.body?.session;
      const connectSession = posts(requests, 'list_tabs')[0]?.body?.session;
      expect(sessionA).toMatch(/^kiki-cmd-[0-9a-f]{24}$/);
      expect(sessionB).toMatch(/^kiki-cmd-[0-9a-f]{24}$/);
      expect(new Set([connectSession, sessionA, sessionB]).size).toBe(3);
      expect(navigations.map((item) => item.body?.args)).toEqual([
        { url: SAME_URL, newTab: true },
        { url: SAME_URL, newTab: true },
      ]);
      expect(posts(requests, 'close_tab').map((item) => item.body)).toEqual([
        { action: 'close_tab', args: {}, session: sessionA },
        { action: 'close_tab', args: {}, session: sessionB },
      ]);
      expect(requests.filter((item) => item.body?.args !== undefined && ('tabId' in item.body.args || '_tabId' in item.body.args))).toHaveLength(0);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally {
      await a.ix.dispose();
      await b.ix.dispose();
      await f.ix.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps interleaved callers on their own sessions, tabs, and element refs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-webbridge-tools-'));
    const f = controlFixture();
    const requests = installSessionPeer();
    const a = agentFixture(f.control, directory, { sessionId: 'session-a', agentId: 'agent-a' });
    const b = agentFixture(f.control, directory, { sessionId: 'session-b', agentId: 'agent-b' });
    try {
      await f.control.connect(browserId);
      await a.service.connections({ action: 'tools', browser: browserId, tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      await b.service.connections({ action: 'tools', browser: browserId, tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      const tabA = targetOf(await execute(a.tabs.resolveExecution({ action: 'open', browser: browserId, url: SAME_URL })));
      const tabB = targetOf(await execute(b.tabs.resolveExecution({ action: 'open', browser: browserId, url: SAME_URL })));
      expect((await execute(a.tabs.resolveExecution({ action: 'select', browser: browserId, target: tabA }))).isError).not.toBe(true);
      expect((await execute(b.tabs.resolveExecution({ action: 'select', browser: browserId, target: tabB }))).isError).not.toBe(true);
      const snap = (registry: typeof a.registry) => execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}));
      const click = (registry: typeof a.registry, selector: string) => execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector }));
      expect((await snap(a.registry)).isError).not.toBe(true);
      expect((await snap(b.registry)).isError).not.toBe(true);
      const crossA = await click(a.registry, '@e34');
      const crossB = await click(b.registry, '@e12');
      expect(crossA.isError).toBe(true);
      expect(textOf(crossA)).toContain('Element references');
      expect(crossB.isError).toBe(true);
      expect(textOf(crossB)).toContain('Element references');
      expect(posts(requests, 'click')).toHaveLength(0);
      expect((await click(a.registry, '@e12')).isError).not.toBe(true);
      expect((await click(b.registry, '@e34')).isError).not.toBe(true);
      expect((await click(a.registry, '@e12')).isError).toBe(true);
      const sessionA = posts(requests, 'navigate')[0]?.body?.session;
      const sessionB = posts(requests, 'navigate')[1]?.body?.session;
      expect(posts(requests, 'snapshot').map((item) => item.body?.session)).toEqual([sessionA, sessionB]);
      expect(posts(requests, 'click').map((item) => ({ session: item.body?.session, args: item.body?.args }))).toEqual([
        { session: sessionA, args: { selector: '@e12' } },
        { session: sessionB, args: { selector: '@e34' } },
      ]);
      expect(posts(requests, 'find_tab')).toHaveLength(0);
      expect(tabA).not.toBe(tabB);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally {
      await a.ix.dispose();
      await b.ix.dispose();
      await f.ix.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a stale generation and does not reuse refs after the command session is cleared', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-webbridge-tools-'));
    const f = controlFixture();
    const requests = installSessionPeer({ loseAfterSnapshots: 2 });
    const callerA = { sessionId: 'session-a', agentId: 'agent-a' };
    const callerB = { sessionId: 'session-b', agentId: 'agent-b' };
    const a = agentFixture(f.control, directory, callerA);
    const b = agentFixture(f.control, directory, callerB);
    try {
      await f.control.connect(browserId);
      await a.service.connections({ action: 'tools', browser: browserId, tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      await b.service.connections({ action: 'tools', browser: browserId, tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      const tabA = targetOf(await execute(a.tabs.resolveExecution({ action: 'open', browser: browserId, url: SAME_URL })));
      const tabB = targetOf(await execute(b.tabs.resolveExecution({ action: 'open', browser: browserId, url: SAME_URL })));
      expect((await execute(a.registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}))).isError).not.toBe(true);
      expect((await execute(b.registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}))).isError).not.toBe(true);
      expect((await execute(a.registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}))).isError).toBe(true);
      expect(posts(requests, 'snapshot')).toHaveLength(3);
      await f.control.check(browserId);
      const ready = await f.control.connect(browserId);
      const staleA = await execute(a.registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '@e12' }));
      const staleB = await execute(b.registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '@e34' }));
      expect(staleA.isError).toBe(true);
      expect(staleB.isError).toBe(true);
      expect(textOf(staleA)).toContain('reconnected');
      expect(textOf(staleB)).toContain('reconnected');
      await expect(f.control.invoke({ browser: browserId, caller: callerA, tool: 'agent_browser_click', args: { selector: '@e12' }, tab: tabA, generation: ready.generation })).rejects.toMatchObject({ code: 'browser.target' });
      await expect(f.control.invoke({ browser: browserId, caller: callerB, tool: 'agent_browser_click', args: { selector: '@e34' }, tab: tabB, generation: ready.generation })).rejects.toMatchObject({ code: 'browser.target' });
      await expect(f.control.invoke({ browser: browserId, caller: callerA, tool: 'agent_browser_click', args: { selector: '@e34' }, tab: tabB, generation: ready.generation })).rejects.toMatchObject({ code: 'browser.target' });
      expect(posts(requests, 'click')).toHaveLength(0);
      expect(posts(requests, 'find_tab')).toHaveLength(0);
      expect(posts(requests, 'close_tab')).toHaveLength(0);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally {
      await a.ix.dispose();
      await b.ix.dispose();
      await f.ix.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

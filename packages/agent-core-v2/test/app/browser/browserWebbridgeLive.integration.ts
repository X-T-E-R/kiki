import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { AgentBrowserService, IAgentBrowserService } from '#/agent/tools/browser/browserTools';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IBrowserControlService } from '#/app/browser/browser';
import { BrowserControlService } from '#/app/browser/browserControlService';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IBrowserBackendFactory } from '#/app/browser/browserBackend';
import { BROWSER_CONFIG_SECTION, type BrowserConfig } from '#/app/browser/browserConfig';
import { webbridgeExecutionSession } from '#/app/browser/browserWebbridge';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const ID = 'kimi-webbridge-smoke';
const SESSION = webbridgeExecutionSession(ID);
const LABEL = 'kiki-webbridge-smoke';
const defaults = createDecorator<{ readonly _serviceBrand: undefined; ready: Promise<string | undefined> }>('sessionBrowserDefault');
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>kiki smoke form</title><link rel="icon" href="data:,">
<label for="field">Smoke value</label><input id="field" name="field" type="text" autocomplete="off">
<button id="apply" type="button">Apply smoke</button><p id="echo" role="status">echo:empty</p>
<script>document.getElementById('apply').addEventListener('click', () => { const echoed = 'echo:' + document.getElementById('field').value; document.getElementById('echo').textContent = echoed; document.getElementById('apply').textContent = echoed; });</script>`;

describe.skipIf(process.env['KIKI_WEBBRIDGE_SMOKE'] !== '1')('live Kimi WebBridge fixture', () => {
  it('opens, reads, fills and closes only its own local form tab', async () => {
    const token = `smoke${randomBytes(4).toString('hex')}`;
    const echo = `echo:${token}`;
    const page = await startForm();
    const actions: string[] = [];
    const realFetch = globalThis.fetch;
    let bridge: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith('http://127.0.0.1:10086/')) throw new Error('fixture fetch left the WebBridge daemon');
        if (init?.body !== undefined) {
          const body = JSON.parse(String(init.body)) as { action?: string; session?: string; args?: { active?: boolean; url?: unknown; selector?: unknown } };
          if (body.session !== SESSION) throw new Error('fixture fetch left the smoke session');
          if (body.action === 'close_session' || body.args?.active === true) throw new Error('fixture fetch refused a session takeover');
          if (!['navigate', 'list_tabs', 'find_tab', 'snapshot', 'click', 'fill', 'close_tab'].includes(body.action ?? '')) throw new Error('fixture fetch refused an unapproved action');
          if ((body.action === 'navigate' || body.action === 'find_tab') && (typeof body.args?.url !== 'string' || !body.args.url.startsWith(page.origin))) throw new Error('fixture fetch left the local form');
          if ((body.action === 'click' || body.action === 'fill') && body.args?.selector !== '#field' && body.args?.selector !== '#apply') throw new Error('fixture fetch refused an unexpected selector');
          actions.push(body.action ?? '');
        }
        return realFetch(input, init);
      });
      bridge = await harness();
      let owned: { id: string; url: string } | undefined;
      let unknown = false;
      let closed = false;
      let closeSent = false;
      try {
        const connected = json(await bridge.service.connections({ action: 'connect', browser: ID }));
        expect(connected['state']).toBe('ready');
        expect(connected['runtimeSession']).toBe(SESSION);
        expect(SESSION).toBe('kiki-kimi-webbridge-smoke');
        expect(connected['driverVersion']).toBe('v2.0.23');
        expect(bridge.factory.open).not.toHaveBeenCalled();
        const opened = await bridge.service.tabs({ action: 'open', browser: ID, url: page.url, label: LABEL });
        unknown = uncertain(opened);
        accept(opened, 'open');
        const id = /"targetId":"([^"]+)"/.exec(textOf(opened))?.[1];
        if (id === undefined || id === '') throw new Error('open returned no targetId');
        const row = (await tabs(bridge.service)).find((tab) => tab.targetId === id);
        if (row?.url !== page.url) throw new Error('opened tab is not the fixture page');
        owned = { id, url: row.url };
        accept(await bridge.service.tabs({ action: 'select', browser: ID, target: id }), 'select');
        accept(await bridge.service.connections({ action: 'tools', browser: ID, tools: ['agent_browser_snapshot', 'agent_browser_click', 'agent_browser_fill'] }), 'tools');
        const registry = bridge.ix.get(IAgentToolRegistryService);
        const shot = await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}));
        unknown = uncertain(shot);
        accept(shot, 'snapshot');
        expect(textOf(shot)).toContain(`"targetId":"${id}"`);
        expect(textOf(shot)).toContain('Apply smoke');
        const filled = await execute(registry.resolve('browser__agent_browser_fill')!.resolveExecution({ selector: '#field', value: token }));
        unknown = uncertain(filled);
        accept(filled, 'fill');
        expect(textOf(filled)).toContain(`"targetId":"${id}"`);
        const clicked = await execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '#apply' }));
        unknown = uncertain(clicked);
        accept(clicked, 'click');
        expect(textOf(clicked)).toContain(`"targetId":"${id}"`);
        const echoed = await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}));
        unknown = uncertain(echoed);
        accept(echoed, 'echo snapshot');
        expect(textOf(echoed)).toContain(`"targetId":"${id}"`);
        expect(textOf(echoed)).toContain(echo);
        closed = await closeOwned(bridge.service, owned, page.origin, () => { closeSent = true; });
        expect(closed).toBe(true);
        expect(actions).toEqual(expect.arrayContaining(['navigate', 'list_tabs', 'snapshot', 'fill', 'click', 'close_tab']));
        expect(actions).not.toContain('close_session');
        expect(bridge.factory.open).not.toHaveBeenCalled();
        expect(bridge.writes).toEqual({ upsert: 0, remove: 0, setDefault: 0 });
        console.log(JSON.stringify({ session: SESSION, targetId: id, snapshotEcho: true, closed: true }));
      } catch (error) {
        if (error instanceof Uncertain) unknown = true;
        throw error;
      } finally {
        if (!closed && !unknown && !closeSent && owned !== undefined && bridge !== undefined) {
          try { closed = await closeOwned(bridge.service, owned, page.origin, () => { closeSent = true; }); }
          catch (error) { if (error instanceof Uncertain) unknown = true; }
        }
        if (unknown && bridge !== undefined) {
          try {
            const status = json(await bridge.service.connections({ action: 'status', browser: ID }));
            console.log(JSON.stringify({ session: SESSION, targetId: owned?.id, state: status['state'], reason: (status['failure'] as { reason?: string } | undefined)?.reason, closed: false }));
          } catch { console.log(JSON.stringify({ session: SESSION, targetId: owned?.id, closed: false })); }
        }
        await bridge?.ix.dispose();
      }
    } finally {
      await page.close();
      vi.unstubAllGlobals();
    }
  }, 120_000);
});

class Uncertain extends Error {}

function textOf(result: ExecutableToolResult): string {
  if (typeof result.output === 'string') return result.output;
  return result.output.map((part) => part.type === 'text' ? part.text : '').join('\n');
}

function uncertain(result: ExecutableToolResult): boolean {
  return result.isError === true && /outcome_unknown|not replayed|was sent but its result was not confirmed/i.test(textOf(result));
}

function accept(result: ExecutableToolResult, step: string): void {
  if (uncertain(result)) throw new Uncertain(`${step} outcome is unknown`);
  if (result.isError === true) throw new Error(`${step} failed: ${textOf(result).replace(/https?:\/\/\S+/gi, '').slice(0, 240)}`);
}

function json(result: ExecutableToolResult): Record<string, unknown> {
  accept(result, 'status');
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function execute(work: ToolExecution | Promise<ToolExecution>): Promise<ExecutableToolResult> {
  const execution = await work;
  if (!('execute' in execution)) return execution;
  return execution.execute({ turnId: 1, toolCallId: 'webbridge-live', signal: new AbortController().signal });
}

async function tabs(service: Awaited<ReturnType<typeof harness>>['service']): Promise<{ targetId?: string; url?: string }[]> {
  const listed = await service.tabs({ action: 'list', browser: ID });
  if (uncertain(listed)) throw new Uncertain('list outcome is unknown');
  accept(listed, 'list');
  const body = JSON.parse(textOf(listed)) as { tabs?: { targetId?: string; url?: string }[] };
  return body.tabs ?? [];
}

async function closeOwned(service: Awaited<ReturnType<typeof harness>>['service'], owned: { id: string; url: string }, origin: string, onSend: () => void): Promise<boolean> {
  const current = await tabs(service);
  const matches = current.filter((tab) => tab.targetId === owned.id && tab.url === owned.url && tab.url.startsWith(origin));
  if (matches.length !== 1 || current.filter((tab) => tab.url === owned.url).length !== 1) return false;
  onSend();
  const closed = await service.tabs({ action: 'close', browser: ID, target: owned.id });
  if (uncertain(closed)) throw new Uncertain('close outcome is unknown');
  accept(closed, 'close');
  const after = await tabs(service);
  if (after.some((tab) => tab.targetId === owned.id)) throw new Error('owned tab was still listed after close');
  return true;
}

async function startForm(): Promise<{ url: string; origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    if (request.url !== '/' && request.url !== '/index.html') { response.writeHead(404).end(); return; }
    const body = Buffer.from(PAGE);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' });
    response.end(body);
  });
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port');
  const origin = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  return { origin, url: `${origin}/`, close: async () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

async function harness() {
  const writes = { upsert: 0, remove: 0, setDefault: 0 };
  const connection = { id: ID, type: 'kimi-webbridge' as const, name: 'kiki smoke', enabled: true };
  const config: BrowserConfig = { connections: { [ID]: { type: 'kimi-webbridge', name: 'kiki smoke', enabled: true } }, allowedBrowsers: [ID] };
  const sections = new Emitter<ConfigSectionChangedEvent>();
  const ix = new TestInstantiationService();
  const factory = { _serviceBrand: undefined, open: vi.fn(async () => { throw new Error('CDP driver must stay closed'); }) };
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IBrowserConnectionStore, {
    _serviceBrand: undefined,
    list: async () => ({ connections: [connection], allowedBrowsers: [ID] }),
    resolve: async () => connection,
    upsert: async () => { writes.upsert += 1; throw new Error('fixture does not write config'); },
    remove: async () => { writes.remove += 1; },
    setDefault: async () => { writes.setDefault += 1; },
    revealEndpoint: async () => undefined,
  });
  ix.stub(IBrowserBackendFactory, factory);
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  ix.stub(defaults, { ready: Promise.resolve(undefined) });
  ix.stub(IAgentScopeContext, { agentId: 'main' });
  ix.stub(ISessionContext, { sessionId: 'fixture-session', sessionDir: '/fixture/session' });
  ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
  ix.stub(IAgentRuntimeService, {});
  ix.stub(ISessionMediaStore, {});
  ix.stub(ISessionInteractionService, { hasConsumer: () => false });
  ix.stub(IConfigService, { onDidSectionChange: sections.event, get: <T>(domain: string) => (domain === BROWSER_CONFIG_SECTION ? config : undefined) as T });
  ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
  return { ix, service: ix.get(IAgentBrowserService), factory, writes };
}

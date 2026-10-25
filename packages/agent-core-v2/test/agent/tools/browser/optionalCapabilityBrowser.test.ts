import { describe, expect, it, vi } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { AgentBrowserService, IAgentBrowserService } from '#/agent/tools/browser/browserTools';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IBrowserControlService, type BrowserInvocation, type BrowserInvocationResult } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { BROWSER_CONFIG_SECTION, type BrowserConfig } from '#/app/browser/browserConfig';
import { IFlagService } from '#/app/flag/flag';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const defaults = createDecorator<{ readonly _serviceBrand: undefined; ready: Promise<string | undefined> }>('sessionBrowserDefault');

async function execute(work: ToolExecution | Promise<ToolExecution>): Promise<ExecutableToolResult> {
  const execution = await work;
  return 'execute' in execution ? execution.execute({ turnId: 1, toolCallId: 'test-call', signal: new AbortController().signal }) : execution;
}

describe('browser dynamic tools follow optional capability policy', () => {
  it('keeps a loaded catalog unloaded until policy allows it, then drops it again without another call', async () => {
    const ix = new TestInstantiationService();
    const invoke = vi.fn(async (input: BrowserInvocation): Promise<BrowserInvocationResult> => ({
      browser: input.browser, executionHost: 'fixture-host', runtimeSession: 'official-runtime', generation: 1, tab: input.tab,
      result: { isError: false, content: [{ type: 'text', text: 'ran' }], structuredContent: { official: true } },
    }));
    const changes = new Emitter<{ readonly sessionId?: string }>();
    const sections = new Emitter<ConfigSectionChangedEvent>();
    let disclosed = false;
    const admissions: Array<{ id: string; admitted: boolean }> = [];
    const official: BrowserConfig['connections'][string] = { type: 'codex-extension', name: 'Official', enabled: true, runtimeRoot: '/fixture/cua_node', browserId: 'extension-fixture' };
    const browserConfig: BrowserConfig = { connections: { official } };
    const js = { name: 'codex_browser_js', description: 'Official runtime JavaScript', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } };
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({
        connections: Object.entries(browserConfig.connections).map(([id, entry]) => ({ ...entry, id })),
        ...(browserConfig.allowedBrowsers !== undefined ? { allowedBrowsers: browserConfig.allowedBrowsers } : {}),
        ...(browserConfig.disabledSources !== undefined ? { disabledSources: browserConfig.disabledSources } : {}),
      }),
      resolve: async (id: string) => {
        const entry = browserConfig.connections[id];
        if (entry === undefined) throw new Error('Unknown id');
        return { ...entry, id };
      },
    });
    ix.stub(defaults, { ready: Promise.resolve(undefined) });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'fixture-session', sessionDir: '/fixture/session' });
    ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
    ix.stub(IAgentRuntimeService, {});
    ix.stub(ISessionMediaStore, {});
    ix.stub(ISessionInteractionService, { hasConsumer: () => false });
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IConfigService, {
      onDidSectionChange: sections.event,
      get: <T>(domain: string) => (domain === BROWSER_CONFIG_SECTION ? browserConfig : undefined) as T,
    });
    ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => disclosed });
    ix.stub(IOptionalCapabilityPolicy, {
      onDidChange: changes.event,
      admit: (id: string) => {
        const admitted = false;
        admissions.push({ id, admitted });
        return { admitted, reason: 'default_off' as const };
      },
    });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IBrowserControlService, {
      catalog: async () => [js],
      status: async () => ({ browser: 'official', state: 'ready' as const, executionHost: 'fixture-host', generation: 1 }),
      invoke,
      endTurn: async () => undefined,
    });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    try {
      const service = ix.get(IAgentBrowserService);
      const registry = ix.get(IAgentToolRegistryService);
      await service.connections({ action: 'tools', browser: 'official', tools: ['codex_browser_js'] });
      expect(registry.resolve('browser__codex_browser_js')).toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
      expect(admissions).toEqual([]);
      disclosed = true;
      changes.fire({});
      expect(registry.resolve('browser__codex_browser_js')).toBeDefined();
      official.enabled = false;
      sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: browserConfig, previousValue: {} });
      expect(registry.resolve('browser__codex_browser_js')).toBeUndefined();
      official.enabled = true;
      sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: browserConfig, previousValue: {} });
      browserConfig.disabledSources = ['codex-browser'];
      sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: browserConfig, previousValue: {} });
      expect(registry.resolve('browser__codex_browser_js')).toBeUndefined();
      browserConfig.disabledSources = undefined;
      sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: browserConfig, previousValue: {} });
      const tool = registry.resolve('browser__codex_browser_js');
      expect(tool).toBeDefined();
      expect(admissions).toEqual([]);
      await execute(tool!.resolveExecution({ code: 'inventory' }));
      expect(invoke).toHaveBeenCalledOnce();
      disclosed = false;
      changes.fire({});
      expect(registry.resolve('browser__codex_browser_js')).toBeUndefined();
      const stale = await execute(tool!.resolveExecution({ code: 'again' }));
      expect(stale.isError).toBe(true);
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await ix.dispose();
    }
  });
});

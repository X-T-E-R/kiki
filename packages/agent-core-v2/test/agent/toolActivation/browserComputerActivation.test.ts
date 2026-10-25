import { describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { Emitter, Event } from '#/_base/event';
import { createServices } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService, type ConfigChangedEvent, type ConfigSectionChangedEvent } from '#/app/config/config';
import { IFlagRegistry } from '#/app/flag/flagRegistry';
import { FlagRegistryService } from '#/app/flag/flagRegistryService';
import { EXPERIMENTAL_SECTION, IFlagService } from '#/app/flag/flag';
import { FlagService } from '#/app/flag/flagService';
import { NATIVE_BROWSER_FLAG_ID } from '#/app/browser/flag';
import { IEventBus } from '#/app/event/eventBus';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { AgentToolActivationService } from '#/agent/toolActivation/toolActivationService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { AgentToolContribution, getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import {
  BrowserConnectionsTool,
  BrowserTabsTool,
  IAgentBrowserService,
  IBrowserConnectionsTool,
  IBrowserTabsTool,
} from '#/agent/tools/browser/browserTools';

class BrowserContributionAssembly extends Service {
  constructor() {
    super();
    for (const record of getAgentToolContributions()) {
      if (record.options.name === 'BrowserConnections' || record.options.name === 'BrowserTabs') this.provide(AgentToolContribution, record);
    }
  }
}

describe('browser tool activation follows native_browser', () => {
  it('registers the real browser schemas, drops them when the flag turns off, and keeps an explicit deny', async () => {
    const disposables = new DisposableStore();
    const env = new Map<string, string>();
    let experimental: Record<string, boolean> = {};
    const disallowedTools: string[] = [];
    const changed = new Emitter<ConfigChangedEvent>();
    const sections = new Emitter<ConfigSectionChangedEvent>();
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IBootstrapService, { getEnv: (key: string) => env.get(key) });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => (domain === EXPERIMENTAL_SECTION ? experimental : undefined)) as IConfigService['get'],
          onDidChangeConfiguration: changed.event,
          onDidSectionChange: sections.event,
        });
        reg.define(IFlagRegistry, FlagRegistryService);
        reg.define(IFlagService, FlagService);
        reg.definePartialInstance(IAgentProfileService, { data: () => ({ disallowedTools }) as never });
        reg.definePartialInstance(IEventBus, { subscribe: (() => toDisposable(() => {})) as IEventBus['subscribe'] });
        reg.definePartialInstance(IAgentToolPolicyService, {
          isToolActiveForDisclosure: (name, source) => isToolActive({ disallowedTools }, name, source ?? 'builtin'),
        });
        reg.definePartialInstance(IAgentRuntimeService, { onDidChange: Event.None as Event<void>, isAvailable: () => true });
        reg.defineInstance(ISessionToolPolicyGate, {
          _serviceBrand: undefined,
          disabledTools: [],
          onDidChange: Event.None as Event<void>,
        });
        reg.definePartialInstance(ISessionDeliveryService, {
          effectiveMode: () => 'reply' as const,
          onDidChangeEffective: Event.None as Event<'reply' | 'message'>,
        });
        reg.definePartialInstance(IShippedAgentProfileManager, {
          ready: Promise.resolve(),
          isCleanActivePath: () => false,
          onDidChange: Event.None as Event<void>,
        });
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolActivationService, AgentToolActivationService);
        reg.define(IBrowserConnectionsTool, BrowserConnectionsTool);
        reg.define(IBrowserTabsTool, BrowserTabsTool);
        reg.definePartialInstance(IAgentBrowserService, {
          connections: async () => ({ output: '' }),
          tabs: async () => ({ output: '' }),
        });
      },
    });
    const apply = (next: Record<string, boolean>) => {
      const previous = experimental;
      experimental = next;
      changed.fire({ domain: EXPERIMENTAL_SECTION, source: 'set', value: next, previousValue: previous });
      sections.fire({ domain: EXPERIMENTAL_SECTION, source: 'set', value: next, previousValue: previous });
    };
    try {
      disposables.add(ix.createInstance(BrowserContributionAssembly));
      await ix.get(IAgentToolActivationService).activate();
      const registry = ix.get(IAgentToolRegistryService);
      const connections = registry.resolve('BrowserConnections');
      const tabs = registry.resolve('BrowserTabs');
      expect(connections?.name).toBe('BrowserConnections');
      expect(JSON.stringify(connections?.parameters)).toContain('"list"');
      expect(JSON.stringify(connections?.parameters)).toContain('"tools"');
      expect(tabs?.name).toBe('BrowserTabs');
      expect(JSON.stringify(tabs?.parameters)).toContain('"open"');
      expect(ix.get(IFlagService).explain(NATIVE_BROWSER_FLAG_ID)?.source).toBe('default');
      apply({ native_browser: false });
      expect(registry.resolve('BrowserConnections')).toBeUndefined();
      expect(registry.resolve('BrowserTabs')).toBeUndefined();
      apply({});
      expect(registry.resolve('BrowserConnections')?.parameters).toBeDefined();
      expect(registry.resolve('BrowserTabs')?.parameters).toBeDefined();
      disallowedTools.push('BrowserConnections');
      sections.fire({ domain: 'tools', source: 'set', value: {}, previousValue: {} });
      expect(registry.resolve('BrowserConnections')).toBeUndefined();
      expect(registry.resolve('BrowserTabs')?.name).toBe('BrowserTabs');
      env.set('KIKI_EXPERIMENTAL_NATIVE_BROWSER', 'false');
      apply({ native_browser: true });
      expect(ix.get(IFlagService).explain(NATIVE_BROWSER_FLAG_ID)).toMatchObject({ enabled: false, source: 'env' });
      expect(registry.resolve('BrowserTabs')).toBeUndefined();
    } finally {
      await disposables.dispose();
    }
  });
});

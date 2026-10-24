import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { NATIVE_BROWSER_FLAG_ID } from '#/app/browser/flag';
import { IConfigService, type ConfigOrigin } from '#/app/config/config';
import { COMPUTER_CONFIG_SECTION } from '#/app/computer/configSection';
import { IFlagService } from '#/app/flag/flag';
import { MEMORY_SECTION } from '#/app/memory/configSection';
import { OPTIONAL_CAPABILITIES_SECTION, OPTIONAL_CAPABILITY_FACTORY_DEFAULTS, OptionalCapabilitiesConfigSchema } from '#/app/optionalCapability/configSection';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { OptionalCapabilityPolicyService } from '#/app/optionalCapability/policyService';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { THREAD_COMMUNICATION_SECTION } from '#/app/threadCommunication/configSection';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';

type OriginMap = Record<string, ConfigOrigin>;

const disposables = new DisposableStore();
const cleanPath = 'C:/kiki/agents/builtin/agent.md';
const tools = ['MemoryRead', 'WebSearch', 'ThreadSend', 'BrowserConnections', 'mcp__desktop__screenshot'];

afterEach(() => disposables.clear());

function setup(profile: ProfileData['boundProfile'], activeTools: readonly string[], options?: {
  origins?: Record<string, OriginMap>;
  values?: Record<string, unknown>;
}) {
  const ix = disposables.add(new TestInstantiationService());
  const origins = options?.origins ?? {};
  const values = options?.values ?? {};
  ix.stub(IConfigService, {
    origins: (domain: string) => {
      const map = origins[domain];
      if (map === undefined) return {};
      return map;
    },
    get: ((domain: string) => values[domain]) as IConfigService['get'],
  });
  ix.stub(IFlagService, { explain: () => ({ id: NATIVE_BROWSER_FLAG_ID, title: '', description: '', surface: 'core', env: '', defaultEnabled: true, enabled: true, source: 'default' as const }) });
  ix.stub(IAtomicDocumentStore, { get: async () => undefined, set: async () => undefined });
  ix.stub(IShippedAgentProfileManager, { isCleanActivePath: (path: string) => path === cleanPath });
  ix.stub(IAgentScopeContext, { agentId: 'main', parentAgentId: undefined });
  ix.stub(ISessionContext, { sessionId: 'session-factory', workspaceId: 'workspace-factory' });
  ix.stub(IAgentProfileService, {
    data: () => ({
      modelCapabilities: { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 8192 },
      thinkingLevel: 'off',
      systemPrompt: '',
      activeToolNames: activeTools,
      tools: activeTools,
      boundProfile: profile,
    }) as ProfileData,
  });
  ix.stub(ISessionToolPolicy, { disabledTools: () => [] });
  ix.stub(ISessionToolPolicyGate, { disabledTools: [] });
  ix.stub(IAgentToolExecutorService, { registerToolCallGuard: () => ({ dispose() {} }) });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IOptionalCapabilityPolicy, new SyncDescriptor(OptionalCapabilityPolicyService));
  ix.set(IAgentToolPolicyService, new SyncDescriptor(AgentToolPolicyService));
  const capabilities = ix.get(IOptionalCapabilityPolicy);
  capabilities.noteComputerServers([{ name: 'desktop', transport: 'stdio', command: 'cua-driver', args: ['mcp'] }]);
  return { policy: ix.get(IAgentToolPolicyService), capabilities };
}

function cleanDefault() {
  return {
    name: 'agent',
    toolsSource: 'declared' as const,
    tools,
    sourcePath: cleanPath,
    definitionId: cleanPath,
    fileDefinition: { tools },
  } as unknown as ProfileData['boundProfile'];
}

describe('factory capability matrix', () => {
  it('publishes the factory defaults from the config schema', () => {
    expect(OPTIONAL_CAPABILITY_FACTORY_DEFAULTS).toEqual({ browser: false, computer: false, memory: true, thread: true, web: true, send_message: false });
    expect(OptionalCapabilitiesConfigSchema.parse({}).defaults).toEqual({ ...OPTIONAL_CAPABILITY_FACTORY_DEFAULTS });
  });

  it('admits memory, web, and thread for a new clean default session and keeps browser and computer closed', async () => {
    const { policy, capabilities } = setup(cleanDefault(), tools);
    expect(policy.isToolActive('MemoryRead')).toBe(true);
    expect(policy.isToolActive('WebSearch')).toBe(true);
    expect(policy.isToolActive('ThreadSend')).toBe(true);
    expect(policy.isToolActive('BrowserConnections')).toBe(false);
    expect(policy.isToolActive('mcp__desktop__screenshot')).toBe(false);
    expect(policy.isToolActive('SendMessage')).toBe(false);
    const view = await capabilities.readSession('session-factory', 'workspace-factory');
    expect(view.rows.find((row) => row.id === 'thread')).toMatchObject({ choice: 'inherit', effective: true, reason: 'admitted' });
    expect(view.rows.find((row) => row.id === 'browser')).toMatchObject({ choice: 'inherit', effective: false, reason: 'default_off' });
    expect(view.rows.find((row) => row.id === 'computer')).toMatchObject({ choice: 'inherit', effective: false, reason: 'default_off' });
    expect(view.rows.find((row) => row.id === 'send_message')).toMatchObject({ choice: 'inherit', effective: false, reason: 'default_off', defaultOn: false });
  });

  it('keeps an explicit session off and an explicit session on ahead of the factory default', async () => {
    const { policy, capabilities } = setup(cleanDefault(), tools);
    await capabilities.setChoice('session-factory', 'memory', 'off');
    await capabilities.setChoice('session-factory', 'browser', 'on');
    await capabilities.setChoice('session-factory', 'send_message', 'on');
    expect(policy.isToolActive('MemoryRead')).toBe(false);
    expect(policy.isToolActive('WebSearch')).toBe(true);
    expect(policy.isToolActive('BrowserConnections')).toBe(true);
    expect(policy.isToolActive('mcp__desktop__screenshot')).toBe(false);
    expect(policy.isToolActive('SendMessage')).toBe(true);
    await capabilities.setChoice('session-factory', 'send_message', 'off');
    expect(policy.isToolActive('SendMessage')).toBe(false);
  });

  it('does not turn an explicit user false into the new factory on', () => {
    const { policy } = setup(cleanDefault(), tools, {
      origins: {
        [THREAD_COMMUNICATION_SECTION]: { enabled: 'home' },
        [OPTIONAL_CAPABILITIES_SECTION]: { 'defaults.memory': 'home' },
        [COMPUTER_CONFIG_SECTION]: { enabled: 'home' },
      },
      values: {
        [THREAD_COMMUNICATION_SECTION]: { enabled: false },
        [OPTIONAL_CAPABILITIES_SECTION]: { defaults: { memory: false } },
        [COMPUTER_CONFIG_SECTION]: { enabled: false },
        [MEMORY_SECTION]: { enabled: true },
      },
    });
    expect(policy.isToolActive('ThreadSend')).toBe(false);
    expect(policy.isToolActive('MemoryRead')).toBe(false);
    expect(policy.isToolActive('WebSearch')).toBe(true);
    expect(policy.isToolActive('mcp__desktop__screenshot')).toBe(false);
  });

  it('lets a named profile opt in to a factory-off capability', () => {
    const named = {
      name: 'browser-named',
      toolsSource: 'declared' as const,
      tools: ['BrowserConnections'],
      sourcePath: cleanPath,
      definitionId: cleanPath,
    } as ProfileData['boundProfile'];
    const { policy } = setup(named, ['BrowserConnections']);
    expect(policy.isToolActive('BrowserConnections')).toBe(true);
    expect(policy.isToolActive('MemoryRead')).toBe(false);
  });
});

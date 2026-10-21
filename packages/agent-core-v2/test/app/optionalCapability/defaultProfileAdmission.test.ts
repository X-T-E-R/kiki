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
import { IConfigService, type ConfigOrigin } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { NATIVE_BROWSER_FLAG_ID } from '#/app/browser/flag';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { OptionalCapabilityPolicyService } from '#/app/optionalCapability/policyService';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';

type OriginMap = Record<string, ConfigOrigin>;

const disposables = new DisposableStore();
const cleanPath = 'C:/kiki/agents/builtin/agent.md';

afterEach(() => disposables.clear());

function profileData(profile: ProfileData['boundProfile'], tools: readonly string[], toolOverride?: { tools: readonly string[] }): ProfileData {
  return {
    modelCapabilities: { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 8192 },
    thinkingLevel: 'off',
    systemPrompt: '',
    activeToolNames: tools,
    tools,
    boundProfile: profile,
    toolOverride,
  } as ProfileData;
}

function setup(profile: ProfileData['boundProfile'], tools: readonly string[], options?: { parentAgentId?: string; toolOverride?: { tools: readonly string[] }; clean?: boolean }) {
  const ix = disposables.add(new TestInstantiationService());
  const origins: Record<string, OriginMap> = {
    optionalCapabilities: { 'defaults.memory': 'home', 'defaults.web': 'home', 'defaults.thread': 'home', 'web.allowed': 'default' },
  };
  const values: Record<string, unknown> = {
    optionalCapabilities: { defaults: { memory: false, web: false, thread: false, browser: true, computer: true }, web: { allowed: true } },
  };
  ix.stub(IConfigService, {
    origins: (domain: string) => {
      const map = origins[domain];
      if (map === undefined) return {};
      return map;
    },
    get: ((domain: string) => values[domain]) as IConfigService['get'],
  });
  ix.stub(IFlagService, { explain: () => ({ id: NATIVE_BROWSER_FLAG_ID, title: '', description: '', surface: 'core', env: '', defaultEnabled: true, enabled: true, source: 'default' }) });
  ix.stub(IAtomicDocumentStore, { get: async () => undefined, set: async () => undefined });
  ix.stub(IShippedAgentProfileManager, { isCleanActivePath: (path: string) => options?.clean !== false && path === cleanPath });
  ix.stub(IAgentScopeContext, { agentId: options?.parentAgentId === undefined ? 'main' : 'child', parentAgentId: options?.parentAgentId });
  ix.stub(ISessionContext, { sessionId: 'session-default', workspaceId: 'workspace-default' });
  ix.stub(IAgentProfileService, { data: () => profileData(profile, tools, options?.toolOverride) });
  ix.stub(ISessionToolPolicy, { disabledTools: () => [] });
  ix.stub(ISessionToolPolicyGate, { disabledTools: [] });
  ix.stub(IAgentToolExecutorService, { registerToolCallGuard: () => ({ dispose() {} }) });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IOptionalCapabilityPolicy, new SyncDescriptor(OptionalCapabilityPolicyService));
  ix.set(IAgentToolPolicyService, new SyncDescriptor(AgentToolPolicyService));
  return { policy: ix.get(IAgentToolPolicyService), capabilities: ix.get(IOptionalCapabilityPolicy) };
}

describe('default profile capability admission', () => {
  it('does not let the clean shipped default tool list opt in while default is off', async () => {
    const tools = ['MemoryRead', 'WebSearch', 'ThreadSend'];
    const bound = {
      name: 'agent',
      toolsSource: 'declared' as const,
      tools,
      sourcePath: cleanPath,
      definitionId: cleanPath,
      fileDefinition: { tools },
    } as unknown as ProfileData['boundProfile'];
    const { policy, capabilities } = setup(bound, tools);
    expect(policy.isToolActive('MemoryRead')).toBe(false);
    expect(policy.isToolActive('WebSearch')).toBe(false);
    expect(policy.isToolActive('ThreadSend')).toBe(false);
    const view = await capabilities.readSession('session-default', 'workspace-default');
    expect(view.rows.find((row) => row.id === 'memory')).toMatchObject({ choice: 'inherit', effective: false, reason: 'default_off' });
    expect(view.rows.find((row) => row.id === 'web')).toMatchObject({ effective: false, reason: 'default_off' });
  });

  it('keeps an edited default profile and a named profile as explicit opt-ins', () => {
    const edited = { name: 'agent', toolsSource: 'declared' as const, tools: ['MemoryRead'], sourcePath: 'C:/project/agents/agent.md', definitionId: 'C:/project/agents/agent.md' };
    const named = { name: 'memory-named', toolsSource: 'declared' as const, tools: ['WebSearch'], sourcePath: cleanPath, definitionId: cleanPath };
    expect(setup(edited as ProfileData['boundProfile'], edited.tools, { clean: false }).policy.isToolActive('MemoryRead')).toBe(true);
    expect(setup(named as ProfileData['boundProfile'], named.tools).policy.isToolActive('WebSearch')).toBe(true);
  });

  it('still lets this child run opt in while the parent session is off', async () => {
    const bound = { name: 'agent', toolsSource: 'declared' as const, tools: ['ThreadCreate'], sourcePath: cleanPath, definitionId: cleanPath };
    const child = setup(bound as ProfileData['boundProfile'], ['MemoryRead'], {
      parentAgentId: 'main',
      toolOverride: { tools: ['MemoryRead'] },
    });
    await child.capabilities.setChoice('session-default', 'memory', 'off');
    expect(child.policy.isToolActive('MemoryRead')).toBe(true);
    const parent = setup(bound as ProfileData['boundProfile'], ['MemoryRead']);
    await parent.capabilities.setChoice('session-default', 'memory', 'off');
    expect(parent.policy.isToolActive('MemoryRead')).toBe(false);
  });
});

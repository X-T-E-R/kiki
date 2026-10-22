import { describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentCapabilityRebuildService } from '#/agent/capabilityRebuild/capabilityRebuildService';
import { AgentToolActivationService } from '#/agent/toolActivation/toolActivationService';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { CapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshotService';
import { OPTIONAL_CAPABILITIES_SECTION } from '#/app/optionalCapability/configSection';
import { OptionalCapabilityPolicyService } from '#/app/optionalCapability/policyService';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { MEMORY_SECTION } from '#/app/memory/configSection';
import { AgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { isComputerMcpConfig } from '#/mcpCore/computer';
import { THREAD_COMMUNICATION_SECTION } from '#/app/threadCommunication/configSection';
import { ThreadCommunicationService } from '#/app/threadCommunication/threadCommunicationService';
import { SendMessageToThreadTool } from '#/agent/tools/thread-communication/threadCommunicationTools';
import { SessionOptionalCapabilityService } from '#/session/optionalCapability/sessionOptionalCapabilityService';

const BODY = 'PRIVATE_REVIEW_FIXTURE_BODY';

function harness() {
  const values: Record<string, unknown> = {
    [MEMORY_SECTION]: { enabled: true, approval: 'auto', budget: 2000, workspaces: { blocked: false } },
    [OPTIONAL_CAPABILITIES_SECTION]: { defaults: { memory: false, computer: false } },
  };
  const origins: Record<string, Record<string, string>> = {
    [OPTIONAL_CAPABILITIES_SECTION]: { 'defaults.memory': 'home', 'defaults.computer': 'home' },
  };
  const docs = new Map<string, unknown>();
  const config = {
    get: (domain: string) => values[domain],
    origins: (domain: string) => origins[domain] ?? {},
    onDidSectionChange: Event.None,
    ready: Promise.resolve(),
  };
  const flags = { explain: () => ({ enabled: true, source: 'default' as const }) };
  const store = {
    get: async (_scope: string, key: string) => docs.get(key),
    set: async (_scope: string, key: string, value: unknown) => { docs.set(key, value); },
  };
  const policy = new OptionalCapabilityPolicyService(config as never, flags as never, store as never);
  return { values, origins, docs, config, policy };
}

describe('optional capability review follow-up', () => {
  it('keeps a saved off closed while its document is loading and after a failed read', async () => {
    const { config } = harness();
    const flags = { explain: () => ({ enabled: true, source: 'default' as const }) };
    let finishRead!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finishRead = resolve; });
    const restoring = new OptionalCapabilityPolicyService(config as never, flags as never, { get: () => pending } as never);
    new SessionOptionalCapabilityService({ sessionId: 'restoring', workspaceId: 'open' } as never, restoring);
    expect(restoring.admit('web', { sessionId: 'restoring', workspaceId: 'open', agentId: 'main' })).toEqual({ admitted: false, reason: 'origin_unreadable' });
    finishRead({ revision: 3, hostId: 'local', overrides: { web: 'off' } });
    await restoring.load('restoring');
    expect(restoring.admit('web', { sessionId: 'restoring', workspaceId: 'open', agentId: 'main' })).toEqual({ admitted: false, reason: 'session_off' });

    const failing = new OptionalCapabilityPolicyService(config as never, flags as never, {
      get: async () => { throw new Error('unreadable document'); },
    } as never);
    await expect(failing.readSession('broken')).rejects.toThrow('unreadable document');
    expect(failing.admit('web', { sessionId: 'broken', workspaceId: 'open', agentId: 'main' })).toEqual({ admitted: false, reason: 'origin_unreadable' });
    await restoring.dispose();
    await failing.dispose();
  });

  it('drops memory projection when the session capability is closed and restores it on the next step', async () => {
    const { config, policy } = harness();
    let inventories = 0;
    let lists = 0;
    let reads = 0;
    const entry = {
      id: 'm_example', title: 'Review fixture', body: BODY, status: 'active', type: 'reference', pinned: true,
      updated: '2026-10-21T00:00:00Z', source: { writer: 'user', session: 'memory-session' },
    };
    const memoryStore = {
      inventory: async () => { inventories += 1; return { entries: [entry], complete: true, warnings: [] }; },
      list: async () => { lists += 1; return [entry]; },
      get: async () => { reads += 1; return entry; },
      onDidChange: Event.None,
    };
    const instantiation = {
      invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) => fn({
        get: (id: unknown) => {
          if (id === IOptionalCapabilityPolicy) return policy;
          if (id === IMemoryStore) return memoryStore;
          if (id === IAgentScopeContext) return { agentId: 'main' };
          if (id === IInstantiationService) return instantiation;
          throw new Error('missing service');
        },
      }),
    };
    const snapshot = new AgentMemorySnapshot(config as never, instantiation as never, { sessionId: 'memory-session', workspaceId: 'open' } as never, { agentId: 'main' } as never);
    const projections: string[] = [];
    let step: (() => Promise<unknown>) | undefined;
    let activationCalls = 0;
    const legacy = new CapabilitySnapshotService(config as never);
    const rebuild = new AgentCapabilityRebuildService(
      legacy,
      { sessionId: 'memory-session', workspaceId: 'open' } as never,
      { refreshMemorySnapshot: async () => { projections.push(await snapshot.get()); }, refreshSystemPrompt: async () => undefined } as never,
      { register: (_name: string, fn: () => Promise<unknown>) => { step = fn; return { dispose() {} }; } } as never,
      { activate: async () => { activationCalls += 1; } } as never,
      instantiation as never,
    );
    expect(await step!()).toBeUndefined();
    expect(activationCalls).toBe(0);
    const first = await snapshot.get();
    expect(first).not.toContain(BODY);
    expect(first).toContain('status=disabled');
    expect(inventories).toBe(0);
    expect(await snapshot.liveSessionEntries()).toEqual([]);
    expect(await snapshot.resolveReferences('[m_example]')).toEqual([]);
    expect(lists).toBe(0);
    expect(reads).toBe(0);

    await policy.setChoice('memory-session', 'memory', 'on');
    expect(await step!()).toContain('memory');
    expect(activationCalls).toBe(1);
    expect(projections.at(-1)).toContain(BODY);
    const sent = projections.at(-1)!;

    await policy.setChoice('memory-session', 'memory', 'off');
    expect(await step!()).toContain('memory');
    expect(projections.at(-1)).not.toContain(BODY);
    expect(projections.at(-1)).toContain('status=disabled');
    expect(sent).toContain(BODY);
    expect(policy.admit('memory', { sessionId: 'memory-session', workspaceId: 'open', agentId: 'main' }).admitted).toBe(false);
    await rebuild.dispose();
    await snapshot.dispose();
    await policy.dispose();
  });

  it('registers a static tool that was never admitted when the session turns on', async () => {
    const { config, policy } = harness();
    const registered = new AgentToolRegistryService();
    const toolId = Symbol('review-ThreadRead');
    const tool = { name: 'ThreadRead', description: 'review fixture', parameters: {}, resolveExecution: () => ({ output: '' }) };
    const instantiation = {
      invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) => fn({
        get: (id: unknown) => {
          if (id === IOptionalCapabilityPolicy) return policy;
          if (id === toolId) return tool;
          if (id === IAgentScopeContext) return { agentId: 'main', sessionId: 'hot-session', workspaceId: 'open' };
          throw new Error('missing service');
        },
      }),
    };
    const activation = new AgentToolActivationService(
      instantiation as never,
      registered,
      { data: () => ({}) } as never,
      { isToolActiveForDisclosure: (name: string) => policy.admit(name === 'ThreadRead' ? 'thread' : 'web', { sessionId: 'hot-session', workspaceId: 'open', agentId: 'main' }).admitted } as never,
      { disabledTools: [] } as never,
      { isAvailable: () => true, onDidChange: Event.None } as never,
      { subscribe: () => ({ dispose() {} }) } as never,
      config as never,
      { effectiveMode: () => 'reply', onDidChangeEffective: Event.None } as never,
      { ready: Promise.resolve(), isCleanActivePath: () => false } as never,
      { items: [{ id: toolId, options: { name: 'ThreadRead' } }], onDidChange: Event.None } as never,
    );
    await activation.activate();
    expect(registered.resolve('ThreadRead')).toBeUndefined();
    await policy.setChoice('hot-session', 'thread', 'on');
    expect(policy.admit('thread', { sessionId: 'hot-session', workspaceId: 'open', agentId: 'main' }).admitted).toBe(true);
    expect(registered.resolve('ThreadRead')?.name).toBe('ThreadRead');

    let step: (() => Promise<unknown>) | undefined;
    let activationCalls = 0;
    const rebuild = new AgentCapabilityRebuildService(
      new CapabilitySnapshotService(config as never),
      { sessionId: 'hot-session', workspaceId: 'open' } as never,
      { refreshMemorySnapshot: async () => undefined, refreshSystemPrompt: async () => undefined } as never,
      { register: (_name: string, fn: () => Promise<unknown>) => { step = fn; return { dispose() {} }; } } as never,
      { activate: async () => { activationCalls += 1; await activation.activate(); } } as never,
      instantiation as never,
    );
    expect(await step!()).toBeUndefined();
    expect(activationCalls).toBe(0);
    await policy.setChoice('hot-session', 'thread', 'off');
    expect(registered.resolve('ThreadRead')).toBeUndefined();
    const changed = await step!();
    expect(changed).toContain('thread communication');
    expect(activationCalls).toBe(1);
    expect(registered.resolve('ThreadRead')).toBeUndefined();
    await rebuild.dispose();
    await activation.dispose();
    await policy.dispose();
  });

  it('keeps the executing agent on a peer send without accepting a forged public caller', async () => {
    const { values, origins, policy } = harness();
    policy.retain('send-session', 'main', { workspaceId: 'open', agentKind: 'main', toolsSource: 'declared', declaredTools: ['ThreadSend'] });
    const accepted: Array<{ producer: { source?: { agentId?: string; executingAgentId?: string } } }> = [];
    const threads = Object.assign(Object.create(ThreadCommunicationService.prototype), {
      hostId: 'review-host',
      capabilities: { ready: Promise.resolve() },
      instantiation: { invokeFunction: (fn: (accessor: { get: () => unknown }) => unknown) => fn({ get: () => policy }) },
      mailbox: {
        getWorkspaceOverride: async () => undefined,
        acceptMessage: async (input: { producer: { source?: { agentId?: string; executingAgentId?: string } } }) => {
          accepted.push(input);
          return { payloadConflict: false, deduplicated: false, delivery: 'delivered', message: { messageId: 'm1', targetSeq: 1, acceptedAt: 1, target: input } };
        },
      },
      mailboxController: new AbortController(),
      ensureRecovery: async () => undefined,
      sessions: { get: async (id: string) => ({ id, workspaceId: 'open' }) },
    }) as ThreadCommunicationService;
    expect(await threads.isWorkspaceEnabled('open', { sessionId: 'send-session', workspaceId: 'open', agentId: 'main' })).toBe(true);
    const sendTool = new SendMessageToThreadTool(threads, { sessionId: 'send-session', workspaceId: 'open' } as never, {} as never, { agentId: 'main' } as never, { get: () => [] } as never);
    const execute = () => {
      const execution = sendTool.resolveExecution({
        thread: { host_id: 'local', workspace_id: 'open', session_id: 'target' },
        content: 'review fixture only',
        idempotency_key: 'review-key',
      } as never);
      if (!('execute' in execution)) throw new Error('ThreadSend did not resolve an execution');
      return execution.execute({ signal: new AbortController().signal, toolCallId: 'call-1', turnId: 1 });
    };
    const output = await execute();
    expect(output.output).toContain('m1');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.producer.source).not.toHaveProperty('agentId');
    expect(accepted[0]?.producer.source).not.toHaveProperty('executingAgentId');

    await policy.setChoice('send-session', 'thread', 'off');
    await expect(execute()).rejects.toMatchObject({ code: 'thread.disabled' });
    expect(accepted).toHaveLength(1);
    await policy.setChoice('send-session', 'thread', 'inherit');
    origins[THREAD_COMMUNICATION_SECTION] = { enabled: 'home' };
    values[THREAD_COMMUNICATION_SECTION] = { enabled: false };
    await expect(execute()).rejects.toMatchObject({ code: 'thread.disabled' });
    expect(accepted).toHaveLength(1);

    delete origins[THREAD_COMMUNICATION_SECTION];
    delete values[THREAD_COMMUNICATION_SECTION];
    policy.release('send-session', 'main');
    await expect(threads.sendMessage({
      target: { hostId: 'local', workspaceId: 'open', sessionId: 'target' },
      content: 'forged',
      idempotencyKey: 'forged-key',
      executingAgentId: 'main',
    } as never)).rejects.toMatchObject({ code: 'thread.disabled' });
    expect(accepted).toHaveLength(1);
    await policy.dispose();
  });

  it('admits a cua-driver server by its qualified tool name', async () => {
    const { policy } = harness();
    const desktop = { name: 'desktop', transport: 'stdio' as const, command: 'cua-driver', args: ['mcp'] };
    expect(isComputerMcpConfig(desktop)).toBe(true);
    policy.noteComputerServers([desktop, { name: 'notes', transport: 'stdio', command: 'node', args: ['mcp'] }]);
    expect(policy.computerServerNames()).toEqual(['desktop']);
    policy.retain('desktop-session', 'main', { workspaceId: 'open', agentKind: 'main', toolsSource: 'declared', declaredTools: ['mcp__desktop__*'] });
    policy.retain('desktop-session', 'child', { workspaceId: 'open', agentKind: 'child', taskTools: ['mcp__desktop__*'] });
    expect(policy.admit('computer', { sessionId: 'desktop-session', workspaceId: 'open', agentId: 'main' }).admitted).toBe(true);
    expect(policy.admit('computer', { sessionId: 'desktop-session', workspaceId: 'open', agentId: 'child' }).admitted).toBe(true);
    policy.release('desktop-session', 'main');
    policy.release('desktop-session', 'child');
    policy.retain('desktop-session', 'main', { workspaceId: 'open', agentKind: 'main', toolsSource: 'declared', declaredTools: ['mcp__notes__*', '*'] });
    expect(policy.admit('computer', { sessionId: 'desktop-session', workspaceId: 'open', agentId: 'main' }).reason).toBe('default_off');
    await policy.dispose();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { BranchBase } from '#/agent/contextMemory/contextEvents';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { computeUndoCut } from '#/agent/contextMemory/contextOps';
import { isUndoAnchor, isUndoAnchorOrigin } from '#/agent/contextMemory/conversationTime';
import { trimToSettledContextMessages } from '#/agent/contextMemory/settledTrim';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentLoopService } from '#/agent/loop/loop';
import { turnKey } from '#/agent/loop/turnOps';
import { constrainPermissionMode } from '#/agent/permissionMode/permissionMode';
import { permissionModeCeilingKey, PermissionSetModeCeiling } from '#/agent/permissionMode/permissionModeOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { BRANCH_CONFIG_SECTION, type BranchUsagePreference } from '#/app/branch/configSection';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IConfigService } from '#/app/config/config';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { shippedAgentProfileTemplate } from '#/app/shippedAgentProfiles/shippedAgentProfiles';
import {
  AgentBranchGuardService,
  IAgentBranchGuardService,
} from '#/features/btw/agentBranchGuardService';
import {
  AgentBranchSealed,
  AgentToolLockChanged,
  branchSealedKey,
  branchToolLockKey,
} from '#/features/btw/branchOps';
import {
  BRANCH_SEALED_MESSAGE,
  ISessionBranchService,
  ISessionBtwService,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from '#/features/btw/btw';
import { SessionBranchService, SessionBtwService } from '#/features/btw/btwService';
import { buildBranchSeedMessages } from '#/features/btw/seedBuilder';
import { BranchTool, branchToolDescription } from '#/features/btw/tools/branchTool';
import { MergeTool } from '#/features/btw/tools/mergeTool';
import type { ToolCall } from '#/kosong/contract/message';
import { resolveAuthoredRequestIdentity } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { AUTONOMOUS_RECEIPT_POLICY_LABEL } from '#/session/subagent/autonomousReceipt';
import { todoKey } from '#/session/todo/todoOps';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

function textMessage(
  id: string,
  role: ContextMessage['role'],
  text: string,
  extra: Partial<ContextMessage> = {},
): ContextMessage {
  return {
    id,
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
    ...extra,
  };
}

function createBranchFoldHarness(ix: TestInstantiationService, initialMeta: AgentMeta) {
  const branchId = 'branch-1';
  let branchMeta = initialMeta;
  let branchSealed = initialMeta.labels?.['branchSealed'] === 'true';
  const updateAgent = vi.fn(async (_agentId: string, update: (current: AgentMeta) => AgentMeta) => {
    branchMeta = update(branchMeta);
  });
  const branchHandle = {
    id: branchId,
    accessor: {
      get: (token: unknown) => {
        if (token === IAgentStateService) {
          return {
            get: (key: unknown) => {
              if (key === branchSealedKey) return branchSealed;
              if (key === turnKey) return { nextTurnId: 0 };
              return undefined;
            },
          };
        }
        if (token === IEventDispatcher) {
          return {
            dispatch: vi.fn(async (event: unknown) => {
              if (event instanceof AgentBranchSealed) branchSealed = event.sealed;
            }),
          };
        }
        if (token === IAgentPromptService) {
          return { list: () => ({ active: undefined, launching: undefined, pending: [] }) };
        }
        return undefined;
      },
    },
  };
  const mainHandle = {
    id: 'main',
    accessor: {
      get: (token: unknown) => {
        if (token === IAgentLoopService) {
          return { status: () => ({ state: 'idle', pendingTurnIds: [] }) };
        }
        if (token === IAgentPromptService) {
          return { list: () => ({ active: undefined, launching: undefined, pending: [] }) };
        }
        if (token === IAgentContextMemoryService) {
          return { appendObservable: vi.fn() };
        }
        return undefined;
      },
    },
  };
  const lifecycle = {
    get: (agentId: string) => agentId === branchId ? branchHandle : agentId === 'main' ? mainHandle : undefined,
  } as unknown as IAgentLifecycleService;
  const metadata = {
    read: async () => ({
      id: 'session-1',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents: { [branchId]: branchMeta },
    }),
    updateAgent,
  } as unknown as ISessionMetadata;
  ix.stub(IAgentLifecycleService, lifecycle);
  ix.stub(ISessionMetadata, metadata);
  ix.stub(ISessionContext, { sessionId: 'session-1', workspaceId: 'workspace-1' });
  ix.stub(IConfigService, {});
  ix.set(ISessionBranchService, new SyncDescriptor(SessionBranchService));
  return { service: ix.get(ISessionBranchService), updateAgent, getBranchMeta: () => branchMeta };
}

describe('SessionBtwService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let fork: ReturnType<typeof vi.fn>;
  let appendReminder: ReturnType<typeof vi.fn>;
  let formatDenyMessage: ReturnType<typeof vi.fn>;
  let executorEvents: ToolExecutorEventStubs;
  let agentMeta: AgentMeta;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    appendReminder = vi.fn(() => 'reminder-id');
    formatDenyMessage = vi.fn((message: string) => `${message} [worker guidance]`);
    executorEvents = stubToolExecutorEvents();
    agentMeta = { labels: { profileName: 'example' } };

    const child = {
      id: 'agent-btw-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentSystemReminderService) return { appendSystemReminder: appendReminder };
          if (id === IAgentToolApprovalService) return { formatDenyMessage };
          if (id === IAgentToolExecutorService) return executorEvents.executor;
          if (id === ISessionMetadata) {
            return {
              updateAgent: async (_agentId: string, update: (current: AgentMeta) => AgentMeta) => {
                agentMeta = update(agentMeta);
              },
            };
          }
          return undefined;
        },
      },
    };
    fork = vi.fn(async () => child);
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork,
    } as unknown as IAgentLifecycleService);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));
  });
  afterEach(() => disposables.dispose());

  it('forks main and configures a side-question child agent', async () => {
    const svc = ix.get(ISessionBtwService);
    const id = await svc.start();

    expect(id).toBe('agent-btw-1');
    expect(fork).toHaveBeenCalledWith('main');
    expect(agentMeta.labels).toEqual({
      profileName: 'example',
      [AUTONOMOUS_RECEIPT_POLICY_LABEL]: 'local',
      branch: 'true',
      branchSeed: 'verbatim',
      branchInitiator: 'user',
      toolsLocked: 'true',
    });
    expect(appendReminder).toHaveBeenCalledWith(SIDE_QUESTION_SYSTEM_REMINDER, {
      kind: 'injection',
      variant: 'btw',
    });
  });

  it('vetoes every tool call on the child through the btw deny listener', async () => {
    const svc = ix.get(ISessionBtwService);
    await svc.start();

    const toolCall: ToolCall = { type: 'function', id: 'call_1', name: 'Bash', arguments: '{}' };
    const decision = await executorEvents.fireBeforeExecute({
      turnId: 0,
      signal: new AbortController().signal,
      toolCall,
      toolCalls: [toolCall],
      args: {},
      execution: { approvalRule: 'Bash', execute: async () => ({ output: '' }) },
    });

    expect(decision).toEqual({
      veto: {
        output: `${TOOL_CALL_DISABLED_MESSAGE} [worker guidance]`,
        isError: true,
      },
    });
    expect(formatDenyMessage).toHaveBeenCalledWith(TOOL_CALL_DISABLED_MESSAGE);
  });
});

describe('SessionBranchService completion metadata', () => {
  let ix: TestInstantiationService;
  beforeEach(() => { ix = new TestInstantiationService(); });
  afterEach(() => { ix.dispose(); });

  it('records the sealing timestamp without changing task outcome fields', async () => {
    const completedAt = 1_234_567;
    const now = vi.spyOn(Date, 'now').mockReturnValue(completedAt);
    try {
      const harness = createBranchFoldHarness(ix, { parentAgentId: 'main' });
      const result = await harness.service.foldBranch({ branchId: 'branch-1', summary: 'Completed work', done: true });

      expect(result).toMatchObject({ status: 'merged', done: true, sealed: true });
      expect(harness.getBranchMeta()).toHaveProperty('completedAt', completedAt);
      expect(harness.getBranchMeta().status).toBeUndefined();
      expect(harness.getBranchMeta().taskId).toBeUndefined();
      expect(harness.getBranchMeta().labels?.['branchSealed']).toBe('true');
    } finally {
      now.mockRestore();
    }
  });

  it('preserves an existing completedAt value when sealing', async () => {
    const previousCompletedAt = 987_654;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234_567);
    try {
      const harness = createBranchFoldHarness(ix, {
        parentAgentId: 'main',
        status: 'completed',
        taskId: 'task-1',
        completedAt: previousCompletedAt,
        resultSummary: 'Existing terminal result',
      });
      await harness.service.foldBranch({ branchId: 'branch-1', summary: 'Fold branch', done: true });

      expect(harness.getBranchMeta()).toHaveProperty('completedAt', previousCompletedAt);
      expect(harness.getBranchMeta()).toMatchObject({
        status: 'completed',
        taskId: 'task-1',
        resultSummary: 'Existing terminal result',
      });
    } finally {
      now.mockRestore();
    }
  });

  it('does not complete branches on nonterminal merges', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234_567);
    try {
      const harness = createBranchFoldHarness(ix, { parentAgentId: 'main' });
      const result = await harness.service.foldBranch({ branchId: 'branch-1', summary: 'Interim update', done: false });

      expect(result).toMatchObject({ status: 'merged', done: false, sealed: false });
      expect(harness.getBranchMeta()).not.toHaveProperty('completedAt');
      expect(harness.getBranchMeta().status).toBeUndefined();
      expect(harness.updateAgent).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});

describe('Phase 0 + Phase 1 Branch & Merge Foundations', () => {
  it('trims partial assistant streaming messages and incomplete tool-call batches at the tail', () => {
    const u1 = textMessage('u1', 'user', 'inspect config', { origin: { kind: 'user' } });
    const a1 = textMessage('a1', 'assistant', 'done');
    const u2 = textMessage('u2', 'user', 'run check', { origin: { kind: 'user' } });
    const callA: ToolCall = { type: 'function', id: 'call-a', name: 'Read', arguments: '{}' };
    const callB: ToolCall = { type: 'function', id: 'call-b', name: 'Bash', arguments: '{}' };
    const unsettledAssistant: ContextMessage = {
      id: 'a2',
      role: 'assistant',
      content: [],
      toolCalls: [callA, callB],
    };
    const partialToolResult: ContextMessage = {
      id: 't1',
      role: 'tool',
      toolCallId: 'call-a',
      content: [{ type: 'text', text: 'ok' }],
      toolCalls: [],
    };
    const streamingAssistant = textMessage('a3', 'assistant', 'half sentence', { partial: true });

    expect(trimToSettledContextMessages([u1, a1, streamingAssistant])).toEqual([u1, a1]);
    expect(trimToSettledContextMessages([u1, a1, u2, unsettledAssistant, partialToolResult])).toEqual([u1, a1, u2]);

    const completeToolResultB: ContextMessage = {
      id: 't2',
      role: 'tool',
      toolCallId: 'call-b',
      content: [{ type: 'text', text: 'all good' }],
      toolCalls: [],
    };
    expect(trimToSettledContextMessages([u1, a1, u2, unsettledAssistant, partialToolResult, completeToolResultB])).toEqual([
      u1,
      a1,
      u2,
      unsettledAssistant,
      partialToolResult,
      completeToolResultB,
    ]);
  });

  it('builds fresh and verbatim branch seeds without mutating source history and stops undo at inheritedSeed', async () => {
    const sourceHistory: ContextMessage[] = [
      textMessage('u1', 'user', 'turn one', { origin: { kind: 'user' }, source: { turnId: 0 } }),
      textMessage('a1', 'assistant', 'answer one', { source: { turnId: 0 } }),
      textMessage('u2', 'user', 'turn two', { origin: { kind: 'user' }, source: { turnId: 1 } }),
      textMessage('a2', 'assistant', 'answer two', { source: { turnId: 1 } }),
      textMessage('u3', 'user', 'turn three', { origin: { kind: 'user' }, source: { turnId: 2 } }),
      textMessage('a3', 'assistant', 'answer three', { source: { turnId: 2 } }),
      textMessage('a4', 'assistant', 'in-flight streaming', { partial: true, source: { turnId: 3 } }),
    ];

    const fresh = await buildBranchSeedMessages({
      mode: 'fresh',
      sourceHistory,
      sourceAgentId: 'main',
      sessionId: 'sess-1',
      epoch: 0,
      notes: { goal: 'Ship clean branch merge' },
      todos: [{ title: 'Verify seed builder', status: 'in_progress' }],
      estimateText: (t) => Math.ceil(t.length / 4),
    });

    expect(sourceHistory).toHaveLength(7);
    expect(sourceHistory[0]!.inheritedSeed).toBeUndefined();
    expect(fresh.baseAnchor).toEqual({ turnId: 2, messageId: 'a3' });
    expect(fresh.messages[0]!.origin?.kind).toBe('compaction_summary');
    expect(fresh.messages.every((msg) => msg.inheritedSeed === true)).toBe(true);
    const carriedTexts = fresh.messages.slice(1).map((msg) => (msg.content[0] as { text: string }).text);
    expect(carriedTexts).toEqual(['turn two', 'answer two', 'turn three', 'answer three']);

    const branchLocalPrompt = textMessage('b-u1', 'user', 'branch follow-up', { origin: { kind: 'user' } });
    const branchLocalReply = textMessage('b-a1', 'assistant', 'branch answer');
    const combined = [...fresh.messages, branchLocalPrompt, branchLocalReply];
    expect(isUndoAnchor(fresh.messages[1]!)).toBe(false);
    expect(isUndoAnchor(branchLocalPrompt)).toBe(true);
    const cut = computeUndoCut(combined, 2);
    expect(cut.removedCount).toBe(1);
    expect(cut.stoppedAtCompaction).toBe(true);
    expect(cut.cutIndex).toBe(fresh.messages.length);
  });

  it('enforces forked permission mode ceiling and durable tool lock / seal state across wire replay', async () => {
    expect(constrainPermissionMode('yolo', 'auto')).toBe('auto');
    expect(constrainPermissionMode('review', 'auto')).toBe('auto');
    expect(constrainPermissionMode('manual', 'auto')).toBe('manual');

    const disposables = new DisposableStore();
    try {
      const storage = new InMemoryStorageService();
      const buildWireHost = () => {
        const ix = disposables.add(new TestInstantiationService());
        ix.stub(IFileSystemStorageService, storage);
        ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
        ix.set(IEventBus, new SyncDescriptor(EventBusService));
        registerTestAgentWire(ix, testWireScope('wire', 'branch-state-test'), {
          log: ix.get(IAppendLogStore),
          eventBus: ix.get(IEventBus),
        });
        const dispatcher = registerTestEventDispatcher(ix);
        const agentState = ix.get(IAgentStateService);
        agentState.contributeState(permissionModeCeilingKey);
        return { ix, dispatcher, agentState };
      };

      const executorEvents = stubToolExecutorEvents();
      const first = buildWireHost();
      first.ix.stub(IAgentToolExecutorService, executorEvents.executor);
      first.ix.stub(IAgentToolApprovalService, {
        formatDenyMessage: (msg: string) => msg,
      } as unknown as IAgentToolApprovalService);
      first.ix.set(IAgentBranchGuardService, new SyncDescriptor(AgentBranchGuardService));
      first.ix.get(IAgentBranchGuardService);

      await first.dispatcher.dispatch(new PermissionSetModeCeiling({ ceiling: 'auto' }));
      await first.dispatcher.dispatch(new AgentToolLockChanged({ locked: true }));
      expect(first.agentState.get(permissionModeCeilingKey)).toBe('auto');
      expect(first.agentState.get(branchToolLockKey)).toBe(true);

      const bashCall: ToolCall = { type: 'function', id: 'c1', name: 'Bash', arguments: '{}' };
      const mergeCall: ToolCall = { type: 'function', id: 'c2', name: 'Merge', arguments: '{}' };
      const blockedBash = await executorEvents.fireBeforeExecute({
        turnId: 0,
        signal: new AbortController().signal,
        toolCall: bashCall,
        toolCalls: [bashCall],
        args: {},
        execution: { approvalRule: 'Bash', execute: async () => ({ output: 'ok' }) },
      });
      expect(blockedBash?.veto?.output).toBe(TOOL_CALL_DISABLED_MESSAGE);

      const allowedMergeWhileLocked = await executorEvents.fireBeforeExecute({
        turnId: 0,
        signal: new AbortController().signal,
        toolCall: mergeCall,
        toolCalls: [mergeCall],
        args: {},
        execution: { approvalRule: 'Merge', execute: async () => ({ output: 'ok' }) },
      });
      expect(allowedMergeWhileLocked).toBeUndefined();

      await first.dispatcher.dispatch(new AgentToolLockChanged({ locked: false }));
      const unlockedBash = await executorEvents.fireBeforeExecute({
        turnId: 0,
        signal: new AbortController().signal,
        toolCall: bashCall,
        toolCalls: [bashCall],
        args: {},
        execution: { approvalRule: 'Bash', execute: async () => ({ output: 'ok' }) },
      });
      expect(unlockedBash).toBeUndefined();

      await first.dispatcher.dispatch(new AgentBranchSealed({ sealed: true, foldId: 'fold_1' }));
      await first.dispatcher.flush();

      const sealedMerge = await executorEvents.fireBeforeExecute({
        turnId: 0,
        signal: new AbortController().signal,
        toolCall: mergeCall,
        toolCalls: [mergeCall],
        args: {},
        execution: { approvalRule: 'Merge', execute: async () => ({ output: 'ok' }) },
      });
      expect(sealedMerge?.veto?.output).toBe(BRANCH_SEALED_MESSAGE);

      const replayed = buildWireHost();
      const replayedExecutorEvents = stubToolExecutorEvents();
      replayed.ix.stub(IAgentToolExecutorService, replayedExecutorEvents.executor);
      replayed.ix.stub(IAgentToolApprovalService, {
        formatDenyMessage: (msg: string) => msg,
      } as unknown as IAgentToolApprovalService);
      replayed.ix.set(IAgentBranchGuardService, new SyncDescriptor(AgentBranchGuardService));
      replayed.ix.get(IAgentBranchGuardService);
      await replayed.dispatcher.restore();

      expect(replayed.agentState.get(permissionModeCeilingKey)).toBe('auto');
      expect(replayed.agentState.get(branchToolLockKey)).toBe(false);
      expect(replayed.agentState.get(branchSealedKey)).toBe(true);
    } finally {
      disposables.dispose();
    }
  });

  it('isolates Gemini gateway branch cache identity across compaction while keeping the shared session stable', () => {
    const policy = resolveAuthoredRequestIdentity({ preset: 'claude_code_compatible' });
    const baseInput = {
      policy,
      protocol: 'anthropic' as const,
      model: 'gemini-4-carbon',
      rawSessionId: 'sess-alpha',
      parentAgentId: 'main',
      isKimiProvider: false,
      snapshot: {
        installationId: 'inst-1',
        sharedSessionId: '00000000-0000-4000-8000-000000000001',
        agentSessionId: '00000000-0000-4000-8000-000000000002',
        setTurnState: () => {},
      },
      runtimeVersion: '0.5.1',
      platform: 'win32' as const,
      arch: 'x64',
    };

    const mainEpoch0 = projectRequestIdentity({
      ...baseInput,
      rawAgentId: 'main',
      isBranch: false,
      compactionWindow: 0,
    });
    const branchEpoch0 = projectRequestIdentity({
      ...baseInput,
      rawAgentId: 'branch-1',
      isBranch: true,
      compactionWindow: 0,
    });
    const mainEpoch1 = projectRequestIdentity({
      ...baseInput,
      rawAgentId: 'main',
      isBranch: false,
      compactionWindow: 1,
    });
    const branchEpoch1 = projectRequestIdentity({
      ...baseInput,
      rawAgentId: 'branch-1',
      isBranch: true,
      compactionWindow: 1,
    });

    expect(mainEpoch0.cacheKey).toBeDefined();
    expect(branchEpoch0.cacheKey).toBeDefined();
    expect(branchEpoch0.cacheKey).not.toBe(mainEpoch0.cacheKey);
    expect(mainEpoch1.cacheKey).toBe(mainEpoch0.cacheKey);
    expect(branchEpoch1.cacheKey).not.toBe(branchEpoch0.cacheKey);
    expect(branchEpoch1.cacheKey).not.toBe(mainEpoch1.cacheKey);
  });

  it('exposes Branch and Merge on shipped main profile, updates Branch description dynamically, keeps Merge in open branches when branch capability flips off, and folds model-authored context with undo anchor + history pointer', async () => {
    const shippedMain = shippedAgentProfileTemplate('agent');
    expect(shippedMain?.text).toContain('- Branch');
    expect(shippedMain?.text).toContain('- Merge');

    let livePreference: BranchUsagePreference = 'balanced';
    const configStub = {
      get: (section: string) => (section === BRANCH_CONFIG_SECTION ? { enabled: true, usagePreference: livePreference } : {}),
    } as unknown as IConfigService;

    const branchToolOnMain = new BranchTool(
      {
        _serviceBrand: undefined,
        createBranch: vi.fn(async (input) => ({
          branchId: 'branch-side-1',
          parentAgentId: 'main',
          seed: input?.seed ?? 'fresh',
          title: input?.title ?? 'Investigate flaky suite',
          toolsLocked: false,
          started: true,
        })),
      } as unknown as ISessionBranchService,
      { agentId: 'main', isBranch: false } as IAgentScopeContext,
      configStub,
    );

    expect(branchToolOnMain.description).toBe(branchToolDescription('balanced'));
    livePreference = 'conservative';
    expect(branchToolOnMain.description).toContain('Branching preference (conservative)');
    livePreference = 'proactive';
    expect(branchToolOnMain.description).toContain('Branching preference (proactive)');

    const disposables = new DisposableStore();
    try {
      let branchCapAdmitted = true;
      const makePolicy = (scope: IAgentScopeContext, activeToolNames?: readonly string[]) => {
        const ix = disposables.add(new TestInstantiationService());
        ix.stub(IOptionalCapabilityPolicy, {
          admit: (id: string) => ({
            admitted: id === 'branch' ? branchCapAdmitted : true,
            reason: id === 'branch' && !branchCapAdmitted ? 'session_off' : 'admitted',
          }),
          choice: () => (branchCapAdmitted ? 'inherit' : 'off'),
          globalState: () => ({ allowed: true, hostLocked: false, defaultOn: true, origin: 'default', unresolved: false }),
          retain() {},
          release() {},
          load: async () => {},
        });
        ix.stub(ISessionContext, { sessionId: 'sess-1', workspaceId: 'ws-1' });
        ix.stub(ISessionDeliveryService, { effectiveMode: () => 'reply' });
        ix.stub(ICapabilitySnapshotService, { toolAvailable: () => true });
        ix.stub(IAgentScopeContext, scope);
        ix.stub(IAgentProfileService, {
          data: () => ({
            activeToolNames,
            modelCapabilities: { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 128_000 },
            thinkingLevel: 'off',
            systemPrompt: '',
          }),
        });
        ix.stub(IConfigService, { get: <T>() => ({ approval: 'auto' }) as T });
        ix.stub(ISessionToolPolicy, { disabledTools: () => [] });
        ix.stub(ISessionToolPolicyGate, { disabledTools: [] });
        ix.stub(IAgentToolExecutorService, { registerToolCallGuard: () => ({ dispose() {} }) });
        ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
        ix.set(IAgentToolPolicyService, new SyncDescriptor(AgentToolPolicyService));
        return ix.get(IAgentToolPolicyService);
      };

      const mainPolicy = makePolicy({ agentId: 'main', isBranch: false } as IAgentScopeContext, ['Read', 'Branch', 'Merge']);
      const branchPolicy = makePolicy(
        { agentId: 'branch-side-1', parentAgentId: 'main', isBranch: true } as IAgentScopeContext,
        ['Read', 'Branch'],
      );

      expect(mainPolicy.isToolActive('Branch')).toBe(true);
      expect(mainPolicy.isToolActive('Merge')).toBe(false);
      expect(branchPolicy.isToolActive('Branch')).toBe(false);
      expect(branchPolicy.isToolActive('Merge')).toBe(true);

      branchCapAdmitted = false;
      expect(mainPolicy.isToolActive('Branch')).toBe(false);
      expect(branchPolicy.isToolActive('Merge')).toBe(true);

      const agentsMeta: Record<string, AgentMeta> = {
        main: { labels: { profileName: 'agent' } },
      };
      const mainMessages: ContextMessage[] = [
        textMessage('m-u1', 'user', 'Main task', { origin: { kind: 'user' }, source: { turnId: 0 } }),
        textMessage('m-a1', 'assistant', 'Working on main task', { source: { turnId: 0 } }),
      ];
      const branchMessages: ContextMessage[] = [];
      const dispatchedBranchEvents: unknown[] = [];
      const mainEnqueuedStepRequests: unknown[] = [];
      const mainPromptEnqueued: unknown[] = [];
      const branchQueuedUserMessage = textMessage('q-u1', 'user', 'Queued follow-up from user while branch was open', {
        origin: { kind: 'user' },
      });
      const branchPendingPrompts = [{ id: 'queued-1', message: branchQueuedUserMessage, appendTiming: 'turnStart' as const }];

      const mainHandle = {
        id: 'main',
        accessor: {
          get: (token: unknown) => {
            if (token === IAgentProfileService) return { data: () => ({ profileName: 'agent', modelAlias: 'kimi-k2', thinkingLevel: 'medium' }) };
            if (token === IAgentContextMemoryService) {
              return {
                get: () => mainMessages,
                appendObservable: (msg: ContextMessage) => { mainMessages.push(msg); },
              };
            }
            if (token === IAgentStateService) {
              return {
                get: (key: unknown) => {
                  if (key === todoKey) return undefined;
                  if (key === contextWindowEpochKey) return 0;
                  return undefined;
                },
              };
            }
            if (token === IAgentTokenCountingService) return { estimateText: (t: string) => t.length };
            if (token === IAgentRuntimeService) return { workspaceRoots: () => ({ workDir: 'E:/repo' }) };
            if (token === IAgentLoopService) {
              return {
                status: () => ({ state: 'idle', pendingTurnIds: [] }),
                enqueue: (req: unknown) => {
                  mainEnqueuedStepRequests.push(req);
                  const msg = (req as { message?: ContextMessage }).message;
                  if (msg !== undefined) mainMessages.push(msg);
                },
              };
            }
            if (token === IAgentPromptService) {
              return {
                list: () => ({ active: undefined, launching: undefined, pending: [] }),
                enqueue: vi.fn(async (payload: unknown) => { mainPromptEnqueued.push(payload); }),
              };
            }
            return undefined;
          },
        },
      };

      let branchSealed = false;
      const branchPromptEnqueue = vi.fn(async () => ({ id: 'bp-1' }));
      const branchHandle = {
        id: 'branch-side-1',
        accessor: {
          get: (token: unknown) => {
            if (token === IEventDispatcher) {
              return {
                dispatch: vi.fn(async (ev: unknown) => {
                  dispatchedBranchEvents.push(ev);
                  if (ev instanceof AgentBranchSealed) branchSealed = ev.sealed;
                }),
              };
            }
            if (token === IAgentContextMemoryService) {
              return {
                get: () => branchMessages,
                append: (...msgs: ContextMessage[]) => { branchMessages.push(...msgs); },
              };
            }
            if (token === IAgentStateService) {
              return {
                get: (key: unknown) => {
                  if (key === branchSealedKey) return branchSealed;
                  if (key === branchToolLockKey) return false;
                  if (key === turnKey) return { nextTurnId: 3 };
                  return undefined;
                },
              };
            }
            if (token === IAgentPromptService) {
              return {
                enqueue: branchPromptEnqueue,
                list: () => ({ active: undefined, launching: undefined, pending: [...branchPendingPrompts] }),
                abortQueued: vi.fn(async (id: string) => {
                  const idx = branchPendingPrompts.findIndex((p) => p.id === id);
                  if (idx < 0) return false;
                  branchPendingPrompts.splice(idx, 1);
                  return true;
                }),
              };
            }
            return undefined;
          },
        },
      };

      const sessionIx = disposables.add(new TestInstantiationService());
      sessionIx.stub(IAgentLifecycleService, {
        get: (id: string) => (id === 'main' ? mainHandle : id === 'branch-side-1' ? branchHandle : undefined),
        fork: vi.fn(async (_parentId: string, opts?: { labels?: Record<string, string>; userLabel?: string }) => {
          agentsMeta['branch-side-1'] = {
            parentAgentId: 'main',
            userLabel: opts?.userLabel,
            labels: { ...opts?.labels },
          };
          return branchHandle;
        }),
        commitCreate: vi.fn(),
        discard: vi.fn(async () => {}),
      } as unknown as IAgentLifecycleService);
      sessionIx.stub(ISessionMetadata, {
        snapshot: () => ({ id: 'sess-1', createdAt: 1, updatedAt: 1, archived: false, agents: agentsMeta }),
        read: async () => ({ id: 'sess-1', createdAt: 1, updatedAt: 1, archived: false, agents: agentsMeta }),
        updateAgent: async (id: string, updater: (cur: AgentMeta) => AgentMeta) => {
          agentsMeta[id] = updater(agentsMeta[id] ?? {});
        },
      } as unknown as ISessionMetadata);
      sessionIx.stub(ISessionContext, { sessionId: 'sess-1', workspaceId: 'ws-1' });
      sessionIx.stub(IConfigService, configStub);
      sessionIx.stub(IOptionalCapabilityPolicy, {
        admit: () => ({ admitted: true, reason: 'admitted' }),
        choice: () => 'inherit',
        globalState: () => ({ allowed: true, hostLocked: false, defaultOn: true, origin: 'default', unresolved: false }),
        retain() {},
        release() {},
        load: async () => {},
      });
      sessionIx.set(ISessionBranchService, new SyncDescriptor(SessionBranchService));
      const branchService = sessionIx.get(ISessionBranchService);

      const created = await branchService.createBranch({
        parentAgentId: 'main',
        initiator: 'agent',
        task: 'Check retry jitter edge case',
        title: 'Retry jitter check',
        name: 'retry_jitter',
      });
      expect(created).toEqual({
        branchId: 'branch-side-1',
        parentAgentId: 'main',
        seed: 'fresh',
        title: 'Retry jitter check',
        toolsLocked: false,
        started: true,
      });
      expect(dispatchedBranchEvents.some((ev) => ev instanceof BranchBase)).toBe(true);
      expect(branchPromptEnqueue).toHaveBeenCalledWith(expect.objectContaining({ waitForLaunch: false }));

      const prompted = await branchService.foldBranch({ branchId: 'branch-side-1' });
      expect(prompted.status).toBe('prompted');
      expect(prompted.sealed).toBe(false);

      const mergeTool = new MergeTool(branchService, {
        agentId: 'branch-side-1',
        parentAgentId: 'main',
        isBranch: true,
      } as IAgentScopeContext);
      const mergeExec = mergeTool.resolveExecution({
        summary: 'Confirmed exponential backoff caps at 60s; no regression in retryService.',
        asks: ['Confirm whether 5m persistence retry should share jitter'],
        done: true,
      });
      if (!('execute' in mergeExec)) throw new Error('Expected executable Merge tool');
      const mergeOut = await mergeExec.execute({
        signal: new AbortController().signal,
        turnId: 2,
        toolCallId: 'merge-call-1',
      });
      expect(mergeOut.isError).toBeUndefined();
      const parsedReceipt = JSON.parse(mergeOut.output as string);
      expect(parsedReceipt).toMatchObject({
        branch_id: 'branch-side-1',
        status: 'merged',
        done: true,
        sealed: true,
        handed_back_prompts: 1,
        through_turn: 2,
      });

      const mergedMsg = mainMessages.at(-1)!;
      expect(mergedMsg.origin).toMatchObject({
        kind: 'branch_fold',
        branchId: 'branch-side-1',
        branchTitle: 'Retry jitter check',
        asks: ['Confirm whether 5m persistence retry should share jitter'],
        throughTurnId: 2,
        done: true,
      });
      expect(isUndoAnchorOrigin(mergedMsg.origin)).toBe(true);
      expect(isUndoAnchor(mergedMsg)).toBe(true);

      const textBody = (mergedMsg.content[0] as { text: string }).text;
      expect(textBody).toContain('Merged branch branch-side-1 (Retry jitter check):');
      expect(textBody).toContain('Confirmed exponential backoff caps at 60s; no regression in retryService.');
      expect(textBody).toContain('- Confirm whether 5m persistence retry should share jitter');
      expect(textBody).toContain('Branch history: HistoryList({ agent_id: "branch-side-1" }) · HistoryRead({ agent_id: "branch-side-1", turn: 2 })');
      expect(textBody).not.toContain('Edited files:');
      expect(textBody).not.toContain('Commands run:');
      expect(mainPromptEnqueued).toHaveLength(1);

      const undoCutAfterMerge = computeUndoCut(mainMessages, 1);
      expect(undoCutAfterMerge.removedCount).toBe(1);
      expect(mainMessages.slice(0, undoCutAfterMerge.cutIndex).some((m) => m.origin?.kind === 'branch_fold')).toBe(false);
    } finally {
      disposables.dispose();
    }
  });
});

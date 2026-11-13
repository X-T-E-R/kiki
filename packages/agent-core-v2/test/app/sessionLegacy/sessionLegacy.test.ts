import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { PersistedGoalReader } from '#/agent/goal/goalRead';
import { goalKey } from '#/agent/goal/goalOps';
import { REPLAY_ABI_VERSION } from '#/state/eventDispatcherService';
import { encodeReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { JOURNAL_BOUNDARY_HASH_BYTES, JOURNAL_HEAD_HASH_BYTES } from '#/wire/wire';
import { type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { ISessionLegacyService } from '#/app/sessionLegacy/sessionLegacy';
import { SessionLegacyService } from '#/app/sessionLegacy/sessionLegacyService';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

function accessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`Unexpected service request: ${String(id)}`);
    },
  };
}

function stubSessionChain(ix: TestInstantiationService, session: ISessionScopeHandle): void {
  const handler = {
    id: 'wd',
    kind: 'program',
    accessor: {
      get<T>(id: ServiceIdentifier<T>): T {
        if (id === ISessionLifecycleService) {
          return {
            resume: () => Promise.resolve(session),
            get: () => session,
          } as T;
        }
        return session.accessor.get(id);
      },
    },
    dispose: () => {},
  } as const;
  ix.stub(ISessionIndex, {
    get: (id: string) =>
      Promise.resolve(
        id === session.id
          ? {
              id: session.id,
              workspaceId: 'wd',
              cwd: '/workspace',
              createdAt: 1,
              updatedAt: 1,
              archived: false,
            }
          : undefined,
      ),
  });
  ix.stub(ISessionIndexMirror, {
    _serviceBrand: undefined,
    record: () => {},
    epoch: () => 0,
    dirtyEpoch: () => undefined,
    settleDirty: () => {},
    invalidate: () => {},
    pending: () => [],
    acknowledge: () => {},
    runExclusive: (operation) => operation(),
    evict: () => Promise.resolve(),
    drain: () => Promise.resolve(),
  });
  ix.stub(ISessionManager, {
    _serviceBrand: undefined,
    create: () => Promise.resolve(handler),
    resume: () => Promise.resolve(handler),
    get: () => handler,
    list: () => [handler],
    close: () => Promise.resolve(),
    archive: () => Promise.resolve(),
    restore: () => Promise.resolve(handler),
    delete: () => Promise.resolve(),
    fork: () => Promise.resolve(handler),
  } as unknown as ISessionManager);
}

function installGoalPersistence(ix: TestInstantiationService): {
  readonly logs: IAppendLogStore;
  readonly docs: IAtomicDocumentStore;
  readonly storage: InMemoryStorageService;
} {
  const storage = new InMemoryStorageService();
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  return { logs: ix.get(IAppendLogStore), docs: ix.get(IAtomicDocumentStore), storage };
}

async function seedPersistedGoal(logs: IAppendLogStore, scope: string): Promise<void> {
  const now = Date.now();
  logs.append(scope, AGENT_WIRE_RECORD_KEY, {
    type: 'goal.create',
    goalId: 'goal-persisted',
    objective: 'Read the saved goal',
    completionCriterion: 'The cold read returns its saved state',
    status: 'active',
    followUpTiming: 'tasks_done',
    controlRevision: 4,
    wallClockResumedAt: now,
    time: now,
  });
  logs.append(scope, AGENT_WIRE_RECORD_KEY, {
    type: 'goal.update',
    goalId: 'goal-persisted',
    controlRevision: 9,
    tokensUsed: 125,
    turnsUsed: 2,
    wallClockMs: 3_000,
    budgetLimits: { tokenBudget: 1_000, turnBudget: 6, wallClockBudgetMs: 60_000 },
    time: now + 1,
  });
  await logs.flush(scope, AGENT_WIRE_RECORD_KEY);
}

describe('Session legacy reads (best-effort runtime state)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
  });

  afterEach(async () => {
    await disposables.dispose();
  });

  it('returns the persisted effort when the saved model alias no longer resolves', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: 'removed-model',
        modelCapabilities: UNKNOWN_CAPABILITY,
        thinkingLevel: 'high',
        systemPrompt: '',
      }),
      getModel: () => 'removed-model',
      getModelCapabilities: () => UNKNOWN_CAPABILITY,
      getEffectiveThinkingLevel: () => 'high',
      resolveModelContext: () => {
        throw new Error('removed-model cannot be resolved');
      },
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [IAgentProfileService, profile],
        [IAgentTokenCountingService, { get: () => ({ size: 25, measured: 20, estimated: 5 }), statusSize: () => 25 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agent),
      whenReady: () => Promise.resolve(agent),
      list: () => [agent],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-test',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
        [ISessionCronService, { _serviceBrand: undefined }],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-test');

    expect(status).toMatchObject({
      busy: false,
      model: 'removed-model',
      thinking_level: 'high',
    });
    expect(status.max_context_tokens).toBeUndefined();
  });

  it('reports an empty thinking level for a never-bound main agent', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: undefined,
        modelCapabilities: UNKNOWN_CAPABILITY,
        thinkingLevel: 'off',
        systemPrompt: '',
      }),
      getModel: () => '',
      getModelCapabilities: () => UNKNOWN_CAPABILITY,
      getEffectiveThinkingLevel: () => 'off',
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [IAgentProfileService, profile],
        [IAgentTokenCountingService, { get: () => ({ size: 0, measured: 0, estimated: 0 }), statusSize: () => 0 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [IModelService, { getDefaultModel: () => undefined }],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agent),
      whenReady: () => Promise.resolve(agent),
      list: () => [agent],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-unbound',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
        [ISessionCronService, { _serviceBrand: undefined }],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-unbound');

    expect(status).toMatchObject({
      busy: false,
      model: undefined,
      thinking_level: '',
    });
    expect(status.max_context_tokens).toBeUndefined();
  });

  it('falls back to the default model limit when no model is bound', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: undefined,
        modelCapabilities: UNKNOWN_CAPABILITY,
        thinkingLevel: 'off',
        systemPrompt: '',
      }),
      getModel: () => '',
      getModelCapabilities: () => UNKNOWN_CAPABILITY,
      getEffectiveThinkingLevel: () => 'off',
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [IAgentProfileService, profile],
        [IAgentTokenCountingService, { get: () => ({ size: 0, measured: 0, estimated: 0 }), statusSize: () => 0 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [IModelService, { getDefaultModel: () => 'default-model' }],
        [
          IModelCatalog,
          {
            get: (id: string) => {
              if (id !== 'default-model') throw new Error(`unknown model ${id}`);
              return { capabilities: { max_context_tokens: 200_000 } };
            },
          },
        ],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agent),
      whenReady: () => Promise.resolve(agent),
      list: () => [agent],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-draft',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
        [ISessionCronService, { _serviceBrand: undefined }],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-draft');

    expect(status).toMatchObject({
      model: undefined,
      max_context_tokens: 200_000,
    });
  });

  it('uses the input cap as the status denominator and clamps usage to 1', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: 'gpt-5',
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 200_000,
          max_input_tokens: 100_000,
          dynamically_loaded_tools: false,
        },
        thinkingLevel: 'medium',
        systemPrompt: '',
      }),
      getModel: () => 'gpt-5',
      getModelCapabilities: () => ({
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 200_000,
        max_input_tokens: 100_000,
        dynamically_loaded_tools: false,
      }),
      getEffectiveThinkingLevel: () => 'medium',
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [IAgentProfileService, profile],
        [IAgentTokenCountingService, { get: () => ({ size: 120_000, measured: 110_000, estimated: 10_000 }), statusSize: () => 120_000 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agent),
      whenReady: () => Promise.resolve(agent),
      list: () => [agent],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-capped',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
        [ISessionCronService, { _serviceBrand: undefined }],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-capped');

    expect(status).toMatchObject({
      max_context_tokens: 100_000,
      context_usage: 1,
    });
  });

  it('returns a complete cold persisted goal in one call across resumable slices without resuming or acquiring', async () => {
    const sessionId = 'session-cold-goal';
    const workspaceId = 'workspace-cold-goal';
    const restoreError = new Error('cold restore attempted');
    const manager = {
      _serviceBrand: undefined,
      get: vi.fn((_id: string) => undefined),
      resume: vi.fn(async () => { throw restoreError; }),
      acquire: vi.fn(async () => { throw restoreError; }),
    };
    const index = {
      get: vi.fn(async (id: string) => id === sessionId ? {
        id: sessionId,
        workspaceId,
        cwd: '/workspace',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
      } : undefined),
    };
    ix.stub(ISessionManager, manager as unknown as ISessionManager);
    ix.stub(ISessionIndex, index);
    const { logs, storage } = installGoalPersistence(ix);
    const agentScope = `sessions/${workspaceId}/${sessionId}/agents/main`;
    await seedPersistedGoal(logs, agentScope);
    for (let index = 0; index < 5; index++) {
      logs.append(agentScope, AGENT_WIRE_RECORD_KEY, { type: 'goal.read.unrelated', index, payload: 'x'.repeat(2 << 20), time: Date.now() });
    }
    await logs.flush(agentScope, AGENT_WIRE_RECORD_KEY);
    expect(await storage.size(agentScope, AGENT_WIRE_RECORD_KEY)).toBeGreaterThan(8 * 1024 * 1024);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const service = ix.get(ISessionLegacyService);
    const goal = await service.goal(sessionId);

    expect(goal).toMatchObject({
      goalId: 'goal-persisted',
      objective: 'Read the saved goal',
      completionCriterion: 'The cold read returns its saved state',
      status: 'active',
      followUpTiming: 'tasks_done',
      controlRevision: 9,
      tokensUsed: 125,
      turnsUsed: 2,
      budget: {
        tokenBudget: 1_000,
        turnBudget: 6,
        wallClockBudgetMs: 60_000,
        remainingTokens: 875,
        remainingTurns: 4,
        remainingWallClockMs: expect.any(Number),
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    });
    expect(goal?.wallClockMs).toBeGreaterThanOrEqual(3_000);
    expect(index.get).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(manager.get).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(manager.resume).not.toHaveBeenCalled();
    expect(manager.acquire).not.toHaveBeenCalled();
  });

  it('reads a live unstarted main goal from session context without creating main', async () => {
    const sessionId = 'session-live-unstarted-goal';
    const workspaceId = 'workspace-live-unstarted-goal';
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(),
    };
    const session: ISessionScopeHandle = {
      id: sessionId,
      kind: LifecycleScope.Session,
      accessor: accessor([
        [ISessionContext, { workspaceId }],
        [IAgentLifecycleService, agents],
      ]),
      dispose: () => {},
    };
    const restoreError = new Error('cold restore attempted');
    const manager = {
      _serviceBrand: undefined,
      get: vi.fn(() => session),
      resume: vi.fn(async () => { throw restoreError; }),
      acquire: vi.fn(async () => { throw restoreError; }),
    };
    const index = { get: vi.fn(async () => undefined) };
    ix.stub(ISessionManager, manager as unknown as ISessionManager);
    ix.stub(ISessionIndex, index);
    const { logs } = installGoalPersistence(ix);
    await seedPersistedGoal(logs, `sessions/${workspaceId}/${sessionId}/agents/main`);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const goal = await ix.get(ISessionLegacyService).goal(sessionId);

    expect(goal).toMatchObject({ goalId: 'goal-persisted', controlRevision: 9, budget: {
      tokenBudget: 1_000,
      turnBudget: 6,
      wallClockBudgetMs: 60_000,
      remainingTokens: 875,
      remainingTurns: 4,
    } });
    expect(manager.get).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(manager.resume).not.toHaveBeenCalled();
    expect(manager.acquire).not.toHaveBeenCalled();
    expect(index.get).not.toHaveBeenCalled();
    expect(agents.get).toHaveBeenCalledExactlyOnceWith('main');
    expect(agents.create).not.toHaveBeenCalled();
  });

  it('returns the valid goal prefix when the append log ends with a torn JSON record', async () => {
    const sessionId = 'session-torn-goal';
    const workspaceId = 'workspace-torn-goal';
    const restoreError = new Error('cold restore attempted');
    const manager = {
      _serviceBrand: undefined,
      get: vi.fn(() => undefined),
      resume: vi.fn(async () => { throw restoreError; }),
      acquire: vi.fn(async () => { throw restoreError; }),
    };
    const index = {
      get: vi.fn(async () => ({
        id: sessionId,
        workspaceId,
        cwd: '/workspace',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
      })),
    };
    ix.stub(ISessionManager, manager as unknown as ISessionManager);
    ix.stub(ISessionIndex, index);
    const { logs, storage } = installGoalPersistence(ix);
    const agentScope = `sessions/${workspaceId}/${sessionId}/agents/main`;
    await seedPersistedGoal(logs, agentScope);
    await storage.append(agentScope, AGENT_WIRE_RECORD_KEY, Buffer.from('{"type":"goal.update","tokensUsed":999'));
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const goal = await ix.get(ISessionLegacyService).goal(sessionId);

    expect(goal).toMatchObject({ goalId: 'goal-persisted', controlRevision: 9, tokensUsed: 125 });
    expect(manager.resume).not.toHaveBeenCalled();
    expect(manager.acquire).not.toHaveBeenCalled();
  });

  it('resumes a checkpointed goal over an appended tail without parsing the prefix', async () => {
    const { logs, docs, storage } = installGoalPersistence(ix);
    const scope = 'sessions/checkpoint-session/agents/main';
    logs.append(scope, AGENT_WIRE_RECORD_KEY, {
      type: 'goal.read.unrelated',
      payload: 'prefix'.repeat(JOURNAL_HEAD_HASH_BYTES / 6 + 1024),
      time: 1,
    });
    await logs.flush(scope, AGENT_WIRE_RECORD_KEY);
    const prefix = await storage.read(scope, AGENT_WIRE_RECORD_KEY);
    if (prefix === undefined) throw new Error('checkpoint prefix was not stored');
    const checkpointSize = prefix.byteLength;
    expect(checkpointSize).toBeGreaterThanOrEqual(JOURNAL_HEAD_HASH_BYTES);
    const mtimeMs = await storage.mtime(scope, AGENT_WIRE_RECORD_KEY) ?? 0;
    const generation = await logs.generation(scope, AGENT_WIRE_RECORD_KEY);
    const headHash = createHash('sha256')
      .update(prefix.subarray(0, JOURNAL_HEAD_HASH_BYTES))
      .digest('hex')
      .slice(0, 32);
    const boundarySha256 = createHash('sha256')
      .update(prefix.subarray(Math.max(0, checkpointSize - JOURNAL_BOUNDARY_HASH_BYTES)))
      .digest('hex');
    const goalId = 'goal-checkpoint';
    const graph = encodeReplayCheckpointGraph({
      states: [
        {
          name: goalKey.name,
          value: {
            goalId,
            objective: 'Continue from the checkpoint',
            completionCriterion: 'Apply the appended control update',
            status: 'paused',
            followUpTiming: 'tasks_done',
            controlRevision: 10,
            turnsUsed: 3,
            tokensUsed: 20,
            wallClockMs: 4_000,
            budgetLimits: { tokenBudget: 1_000, turnBudget: 10, wallClockBudgetMs: 60_000 },
          },
          meta: { history: [], checkpoints: [], nextPatchId: 0 },
        },
        {
          name: 'state.checkpoint.unrelated',
          value: new Uint8Array(1 << 20),
          meta: { history: [], checkpoints: [], nextPatchId: 0 },
        },
      ],
    });
    await docs.set(`${scope}/replay-checkpoints`, 'engine-v1', {
      format: 1,
      replayAbi: REPLAY_ABI_VERSION,
      wire: { size: checkpointSize, mtimeMs, headHash, boundarySha256, storeGeneration: generation },
      stateNames: [goalKey.name, 'state.checkpoint.unrelated'],
      pluginInterpretation: [],
      graph,
    });
    logs.append(scope, AGENT_WIRE_RECORD_KEY, {
      type: 'goal.update',
      goalId,
      controlRevision: 11,
      tokensUsed: 25,
      turnsUsed: 4,
      wallClockMs: 5_000,
      time: 2,
    });
    await logs.flush(scope, AGENT_WIRE_RECORD_KEY);
    const read = vi.spyOn(logs, 'read');
    const reader = new PersistedGoalReader(logs, docs, storage);

    const goal = await reader.read(scope);

    expect(goal).toMatchObject({
      goalId,
      controlRevision: 11,
      tokensUsed: 25,
      turnsUsed: 4,
      budget: { tokenBudget: 1_000, turnBudget: 10, wallClockBudgetMs: 60_000 },
    });
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[2]).toMatchObject({ startOffset: checkpointSize });
  });

  it('falls back to canonical wire replay when the engine-v1 goal checkpoint graph is corrupted', async () => {
    const { logs, docs, storage } = installGoalPersistence(ix);
    const scope = 'sessions/corrupt-checkpoint-session/agents/main';
    await seedPersistedGoal(logs, scope);
    const prefix = await storage.read(scope, AGENT_WIRE_RECORD_KEY);
    if (prefix === undefined) throw new Error('goal wire was not stored');
    const mtimeMs = await storage.mtime(scope, AGENT_WIRE_RECORD_KEY) ?? 0;
    const generation = await logs.generation(scope, AGENT_WIRE_RECORD_KEY);
    const prefixSha256 = createHash('sha256').update(prefix).digest('hex');
    await docs.set(`${scope}/replay-checkpoints`, 'engine-v1', {
      format: 1,
      replayAbi: REPLAY_ABI_VERSION,
      wire: { size: prefix.byteLength, mtimeMs, prefixSha256, storeGeneration: generation },
      stateNames: [goalKey.name],
      pluginInterpretation: [],
      graph: 'not-a-valid-encoded-graph',
    });

    const reader = new PersistedGoalReader(logs, docs, storage);
    const goal = await reader.read(scope);

    expect(goal).toMatchObject({
      goalId: 'goal-persisted',
      controlRevision: 9,
      tokensUsed: 125,
      turnsUsed: 2,
    });
  });
});

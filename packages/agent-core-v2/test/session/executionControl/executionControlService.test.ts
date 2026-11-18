import { expect, it, vi } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { Turn, TurnResult } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import type { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionExecutionControl } from '#/session/executionControl/executionControl';
import { SessionExecutionControl } from '#/session/executionControl/executionControlService';
import { resumeAgentTask } from '#/session/executionControl/resumeAgentTask';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { IEventDispatcher } from '#/state/eventDispatcher';

it.each(['resume', 'cancelPause', 'legacy'] as const)('cold %s preserves necessary owners and skips idle history when indexed', async mode => {
  const documents = new Map<string, unknown>();
  const agents = { owner: { parentAgentId: null }, queued: { parentAgentId: 'owner' }, finite: { parentAgentId: null }, late: { parentAgentId: null } };
  const disposables = new DisposableStore();
  const handles = new Map<string, IAgentScopeHandle>();
  let control!: ISessionExecutionControl;
  const create = vi.fn(async ({ agentId }: { agentId?: string }) => {
    if (agentId === undefined) throw new Error('Explicit identity required');
    control.register(agentId, { pause: async () => undefined, resume: async () => undefined });
    return handles.get(agentId)!;
  });
  const prompt = (queued: boolean): IAgentPromptService => ({ hasQueuedWork: () => queued } as IAgentPromptService);
  for (const id of ['owner', 'queued', 'finite', 'late', ...Array.from({ length: 100 }, (_, index) => `idle-${index}`)]) {
    const service = prompt(id === 'queued');
    handles.set(id, { kind: 'agent', id, accessor: { get: token => {
      if (token === IAgentPromptService) return service as never;
      if (token === IAgentTaskService) return { hasUnfinishedWork: (restoring?: boolean) => restoring || id === 'finite' } as never;
      throw new Error('Only work ownership is inspected');
    } }, dispose: () => {} });
  }
  const services = () => createServices(disposables, { additionalServices: reg => {
    reg.definePartialInstance(IAtomicDocumentStore, {
      get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
      set: async (_scope, key, value) => { documents.set(key, structuredClone(value)); },
    });
    reg.definePartialInstance(ISessionContext, makeSessionContext({ sessionId: 'fixture-session', workspaceId: 'fixture-workspace', sessionScope: 'sessions/fixture', sessionDir: '/fixture', cwd: '/fixture' }));
    reg.definePartialInstance(ISessionMetadata, { update: async () => {}, snapshot: () => ({ id: 'fixture-session', createdAt: 0, updatedAt: 0, archived: false, agents }) });
    reg.definePartialInstance(IAgentLifecycleService, { list: () => [...handles.values()], get: id => handles.get(id), create });
    reg.define(ISessionExecutionControl, SessionExecutionControl);
  } });
  try {
    control = services().get(ISessionExecutionControl);
    const registrations = [...handles.keys()].map(id => control.register(id, { pause: async () => undefined, resume: async () => undefined }));
    await control.pause({ operationId: 'pause-owners' });
    await vi.waitFor(async () => expect((await control.read()).phase).toBe('paused'));
    await control.retainAgent('late');
    expect(documents.get('execution-control.json')).toMatchObject({ requiredAgents: ['queued', 'finite', 'late'] });
    if (mode === 'legacy') {
      const document = documents.get('execution-control.json') as Record<string, unknown>;
      delete document['requiredAgents'];
    }
    await Promise.all(registrations.map(registration => registration.dispose()));
    handles.clear();
    control = services().get(ISessionExecutionControl);
    await control.ready();
    const action = mode === 'legacy' ? 'resume' : mode;
    await expect(control[action]({ operationId: 'release-owners', pauseOperationId: 'pause-owners' })).resolves.toMatchObject({ phase: 'running' });
    const owners = ['owner', 'queued', 'finite', 'late'];
    const expected = mode === 'legacy' ? [...owners, ...Array.from({ length: 100 }, (_, index) => `idle-${index}`)] : owners;
    expect(create.mock.calls.map(([input]) => input.agentId)).toEqual(expected);
    expect(create).toHaveBeenCalledTimes(mode === 'legacy' ? 104 : 4);
  } finally { await disposables.dispose(); }
});

it('cold resume retains child with running parent agent task and settles unresumed task on release', async () => {
  const documents = new Map<string, unknown>();
  const agents = { parent: { parentAgentId: null }, child: { parentAgentId: 'parent' } };
  const disposables = new DisposableStore();
  const handles = new Map<string, IAgentScopeHandle>();
  let control!: ISessionExecutionControl;
  const pausedTask: AgentTaskInfo = {
    taskId: 'agent-paused1', kind: 'agent', agentId: 'child',
    description: 'finishing child', executorId: 'native', executorProtocol: 'native',
    status: 'running', detached: true, startedAt: 1, endedAt: null,
  };
  const findPausedAgentTask = vi.fn(async (agentId: string) => (agentId === 'child' ? pausedTask : undefined));
  const settlePausedAgentTask = vi.fn(async () => ({ ...pausedTask, status: 'killed' as const, endedAt: 2 }));
  const registerHandle = (id: string, runningChildTask: boolean) => {
    const prompt = { hasQueuedWork: () => false } as IAgentPromptService;
    const tasks = {
      hasUnfinishedWork: () => false,
      list: () => (id === 'parent' && runningChildTask ? [pausedTask] : []),
      findPausedAgentTask,
      settlePausedAgentTask,
    } as unknown as IAgentTaskService;
    const scope = { parentAgentId: id === 'child' ? 'parent' : undefined } as IAgentScopeContext;
    const lifecycle = { list: () => [...handles.values()], get: (target: string) => handles.get(target) } as unknown as IAgentLifecycleService;
    const metadata = { snapshot: () => ({ id: 'fixture-session', createdAt: 0, updatedAt: 0, archived: false, agents }) } as unknown as ISessionMetadata;
    handles.set(id, {
      kind: 'agent',
      id,
      accessor: {
        get: (token) => {
          if (token === IAgentPromptService) return prompt as never;
          if (token === IAgentTaskService) return tasks as never;
          if (token === IAgentScopeContext) return scope as never;
          if (token === IAgentLifecycleService) return lifecycle as never;
          if (token === ISessionMetadata) return metadata as never;
          throw new Error('Unexpected service lookup');
        },
      },
      dispose: () => {},
    });
  };
  const create = vi.fn(async ({ agentId }: { agentId?: string }) => {
    if (agentId === undefined) throw new Error('Explicit identity required');
    registerHandle(agentId, false);
    control.register(agentId, { pause: async () => undefined, resume: async () => undefined, turnId: () => undefined });
    return handles.get(agentId)!;
  });
  const services = () => createServices(disposables, { additionalServices: (reg) => {
    reg.definePartialInstance(IAtomicDocumentStore, {
      get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
      set: async (_scope, key, value) => { documents.set(key, structuredClone(value)); },
    });
    reg.definePartialInstance(ISessionContext, makeSessionContext({ sessionId: 'fixture-session', workspaceId: 'fixture-workspace', sessionScope: 'sessions/fixture', sessionDir: '/fixture', cwd: '/fixture' }));
    reg.definePartialInstance(ISessionMetadata, { update: async () => {}, snapshot: () => ({ id: 'fixture-session', createdAt: 0, updatedAt: 0, archived: false, agents }) });
    reg.definePartialInstance(IAgentLifecycleService, { list: () => [...handles.values()], get: (id) => handles.get(id), create });
    reg.define(ISessionExecutionControl, SessionExecutionControl);
  } });
  try {
    control = services().get(ISessionExecutionControl);
    registerHandle('parent', true);
    registerHandle('child', false);
    const parentReg = control.register('parent', { pause: async () => undefined, resume: async () => undefined, turnId: () => undefined });
    const childReg = control.register('child', { pause: async () => undefined, resume: async () => undefined, turnId: () => undefined });
    await control.pause({ operationId: 'pause-unresumed' });
    await vi.waitFor(async () => expect((await control.read()).phase).toBe('paused'));
    expect(documents.get('execution-control.json')).toMatchObject({ requiredAgents: ['child'] });
    await Promise.all([parentReg.dispose(), childReg.dispose()]);
    handles.clear();
    control = services().get(ISessionExecutionControl);
    await control.ready();
    await expect(control.resume({ operationId: 'resume-unresumed', pauseOperationId: 'pause-unresumed' })).resolves.toMatchObject({ phase: 'running' });
    expect(findPausedAgentTask).toHaveBeenCalledWith('child', undefined);
    expect(settlePausedAgentTask).toHaveBeenCalledWith('agent-paused1', 'Execution ended before the pause point and was not resumed.');
  } finally {
    await disposables.dispose();
  }
});

it('resumeAgentTask wires TaskStop cancellation to turn.cancel and restores collaboration and parentSteering', async () => {
  let resolveDurable!: (result: TurnResult) => void;
  const durableResult = new Promise<TurnResult>((resolve) => { resolveDurable = resolve; });
  const turnController = new AbortController();
  const cancel = vi.fn((reason?: unknown) => {
    turnController.abort(reason);
    resolveDurable({ type: 'cancelled', reason: reason ?? new Error('stopped'), steps: 1 });
    return true;
  });
  const turn: Turn = {
    id: 3,
    state: 'running',
    signal: turnController.signal,
    ready: Promise.resolve(),
    result: durableResult,
    durableResult,
    cancel,
  };
  let registeredTask: SubagentTask | undefined;
  const registerTask = vi.fn((task: unknown) => {
    registeredTask = task as SubagentTask;
    return 'agent-resumed1';
  });
  const pausedInfo: AgentTaskInfo = {
    taskId: 'agent-resumed1',
    kind: 'agent',
    description: 'Resumed worker slice',
    status: 'running',
    startedAt: 100,
    endedAt: null,
    detached: true,
    agentId: 'child-1',
    profile: 'worker',
    collaborationTaskName: 'slice_owner',
    collaborationAgentType: 'worker',
    parentSteering: 'saved steering fallback',
  };
  const tasks: Partial<IAgentTaskService> = {
    findPausedAgentTask: vi.fn(async () => pausedInfo),
    registerTask: registerTask as IAgentTaskService['registerTask'],
  };
  let liveSteering: string | undefined = 'live parent steering';
  const handles = new Map<string, IAgentScopeHandle>();
  const lifecycle: Partial<IAgentLifecycleService> = {
    get: (id: string) => handles.get(id),
    list: () => [...handles.values()],
  };
  const metadata: Partial<ISessionMetadata> = {
    snapshot: () => ({
      id: 'fixture-session',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents: {
        'child-1': {
          parentAgentId: 'parent-1',
          labels: {
            [COLLABORATION_LATEST_TASK_LABEL]: 'agent-resumed1',
            [COLLABORATION_TASK_NAME_LABEL]: 'label_fallback',
            [COLLABORATION_AGENT_TYPE_LABEL]: 'worker',
          },
        },
      },
    }),
    updateAgent: vi.fn(async () => {}),
  };
  const parent: IAgentScopeHandle = {
    kind: 'agent',
    id: 'parent-1',
    accessor: {
      get: (token) => {
        if (token === IAgentTaskService) return tasks as never;
        if (token === IEventDispatcher) return { dispatch: vi.fn(async () => {}) } as never;
        if (token === ISessionSubagentService) return { notifyAgentTaskStopped: vi.fn() } as never;
        if (token === IAgentLifecycleService) return lifecycle as never;
        if (token === ISessionExecutionControl) return { isParked: () => false } as never;
        if (token === ISessionMetadata) return metadata as never;
        return undefined as never;
      },
    },
    dispose: () => {},
  };
  const child: IAgentScopeHandle = {
    kind: 'agent',
    id: 'child-1',
    accessor: {
      get: (token) => {
        if (token === IAgentScopeContext) return { agentId: 'child-1', parentAgentId: 'parent-1' } as never;
        if (token === IAgentLifecycleService) return lifecycle as never;
        if (token === ISessionMetadata) return metadata as never;
        if (token === IAgentProfileService) return { getParentSteering: () => liveSteering } as never;
        if (token === IAgentContextMemoryService) return { get: () => [] } as never;
        if (token === IAgentTokenCountingService) return undefined as never;
        if (token === IAgentActivityView) return undefined as never;
        return undefined as never;
      },
    },
    dispose: () => {},
  };
  handles.set('parent-1', parent);
  handles.set('child-1', child);

  await resumeAgentTask(child, turn);
  expect(registeredTask).toBeDefined();
  const baseInfo = {
    taskId: 'agent-resumed1',
    description: 'Resumed worker slice',
    status: 'running' as const,
    startedAt: 100,
    endedAt: null,
    detached: true,
  };
  expect(registeredTask!.collaborationTaskName).toBe('slice_owner');
  expect(registeredTask!.collaborationAgentType).toBe('worker');
  expect(registeredTask!.toInfo(baseInfo).parentSteering).toBe('live parent steering');

  liveSteering = 'updated parent steering';
  expect(registeredTask!.toInfo(baseInfo).parentSteering).toBe('updated parent steering');

  const sinkController = new AbortController();
  let settledStatus: string | undefined;
  const runPromise = registeredTask!.start({
    signal: sinkController.signal,
    appendOutput: () => {},
    setFinalOutput: () => {},
    settle: async (outcome) => {
      settledStatus = outcome.status;
      return true;
    },
  });
  sinkController.abort(new Error('TaskStop requested'));
  await runPromise;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(settledStatus).toBe('killed');
});

it('cold cancelPause after interrupted pausing materializes settling participants even when requiredAgents is empty', async () => {
  const documents = new Map<string, unknown>();
  const agents = { parent: { parentAgentId: null }, child: { parentAgentId: 'parent' } };
  const disposables = new DisposableStore();
  const handles = new Map<string, IAgentScopeHandle>();
  let control!: ISessionExecutionControl;
  const neverSettle = new Promise<undefined>(() => {});
  const registerHandle = (id: string) => {
    const prompt = { hasQueuedWork: () => id === 'parent' } as IAgentPromptService;
    const tasks = {
      hasUnfinishedWork: () => false,
      list: () => [],
      findPausedAgentTask: vi.fn(async () => undefined),
      settlePausedAgentTask: vi.fn(async () => undefined),
    } as unknown as IAgentTaskService;
    const scope = { parentAgentId: id === 'child' ? 'parent' : undefined } as IAgentScopeContext;
    const lifecycle = { list: () => [...handles.values()], get: (target: string) => handles.get(target) } as unknown as IAgentLifecycleService;
    const metadata = { snapshot: () => ({ id: 'fixture-session', createdAt: 0, updatedAt: 0, archived: false, agents }) } as unknown as ISessionMetadata;
    handles.set(id, {
      kind: 'agent',
      id,
      accessor: {
        get: (token) => {
          if (token === IAgentPromptService) return prompt as never;
          if (token === IAgentTaskService) return tasks as never;
          if (token === IAgentScopeContext) return scope as never;
          if (token === IAgentLifecycleService) return lifecycle as never;
          if (token === ISessionMetadata) return metadata as never;
          throw new Error('Unexpected service lookup');
        },
      },
      dispose: () => {},
    });
  };
  const create = vi.fn(async ({ agentId }: { agentId?: string }) => {
    if (agentId === undefined) throw new Error('Explicit identity required');
    registerHandle(agentId);
    control.register(agentId, { pause: async () => undefined, resume: async () => undefined, turnId: () => undefined });
    return handles.get(agentId)!;
  });
  const services = () => createServices(disposables, { additionalServices: (reg) => {
    reg.definePartialInstance(IAtomicDocumentStore, {
      get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
      set: async (_scope, key, value) => { documents.set(key, structuredClone(value)); },
    });
    reg.definePartialInstance(ISessionContext, makeSessionContext({ sessionId: 'fixture-session', workspaceId: 'fixture-workspace', sessionScope: 'sessions/fixture', sessionDir: '/fixture', cwd: '/fixture' }));
    reg.definePartialInstance(ISessionMetadata, { update: async () => {}, snapshot: () => ({ id: 'fixture-session', createdAt: 0, updatedAt: 0, archived: false, agents }) });
    reg.definePartialInstance(IAgentLifecycleService, { list: () => [...handles.values()], get: (id) => handles.get(id), create });
    reg.define(ISessionExecutionControl, SessionExecutionControl);
  } });
  try {
    control = services().get(ISessionExecutionControl);
    registerHandle('parent');
    registerHandle('child');
    const parentReg = control.register('parent', { pause: () => neverSettle, resume: async () => undefined });
    const childReg = control.register('child', { pause: () => neverSettle, resume: async () => undefined });
    await expect(control.pause({ operationId: 'hot-switch:interrupted' })).resolves.toMatchObject({ phase: 'pausing' });
    expect(documents.get('execution-control.json')).toMatchObject({
      checkpointComplete: false,
      requiredAgents: [],
      state: { phase: 'pausing' },
    });

    await Promise.all([parentReg.dispose(), childReg.dispose()]);
    handles.clear();
    control = services().get(ISessionExecutionControl);
    await control.ready();
    await expect(control.read()).resolves.toMatchObject({ phase: 'failed', pauseOperationId: 'hot-switch:interrupted' });

    await expect(
      control.cancelPause({ operationId: 'hot-switch:interrupted:cancelPause', pauseOperationId: 'hot-switch:interrupted' }),
    ).resolves.toMatchObject({ phase: 'running', agents: [] });
    expect(create.mock.calls.map(([input]) => input.agentId)).toEqual(['parent', 'child']);
  } finally {
    await disposables.dispose();
  }
});

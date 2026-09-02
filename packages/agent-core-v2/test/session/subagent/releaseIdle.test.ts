import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { AgentRunHandle } from '#/session/subagent/subagent';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  SUBAGENT_RELEASE_GRACE_ENV,
  SUBAGENT_RELEASE_GRACE_MS,
  SessionSubagentService,
  isReleasable,
  resolveReleaseGraceMs,
} from '#/session/subagent/subagentService';

import { stubFlag } from '../../app/flag/stubs';

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly run: ReturnType<typeof vi.fn>;
  readonly runs: Array<{ resolve: (summary: string) => void; reject: (error: unknown) => void }>;
  executionState: 'idle' | 'running';
  loopState: 'idle' | 'running';
  pendingTurnIds: number[];
  hasPendingRequests: boolean;
  activePrompt: unknown;
  pendingPrompts: unknown[];
  activeTasks: unknown[];
  swarmActive: boolean;
}

function fakeAgent(id: string): FakeAgent {
  const runs: FakeAgent['runs'] = [];
  const agent: { -readonly [K in keyof FakeAgent]?: FakeAgent[K] } = {
    runs,
    executionState: 'idle',
    loopState: 'idle',
    pendingTurnIds: [],
    hasPendingRequests: false,
    activePrompt: undefined,
    pendingPrompts: [],
    activeTasks: [],
    swarmActive: false,
  };
  const run = vi.fn(async (): Promise<AgentRunHandle> => {
    const completion = new Promise<{ summary: string }>((resolve, reject) => {
      runs.push({ resolve: (summary) => resolve({ summary }), reject });
    });
    return { agentId: id, turn: {} as AgentRunHandle['turn'], completion };
  });
  const services = new Map<unknown, unknown>([
    [IAgentExecutionService, { run, status: () => ({ state: agent.executionState }) }],
    [
      IAgentLoopService,
      {
        status: () => ({
          state: agent.loopState,
          pendingTurnIds: agent.pendingTurnIds,
          hasPendingRequests: agent.hasPendingRequests,
        }),
      },
    ],
    [IAgentPromptService, { list: () => ({ active: agent.activePrompt, pending: agent.pendingPrompts }) }],
    [IAgentTaskService, { list: () => agent.activeTasks }],
    [IAgentSwarmService, { get isActive() { return agent.swarmActive; } }],
    [IAgentProfileService, { data: () => ({ profileName: undefined }) }],
  ]);
  const handle = {
    id,
    accessor: {
      get: (token: unknown) => {
        const service = services.get(token);
        if (service === undefined) throw new Error(`unstubbed service for ${String(token)}`);
        return service;
      },
    },
  } as unknown as IAgentScopeHandle;
  agent.handle = handle;
  agent.run = run;
  return agent as FakeAgent;
}

describe('SessionSubagentService idle release', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let agents: Map<string, FakeAgent>;
  let remove: ReturnType<typeof vi.fn>;
  let flagEnabled: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    flagEnabled = true;
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agents = new Map();
    remove = vi.fn(async (agentId: string) => {
      agents.delete(agentId);
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      get: (agentId: string) => agents.get(agentId)?.handle,
      remove,
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      get: () => undefined,
    } as unknown as ISessionAgentProfileCatalog);
    ix.stub(IFlagService, stubFlag(() => flagEnabled));
    ix.stub(IBootstrapService, { _serviceBrand: undefined, getEnv: () => undefined } as unknown as IBootstrapService);
    ix.stub(ILogService, { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as unknown as ILogService);
    ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
  });

  afterEach(() => {
    disposables.dispose();
    vi.useRealTimers();
  });

  async function startRun(agentId: string): Promise<AgentRunHandle> {
    const svc = ix.get(ISessionSubagentService);
    return svc.run(agentId, { kind: 'prompt', prompt: 'go' }, { signal: new AbortController().signal });
  }

  it('releases a completed subagent once it has stayed idle through the grace period', async () => {
    const child = fakeAgent('agent-1');
    agents.set('agent-1', child);
    const run = await startRun('agent-1');
    child.runs[0]!.resolve('done');
    await run.completion;
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS - 1);
    expect(remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(remove).toHaveBeenCalledWith('agent-1');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('releases after a failed run as well', async () => {
    const child = fakeAgent('agent-1');
    agents.set('agent-1', child);
    const run = await startRun('agent-1');
    child.runs[0]!.reject(new Error('boom'));
    await run.completion.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS);
    expect(remove).toHaveBeenCalledWith('agent-1');
  });

  it('keeps the scope when a new run starts inside the grace period', async () => {
    const child = fakeAgent('agent-1');
    agents.set('agent-1', child);
    const first = await startRun('agent-1');
    child.runs[0]!.resolve('done');
    await first.completion;
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS / 2);
    const second = await startRun('agent-1');
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS);
    expect(remove).not.toHaveBeenCalled();
    child.runs[1]!.resolve('done again');
    await second.completion;
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('skips release while the agent is busy, queued, has live tasks, or is in swarm mode', async () => {
    const child = fakeAgent('agent-1');
    agents.set('agent-1', child);
    const run = await startRun('agent-1');
    child.runs[0]!.resolve('done');
    await run.completion;
    child.activeTasks = [{ taskId: 'bg' }];
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS);
    expect(remove).not.toHaveBeenCalled();

    child.activeTasks = [];
    expect(isReleasable(child.handle)).toBe(true);
    child.executionState = 'running';
    expect(isReleasable(child.handle)).toBe(false);
    child.executionState = 'idle';
    child.pendingPrompts = [{}];
    expect(isReleasable(child.handle)).toBe(false);
    child.pendingPrompts = [];
    child.hasPendingRequests = true;
    expect(isReleasable(child.handle)).toBe(false);
    child.hasPendingRequests = false;
    child.swarmActive = true;
    expect(isReleasable(child.handle)).toBe(false);
  });

  it('reads the grace period from the environment and falls back on invalid values', () => {
    expect(resolveReleaseGraceMs(() => undefined)).toBe(SUBAGENT_RELEASE_GRACE_MS);
    expect(resolveReleaseGraceMs((name) => (name === SUBAGENT_RELEASE_GRACE_ENV ? '250' : undefined))).toBe(250);
    expect(resolveReleaseGraceMs(() => '0')).toBe(0);
    expect(resolveReleaseGraceMs(() => '-5')).toBe(SUBAGENT_RELEASE_GRACE_MS);
    expect(resolveReleaseGraceMs(() => 'soon')).toBe(SUBAGENT_RELEASE_GRACE_MS);
  });

  it('never releases the main agent and honours the flag', async () => {
    const main = fakeAgent('main');
    agents.set('main', main);
    const run = await startRun('main');
    main.runs[0]!.resolve('done');
    await run.completion;
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS);
    expect(remove).not.toHaveBeenCalled();

    flagEnabled = false;
    const child = fakeAgent('agent-2');
    agents.set('agent-2', child);
    const childRun = await startRun('agent-2');
    child.runs[0]!.resolve('done');
    await childRun.completion;
    await vi.advanceTimersByTimeAsync(SUBAGENT_RELEASE_GRACE_MS);
    expect(remove).not.toHaveBeenCalled();
  });
});

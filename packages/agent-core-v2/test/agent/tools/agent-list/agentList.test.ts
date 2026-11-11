import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import { IAgentActivityView, type AgentActivityState, type AgentActivityTelemetry } from '#/agent/activityView/activityView';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService, type AgentLoopStatus } from '#/agent/loop/loop';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import type { AgentExecutionStatus } from '#/app/agentExecutor/agentExecutor';
import { AgentListTool } from '#/agent/tools/agent-list/agentListTool';
import { IAgentListTool, type AgentListOutput } from '#/agent/tools/agent-list/agent-list';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';
import { SUBAGENT_SECTION, type SubagentConfig } from '#/session/subagent/configSection';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;
const disposables = new DisposableStore();
afterEach(() => {
  vi.useRealTimers();
  disposables.clear();
});

function childMeta(options: {
  readonly parent?: string;
  readonly name?: string;
  readonly profile?: string;
}): AgentMeta {
  const labels: Record<string, string> = {
    parentAgentId: options.parent ?? 'main',
  };
  if (options.name !== undefined) labels[COLLABORATION_TASK_NAME_LABEL] = options.name;
  if (options.profile !== undefined) labels[COLLABORATION_AGENT_TYPE_LABEL] = options.profile;
  return { type: 'sub', labels };
}

interface LiveChildStub {
  readonly execution?: AgentExecutionStatus['state'] | AgentExecutionStatus;
  readonly loop?: AgentLoopStatus;
  readonly profile?: Partial<ProfileData>;
  readonly activity?: {
    readonly state?: Partial<AgentActivityState>;
    readonly telemetry?: AgentActivityTelemetry;
  };
  readonly statusTokens?: number;
}

function makeTool(options: {
  readonly callerAgentId?: string;
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  readonly execution?: Readonly<Record<string, AgentExecutionStatus['state']>>;
  readonly loops?: Readonly<Record<string, AgentLoopStatus>>;
  readonly liveChildren?: Readonly<Record<string, LiveChildStub>>;
  readonly subagentConfig?: SubagentConfig;
  readonly tasks?: readonly {
    readonly taskId?: string;
    readonly agentId: string;
    readonly status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
    readonly startedAt?: number;
    readonly endedAt?: number | null;
    readonly model?: string;
    readonly thinkingEffort?: string;
    readonly thinkingEffortExplicit?: boolean;
  }[];
}): IAgentListTool {
  const services = disposables.add(new TestInstantiationService());
  services.stub(IAgentScopeContext, { agentId: options.callerAgentId ?? 'main' });
  if (options.subagentConfig !== undefined) {
    services.stub(IConfigService, {
      get: (section: string) => (section === SUBAGENT_SECTION ? options.subagentConfig : undefined),
    } as unknown as IConfigService);
  }
  services.stub(ISessionMetadata, {
    read: async () => ({ agents: options.agents ?? {} }),
    getAgentExecutor: async (agentId: string) => options.agents?.[agentId]?.executor,
  } as ISessionMetadata);
  services.stub(IAgentTaskService, {
    list: () => (options.tasks ?? []).map((task, index) => ({
      kind: 'agent',
      taskId: task.taskId ?? `task-${String(index + 1)}`,
      description: '',
      agentId: task.agentId,
      status: task.status,
      startedAt: task.startedAt ?? index,
      endedAt: task.endedAt !== undefined ? task.endedAt : task.status === 'running' ? null : index,
      model: task.model,
      thinkingEffort: task.thinkingEffort,
      thinkingEffortExplicit: task.thinkingEffortExplicit,
    })),
  } as unknown as IAgentTaskService);
  services.stub(IAgentLifecycleService, {
    get: (agentId) => {
      const liveSpec = options.liveChildren?.[agentId];
      const stateOrStatus = liveSpec?.execution ?? options.execution?.[agentId];
      if (liveSpec === undefined && stateOrStatus === undefined) return undefined;
      const child = disposables.add(new TestInstantiationService());
      if (stateOrStatus !== undefined) {
        const execStatus: AgentExecutionStatus =
          typeof stateOrStatus === 'string' ? { state: stateOrStatus } : stateOrStatus;
        child.stub(IAgentExecutionService, { status: () => execStatus });
      }
      child.stub(IAgentLoopService, {
        status: () => liveSpec?.loop ?? options.loops?.[agentId] ?? { state: 'idle', pendingTurnIds: [], hasPendingRequests: false },
      });
      if (liveSpec?.profile !== undefined) {
        child.stub(IAgentProfileService, {
          data: () => ({
            modelCapabilities: UNKNOWN_CAPABILITY,
            thinkingLevel: 'off',
            systemPrompt: '',
            ...liveSpec.profile,
          }),
        } as unknown as IAgentProfileService);
      }
      if (liveSpec?.activity !== undefined) {
        child.stub(IAgentActivityView, {
          state: () => ({
            lifecycle: 'ready',
            background: [],
            ...liveSpec.activity?.state,
          }),
          telemetry: () => liveSpec.activity?.telemetry ?? { toolCallCount: 0 },
        } as IAgentActivityView);
      }
      if (liveSpec?.statusTokens !== undefined) {
        child.stub(IAgentTokenCountingService, {
          statusSize: () => liveSpec.statusTokens!,
        } as unknown as IAgentTokenCountingService);
      }
      return {
        id: agentId,
        kind: 'agent',
        accessor: child,
        dispose: () => child.dispose(),
      } satisfies IAgentScopeHandle;
    },
  });
  services.set(IAgentListTool, new SyncDescriptor(AgentListTool));
  return services.get(IAgentListTool);
}

async function listAgents(
  tool: IAgentListTool,
  args: { include_finished?: boolean; raw?: boolean } = {},
): Promise<AgentListOutput> {
  const result = await executeTool(tool, {
    turnId: 1,
    toolCallId: 'call_1',
    args,
    signal,
  });
  expect(result).toMatchObject({ isError: false });
  expect(typeof result.output).toBe('string');
  if (typeof result.output !== 'string') throw new Error('expected JSON text output');
  return JSON.parse(result.output) as AgentListOutput;
}

describe('AgentListTool', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)('uses a committed %s outcome when its task is no longer retained', async (status) => {
    for (const execution of [undefined, { worker: 'idle' as const }]) {
      const tool = makeTool({ agents: { worker: { ...childMeta({}), status, taskId: 'old-task', completedAt: 10 } }, execution });
      expect((await listAgents(tool)).agents).toEqual([]);
      expect((await listAgents(tool, { include_finished: true })).agents[0]?.status)
        .toBe(status === 'completed' ? 'completed' : status === 'failed' ? 'errored' : 'interrupted');
    }
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('uses a matching committed %s outcome above a stale running task', async (status) => {
    const tool = makeTool({ agents: { worker: { ...childMeta({}), status, taskId: 'task-1', completedAt: 10 } },
      execution: { worker: 'idle' }, tasks: [{ agentId: 'worker', status: 'running' }] });
    expect((await listAgents(tool)).agents).toEqual([]);
    expect((await listAgents(tool, { include_finished: true })).agents[0]?.status)
      .toBe(status === 'completed' ? 'completed' : status === 'failed' ? 'errored' : 'interrupted');
  });

  it('retains an already lost task despite a matching metadata outcome', async () => {
    const tool = makeTool({ agents: { worker: { ...childMeta({}), status: 'completed', taskId: 'task-1', completedAt: 10 } },
      tasks: [{ agentId: 'worker', status: 'lost' }] });
    expect((await listAgents(tool, { include_finished: true })).agents[0]?.status).toBe('interrupted');
  });

  it('keeps a later active execution ahead of the previous committed outcome', async () => {
    const tool = makeTool({ agents: { worker: { ...childMeta({}), status: 'completed', completedAt: 10 } },
      execution: { worker: 'running' } });
    expect((await listAgents(tool)).agents[0]?.status).toBe('running');
  });

  it('does not replace a newer tracking task with an older committed outcome', async () => {
    const tool = makeTool({ agents: { worker: { ...childMeta({}), status: 'completed', taskId: 'old-task', completedAt: 10 } },
      tasks: [{ agentId: 'worker', status: 'running', startedAt: 20 }] });
    expect((await listAgents(tool)).agents[0]?.status).toBe('running');
  });

  it.each([undefined, 'failed', 'completed'] as const)('keeps a persistence-blocked child discoverable with task status %s', async (status) => {
    const tool = makeTool({ agents: { worker: childMeta({ name: 'worker' }) }, execution: { worker: 'running' },
      loops: { worker: { state: 'running', activeTurnId: 3, finalizing: true, pendingTurnIds: [], hasPendingRequests: false,
        persistenceFailure: { executionOutcome: 'completed', message: 'storage append failed: no space left on device' } } },
      tasks: status === undefined ? [] : [{ agentId: 'worker', status }],
    });
    expect((await listAgents(tool)).agents).toEqual([{ agent_id: 'worker', name: 'worker', status: 'persistence_failed',
      persistence_failure: { turn_id: 3, execution_outcome: 'completed', message: 'storage append failed: no space left on device' } }]);
  });

  it.each(['timed_out', 'completed', 'failed', 'killed', 'lost'] as const)(
    'keeps a live child visible after its background task is %s',
    async (status) => {
      const tool = makeTool({
        agents: { worker: childMeta({ name: 'worker' }) },
        execution: { worker: 'running' },
        tasks: [{ agentId: 'worker', status }],
      });
      expect((await listAgents(tool)).agents).toEqual([
        { agent_id: 'worker', name: 'worker', status: 'running' },
      ]);
    },
  );

  it.each(['starting', 'running', 'cancelling'] as const)(
    'reports an untracked %s execution as running',
    async (state) => {
      const tool = makeTool({
        agents: { worker: childMeta({}) },
        execution: { worker: state },
      });
      expect((await listAgents(tool)).agents[0]).toMatchObject({
        agent_id: 'worker', status: 'running',
      });
    },
  );

  it('uses the settled task status after the live execution becomes idle', async () => {
    const execution: Record<string, AgentExecutionStatus['state']> = { worker: 'running' };
    const tool = makeTool({
      agents: { worker: childMeta({}) },
      execution,
      tasks: [{ agentId: 'worker', status: 'timed_out' }],
    });
    expect((await listAgents(tool)).agents[0]?.status).toBe('running');
    execution['worker'] = 'idle';
    expect((await listAgents(tool)).agents).toEqual([]);
    expect((await listAgents(tool, { include_finished: true })).agents[0]?.status).toBe('interrupted');
  });

  it('reports a broken live executor as errored, not running', async () => {
    const tool = makeTool({
      agents: { worker: childMeta({}) },
      execution: { worker: 'broken' },
    });
    expect((await listAgents(tool)).agents).toEqual([]);
    expect((await listAgents(tool, { include_finished: true })).agents[0]?.status).toBe('errored');
  });

  it('reports a closed executor as interrupted, not running', async () => {
    const tool = makeTool({
      agents: { worker: childMeta({}) },
      execution: { worker: 'closed' },
      tasks: [{ agentId: 'worker', status: 'running' }],
    });
    expect((await listAgents(tool)).agents).toEqual([]);
    expect((await listAgents(tool, { include_finished: true })).agents[0]?.status).toBe('interrupted');
  });

  it('lists a child that has no background task', async () => {
    const tool = makeTool({
      agents: {
        'untracked-1': childMeta({ profile: 'coder' }),
      },
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'untracked-1',
          profile: 'coder',
          status: 'untracked',
        },
      ],
    });
  });

  it('includes the name of a named Agent child', async () => {
    const tool = makeTool({
      agents: {
        'agent-7': childMeta({ name: 'researcher', profile: 'explore' }),
      },
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'agent-7',
          name: 'researcher',
          profile: 'explore',
          status: 'untracked',
        },
      ],
    });
  });

  it('excludes grandchildren of the caller', async () => {
    const tool = makeTool({
      agents: {
        'agent-child': childMeta({ name: 'worker', profile: 'coder' }),
        'agent-grand': childMeta({
          parent: 'agent-child',
          name: 'nested',
          profile: 'explore',
        }),
      },
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'agent-child',
          name: 'worker',
          profile: 'coder',
          status: 'untracked',
        },
      ],
    });
  });

  it('reports how many entries were omitted past the 50-cap', async () => {
    const agents: Record<string, AgentMeta> = {};
    for (let index = 0; index < 51; index += 1) {
      const agentId = `child-${String(index).padStart(2, '0')}`;
      agents[agentId] = childMeta({});
    }
    const tool = makeTool({ agents });

    const listed = await listAgents(tool);
    expect(listed.omitted).toBe(1);
    expect(listed.agents).toHaveLength(50);
    expect(listed.agents[0]?.agent_id).toBe('child-00');
    expect(listed.agents[49]?.agent_id).toBe('child-49');
  });

  it('hides finished children until include_finished is true', async () => {
    const tool = makeTool({
      agents: {
        'agent-done': childMeta({ name: 'done', profile: 'coder' }),
        'agent-live': childMeta({ name: 'live', profile: 'coder' }),
      },
      tasks: [
        { agentId: 'agent-done', status: 'completed' },
        { agentId: 'agent-live', status: 'running' },
      ],
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'agent-live',
          name: 'live',
          profile: 'coder',
          status: 'running',
          elapsed_ms: expect.any(Number),
        },
      ],
    });
    expect(await listAgents(tool, { include_finished: true })).toEqual({
      agents: [
        {
          agent_id: 'agent-live',
          name: 'live',
          profile: 'coder',
          status: 'running',
          elapsed_ms: expect.any(Number),
        },
        {
          agent_id: 'agent-done',
          name: 'done',
          profile: 'coder',
          status: 'completed',
          elapsed_ms: 0,
        },
      ],
    });
  });

  it('uses the latest domain run record instead of the collaboration task label', async () => {
    const base = childMeta({ name: 'worker', profile: 'coder' });
    const meta: AgentMeta = {
      ...base,
      labels: { ...base.labels, collaborationLatestTaskId: 'stale-task' },
    };
    const tool = makeTool({
      agents: { worker: meta },
      tasks: [
        { agentId: 'worker', status: 'completed', startedAt: 1 },
        { agentId: 'worker', status: 'running', startedAt: 2 },
      ],
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'worker',
          name: 'worker',
          profile: 'coder',
          status: 'running',
          elapsed_ms: expect.any(Number),
        },
      ],
    });
  });

  it('returns running children before idle ones', async () => {
    const tool = makeTool({
      agents: {
        aaa: childMeta({ profile: 'coder' }),
        zzz: childMeta({ profile: 'coder' }),
      },
      tasks: [{ agentId: 'zzz', status: 'running' }],
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'zzz',
          profile: 'coder',
          status: 'running',
          elapsed_ms: expect.any(Number),
        },
        {
          agent_id: 'aaa',
          profile: 'coder',
          status: 'untracked',
        },
      ],
    });
  });

  it('projects default 4 telemetry fields on compact calls and all 6 available fields on raw=true', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const tool = makeTool({
      agents: {
        worker: childMeta({ name: 'worker', profile: 'implementer' }),
      },
      tasks: [
        {
          agentId: 'worker',
          status: 'running',
          startedAt: 4_000,
        },
      ],
      liveChildren: {
        worker: {
          execution: { state: 'running', startedAt: 4_000 },
          profile: {
            modelAlias: 'kimi-for-coding',
            modelCapabilities: {
              image_in: false,
              video_in: false,
              audio_in: false,
              thinking: true,
              tool_use: true,
              max_context_tokens: 128_000,
            } satisfies ModelCapability,
            thinkingLevel: 'high',
            effectiveThinkingLevel: 'high',
            thinkingEffortExplicit: true,
          },
          activity: {
            telemetry: {
              lastActivityAt: 8_500,
              activeTurnStartedAt: 4_100,
              toolCallCount: 7,
            },
          },
          statusTokens: 42_000,
        },
      },
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'worker',
          name: 'worker',
          profile: 'implementer',
          status: 'running',
          model: 'kimi-for-coding',
          elapsed_ms: 6_000,
          idle_ms: 1_500,
          tool_call_count: 7,
        },
      ],
    });

    expect(await listAgents(tool, { raw: true })).toEqual({
      agents: [
        {
          agent_id: 'worker',
          name: 'worker',
          profile: 'implementer',
          status: 'running',
          model: 'kimi-for-coding',
          thinking_effort: 'high',
          elapsed_ms: 6_000,
          idle_ms: 1_500,
          tool_call_count: 7,
          context_tokens: 42_000,
        },
      ],
    });
  });

  it('respects custom [subagent].agent_list_fields including [] while keeping raw=true unfiltered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const baseOptions = {
      agents: {
        cold: {
          ...childMeta({ name: 'cold', profile: 'researcher' }),
          status: 'completed' as const,
          taskId: 'task-1',
          createdAt: 5_000,
          completedAt: 12_000,
          model: 'gpt-test',
          thinkingEffort: 'medium',
          thinkingEffortExplicit: true,
          contextTokens: 18_500,
          toolCallCount: 4,
        },
      },
      tasks: [
        {
          taskId: 'task-1',
          agentId: 'cold',
          status: 'completed' as const,
          startedAt: 5_000,
          endedAt: 12_000,
        },
      ],
    };

    const customTool = makeTool({
      ...baseOptions,
      subagentConfig: { agentListFields: ['thinking_effort', 'context_tokens'] },
    });
    expect(await listAgents(customTool, { include_finished: true })).toEqual({
      agents: [
        {
          agent_id: 'cold',
          name: 'cold',
          profile: 'researcher',
          status: 'completed',
          thinking_effort: 'medium',
          context_tokens: 18_500,
        },
      ],
    });

    const emptyTool = makeTool({
      ...baseOptions,
      subagentConfig: { agentListFields: [] },
    });
    expect(await listAgents(emptyTool, { include_finished: true })).toEqual({
      agents: [
        {
          agent_id: 'cold',
          name: 'cold',
          profile: 'researcher',
          status: 'completed',
        },
      ],
    });
    expect(await listAgents(emptyTool, { include_finished: true, raw: true })).toEqual({
      agents: [
        {
          agent_id: 'cold',
          name: 'cold',
          profile: 'researcher',
          status: 'completed',
          model: 'gpt-test',
          thinking_effort: 'medium',
          elapsed_ms: 7_000,
          tool_call_count: 4,
          context_tokens: 18_500,
        },
      ],
    });
  });

  it('uses current run start on resumed turns instead of historical createdAt and omits non-applicable thinking_effort', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const tool = makeTool({
      agents: {
        resumed: {
          ...childMeta({ name: 'resumed', profile: 'worker' }),
          createdAt: 1_000,
          completedAt: 10_000,
          status: 'completed',
          taskId: 'old-task',
          model: 'fast-non-thinking',
          thinkingEffort: 'off',
          thinkingEffortExplicit: false,
        },
      },
      liveChildren: {
        resumed: {
          execution: { state: 'running', startedAt: 47_000 },
          profile: {
            modelAlias: 'fast-non-thinking',
            modelCapabilities: {
              image_in: false,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
              max_context_tokens: 128_000,
            } satisfies ModelCapability,
            thinkingLevel: 'off',
            effectiveThinkingLevel: 'off',
            thinkingEffortExplicit: false,
          },
          activity: {
            telemetry: {
              lastActivityAt: 49_200,
              activeTurnStartedAt: 47_000,
              toolCallCount: 2,
            },
          },
          statusTokens: 0,
        },
      },
    });

    const raw = await listAgents(tool, { raw: true });
    expect(raw.agents).toEqual([
      {
        agent_id: 'resumed',
        name: 'resumed',
        profile: 'worker',
        status: 'running',
        model: 'fast-non-thinking',
        elapsed_ms: 3_000,
        idle_ms: 800,
        tool_call_count: 2,
      },
    ]);
    expect(raw.agents[0]).not.toHaveProperty('thinking_effort');
    expect(raw.agents[0]).not.toHaveProperty('context_tokens');
  });
});

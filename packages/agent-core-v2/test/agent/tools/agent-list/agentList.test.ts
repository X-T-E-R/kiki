import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentExecutionService } from '#/agent/execution/execution';
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
import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;
const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function childMeta(options: {
  readonly parent?: string;
  readonly name?: string;
  readonly profile?: string;
  readonly swarmItem?: string;
}): AgentMeta {
  const labels: Record<string, string> = {
    parentAgentId: options.parent ?? 'main',
  };
  if (options.name !== undefined) labels[COLLABORATION_TASK_NAME_LABEL] = options.name;
  if (options.profile !== undefined) labels[COLLABORATION_AGENT_TYPE_LABEL] = options.profile;
  if (options.swarmItem !== undefined) labels['swarmItem'] = options.swarmItem;
  return { type: 'sub', labels };
}

function makeTool(options: {
  readonly callerAgentId?: string;
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  readonly execution?: Readonly<Record<string, AgentExecutionStatus['state']>>;
  readonly tasks?: readonly {
    readonly agentId: string;
    readonly status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
    readonly startedAt?: number;
  }[];
}): IAgentListTool {
  const services = disposables.add(new TestInstantiationService());
  services.stub(IAgentScopeContext, { agentId: options.callerAgentId ?? 'main' });
  services.stub(ISessionMetadata, {
    read: async () => ({ agents: options.agents ?? {} }),
  } as ISessionMetadata);
  services.stub(IAgentTaskService, {
    list: () => (options.tasks ?? []).map((task, index) => ({
      kind: 'agent',
      taskId: `task-${String(index + 1)}`,
      description: '',
      agentId: task.agentId,
      status: task.status,
      startedAt: task.startedAt ?? index,
      endedAt: task.status === 'running' ? null : index,
    })),
  } as unknown as IAgentTaskService);
  services.stub(IAgentLifecycleService, {
    get: (agentId) => {
      const state = options.execution?.[agentId];
      if (state === undefined) return undefined;
      const child = disposables.add(new TestInstantiationService());
      child.stub(IAgentExecutionService, { status: () => ({ state }) });
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
  args: { include_finished?: boolean } = {},
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
        agents: { worker: childMeta({ swarmItem: 'src/a.ts' }) },
        execution: { worker: state },
      });
      expect((await listAgents(tool)).agents[0]).toMatchObject({
        agent_id: 'worker', status: 'running', swarm_item: 'src/a.ts',
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
  it('lists a swarm child that has no background task', async () => {
    const tool = makeTool({
      agents: {
        'swarm-1': childMeta({ swarmItem: 'src/a.ts', profile: 'coder' }),
      },
    });

    expect(await listAgents(tool)).toEqual({
      agents: [
        {
          agent_id: 'swarm-1',
          profile: 'coder',
          status: 'untracked',
          swarm_item: 'src/a.ts',
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
        },
        {
          agent_id: 'agent-done',
          name: 'done',
          profile: 'coder',
          status: 'completed',
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
        },
        {
          agent_id: 'aaa',
          profile: 'coder',
          status: 'untracked',
        },
      ],
    });
  });
});

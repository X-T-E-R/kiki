import { describe, expect, it } from 'vitest';

import { AgentListTool } from '#/agent/tools/agent-list/agentListTool';
import type { AgentListOutput } from '#/agent/tools/agent-list/agent-list';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentTaskService } from '#/agent/task/task';
import type { ISessionMetadata, AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function childMeta(options: {
  readonly parent?: string;
  readonly name?: string;
  readonly profile?: string;
  readonly taskId?: string;
  readonly swarmItem?: string;
}): AgentMeta {
  const labels: Record<string, string> = {
    parentAgentId: options.parent ?? 'main',
  };
  if (options.name !== undefined) labels[COLLABORATION_TASK_NAME_LABEL] = options.name;
  if (options.profile !== undefined) labels[COLLABORATION_AGENT_TYPE_LABEL] = options.profile;
  if (options.taskId !== undefined) labels[COLLABORATION_LATEST_TASK_LABEL] = options.taskId;
  if (options.swarmItem !== undefined) labels['swarmItem'] = options.swarmItem;
  return { type: 'sub', labels };
}

function makeTool(options: {
  readonly callerAgentId?: string;
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  readonly tasks?: Readonly<Record<string, { readonly status: string }>>;
}): AgentListTool {
  const tasks = options.tasks ?? {};
  return new AgentListTool(
    { agentId: options.callerAgentId ?? 'main' } as IAgentScopeContext,
    {
      read: async () => ({ agents: options.agents ?? {} }),
    } as ISessionMetadata,
    {
      getTask: (taskId: string) => tasks[taskId],
    } as IAgentTaskService,
  );
}

async function listAgents(
  tool: AgentListTool,
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
        'agent-done': childMeta({ name: 'done', profile: 'coder', taskId: 'task-done' }),
        'agent-live': childMeta({ name: 'live', profile: 'coder', taskId: 'task-live' }),
      },
      tasks: {
        'task-done': { status: 'completed' },
        'task-live': { status: 'running' },
      },
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

  it('returns running children before idle ones', async () => {
    const tool = makeTool({
      agents: {
        aaa: childMeta({ profile: 'coder' }),
        zzz: childMeta({ profile: 'coder', taskId: 'task-zzz' }),
      },
      tasks: {
        'task-zzz': { status: 'running' },
      },
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

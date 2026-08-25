import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService, type AgentTaskStatus } from '#/agent/task/task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  directChildAgents,
  type DirectChildAgent,
} from '#/session/agentCollaboration/directChildren';

import {
  IAgentListTool,
  MAX_AGENT_LIST_ENTRIES,
  AgentListInputSchema,
  type AgentListEntry,
  type AgentListInput,
  type AgentListOutput,
  type AgentListStatus,
} from './agent-list';
import AGENT_LIST_DESCRIPTION from './agent-list.md?raw';

const FINISHED_STATUSES = new Set<AgentListStatus>(['completed', 'interrupted', 'errored']);

export class AgentListTool implements IAgentListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentList' as const;
  readonly description = AGENT_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentListInputSchema);

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
  ) {}

  resolveExecution(args: AgentListInput): ToolExecution {
    return {
      description: 'Listing child agents',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        const includeFinished = args.include_finished ?? false;
        const session = await this.metadata.read();
        const entries = directChildAgents(session.agents, this.scope.agentId)
          .map((child) => toEntry(child, this.listStatus(child)))
          .filter((entry) => includeFinished || !FINISHED_STATUSES.has(entry.status))
          .sort(byRunningFirst);
        const omitted = Math.max(0, entries.length - MAX_AGENT_LIST_ENTRIES);
        const output: AgentListOutput =
          omitted > 0
            ? { agents: entries.slice(0, MAX_AGENT_LIST_ENTRIES), omitted }
            : { agents: entries };
        return { output: JSON.stringify(output), isError: false };
      },
    };
  }

  private listStatus(child: DirectChildAgent): AgentListStatus {
    if (child.latestTaskId === undefined) return 'untracked';
    return statusOf(this.tasks.getTask(child.latestTaskId)?.status);
  }
}

registerAgentToolService(IAgentListTool, AgentListTool, { name: 'AgentList', domain: 'subagent' });

function toEntry(child: DirectChildAgent, status: AgentListStatus): AgentListEntry {
  return {
    agent_id: child.agentId,
    ...(child.name === undefined ? {} : { name: child.name }),
    ...(child.profileName === undefined ? {} : { profile: child.profileName }),
    status,
    ...(child.swarmItem === undefined ? {} : { swarm_item: child.swarmItem }),
  };
}

function statusOf(status: AgentTaskStatus | undefined): AgentListStatus {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'killed' || status === 'timed_out') return 'interrupted';
  if (status === 'failed') return 'errored';
  return 'unknown';
}

function byRunningFirst(left: AgentListEntry, right: AgentListEntry): number {
  const leftRunning = left.status === 'running' ? 0 : 1;
  const rightRunning = right.status === 'running' ? 0 : 1;
  return leftRunning - rightRunning;
}

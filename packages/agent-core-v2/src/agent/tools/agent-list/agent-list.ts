import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MAX_AGENT_LIST_ENTRIES = 50;

export const AgentListInputSchema = z.object({
  include_finished: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'When true, also include children whose latest background task has finished or failed. The default lists running children and children with no tracking task.',
    ),
});

export type AgentListInput = z.infer<typeof AgentListInputSchema>;

export type AgentListStatus =
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'errored'
  | 'unknown'
  | 'untracked';

export interface AgentListEntry {
  readonly agent_id: string;
  readonly name?: string;
  readonly profile?: string;
  readonly status: AgentListStatus;
  readonly swarm_item?: string;
}

export interface AgentListOutput {
  readonly agents: readonly AgentListEntry[];
  readonly omitted?: number;
}

export interface IAgentListTool extends AgentTool<AgentListInput> {
  readonly _serviceBrand: undefined;
}
export const IAgentListTool = createDecorator<IAgentListTool>('agentListTool');

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { DEFAULT_AGENT_LIST_LIMIT } from '#/session/subagent/configSection';
import { type AgentTool } from '#/tool/toolContract';

export const MAX_AGENT_LIST_ENTRIES = DEFAULT_AGENT_LIST_LIMIT;

export const AgentListInputSchema = z.object({
  raw: z.boolean().optional().describe('Return all original receipt metadata instead of the compact model view.'),
  include_finished: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'When true, also include finished or errored children. Open branches that are running or idle appear by default.',
    ),
  query: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring filter matching child name, agent_id, or profile.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional maximum number of children to return (1-200). Defaults to [subagent].agent_list_limit.'),
});

export type AgentListInput = z.infer<typeof AgentListInputSchema>;

export type AgentListStatus =
  | 'persistence_failed'
  | 'running'
  | 'idle'
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
  readonly model?: string;
  readonly thinking_effort?: string;
  readonly elapsed_ms?: number;
  readonly idle_ms?: number;
  readonly tool_call_count?: number;
  readonly context_tokens?: number;
  readonly persistence_failure?: {
    readonly turn_id?: number;
    readonly execution_outcome: 'completed' | 'failed' | 'cancelled';
    readonly message: string;
  };
}

export interface AgentListOutput {
  readonly agents: readonly AgentListEntry[];
  readonly omitted?: number;
  readonly note?: string;
}

export interface IAgentListTool extends AgentTool<AgentListInput> {
  readonly _serviceBrand: undefined;
}
export const IAgentListTool = createDecorator<IAgentListTool>('agentListTool');

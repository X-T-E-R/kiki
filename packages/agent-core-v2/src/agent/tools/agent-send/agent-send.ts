import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const AgentSendInputSchema = z
  .object({
    target: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Name or agent id of a direct child. Names come from the `name` parameter of the Agent tool; unnamed Agent and AgentSwarm children are addressed by agent id. Call AgentList when unsure.',
      ),
    message: z
      .string()
      .describe(
        'Non-empty message to queue in the child mailbox. The child reads it on its next turn; this tool does not start or interrupt a turn.',
      ),
  })
  .strict();

export type AgentSendInput = z.infer<typeof AgentSendInputSchema>;

export interface AgentSendResult {
  readonly message_id: string;
  readonly status: 'queued' | 'delivered';
  readonly deduplicated: boolean;
  readonly target: {
    readonly task_name: string;
    readonly agent_id: string;
  };
}

export interface IAgentSendTool extends AgentTool<AgentSendInput> {
  readonly _serviceBrand: undefined;
}
export const IAgentSendTool = createDecorator<IAgentSendTool>('agentSendTool');

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const AgentNotifyInputSchema = z
  .object({
    message: z
      .string()
      .describe(
        'Non-empty text message to queue in the parent agent mailbox. The parent receives it as a user-role message; write it as a self-contained note it can act on without seeing this conversation.',
      ),
  })
  .strict();

export type AgentNotifyInput = z.infer<typeof AgentNotifyInputSchema>;

export interface AgentNotifyResult {
  readonly message_id: string;
  readonly status: 'queued' | 'delivered';
  readonly target: {
    readonly task_name: string;
    readonly agent_id: string;
  };
}

export interface IAgentNotifyTool extends AgentTool<AgentNotifyInput> {
  readonly _serviceBrand: undefined;
}
export const IAgentNotifyTool = createDecorator<IAgentNotifyTool>('agentNotifyTool');

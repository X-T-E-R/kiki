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
        'Name or agent id of a direct child. Names come from the `name` parameter of AgentRun; unnamed children are addressed by agent id. AgentList lists them.',
      ),
    message: z
      .string()
      .describe(
        'Input the child needs to continue. A running native child takes it at the next step boundary; Codex or a steer-capable ACP child can take it during the run. A stopped child continues with its current binding.',
      ),
  })
  .strict();

export type AgentSendInput = z.infer<typeof AgentSendInputSchema>;

export interface AgentSendResult {
  readonly message_id: string;
  readonly status: 'queued' | 'delivered';
  readonly deduplicated: boolean;
  readonly resumed?: boolean;
  readonly target: {
    readonly task_name: string;
    readonly agent_id: string;
  };
}

export interface IAgentSendTool extends AgentTool<AgentSendInput> {
  readonly _serviceBrand: undefined;
}
export const IAgentSendTool = createDecorator<IAgentSendTool>('agentSendTool');

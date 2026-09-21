import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const AgentNotifyInputSchema = z
  .object({
    message: z
      .string()
      .describe(
        'A short self-contained message for a parent that must change its actions before your final result arrives. Do not send startup confirmations, routine progress, completion notices, or final-result copies. This is one-way and does not guarantee a reply or approval.',
      ),
  })
  .strict();

export type AgentNotifyInput = z.infer<typeof AgentNotifyInputSchema>;

export interface AgentNotifyAvailabilityInput {
  readonly hasParent: boolean;
  readonly allowParentNotify?: boolean;
  readonly configEnabled: boolean;
  readonly toolPolicyEnabled: boolean;
}

export function isAgentNotifyAvailable(input: AgentNotifyAvailabilityInput): boolean {
  return input.hasParent && input.allowParentNotify !== false && input.configEnabled && input.toolPolicyEnabled;
}

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

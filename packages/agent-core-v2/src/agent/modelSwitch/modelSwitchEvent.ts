/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';
import { Event2 } from '#/app/event/event2';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ConfigUpdatePayload } from '#/agent/profile/profileOps';
import type { ModelSwitchInput } from './modelSwitch';

const modelSwitchSchema = z.object({
  operationId: z.string().min(1),
  input: z.object({ operationId: z.string().min(1), model: z.string().min(1), mode: z.enum(['direct', 'compact', 'fresh']),
    thinking: z.string().optional(), selectedFromModel: z.string().optional() }).readonly() satisfies z.ZodType<ModelSwitchInput>,
  agentId: z.string(),
  fromModel: z.string(),
  toModel: z.string(),
  mode: z.enum(['direct', 'compact', 'fresh']),
  thinking: z.string(),
  config: z.custom<ConfigUpdatePayload>(),
  contextRevision: z.number().int().nonnegative(),
  oldEpoch: z.number().int().nonnegative(),
  newEpoch: z.number().int().nonnegative(),
  summaryGenerated: z.boolean(),
  context: z.custom<readonly ContextMessage[]>().optional(),
  contextTokens: z.number().nonnegative().optional(),
  previousMessageCount: z.number().int().nonnegative(),
}).superRefine((event, ctx) => {
  const direct = event.mode === 'direct';
  if (event.input.operationId !== event.operationId || event.input.mode !== event.mode
    || event.config?.modelAlias !== event.toModel
    || (event.config?.thinkingEffort ?? event.config?.thinkingLevel) !== event.thinking
    || event.newEpoch !== event.oldEpoch + (direct ? 0 : 1)
    || (direct ? event.context !== undefined || event.contextTokens !== undefined : !Array.isArray(event.context) || event.contextTokens === undefined)
    || (event.summaryGenerated && event.mode !== 'compact')) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent model switch binding, context or operation identity.' });
  }
});

export class AgentModelSwitch extends Event2<z.infer<typeof modelSwitchSchema>> {
  static override readonly type = 'agent.model_switch';
  static override readonly durable = true;
  static override readonly schema = modelSwitchSchema;
}
export interface AgentModelSwitch extends z.infer<typeof modelSwitchSchema> {}

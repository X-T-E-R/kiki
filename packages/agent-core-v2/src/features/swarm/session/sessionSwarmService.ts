/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';
import { Event2, registerEvent2Class } from '#/app/event/event2';

export interface SubagentSuspendedPayload {
  readonly subagentId: string;
  readonly reason: string;
}

const subagentSuspendedSchema: z.ZodType<SubagentSuspendedPayload> = z.object({
  subagentId: z.string(),
  reason: z.string(),
});

export class SubagentSuspended extends Event2<SubagentSuspendedPayload> {
  static override readonly type = 'subagent.suspended';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = subagentSuspendedSchema;
}
export interface SubagentSuspended extends SubagentSuspendedPayload {}
registerEvent2Class(SubagentSuspended);

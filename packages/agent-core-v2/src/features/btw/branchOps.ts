/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const agentToolLockChangedSchema = z.object({
  locked: z.boolean(),
}).strict();

export class AgentToolLockChanged extends Event2<z.infer<typeof agentToolLockChangedSchema>> {
  static override readonly type = 'agent.tool_lock_changed';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = agentToolLockChangedSchema;
}
export interface AgentToolLockChanged extends z.infer<typeof agentToolLockChangedSchema> {}

const agentBranchSealedSchema = z.object({
  sealed: z.boolean(),
  foldId: z.string().min(1).optional(),
}).strict();

export class AgentBranchSealed extends Event2<z.infer<typeof agentBranchSealedSchema>> {
  static override readonly type = 'agent.branch_sealed';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = agentBranchSealedSchema;
}
export interface AgentBranchSealed extends z.infer<typeof agentBranchSealedSchema> {}

export const branchToolLockKey = defineState('branch.toolsLocked', () => false)
  .replayable({ schema: z.boolean() })
  .on(AgentToolLockChanged, (_state, event) => event.locked);

export const branchSealedKey = defineState('branch.sealed', () => false)
  .replayable({ schema: z.boolean() })
  .on(AgentBranchSealed, (_state, event) => event.sealed);

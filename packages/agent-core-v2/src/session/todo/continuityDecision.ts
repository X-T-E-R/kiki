/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';
import { Event2, registerEvent2Class } from '#/app/event/event2';
const decisionSchema = z.object({
  classId: z.string(), reason: z.string(), humanTurnOrdinal: z.number(), workStepOrdinal: z.number(),
  epoch: z.number(), inputRevision: z.number(), stateRevision: z.number(), legacyCandidate: z.boolean(),
});
export class ContinuityDecision extends Event2<z.infer<typeof decisionSchema>> {
  static override readonly type = 'todo.continuity_decision';
  static override readonly durable = true;
  static override readonly schema = decisionSchema;
}
export interface ContinuityDecision extends z.infer<typeof decisionSchema> {}
registerEvent2Class(ContinuityDecision);

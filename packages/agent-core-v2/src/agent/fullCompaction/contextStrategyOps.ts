/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export const contextStrategySchema = z.enum(['summarize', 'auto', 'fresh']);
const changedSchema = z.object({ strategy: contextStrategySchema.nullable() });

export class ContextStrategyOverrideChanged extends Event2<z.infer<typeof changedSchema>> {
  static override readonly type = 'context_strategy.override_changed';
  static override readonly durable = true;
  static override readonly schema = changedSchema;
}
export interface ContextStrategyOverrideChanged extends z.infer<typeof changedSchema> {}

export const contextStrategyOverrideKey = defineState('contextStrategyOverride', (): z.infer<typeof contextStrategySchema> | null => null)
  .replayable({ schema: contextStrategySchema.nullable() })
  .on(ContextStrategyOverrideChanged, (_state, event) => event.strategy);

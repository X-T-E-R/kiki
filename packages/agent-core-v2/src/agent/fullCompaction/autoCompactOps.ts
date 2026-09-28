/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const overrideSchema = z.object({ modelId: z.string().min(1).refine((value) => value !== '__proto__'), tokens: z.number().int().positive().safe().nullable() });

export class AutoCompactOverrideChanged extends Event2<z.infer<typeof overrideSchema>> {
  static override readonly type = 'auto_compact.override_changed';
  static override readonly durable = true;
  static override readonly schema = overrideSchema;
}
export interface AutoCompactOverrideChanged extends z.infer<typeof overrideSchema> {}

export const autoCompactOverrideKey = defineState('autoCompactOverride', (): Record<string, number> => ({}))
  .replayable({ schema: z.record(z.string(), z.number().int().positive().safe()) })
  .on(AutoCompactOverrideChanged, (state, event) => {
    if (event.tokens === null) delete state[event.modelId];
    else state[event.modelId] = event.tokens;
  });

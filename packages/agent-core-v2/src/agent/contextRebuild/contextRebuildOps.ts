/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import {
  CONTEXT_REBUILD_SURFACES,
  type ContextRebuildControl,
} from './contextRebuild';

const surfaceSchema = z.enum(CONTEXT_REBUILD_SURFACES);
const triggerSchema = z.enum(['manual', 'compaction', 'restore']);
const outcomeSchema = z.enum(['applied', 'partial', 'failed']);
const changesSchema = z.object({
  profile: z.boolean(),
  promptFields: z.boolean(),
  skills: z.boolean(),
  instructions: z.boolean(),
  plugins: z.boolean(),
  mcp: z.boolean(),
  injections: z.boolean(),
});
const unsupportedSchema = z.object({
  surface: z.union([surfaceSchema, z.literal('executor_session')]),
  reason: z.string(),
});

const preferenceSchema = z.object({ enabled: z.boolean() });

export class ContextRebuildPreferenceChanged extends Event2<z.infer<typeof preferenceSchema>> {
  static override readonly type = 'context_rebuild.preference';
  static override readonly durable = true;
  static override readonly schema = preferenceSchema;
}
export interface ContextRebuildPreferenceChanged extends z.infer<typeof preferenceSchema> {}

const reportSchema = z.object({
  outcome: outcomeSchema,
  trigger: triggerSchema,
  at: z.string(),
  error: z.string().optional(),
  changes: changesSchema.optional(),
  rebuilt: z.array(surfaceSchema),
  unsupported: z.array(unsupportedSchema),
});

export class ContextRebuildReported extends Event2<z.infer<typeof reportSchema>> {
  static override readonly type = 'context_rebuild.reported';
  static override readonly durable = true;
  static override readonly schema = reportSchema;
}
export interface ContextRebuildReported extends z.infer<typeof reportSchema> {}

const controlSchema = z.object({
  enabled: z.boolean(),
  outcome: outcomeSchema.optional(),
  trigger: triggerSchema.optional(),
  at: z.string().optional(),
  error: z.string().optional(),
  changes: changesSchema.optional(),
  rebuilt: z.array(surfaceSchema),
  unsupported: z.array(unsupportedSchema),
});

export const contextRebuildControlKey = defineState(
  'contextRebuild.control',
  (): ContextRebuildControl => ({ enabled: false, rebuilt: [], unsupported: [] }),
).replayable({ schema: controlSchema as z.ZodType<ContextRebuildControl> })
  .on(ContextRebuildPreferenceChanged, (state, event) => {
    state.enabled = event.enabled;
  })
  .on(ContextRebuildReported, (state, event) => {
    state.outcome = event.outcome;
    state.trigger = event.trigger;
    state.at = event.at;
    state.error = event.error;
    state.changes = event.changes === undefined ? undefined : { ...event.changes };
    state.rebuilt = [...event.rebuilt];
    state.unsupported = event.unsupported.map((item) => ({ ...item }));
  });

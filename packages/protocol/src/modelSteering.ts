import { z } from 'zod';

export const modelSteeringCadenceSchema = z.object({
  steering_on_turn: z.boolean().optional(),
  steering_on_input: z.boolean().optional(),
  steering_interval_steps: z.number().int().nonnegative().safe().optional(),
});

export const modelSteeringSourceIds = ['thread', 'room', 'agent', 'task', 'cron', 'hook', 'automation', 'skill', 'external'] as const;
export const modelSteeringSourceSchema = z.enum(modelSteeringSourceIds);
export type ModelSteeringSource = z.infer<typeof modelSteeringSourceSchema>;
export const modelSteeringSourceModeSchema = z.enum(['off', 'inherit', 'custom']);
export type ModelSteeringSourceMode = z.infer<typeof modelSteeringSourceModeSchema>;

export function modelSteeringSourcesSchema<T extends z.ZodTypeAny>(body: T) {
  return z.partialRecord(modelSteeringSourceSchema, z.object({
    mode: modelSteeringSourceModeSchema,
    custom: modelSteeringCadenceSchema.extend({ steering: body.optional() }).strict().optional(),
  }).strict());
}

export interface ModelSteeringSourceSetting<T> {
  mode: ModelSteeringSourceMode;
  custom?: { steering?: T; steering_on_turn?: boolean; steering_on_input?: boolean; steering_interval_steps?: number };
}
export type ModelSteeringSources<T> = Partial<Record<ModelSteeringSource, ModelSteeringSourceSetting<T>>>;

export function mergeModelSteeringSources<T>(lower: ModelSteeringSources<T> | undefined, upper: ModelSteeringSources<T> | undefined): ModelSteeringSources<T> | undefined {
  if (upper === undefined) return lower;
  const result = { ...lower };
  for (const source of modelSteeringSourceIds) {
    const next = upper[source];
    if (next !== undefined) {
      const custom = next.custom === undefined ? lower?.[source]?.custom : { ...lower?.[source]?.custom, ...Object.fromEntries(Object.entries(next.custom).filter(([, value]) => value !== undefined)) };
      result[source] = { ...lower?.[source], ...next, custom };
    }
  }
  return result;
}

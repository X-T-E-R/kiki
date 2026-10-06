import { z } from 'zod';

export const executionContextSchema = z.enum(['memory', 'board', 'cron', 'threads', 'history', 'hooks']);
export const executionPermissionSchema = z.enum(['manual', 'auto', 'review', 'yolo']);
export const executionOverridesSchema = z.strictObject({
  model: z.string().min(1).nullable().optional(),
  thinking: z.string().min(1).nullable().optional(),
  permission_mode: executionPermissionSchema.nullable().optional(),
  kiki_context: z.array(executionContextSchema).readonly().nullable().optional(),
  allow_kiki_subagents: z.boolean().nullable().optional(),
});
export const executionSelectionSchema = z.strictObject({
  executor: z.string().min(1),
  profile: z.string().min(1).optional(),
  overrides: executionOverridesSchema.optional(),
});
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;
export type ExecutionOverrides = z.infer<typeof executionOverridesSchema>;
export const executionEffectiveSchema = z.strictObject({
  model: z.string().optional(),
  thinking: z.string().optional(),
  permission_mode: executionPermissionSchema.optional(),
  kiki_context: z.array(executionContextSchema).readonly(),
  allow_kiki_subagents: z.boolean(),
});
export const executionValueSourceSchema = z.enum(['session', 'profile', 'harness-settings', 'harness-default']);
export const executionBindingSchema = z.strictObject({
  version: z.literal(1),
  selection: executionSelectionSchema,
  effective: executionEffectiveSchema,
  sources: z.record(z.string(), executionValueSourceSchema),
  generation: z.number().int().positive(),
});
export type ExecutionBinding = z.infer<typeof executionBindingSchema>;

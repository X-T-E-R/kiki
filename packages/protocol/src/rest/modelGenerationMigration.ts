import { z } from 'zod';

export const modelGenerationMigrationReasonSchema = z.enum([
  'invalid_model', 'invalid_parameters', 'invalid_value', 'differs',
  'ambiguous', 'default_effort', 'max_output_size',
]);

export const modelGenerationMigrationPreviewSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  changes: z.array(z.object({
    model_id: z.string(),
    fields: z.array(z.string()),
  }).strict()),
  needs_review: z.array(z.object({
    model_id: z.string(),
    code: modelGenerationMigrationReasonSchema,
    field: z.string().optional(),
  }).strict()),
  backups: z.array(z.string()),
}).strict();
export type ModelGenerationMigrationPreviewResponse = z.infer<typeof modelGenerationMigrationPreviewSchema>;

export const modelGenerationMigrationApplyRequestSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
}).strict();
export type ModelGenerationMigrationApplyRequest = z.infer<typeof modelGenerationMigrationApplyRequestSchema>;

export const modelGenerationMigrationApplyResponseSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  backup_key: z.string(),
}).strict();
export type ModelGenerationMigrationApplyResponse = z.infer<typeof modelGenerationMigrationApplyResponseSchema>;

export const modelGenerationMigrationRestoreRequestSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  backup_key: z.string().min(1).max(255),
  confirmed: z.literal(true),
}).strict();
export type ModelGenerationMigrationRestoreRequest = z.infer<typeof modelGenerationMigrationRestoreRequestSchema>;

export const modelGenerationMigrationRestoreResponseSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ModelGenerationMigrationRestoreResponse = z.infer<typeof modelGenerationMigrationRestoreResponseSchema>;

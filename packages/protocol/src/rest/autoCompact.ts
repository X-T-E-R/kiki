import { z } from 'zod';

export const autoCompactStatusSchema = z.object({
  tokens: z.number(),
  source: z.enum(['session', 'profile', 'model', 'global', 'legacy']),
  effectiveMaxContextTokens: z.number(),
  reservedContextTokens: z.number(),
});
export type AutoCompactStatus = z.infer<typeof autoCompactStatusSchema>;

export const autoCompactWriteSchema = z.object({
  tokens: z.number().int().positive().safe().nullable(),
  save: z.enum(['model', 'profile', 'global']).optional(),
}).strict().refine((input) => input.tokens !== null || input.save === undefined, {
  message: 'saving a default requires an absolute positive token count',
});
export type AutoCompactWrite = z.infer<typeof autoCompactWriteSchema>;

export const autoCompactWriteResultSchema = z.object({
  effective: autoCompactStatusSchema,
  default: autoCompactStatusSchema,
  overrideCleared: z.boolean(),
  savedAs: z.union([z.number().positive(), z.string().endsWith('%')]).optional(),
});
export type AutoCompactWriteResult = z.infer<typeof autoCompactWriteResultSchema>;

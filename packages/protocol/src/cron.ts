import { z } from 'zod';

export const cronTriggerProbabilitySchema = z.number().min(0).max(1);
export const cronTriggerScriptIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const cronTriggerSchema = z.strictObject({
  probability: cronTriggerProbabilitySchema.optional(),
  script: cronTriggerScriptIdSchema.optional(),
});

export type CronTrigger = z.infer<typeof cronTriggerSchema>;

export const cronScriptExecutionSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  timeout: z.number().int().min(1).max(60),
  environment: z.literal('isolated'),
});

export type CronScriptExecution = z.infer<typeof cronScriptExecutionSchema>;

export const cronTriggerCheckSchema = z.object({
  checkedAt: z.number().int().nonnegative(),
  outcome: z.enum(['allowed', 'skipped', 'error']),
  reason: z.enum(['probability', 'exit_code', 'not_authorized', 'timeout', 'cancelled', 'process_failed', 'cleanup_failed']).optional(),
  exitCode: z.number().int().nonnegative().optional(),
});

export type CronTriggerCheck = z.infer<typeof cronTriggerCheckSchema>;

export const cronRunResultSchema = z.discriminatedUnion('triggered', [
  z.object({ triggered: z.literal(true) }),
  z.object({ triggered: z.literal(false), check: cronTriggerCheckSchema }),
]);

export type CronRunResult = z.infer<typeof cronRunResultSchema>;

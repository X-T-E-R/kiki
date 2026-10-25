import { z } from 'zod';

export const executorAuthObservationSchema = z.object({
  status: z.enum(['logged_in', 'logged_out', 'required', 'unknown']),
  source: z.enum(['codex.account.updated', 'acp.authentication_required']),
  scope: z.enum(['vendor_account', 'session']),
  executor_id: z.string().min(1),
  descriptor_revision: z.string().min(1),
  binding_fingerprint: z.string().length(64),
  execution_generation: z.number().int().positive().optional(),
  cwd: z.string().min(1),
  home_dir: z.string().optional(),
  selected_source: z.string().optional(),
  observed_at: z.number().int().nonnegative(),
});
export type ExecutorAuthObservation = z.infer<typeof executorAuthObservationSchema>;

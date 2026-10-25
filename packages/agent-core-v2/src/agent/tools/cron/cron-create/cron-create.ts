import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const MAX_CRON_JOBS_PER_SESSION = 50;

export const MAX_PROMPT_BYTES = 8 * 1024;

export const CronCreateInputSchema = z.object({
  cron: z
    .string()
    .describe(
      '5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes; "30 14 28 2 *" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false).',
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_BYTES)
    .describe('The prompt to deliver at each fire time. Limited to 8 KiB (UTF-8).'),
  delivery_mode: z.enum(['queue', 'steer', 'idle']).optional()
    .describe('idle (default): wait for current work to finish, then run before ordinary queued messages; repeated fires of this job merge with their count. queue: retain each fire in normal FIFO order. steer: insert at the next safe step without interrupting the current request.'),
  recurring: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
    ),
});

export type CronCreateInput = z.Infer<typeof CronCreateInputSchema>;

export interface CronCreateOutput {
  readonly id: string;
  readonly cron: string;
  readonly humanSchedule: string;
  readonly recurring: boolean;
  readonly deliveryMode: import('@kiki/protocol').CronDeliveryMode;
  readonly nextFireAt: number | null;
}

export interface ICronCreateTool extends AgentTool<CronCreateInput> { readonly _serviceBrand: undefined }
export const ICronCreateTool = createDecorator<ICronCreateTool>('cronCreateTool');

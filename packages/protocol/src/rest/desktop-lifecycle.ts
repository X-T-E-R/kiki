import { z } from 'zod';

export const desktopLifecycleRequestSchema = z.object({
  action: z.enum(['restart', 'update']),
  server_id: z.string().min(1),
  consent: z.literal(true),
  interrupt_work: z.boolean().default(false),
}).strict();
export const desktopLifecycleStateSchema = z.object({
  server_id: z.string().min(1),
  home_id: z.string().min(1),
  managed: z.boolean(),
  draining: z.boolean(),
  work_pending: z.array(z.string()),
  impact: z.literal('all-windows-in-this-space'),
});
export type DesktopLifecycleState = z.infer<typeof desktopLifecycleStateSchema>;

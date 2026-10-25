import { z } from 'zod';

export const sessionMediaPlaybackSchema = z.object({
  preview_id: z.string().regex(/^[a-f0-9]{64}$/u),
  url: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
}).strict();

export type SessionMediaPlayback = z.infer<typeof sessionMediaPlaybackSchema>;

import { z } from 'zod';
import { connectionIdentitySchema, sshRemoteProfileSchema } from './connections';

export const sshRemotePlanSchema = z.object({
  id: z.string().uuid(), profile: sshRemoteProfileSchema,
  state: z.enum(['attach', 'ensure_required', 'ready']), target: connectionIdentitySchema.optional(),
  serverId: z.string().optional(), expiresAt: z.number(),
  effects: z.object({ startsServer: z.boolean(), serverLifetime: z.enum(['existing', 'until_explicit_stop']), opensInbound: z.literal(false), installsSoftware: z.literal(false) }),
});
export type SshRemotePlan = z.infer<typeof sshRemotePlanSchema>;
export const sshRemoteExecuteSchema = z.object({ ensure: z.boolean() }).strict();
export type SshRemoteExecute = z.infer<typeof sshRemoteExecuteSchema>;
export const sshRemoteStatusSchema = z.object({
  connectionId: z.string(), state: z.enum(['connecting', 'ready', 'offline']),
  guiLeases: z.number().int().nonnegative(), bridgeLeases: z.number().int().nonnegative(),
});
export type SshRemoteStatus = z.infer<typeof sshRemoteStatusSchema>;

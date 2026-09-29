import { z } from 'zod';

export const sshHostSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(['kiki', 'ssh-config', 'session']),
  hostname: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().optional(),
  roots: z.array(z.string()).optional(),
  description: z.string().optional(),
  agentAccess: z.enum(['offered', 'hidden']).optional(),
});
export type SshHost = z.infer<typeof sshHostSchema>;

export const sshHostInputSchema = sshHostSchema.omit({ id: true, source: true }).extend({
  name: z.string().trim().min(1),
  roots: z.array(z.string().startsWith('/')).min(1).optional(),
});
export type SshHostInput = z.infer<typeof sshHostInputSchema>;

export const sshHostStatusSchema = z.object({
  hostId: z.string(),
  workspaceId: z.string().optional(),
  state: z.enum(['idle', 'connecting', 'ready', 'disconnected', 'failed']),
  generation: z.number(),
}).passthrough();
export type SshHostStatus = z.infer<typeof sshHostStatusSchema>;

export const sshHostsResponseSchema = z.object({ hosts: z.array(sshHostSchema) });
export const sshHostResponseSchema = z.object({ host: sshHostSchema });
export const sshSessionHostsResponseSchema = z.object({ hosts: z.array(z.object({
  host: sshHostSchema,
  status: sshHostStatusSchema,
})) });
export type SshSessionHostsResponse = z.infer<typeof sshSessionHostsResponseSchema>;

export const sshCredentialSchema = z.object({
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyContents: z.string().optional(),
  passphrase: z.string().optional(),
  answers: z.array(z.string()).optional(),
  save: z.enum(['session', 'workspace', 'global']).optional(),
}).strict();
export type SshCredential = z.infer<typeof sshCredentialSchema>;

export const sshApprovalSubmitSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  credential: sshCredentialSchema.optional(),
}).strict();
export type SshApprovalSubmit = z.infer<typeof sshApprovalSubmitSchema>;

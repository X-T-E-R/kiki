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

export const sshConfigSyncSettingsSchema = z.object({
  enabled: z.boolean(),
  source: z.enum(['home', 'base', 'default']),
});
export type SshConfigSyncSettings = z.infer<typeof sshConfigSyncSettingsSchema>;

export const sshHostKeysSchema = z.object({
  hostId: z.string(),
  workspaceId: z.string().optional(),
  hostname: z.string(),
  port: z.number().int().min(1).max(65535),
  label: z.string(),
  state: z.enum(['recorded', 'unrecorded', 'unavailable']),
  records: z.array(z.object({
    file: z.string(),
    line: z.number().int().min(1),
    hostPattern: z.string(),
    algorithm: z.string(),
    fingerprint: z.string().optional(),
    marker: z.string().optional(),
    status: z.enum(['recorded', 'revoked', 'unsupported', 'invalid']),
    reason: z.string().optional(),
  })),
  files: z.array(z.object({
    path: z.string(),
    state: z.enum(['read', 'missing', 'unavailable']),
    reason: z.string().optional(),
  })),
});
export type SshHostKeys = z.infer<typeof sshHostKeysSchema>;

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

export const copySharedSshCredentialsRequestSchema = z.object({
  hosts: z.array(z.object({
    hostId: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    workspaceId: z.string().min(1).optional(),
  })).max(64),
});
export type CopySharedSshCredentialsRequest = z.infer<typeof copySharedSshCredentialsRequestSchema>;
export const copySharedSshCredentialsResponseSchema = z.object({
  hosts: z.array(z.object({
    hostId: z.string(),
    workspaceId: z.string().optional(),
    copied: z.number().int().min(0),
  })),
});
export type CopySharedSshCredentialsResponse = z.infer<typeof copySharedSshCredentialsResponseSchema>;

export const sshApprovalSubmitSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  credential: sshCredentialSchema.optional(),
}).strict();
export type SshApprovalSubmit = z.infer<typeof sshApprovalSubmitSchema>;

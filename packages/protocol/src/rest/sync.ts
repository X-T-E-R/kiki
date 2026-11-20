import { z } from 'zod';

export const credentialSyncPolicySchema = z.enum(['machine', 'keyring', 'env', 'synced']);
export type CredentialSyncPolicy = z.infer<typeof credentialSyncPolicySchema>;

export const credentialPoolKindSchema = z.enum(['api_key', 'bearer_token', 'oauth', 'env_ref', 'keyring_ref']);
export type CredentialPoolKind = z.infer<typeof credentialPoolKindSchema>;

export const encryptedCredentialEnvelopeSchema = z.object({
  format: z.literal('kiki.credential-envelope.v1'),
  credentialId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
  revision: z.string().min(1).max(128),
  updatedAt: z.string().datetime({ offset: true }),
  recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/)).min(1).max(64),
  ciphertextBase64: z.string().min(1).max(1_048_576),
}).strict();
export type EncryptedCredentialEnvelope = z.infer<typeof encryptedCredentialEnvelopeSchema>;

export const projectIdentitySourceSchema = z.enum(['explicit', 'git', 'path_fallback']);
export type ProjectIdentitySource = z.infer<typeof projectIdentitySourceSchema>;

export const projectIdentitySchema = z.object({
  projectId: z.string().min(1).max(128),
  source: projectIdentitySourceSchema,
  slug: z.string().min(1).max(64),
  workDirKey: z.string().min(1).max(128),
  gitRoot: z.string().min(1).max(4096).optional(),
  normalizedRemote: z.string().min(1).max(1024).optional(),
  rootCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;

export const configSyncScopeSchema = z.enum(['portable', 'machine']);
export type ConfigSyncScope = z.infer<typeof configSyncScopeSchema>;

export const skillRootSyncPlanSchema = z.object({
  path: z.string().min(1).max(4096),
  source: z.enum(['project', 'user', 'extra', 'builtin']),
  transport: z.enum(['git', 'file_tree']),
  gitRoot: z.string().min(1).max(4096).optional(),
  remoteUrl: z.string().min(1).max(1024).optional(),
  branch: z.string().min(1).max(256).optional(),
  ignorePatterns: z.array(z.string().min(1).max(128)),
});
export type SkillRootSyncPlan = z.infer<typeof skillRootSyncPlanSchema>;

export const syncCredentialSealInputSchema = z.object({
  recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/)).min(1).max(64),
  credentialIds: z.array(z.string().min(1).max(128)).max(128).optional(),
}).strict();
export type SyncCredentialSealInput = z.infer<typeof syncCredentialSealInputSchema>;

export const syncCredentialMergeInputSchema = z.object({
  envelopes: z.array(encryptedCredentialEnvelopeSchema).max(128),
}).strict();
export type SyncCredentialMergeInput = z.infer<typeof syncCredentialMergeInputSchema>;

export const syncProjectIdentityResolveInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  bind: z.boolean().default(true),
}).strict();
export type SyncProjectIdentityResolveInput = z.infer<typeof syncProjectIdentityResolveInputSchema>;

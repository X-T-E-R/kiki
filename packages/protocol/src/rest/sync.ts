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

export const syncCredentialMergeReceiptSchema = z.object({
  appliedIds: z.array(z.string().min(1).max(128)),
  skippedIds: z.array(z.object({
    credentialId: z.string().min(1).max(128),
    reason: z.string().min(1).max(128),
  })),
  conflictIds: z.array(z.string().min(1).max(128)),
  revision: z.string().min(1).max(128),
}).strict();
export type SyncCredentialMergeReceipt = z.infer<typeof syncCredentialMergeReceiptSchema>;

export const syncProjectIdentityResolveInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  bind: z.boolean().default(true),
}).strict();
export type SyncProjectIdentityResolveInput = z.infer<typeof syncProjectIdentityResolveInputSchema>;

export const syncMemoryRecordSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  type: z.enum(['user', 'feedback', 'project', 'reference']),
  title: z.string().min(1).max(256),
  body: z.string(),
  pinned: z.boolean().optional(),
  updated: z.string(),
  revision: z.string().min(1).max(128),
  applicability: z.literal('portable').optional(),
  origin_host_id: z.string().max(128).optional(),
}).strict();
export type SyncMemoryRecord = z.infer<typeof syncMemoryRecordSchema>;

export const syncSkillFileEntrySchema = z.object({
  skillName: z.string().min(1).max(128),
  relativePath: z.string().min(1).max(512),
  contentBase64: z.string(),
}).strict();
export type SyncSkillFileEntry = z.infer<typeof syncSkillFileEntrySchema>;

export const syncBundleSchema = z.object({
  format: z.literal('kiki.sync-bundle.v1'),
  exportedAt: z.string().datetime({ offset: true }),
  portableConfig: z.record(z.string(), z.unknown()).optional(),
  credentialEnvelopes: z.array(encryptedCredentialEnvelopeSchema).max(128).optional(),
  memories: z.array(syncMemoryRecordSchema).max(2048).optional(),
  skills: z.array(syncSkillFileEntrySchema).max(1024).optional(),
  skillPlans: z.array(skillRootSyncPlanSchema).max(64).optional(),
}).strict();
export type SyncBundle = z.infer<typeof syncBundleSchema>;

export const syncBundleExportInputSchema = z.object({
  recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/)).max(64).optional(),
  credentialIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  projectIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  workDir: z.string().min(1).max(4096).optional(),
  includeConfig: z.boolean().default(true),
  includeCredentials: z.boolean().default(true),
  includeMemories: z.boolean().default(true),
  includeSkills: z.boolean().default(true),
  targetPlatform: z.enum(['win32', 'darwin', 'linux']).optional(),
}).strict();
export type SyncBundleExportInput = z.infer<typeof syncBundleExportInputSchema>;

export const syncPeerTransferInputSchema = z.object({
  credentialIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  projectIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  workDir: z.string().min(1).max(4096).optional(),
  includeConfig: z.boolean().default(true),
  includeCredentials: z.boolean().default(true),
  includeMemories: z.boolean().default(true),
  includeSkills: z.boolean().default(true),
}).strict();
export type SyncPeerTransferInput = z.infer<typeof syncPeerTransferInputSchema>;

export const syncBundleImportReceiptSchema = z.object({
  configDomainsApplied: z.array(z.string()),
  credentials: syncCredentialMergeReceiptSchema,
  memoriesApplied: z.number().int().nonnegative(),
  memoriesSkipped: z.number().int().nonnegative(),
  skillsApplied: z.number().int().nonnegative(),
  skillsSkipped: z.number().int().nonnegative(),
}).strict();
export type SyncBundleImportReceipt = z.infer<typeof syncBundleImportReceiptSchema>;

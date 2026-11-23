import { z } from 'zod';
import { portableSpaceSessionSelectionSchema } from './portable-space';

export const credentialSyncPolicySchema = /* @__PURE__ */ z.enum(['machine', 'keyring', 'env', 'synced']);
export type CredentialSyncPolicy = z.infer<typeof credentialSyncPolicySchema>;

export const credentialPoolKindSchema = /* @__PURE__ */ z.enum(['api_key', 'bearer_token', 'oauth', 'env_ref', 'keyring_ref']);
export type CredentialPoolKind = z.infer<typeof credentialPoolKindSchema>;

export const encryptedCredentialEnvelopeSchema = /* @__PURE__ */ z.object({
  format: z.literal('kiki.credential-envelope.v1'),
  credentialId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
  revision: z.string().min(1).max(128),
  updatedAt: z.string().datetime({ offset: true }),
  recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/)).min(1),
  ciphertextBase64: z.string().min(1).max(1_048_576),
}).strict();
export type EncryptedCredentialEnvelope = z.infer<typeof encryptedCredentialEnvelopeSchema>;

export const projectIdentitySourceSchema = /* @__PURE__ */ z.enum(['explicit', 'git', 'path_fallback']);
export type ProjectIdentitySource = z.infer<typeof projectIdentitySourceSchema>;

export const projectIdentitySchema = /* @__PURE__ */ z.object({
  projectId: z.string().min(1).max(128),
  source: projectIdentitySourceSchema,
  slug: z.string().min(1).max(64),
  workDirKey: z.string().min(1).max(128),
  gitRoot: z.string().min(1).max(4096).optional(),
  normalizedRemote: z.string().min(1).max(1024).optional(),
  rootCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;

export const configSyncScopeSchema = /* @__PURE__ */ z.enum(['portable', 'machine']);
export type ConfigSyncScope = z.infer<typeof configSyncScopeSchema>;

export const skillRootSyncPlanSchema = /* @__PURE__ */ z.object({
  path: z.string().min(1).max(4096),
  source: z.enum(['project', 'user', 'extra', 'builtin']),
  transport: z.enum(['git', 'file_tree']),
  gitRoot: z.string().min(1).max(4096).optional(),
  remoteUrl: z.string().min(1).max(1024).optional(),
  branch: z.string().min(1).max(256).optional(),
  ignorePatterns: z.array(z.string().min(1).max(128)),
});
export type SkillRootSyncPlan = z.infer<typeof skillRootSyncPlanSchema>;

export const syncCredentialSealInputSchema = /* @__PURE__ */ z.object({
  recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/)).min(1),
  credentialIds: z.array(z.string().min(1).max(128)).max(128).optional(),
}).strict();
export type SyncCredentialSealInput = z.infer<typeof syncCredentialSealInputSchema>;

export const syncCredentialMergeInputSchema = /* @__PURE__ */ z.object({
  envelopes: z.array(encryptedCredentialEnvelopeSchema).max(128),
}).strict();
export type SyncCredentialMergeInput = z.infer<typeof syncCredentialMergeInputSchema>;

export const syncCredentialMergeReceiptSchema = /* @__PURE__ */ z.object({
  appliedIds: z.array(z.string().min(1).max(128)),
  skippedIds: z.array(z.object({
    credentialId: z.string().min(1).max(128),
    reason: z.string().min(1).max(128),
  })),
  conflictIds: z.array(z.string().min(1).max(128)),
  revision: z.string().min(1).max(128),
}).strict();
export type SyncCredentialMergeReceipt = z.infer<typeof syncCredentialMergeReceiptSchema>;

export const syncProjectIdentityResolveInputSchema = /* @__PURE__ */ z.object({
  cwd: z.string().min(1).max(4096),
  bind: z.boolean().default(true),
}).strict();
export type SyncProjectIdentityResolveInput = z.infer<typeof syncProjectIdentityResolveInputSchema>;

export const syncMemoryScopeKindSchema = /* @__PURE__ */ z.enum(['global', 'persona', 'workspace', 'persona_workspace']);
export type SyncMemoryScopeKind = z.infer<typeof syncMemoryScopeKindSchema>;

export const syncMemoryScopeSchema = /* @__PURE__ */ z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('persona'), personaId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: z.string().min(1).max(128) }).strict(),
  z.object({
    kind: z.literal('persona_workspace'),
    workspaceId: z.string().min(1).max(128),
    personaId: z.string().min(1).max(128),
  }).strict(),
]);
export type SyncMemoryScope = z.infer<typeof syncMemoryScopeSchema>;

export const syncMemoryBasisSchema = /* @__PURE__ */ z.object({
  kind: z.enum(['human', 'observed', 'derived', 'unknown']),
  note: z.string().trim().min(1).max(500),
  refs: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
}).strict();
export type SyncMemoryBasis = z.infer<typeof syncMemoryBasisSchema>;

export const syncMemoryValiditySchema = /* @__PURE__ */ z.object({
  check: z.string().trim().min(1).max(300),
  until: z.string().datetime({ offset: true }).optional(),
}).strict();
export type SyncMemoryValidity = z.infer<typeof syncMemoryValiditySchema>;

export const syncMemoryRecordSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1).max(128),
  scope: syncMemoryScopeSchema.optional(),
  projectId: z.string().min(1).max(128).optional(),
  type: z.enum(['user', 'feedback', 'project', 'reference']),
  title: z.string().min(1).max(256),
  body: z.string(),
  pinned: z.boolean().optional(),
  updated: z.string(),
  revision: z.string().min(1).max(128),
  applicability: z.literal('portable').optional(),
  origin_host_id: z.string().max(128).optional(),
  basis: syncMemoryBasisSchema.optional(),
  validity: syncMemoryValiditySchema.optional(),
}).strict();
export type SyncMemoryRecord = z.infer<typeof syncMemoryRecordSchema>;

export const syncSkillFileEntrySchema = /* @__PURE__ */ z.object({
  skillName: z.string().min(1).max(128),
  relativePath: z.string().min(1).max(512),
  contentBase64: z.string(),
}).strict();
export type SyncSkillFileEntry = z.infer<typeof syncSkillFileEntrySchema>;

export const syncSessionFileEntrySchema = /* @__PURE__ */ z.object({
  sessionId: z.string().min(1).max(256),
  relativePath: z.string().min(1).max(512),
  contentBase64: z.string(),
}).strict();
export type SyncSessionFileEntry = z.infer<typeof syncSessionFileEntrySchema>;

export const syncHomeAssetEntrySchema = /* @__PURE__ */ z.object({
  relativePath: z.string().min(1).max(512),
  contentBase64: z.string(),
}).strict();
export type SyncHomeAssetEntry = z.infer<typeof syncHomeAssetEntrySchema>;

export const syncBundleSchema = /* @__PURE__ */ z.object({
  format: z.literal('kiki.sync-bundle.v1'),
  exportedAt: z.string().datetime({ offset: true }),
  portableConfig: z.record(z.string(), z.unknown()).optional(),
  homeAssets: z.array(syncHomeAssetEntrySchema).optional(),
  credentialEnvelopes: z.array(encryptedCredentialEnvelopeSchema).max(128).optional(),
  memories: z.array(syncMemoryRecordSchema).optional(),
  skills: z.array(syncSkillFileEntrySchema).optional(),
  skillPlans: z.array(skillRootSyncPlanSchema).max(64).optional(),
  sessions: z.array(syncSessionFileEntrySchema).optional(),
}).strict();
export type SyncBundle = z.infer<typeof syncBundleSchema>;

export const syncBundleImportInputSchema = /* @__PURE__ */ syncBundleSchema.extend({
  targetWorkDir: z.string().min(1).max(4096).optional(),
  targetProjectId: z.string().min(1).max(128).optional(),
}).strict();
export type SyncBundleImportInput = z.infer<typeof syncBundleImportInputSchema>;

export const syncBundleExportInputSchema = /* @__PURE__ */ z.object({
  recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/)).optional(),
  credentialIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  projectIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  memoryScopes: z.array(syncMemoryScopeKindSchema).optional(),
  workDir: z.string().min(1).max(4096).optional(),
  includeConfig: z.boolean().default(true),
  includeHomeAssets: z.boolean().optional(),
  includeCredentials: z.boolean().default(true),
  includeMemories: z.boolean().default(true),
  includeSkills: z.boolean().default(true),
  includeGitSkills: z.boolean().optional(),
  sessions: portableSpaceSessionSelectionSchema.optional(),
  targetPlatform: z.enum(['win32', 'darwin', 'linux']).optional(),
}).strict();
export type SyncBundleExportInput = z.infer<typeof syncBundleExportInputSchema>;

export const syncPeerTransferInputSchema = /* @__PURE__ */ z.object({
  credentialIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  projectIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  memoryScopes: z.array(syncMemoryScopeKindSchema).optional(),
  workDir: z.string().min(1).max(4096).optional(),
  targetWorkDir: z.string().min(1).max(4096).optional(),
  targetProjectId: z.string().min(1).max(128).optional(),
  includeConfig: z.boolean().default(true),
  includeCredentials: z.boolean().default(true),
  includeMemories: z.boolean().default(true),
  includeSkills: z.boolean().default(true),
  includeGitSkills: z.boolean().optional(),
  sessions: portableSpaceSessionSelectionSchema.optional(),
}).strict();
export type SyncPeerTransferInput = z.infer<typeof syncPeerTransferInputSchema>;

export const syncBundleImportReceiptSchema = /* @__PURE__ */ z.object({
  configDomainsApplied: z.array(z.string()),
  homeAssetsApplied: z.number().int().nonnegative().optional(),
  homeAssetsSkipped: z.number().int().nonnegative().optional(),
  credentials: syncCredentialMergeReceiptSchema,
  memoriesApplied: z.number().int().nonnegative(),
  memoriesSkipped: z.number().int().nonnegative(),
  skillsApplied: z.number().int().nonnegative(),
  skillsSkipped: z.number().int().nonnegative(),
  sessionsApplied: z.number().int().nonnegative().optional(),
  sessionsSkipped: z.number().int().nonnegative().optional(),
}).strict();
export type SyncBundleImportReceipt = z.infer<typeof syncBundleImportReceiptSchema>;

export const syncFilesExportInputSchema = /* @__PURE__ */ z.object({
  path: z.string().min(1).max(4096),
}).strict();
export type SyncFilesExportInput = z.infer<typeof syncFilesExportInputSchema>;

export const syncFilesExportResultSchema = /* @__PURE__ */ z.object({
  kind: z.enum(['file', 'directory']),
  rootName: z.string().min(1).max(256),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  archiveBase64: z.string().min(1),
}).strict();
export type SyncFilesExportResult = z.infer<typeof syncFilesExportResultSchema>;

export const syncFilesImportInputSchema = /* @__PURE__ */ z.object({
  destinationPath: z.string().min(1).max(4096),
  kind: z.enum(['file', 'directory']),
  archiveBase64: z.string().min(1),
}).strict();
export type SyncFilesImportInput = z.infer<typeof syncFilesImportInputSchema>;

export const syncFilesTransferReceiptSchema = /* @__PURE__ */ z.object({
  kind: z.enum(['file', 'directory']),
  destinationPath: z.string().min(1).max(4096),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(z.string()),
}).strict();
export type SyncFilesTransferReceipt = z.infer<typeof syncFilesTransferReceiptSchema>;

export const syncPeerFilesPullInputSchema = /* @__PURE__ */ z.object({
  remotePath: z.string().min(1).max(4096),
  localPath: z.string().min(1).max(4096),
}).strict();
export type SyncPeerFilesPullInput = z.infer<typeof syncPeerFilesPullInputSchema>;

export const syncPeerFilesPushInputSchema = /* @__PURE__ */ z.object({
  localPath: z.string().min(1).max(4096),
  remotePath: z.string().min(1).max(4096),
}).strict();
export type SyncPeerFilesPushInput = z.infer<typeof syncPeerFilesPushInputSchema>;

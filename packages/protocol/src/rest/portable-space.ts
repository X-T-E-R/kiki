import { z } from 'zod';

export const PORTABLE_SPACE_DOMAINS = [
  'config',
  'credentials',
  'instructions',
  'agents',
  'recipes',
  'personas',
  'mcp',
  'skills',
  'plugins',
  'memories',
  'appearance',
  'sessions',
] as const;

export const portableSpaceDomainSchema = z.enum(PORTABLE_SPACE_DOMAINS);
export type PortableSpaceDomain = z.infer<typeof portableSpaceDomainSchema>;

export const portableSpaceModeSchema = z.enum(['full', 'overlay']);
export type PortableSpaceMode = z.infer<typeof portableSpaceModeSchema>;

export const portableSpaceFormatSchema = z.enum(['dir', 'age', 'tgz']);
export type PortableSpaceFormat = z.infer<typeof portableSpaceFormatSchema>;

export const portableSpaceSecretModeSchema = z.enum(['none', 'sealed', 'plain']);
export type PortableSpaceSecretMode = z.infer<typeof portableSpaceSecretModeSchema>;

export const portableSpaceEncryptionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('x25519'),
    recipients: z.array(z.string().regex(/^age1[a-z0-9]+$/)).optional(),
  }).strict(),
  z.object({
    mode: z.literal('passphrase'),
    passphrase: z.string().min(1).max(1024).optional(),
  }).strict(),
]);
export type PortableSpaceEncryption = z.infer<typeof portableSpaceEncryptionSchema>;

export const portableSpaceUnlockSchema = z.object({
  passphrase: z.string().min(1).max(1024).optional(),
  identity: z.string().min(1).max(512).optional(),
}).strict();
export type PortableSpaceUnlock = z.infer<typeof portableSpaceUnlockSchema>;

export const portableSpaceEndpointSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('live'),
    spaceId: z.union([z.literal('main'), z.string().regex(/^h-[a-z0-9-]+$/)]).default('main'),
  }).strict(),
  z.object({
    kind: z.literal('dir'),
    path: z.string().min(1).max(4096),
  }).strict(),
  z.object({
    kind: z.literal('archive'),
    path: z.string().min(1).max(4096),
  }).strict(),
  z.object({
    kind: z.literal('git'),
    repo: z.string().min(1).max(1024),
    ref: z.string().min(1).max(256).optional(),
    subpath: z.string().min(1).max(512).optional(),
  }).strict(),
  z.object({
    kind: z.literal('url'),
    url: z.url().max(4096),
  }).strict(),
]);
export type PortableSpaceEndpoint = z.infer<typeof portableSpaceEndpointSchema>;

export const portableSpaceSessionSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('recent'), count: z.number().int().min(1) }).strict(),
  z.object({ mode: z.literal('ids'), sessionIds: z.array(z.string().min(1).max(256)).min(1) }).strict(),
]);
export type PortableSpaceSessionSelection = z.infer<typeof portableSpaceSessionSelectionSchema>;

export const portableSpaceItemSummarySchema = z.object({
  id: z.string().min(1).max(512),
  domain: portableSpaceDomainSchema,
  path: z.string().min(1).max(512),
  label: z.string().min(1).max(256),
  summary: z.string().max(512).optional(),
  bytes: z.number().int().nonnegative().optional(),
  masked: z.boolean().optional(),
  unset: z.boolean().optional(),
  scalarValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
}).strict();
export type PortableSpaceItemSummary = z.infer<typeof portableSpaceItemSummarySchema>;

export const portableSpaceDomainCountSchema = z.object({
  domain: portableSpaceDomainSchema,
  count: z.number().int().nonnegative(),
}).strict();
export type PortableSpaceDomainCount = z.infer<typeof portableSpaceDomainCountSchema>;

export const portableSpaceExcludedItemSchema = z.object({
  id: z.string().min(1).max(512),
  domain: portableSpaceDomainSchema,
  path: z.string().min(1).max(512),
  reason: z.string().min(1).max(512),
}).strict();
export type PortableSpaceExcludedItem = z.infer<typeof portableSpaceExcludedItemSchema>;

export const portableSpaceInspectInputSchema = z.object({
  endpoint: portableSpaceEndpointSchema,
  unlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceInspectInput = z.infer<typeof portableSpaceInspectInputSchema>;

export const portableSpaceInspectResultSchema = z.object({
  endpoint: portableSpaceEndpointSchema,
  label: z.string().min(1).max(256),
  format: portableSpaceFormatSchema,
  spaceMode: portableSpaceModeSchema,
  secretMode: portableSpaceSecretModeSchema,
  encryptionMode: z.enum(['none', 'x25519', 'passphrase']),
  recipients: z.array(z.string()),
  unset: z.array(z.string()),
  git: z.object({
    repo: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    dirty: z.boolean().optional(),
  }).strict().optional(),
  domains: z.array(portableSpaceDomainCountSchema),
  items: z.array(portableSpaceItemSummarySchema),
  excluded: z.array(portableSpaceExcludedItemSchema).optional(),
  updatedAt: z.string().optional(),
}).strict();
export type PortableSpaceInspectResult = z.infer<typeof portableSpaceInspectResultSchema>;

export const portableSpaceSourceRecordSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  endpoint: portableSpaceEndpointSchema,
  linkedSpaceId: z.union([z.literal('main'), z.string().regex(/^h-[a-z0-9-]+$/)]).optional(),
  format: portableSpaceFormatSchema,
  spaceMode: portableSpaceModeSchema.optional(),
  secretMode: portableSpaceSecretModeSchema.optional(),
  encryptionMode: z.enum(['none', 'x25519', 'passphrase']).optional(),
  gitBranch: z.string().optional(),
  updatedAt: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  autoSync: z.boolean().optional(),
  etag: z.string().max(512).optional(),
  etagOrigin: z.string().max(512).optional(),
  lastCheckedAt: z.string().optional(),
  lastSyncError: z.string().max(1024).optional(),
  managedIds: z.array(z.string().min(1).max(512)).optional(),
  pendingOfficialPlugins: z.array(z.string().min(1).max(128)).max(64).optional(),
}).strict();
export type PortableSpaceSourceRecord = z.infer<typeof portableSpaceSourceRecordSchema>;

export const portableSpaceSourcesListResponseSchema = z.object({
  deviceRecipient: z.string().regex(/^age1[a-z0-9]+$/),
  knownRecipients: z.array(z.object({
    label: z.string().max(128).optional(),
    recipient: z.string().regex(/^age1[a-z0-9]+$/),
  }).strict()),
  items: z.array(portableSpaceSourceRecordSchema),
}).strict();
export type PortableSpaceSourcesListResponse = z.infer<typeof portableSpaceSourcesListResponseSchema>;

export const portableSpaceRegisterSourceInputSchema = z.object({
  label: z.string().min(1).max(256).optional(),
  endpoint: portableSpaceEndpointSchema,
  linkToSpaceId: z.union([z.literal('main'), z.string().regex(/^h-[a-z0-9-]+$/)]).optional(),
  autoSync: z.boolean().optional(),
  unlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceRegisterSourceInput = z.infer<typeof portableSpaceRegisterSourceInputSchema>;

export const portableSpaceSubscribeInputSchema = z.object({
  url: z.url().max(4096),
  label: z.string().min(1).max(256).optional(),
  linkToSpaceId: z.union([z.literal('main'), z.string().regex(/^h-[a-z0-9-]+$/)]).default('main'),
  autoSync: z.boolean().default(true),
  unlock: portableSpaceUnlockSchema.optional(),
  createBackup: z.boolean().default(true),
}).strict();
export type PortableSpaceSubscribeInput = z.infer<typeof portableSpaceSubscribeInputSchema>;

export const portableSpaceSubscriptionSyncInputSchema = z.object({
  force: z.boolean().default(false),
  createBackup: z.boolean().default(true),
}).strict();
export type PortableSpaceSubscriptionSyncInput = z.infer<typeof portableSpaceSubscriptionSyncInputSchema>;

export const portableSpaceSubscriptionSyncResultSchema = z.object({
  source: portableSpaceSourceRecordSchema,
  status: z.enum(['updated', 'not_modified', 'error']),
  appliedIds: z.array(z.string()),
  deletedIds: z.array(z.string()),
  skippedIds: z.array(z.string()),
  backupPath: z.string().optional(),
  error: z.string().optional(),
}).strict();
export type PortableSpaceSubscriptionSyncResult = z.infer<typeof portableSpaceSubscriptionSyncResultSchema>;

export const portableSpaceRemoveSourceResponseSchema = z.object({
  removed: z.literal(true),
}).strict();
export type PortableSpaceRemoveSourceResponse = z.infer<typeof portableSpaceRemoveSourceResponseSchema>;

export const portableSpaceExportInputSchema = z.object({
  source: portableSpaceEndpointSchema.default({ kind: 'live', spaceId: 'main' }),
  destination: z.string().min(1).max(4096),
  format: portableSpaceFormatSchema.optional(),
  spaceMode: portableSpaceModeSchema.default('full'),
  secretMode: portableSpaceSecretModeSchema.optional(),
  encryption: portableSpaceEncryptionSchema.optional(),
  domains: z.array(portableSpaceDomainSchema).min(1).max(12).optional(),
  pick: z.array(z.string().min(1).max(256)).max(256).optional(),
  unset: z.array(z.string().min(1).max(256)).max(256).optional(),
  sessions: portableSpaceSessionSelectionSchema.default({ mode: 'none' }),
  includeMemories: z.boolean().default(true),
  gitInit: z.boolean().default(false),
  targetPlatform: z.enum(['win32', 'darwin', 'linux']).optional(),
  sourceUnlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceExportInput = z.infer<typeof portableSpaceExportInputSchema>;

export const portableSpaceExportReceiptSchema = z.object({
  destination: z.string(),
  format: portableSpaceFormatSchema,
  spaceMode: portableSpaceModeSchema,
  secretMode: portableSpaceSecretModeSchema,
  encryptionMode: z.enum(['none', 'x25519', 'passphrase']),
  domains: z.array(portableSpaceDomainCountSchema),
  totalItems: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative().optional(),
  excluded: z.array(portableSpaceExcludedItemSchema).optional(),
  sourceRecord: portableSpaceSourceRecordSchema.optional(),
}).strict();
export type PortableSpaceExportReceipt = z.infer<typeof portableSpaceExportReceiptSchema>;

export const portableSpaceOperationModeSchema = z.enum(['merge', 'override', 'replace', 'sync']);
export type PortableSpaceOperationMode = z.infer<typeof portableSpaceOperationModeSchema>;

export const portableSpaceDiffChangeSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'only_left',
  'only_right',
  'conflict',
  'unchanged',
]);
export type PortableSpaceDiffChange = z.infer<typeof portableSpaceDiffChangeSchema>;

export const PORTABLE_SPACE_DIFF_PREVIEW_MAX_CHARS = 16_384;

export const portableSpaceDiffRowSchema = z.object({
  id: z.string().min(1).max(512),
  domain: portableSpaceDomainSchema,
  path: z.string().min(1).max(512),
  label: z.string().min(1).max(256),
  change: portableSpaceDiffChangeSchema,
  direction: z.enum(['to_target', 'to_left', 'to_right', 'both', 'conflict', 'none']),
  beforeSummary: z.string().max(512).nullable(),
  afterSummary: z.string().max(512).nullable(),
  diffPreview: z.string().max(PORTABLE_SPACE_DIFF_PREVIEW_MAX_CHARS).optional(),
  selected: z.boolean(),
  masked: z.boolean().optional(),
  blockedReason: z.string().max(512).optional(),
}).strict();
export type PortableSpaceDiffRow = z.infer<typeof portableSpaceDiffRowSchema>;

export const portableSpacePreviewInputSchema = z.object({
  mode: portableSpaceOperationModeSchema.default('merge'),
  sources: z.array(portableSpaceEndpointSchema).min(1).max(8),
  target: portableSpaceEndpointSchema.default({ kind: 'live', spaceId: 'main' }),
  base: portableSpaceEndpointSchema.optional(),
  domains: z.array(portableSpaceDomainSchema).min(1).max(12).optional(),
  pick: z.array(z.string().min(1).max(256)).max(256).optional(),
  prefer: z.enum(['left', 'right']).optional(),
  targetPlatform: z.enum(['win32', 'darwin', 'linux']).optional(),
  sourceUnlocks: z.array(portableSpaceUnlockSchema.optional()).max(8).optional(),
  targetUnlock: portableSpaceUnlockSchema.optional(),
  baseUnlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpacePreviewInput = z.infer<typeof portableSpacePreviewInputSchema>;

export const portableSpacePreviewResultSchema = z.object({
  previewToken: z.string().min(1).max(128),
  mode: portableSpaceOperationModeSchema,
  hasVerifiedBase: z.boolean(),
  sourceLabels: z.array(z.string()),
  targetLabel: z.string(),
  rows: z.array(portableSpaceDiffRowSchema),
  unchangedCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  dependencyErrors: z.array(z.string()),
  expiresAt: z.string(),
}).strict();
export type PortableSpacePreviewResult = z.infer<typeof portableSpacePreviewResultSchema>;

export const portableSpaceApplyInputSchema = z.object({
  previewToken: z.string().min(1).max(128).optional(),
  direct: portableSpacePreviewInputSchema.optional(),
  selectedIds: z.array(z.string().min(1).max(512)).max(2048).optional(),
  resolutions: z.record(z.string(), z.enum(['left', 'right', 'skip'])).optional(),
  createBackup: z.boolean().default(true),
  targetEncryption: portableSpaceEncryptionSchema.optional(),
}).strict();
export type PortableSpaceApplyInput = z.infer<typeof portableSpaceApplyInputSchema>;

export const portableSpaceApplyReceiptSchema = z.object({
  mode: portableSpaceOperationModeSchema,
  appliedIds: z.array(z.string()),
  skippedIds: z.array(z.string()),
  deletedIds: z.array(z.string()),
  backupPath: z.string().optional(),
  gitSyncedSkills: z.array(z.string()).optional(),
  restartRequired: z.boolean(),
}).strict();
export type PortableSpaceApplyReceipt = z.infer<typeof portableSpaceApplyReceiptSchema>;

export const portableSpacePackUnpackInputSchema = z.object({
  action: z.enum(['pack', 'unpack']),
  sourcePath: z.string().min(1).max(4096),
  destinationPath: z.string().min(1).max(4096),
  format: z.enum(['age', 'tgz']).optional(),
  secretMode: portableSpaceSecretModeSchema.optional(),
  encryption: portableSpaceEncryptionSchema.optional(),
  unlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpacePackUnpackInput = z.infer<typeof portableSpacePackUnpackInputSchema>;

export const portableSpaceForkInputSchema = z.object({
  source: portableSpaceEndpointSchema,
  destination: z.string().min(1).max(4096),
  format: portableSpaceFormatSchema.optional(),
  overlay: z.boolean().default(false),
  secretMode: portableSpaceSecretModeSchema.optional(),
  encryption: portableSpaceEncryptionSchema.optional(),
  domains: z.array(portableSpaceDomainSchema).min(1).max(12).optional(),
  pick: z.array(z.string().min(1).max(256)).max(256).optional(),
  unset: z.array(z.string().min(1).max(256)).max(256).optional(),
  includeMemories: z.boolean().default(true),
  sourceUnlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceForkInput = z.infer<typeof portableSpaceForkInputSchema>;

export const portableSpaceDeltaInputSchema = z.object({
  source: portableSpaceEndpointSchema.default({ kind: 'live', spaceId: 'main' }),
  since: portableSpaceEndpointSchema,
  destination: z.string().min(1).max(4096),
  format: portableSpaceFormatSchema.optional(),
  encryption: portableSpaceEncryptionSchema.optional(),
  domains: z.array(portableSpaceDomainSchema).min(1).max(12).optional(),
  sessions: portableSpaceSessionSelectionSchema.default({ mode: 'none' }),
  sourceUnlock: portableSpaceUnlockSchema.optional(),
  sinceUnlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceDeltaInput = z.infer<typeof portableSpaceDeltaInputSchema>;

export const portableSpaceMutateActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), key: z.string().min(1).max(256), value: z.unknown() }).strict(),
  z.object({ op: z.literal('unset'), key: z.string().min(1).max(256), recordOverlayUnset: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('rm'), paths: z.array(z.string().min(1).max(512)).min(1).max(256) }).strict(),
  z.object({
    op: z.literal('cp'),
    from: portableSpaceEndpointSchema,
    fromPath: z.string().min(1).max(512),
    toPath: z.string().min(1).max(512).optional(),
    fromUnlock: portableSpaceUnlockSchema.optional(),
  }).strict(),
  z.object({
    op: z.literal('writeFile'),
    path: z.string().min(1).max(512),
    contentBase64: z.string(),
  }).strict(),
]);
export type PortableSpaceMutateAction = z.infer<typeof portableSpaceMutateActionSchema>;

export const portableSpaceMutateInputSchema = z.object({
  target: portableSpaceEndpointSchema,
  actions: z.array(portableSpaceMutateActionSchema).min(1).max(128),
  unlock: portableSpaceUnlockSchema.optional(),
  encryption: portableSpaceEncryptionSchema.optional(),
}).strict();
export type PortableSpaceMutateInput = z.infer<typeof portableSpaceMutateInputSchema>;

export const portableSpaceMutateReceiptSchema = z.object({
  changed: z.boolean(),
  appliedOps: z.number().int().nonnegative(),
  inspect: portableSpaceInspectResultSchema,
}).strict();
export type PortableSpaceMutateReceipt = z.infer<typeof portableSpaceMutateReceiptSchema>;

export const portableSpaceRekeyInputSchema = z.object({
  target: z.string().min(1).max(4096),
  outputPath: z.string().min(1).max(4096).optional(),
  unlock: portableSpaceUnlockSchema.optional(),
  encryption: portableSpaceEncryptionSchema,
}).strict();
export type PortableSpaceRekeyInput = z.infer<typeof portableSpaceRekeyInputSchema>;

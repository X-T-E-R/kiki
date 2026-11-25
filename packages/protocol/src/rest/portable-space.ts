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

export const portableSpaceAddRecipientInputSchema = z.object({
  recipient: z.string().regex(/^age1[a-z0-9]+$/),
  label: z.string().min(1).max(128).optional(),
}).strict();
export type PortableSpaceAddRecipientInput = z.infer<typeof portableSpaceAddRecipientInputSchema>;

export const PORTABLE_SUBSCRIPTION_SCOPES = [
  'models_providers',
  'extensions_search',
  'agents_recipes',
  'personas',
  'instructions',
  'settings',
] as const;

export const portableSubscriptionScopeSchema = z.enum(PORTABLE_SUBSCRIPTION_SCOPES);
export type PortableSubscriptionScope = z.infer<typeof portableSubscriptionScopeSchema>;

export const portableSpaceSyncPolicySchema = z.enum(['auto', 'manual', 'once']);
export type PortableSpaceSyncPolicy = z.infer<typeof portableSpaceSyncPolicySchema>;

export const portableSpaceStoredSyncPolicySchema = z.enum(['auto', 'manual']);
export type PortableSpaceStoredSyncPolicy = z.infer<typeof portableSpaceStoredSyncPolicySchema>;

export const PORTABLE_SPACE_MAX_SELECTION_OVERRIDES = 2048;
export const PORTABLE_SPACE_MAX_BINDING_ASSIGNMENTS = 16_384;
export const PORTABLE_SPACE_MAX_PREVIEW_ITEMS = 2048;
export const PORTABLE_SPACE_MAX_PREVIEW_EDGES = 16_384;
export const PORTABLE_SPACE_PREVIEW_TTL_MS = 300_000;
export const PORTABLE_SPACE_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const PORTABLE_SPACE_CENTER_BODY_LIMIT = 3 * 1024 * 1024;

export const portableSpaceSpaceIdSchema = z.union([z.literal('main'), z.string().regex(/^h-[a-z0-9-]+$/)]);

/** Builds the canonical collision-free JSON tuple key for a per-unit model binding slot. */
export function formatBindingSlotTupleKey(itemId: string, sourceModelId: string): string {
  return JSON.stringify([itemId, sourceModelId]);
}

/** Parses a canonical JSON tuple key (`JSON.stringify([itemId, sourceModelId])`) and validates its round-trip form. */
export function parseBindingSlotTupleKey(raw: string): readonly [itemId: string, sourceModelId: string] | undefined {
  if (raw.length === 0 || raw.length > 1024) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
  const [itemId, sourceModelId] = parsed;
  if (typeof itemId !== 'string' || typeof sourceModelId !== 'string') return undefined;
  if (itemId.length === 0 || itemId.length > 512 || sourceModelId.length === 0 || sourceModelId.length > 256) return undefined;
  if (JSON.stringify([itemId, sourceModelId]) !== raw) return undefined;
  return [itemId, sourceModelId] as const;
}

const uniqueItemIdArraySchema = z.array(z.string().min(1).max(512)).max(PORTABLE_SPACE_MAX_SELECTION_OVERRIDES);

export const portableSpaceSubscriptionSelectionSchema = z.object({
  version: z.literal(1),
  enabledScopes: z.array(portableSubscriptionScopeSchema).max(PORTABLE_SUBSCRIPTION_SCOPES.length),
  excludedIds: uniqueItemIdArraySchema,
  includedIds: uniqueItemIdArraySchema,
  includeCredentials: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.enabledScopes).size !== value.enabledScopes.length) {
    ctx.addIssue({ code: 'custom', path: ['enabledScopes'], message: 'enabledScopes must contain unique scope names' });
  }
  const excludedSet = new Set(value.excludedIds);
  if (excludedSet.size !== value.excludedIds.length) {
    ctx.addIssue({ code: 'custom', path: ['excludedIds'], message: 'excludedIds must contain unique item IDs' });
  }
  const includedSet = new Set(value.includedIds);
  if (includedSet.size !== value.includedIds.length) {
    ctx.addIssue({ code: 'custom', path: ['includedIds'], message: 'includedIds must contain unique item IDs' });
  }
  if (value.excludedIds.length + value.includedIds.length > PORTABLE_SPACE_MAX_SELECTION_OVERRIDES) {
    ctx.addIssue({ code: 'custom', path: ['excludedIds'], message: `Total selection overrides cannot exceed ${PORTABLE_SPACE_MAX_SELECTION_OVERRIDES}` });
  }
  for (const id of includedSet) {
    if (excludedSet.has(id)) {
      ctx.addIssue({ code: 'custom', path: ['includedIds'], message: `Item ID "${id}" cannot appear in both excludedIds and includedIds` });
      break;
    }
  }
});
export type PortableSpaceSubscriptionSelection = z.infer<typeof portableSpaceSubscriptionSelectionSchema>;

const modelAliasStringSchema = z.string().min(1).max(256);

export const portableSpaceBindingChoicesFields = {
  modelBindings: z.record(modelAliasStringSchema, modelAliasStringSchema).optional(),
  unitModelBindings: z.record(z.string().min(1).max(1024), modelAliasStringSchema).optional(),
  unmappedModelPolicy: z.literal('defer').optional(),
  deferredSlotIds: z.array(z.string().min(1).max(1024)).max(PORTABLE_SPACE_MAX_BINDING_ASSIGNMENTS).optional(),
};

function validateBindingChoices(
  value: {
    readonly modelBindings?: Readonly<Record<string, string>>;
    readonly unitModelBindings?: Readonly<Record<string, string>>;
    readonly unmappedModelPolicy?: 'defer';
    readonly deferredSlotIds?: readonly string[];
  },
  ctx: z.RefinementCtx,
): void {
  const modelKeys = value.modelBindings ? Object.keys(value.modelBindings) : [];
  const unitKeys = value.unitModelBindings ? Object.keys(value.unitModelBindings) : [];
  const deferred = value.deferredSlotIds ?? [];
  if (modelKeys.length + unitKeys.length + deferred.length > PORTABLE_SPACE_MAX_BINDING_ASSIGNMENTS) {
    ctx.addIssue({ code: 'custom', path: ['modelBindings'], message: `Total model binding assignments cannot exceed ${PORTABLE_SPACE_MAX_BINDING_ASSIGNMENTS}` });
  }
  const unitKeySet = new Set<string>();
  for (const key of unitKeys) {
    if (parseBindingSlotTupleKey(key) === undefined) {
      ctx.addIssue({ code: 'custom', path: ['unitModelBindings', key], message: 'unitModelBindings keys must be canonical JSON [itemId, sourceModelId] tuples' });
      break;
    }
    unitKeySet.add(key);
  }
  const deferredSet = new Set<string>();
  for (let i = 0; i < deferred.length; i += 1) {
    const slotKey = deferred[i]!;
    if (parseBindingSlotTupleKey(slotKey) === undefined) {
      ctx.addIssue({ code: 'custom', path: ['deferredSlotIds', i], message: 'deferredSlotIds entries must be canonical JSON [itemId, sourceModelId] tuples' });
      break;
    }
    if (deferredSet.has(slotKey)) {
      ctx.addIssue({ code: 'custom', path: ['deferredSlotIds', i], message: `Duplicate deferredSlotIds entry: ${slotKey}` });
      break;
    }
    if (unitKeySet.has(slotKey)) {
      ctx.addIssue({ code: 'custom', path: ['deferredSlotIds', i], message: `Slot ${slotKey} cannot be both explicitly bound and deferred` });
      break;
    }
    deferredSet.add(slotKey);
  }
  if (deferred.length > 0 && value.unmappedModelPolicy !== 'defer') {
    ctx.addIssue({ code: 'custom', path: ['unmappedModelPolicy'], message: 'unmappedModelPolicy must be "defer" when deferredSlotIds is non-empty' });
  }
}

export const portableSpaceBindingChoicesSchema = z.object(portableSpaceBindingChoicesFields).strict().superRefine(validateBindingChoices);
export type PortableSpaceBindingChoices = z.infer<typeof portableSpaceBindingChoicesSchema>;

export const portableSpaceDependencyEdgeSchema = z.object({
  toId: z.string().min(1).max(512),
  kind: z.enum(['hard', 'soft']),
  via: z.string().min(1).max(128),
  liveSatisfied: z.boolean(),
}).strict();
export type PortableSpaceDependencyEdge = z.infer<typeof portableSpaceDependencyEdgeSchema>;

export const portableSpaceLocalModelOptionSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  providerId: z.string().min(1).max(128).optional(),
  thinkingEfforts: z.array(z.string().min(1).max(64)).max(32).optional(),
  defaultThinkingEffort: z.string().min(1).max(64).optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
}).strict();
export type PortableSpaceLocalModelOption = z.infer<typeof portableSpaceLocalModelOptionSchema>;

export const portableSpaceBindingSlotSchema = z.object({
  tupleKey: z.string().min(1).max(1024),
  itemId: z.string().min(1).max(512),
  itemLabel: z.string().min(1).max(256),
  itemScope: portableSubscriptionScopeSchema,
  sourceModelId: z.string().min(1).max(256),
  required: z.boolean(),
  location: z.string().min(1).max(128),
  eligibleOptionIndices: z.array(z.number().int().nonnegative()),
  currentLocalModelId: z.string().min(1).max(256).optional(),
  reason: z.string().max(512).optional(),
  restrictionNote: z.string().max(512).optional(),
}).strict();
export type PortableSpaceBindingSlot = z.infer<typeof portableSpaceBindingSlotSchema>;

export const portableSpaceSubscribePreviewItemStatusSchema = z.enum([
  'will_write',
  'unchanged',
  'kept_local',
  'new_scope',
  'blocked',
  'owned_by_other',
  'pending',
  'removed_impact',
]);
export type PortableSpaceSubscribePreviewItemStatus = z.infer<typeof portableSpaceSubscribePreviewItemStatusSchema>;

export const portableSpaceSubscribePreviewItemSchema = z.object({
  id: z.string().min(1).max(512),
  scope: portableSubscriptionScopeSchema,
  domain: portableSpaceDomainSchema,
  label: z.string().min(1).max(256),
  path: z.string().min(1).max(512),
  memberUnitIds: z.array(z.string().min(1).max(512)),
  dependsOnIds: z.array(z.string().min(1).max(512)),
  softDependsOnIds: z.array(z.string().min(1).max(512)),
  referencedByIds: z.array(z.string().min(1).max(512)),
  dependencyEdges: z.array(portableSpaceDependencyEdgeSchema),
  coupledCredentialIds: z.array(z.string().min(1).max(512)),
  liveSatisfiedIds: z.array(z.string().min(1).max(512)),
  blockedDependencyIds: z.array(z.string().min(1).max(512)),
  status: portableSpaceSubscribePreviewItemStatusSchema,
  selectable: z.boolean(),
  selected: z.boolean(),
  reason: z.string().max(512).optional(),
  ownerSourceId: z.string().min(1).max(128).optional(),
  ownerLabel: z.string().min(1).max(256).optional(),
  safeDiff: z.string().max(PORTABLE_SPACE_DIFF_PREVIEW_MAX_CHARS).optional(),
  safeDiffTruncated: z.boolean().optional(),
  warnings: z.array(z.string().max(512)).optional(),
}).strict();
export type PortableSpaceSubscribePreviewItem = z.infer<typeof portableSpaceSubscribePreviewItemSchema>;

export const portableSpaceImpactSchema = z.object({
  managedCount: z.number().int().nonnegative(),
  deletedIds: z.array(z.string().min(1).max(512)),
  handedOffIds: z.array(z.string().min(1).max(512)),
  preservedLocalIds: z.array(z.string().min(1).max(512)),
  preservedDependencyIds: z.array(z.string().min(1).max(512)),
  pendingReconcileIds: z.array(z.string().min(1).max(512)),
  addedIds: z.array(z.string().min(1).max(512)),
  updatedIds: z.array(z.string().min(1).max(512)),
}).strict();
export type PortableSpaceImpact = z.infer<typeof portableSpaceImpactSchema>;

export const portableSpaceSubscribePreviewManifestSchema = z.object({
  previewToken: z.string().min(1).max(128),
  packDigest: z.string().min(1).max(128),
  expiresAt: z.string(),
  targetSpaceId: portableSpaceSpaceIdSchema,
  suggestedLabel: z.string().min(1).max(256),
  displayOrigin: z.string().min(1).max(256),
  format: portableSpaceFormatSchema,
  secretMode: portableSpaceSecretModeSchema,
  encryptionMode: z.enum(['none', 'x25519', 'passphrase']),
  allowedPolicies: z.array(portableSpaceSyncPolicySchema).min(1).max(3),
  defaultSelection: portableSpaceSubscriptionSelectionSchema,
  items: z.array(portableSpaceSubscribePreviewItemSchema).max(PORTABLE_SPACE_MAX_PREVIEW_ITEMS),
  excluded: z.array(portableSpaceExcludedItemSchema),
  bindingSlots: z.array(portableSpaceBindingSlotSchema),
  localModelOptions: z.array(portableSpaceLocalModelOptionSchema),
  savedBindingChoices: portableSpaceBindingChoicesSchema,
  catalogRevision: z.string().min(1).max(128),
  targetRevision: z.string().min(1).max(128),
  orderRevision: z.string().min(1).max(128),
  impact: portableSpaceImpactSchema.optional(),
  impactDigest: z.string().min(1).max(128).optional(),
  manifestTruncated: z.boolean().optional(),
}).strict();
export type PortableSpaceSubscribePreviewManifest = z.infer<typeof portableSpaceSubscribePreviewManifestSchema>;

export const portableSpaceCenterSourceSchema = portableSpaceSourceRecordSchema.extend({
  enabled: z.boolean(),
  priority: z.number().int().nonnegative().optional(),
  syncPolicy: portableSpaceStoredSyncPolicySchema.optional(),
  selection: portableSpaceSubscriptionSelectionSchema.optional(),
  revision: z.string().min(1).max(128),
  availableNewScopes: z.array(portableSubscriptionScopeSchema).max(PORTABLE_SUBSCRIPTION_SCOPES.length),
  needsReconcile: z.boolean(),
  ...portableSpaceBindingChoicesFields,
}).strict().superRefine(validateBindingChoices);
export type PortableSpaceCenterSource = z.infer<typeof portableSpaceCenterSourceSchema>;

export const portableSpaceCenterSourcesListResponseSchema = z.object({
  deviceRecipient: z.string().regex(/^age1[a-z0-9]+$/),
  knownRecipients: z.array(z.object({
    label: z.string().max(128).optional(),
    recipient: z.string().regex(/^age1[a-z0-9]+$/),
  }).strict()),
  items: z.array(portableSpaceCenterSourceSchema),
  orderRevision: z.string().min(1).max(128),
}).strict();
export type PortableSpaceCenterSourcesListResponse = z.infer<typeof portableSpaceCenterSourcesListResponseSchema>;

export const portableSpaceCenterCommitSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscription'),
    source: portableSpaceCenterSourceSchema,
    status: z.enum(['updated', 'not_modified', 'error']),
    appliedIds: z.array(z.string()),
    deletedIds: z.array(z.string()),
    skippedIds: z.array(z.string()),
    impact: portableSpaceImpactSchema,
    error: z.string().optional(),
    backupPath: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal('once'),
    status: z.literal('imported'),
    appliedIds: z.array(z.string()),
    deletedIds: z.array(z.string()),
    skippedIds: z.array(z.string()),
    impact: portableSpaceImpactSchema,
    backupPath: z.string().optional(),
  }).strict(),
]);
export type PortableSpaceCenterCommit = z.infer<typeof portableSpaceCenterCommitSchema>;

export const portableSpaceSubscribePreviewSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.url().max(4096),
  }).strict(),
  z.object({
    kind: z.literal('archive'),
    path: z.string().min(1).max(4096),
  }).strict(),
]);
export type PortableSpaceSubscribePreviewSource = z.infer<typeof portableSpaceSubscribePreviewSourceSchema>;

export const portableSpaceSubscribePreviewInputSchema = z.object({
  source: portableSpaceSubscribePreviewSourceSchema,
  linkToSpaceId: portableSpaceSpaceIdSchema.default('main'),
  unlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceSubscribePreviewInput = z.infer<typeof portableSpaceSubscribePreviewInputSchema>;

export const portableSpaceCenterSubscribeInputSchema = z.object({
  previewToken: z.string().min(1).max(128),
  selection: portableSpaceSubscriptionSelectionSchema,
  syncPolicy: portableSpaceSyncPolicySchema,
  label: z.string().min(1).max(120).optional(),
  createBackup: z.boolean().default(true),
  ...portableSpaceBindingChoicesFields,
}).strict().superRefine(validateBindingChoices);
export type PortableSpaceCenterSubscribeInput = z.infer<typeof portableSpaceCenterSubscribeInputSchema>;

export const portableSpaceSubscribeRequestSchema = z.union([
  portableSpaceCenterSubscribeInputSchema,
  portableSpaceSubscribeInputSchema,
]);
export type PortableSpaceSubscribeRequest = z.infer<typeof portableSpaceSubscribeRequestSchema>;

export const portableSpaceSourcePreviewRefreshInputSchema = z.object({
  unlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceSourcePreviewRefreshInput = z.infer<typeof portableSpaceSourcePreviewRefreshInputSchema>;

export const portableSpaceSourcePreviewReviewInputSchema = z.object({
  previewToken: z.string().min(1).max(128),
  selection: portableSpaceSubscriptionSelectionSchema,
  cleanupDeselected: z.literal(true),
  ...portableSpaceBindingChoicesFields,
}).strict().superRefine(validateBindingChoices);
export type PortableSpaceSourcePreviewReviewInput = z.infer<typeof portableSpaceSourcePreviewReviewInputSchema>;

export const portableSpaceSourcePreviewInputSchema = z.union([
  portableSpaceSourcePreviewReviewInputSchema,
  portableSpaceSourcePreviewRefreshInputSchema,
]);
export type PortableSpaceSourcePreviewInput = z.infer<typeof portableSpaceSourcePreviewInputSchema>;

export const portableSpaceCenterTokenSyncInputSchema = z.object({
  previewToken: z.string().min(1).max(128),
  createBackup: z.boolean().default(true),
  ...portableSpaceBindingChoicesFields,
}).strict().superRefine(validateBindingChoices);
export type PortableSpaceCenterTokenSyncInput = z.infer<typeof portableSpaceCenterTokenSyncInputSchema>;

export const portableSpaceCenterDirectSyncInputSchema = z.object({
  force: z.boolean().default(false),
  createBackup: z.boolean().default(true),
  unlock: portableSpaceUnlockSchema.optional(),
}).strict();
export type PortableSpaceCenterDirectSyncInput = z.infer<typeof portableSpaceCenterDirectSyncInputSchema>;

export const portableSpaceCenterSyncInputSchema = z.union([
  portableSpaceCenterTokenSyncInputSchema,
  portableSpaceCenterDirectSyncInputSchema,
]);
export type PortableSpaceCenterSyncInput = z.infer<typeof portableSpaceCenterSyncInputSchema>;

export const portableSpacePatchSourceMetadataInputSchema = z.object({
  expectedRevision: z.string().min(1).max(128),
  label: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  syncPolicy: portableSpaceStoredSyncPolicySchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.label === undefined && value.enabled === undefined && value.syncPolicy === undefined) {
    ctx.addIssue({ code: 'custom', path: ['label'], message: 'At least one of label, enabled, or syncPolicy must be specified' });
  }
});
export type PortableSpacePatchSourceMetadataInput = z.infer<typeof portableSpacePatchSourceMetadataInputSchema>;

export const portableSpacePatchSourceRangeInputSchema = z.object({
  previewToken: z.string().min(1).max(128),
  selection: portableSpaceSubscriptionSelectionSchema,
  cleanupDeselected: z.boolean(),
  impactDigest: z.string().min(1).max(128).optional(),
  createBackup: z.boolean().default(true),
  ...portableSpaceBindingChoicesFields,
}).strict().superRefine((value, ctx) => {
  validateBindingChoices(value, ctx);
  if (value.cleanupDeselected && (value.impactDigest === undefined || value.impactDigest.length === 0)) {
    ctx.addIssue({ code: 'custom', path: ['impactDigest'], message: 'impactDigest is required when cleanupDeselected is true' });
  }
});
export type PortableSpacePatchSourceRangeInput = z.infer<typeof portableSpacePatchSourceRangeInputSchema>;

export const portableSpacePatchSourceInputSchema = z.union([
  portableSpacePatchSourceMetadataInputSchema,
  portableSpacePatchSourceRangeInputSchema,
]);
export type PortableSpacePatchSourceInput = z.infer<typeof portableSpacePatchSourceInputSchema>;

export const portableSpacePatchSourceResultSchema = z.object({
  source: portableSpaceCenterSourceSchema,
  impact: portableSpaceImpactSchema,
  backupPath: z.string().optional(),
}).strict();
export type PortableSpacePatchSourceResult = z.infer<typeof portableSpacePatchSourceResultSchema>;

export const portableSpaceReorderSourcesInputSchema = z.object({
  spaceId: portableSpaceSpaceIdSchema.default('main'),
  orderedIds: z.array(z.string().min(1).max(128)).max(512),
  expectedOrderRevision: z.string().min(1).max(128),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.orderedIds).size !== value.orderedIds.length) {
    ctx.addIssue({ code: 'custom', path: ['orderedIds'], message: 'orderedIds must not contain duplicates' });
  }
});
export type PortableSpaceReorderSourcesInput = z.infer<typeof portableSpaceReorderSourcesInputSchema>;

export const portableSpaceReorderSourcesResultSchema = z.object({
  orderedIds: z.array(z.string().min(1).max(128)),
  orderRevision: z.string().min(1).max(128),
}).strict();
export type PortableSpaceReorderSourcesResult = z.infer<typeof portableSpaceReorderSourcesResultSchema>;

export const portableSpaceRemovePreviewResultSchema = z.object({
  previewToken: z.string().min(1).max(128),
  expiresAt: z.string(),
  managedCount: z.number().int().nonnegative(),
  impact: portableSpaceImpactSchema,
  impactDigest: z.string().min(1).max(128),
}).strict();
export type PortableSpaceRemovePreviewResult = z.infer<typeof portableSpaceRemovePreviewResultSchema>;

export const portableSpaceRemoveReviewedInputSchema = z.object({
  previewToken: z.string().min(1).max(128),
  purgeManaged: z.boolean(),
  impactDigest: z.string().min(1).max(128),
  createBackup: z.boolean().default(true),
}).strict();
export type PortableSpaceRemoveReviewedInput = z.infer<typeof portableSpaceRemoveReviewedInputSchema>;

export const portableSpaceRemoveReviewedResponseSchema = z.object({
  removed: z.literal(true),
  impact: portableSpaceImpactSchema,
  backupPath: z.string().optional(),
}).strict();
export type PortableSpaceRemoveReviewedResponse = z.infer<typeof portableSpaceRemoveReviewedResponseSchema>;

export const portableSpaceViewQuerySchema = z.object({
  view: z.literal('center-v1').optional(),
}).strict();
export type PortableSpaceViewQuery = z.infer<typeof portableSpaceViewQuerySchema>;

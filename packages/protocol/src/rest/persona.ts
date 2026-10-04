import { z } from 'zod';

export const personaIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const optionalPersonaTextSchema = z.string().trim().min(1).optional();
const personaStringListSchema = z.array(z.string().trim().min(1)).optional();

export const personaMemorySchema = z.object({
  shared: z.array(z.enum(['global', 'workspace'])),
});

export const personaDefinitionSchema = z.object({
  id: personaIdSchema,
  name: z.string().trim().min(1),
  title: optionalPersonaTextSchema,
  job: optionalPersonaTextSchema,
  profile: optionalPersonaTextSchema,
  modelAlias: optionalPersonaTextSchema,
  thinkingEffort: optionalPersonaTextSchema,
  greeting: z.string().optional(),
  greetings: personaStringListSchema,
  roomGreeting: z.string().optional(),
  delivery: z.enum(['reply', 'message']).optional(),
  memory: personaMemorySchema.optional(),
  skills: personaStringListSchema,
  tags: personaStringListSchema,
  notes: z.string().optional(),
  homeWorkspace: optionalPersonaTextSchema,
  description: z.string().trim().min(1),
}).strict();
export type PersonaDefinition = z.infer<typeof personaDefinitionSchema>;

export const personaSnapshotSchema = z.object({
  definition: personaDefinitionSchema,
  revision: z.string().min(1),
  examples: z.string().optional(),
}).strict();
export type PersonaSnapshot = z.infer<typeof personaSnapshotSchema>;

/** How the face is framed; the image itself is always a square crop. */
export const personaAvatarShapeSchema = z.enum(['circle', 'square']);
export type PersonaAvatarShape = z.infer<typeof personaAvatarShapeSchema>;

export const personaSummarySchema = z.object({
  id: personaIdSchema,
  name: z.string().min(1),
  title: z.string().optional(),
  job: z.string().optional(),
  revision: z.string().min(1),
  archived: z.boolean(),
  homeSessionId: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  avatarMime: z.string().min(1).optional(),
  avatarShape: personaAvatarShapeSchema.optional(),
}).strict();
export type PersonaSummary = z.infer<typeof personaSummarySchema>;

export const personaPutInputSchema = z.object({
  definition: personaDefinitionSchema,
  revision: z.string().min(1).optional(),
  examples: z.string().optional(),
}).strict();
export type PersonaPutInput = z.infer<typeof personaPutInputSchema>;

const booleanQueryParam = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === 1 || value === true) return true;
  if (value === 'false' || value === '0' || value === 0 || value === false) return false;
  return value;
}, z.boolean().optional());

export const personaListQuerySchema = z.object({
  includeArchived: booleanQueryParam,
}).strict();
export type PersonaListQuery = z.infer<typeof personaListQuerySchema>;

export const personaIdParamsSchema = z.object({ id: personaIdSchema });
export type PersonaIdParams = z.infer<typeof personaIdParamsSchema>;

export const personaDuplicateInputSchema = z.object({
  id: personaIdSchema.optional(),
  name: z.string().trim().min(1).optional(),
}).strict();
export type PersonaDuplicateInput = z.infer<typeof personaDuplicateInputSchema>;

export const personaArchiveInputSchema = z.object({
  archived: z.boolean(),
}).strict();
export type PersonaArchiveInput = z.infer<typeof personaArchiveInputSchema>;

export const personaHomeInputSchema = z.object({ sessionId: z.string().min(1) }).strict();
export type PersonaHomeInput = z.infer<typeof personaHomeInputSchema>;
export const personaHomeResponseSchema = z.object({ homeSessionId: z.string().min(1) }).strict();
export const personaStateUpdateSchema = z.object({ pinned: z.boolean().optional(), hidden: z.boolean().optional() }).strict();
export type PersonaStateUpdate = z.infer<typeof personaStateUpdateSchema>;

export const personaStateSchema = z.object({
  version: z.literal(1),
  archived: z.boolean(),
  homeSessionId: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  pausedCronTasks: z.array(z.object({ workspaceId: z.string(), taskId: z.string(), wasPaused: z.boolean() }).strict()).optional(),
}).strict();
export type PersonaState = z.infer<typeof personaStateSchema>;

export const personaMutationResponseSchema = z.object({
  id: personaIdSchema,
  revision: z.string().min(1),
}).strict();
export type PersonaMutationResponse = z.infer<typeof personaMutationResponseSchema>;

export const personaMemoryIntegrationSchema = z.object({
  status: z.enum(['committed', 'pending', 'failed']),
  count: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}).strict();
export type PersonaMemoryIntegration = z.infer<typeof personaMemoryIntegrationSchema>;

export const personaDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  memory: z.object({
    status: z.enum(['committed', 'pending', 'failed']),
    error: z.string().optional(),
  }).strict(),
}).strict();
export type PersonaDeleteResponse = z.infer<typeof personaDeleteResponseSchema>;

export const personaDeleteQuerySchema = z.object({
  expectedRevision: z.string().min(1).optional(),
}).strict();
export type PersonaDeleteQuery = z.infer<typeof personaDeleteQuerySchema>;

export const personaCardFormatSchema = z.enum(['png', 'json', 'charx']);
export type PersonaCardFormat = z.infer<typeof personaCardFormatSchema>;

export const personaImportPayloadSchema = z.object({
  data: z.string().min(1),
  format: personaCardFormatSchema,
  filename: z.string().trim().min(1).optional(),
}).strict();
export type PersonaImportPayload = z.infer<typeof personaImportPayloadSchema>;

export const personaImportConfirmInputSchema = z.object({
  id: personaIdSchema.optional(),
  name: z.string().trim().min(1).optional(),
}).strict();
export type PersonaImportConfirmInput = z.infer<typeof personaImportConfirmInputSchema>;

export const personaImportMemoryEntrySchema = z.object({
  title: z.string(),
  body: z.string(),
  pinned: z.boolean(),
  type: z.literal('reference'),
}).strict();
export type PersonaImportMemoryEntry = z.infer<typeof personaImportMemoryEntrySchema>;

export const personaImportPreviewSchema = z.object({
  format: personaCardFormatSchema,
  definition: personaDefinitionSchema,
  examples: z.string().optional(),
  avatar: z.object({
    data: z.string().min(1),
    mimeType: z.string().min(1),
  }).strict().optional(),
  avatarMimeType: z.string().min(1).optional(),
  memoryEntries: z.array(personaImportMemoryEntrySchema),
  ignoredFields: z.array(z.string()),
  extensions: z.unknown().optional(),
}).strict();
export type PersonaImportPreview = z.infer<typeof personaImportPreviewSchema>;

export const personaImportResponseSchema = z.object({
  snapshot: personaSnapshotSchema,
  memory: z.object({
    status: z.enum(['committed', 'pending', 'failed']),
    count: z.number().int().nonnegative(),
    error: z.string().optional(),
  }).strict(),
}).strict();
export type PersonaImportResponse = z.infer<typeof personaImportResponseSchema>;

export const personaAvatarUploadResponseSchema = z.object({
  id: personaIdSchema,
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  shape: personaAvatarShapeSchema.optional(),
}).strict();
export type PersonaAvatarUploadResponse = z.infer<typeof personaAvatarUploadResponseSchema>;

export const personaAvatarDeleteResponseSchema = z.object({
  id: personaIdSchema,
  deleted: z.boolean(),
}).strict();
export type PersonaAvatarDeleteResponse = z.infer<typeof personaAvatarDeleteResponseSchema>;

export const personaAvatarDataSchema = z.object({
  id: personaIdSchema,
  name: z.string().min(1),
  avatarUrl: z.string().min(1).optional(),
  avatarShape: personaAvatarShapeSchema.optional(),
}).strict();
export type PersonaAvatarData = z.infer<typeof personaAvatarDataSchema>;
export type PersonaAvatar = PersonaAvatarData;

export const personaExportQuerySchema = z.object({
  format: personaCardFormatSchema.default('json'),
  includeMemory: booleanQueryParam,
}).strict();
export type PersonaExportQuery = z.infer<typeof personaExportQuerySchema>;

export const personaExportResponseSchema = z.object({
  format: personaCardFormatSchema,
  data: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
}).strict();
export type PersonaExportResponse = z.infer<typeof personaExportResponseSchema>;

export const PERSONA_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

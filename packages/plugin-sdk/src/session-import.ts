import { z } from 'zod';

export const sessionSourceDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(100),
  formatVersion: z.string().min(1).max(100),
}).strict();
export const importSelectionSchema = z.object({
  pluginId: z.string().min(1).max(64), sourceId: z.string().min(1).max(64),
  home: z.string().min(1).max(4096), externalId: z.string().min(1).max(4096),
}).strict();
export const importLossSchema = z.object({ code: z.string().max(100), count: z.number().int().nonnegative(), detail: z.string().max(200) }).strict();
export const importRecordSchema = z.object({
  id: z.string().min(1).max(200), part: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'system', 'tool', 'tool_call', 'metadata']),
  text: z.string().max(48 * 1024), timestamp: z.string().max(100).optional(),
  toolName: z.string().max(200).optional(), toolCallId: z.string().max(200).optional(),
  textOffset: z.number().int().nonnegative().optional(), textTotal: z.number().int().nonnegative().optional(),
}).strict();
export const importProbeSchema = z.object({
  revision: z.string().min(1).max(200), title: z.string().max(500),
  formatVersion: z.string().max(100), status: z.enum(['preserved', 'partial', 'unsupported']),
  losses: z.array(importLossSchema).max(100), totalBytes: z.number().int().nonnegative(),
  sourceHome: z.string().min(1).max(4096),
}).strict();
export const importParsePageSchema = z.object({
  records: z.array(importRecordSchema).max(64), cursor: z.string().max(8192).nullable(),
  losses: z.array(importLossSchema).max(100), bytesRead: z.number().int().nonnegative(),
}).strict();
export const importSourceSchema = sessionSourceDefinitionSchema.extend({ pluginId: z.string() });
export const importDiscoveryInputSchema = importSelectionSchema.omit({ externalId: true }).extend({ cursor: z.string().max(8192).optional() });
export const importDiscoveryPageSchema = z.object({
  entries: z.array(z.object({ externalId: z.string().max(4096), title: z.string().max(500) }).strict()).max(100),
  cursor: z.string().max(8192).nullable(),
}).strict();
export const importDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('archive') }).strict(),
  z.object({ kind: z.literal('native-session'), workDir: z.string().min(1).max(4096) }).strict(),
]);
export const importPreviewInputSchema = importSelectionSchema.extend({ destination: importDestinationSchema.optional() });
export const importPreviewSchema = z.object({
  destination: importDestinationSchema.optional(), existingSessionId: z.string().nullable().optional(),
  schemaVersion: z.literal(1), id: z.string(), selection: importSelectionSchema,
  targetHome: z.string(), probe: importProbeSchema, records: z.array(importRecordSchema).max(64),
  losses: z.array(importLossSchema).max(100), coverage: z.enum(['sample', 'complete']),
  existingArchiveId: z.string().nullable(), existingRevision: z.string().nullable(), createdAt: z.number(),
}).strict();
export const importJobSchema = z.object({
  destination: importDestinationSchema.optional(), sessionId: z.string().nullable().optional(), sessionPath: z.string().nullable().optional(),
  schemaVersion: z.literal(1), id: z.string(), previewId: z.string(), selection: importSelectionSchema,
  sourceHome: z.string(), targetHome: z.string(), revision: z.string(), title: z.string(), formatVersion: z.string(),
  status: z.enum(['queued', 'running', 'cancelled', 'failed', 'interrupted', 'completed']),
  createdAt: z.number(), updatedAt: z.number(), records: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(), bytesRead: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  cursor: z.string().nullable(), parsed: z.boolean(), losses: z.array(importLossSchema).max(100),
  archiveId: z.string().nullable(), error: z.string().max(2000).nullable(),
}).strict();
export const importArchiveSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), pluginId: z.string(), sourceId: z.string(),
  sourceHome: z.string(), externalId: z.string(), targetHome: z.string(), title: z.string(),
  revision: z.string(), formatVersion: z.string(), createdAt: z.number(), updatedAt: z.number(),
  status: z.enum(['preserved', 'partial']), losses: z.array(importLossSchema).max(100),
  records: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), jobId: z.string(),
  previousJobIds: z.array(z.string()),
}).strict();
export const importListInputSchema = z.object({ cursor: z.string().max(8192).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const importArchiveQuerySchema = importListInputSchema.extend({ query: z.string().max(500).optional() });
export const importReadInputSchema = importListInputSchema.extend({ archiveId: z.string().min(1) });
export const importReadPageSchema = z.object({ archive: importArchiveSchema, records: z.array(importRecordSchema).max(64), cursor: z.string().nullable() }).strict();
export const importStoredPageSchema = z.object({ schemaVersion: z.literal(1), page: importParsePageSchema, recordsBefore: z.number().int().nonnegative() }).strict();
export const importStartInputSchema = z.object({ previewId: z.string().min(1), acknowledge: z.literal(true) }).strict();
export type SessionSourceDefinition = z.infer<typeof sessionSourceDefinitionSchema>;
export type ImportSelection = z.infer<typeof importSelectionSchema>;
export type ImportDestination = z.infer<typeof importDestinationSchema>;
export type ImportPreviewInput = z.infer<typeof importPreviewInputSchema>;
export type ImportProbe = z.infer<typeof importProbeSchema>;
export type ImportRecord = z.infer<typeof importRecordSchema>;
export type ImportLoss = z.infer<typeof importLossSchema>;
export type ImportParsePage = z.infer<typeof importParsePageSchema>;
export type ImportDiscoveryInput = z.infer<typeof importDiscoveryInputSchema>;
export type ImportDiscoveryPage = z.infer<typeof importDiscoveryPageSchema>;
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export type ImportJob = z.infer<typeof importJobSchema>;
export type ImportArchive = z.infer<typeof importArchiveSchema>;
export type ImportSource = z.infer<typeof importSourceSchema>;
export type ImportListInput = z.infer<typeof importListInputSchema>;
export type ImportArchiveQuery = z.infer<typeof importArchiveQuerySchema>;
export type ImportReadInput = z.infer<typeof importReadInputSchema>;
export type ImportReadPage = z.infer<typeof importReadPageSchema>;
export type ImportStartInput = z.infer<typeof importStartInputSchema>;

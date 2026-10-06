import { z } from 'zod';

export const documentPreviewSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspace'),
    path: z.string().min(1).max(4096),
    runtime_id: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    kind: z.literal('session-media'),
    file_id: z.string().min(1).max(512),
    media_type: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(512).optional(),
  }).strict(),
]);
export type DocumentPreviewSource = z.infer<typeof documentPreviewSourceSchema>;

export const documentPreviewRequestSchema = z.object({
  source: documentPreviewSourceSchema,
  page: z.number().int().min(1).optional(),
  sheet: z.string().min(1).max(256).optional(),
  range: z.string().min(1).max(512).optional(),
  offset: z.number().int().nonnegative().optional(),
  max_bytes: z.number().int().min(1024).max(1024 * 1024).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.sheet !== undefined && value.page !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['page'], message: 'page and sheet are mutually exclusive' });
  }
  if (value.range !== undefined && value.sheet === undefined) {
    ctx.addIssue({ code: 'custom', path: ['range'], message: 'range requires sheet' });
  }
});
export type DocumentPreviewRequest = z.infer<typeof documentPreviewRequestSchema>;

export const documentPreviewAssetSchema = z.object({
  asset_id: z.string().min(1),
  mime: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  url: z.string().min(1),
}).strict();
export type DocumentPreviewAsset = z.infer<typeof documentPreviewAssetSchema>;

const documentPreviewSourceInfoSchema = z.object({
  kind: z.enum(['workspace', 'session-media']),
  name: z.string().min(1),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
}).strict();

export const documentPreviewNavigationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page'),
    page: z.number().int().positive(),
    page_count: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    kind: z.literal('sheet'),
    sheet: z.string().min(1).optional(),
    sheets: z.array(z.string().min(1)).optional(),
    sheet_index: z.number().int().positive().optional(),
    sheet_count: z.number().int().positive().optional(),
  }).strict(),
]);
export type DocumentPreviewNavigation = z.infer<typeof documentPreviewNavigationSchema>;

export const documentPreviewReadySchema = z.object({
  kind: z.literal('ready'),
  format: z.enum(['pdf', 'docx', 'xlsx', 'pptx']),
  fidelity: z.literal('rendered'),
  renderer: z.enum(['browser-pdf', 'poppler', 'officecli']),
  source: documentPreviewSourceInfoSchema,
  navigation: documentPreviewNavigationSchema,
  assets: z.array(documentPreviewAssetSchema).min(1).max(8),
  read_only: z.literal(true),
}).strict();

export const documentPreviewTextSchema = z.object({
  kind: z.literal('text'),
  format: z.enum(['text', 'csv']),
  fidelity: z.literal('source'),
  source: documentPreviewSourceInfoSchema,
  encoding: z.literal('utf-8'),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
  total_bytes: z.number().int().nonnegative(),
  read_only: z.literal(true),
}).strict();

export const documentPreviewUnsupportedSchema = z.object({
  kind: z.literal('unsupported'),
  format: z.string().min(1),
  source: documentPreviewSourceInfoSchema,
  reason: z.enum(['format', 'source_too_large', 'remote_renderer_unavailable', 'binary_content']),
  recovery: z.object({ kind: z.literal('download-original') }).strict().optional(),
  read_only: z.literal(true),
}).strict();

export const documentPreviewMissingDependencySchema = z.object({
  kind: z.literal('missing_dependency'),
  dependency: z.literal('officecli'),
  source: documentPreviewSourceInfoSchema,
  message: z.string().min(1),
  recovery: z.object({
    kind: z.literal('install-prerequisite'),
    plugin_id: z.literal('kiki-office'),
    prerequisite_id: z.literal('officecli'),
    consent_required: z.literal(true),
    plugin_state: z.enum(['not-installed', 'disabled', 'enabled']),
  }).strict(),
  read_only: z.literal(true),
}).strict();

export const documentPreviewResponseSchema = z.discriminatedUnion('kind', [
  documentPreviewReadySchema,
  documentPreviewTextSchema,
  documentPreviewUnsupportedSchema,
  documentPreviewMissingDependencySchema,
]);
export type DocumentPreviewResponse = z.infer<typeof documentPreviewResponseSchema>;

export const documentPreviewAssetParamsSchema = z.object({
  session_id: z.string().min(1),
  asset_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict();

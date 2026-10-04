import { z } from 'zod';

const json = z.record(z.string(), z.unknown());
export const mediaKindSchema = z.enum(['image', 'video', 'tts']);
export const mediaInputRefSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ file_id: z.string().min(1) }).strict(),
  z.object({ url: z.url() }).strict(),
]);
export const mediaRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), prompt: z.string().min(1), images: z.array(mediaInputRefSchema).optional(), mask: mediaInputRefSchema.optional(), count: z.number().int().positive().optional(), size: z.string().optional(), aspect_ratio: z.string().optional(), format: z.string().optional(), options: json.optional() }).strict(),
  z.object({ kind: z.literal('video'), prompt: z.string().min(1), inputs: z.array(z.object({ ref: mediaInputRefSchema, role: z.enum(['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']) }).strict()).optional(), duration_seconds: z.number().positive().optional(), aspect_ratio: z.string().optional(), resolution: z.string().optional(), options: json.optional() }).strict(),
  z.object({ kind: z.literal('tts'), text: z.string().min(1), voice: z.string().min(1), language: z.string().optional(), format: z.string().optional(), sample_rate_hz: z.number().int().positive().optional(), options: json.optional() }).strict(),
]);
export const mediaGenerateInputSchema = z.object({ request_id: z.string().min(1).max(200).optional(), provider: z.string().min(1).optional(), model: z.string().optional(), execution: z.enum(['auto', 'background']).default('auto'), request: mediaRequestSchema }).strict();
export const mediaProviderDefinitionSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), kinds: z.array(mediaKindSchema).min(1), label: z.string().min(1), resumeVersion: z.number().int().positive(), connectionSetting: z.string().min(1).optional() }).strict();
export const mediaHandleSchema = z.object({ version: z.number().int().positive(), data: json }).strict();
export const mediaArtifactDraftSchema = z.object({ path: z.string().min(1), name: z.string().min(1), mime: z.string().min(1), kind: z.enum(['image', 'video', 'audio', 'file']), role: z.enum(['original', 'preview', 'subtitle']), complete: z.boolean(), metadata: json.optional() }).strict();
export const mediaProviderErrorSchema = z.object({ code: z.string().min(1), message: z.string(), submission: z.enum(['not_sent', 'rejected', 'unknown', 'accepted']), retryAfterMs: z.number().nonnegative().optional(), items: z.array(z.object({ item: z.string(), code: z.string(), message: z.string() }).strict()).optional() }).strict();
const outcomeFields = { artifacts: z.array(mediaArtifactDraftSchema).default([]), effective: json.optional(), usage: json.optional(), warnings: z.array(z.string()).optional() };
export const mediaOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('complete'), ...outcomeFields }).strict(),
  z.object({ state: z.literal('pending'), handle: mediaHandleSchema, phase: z.enum(['generation', 'download']), retryAfterMs: z.number().nonnegative().optional(), ...outcomeFields }).strict(),
  z.object({ state: z.literal('failed'), error: mediaProviderErrorSchema, ...outcomeFields }).strict(),
]);
export const mediaCapabilityQuerySchema = z.object({ provider: z.string().optional(), kind: mediaKindSchema.optional(), model: z.string().optional(), cursor: z.string().optional() }).strict();
export const mediaVoiceQuerySchema = z.object({ provider: z.string().min(1), model: z.string().optional(), language: z.string().optional(), cursor: z.string().optional() }).strict();
export const mediaCapabilitiesSchema = z.object({ models: z.array(z.object({ id: z.string(), kind: mediaKindSchema, label: z.string().optional() }).passthrough()), cursor: z.string().nullable().optional(), constraints: z.array(z.string()).optional(), optionsSchema: json.optional(), skill_refs: z.array(z.object({ name: z.string(), path: z.string(), when: z.string() }).strict()).optional() }).passthrough();
export const mediaVoicePageSchema = z.object({ voices: z.array(z.object({ id: z.string(), label: z.string().optional(), languages: z.array(z.string()).optional() }).passthrough()), cursor: z.string().nullable().optional() }).passthrough();
export const mediaCancelOutcomeSchema = z.object({ remote: z.enum(['cancelled', 'requested', 'unsupported']), billing: z.enum(['unknown', 'provider_reported']), message: z.string().optional() }).strict();
export const mediaArtifactSchema = mediaArtifactDraftSchema.omit({ path: true }).extend({ id: z.string(), file_id: z.string(), bytes: z.number().int().nonnegative() });
export const mediaJobSchema = z.object({ schemaVersion: z.literal(1), job_id: z.string(), request_id: z.string(), owner_session_id: z.string(), owner_agent_id: z.string(), provider: z.string(), model: z.string().optional(), task_id: z.string().optional(), state: z.enum(['running', 'pending', 'succeeded', 'partial', 'failed', 'unknown', 'stopped']), phase: z.enum(['submit', 'generation', 'download']), can_resume: z.boolean(), blocked_reason: z.string().optional(), artifacts: z.array(mediaArtifactSchema), effective: json.optional(), usage: json.optional(), warnings: z.array(z.string()).optional(), error: mediaProviderErrorSchema.optional(), cancellation: mediaCancelOutcomeSchema.optional(), created_at: z.number(), updated_at: z.number() }).strict();
export const mediaActionSchema = z.discriminatedUnion('action', [
  mediaCapabilityQuerySchema.extend({ action: z.literal('capabilities') }),
  mediaVoiceQuerySchema.extend({ action: z.literal('voices') }),
  ...(['get', 'cancel', 'resume'] as const).map((action) => z.object({ action: z.literal(action), job_id: z.string().min(1) }).strict()),
]);
export const mediaSourceSchema = z.object({ id: z.string().min(1).max(100), url: z.string().min(1).max(4096), enabled: z.boolean() }).strict();
export const mediaSourcesInputSchema = z.object({ sources: z.array(mediaSourceSchema).max(1000) }).strict().refine((value) => new Set(value.sources.map((item) => item.id)).size === value.sources.length, 'Duplicate source id');
export const mediaProvidersSchema = z.array(z.object({ provider: z.string(), definition: mediaProviderDefinitionSchema }).strict());
export const mediaJobsInputSchema = z.object({ session_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict();
export const mediaCatalogSchema = z.object({ source: z.string(), version: z.string().optional(), plugins: z.array(z.object({ id: z.string(), displayName: z.string(), source: z.string(), version: z.string().optional(), description: z.string().optional(), homepage: z.string().optional(), icon: z.string().optional(), keywords: z.array(z.string()).optional(), tier: z.enum(['official', 'curated']).optional(), builtIn: z.boolean().optional() }).passthrough()) }).strict();
export type MediaSource = z.infer<typeof mediaSourceSchema>;
export type MediaCatalog = z.infer<typeof mediaCatalogSchema>;
export type MediaKind = z.infer<typeof mediaKindSchema>;
export type MediaInputRef = z.infer<typeof mediaInputRefSchema>;
export type MediaRequest = z.infer<typeof mediaRequestSchema>;
export type MediaGenerateInput = z.input<typeof mediaGenerateInputSchema>;
export type MediaProviderDefinition = z.infer<typeof mediaProviderDefinitionSchema>;
export type MediaHandle = z.infer<typeof mediaHandleSchema>;
export type MediaArtifactDraft = z.input<typeof mediaArtifactDraftSchema>;
export type MediaProviderError = z.infer<typeof mediaProviderErrorSchema>;
export type MediaOutcome = z.input<typeof mediaOutcomeSchema>;
export type MediaCapabilityQuery = z.infer<typeof mediaCapabilityQuerySchema>;
export type MediaVoiceQuery = z.infer<typeof mediaVoiceQuerySchema>;
export type MediaCapabilities = z.infer<typeof mediaCapabilitiesSchema>;
export type MediaVoicePage = z.infer<typeof mediaVoicePageSchema>;
export type MediaCancelOutcome = z.infer<typeof mediaCancelOutcomeSchema>;
export type MediaJob = z.infer<typeof mediaJobSchema>;
export type MediaAction = z.infer<typeof mediaActionSchema>;
export interface MediaProviderRequest { readonly request: MediaRequest; readonly model?: string }
export interface MediaConnection {
  readonly id: string;
  readonly type?: string;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authentication: 'api-key' | 'oauth' | 'none';
}
/** Context is bound to this provider only. Staging files do not cross JSON-RPC. Trusted plugins are not sandboxed. */
export interface MediaProviderContext {
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly jobId: string;
  readonly stagingDir: string;
  /** Resolves only the connection selected in this provider's declared connectionSetting; OAuth refresh stays in Kiki. Never persist these headers. */
  connection(): Promise<MediaConnection | undefined>;
  progress(update: { kind: 'progress' | 'status' | 'stdout' | 'stderr'; text?: string; percent?: number }): void;
}
export interface MediaProviderAdapter {
  describe(query: MediaCapabilityQuery, context: MediaProviderContext): Promise<MediaCapabilities>;
  submit(input: MediaProviderRequest, context: MediaProviderContext): Promise<MediaOutcome>;
  poll?(handle: MediaHandle, context: MediaProviderContext): Promise<MediaOutcome>;
  cancel?(handle: MediaHandle, context: MediaProviderContext): Promise<MediaCancelOutcome>;
  voices?(query: MediaVoiceQuery, context: MediaProviderContext): Promise<MediaVoicePage>;
}
/** Session and agent ownership are supplied by the host, never tool arguments. Resume never submits. */
export interface PluginMediaApi {
  generate(input: MediaGenerateInput): Promise<MediaJob>;
  media(input: MediaAction): Promise<MediaJob | MediaCapabilities | MediaVoicePage | { providers: readonly { provider: string; definition: MediaProviderDefinition }[] }>;
}

import { z } from 'zod';

import {
  requestIdentityPresetSchema,
  requestIdentityProfileIdSchema,
  requestIdentityPolicySchema,
  requestIdentityOverridesSchema,
} from '../modelCatalog';

/**
 * Request identity catalog: named identity profiles (the client a request presents itself as),
 * upstream client release tracks that feed their version and templates, and what the last
 * requests actually sent. Values are shown verbatim; credentials never enter this surface.
 */

export const requestIdentityTrackIdSchema = z.enum(['codex_cli', 'claude_code', 'grok_cli', 'opencode_cli']);
export type RequestIdentityTrackId = z.infer<typeof requestIdentityTrackIdSchema>;

export const requestIdentityUpdateSourceSchema = z.enum(['npm', 'local_cli', 'manifest']);
export type RequestIdentityUpdateSource = z.infer<typeof requestIdentityUpdateSourceSchema>;

/** Where a track's current value came from: the value shipped with Kiki, or an applied update. */
export const requestIdentityRevisionOriginSchema = z.enum(['builtin', 'npm', 'local_cli', 'manifest', 'manual']);
export type RequestIdentityRevisionOrigin = z.infer<typeof requestIdentityRevisionOriginSchema>;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const NO_CONTROL = /^[^\u0000-\u001F\u007F]*$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;

export const requestIdentityVersionSchema = z.string().regex(VERSION);

export const requestIdentityTemplateSchema = z.string().max(1024).regex(NO_CONTROL);

/** A header template. An empty value removes a header the base identity would otherwise send. */
export const requestIdentityHeaderSchema = z.object({
  name: z.string().regex(HEADER_NAME),
  value: requestIdentityTemplateSchema,
}).strict();
export type RequestIdentityHeader = z.infer<typeof requestIdentityHeaderSchema>;

/** A top-level request-body field; string values are templates. */
export const requestIdentityParamSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u),
  value: z.union([requestIdentityTemplateSchema, z.number().finite(), z.boolean()]),
}).strict();
export type RequestIdentityParam = z.infer<typeof requestIdentityParamSchema>;

/** Version the profile renders into `{version}`. */
export const requestIdentityVersionModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('kiki') }).strict(),
  z.object({ mode: z.literal('track') }).strict(),
  z.object({ mode: z.literal('fixed'), value: requestIdentityVersionSchema }).strict(),
]);
export type RequestIdentityVersionMode = z.infer<typeof requestIdentityVersionModeSchema>;

/** The editable part of a profile; also the create/update body for custom profiles. */
export const requestIdentityProfileDraftSchema = z.object({
  label: z.string().trim().min(1).max(64),
  description: z.string().max(280).optional(),
  base_preset: requestIdentityPresetSchema,
  overrides: requestIdentityOverridesSchema.optional(),
  track: requestIdentityTrackIdSchema.nullable(),
  version: requestIdentityVersionModeSchema,
  /** Empty keeps the base identity's native User-Agent. */
  user_agent: requestIdentityTemplateSchema,
  headers: z.array(requestIdentityHeaderSchema).max(64),
  params: z.array(requestIdentityParamSchema).max(32),
}).strict();
export type RequestIdentityProfileDraft = z.infer<typeof requestIdentityProfileDraftSchema>;

export const requestIdentityProfileSchema = requestIdentityProfileDraftSchema.extend({
  id: requestIdentityProfileIdSchema,
  builtin: z.boolean(),
  /** Custom profiles only: the profile it was duplicated from. */
  duplicated_from: requestIdentityProfileIdSchema.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).strict();
export type RequestIdentityProfile = z.infer<typeof requestIdentityProfileSchema>;

/** One value a track can carry: the client version plus optional template replacements. */
export const requestIdentityTrackRevisionSchema = z.object({
  version: requestIdentityVersionSchema,
  user_agent: requestIdentityTemplateSchema.optional(),
  headers: z.array(requestIdentityHeaderSchema).max(64).optional(),
  origin: requestIdentityRevisionOriginSchema,
  /** npm package, CLI command, or manifest URL the value was read from. */
  source_detail: z.string().max(512).optional(),
  at: z.string(),
}).strict();
export type RequestIdentityTrackRevision = z.infer<typeof requestIdentityTrackRevisionSchema>;

export const requestIdentityTrackCheckSchema = z.object({
  source: requestIdentityUpdateSourceSchema,
  at: z.string(),
  ok: z.boolean(),
  version: z.string().optional(),
  error: z.string().max(512).optional(),
}).strict();
export type RequestIdentityTrackCheck = z.infer<typeof requestIdentityTrackCheckSchema>;

export const requestIdentityTrackSchema = z.object({
  id: requestIdentityTrackIdSchema,
  /** Upstream client this track follows, e.g. `@openai/codex`. */
  npm_package: z.string(),
  cli_command: z.string(),
  current: requestIdentityTrackRevisionSchema,
  builtin: requestIdentityTrackRevisionSchema,
  /** A checked value waiting for explicit apply; never used by requests. */
  candidate: requestIdentityTrackRevisionSchema.nullable(),
  /** Newest first; rollback restores the first entry. */
  history: z.array(requestIdentityTrackRevisionSchema),
  pinned: z.boolean(),
  last_check: requestIdentityTrackCheckSchema.nullable(),
}).strict();
export type RequestIdentityTrack = z.infer<typeof requestIdentityTrackSchema>;

/** Where one layer of the identity chain points; `inherit` when the layer is unset. */
export const requestIdentityUsageSchema = z.object({
  scope: z.enum(['global', 'provider', 'model']),
  provider_id: z.string().optional(),
  model_id: z.string().optional(),
  label: z.string(),
  /** The layer as authored, absent when it inherits. */
  authored: requestIdentityPolicySchema.optional(),
  effective_profile: z.string().nullable(),
  effective_preset: requestIdentityPresetSchema.nullable(),
  error: z.string().optional(),
}).strict();
export type RequestIdentityUsage = z.infer<typeof requestIdentityUsageSchema>;

export const requestIdentityObservationSchema = z.object({
  at: z.string(),
  provider_id: z.string(),
  model: z.string(),
  protocol: z.string(),
  profile: z.string(),
  preset: requestIdentityPresetSchema,
  session_id: z.string(),
  agent_id: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  cache_key: z.string().optional(),
  suppressed_user_agent: z.boolean(),
}).strict();
export type RequestIdentityObservation = z.infer<typeof requestIdentityObservationSchema>;

export const requestIdentityCatalogSchema = z.object({
  profiles: z.array(requestIdentityProfileSchema),
  tracks: z.array(requestIdentityTrackSchema),
  manifest_url: z.string().nullable(),
  usage: z.array(requestIdentityUsageSchema),
  observations: z.array(requestIdentityObservationSchema),
}).strict();
export type RequestIdentityCatalog = z.infer<typeof requestIdentityCatalogSchema>;

export const requestIdentityPreviewRequestSchema = z.object({
  profile: requestIdentityProfileIdSchema.optional(),
  /** Render an unsaved draft instead of a stored profile. */
  draft: requestIdentityProfileDraftSchema.optional(),
  protocol: z.enum(['anthropic', 'openai', 'openai_responses', 'google-genai']),
  model: z.string().min(1).max(256).default('example-model'),
}).strict().refine((body) => (body.profile === undefined) !== (body.draft === undefined), {
  message: 'preview needs exactly one of profile or draft',
});
export type RequestIdentityPreviewRequest = z.input<typeof requestIdentityPreviewRequestSchema>;

export const requestIdentityPreviewSchema = z.object({
  headers: z.array(z.object({
    name: z.string(),
    value: z.string(),
    /** `per_request` values are regenerated for every session/turn; the preview shows a sample. */
    kind: z.enum(['static', 'per_request']),
    origin: z.enum(['profile', 'lineage']),
  }).strict()),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  version: z.string(),
  version_origin: z.string(),
  suppressed_user_agent: z.boolean(),
  error: z.string().optional(),
}).strict();
export type RequestIdentityPreview = z.infer<typeof requestIdentityPreviewSchema>;

export const requestIdentityCreateProfileSchema = z.object({
  from: requestIdentityProfileIdSchema,
  label: z.string().trim().min(1).max(64).optional(),
}).strict();

export const requestIdentityTrackCheckRequestSchema = z.object({
  source: requestIdentityUpdateSourceSchema,
}).strict();

export const requestIdentityTrackApplyRequestSchema = z.object({
  /** Must equal the candidate version, so a stale page cannot apply a newer check. */
  version: requestIdentityVersionSchema,
}).strict();

export const requestIdentityTrackPinRequestSchema = z.object({ pinned: z.boolean() }).strict();

export const requestIdentityManifestRequestSchema = z.object({
  url: z.string().url().max(2048).refine((url) => url.startsWith('https://'), { message: 'manifest URL must use https' }).nullable(),
}).strict();

/** Remote manifest document shape; unknown fields are rejected. */
export const requestIdentityManifestSchema = z.object({
  schema: z.literal(1),
  tracks: z.partialRecord(requestIdentityTrackIdSchema, z.object({
    version: requestIdentityVersionSchema,
    user_agent: requestIdentityTemplateSchema.optional(),
    headers: z.array(requestIdentityHeaderSchema).max(64).optional(),
  }).strict()),
}).strict();
export type RequestIdentityManifest = z.infer<typeof requestIdentityManifestSchema>;

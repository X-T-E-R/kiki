import { z } from 'zod';
import { pluginImDiagnosticCodeSchema, PLUGIN_IM_DIAGNOSTIC_LIMITS } from '@kiki/plugin-sdk/im';

export const builtinImProviderKindSchema = z.enum(['telegram', 'feishu_app', 'onebot_v11', 'wechat_bridge', 'discord', 'slack', 'matrix']);
export const pluginImProviderKindSchema = z.string().regex(/^plugin:[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/).transform((value) => value as `plugin:${string}/${string}`);
export const imProviderKindSchema = z.union([builtinImProviderKindSchema, pluginImProviderKindSchema]);
export type ImProviderKind = z.infer<typeof imProviderKindSchema>;

/**
 * Session-bridge allowance. This is not an install CapabilityId.
 * A later composer can AND `allowed` with another policy; `sessionEnabled`
 * overrides only the binding it is set on.
 */
export interface ImSessionAllowance {
  readonly allowed: boolean;
  readonly defaultEnabled: boolean;
  readonly sessionEnabled?: boolean;
}

export function imSessionAdmitted(input: ImSessionAllowance): boolean {
  if (!input.allowed) return false;
  return input.sessionEnabled ?? input.defaultEnabled;
}

export const imPolicySchema = z.object({
  allowed: z.boolean(),
  default_enabled: z.boolean(),
  allow_channel_borrowing: z.boolean().optional(),
}).strict();
export type ImPolicy = z.infer<typeof imPolicySchema>;

export const imIdentitySchema = z.object({
  chat_id: z.string().min(1),
  sender_id: z.string().min(1),
  topic_id: z.string().min(1),
  chat_kind: z.enum(['private', 'group']).optional(),
  chat_title: z.string().optional(),
  sender_name: z.string().optional(),
  topic_title: z.string().optional(),
}).strict();
export type ImIdentity = z.infer<typeof imIdentitySchema>;

export const imMessageMetadataSchema = z.object({
  provider_kind: imProviderKindSchema,
  provider_instance_id: z.string().min(1),
  account_id: z.string().min(1),
  identity: imIdentitySchema,
  source_message_id: z.string().min(1).optional(),
  mentioned: z.boolean().optional(),
  mention_ids: z.array(z.string().min(1)).optional(),
  reply_to_message_id: z.string().min(1).optional(),
  is_self: z.boolean().optional(),
  timestamp: z.number().int().nonnegative().optional(),
  context: z.object({
    order: z.literal('chronological'),
    coverage: z.enum(['received_only', 'retention_limited']),
    truncated: z.boolean(),
    messages: z.array(z.object({
      sequence: z.number().int().positive(),
      source_message_id: z.string().optional(),
      identity: imIdentitySchema,
      text: z.string().max(16_384),
      operation: z.enum(['create', 'edit', 'retract']),
      is_self: z.boolean().optional(),
      timestamp: z.number().int().nonnegative().optional(),
      mention_ids: z.array(z.string()).optional(),
      reply_to_message_id: z.string().optional(),
      media: z.array(z.object({ kind: z.string(), name: z.string(), media_type: z.string(), available: z.boolean() }).strict()).max(4).optional(),
    }).strict()).max(50),
  }).strict().optional(),
}).strict();
export type ImMessageMetadata = z.infer<typeof imMessageMetadataSchema>;
export const imBindingScopeSchema = z.enum(['sender', 'topic', 'chat']);
export const imGroupPolicySchema = z.object({
  wake: z.enum(['always', 'mention_or_reply', 'manual']),
  prefixes: z.array(z.string().min(1).max(128)).max(16).optional(),
}).strict();
export type ImGroupPolicy = z.infer<typeof imGroupPolicySchema>;

export const imDiscoverySchema = z.object({
  id: z.string().min(1),
  provider_instance_id: z.string().min(1),
  provider_kind: imProviderKindSchema,
  account_id: z.string().min(1),
  identity: imIdentitySchema,
  preview: z.string(),
  at: z.string().min(1),
}).strict();
export type ImDiscovery = z.infer<typeof imDiscoverySchema>;

export const imBusyDeliverySchema = z.enum(['immediate', 'queue', 'steer']);
export type ImBusyDelivery = z.infer<typeof imBusyDeliverySchema>;

export const imBindingSchema = z.object({
  id: z.string().min(1),
  provider_instance_id: z.string().min(1),
  provider_kind: imProviderKindSchema,
  account_id: z.string().min(1),
  identity: imIdentitySchema,
  session_id: z.string().min(1).optional(),
  persona_id: z.string().min(1).optional(),
  pending_reanchor: z.boolean().optional(),
  binding_scope: imBindingScopeSchema.optional(),
  group_policy: imGroupPolicySchema.optional(),
  enabled: z.boolean(),
  session_enabled: z.boolean().optional(),
  input_enabled: z.boolean().optional(),
  output_enabled: z.boolean().optional(),
  busy: imBusyDeliverySchema,
  reply: z.enum(['final', 'edit']),
  mobile_interactions: z.boolean(),
}).strict();
export type ImBinding = z.infer<typeof imBindingSchema>;

export const imConnectionDetailSchema = z.object({
  code: z.enum(['transport_error', 'http_error', 'api_error', 'invalid_response', 'auth_expired', 'loop_failed']),
  http_status: z.number().int().nonnegative().optional(),
  ret: z.number().int().optional(),
  errcode: z.number().int().optional(),
  failure_count: z.number().int().nonnegative().optional(),
  retry_in_ms: z.number().int().nonnegative().optional(),
}).strict();
export type ImConnectionDetail = z.infer<typeof imConnectionDetailSchema>;

export const imInboundDiagnosticSchema = z.object({
  source_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  code: pluginImDiagnosticCodeSchema,
  at: z.string().datetime(),
  account_id: z.string().min(1).max(1024),
}).strict();
export type ImInboundDiagnostic = z.infer<typeof imInboundDiagnosticSchema>;

export const imInstanceViewSchema = z.object({
  id: z.string().min(1),
  provider_kind: imProviderKindSchema,
  label: z.string().optional(),
  listening: z.boolean(),
  inbound: z.boolean().optional(),
  outbound: z.boolean().optional(),
  configured: z.boolean(),
  account_id: z.string().optional(),
  conflict: z.enum(['webhook', 'account_in_use']).optional(),
  adapter: z.enum(['missing', 'running', 'shared', 'stopped']),
  connection: z.enum(['starting', 'reconnecting', 'auth_expired', 'stopped']).optional(),
  connection_detail: imConnectionDetailSchema.optional(),
  inbound_diagnostics: z.array(imInboundDiagnosticSchema).max(PLUGIN_IM_DIAGNOSTIC_LIMITS.sources).optional(),
}).strict();
export type ImInstanceView = z.infer<typeof imInstanceViewSchema>;

export const imStrangerSchema = z.object({
  provider_instance_id: z.string().min(1),
  identity: imIdentitySchema,
  preview: z.string(),
  count: z.number().int().positive(),
}).strict();
export type ImStranger = z.infer<typeof imStrangerSchema>;

export const imSessionSnapshotSchema = z.object({
  policy: imPolicySchema,
  instances: z.array(imInstanceViewSchema),
  discoveries: z.array(imDiscoverySchema),
  bindings: z.array(imBindingSchema),
  strangers: z.array(imStrangerSchema),
  voice_fallbacks: z.number().int().nonnegative(),
}).strict();
export type ImSessionSnapshot = z.infer<typeof imSessionSnapshotSchema>;

export const imCatalogSchema = z.object({
  personas: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    home_session_id: z.string().min(1).optional(),
  }).strict()),
  sessions: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    persona_id: z.string().optional(),
  }).strict()),
}).strict();
export type ImCatalog = z.infer<typeof imCatalogSchema>;

export const imPasteResultSchema = z.object({
  provider_instance_id: z.string().min(1),
  provider_kind: imProviderKindSchema,
  ignored_keys: z.array(z.string()),
  chat_hint_ignored: z.boolean(),
}).strict();
export type ImPasteResult = z.infer<typeof imPasteResultSchema>;

export const imCheckResultSchema = z.object({
  ok: z.boolean(),
  account_id: z.string().optional(),
  conflict: z.literal('webhook').optional(),
  detail: z.string().optional(),
}).strict();
export type ImCheckResult = z.infer<typeof imCheckResultSchema>;

export const imConfirmRequestSchema = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('persona'), persona_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('session'), session_id: z.string().min(1) }).strict(),
  ]),
  busy: imBusyDeliverySchema.optional(),
  reply: z.enum(['final', 'edit']).optional(),
  mobile_interactions: z.boolean().optional(),
  also_home: z.boolean().optional(),
  binding_scope: imBindingScopeSchema.optional(),
  group_policy: imGroupPolicySchema.optional(),
  rebind: z.boolean().optional(),
  input_enabled: z.boolean().optional(),
  output_enabled: z.boolean().optional(),
}).strict();
export type ImConfirmRequest = z.infer<typeof imConfirmRequestSchema>;

export const imBindingPatchSchema = z.object({
  binding_scope: imBindingScopeSchema.optional(),
  enabled: z.boolean().optional(),
  session_enabled: z.boolean().nullable().optional(),
  group_policy: imGroupPolicySchema.optional(),
  input_enabled: z.boolean().nullable().optional(),
  output_enabled: z.boolean().nullable().optional(),
  rebind: z.boolean().optional(),
  busy: imBusyDeliverySchema.optional(),
  reply: z.enum(['final', 'edit']).optional(),
  mobile_interactions: z.boolean().optional(),
  session_id: z.string().min(1).optional(),
  target: imConfirmRequestSchema.shape.target.optional(),
}).strict().refine((patch) => patch.target === undefined || patch.session_id === undefined, {
  path: ['target'],
  message: 'Set either target or session_id, not both.',
});
export type ImBindingPatch = z.infer<typeof imBindingPatchSchema>;

export const imChannelCapabilitySchema = z.object({
  kind: z.string().min(1),
  mime_types: z.array(z.string().min(1)).optional(),
  max_bytes: z.number().int().positive().optional(),
  rendering: z.string().min(1).optional(),
}).strict();
export type ImChannelCapability = z.infer<typeof imChannelCapabilitySchema>;

/** One delivery channel bound to a conversation; `internal` is the in-app message view. */
export const imChannelViewSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['internal', 'im', 'notify']),
  bound: z.boolean().optional(),
  enabled: z.boolean(),
  capabilities: z.array(imChannelCapabilitySchema),
}).strict();
export type ImChannelView = z.infer<typeof imChannelViewSchema>;

export const imTargetChannelsSchema = z.object({
  internal_enabled: z.boolean(),
  channels: z.array(imChannelViewSchema),
}).strict();
export type ImTargetChannels = z.infer<typeof imTargetChannelsSchema>;

export const imSetupProviderSchema = z.enum(['discord', 'slack', 'matrix']);
export type ImSetupProvider = z.infer<typeof imSetupProviderSchema>;

export const imSetupCatalogSchema = z.object({
  platforms: z.array(z.object({
    provider_kind: imSetupProviderSchema,
    methods: z.array(z.string()),
    fields: z.array(z.object({ key: z.string(), secret: z.boolean(), required: z.boolean(), label: z.string() }).strict()),
    portal_url: z.string().url(),
    instructions: z.array(z.string()),
    capabilities: z.object({
      inbound: z.array(z.string()), outbound: z.array(z.string()), threads: z.boolean(), edit_text: z.boolean(), callbacks: z.boolean(),
      encrypted_rooms: z.boolean(), voice_rendering: z.string(), audio_rendering: z.string(), transport: z.string(),
    }).strict(),
  }).strict()),
}).strict();
export type ImSetupCatalog = z.infer<typeof imSetupCatalogSchema>;

const setupInstance = z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/u).optional();
const setupValue = z.string().min(1).max(8192).refine((value) => !/[\r\n]/u.test(value), 'Use one line per field.');
const setupUrl = z.string().url().max(2048);
export const imSetupRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), provider_kind: imSetupProviderSchema, instance_id: setupInstance, fields: z.record(z.string(), setupValue) }).strict(),
  z.object({ action: z.literal('discord_install'), application_id: z.string().regex(/^\d{1,22}$/u), guild_id: z.string().regex(/^\d{1,22}$/u).optional() }).strict(),
  z.object({ action: z.literal('slack_manifest'), name: z.string().min(1).max(80).optional() }).strict(),
  z.object({ action: z.literal('slack_oauth_begin'), client_id: setupValue, redirect_uri: setupUrl, instance_id: setupInstance }).strict(),
  z.object({ action: z.literal('slack_oauth_complete'), attempt_id: setupValue, state: setupValue, code: setupValue, client_secret: setupValue, app_token: setupValue }).strict(),
  z.object({ action: z.literal('matrix_discover'), server: setupValue }).strict(),
  z.object({ action: z.literal('matrix_sso_begin'), homeserver: setupUrl, redirect_uri: setupUrl, idp_id: setupValue.optional(), instance_id: setupInstance }).strict(),
  z.object({ action: z.literal('matrix_sso_complete'), attempt_id: setupValue, callback_uri: setupUrl, login_token: setupValue }).strict(),
  z.object({ action: z.literal('matrix_password'), homeserver: setupUrl, user: setupValue, password: setupValue, instance_id: setupInstance }).strict(),
]);
export type ImSetupRequest = z.infer<typeof imSetupRequestSchema>;

export const imSetupResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), result: imPasteResultSchema }).strict(),
  z.object({ kind: z.literal('link'), url: z.string().url(), attempt_id: z.string().optional(), callback_uri: z.string().url().optional() }).strict(),
  z.object({ kind: z.literal('discovery'), homeserver: z.string().url(), login_types: z.array(z.string()), sso: z.boolean() }).strict(),
]);
export type ImSetupResult = z.infer<typeof imSetupResultSchema>;

export const imBindingTestResultSchema = z.object({
  binding_id: z.string().min(1),
  status: z.enum(['delivered', 'partial', 'failed', 'unknown']),
  message_ids: z.array(z.string().min(1)),
  detail: z.string().optional(),
}).strict();
export type ImBindingTestResult = z.infer<typeof imBindingTestResultSchema>;

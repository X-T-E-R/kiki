import { z } from 'zod';

export const imProviderKindSchema = z.enum(['telegram', 'feishu_app', 'onebot_v11', 'wechat_bridge']);
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
}).strict();
export type ImPolicy = z.infer<typeof imPolicySchema>;

export const imIdentitySchema = z.object({
  chat_id: z.string().min(1),
  sender_id: z.string().min(1),
  topic_id: z.string().min(1),
  chat_title: z.string().optional(),
  sender_name: z.string().optional(),
  topic_title: z.string().optional(),
}).strict();
export type ImIdentity = z.infer<typeof imIdentitySchema>;

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

export const imBindingSchema = z.object({
  id: z.string().min(1),
  provider_instance_id: z.string().min(1),
  provider_kind: imProviderKindSchema,
  account_id: z.string().min(1),
  identity: imIdentitySchema,
  session_id: z.string().min(1),
  persona_id: z.string().min(1).optional(),
  enabled: z.boolean(),
  session_enabled: z.boolean().optional(),
  busy: z.enum(['queue', 'steer']),
  reply: z.enum(['final', 'edit']),
  mobile_interactions: z.boolean(),
}).strict();
export type ImBinding = z.infer<typeof imBindingSchema>;

export const imInstanceViewSchema = z.object({
  id: z.string().min(1),
  provider_kind: imProviderKindSchema,
  label: z.string().optional(),
  listening: z.boolean(),
  configured: z.boolean(),
  account_id: z.string().optional(),
  conflict: z.literal('webhook').optional(),
  adapter: z.enum(['missing', 'running', 'shared', 'stopped']),
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
  busy: z.enum(['queue', 'steer']).optional(),
  reply: z.enum(['final', 'edit']).optional(),
  mobile_interactions: z.boolean().optional(),
  also_home: z.boolean().optional(),
}).strict();
export type ImConfirmRequest = z.infer<typeof imConfirmRequestSchema>;

export const imBindingPatchSchema = z.object({
  enabled: z.boolean().optional(),
  session_enabled: z.boolean().nullable().optional(),
  busy: z.enum(['queue', 'steer']).optional(),
  reply: z.enum(['final', 'edit']).optional(),
  mobile_interactions: z.boolean().optional(),
  session_id: z.string().min(1).optional(),
  target: imConfirmRequestSchema.shape.target.optional(),
}).strict().refine((patch) => patch.target === undefined || patch.session_id === undefined, {
  path: ['target'],
  message: 'Set either target or session_id, not both.',
});
export type ImBindingPatch = z.infer<typeof imBindingPatchSchema>;

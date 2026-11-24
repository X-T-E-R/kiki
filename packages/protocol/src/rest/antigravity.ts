import { z } from 'zod';

export const antigravityAuthMethodSchema = /* @__PURE__ */ z.enum([
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform',
]);
export type AntigravityAuthMethod = z.infer<typeof antigravityAuthMethodSchema>;

export const antigravityReleaseLayoutSchema = /* @__PURE__ */ z.enum([
  'official-cli',
  'legacy-pair',
]);
export type AntigravityReleaseLayout = z.infer<typeof antigravityReleaseLayoutSchema>;

export const antigravityModelEntrySchema = /* @__PURE__ */ z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  thinking_levels: z.array(z.string()).optional(),
});
export type AntigravityModelEntry = z.infer<typeof antigravityModelEntrySchema>;

export const antigravityEligibilitySchema = /* @__PURE__ */ z.enum([
  'ready',
  'subscription_required',
  'unknown',
]);
export type AntigravityEligibility = z.infer<typeof antigravityEligibilitySchema>;

export const antigravityProfileStatusSchema = /* @__PURE__ */ z.object({
  instance_id: z.string().optional(),
  signed_in: z.boolean(),
  auth_method: antigravityAuthMethodSchema.optional(),
  account_label: z.string().optional(),
  gcp_project: z.string().optional(),
  gcp_location: z.string().optional(),
  eligibility: antigravityEligibilitySchema.optional(),
  eligibility_message: z.string().optional(),
  token_expired: z.boolean().optional(),
  auto_mode_supported: z.boolean().optional(),
  models: z.array(antigravityModelEntrySchema).optional(),
  commands: z.array(z.string()).optional(),
  checked_at: z.string().optional(),
});
export type AntigravityProfileStatus = z.infer<typeof antigravityProfileStatusSchema>;

export const antigravityStatusQuerySchema = /* @__PURE__ */ z.object({
  instance_id: z.string().trim().min(1).optional(),
  check_updates: z.preprocess((value) => {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }, z.boolean().optional()),
  refresh_models: z.preprocess((value) => {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }, z.boolean().optional()),
});
export type AntigravityStatusQuery = z.infer<typeof antigravityStatusQuerySchema>;

export const antigravityStatusSchema = /* @__PURE__ */ z.object({
  release: z.object({
    version: z.string(),
    platform: z.string(),
    url: z.string().url(),
    entry: z.string(),
    required_sibling: z.string(),
    layout: antigravityReleaseLayoutSchema.optional(),
    sha512: z.string().optional(),
    args: z.array(z.string()),
  }),
  latest_release: z.object({
    version: z.string(),
    update_available: z.boolean(),
  }).optional(),
  versions: z.array(z.string()),
  active_version: z.string().optional(),
  phase: z.enum(['idle', 'installing', 'failed']),
  error: z.string().optional(),
  profile: antigravityProfileStatusSchema.optional(),
});

export const antigravityInstallRequestSchema = /* @__PURE__ */ z.object({
  version: z.string().optional(),
  instance_id: z.string().trim().min(1).optional(),
}).strict();

export const antigravityActivateRequestSchema = /* @__PURE__ */ z.object({
  version: z.string().min(1),
  instance_id: z.string().trim().min(1).optional(),
}).strict();

export const antigravityLoginRequestSchema = /* @__PURE__ */ z.object({
  method_id: antigravityAuthMethodSchema,
  instance_id: z.string().trim().min(1).optional(),
  gcp_project: z.string().trim().min(1).optional(),
  gcp_location: z.string().trim().min(1).optional(),
  api_key: z.string().trim().min(1).optional(),
  force: z.boolean().optional(),
}).strict();
export type AntigravityLoginRequest = z.infer<typeof antigravityLoginRequestSchema>;

export const antigravityLoginFlowKindSchema = /* @__PURE__ */ z.enum([
  'code_paste',
  'loopback_url',
]);
export type AntigravityLoginFlowKind = z.infer<typeof antigravityLoginFlowKindSchema>;

export const antigravityLoginStartSchema = /* @__PURE__ */ z.discriminatedUnion('already_signed_in', [
  z.object({
    already_signed_in: z.literal(true),
    instance_id: z.string().optional(),
    profile: antigravityProfileStatusSchema.optional(),
  }),
  z.object({
    already_signed_in: z.literal(false),
    handle: z.string(),
    auth_url: z.string().url(),
    redirect_uri: z.string().url(),
    flow_kind: antigravityLoginFlowKindSchema.optional(),
    method_id: antigravityAuthMethodSchema,
    instance_id: z.string().optional(),
    expires_in_secs: z.number().int().positive(),
  }),
]);

export const antigravityLoginCompleteRequestSchema = /* @__PURE__ */ z.object({
  handle: z.string().min(1),
  redirect_url: z.string().url().optional(),
  code_or_url: z.string().trim().min(1).max(8192).optional(),
  instance_id: z.string().trim().min(1).optional(),
}).strict().refine(
  (value) => value.redirect_url !== undefined || value.code_or_url !== undefined,
  { message: 'Provide redirect_url or code_or_url' },
);
export type AntigravityLoginCompleteRequest = z.infer<typeof antigravityLoginCompleteRequestSchema>;

export const antigravityLoginCancelRequestSchema = /* @__PURE__ */ z.object({
  handle: z.string().min(1),
  instance_id: z.string().trim().min(1).optional(),
}).strict();

export const antigravityLogoutRequestSchema = /* @__PURE__ */ z.object({
  instance_id: z.string().trim().min(1).optional(),
}).strict();
export type AntigravityLogoutRequest = z.infer<typeof antigravityLogoutRequestSchema>;

/** `message` is the server's own words (diagnostic); `message_code` is what clients translate. */
export const antigravityLoginMessageCodeSchema = /* @__PURE__ */ z.enum([
  'callback_mismatch',
  'signin_failed',
  'subscription_required',
  'configuration_invalid',
]);

export const antigravityLoginOutcomeSchema = /* @__PURE__ */ z.object({
  signed_in: z.boolean(),
  retryable: z.boolean(),
  message: z.string().optional(),
  message_code: antigravityLoginMessageCodeSchema.optional(),
  profile: antigravityProfileStatusSchema.optional(),
});

export type AntigravityStatusResponse = z.infer<typeof antigravityStatusSchema>;
export type AntigravityLoginStartResponse = z.infer<typeof antigravityLoginStartSchema>;
export type AntigravityLoginOutcomeResponse = z.infer<typeof antigravityLoginOutcomeSchema>;

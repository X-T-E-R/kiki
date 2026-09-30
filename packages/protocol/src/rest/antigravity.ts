import { z } from 'zod';

export const antigravityAuthMethodSchema = z.enum(['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform']);
export const antigravityStatusSchema = z.object({
  release: z.object({ version: z.string(), platform: z.string(), url: z.string().url(), entry: z.string(), required_sibling: z.string(), args: z.array(z.string()) }),
  versions: z.array(z.string()), active_version: z.string().optional(),
  phase: z.enum(['idle', 'installing', 'failed']), error: z.string().optional(),
});
export const antigravityInstallRequestSchema = z.object({ version: z.string().optional() }).strict();
export const antigravityActivateRequestSchema = z.object({ version: z.string().min(1) }).strict();
export const antigravityLoginRequestSchema = z.object({ method_id: antigravityAuthMethodSchema }).strict();
export const antigravityLoginStartSchema = z.discriminatedUnion('already_signed_in', [
  z.object({ already_signed_in: z.literal(true) }),
  z.object({ already_signed_in: z.literal(false), handle: z.string(), auth_url: z.string().url(), redirect_uri: z.string().url(), method_id: antigravityAuthMethodSchema, expires_in_secs: z.number().int().positive() }),
]);
export const antigravityLoginCompleteRequestSchema = z.object({ handle: z.string().min(1), redirect_url: z.string().url() }).strict();
export const antigravityLoginCancelRequestSchema = z.object({ handle: z.string().min(1) }).strict();
/** `message` is the server's own words (diagnostic); `message_code` is what clients translate. */
export const antigravityLoginMessageCodeSchema = z.enum(['callback_mismatch', 'signin_failed']);
export const antigravityLoginOutcomeSchema = z.object({
  signed_in: z.boolean(), retryable: z.boolean(), message: z.string().optional(), message_code: antigravityLoginMessageCodeSchema.optional(),
});
export type AntigravityStatusResponse = z.infer<typeof antigravityStatusSchema>;
export type AntigravityLoginStartResponse = z.infer<typeof antigravityLoginStartSchema>;
export type AntigravityLoginOutcomeResponse = z.infer<typeof antigravityLoginOutcomeSchema>;

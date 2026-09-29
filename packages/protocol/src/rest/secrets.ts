import { z } from 'zod';

/**
 * Where the value a secret field resolves to comes from. `kiki` is a value
 * saved through Kiki (config credentials, mcp.json, the nb-search managed
 * store); `environment` is a server environment variable (or a provider's
 * declared env table); `local` is the nb-search CLI secrets file.
 */
export const secretSourceSchema = z.enum(['kiki', 'environment', 'local', 'none']);
export type SecretSource = z.infer<typeof secretSourceSchema>;

const mcpScope = { server: z.string().min(1).max(256), cwd: z.string().min(1).optional() };

/**
 * Addresses exactly one secret. POST bodies keep identifiers and secrets out
 * of URLs, query strings and access logs. OAuth tokens are sign-in state and
 * have no reference kind.
 */
export const secretRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider_api_key'), provider_id: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('reviewer_api_key') }).strict(),
  z.object({ kind: z.literal('mcp_env'), ...mcpScope, key: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('mcp_header'), ...mcpScope, key: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('mcp_bearer_env'), ...mcpScope }).strict(),
  z.object({ kind: z.literal('nb_search_credential'), instance_id: z.string().min(1).max(256) }).strict(),
]);
export type SecretRef = z.infer<typeof secretRefSchema>;

export const revealSecretRequestSchema = z.object({ ref: secretRefSchema }).strict();
export type RevealSecretRequest = z.infer<typeof revealSecretRequestSchema>;

/** Only returned by the explicit reveal route; bulk reads carry `source` alone. */
export const revealedSecretSchema = z.object({
  source: secretSourceSchema,
  env_name: z.string().min(1).optional(),
  value: z.string().optional(),
}).strict();
export type RevealedSecret = z.infer<typeof revealedSecretSchema>;

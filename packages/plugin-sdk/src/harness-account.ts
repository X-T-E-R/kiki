import { z } from 'zod';

const identifier = z.string().min(1).max(1024).regex(/^[^\s\u0000]+$/);
const engineIds = z.array(identifier).min(1).refine((ids) => new Set(ids).size === ids.length, 'Duplicate engine id');

export const harnessAccountSourceDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().min(1),
  engineIds,
}).strict();

export const harnessAccountListInputSchema = z.object({ engineId: identifier }).strict();
export const harnessAccountSchema = z.object({
  id: identifier,
  label: z.string().min(1),
  status: z.enum(['ready', 'signed_out', 'disabled']),
});
export const harnessAccountListSchema = z.array(harnessAccountSchema)
  .refine((accounts) => new Set(accounts.map(({ id }) => id)).size === accounts.length, 'Duplicate account id');

export const harnessAccountPrepareInputSchema = harnessAccountListInputSchema.extend({
  accountId: identifier,
  instanceId: identifier,
  proxy: z.object({
    mode: z.enum(['system', 'direct', 'custom']),
    url: z.url().optional(),
  }).strict().refine(({ mode, url }) => (mode === 'custom') === (url !== undefined), 'Only a custom proxy takes a URL'),
});

export const harnessAccountConnectionSchema = z.object({
  protocol: z.enum(['gemini-v1beta', 'openai-responses', 'anthropic-messages']),
  baseUrl: z.url({ protocol: /^https?$/ }).refine((url) => {
    const parsed = URL.parse(url);
    return parsed !== null && !parsed.username && !parsed.password;
  }),
  apiKey: z.string().min(1).refine((key) => !key.includes('\0') && !key.includes('\r') && !key.includes('\n')),
  modelIds: z.array(identifier),
});

export type HarnessAccountSourceDefinition = z.infer<typeof harnessAccountSourceDefinitionSchema>;
export type HarnessAccountListInput = z.infer<typeof harnessAccountListInputSchema>;
export type HarnessAccount = z.infer<typeof harnessAccountSchema>;
export type HarnessAccountPrepareInput = z.infer<typeof harnessAccountPrepareInputSchema>;
export type HarnessAccountConnection = z.infer<typeof harnessAccountConnectionSchema>;

export interface HarnessAccountContext {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly kikiHome: string;
}

export interface HarnessAccountPrepared {
  readonly leaseId: string;
  /** Short-lived adapter access. Never return the underlying OAuth credentials. */
  readonly connection: HarnessAccountConnection;
}

export interface HarnessAccountAdapter {
  /** Lists display metadata for the specified engine without preparing a connection. */
  list(input: HarnessAccountListInput, context: HarnessAccountContext): readonly HarnessAccount[] | Promise<readonly HarnessAccount[]>;
  /** Prepares the exact selected account. On failure, clean up partial acquisition and throw a credential-free error. */
  prepare(input: HarnessAccountPrepareInput, context: HarnessAccountContext): HarnessAccountPrepared | Promise<HarnessAccountPrepared>;
  /** Releases the lease in the same backend, with a fresh signal and the original settings. */
  release(input: { leaseId: string }, context: HarnessAccountContext): void | Promise<void>;
}

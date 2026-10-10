import { z } from 'zod';

export const cloudflareSettingsPatchSchema = z.object({
  cloudflaredPath: z.string().nullable().optional(),
  mode: z.enum(['token', 'local']).nullable().optional(),
  tunnelToken: z.string().nullable().optional(),
  tokenFile: z.string().nullable().optional(),
  apiToken: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  tunnelId: z.string().nullable().optional(),
  certificatePath: z.string().nullable().optional(),
  configPath: z.string().nullable().optional(),
  credentialsFile: z.string().nullable().optional(),
  publicUrl: z.string().nullable().optional(),
  autoStart: z.boolean().nullable().optional(),
}).strict();

export const cloudflareStatusSchema = z.object({
  schemaVersion: z.literal(1),
  dependency: z.object({ state: z.enum(['ready', 'missing', 'error']), path: z.string(), version: z.string().optional(), installable: z.boolean().optional() }),
  account: z.object({ certificate: z.boolean(), apiToken: z.boolean() }),
  configuration: z.object({
    mode: z.enum(['token', 'local']), tunnelId: z.string(), configPath: z.string(),
    tokenFile: z.string(), credentialsFile: z.string(), certificatePath: z.string(),
    publicUrl: z.string(), accountId: z.string(), cloudflaredPath: z.string(),
    autoStart: z.boolean(), tokenConfigured: z.boolean(),
    source: z.literal('plugin-settings').optional(),
    credentialSource: z.enum(['plugin-secret-store', 'existing-token-file', 'existing-local-config', 'none']).optional(),
  }),
  service: z.object({
    state: z.enum(['unconfigured', 'stopped', 'starting', 'running', 'retrying', 'error']),
    ready: z.boolean(), manualStop: z.boolean(), retryCount: z.number().int().nonnegative(),
    pid: z.number().int().positive().optional(), error: z.string().optional(),
  }),
  login: z.object({ state: z.enum(['idle', 'pending', 'complete', 'error']), url: z.string().optional(), error: z.string().optional() }),
});

export const cloudflareTunnelsSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), status: z.string().optional() })) });
export const cloudflareAccountsSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) });
export const cloudflareSetupSchema = z.object({ url: z.string().url(), docsUrl: z.string().url(), managedExternally: z.literal(true) });

export type CloudflareSettingsPatch = z.infer<typeof cloudflareSettingsPatchSchema>;
export type CloudflareStatus = z.infer<typeof cloudflareStatusSchema>;
export type CloudflareTunnels = z.infer<typeof cloudflareTunnelsSchema>;
export type CloudflareAccounts = z.infer<typeof cloudflareAccountsSchema>;
export type CloudflareSetup = z.infer<typeof cloudflareSetupSchema>;

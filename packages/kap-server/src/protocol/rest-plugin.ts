import { z } from 'zod';
import { pluginInstallPlanSchema, pluginInstallRequestSchema, pluginPreviewRequestSchema } from '@kiki/protocol';

export { pluginInstallPlanSchema, pluginPreviewRequestSchema };

/** GitHub provenance for github-sourced plugins (domain PluginGithubMetadata). */
export const pluginGithubMetadataSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.object({
    kind: z.enum(['branch', 'tag', 'sha']),
    value: z.string(),
  }),
  installedSha: z.string().optional(),
});

export const pluginSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string().optional(),
  icon: z.string().optional(),
  enabled: z.boolean(),
  globalEnabled: z.boolean(),
  state: z.enum(['ok', 'error']),
  skillCount: z.number(),
  mcpServerCount: z.number(),
  enabledMcpServerCount: z.number(),
  hookCount: z.number(),
  commandCount: z.number(),
  hasErrors: z.boolean(),
  source: z.enum(['local-path', 'zip-url', 'github']),
  originalSource: z.string().optional(),
  github: pluginGithubMetadataSchema.optional(),
  zipSha256: z.string().optional(),
  rollback: z.object({
    version: z.string().optional(),
    source: z.enum(['local-path', 'zip-url', 'github']),
    originalSource: z.string().optional(),
    github: pluginGithubMetadataSchema.optional(),
    zipSha256: z.string().optional(),
  }).optional(),
});
export type PluginSummaryWire = z.infer<typeof pluginSummarySchema>;

export const listPluginsResponseSchema = z.object({
  plugins: z.array(pluginSummarySchema),
});
export type ListPluginsResponse = z.infer<typeof listPluginsResponseSchema>;

export const installPluginRequestSchema = pluginInstallRequestSchema;
export type InstallPluginRequest = z.infer<typeof installPluginRequestSchema>;

export const pluginMarketplaceEntrySchema = z.object({
  id: z.string(),
  tier: z.enum(['official', 'curated', 'third-party']),
  displayName: z.string(),
  description: z.string().optional(),
  homepage: z.string().optional(),
  icon: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  relevance: z.object({
    cwd: z.array(z.string()).optional(), fileGlobs: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(), dependencies: z.array(z.string()).optional(),
  }).optional(),
  version: z.string().optional(),
  source: z.string(),
  sha256: z.string().optional(),
  engines: z.object({ kiki: z.string().optional() }).optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  installable: z.boolean().optional(),
  group: z.string().optional(),
  localizations: z
    .record(
      z.string(),
      z.object({
        displayName: z.string().optional(),
        description: z.string().optional(),
        keywords: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  installed: z
    .object({
      version: z.string().optional(),
      enabled: z.boolean(),
    })
    .optional(),
  updateAvailable: z.boolean().optional(),
  capabilityId: z.string().optional(),
});
export type PluginMarketplaceEntryWire = z.infer<typeof pluginMarketplaceEntrySchema>;

export const pluginMarketplaceResponseSchema = z.object({
  configured: z.boolean(),
  source: z.string().optional(),
  entries: z.array(pluginMarketplaceEntrySchema),
});
export type PluginMarketplaceResponse = z.infer<typeof pluginMarketplaceResponseSchema>;

export const pluginMcpServerInfoSchema = z.object({
  name: z.string(),
  runtimeName: z.string(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  envKeys: z.array(z.string()).optional(),
  headerKeys: z.array(z.string()).optional(),
});

export const pluginDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warn', 'info']),
  message: z.string(),
});

export const pluginInfoSchema = pluginSummarySchema.extend({
  root: z.string(),
  installedAt: z.string(),
  updatedAt: z.string().optional(),
  manifestKind: z.enum(['kimi-plugin-root', 'kimi-plugin-dir', 'claude-code']).optional(),
  manifestPath: z.string().optional(),
  manifest: z.unknown().optional(),
  prerequisites: z.object({
    origin: z.enum(['kiki-compatibility', 'plugin-declared']),
    items: z.object({ schemaVersion: z.literal(1), items: z.array(z.object({
      id: z.string(), kind: z.enum(['host-capability', 'daemon', 'browser-extension', 'executable', 'configuration']),
      required: z.boolean(), provider: z.string().optional(), executionHost: z.string().optional(),
      version: z.string().optional(), setting: z.string().optional(),
      dependsOn: z.array(z.string()).optional(), capabilityImpact: z.array(z.string()).optional(),
    })) }),
  }).optional(),
  mcpServers: z.array(pluginMcpServerInfoSchema),
  shadowedManifestPath: z.string().optional(),
  diagnostics: z.array(pluginDiagnosticSchema),
});
export type PluginInfoWire = z.infer<typeof pluginInfoSchema>;

export const pluginIdParamSchema = z.object({
  tail: z.string().min(1),
});
export type PluginIdParam = z.infer<typeof pluginIdParamSchema>;

export const pluginInfoParamSchema = z.object({
  plugin_id: z.string().min(1),
});
export type PluginInfoParam = z.infer<typeof pluginInfoParamSchema>;

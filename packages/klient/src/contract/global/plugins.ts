/**
 * `pluginService` — plugin management and consumption. Mirrors
 * `agent-core-v2/app/plugin/plugin.ts` and `agent-core-v2/app/plugin/types.ts`;
 * nested `McpServerConfig` mirrors `agent-core-v2/mcpCore/config-schema.ts`,
 * `HookDefConfig` mirrors `agent-core-v2/features/externalHooks/configSection.ts`.
 * `pluginSkillRoots`, `enabledSessionStarts`, `enabledSystemPrompts`,
 * `enabledMcpServers`, and `enabledHooks` are excluded (not part of the
 * klient wire surface).
 */

import { z } from 'zod';
import { asrProviderDefinitionSchema, pluginInstallPlanSchema, pluginPreviewRequestSchema } from '@kiki/protocol';

import { noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const pluginDiagnosticSchema = /* @__PURE__ */ z.object({
  severity: z.enum(['error', 'warn', 'info']),
  message: z.string(),
});

const pluginAuthorSchema = /* @__PURE__ */ z.object({
  name: z.string().optional(),
  email: z.string().optional(),
});

const pluginSessionStartSchema = /* @__PURE__ */ z.object({
  skill: z.string(),
});

const pluginInterfaceSchema = /* @__PURE__ */ z.object({
  displayName: z.string().optional(),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  developerName: z.string().optional(),
  websiteURL: z.string().optional(),
});

const hookDefSchema = /* @__PURE__ */ z.object({
  event: z.enum([
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'PermissionResult',
    'UserPromptSubmit',
    'UserPromptQueued',
    'TurnStarted',
    'Stop',
    'StopFailure',
    'Interrupt',
    'SessionStart',
    'SessionEnd',
    'SessionHeartbeat',
    'SubagentStart',
    'SubagentStop',
    'TaskStarted',
    'PreCompact',
    'PostCompact',
    'Notification',
  ]),
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeout: z.number().int().min(1).max(600).optional(),
});

const pluginCommandEntrySchema = /* @__PURE__ */ z.object({
  path: z.string(),
  name: z.string(),
});

const pluginManifestKindSchema = /* @__PURE__ */ z.enum(['kimi-plugin-root', 'kimi-plugin-dir', 'claude-code']);

const pluginSourceSchema = /* @__PURE__ */ z.enum(['local-path', 'zip-url', 'github']);

const pluginStateSchema = /* @__PURE__ */ z.enum(['ok', 'error']);

const pluginGithubRefSchema = /* @__PURE__ */ z.object({
  kind: z.enum(['branch', 'tag', 'sha']),
  value: z.string(),
});

export const pluginManifestSchema = /* @__PURE__ */ z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  author: pluginAuthorSchema.optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  icon: z.string().optional(),
  skills: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  sessionStart: pluginSessionStartSchema.optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  hooks: z.array(hookDefSchema).optional(),
  commands: z.array(pluginCommandEntrySchema).optional(),
  interface: pluginInterfaceSchema.optional(),
  skillInstructions: z.string().optional(),
  systemPrompt: z.string().optional(),
  unsupportedComponents: z.array(z.string()).optional(),
});

export const pluginMcpServerInfoSchema = /* @__PURE__ */ z.object({
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

export const pluginGithubMetadataSchema = /* @__PURE__ */ z.object({
  owner: z.string(),
  repo: z.string(),
  ref: pluginGithubRefSchema,
  installedSha: z.string().optional(),
});

export const pluginSummarySchema = /* @__PURE__ */ z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string().optional(),
  icon: z.string().optional(),
  enabled: z.boolean(),
  globalEnabled: z.boolean(),
  defaultEnabled: z.boolean().optional(),
  asrProviders: z.array(asrProviderDefinitionSchema).optional(),
  state: pluginStateSchema,
  skillCount: z.number(),
  mcpServerCount: z.number(),
  enabledMcpServerCount: z.number(),
  hookCount: z.number(),
  commandCount: z.number(),
  hasErrors: z.boolean(),
  source: pluginSourceSchema,
  originalSource: z.string().optional(),
  github: pluginGithubMetadataSchema.optional(),
  zipSha256: z.string().optional(),
  rollback: z.object({
    version: z.string().optional(),
    source: pluginSourceSchema,
    originalSource: z.string().optional(),
    github: pluginGithubMetadataSchema.optional(),
    zipSha256: z.string().optional(),
  }).optional(),
});

export const pluginInfoSchema = /* @__PURE__ */ pluginSummarySchema.extend({
  root: z.string(),
  installedAt: z.string(),
  updatedAt: z.string().optional(),
  manifestKind: pluginManifestKindSchema.optional(),
  manifestPath: z.string().optional(),
  manifest: pluginManifestSchema.optional(),
  mcpServers: z.array(pluginMcpServerInfoSchema),
  shadowedManifestPath: z.string().optional(),
  diagnostics: z.array(pluginDiagnosticSchema),
});

/** Same shape as `reloadSummarySchema` in `./events.js` — keep in sync. */
export const reloadSummarySchema = /* @__PURE__ */ z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  errors: z.array(z.object({ id: z.string(), message: z.string() })),
});

export const pluginUpdateStatusSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  source: pluginSourceSchema,
  current: pluginGithubRefSchema.optional(),
  latest: pluginGithubRefSchema,
  displayVersion: z.string(),
  updateAvailable: z.boolean(),
});

export const pluginCommandDefSchema = /* @__PURE__ */ z.object({
  pluginId: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  path: z.string(),
});

export const installPluginInputSchema = /* @__PURE__ */ pluginPreviewRequestSchema.extend({
  fingerprint: z.string().optional(),
  consent: z.boolean().optional(),
  defaultEnabled: z.boolean().optional(),
});

export const setPluginEnabledInputSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  enabled: z.boolean(),
  defaultEnabled: z.boolean().optional(),
});

export const setPluginMcpServerEnabledInputSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  server: z.string(),
  enabled: z.boolean(),
});

export const removePluginInputSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  deleteData: z.boolean().optional(),
});

export const getPluginInfoInputSchema = /* @__PURE__ */ z.object({
  id: z.string(),
});

export const pluginsContract = {
  listPlugins: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(pluginSummarySchema) }), 'input', 'output'),
  previewPlugin: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([pluginPreviewRequestSchema]), output: pluginInstallPlanSchema }), 'input', 'output'),
  installPlugin: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([installPluginInputSchema]), output: pluginSummarySchema }), 'input', 'output'),
  rollbackPlugin: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.object({ id: z.string() })]), output: pluginSummarySchema }), 'input', 'output'),
  setPluginEnabled: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([setPluginEnabledInputSchema]), output: noResult }), 'input', 'output'),
  setPluginMcpServerEnabled: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([setPluginMcpServerEnabledInputSchema]),
    output: noResult,
  }), 'input', 'output'),
  removePlugin: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([removePluginInputSchema]), output: noResult }), 'input', 'output'),
  reloadPlugins: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: reloadSummarySchema }), 'input', 'output'),
  getPluginInfo: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([getPluginInfoInputSchema]), output: pluginInfoSchema }), 'input', 'output'),
  listPluginCommands: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(pluginCommandDefSchema) }), 'input', 'output'),
  checkUpdates: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(pluginUpdateStatusSchema) }), 'input', 'output'),
} satisfies ServiceContract;

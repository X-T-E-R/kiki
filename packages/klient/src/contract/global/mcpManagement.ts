/**
 * `mcpManagementService` — the unified MCP management plane. Mirrors
 * `agent-core-v2/app/mcpManagement/mcpManagement.ts`; `McpServerSource` /
 * `McpRegistryPluginOrigin` / `McpRegistryQuery` mirror
 * `agent-core-v2/app/mcpRegistry/mcpRegistry.ts`, and the redacted config
 * shape mirrors `agent-core-v2/mcpCore/configView.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import {
  mcpServerHttpConfigSchema,
  mcpServerSseConfigSchema,
  mcpServerStdioConfigSchema,
} from '../mcp.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const mcpServerSourceSchema = /* @__PURE__ */ z.enum(['global', 'plugin', 'caller']);

export const mcpRegistryPluginOriginSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  /** Manifest-local server name (without the runtime prefix). */
  name: z.string(),
});

export const mcpRegistryQuerySchema = /* @__PURE__ */ z.object({
  cwd: z.string().min(1).optional(),
});

export const mcpAuthStatusQuerySchema = /* @__PURE__ */ z.object({
  cwd: z.string().min(1).optional(),
  verify: z.boolean().optional(),
});

/** `GlobalMcpServerConfig` — a named full config (add/update, inline test target). */
export const globalMcpServerConfigSchema = /* @__PURE__ */ z.discriminatedUnion('transport', [
  mcpServerStdioConfigSchema.extend({ name: z.string().min(1) }),
  mcpServerHttpConfigSchema.extend({ name: z.string().min(1) }),
  mcpServerSseConfigSchema.extend({ name: z.string().min(1) }),
]);

/**
 * The wire config of a managed/inspected server. Listings are redacted —
 * `env` / `headers` values are replaced by the sorted key lists `envKeys` /
 * `headerKeys`; one value is available through the authenticated reveal route.
 * One schema covers both shapes, mirroring the engine's
 * `McpServerConfig | McpServerConfigView` union.
 */
export const mcpServerConfigDataSchema = /* @__PURE__ */ z.discriminatedUnion('transport', [
  mcpServerStdioConfigSchema.extend({
    envKeys: z.array(z.string()).optional(),
    computerServeReady: z.boolean().optional(),
  }),
  mcpServerHttpConfigSchema.extend({ headerKeys: z.array(z.string()).optional() }),
  mcpServerSseConfigSchema.extend({ headerKeys: z.array(z.string()).optional() }),
]);

export const mcpManagedServerSchema = /* @__PURE__ */ z.object({
  name: z.string(),
  config: mcpServerConfigDataSchema,
  source: mcpServerSourceSchema,
  origin: z.string(),
  mutable: z.boolean(),
  plugin: mcpRegistryPluginOriginSchema.optional(),
});

export const mcpServerTestTargetSchema = /* @__PURE__ */ z.object({
  name: z.string().min(1).optional(),
  server: globalMcpServerConfigSchema.optional(),
  cwd: z.string().min(1).optional(),
});

export const mcpServerTestResultSchema = /* @__PURE__ */ z.object({
  success: z.boolean(),
  output: z.string(),
});

export const mcpServerStopTargetSchema = /* @__PURE__ */ z.object({ name: z.string().min(1), cwd: z.string().min(1).optional() });
export const mcpServerStopResultSchema = /* @__PURE__ */ z.object({ state: z.enum(['idle', 'stopped', 'unconfirmed']), output: z.string() });

export const mcpServerLocatorSchema = /* @__PURE__ */ z.discriminatedUnion('source', [
  z.object({ source: z.literal('global'), name: z.string().min(1) }),
  z.object({
    source: z.literal('plugin'),
    pluginId: z.string().min(1),
    serverName: z.string().min(1),
  }),
]);

export const mcpServerAuthStateSchema = /* @__PURE__ */ z.enum([
  'not-applicable',
  'bearer-token',
  'oauth-required',
  'oauth-authorized',
  'oauth-expired',
  'unavailable',
]);

export const mcpServerDescriptorSchema = /* @__PURE__ */ z.object({
  /** `global:<name>` / `plugin:<pluginId>:<serverName>`, URL-encoded. */
  serverId: z.string(),
  locator: mcpServerLocatorSchema,
  runtimeName: z.string(),
  canonicalUrl: z.string().optional(),
  origin: mcpServerSourceSchema,
  config: mcpServerConfigDataSchema,
  enabled: z.boolean(),
  editable: z.boolean(),
});

export const mcpServerInspectionSchema = /* @__PURE__ */ mcpServerDescriptorSchema.extend({
  authStatus: mcpServerAuthStateSchema,
  checkedAt: z.number().optional(),
  error: z.string().optional(),
});

export const mcpServerAuthStatusSchema = /* @__PURE__ */ z.object({
  name: z.string(),
  authStatus: mcpServerAuthStateSchema,
});

export const mcpStoredOAuthIdentitySchema = /* @__PURE__ */ z.object({
  credentialId: z.string().regex(/^[a-f0-9]{64}$/),
});

export const mcpStoredOAuthCredentialSchema = /* @__PURE__ */ mcpStoredOAuthIdentitySchema.extend({
  serverName: z.string().min(1),
  displayUrl: z.string().min(1),
  origin: z.literal('unknown'),
});

export const mcpRevealedOAuthCredentialSchema = /* @__PURE__ */ z.object({ canonicalUrl: z.url() });

export const mcpServerAuthBeginResultSchema = /* @__PURE__ */ z.discriminatedUnion('status', [
  z.object({
    status: z.literal('authorization-required'),
    flowId: z.string(),
    authorizationUrl: z.string(),
  }),
  z.object({ status: z.literal('already-authorized') }),
]);

export const mcpServerAuthFlowHandleSchema = /* @__PURE__ */ z.object({
  flowId: z.string().min(1),
  // Node overflows setTimeout delays above 2^31-1 into ~1ms; the REST schema
  // and the engine reject the same range.
  timeoutMs: z.number().int().min(1).max(2 ** 31 - 1).optional(),
});

export const mcpManagementContract = {
  listServers: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpRegistryQuerySchema.optional()]),
    output: /* @__PURE__ */ z.array(mcpManagedServerSchema),
  }), 'input', 'output'),
  getServer: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().min(1), mcpRegistryQuerySchema.optional()]),
    output: mcpManagedServerSchema,
  }), 'input', 'output'),
  addServer: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([globalMcpServerConfigSchema, mcpRegistryQuerySchema.optional()]),
    output: /* @__PURE__ */ z.array(mcpManagedServerSchema),
  }), 'input', 'output'),
  updateServer: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([globalMcpServerConfigSchema, mcpRegistryQuerySchema.optional()]),
    output: /* @__PURE__ */ z.array(mcpManagedServerSchema),
  }), 'input', 'output'),
  removeServer: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().min(1), mcpRegistryQuerySchema.optional()]),
    output: /* @__PURE__ */ z.array(mcpManagedServerSchema),
  }), 'input', 'output'),
  testServer: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpServerTestTargetSchema]),
    output: mcpServerTestResultSchema,
  }), 'input', 'output'),
  stopServer: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mcpServerStopTargetSchema]), output: mcpServerStopResultSchema }), 'input', 'output'),
  listAuthStatuses: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpAuthStatusQuerySchema.optional()]),
    output: /* @__PURE__ */ z.array(mcpServerAuthStatusSchema),
  }), 'input', 'output'),
  inspectServers: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([
      z.array(mcpServerLocatorSchema).optional(),
      mcpRegistryQuerySchema.optional(),
    ]),
    output: /* @__PURE__ */ z.array(mcpServerInspectionSchema),
  }), 'input', 'output'),
  resolveServerByName: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().min(1), mcpRegistryQuerySchema.optional()]),
    output: mcpServerLocatorSchema,
  }), 'input', 'output'),
  beginServerAuth: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpServerLocatorSchema, mcpRegistryQuerySchema.optional()]),
    output: mcpServerAuthBeginResultSchema,
  }), 'input', 'output'),
  completeServerAuth: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpServerAuthFlowHandleSchema]),
    output: noResult,
  }), 'input', 'output'),
  cancelServerAuth: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.object({ flowId: z.string().min(1) })]),
    output: noResult,
  }), 'input', 'output'),
  resetServerAuth: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpServerLocatorSchema, mcpRegistryQuerySchema.optional(), z.url().optional()]),
    output: noResult,
  }), 'input', 'output'),
  listStoredOAuthCredentials: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([]),
    output: /* @__PURE__ */ z.array(mcpStoredOAuthCredentialSchema),
  }), 'input', 'output'),
  revealStoredOAuthCredential: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpStoredOAuthIdentitySchema]),
    output: mcpRevealedOAuthCredentialSchema,
  }), 'input', 'output'),
  revokeStoredOAuthCredential: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpStoredOAuthIdentitySchema]),
    output: noResult,
  }), 'input', 'output'),
} satisfies ServiceContract;

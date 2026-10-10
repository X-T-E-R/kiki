import { z } from 'zod';

export const browserIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const common = { name: z.string().trim().min(1).max(256), enabled: z.boolean().default(true), driverPath: z.string().min(1).optional() };
const path = z.string().min(1);
const endpoint = z.string().max(8192).refine((value) => {
  try { return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol) && !/[\r\n\0]/.test(value); }
  catch { return false; }
});
export const browserEndpointEditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('set'), value: endpoint }).strict(),
]);
export const browserConnectionInputSchema = z.discriminatedUnion('type', [
  z.object({ name: common.name, enabled: common.enabled, type: z.literal('codex-extension'), runtimeRoot: path, browserId: z.string().min(1).max(512) }).strict(),
  z.object({ ...common, type: z.literal('agent-browser-profile'), profilePath: path.optional(), executablePath: path.optional(), headed: z.boolean().optional() }).strict(),
  z.object({ ...common, type: z.literal('agent-browser-cdp'), endpoint: browserEndpointEditSchema }).strict(),
]);
export type BrowserConnectionInput = z.infer<typeof browserConnectionInputSchema>;
export const browserConnectionSchema = z.object({
  id: browserIdSchema, ...common, type: z.enum(['agent-browser-profile', 'agent-browser-cdp', 'codex-extension']),
  runtimeRoot: path.optional(), browserId: z.string().optional(),
  profilePath: path.optional(), executablePath: path.optional(), headed: z.boolean().optional(),
  endpointDisplay: z.string().optional(), endpointConfigured: z.boolean().optional(),
}).strict();
export type BrowserConnection = z.infer<typeof browserConnectionSchema>;
export const browserConnectionsSchema = z.object({ connections: z.array(browserConnectionSchema), defaultBrowser: browserIdSchema.optional() });
export type BrowserConnections = z.infer<typeof browserConnectionsSchema>;
export const browserConnectionResponseSchema = z.object({ connection: browserConnectionSchema });
export const browserDefaultInputSchema = z.object({ browser: browserIdSchema.optional() }).strict();

export const browserFailureSchema = z.object({
  code: z.enum(['browser.invalid', 'browser.not_found', 'browser.disabled', 'browser.disconnected', 'browser.execution_failed', 'browser.busy', 'browser.version', 'browser.target', 'browser.requires_action', 'browser.unsupported']),
  reason: z.enum(['feature_disabled', 'connection_disabled', 'outcome_unknown']).optional(),
}).strict();
export type BrowserFailure = z.infer<typeof browserFailureSchema>;
export const browserStatusSchema = z.object({
  failure: browserFailureSchema.optional(),
  browser: browserIdSchema,
  state: z.enum(['idle', 'connecting', 'ready', 'running', 'stopping', 'disconnected', 'failed', 'unconfirmed', 'requires_action', 'unsupported']),
  executionHost: z.string(), runtimeSession: z.string().optional(), generation: z.number().int(),
  checkedAt: z.string().optional(), driverVersion: z.string().optional(), error: z.string().optional(),
  currentCall: z.object({ sessionId: z.string(), agentId: z.string(), tool: z.string(), tab: z.string().optional() }).optional(),
  ownership: z.enum(['managed-profile', 'external-browser']).optional(), profilePath: z.string().optional(),
}).strict();
export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export const browserControlListSchema = z.object({
  connections: z.array(browserConnectionSchema.extend({ status: browserStatusSchema })), defaultBrowser: browserIdSchema.optional(),
});
export type BrowserControlList = z.infer<typeof browserControlListSchema>;

export const browserTabSchema = z.object({
  tabId: z.string(), targetId: z.string(), title: z.string().optional(), url: z.string().optional(), active: z.boolean().optional(), label: z.string().optional(),
});
export type BrowserTab = z.infer<typeof browserTabSchema>;
export const browserTabsResponseSchema = z.object({ browser: browserIdSchema, status: browserStatusSchema, tabs: z.array(browserTabSchema) });
export type BrowserTabsResponse = z.infer<typeof browserTabsResponseSchema>;
export const browserCatalogQuerySchema = z.object({ includeSchema: z.enum(['true', 'false']).optional() }).strict();
export const browserCatalogResponseSchema = z.object({
  browser: browserIdSchema, status: browserStatusSchema, backendToolCount: z.number().int(),
  contextIsolation: z.enum(['opaque-context-through-window', 'official-extension-tab-ids']),
  capabilities: z.array(z.object({ name: z.string(), description: z.string(), group: z.string(), surface: z.enum(['operation', 'lifecycle', 'administrative']), inputSchema: z.unknown().optional() })),
});
export type BrowserCatalogResponse = z.infer<typeof browserCatalogResponseSchema>;

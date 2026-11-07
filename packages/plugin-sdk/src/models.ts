import { z } from 'zod';

export const pluginModelTargetSchema = z.union([
  z.object({ modelId: z.string().trim().min(1) }).strict(),
  z.object({ connectionId: z.string().trim().min(1), modelName: z.string().trim().min(1), maxContextSize: z.number().int().positive().optional() }).strict(),
]);
export const pluginModelRequestSchema = z.object({
  target: pluginModelTargetSchema,
  systemPrompt: z.string().optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() }).strict()).min(1),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();
export type PluginModelTarget = z.infer<typeof pluginModelTargetSchema>;
export type PluginModelRequest = z.infer<typeof pluginModelRequestSchema>;

export interface PluginModelUsage {
  readonly inputOther: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
  readonly output: number;
}

export type PluginModelEvent =
  | { readonly type: 'started'; readonly modelId: string; readonly connectionId: string; readonly modelName: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'reset' }
  | { readonly type: 'usage'; readonly usage: PluginModelUsage }
  | { readonly type: 'completed'; readonly text: string; readonly finishReason?: string };

/** Streaming errors reject iteration with a stable code; cancellation uses request.cancelled. */
export interface PluginModelError extends Error { readonly code: string }

/** The host binds identity, cancellation, governance and Usage to the invoking agent. No keys cross this API. */
export interface PluginModelListOptions {
  /** Exact catalog ids or remote ids. Unknown candidates are omitted. An empty list returns no models. */
  readonly candidates?: readonly string[];
}

export interface PluginModelsApi {
  list(options?: PluginModelListOptions): Promise<PluginModelCatalog>;
  stream(request: PluginModelRequest, options?: { readonly signal?: AbortSignal }): AsyncIterable<PluginModelEvent>;
}

export const pluginModelCatalogSchema = z.object({
  models: z.array(z.object({
    id: z.string().min(1),
    provider_id: z.string(),
    remote_id: z.string().min(1),
    display_name: z.string().min(1).optional(),
    max_context_size: z.number().int().min(0),
    effective_capabilities: z.array(z.string()).optional(),
    effective_protocol: z.enum(['anthropic', 'openai', 'openai_responses', 'google-genai']).optional(),
  }).strict()),
  connections: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    status: z.enum(['connected', 'error', 'unconfigured']),
    service: z.enum(['chat', 'decision']),
    default_model: z.string().min(1).optional(),
    models: z.array(z.string().min(1)).optional(),
    authentication: z.enum(['oauth', 'api-key', 'none']),
  }).strict()),
}).strict();
export type PluginModelCatalog = z.infer<typeof pluginModelCatalogSchema>;

export interface PluginCredentialStatus {
  readonly reference: { readonly kind: 'plugin-setting'; readonly setting: string };
  readonly configured: boolean;
}

/** Only this plugin's declared secret settings. Values are saved by Kiki's existing credential service. */
export interface PluginCredentialsApi {
  status(setting: string): Promise<PluginCredentialStatus>;
  set(setting: string, value: string | null): Promise<PluginCredentialStatus>;
}

/** Context for handlePanelRequest; model execution requires an admitted agent tool call. */
export interface PluginPanelContext {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly kikiHome?: string;
  readonly models: Pick<PluginModelsApi, 'list'>;
  readonly credentials: PluginCredentialsApi;
}

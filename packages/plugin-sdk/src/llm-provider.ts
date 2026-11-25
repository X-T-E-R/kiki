import { z } from 'zod';

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const nonEmptyString = z.string().min(1);

export const pluginLlmProviderReadinessSchema = /* @__PURE__ */ z.enum([
  'initializing',
  'ready',
  'auth_required',
  'degraded',
]);
export type PluginLlmProviderReadiness = z.infer<typeof pluginLlmProviderReadinessSchema>;

export const pluginModelCapabilitySchema = /* @__PURE__ */ z.enum([
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'always_thinking',
  'tool_use',
]);
export type PluginModelCapability = z.infer<typeof pluginModelCapabilitySchema>;

export const pluginModelDescriptorSchema = /* @__PURE__ */ z.object({
  id: nonEmptyString.max(256),
  wireModel: nonEmptyString.max(256),
  displayName: nonEmptyString.max(256).optional(),
  maxContextSize: z.number().int().positive().finite(),
  maxInputSize: z.number().int().positive().finite().optional(),
  maxOutputSize: z.number().int().positive().finite().optional(),
  capabilities: z.array(pluginModelCapabilitySchema),
  supportEfforts: z.array(nonEmptyString.max(64)).optional(),
  defaultEffort: nonEmptyString.max(64).optional(),
}).strict();
export type PluginModelDescriptor = Readonly<z.infer<typeof pluginModelDescriptorSchema>>;

export const llmProviderContributionDefinitionSchema = /* @__PURE__ */ z.object({
  schemaVersion: z.literal(1),
  id: slugSchema,
  label: nonEmptyString.max(128),
  description: z.string().max(1024).optional(),
  panelId: slugSchema.optional(),
  defaultModels: z.array(pluginModelDescriptorSchema).max(500).refine(
    (models) => new Set(models.map((item) => item.id)).size === models.length,
    'Duplicate default model id',
  ),
}).strict();
export type LlmProviderContributionDefinition = Readonly<z.infer<typeof llmProviderContributionDefinitionSchema>>;

export const pluginLlmProviderDescriptionSchema = /* @__PURE__ */ z.object({
  readiness: z.enum(['ready', 'auth_required', 'degraded']),
  statusText: z.string().max(512).optional(),
  accountSummary: z.string().max(256).optional(),
  models: z.array(pluginModelDescriptorSchema).max(500).refine(
    (models) => new Set(models.map((item) => item.id)).size === models.length,
    'Duplicate model id in provider description',
  ),
}).strict();
export type PluginLlmProviderDescription = Readonly<z.infer<typeof pluginLlmProviderDescriptionSchema>>;

export interface PluginLlmProviderContext {
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly dataDir: string;
  readonly kikiHome?: string;
}

export const pluginWireToolSchema = /* @__PURE__ */ z.object({
  name: nonEmptyString,
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  defer_loading: z.boolean().optional(),
}).strict();
export type PluginWireTool = Readonly<z.infer<typeof pluginWireToolSchema>>;

const mediaRefSchema = /* @__PURE__ */ z.object({
  url: nonEmptyString,
  id: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
}).strict();

export const pluginWireContentPartSchema = /* @__PURE__ */ z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
    presentation: z.unknown().optional(),
    attachment: z.object({
      fileId: nonEmptyString,
      mimeType: nonEmptyString,
      size: z.number().int().nonnegative(),
      name: z.string().optional(),
    }).strict().optional(),
    resourceLink: z.object({
      uri: nonEmptyString,
      name: z.string().optional(),
      mimeType: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    type: z.literal('think'),
    think: z.string(),
    encrypted: z.string().optional(),
    redacted: z.string().optional(),
    reasoningKey: z.string().optional(),
    reasoningDetails: z.array(z.record(z.string(), z.unknown())).optional(),
    hidden: z.boolean().optional(),
    reasoningOrigin: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('image_url'),
    imageUrl: mediaRefSchema,
  }).strict(),
  z.object({
    type: z.literal('audio_url'),
    audioUrl: mediaRefSchema,
  }).strict(),
  z.object({
    type: z.literal('video_url'),
    videoUrl: mediaRefSchema,
  }).strict(),
]);
export type PluginWireContentPart = Readonly<z.infer<typeof pluginWireContentPartSchema>>;

export const pluginWireToolCallSchema = /* @__PURE__ */ z.object({
  type: z.literal('function'),
  id: z.string(),
  name: nonEmptyString,
  arguments: z.string().nullable(),
  /**
   * SECURITY INVARIANT: Only non-sensitive round-trip metadata (e.g. wireName, origId, thoughtSignature, sigOrigin).
   * NEVER place raw or duplicate tool arguments in `extras` because `adhocEndpointVault` scrubs secrets ONLY from `arguments`!
   */
  extras: z.record(z.string(), z.unknown()).optional(),
  _streamIndex: z.union([z.number().int().nonnegative(), z.string()]).optional(),
}).strict();
export type PluginWireToolCall = Readonly<z.infer<typeof pluginWireToolCallSchema>>;

export const pluginWireToolCallPartSchema = /* @__PURE__ */ z.object({
  type: z.literal('tool_call_part'),
  argumentsPart: z.string().nullable(),
  index: z.union([z.number().int().nonnegative(), z.string()]).optional(),
}).strict();
export type PluginWireToolCallPart = Readonly<z.infer<typeof pluginWireToolCallPartSchema>>;

export const pluginWireStreamPartSchema = /* @__PURE__ */ z.union([
  pluginWireContentPartSchema,
  pluginWireToolCallSchema,
  pluginWireToolCallPartSchema,
]);
export type PluginWireStreamPart =
  | PluginWireContentPart
  | PluginWireToolCall
  | PluginWireToolCallPart;

export const pluginWireMessageSchema = /* @__PURE__ */ z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  name: z.string().optional(),
  content: z.array(pluginWireContentPartSchema),
  toolCalls: z.array(pluginWireToolCallSchema),
  toolCallId: z.string().optional(),
  partial: z.boolean().optional(),
  tools: z.array(pluginWireToolSchema).optional(),
}).strict();
export type PluginWireMessage = Readonly<z.infer<typeof pluginWireMessageSchema>>;

export const pluginWireUsageSchema = /* @__PURE__ */ z.object({
  inputOther: z.number().int().nonnegative().finite(),
  output: z.number().int().nonnegative().finite(),
  inputCacheRead: z.number().int().nonnegative().finite().optional(),
  inputCacheCreation: z.number().int().nonnegative().finite().optional(),
}).strict();
export type PluginWireUsage = Readonly<z.infer<typeof pluginWireUsageSchema>>;

export const pluginWireFinishReasonSchema = /* @__PURE__ */ z.enum([
  'completed',
  'tool_calls',
  'truncated',
  'filtered',
  'paused',
  'other',
]);
export type PluginWireFinishReason = z.infer<typeof pluginWireFinishReasonSchema>;

export const pluginWireGenerationOptionsSchema = /* @__PURE__ */ z.object({
  temperature: z.number().finite().min(0).optional(),
  topP: z.number().finite().min(0).max(1).optional(),
  maxCompletionTokens: z.number().int().positive().finite().optional(),
  maxContextSize: z.number().int().positive().finite().optional(),
  maxInputSize: z.number().int().positive().finite().optional(),
  thinking: z.object({
    effort: nonEmptyString,
    keep: z.string().optional(),
  }).strict().optional(),
  toolChoice: z.union([
    z.enum(['auto', 'none', 'required']),
    z.object({ type: z.literal('function'), name: nonEmptyString }).strict(),
  ]).optional(),
  responseFormat: z.discriminatedUnion('type', [
    z.object({ type: z.literal('json_object') }).strict(),
    z.object({
      type: z.literal('json_schema'),
      jsonSchema: z.object({
        name: nonEmptyString,
        schema: z.record(z.string(), z.unknown()),
        strict: z.boolean().optional(),
        description: z.string().optional(),
      }).strict(),
    }).strict(),
  ]).optional(),
  serviceTier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  requestParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  threadScopeKey: z.string().optional(),
  promptCacheKey: z.string().optional(),
}).strict();
export type PluginWireGenerationOptions = Readonly<z.infer<typeof pluginWireGenerationOptionsSchema>>;

export const pluginLlmStreamRequestSchema = /* @__PURE__ */ z.object({
  providerId: slugSchema,
  modelId: nonEmptyString,
  wireModel: nonEmptyString,
  systemPrompt: z.string(),
  tools: z.array(pluginWireToolSchema),
  history: z.array(pluginWireMessageSchema),
  options: pluginWireGenerationOptionsSchema,
}).strict();
export type PluginLlmStreamRequest = Readonly<z.infer<typeof pluginLlmStreamRequestSchema>>;

export const pluginWireStreamTerminalSchema = /* @__PURE__ */ z.object({
  id: z.string().nullable(),
  usage: pluginWireUsageSchema.nullable(),
  finishReason: pluginWireFinishReasonSchema.nullable(),
  rawFinishReason: z.string().nullable(),
  traceId: z.string().nullable().optional(),
  thinkingOnlyRecoveryBlocked: z.boolean().optional(),
}).strict();
export type PluginWireStreamTerminal = Readonly<z.infer<typeof pluginWireStreamTerminalSchema>>;

export const pluginWireFailureKindSchema = /* @__PURE__ */ z.enum([
  'cancelled',
  'connection',
  'timeout',
  'http',
  'auth',
  'rate_limit',
  'quota_exhausted',
  'overloaded',
  'context_overflow',
  'request_too_large',
  'filtered',
  'invalid_stream',
]);
export type PluginWireFailureKind = z.infer<typeof pluginWireFailureKindSchema>;

export const pluginWireFailureSchema = /* @__PURE__ */ z.object({
  kind: pluginWireFailureKindSchema,
  message: z.string().max(4096),
  status: z.number().int().min(100).max(599).optional(),
  requestId: z.string().max(256).optional(),
  traceId: z.string().max(256).optional(),
  retryAfterMs: z.number().finite().nonnegative().optional(),
  requestDispatched: z.boolean().optional(),
  retryable: z.boolean().optional(),
}).strict();
export type PluginWireFailure = Readonly<z.infer<typeof pluginWireFailureSchema>>;

export const pluginLlmStreamEventSchema = /* @__PURE__ */ z.discriminatedUnion('type', [
  z.object({ type: z.literal('sent') }).strict(),
  z.object({ type: z.literal('part'), part: pluginWireStreamPartSchema }).strict(),
  z.object({ type: z.literal('finish'), result: pluginWireStreamTerminalSchema }).strict(),
  z.object({ type: z.literal('error'), failure: pluginWireFailureSchema, usage: pluginWireUsageSchema.optional() }).strict(),
]);
export type PluginLlmStreamEvent =
  | { readonly type: 'sent' }
  | { readonly type: 'part'; readonly part: PluginWireStreamPart }
  | { readonly type: 'finish'; readonly result: PluginWireStreamTerminal }
  | { readonly type: 'error'; readonly failure: PluginWireFailure; readonly usage?: PluginWireUsage };

export interface LlmProviderAdapter {
  describe(context: PluginLlmProviderContext): Promise<PluginLlmProviderDescription>;
  stream(request: PluginLlmStreamRequest, context: PluginLlmProviderContext): AsyncIterable<PluginLlmStreamEvent>;
  forceRefreshAuth?(context: PluginLlmProviderContext): Promise<boolean>;
}

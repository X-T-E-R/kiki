/**
 * `modelResolver` — the engine's `IModelCatalog`: materialized model lookup
 * plus the read-only catalog enumeration over configured providers and model
 * aliases, and the global default-model selection. Mirrors
 * `agent-core-v2/kosong/model/catalog.ts`; wire shapes mirror
 * `protocol/src/modelCatalog.ts` and `protocol/src/rest/modelCatalog.ts`
 * (snake_case fields).
 */

import { z } from 'zod';

import type { ServiceContract, StreamingProcedureContract } from '../types.js';

export const modelCatalogItemSchema = z.object({
  provider: z.string(),
  model: z.string(),
  display_name: z.string().optional(),
  max_context_size: z.number(),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
});

export const providerCatalogStatusSchema = z.enum(['connected', 'error', 'unconfigured']);

export const requestIdentityPolicySchema = z.object({
  preset: z.enum(['codex_compatible', 'grok_build_compatible', 'kiki', 'none']),
  overrides: z
    .object({
      lineage: z
        .object({
          format: z.enum(['codex', 'grok_build', 'kiki', 'none']).optional(),
          session_scope: z.enum(['shared_session', 'agent_session', 'none']).optional(),
          thread_identity: z.enum(['agent', 'none']).optional(),
          parent_thread: z.enum(['immediate_agent', 'none']).optional(),
          subagent_marker: z.enum(['enabled', 'none']).optional(),
          turn_ancestry: z.enum(['spawn_context', 'none']).optional(),
        }).strict()
        .optional(),
      client: z
        .object({
          installation_identity: z.enum(['persistent_local', 'none']).optional(),
          originator: z
            .discriminatedUnion('mode', [
              z.object({ mode: z.literal('none') }).strict(),
              z.object({ mode: z.literal('codex_default') }).strict(),
              z.object({ mode: z.literal('custom'), value: z.string().min(1) }).strict(),
            ])
            .optional(),
          user_agent: z.enum(['codex', 'grok_build', 'host', 'none']).optional(),
        }).strict()
        .optional(),
      request: z
        .object({
          logical_id: z.enum(['turn', 'none']).optional(),
          turn_index: z.enum(['agent_session', 'none']).optional(),
        }).strict()
        .optional(),
      cache: z
        .object({
          source: z.enum(['session', 'none']).optional(),
          responses: z.enum(['prompt_cache_key', 'none']).optional(),
          messages: z.enum(['metadata_user_id', 'none']).optional(),
        }).strict()
        .optional(),
      responses_metadata: z.enum(['codex', 'none']).optional(),
    }).strict()
    .optional(),
}).strict();

export const providerCatalogItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  request_identity: requestIdentityPolicySchema.optional(),
  request_attribution: z.enum(['codex', 'kimi', 'kiki', 'none']).optional(),
  request_originator: z.string().optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string()).optional(),
});

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string(),
  model: modelCatalogItemSchema,
});

const generateInputSchema = z.object({
  systemPrompt: z.string(),
  messages: z.array(z.unknown()),
  tools: z.array(z.unknown()).optional(),
  responseFormat: z.unknown().optional(),
});

const generateParamsSchema = z.object({
  cacheKey: z.string().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  thinkingEffort: z.string().optional(),
  maxCompletionTokens: z.number().optional(),
}).optional();

const generateEventSchema = z.object({
  type: z.string(),
}).passthrough();

export const catalogContract = {
  listModels: { input: z.tuple([]), output: z.array(modelCatalogItemSchema) },
  listProviders: { input: z.tuple([]), output: z.array(providerCatalogItemSchema) },
  getProvider: { input: z.tuple([z.string()]), output: providerCatalogItemSchema },
  setDefaultModel: { input: z.tuple([z.string()]), output: setDefaultModelResponseSchema },
  generate: {
    input: z.tuple([z.string(), generateInputSchema, generateParamsSchema]),
    chunk: generateEventSchema,
    streaming: true,
  } as StreamingProcedureContract,
} satisfies ServiceContract;

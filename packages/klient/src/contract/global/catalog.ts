/**
 * `modelResolver` — the engine's `IModelCatalog`: materialized model lookup
 * plus the read-only catalog enumeration over configured providers and model
 * aliases, and the global default-model selection. The wire shapes are the
 * public ones owned by `@kiki/protocol` (`src/modelCatalog.ts`,
 * `src/rest/modelCatalog.ts`): a model's local `id`, its `provider_id` and the
 * exact `remote_id` sent upstream are three independent fields.
 */

import { RequestIdentityPolicyWireSchema } from '@kiki/agent-core-v2/kosong/requestIdentity/requestIdentityPolicy';
import {
  modelCatalogItemSchema,
  providerCatalogItemSchema,
  setDefaultModelResponseSchema,
} from '@kiki/protocol';
import { z } from 'zod';

import type { ServiceContract, StreamingProcedureContract } from '../types.js';

export const requestIdentityPolicySchema = RequestIdentityPolicyWireSchema;

export { modelCatalogItemSchema, providerCatalogItemSchema, setDefaultModelResponseSchema };

export const providerCatalogStatusSchema = z.enum(['connected', 'error', 'unconfigured']);

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

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
import { lazyContract } from '../lazyContract.js';

export const requestIdentityPolicySchema = RequestIdentityPolicyWireSchema;

export { modelCatalogItemSchema, providerCatalogItemSchema, setDefaultModelResponseSchema };

export const providerCatalogStatusSchema = /* @__PURE__ */ z.enum(['connected', 'error', 'unconfigured']);

export const catalogContract = {
  listModels: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(modelCatalogItemSchema) }), 'input', 'output'),
  listProviders: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(providerCatalogItemSchema) }), 'input', 'output'),
  getProvider: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: providerCatalogItemSchema }), 'input', 'output'),
  setDefaultModel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: setDefaultModelResponseSchema }), 'input', 'output'),
  generate: /* @__PURE__ */ lazyContract((): StreamingProcedureContract => ({
    input: z.tuple([
      z.string(),
      z.object({
        systemPrompt: z.string(),
        messages: z.array(z.unknown()),
        tools: z.array(z.unknown()).optional(),
        responseFormat: z.unknown().optional(),
      }),
      z.object({
        cacheKey: z.string().optional(),
        temperature: z.number().optional(),
        topP: z.number().optional(),
        thinkingEffort: z.string().optional(),
        maxCompletionTokens: z.number().optional(),
      }).optional(),
    ]),
    chunk: z.object({ type: z.string() }).passthrough(),
    streaming: true,
  }), 'input', 'chunk', 'streaming'),
} satisfies ServiceContract;

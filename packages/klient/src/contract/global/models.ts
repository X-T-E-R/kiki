/**
 * `modelService` — model configuration registry. Mirrors
 * `agent-core-v2/kosong/model/model.ts` (`ModelRecordSchema`, including its
 * passthrough of unknown keys) and `agent-core-v2/kosong/protocol/protocol.ts`
 * (`ProtocolSchema` — the four real wire protocols; `kimi` is a provider
 * `type`, not a protocol, and Vertex AI is a `providerOptions` mode of
 * `google-genai`). The schema name stays `modelConfigSchema` while the
 * engine type is `ModelRecord` — the contract-parity test pins that pairing.
 */

import { OAuthRefSchema as oAuthRefSchema, RequestIdentityPolicySchema } from './engine-schemas.js';
import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

const protocolSchema = /* @__PURE__ */ z.enum([
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
]);

const modelBaseSchema = /* @__PURE__ */ z.object({
  providerId: z.string().optional(),

  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: oAuthRefSchema.optional(),

  protocol: protocolSchema.optional(),

  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),

  provider: z.string().optional(),
  model: z.string().optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  betaApi: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  contextStrategy: z.enum(['summarize', 'auto', 'fresh']).optional(),
  requestIdentity: RequestIdentityPolicySchema.optional(),
});

const modelOverrideSchema = /* @__PURE__ */ modelBaseSchema
  .omit({
    providerId: true,
    baseUrl: true,
    apiKey: true,
    oauth: true,
    protocol: true,
    name: true,
    aliases: true,
    provider: true,
    model: true,
    betaApi: true,
    requestIdentity: true,
  })
  .partial();

export const modelConfigSchema = /* @__PURE__ */ modelBaseSchema
  .extend({ overrides: modelOverrideSchema.optional(), pricingModel: z.string().trim().min(1).optional() })
  .passthrough();

export const modelsContract = {
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(modelConfigSchema) }), 'input', 'output'),
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.record(z.string(), modelConfigSchema) }), 'input', 'output'),
  set: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), modelConfigSchema]), output: noResult }), 'input', 'output'),
  delete: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

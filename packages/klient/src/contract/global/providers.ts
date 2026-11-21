/**
 * `providerService` — provider configuration registry. Mirrors
 * `agent-core-v2/kosong/provider/provider.ts` (`ProviderConfigSchema`).
 * `type` is free-form text, not an enum: vendor identity is validated at
 * resolve time against the engine's provider-definition registry, so external
 * packages can register new vendors without touching this schema.
 */

import {
  AnthropicMessageThreadsLayerSchema,
  RequestCompressionLayerSchema,
  ResponsesWebSocketLayerSchema,
} from '@kiki/agent-core-v2/kosong/provider/requestCompression';
import { RequestIdentityPolicySchema } from '@kiki/agent-core-v2/kosong/requestIdentity/requestIdentityPolicy';
import { OAuthRefSchema as oAuthRefSchema } from '@kiki/agent-core-v2/kosong/provider/oauthRef';
import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

const providerTypeSchema = /* @__PURE__ */ z.string();

const stringRecordSchema = /* @__PURE__ */ z.record(z.string(), z.string());

const modelSourceSchema = /* @__PURE__ */ z.enum(['static', 'discover', 'oauth-catalog']);

export const requestIdentityPolicySchema = RequestIdentityPolicySchema;

const providerConfigObjectSchema = /* @__PURE__ */ z.object({
  modelSource: modelSourceSchema.optional(),
  enabled: z.boolean().optional(),

  baseUrl: z.string().optional(),
  customHeaders: stringRecordSchema.optional(),
  defaultModel: z.string().optional(),
  requestIdentity: requestIdentityPolicySchema.optional(),
  requestCompression: RequestCompressionLayerSchema.optional(),
  responsesWebSocket: ResponsesWebSocketLayerSchema.optional(),
  anthropicMessageThreads: AnthropicMessageThreadsLayerSchema.optional(),

  type: providerTypeSchema.optional(),
  apiKey: z.string().optional(),
  credentialId: z.string().optional(),
  oauth: oAuthRefSchema.optional(),
  env: stringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export const providerConfigSchema = /* @__PURE__ */ z.preprocess((value, ctx) => {
  if (value !== null && typeof value === 'object') {
    for (const removed of ['requestAttribution', 'requestOriginator'] as const) {
      if (removed in value) {
        ctx.addIssue({
          code: 'custom',
          message: `${removed} was removed; use requestIdentity`,
          path: [removed],
        });
      }
    }
  }
  return value;
}, providerConfigObjectSchema);

export const providersContract = {
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(providerConfigSchema) }), 'input', 'output'),
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.record(z.string(), providerConfigSchema) }), 'input', 'output'),
  set: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), providerConfigSchema]), output: noResult }), 'input', 'output'),
  delete: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

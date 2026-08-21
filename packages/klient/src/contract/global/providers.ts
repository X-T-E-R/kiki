/**
 * `providerService` — provider configuration registry. Mirrors
 * `agent-core-v2/kosong/provider/provider.ts` (`ProviderConfigSchema`).
 * `type` is free-form text, not an enum: vendor identity is validated at
 * resolve time against the engine's provider-definition registry, so external
 * packages can register new vendors without touching this schema.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const providerTypeSchema = z.string();

const oAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

const stringRecordSchema = z.record(z.string(), z.string());

const modelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);

export const requestIdentityPolicySchema = z.object({
  preset: z.enum(['codex_compatible', 'grok_build_compatible', 'kimi_code', 'none']),
  overrides: z
    .object({
      lineage: z
        .object({
          format: z.enum(['codex', 'grok_build', 'kimi_code', 'none']).optional(),
          sessionScope: z.enum(['shared_session', 'agent_session', 'none']).optional(),
          threadIdentity: z.enum(['agent', 'none']).optional(),
          parentThread: z.enum(['immediate_agent', 'none']).optional(),
          subagentMarker: z.enum(['enabled', 'none']).optional(),
          turnAncestry: z.enum(['spawn_context', 'none']).optional(),
        }).strict()
        .optional(),
      client: z
        .object({
          installationIdentity: z.enum(['persistent_local', 'none']).optional(),
          originator: z
            .discriminatedUnion('mode', [
              z.object({ mode: z.literal('none') }).strict(),
              z.object({ mode: z.literal('codex_default') }).strict(),
              z.object({ mode: z.literal('custom'), value: z.string() }).strict(),
            ])
            .optional(),
          userAgent: z.enum(['codex', 'grok_build', 'kimi_code', 'host', 'none']).optional(),
        }).strict()
        .optional(),
      request: z
        .object({
          logicalId: z.enum(['turn', 'none']).optional(),
          turnIndex: z.enum(['agent_session', 'none']).optional(),
        }).strict()
        .optional(),
      cache: z
        .object({
          source: z.enum(['session', 'none']).optional(),
          responses: z.enum(['prompt_cache_key', 'none']).optional(),
          messages: z.enum(['metadata_user_id', 'none']).optional(),
        }).strict()
        .optional(),
      responsesMetadata: z.enum(['codex', 'none']).optional(),
    }).strict()
    .optional(),
}).strict();

const providerConfigObjectSchema = z.object({
  modelSource: modelSourceSchema.optional(),

  baseUrl: z.string().optional(),
  customHeaders: stringRecordSchema.optional(),
  defaultModel: z.string().optional(),
  requestIdentity: requestIdentityPolicySchema.optional(),

  type: providerTypeSchema.optional(),
  apiKey: z.string().optional(),
  oauth: oAuthRefSchema.optional(),
  env: stringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export const providerConfigSchema = z.preprocess((value, ctx) => {
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
  get: { input: z.tuple([z.string()]), output: maybe(providerConfigSchema) },
  list: { input: z.tuple([]), output: z.record(z.string(), providerConfigSchema) },
  set: { input: z.tuple([z.string(), providerConfigSchema]), output: noResult },
  delete: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;

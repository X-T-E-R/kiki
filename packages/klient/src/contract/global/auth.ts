/**
 * `oauthService` + `authSummaryService` — app-scope OAuth flow and auth
 * summary. Mirrors `agent-core-v2/app/auth/auth.ts`; wire shapes mirror
 * `protocol/src/rest/oauth.ts` (snake_case fields). `resolveTokenProvider`
 * and `getCachedAccessToken` are excluded (non-serializable).
 */

import { z } from 'zod';
import { connectOriginalOAuthRequestSchema, originalOAuthProbeSchema, originalOAuthRequestSchema, oAuthSourceSchema } from '@kiki/protocol';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const oAuthFlowStatusSchema = /* @__PURE__ */ z.enum([
  'pending',
  'authenticated',
  'denied',
  'failed',
  'expired',
  'cancelled',
]);

export const oAuthFlowStartSchema = /* @__PURE__ */ z.discriminatedUnion('status', [
  z.object({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('pending'),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    user_code: z.string(),
    expires_in: z.number(),
    interval: z.number(),
    expires_at: z.string(),
  }),
  z.object({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('authenticated'),
  }),
]);

export const oAuthFlowSnapshotSchema = /* @__PURE__ */ z.object({
  flow_id: z.string(),
  provider: z.string(),
  status: oAuthFlowStatusSchema,
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  user_code: z.string(),
  expires_in: z.number(),
  expires_at: z.string(),
  interval: z.number(),
  resolved_at: z.string().optional(),
  error_message: z.string().optional(),
});

export const oAuthLoginCancelResponseSchema = /* @__PURE__ */ z.object({
  cancelled: z.boolean(),
  status: oAuthFlowStatusSchema,
});

export const oAuthLogoutResponseSchema = /* @__PURE__ */ z.object({
  logged_out: z.literal(true),
  provider: z.string(),
});

export const authStatusSchema = /* @__PURE__ */ z.object({
  loggedIn: z.boolean(),
  provider: z.string().optional(),
});

/** Same shape as `refreshProviderModelsResponseSchema` in `./catalog.js` — keep in sync. */
export const refreshOAuthProviderModelsResponseSchema = /* @__PURE__ */ z.object({
  changed: z.array(
    z.object({
      provider_id: z.string(),
      provider_name: z.string(),
      added: z.number(),
      removed: z.number(),
    }),
  ),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ provider: z.string(), reason: z.string() })),
});

export const oAuthLoginOptionsSchema = /* @__PURE__ */ z.object({
  region: z.enum(['mainland-cn', 'global']).optional(),
});

export const oAuthMethodStatusSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  protocol: z.string(),
  signed_in: z.boolean(),
  auth_source: oAuthSourceSchema.optional(),
  connection_state: z.enum(['ready', 'refresh_required', 'reconnect_required', 'signed_out']).optional(),
  account: z.discriminatedUnion('state', [
    z.object({ state: z.literal('known'), id: z.string() }),
    z.object({ state: z.literal('unknown') }),
  ]),
  quota: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('known'),
      label: z.string(),
      remaining: z.number(),
      unit: z.enum(['count', 'percent']),
      reset_at: z.string().optional(),
    }),
    z.object({ state: z.literal('unknown') }),
  ]),
});

export const authContract = {
  probeOriginal: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([originalOAuthRequestSchema]), output: originalOAuthProbeSchema }), 'input', 'output'),
  connectOriginal: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([connectOriginalOAuthRequestSchema]), output: originalOAuthProbeSchema }), 'input', 'output'),
  listMethods: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(oAuthMethodStatusSchema) }), 'input', 'output'),
  startLogin: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().optional(), oAuthLoginOptionsSchema.optional()]),
    output: oAuthFlowStartSchema,
  }), 'input', 'output'),
  getFlow: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().optional()]),
    output: /* @__PURE__ */ maybe(oAuthFlowSnapshotSchema),
  }), 'input', 'output'),
  cancelLogin: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().optional()]),
    output: oAuthLoginCancelResponseSchema,
  }), 'input', 'output'),
  logout: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().optional()]), output: oAuthLogoutResponseSchema }), 'input', 'output'),
  status: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().optional()]), output: authStatusSchema }), 'input', 'output'),
  refreshOAuthProviderModels: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([]),
    output: refreshOAuthProviderModelsResponseSchema,
  }), 'input', 'output'),
} satisfies ServiceContract;

export const authSummaryContract = {
  summarize: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(authStatusSchema) }), 'input', 'output'),
  ensureReady: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().optional()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

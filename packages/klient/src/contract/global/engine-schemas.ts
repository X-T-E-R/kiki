import { z } from 'zod';

const REQUEST_IDENTITY_PROFILE_ID_PATTERN =
  /^(?:[a-z][a-z0-9_]{0,31}|custom:[a-z0-9][a-z0-9_-]{0,47})$/u;

const RequestIdentityPresetSchema = /* @__PURE__ */ z.enum([
  'codex_compatible',
  'claude_code_compatible',
  'grok_build_compatible',
  'opencode_compatible',
  'kimi_code',
  'none',
]);

const RequestIdentityProfileIdSchema = /* @__PURE__ */ z.string().regex(REQUEST_IDENTITY_PROFILE_ID_PATTERN);

const RequestIdentityOriginatorSchema = /* @__PURE__ */ z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('codex_default') }).strict(),
  z.object({
    mode: z.literal('custom'),
    value: z.string().min(1).refine((value) => !/[\u0000-\u001F\u007F]/u.test(value)),
  }).strict(),
]);

function hasDefinedLeaf(value: Record<string, unknown>): boolean {
  for (const entry of Object.values(value)) {
    if (entry === undefined) continue;
    if (typeof entry === 'object' && entry !== null) {
      if (hasDefinedLeaf(entry as Record<string, unknown>)) return true;
      continue;
    }
    return true;
  }
  return false;
}

function hasSelection(policy: { preset?: unknown; profile?: unknown; overrides?: unknown }): boolean {
  return policy.preset !== undefined || policy.profile !== undefined || policy.overrides !== undefined;
}

const RequestIdentityOverridesSchema = /* @__PURE__ */ z
  .object({
    lineage: z
      .object({
        format: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'none']).optional(),
        sessionScope: z.enum(['shared_session', 'agent_session', 'none']).optional(),
        branchSessionScope: z.enum(['follow_session_scope', 'shared_session', 'agent_session']).optional(),
        threadIdentity: z.enum(['agent', 'none']).optional(),
        parentThread: z.enum(['immediate_agent', 'none']).optional(),
        subagentMarker: z.enum(['enabled', 'none']).optional(),
        turnAncestry: z.enum(['spawn_context', 'none']).optional(),
      })
      .strict()
      .optional(),
    client: z
      .object({
        installationIdentity: z.enum(['persistent_local', 'none']).optional(),
        originator: RequestIdentityOriginatorSchema.optional(),
        userAgent: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'host', 'none']).optional(),
      })
      .strict()
      .optional(),
    request: z
      .object({
        logicalId: z.enum(['turn', 'none']).optional(),
        turnIndex: z.enum(['agent_session', 'none']).optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        source: z.enum(['session', 'none']).optional(),
        responses: z.enum(['prompt_cache_key', 'none']).optional(),
        messages: z.enum(['metadata_user_id', 'none']).optional(),
      })
      .strict()
      .optional(),
    responsesMetadata: z.enum(['codex', 'none']).optional(),
  })
  .strict()
  .refine(hasDefinedLeaf, { message: 'request identity overrides must contain a leaf value' });

export const RequestIdentityPolicySchema = /* @__PURE__ */ z
  .object({
    preset: RequestIdentityPresetSchema.optional(),
    profile: RequestIdentityProfileIdSchema.optional(),
    overrides: RequestIdentityOverridesSchema.optional(),
  })
  .strict()
  .refine(hasSelection, { message: 'request identity policy must contain preset, profile or overrides' })
  .refine((policy) => policy.preset === undefined || policy.profile === undefined, {
    message: 'request identity policy cannot set both preset and profile',
  });

const RequestIdentityOverridesWireSchema = /* @__PURE__ */ z
  .object({
    lineage: z
      .object({
        format: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'none']).optional(),
        session_scope: z.enum(['shared_session', 'agent_session', 'none']).optional(),
        branch_session_scope: z.enum(['follow_session_scope', 'shared_session', 'agent_session']).optional(),
        thread_identity: z.enum(['agent', 'none']).optional(),
        parent_thread: z.enum(['immediate_agent', 'none']).optional(),
        subagent_marker: z.enum(['enabled', 'none']).optional(),
        turn_ancestry: z.enum(['spawn_context', 'none']).optional(),
      })
      .strict()
      .optional(),
    client: z
      .object({
        installation_identity: z.enum(['persistent_local', 'none']).optional(),
        originator: RequestIdentityOriginatorSchema.optional(),
        user_agent: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'host', 'none']).optional(),
      })
      .strict()
      .optional(),
    request: z
      .object({
        logical_id: z.enum(['turn', 'none']).optional(),
        turn_index: z.enum(['agent_session', 'none']).optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        source: z.enum(['session', 'none']).optional(),
        responses: z.enum(['prompt_cache_key', 'none']).optional(),
        messages: z.enum(['metadata_user_id', 'none']).optional(),
      })
      .strict()
      .optional(),
    responses_metadata: z.enum(['codex', 'none']).optional(),
  })
  .strict()
  .refine(hasDefinedLeaf, { message: 'request identity overrides must contain a leaf value' });

export const RequestIdentityPolicyWireSchema = /* @__PURE__ */ z
  .object({
    preset: RequestIdentityPresetSchema.optional(),
    profile: RequestIdentityProfileIdSchema.optional(),
    overrides: RequestIdentityOverridesWireSchema.optional(),
  })
  .strict()
  .refine(hasSelection, { message: 'request identity policy must contain preset, profile or overrides' })
  .refine((policy) => policy.preset === undefined || policy.profile === undefined, {
    message: 'request identity policy cannot set both preset and profile',
  });

const ProviderTargetsSchema = /* @__PURE__ */ z
  .array(
    z.url().refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    }, 'Use an HTTP(S) API base URL without credentials, query, or fragment'),
  )
  .min(1);

const minBytes = /* @__PURE__ */ z.number().int().nonnegative().safe().optional();

const requestCompressionObject = /* @__PURE__ */ z
  .object({
    encoding: z.enum(['off', 'gzip', 'zstd']).optional(),
    targets: ProviderTargetsSchema.optional(),
    minBytes,
    dictionary: z.boolean().optional(),
  })
  .strict();

export const RequestCompressionLayerSchema = /* @__PURE__ */ requestCompressionObject.superRefine((value, ctx) => {
  const extra = value.targets !== undefined || value.minBytes !== undefined || value.dictionary !== undefined;
  if (value.encoding === 'off') {
    if (extra) {
      ctx.addIssue({ code: 'custom', message: 'encoding off cannot include other request_compression fields' });
    }
    return;
  }
  if (!extra && value.encoding === undefined) {
    ctx.addIssue({ code: 'custom', message: 'request_compression needs encoding, targets, min_bytes, or dictionary' });
  }
  if (value.encoding === 'gzip' && value.dictionary !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'dictionary applies only to encoding zstd', path: ['dictionary'] });
  }
});

export const RequestCompressionSystemSchema = /* @__PURE__ */ requestCompressionObject.superRefine((value, ctx) => {
  const parsed = RequestCompressionLayerSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
    return;
  }
  if (parsed.data.encoding === 'off') return;
  if (parsed.data.encoding === undefined) {
    ctx.addIssue({ code: 'custom', message: 'request_compression requires encoding', path: ['encoding'] });
  }
  if (parsed.data.targets === undefined || parsed.data.targets.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'request_compression requires targets', path: ['targets'] });
  }
});

const responsesWebSocketObject = /* @__PURE__ */ z
  .object({
    off: z.literal(true).optional(),
    targets: ProviderTargetsSchema.optional(),
  })
  .strict();

export const ResponsesWebSocketLayerSchema = /* @__PURE__ */ responsesWebSocketObject.superRefine((value, ctx) => {
  if (value.off === true) {
    if (value.targets !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'responses_web_socket off cannot include targets', path: ['targets'] });
    }
    return;
  }
  if (value.targets === undefined) {
    ctx.addIssue({ code: 'custom', message: 'responses_web_socket needs targets or off' });
  }
});

export const ResponsesWebSocketSystemSchema = ResponsesWebSocketLayerSchema;

export const AnthropicMessageThreadsLayerSchema = /* @__PURE__ */ z
  .object({
    mode: z.enum(['auto', 'off']),
  })
  .strict();

export const AnthropicMessageThreadsSystemSchema = AnthropicMessageThreadsLayerSchema;

const localOriginalOAuthSourceRefSchema = /* @__PURE__ */ z.object({
  kind: z.literal('local_original'),
  provider: z.enum(['openai-codex', 'grok-build', 'kimi-code']),
  homeDir: z.string().min(1),
  storageBackend: z.enum(['file', 'keyring', 'encrypted']),
  authFile: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
}).strict().superRefine((source, ctx) => {
  if (source.provider !== 'kimi-code' && source.accountId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'An original account identity is required.' });
  }
  if (source.provider === 'kimi-code' && (source.storageBackend === 'encrypted' || source.accountId !== undefined || source.userId !== undefined || source.scope !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Kimi Code sources select a credential slot, not an account identity.' });
  }
});

export const OAuthRefSchema = /* @__PURE__ */ z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
  source: localOriginalOAuthSourceRefSchema.optional(),
});

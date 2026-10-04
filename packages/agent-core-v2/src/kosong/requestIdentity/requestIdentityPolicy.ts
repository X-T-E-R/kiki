import type { ProviderConfig } from '#/kosong/provider/provider';
import { z } from 'zod';
import { Error2 } from '#/_base/errors/errors';
import { RequestIdentityErrors } from './errors';

export type RequestIdentityPreset =
  | 'codex_compatible'
  | 'claude_code_compatible'
  | 'grok_build_compatible'
  | 'opencode_compatible'
  | 'kimi_code'
  | 'none';

export type RequestIdentityLineageFormat = 'codex' | 'claude_code' | 'grok_build' | 'opencode' | 'kimi_code' | 'none';

export type RequestIdentityUserAgentMode =
  | 'codex'
  | 'claude_code'
  | 'grok_build'
  | 'opencode'
  | 'kimi_code'
  | 'host'
  | 'none';

export type RequestIdentityPolicy = {
  preset?: RequestIdentityPreset;
  profile?: string;
  overrides?: RequestIdentityOverrides;
};

/** Behaviour axes a named identity profile contributes when a layer selects it. */
export interface RequestIdentityProfileAxes {
  readonly preset: RequestIdentityPreset;
  readonly overrides?: RequestIdentityOverrides;
}

export type RequestIdentityProfileLookup = (id: string) => RequestIdentityProfileAxes | undefined;

/** Built-in ids are bare snake_case; user profiles live under `custom:`. */
export const REQUEST_IDENTITY_PROFILE_ID_PATTERN =
  /^(?:[a-z][a-z0-9_]{0,31}|custom:[a-z0-9][a-z0-9_-]{0,47})$/u;

/** Built-in profile id each preset maps to. */
export const BUILTIN_PROFILE_FOR_PRESET: Readonly<Record<RequestIdentityPreset, string>> = {
  codex_compatible: 'codex',
  claude_code_compatible: 'claude_code',
  grok_build_compatible: 'grok_build',
  opencode_compatible: 'opencode',
  kimi_code: 'kimi_code',
  none: 'none',
};

export function builtinRequestIdentityProfileAxes(
  id: string,
): RequestIdentityProfileAxes | undefined {
  for (const [preset, builtinId] of Object.entries(BUILTIN_PROFILE_FOR_PRESET)) {
    if (builtinId === id) return { preset: preset as RequestIdentityPreset };
  }
  return undefined;
}

export type RequestIdentityOverrides = {
  lineage?: {
    format?: RequestIdentityLineageFormat;
    sessionScope?: 'shared_session' | 'agent_session' | 'none';
    threadIdentity?: 'agent' | 'none';
    parentThread?: 'immediate_agent' | 'none';
    subagentMarker?: 'enabled' | 'none';
    turnAncestry?: 'spawn_context' | 'none';
  };
  client?: {
    installationIdentity?: 'persistent_local' | 'none';
    originator?:
      | { mode: 'none' }
      | { mode: 'codex_default' }
      | { mode: 'custom'; value: string };
    userAgent?: RequestIdentityUserAgentMode;
  };
  request?: {
    logicalId?: 'turn' | 'none';
    turnIndex?: 'agent_session' | 'none';
  };
  cache?: {
    source?: 'session' | 'none';
    responses?: 'prompt_cache_key' | 'none';
    messages?: 'metadata_user_id' | 'none';
  };
  responsesMetadata?: 'codex' | 'none';
};

const RequestIdentityPresetSchema = z.enum([
  'codex_compatible',
  'claude_code_compatible',
  'grok_build_compatible',
  'opencode_compatible',
  'kimi_code',
  'none',
]);

export const RequestIdentityProfileIdSchema = z.string().regex(REQUEST_IDENTITY_PROFILE_ID_PATTERN);

const RequestIdentityOriginatorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('codex_default') }).strict(),
  z.object({
    mode: z.literal('custom'),
    value: z.string().min(1).refine((value) => !/[\u0000-\u001F\u007F]/u.test(value)),
  }).strict(),
]);

const RequestIdentityOverridesSchema: z.ZodType<RequestIdentityOverrides> = z
  .object({
    lineage: z
      .object({
        format: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'none']).optional(),
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
        originator: RequestIdentityOriginatorSchema.optional(),
        userAgent: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'host', 'none']).optional(),
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
  })
  .strict()
  .refine(hasDefinedLeaf, { message: 'request identity overrides must contain a leaf value' });

export const RequestIdentityPolicySchema: z.ZodType<RequestIdentityPolicy> = z
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

const RequestIdentityOverridesWireSchema = z
  .object({
    lineage: z
      .object({
        format: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'none']).optional(),
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
        originator: RequestIdentityOriginatorSchema.optional(),
        user_agent: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'host', 'none']).optional(),
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
  })
  .strict()
  .refine(hasDefinedLeaf, { message: 'request identity overrides must contain a leaf value' });

export const RequestIdentityPolicyWireSchema = z
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

export type RequestIdentityPolicyWire = z.infer<typeof RequestIdentityPolicyWireSchema>;

export function requestIdentityToWire(
  policy: RequestIdentityPolicy | undefined,
): RequestIdentityPolicyWire | undefined {
  if (policy === undefined) return undefined;
  const overrides = policy.overrides;
  return {
    preset: policy.preset,
    profile: policy.profile,
    overrides:
      overrides === undefined
        ? undefined
        : {
            lineage:
              overrides.lineage === undefined
                ? undefined
                : {
                    format: overrides.lineage.format,
                    session_scope: overrides.lineage.sessionScope,
                    thread_identity: overrides.lineage.threadIdentity,
                    parent_thread: overrides.lineage.parentThread,
                    subagent_marker: overrides.lineage.subagentMarker,
                    turn_ancestry: overrides.lineage.turnAncestry,
                  },
            client:
              overrides.client === undefined
                ? undefined
                : {
                    installation_identity: overrides.client.installationIdentity,
                    originator: overrides.client.originator,
                    user_agent: overrides.client.userAgent,
                  },
            request:
              overrides.request === undefined
                ? undefined
                : {
                    logical_id: overrides.request.logicalId,
                    turn_index: overrides.request.turnIndex,
                  },
            cache: overrides.cache,
            responses_metadata: overrides.responsesMetadata,
          },
  };
}

export function requestIdentityFromWire(
  policy: RequestIdentityPolicyWire,
): RequestIdentityPolicy {
  const overrides = policy.overrides;
  return {
    preset: policy.preset,
    profile: policy.profile,
    overrides:
      overrides === undefined
        ? undefined
        : {
            lineage:
              overrides.lineage === undefined
                ? undefined
                : {
                    format: overrides.lineage.format,
                    sessionScope: overrides.lineage.session_scope,
                    threadIdentity: overrides.lineage.thread_identity,
                    parentThread: overrides.lineage.parent_thread,
                    subagentMarker: overrides.lineage.subagent_marker,
                    turnAncestry: overrides.lineage.turn_ancestry,
                  },
            client:
              overrides.client === undefined
                ? undefined
                : {
                    installationIdentity: overrides.client.installation_identity,
                    originator: overrides.client.originator,
                    userAgent: overrides.client.user_agent,
                  },
            request:
              overrides.request === undefined
                ? undefined
                : {
                    logicalId: overrides.request.logical_id,
                    turnIndex: overrides.request.turn_index,
                  },
            cache: overrides.cache,
            responsesMetadata: overrides.responses_metadata,
          },
  };
}

export type ResolvedRequestIdentityPolicy = {
  lineage: {
    format: RequestIdentityLineageFormat;
    sessionScope: 'shared_session' | 'agent_session' | 'none';
    threadIdentity: 'agent' | 'none';
    parentThread: 'immediate_agent' | 'none';
    subagentMarker: 'enabled' | 'none';
    turnAncestry: 'spawn_context' | 'none';
  };
  client: {
    installationIdentity: 'persistent_local' | 'none';
    originator:
      | { mode: 'none' }
      | { mode: 'codex_default' }
      | { mode: 'custom'; value: string };
    userAgent: RequestIdentityUserAgentMode;
  };
  request: {
    logicalId: 'turn' | 'none';
    turnIndex: 'agent_session' | 'none';
  };
  cache: {
    source: 'session' | 'none';
    responses: 'prompt_cache_key' | 'none';
    messages: 'metadata_user_id' | 'none';
  };
  responsesMetadata: 'codex' | 'none';
  preset: RequestIdentityPreset;
  /** Identity profile whose client templates (version, User-Agent, headers, params) this policy renders. */
  profile: string;
};

const PRESETS: Record<RequestIdentityPreset, Omit<ResolvedRequestIdentityPolicy, 'preset' | 'profile'>> = {
  codex_compatible: {
    lineage: {
      format: 'codex',
      sessionScope: 'shared_session',
      threadIdentity: 'agent',
      parentThread: 'immediate_agent',
      subagentMarker: 'enabled',
      turnAncestry: 'spawn_context',
    },
    client: {
      installationIdentity: 'persistent_local',
      originator: { mode: 'codex_default' },
      userAgent: 'codex',
    },
    request: { logicalId: 'turn', turnIndex: 'none' },
    cache: { source: 'session', responses: 'prompt_cache_key', messages: 'none' },
    responsesMetadata: 'codex',
  },
  grok_build_compatible: {
    lineage: {
      format: 'grok_build',
      sessionScope: 'agent_session',
      threadIdentity: 'none',
      parentThread: 'none',
      subagentMarker: 'none',
      turnAncestry: 'none',
    },
    client: {
      installationIdentity: 'persistent_local',
      originator: { mode: 'none' },
      userAgent: 'grok_build',
    },
    request: { logicalId: 'turn', turnIndex: 'agent_session' },
    cache: { source: 'session', responses: 'prompt_cache_key', messages: 'none' },
    responsesMetadata: 'none',
  },
  claude_code_compatible: {
    lineage: {
      format: 'claude_code',
      sessionScope: 'shared_session',
      threadIdentity: 'none',
      parentThread: 'none',
      subagentMarker: 'none',
      turnAncestry: 'none',
    },
    client: {
      installationIdentity: 'persistent_local',
      originator: { mode: 'none' },
      userAgent: 'claude_code',
    },
    request: { logicalId: 'none', turnIndex: 'none' },
    cache: { source: 'session', responses: 'none', messages: 'metadata_user_id' },
    responsesMetadata: 'none',
  },
  opencode_compatible: {
    lineage: {
      format: 'opencode',
      sessionScope: 'agent_session',
      threadIdentity: 'none',
      parentThread: 'none',
      subagentMarker: 'none',
      turnAncestry: 'none',
    },
    client: {
      installationIdentity: 'none',
      originator: { mode: 'none' },
      userAgent: 'opencode',
    },
    request: { logicalId: 'turn', turnIndex: 'none' },
    cache: { source: 'none', responses: 'none', messages: 'none' },
    responsesMetadata: 'none',
  },
  kimi_code: {
    lineage: {
      format: 'kimi_code',
      sessionScope: 'shared_session',
      threadIdentity: 'none',
      parentThread: 'none',
      subagentMarker: 'none',
      turnAncestry: 'none',
    },
    client: {
      installationIdentity: 'persistent_local',
      originator: { mode: 'none' },
      userAgent: 'kimi_code',
    },
    request: { logicalId: 'none', turnIndex: 'none' },
    cache: { source: 'session', responses: 'prompt_cache_key', messages: 'metadata_user_id' },
    responsesMetadata: 'none',
  },
  none: {
    lineage: {
      format: 'none',
      sessionScope: 'none',
      threadIdentity: 'none',
      parentThread: 'none',
      subagentMarker: 'none',
      turnAncestry: 'none',
    },
    client: {
      installationIdentity: 'none',
      originator: { mode: 'none' },
      userAgent: 'none',
    },
    request: { logicalId: 'none', turnIndex: 'none' },
    cache: { source: 'none', responses: 'none', messages: 'none' },
    responsesMetadata: 'none',
  },
};

let registeredProfileLookup: RequestIdentityProfileLookup | undefined;

/**
 * Install the process-wide lookup for custom identity profiles. The App-scope catalog owns the
 * profiles; config validation that runs outside DI (model/provider writes) resolves through it.
 * Returns a disposer that restores the previous lookup.
 */
export function registerRequestIdentityProfileLookup(lookup: RequestIdentityProfileLookup): () => void {
  const previous = registeredProfileLookup;
  registeredProfileLookup = lookup;
  return () => {
    if (registeredProfileLookup === lookup) registeredProfileLookup = previous;
  };
}

function defaultProfileLookup(id: string): RequestIdentityProfileAxes | undefined {
  return builtinRequestIdentityProfileAxes(id) ?? registeredProfileLookup?.(id);
}

export function resolveRequestIdentityLayers(
  ...layers: readonly (RequestIdentityPolicy | undefined)[]
): ResolvedRequestIdentityPolicy {
  return resolveRequestIdentityLayersWith(defaultProfileLookup, ...layers);
}

/** Resolve layers, expanding each layer's `profile` reference through `lookup`; an unknown id is rejected. */
export function resolveRequestIdentityLayersWith(
  lookup: RequestIdentityProfileLookup,
  ...layers: readonly (RequestIdentityPolicy | undefined)[]
): ResolvedRequestIdentityPolicy {
  let resolved: ResolvedRequestIdentityPolicy = {
    ...structuredClone(PRESETS.kimi_code),
    preset: 'kimi_code',
    profile: BUILTIN_PROFILE_FOR_PRESET.kimi_code,
  };
  validateResolvedRequestIdentity(resolved);
  for (const layer of layers) {
    if (layer === undefined) continue;
    resolved = applyRequestIdentityLayer(resolved, expandProfileLayer(layer, lookup));
    validateResolvedRequestIdentity(resolved);
  }
  return resolved;
}

export function resolveAuthoredRequestIdentity(
  policy: RequestIdentityPolicy,
): ResolvedRequestIdentityPolicy {
  return resolveRequestIdentityLayers(policy);
}

export function defaultOAuthRequestIdentity(
  provider: Pick<ProviderConfig, 'oauth'> | undefined,
): RequestIdentityPolicy | undefined {
  if (provider?.oauth?.key === 'oauth/openai-codex') return { profile: 'codex' };
  if (provider?.oauth?.key === 'oauth/grok-build') return { profile: 'grok_build' };
  return undefined;
}

export function resolveProviderRequestIdentity(
  provider: ProviderConfig | undefined,
): ResolvedRequestIdentityPolicy {
  return resolveRequestIdentityLayers(defaultOAuthRequestIdentity(provider), provider?.requestIdentity);
}

function expandProfileLayer(
  layer: RequestIdentityPolicy,
  lookup: RequestIdentityProfileLookup,
): RequestIdentityPolicy {
  if (layer.profile === undefined) return layer;
  const axes = lookup(layer.profile);
  if (axes === undefined) throw invalid(`request identity profile ${layer.profile} does not exist`);
  const expanded: RequestIdentityPolicy = { preset: axes.preset, profile: layer.profile, overrides: axes.overrides };
  const withProfile = applyRequestIdentityLayer(
    { ...structuredClone(PRESETS[axes.preset]), preset: axes.preset, profile: layer.profile },
    expanded,
  );
  validateResolvedRequestIdentity(withProfile);
  return layer.overrides === undefined
    ? expanded
    : { ...expanded, overrides: mergeOverrides(axes.overrides, layer.overrides) };
}

function mergeOverrides(
  base: RequestIdentityOverrides | undefined,
  patch: RequestIdentityOverrides,
): RequestIdentityOverrides {
  return {
    lineage: base?.lineage === undefined && patch.lineage === undefined ? undefined : { ...base?.lineage, ...definedOnly(patch.lineage) },
    client: base?.client === undefined && patch.client === undefined ? undefined : { ...base?.client, ...definedOnly(patch.client) },
    request: base?.request === undefined && patch.request === undefined ? undefined : { ...base?.request, ...definedOnly(patch.request) },
    cache: base?.cache === undefined && patch.cache === undefined ? undefined : { ...base?.cache, ...definedOnly(patch.cache) },
    responsesMetadata: patch.responsesMetadata ?? base?.responsesMetadata,
  };
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(value).filter(([, leaf]) => leaf !== undefined)) as Partial<T>;
}

function applyRequestIdentityLayer(
  inherited: ResolvedRequestIdentityPolicy,
  layer: RequestIdentityPolicy,
): ResolvedRequestIdentityPolicy {
  const base: ResolvedRequestIdentityPolicy =
    layer.preset === undefined
      ? structuredClone(inherited)
      : {
          ...structuredClone(PRESETS[layer.preset]),
          preset: layer.preset,
          profile: layer.profile ?? BUILTIN_PROFILE_FOR_PRESET[layer.preset],
        };
  const overrides = layer.overrides;
  if (overrides?.lineage !== undefined) assignDefined(base.lineage, overrides.lineage);
  if (overrides?.client !== undefined) assignDefined(base.client, overrides.client);
  if (overrides?.request !== undefined) assignDefined(base.request, overrides.request);
  if (overrides?.cache !== undefined) assignDefined(base.cache, overrides.cache);
  if (overrides?.responsesMetadata !== undefined) {
    base.responsesMetadata = overrides.responsesMetadata;
  }
  return base;
}

export function validateResolvedRequestIdentity(
  policy: Omit<ResolvedRequestIdentityPolicy, 'preset' | 'profile'>,
): void {
  if (policy.request.turnIndex === 'agent_session' && policy.lineage.sessionScope !== 'agent_session') {
    throw invalid('request turnIndex=agent_session requires lineage sessionScope=agent_session');
  }
  if (policy.cache.source === 'session' && policy.lineage.sessionScope === 'none') {
    throw invalid('cache source=session requires a non-none session scope');
  }
  if (policy.request.logicalId === 'turn' && !['codex', 'grok_build', 'opencode'].includes(policy.lineage.format)) {
    throw invalid('logicalId=turn requires a Codex, Grok Build or OpenCode projector');
  }
  if (
    policy.cache.messages === 'metadata_user_id' &&
    policy.lineage.format !== 'kimi_code' &&
    policy.lineage.format !== 'claude_code'
  ) {
    throw invalid('messages metadata_user_id is only supported by the Kimi Code or Claude Code projector');
  }
  if (policy.responsesMetadata === 'codex' && policy.lineage.format !== 'codex') {
    throw invalid('responsesMetadata=codex requires the Codex projector');
  }
  if (policy.lineage.format === 'opencode' && (
    policy.lineage.threadIdentity !== 'none' ||
    policy.lineage.parentThread !== 'none' ||
    policy.lineage.subagentMarker !== 'none' ||
    policy.lineage.turnAncestry !== 'none'
  )) {
    throw invalid('the OpenCode projector does not support thread or parent lineage');
  }
  if (policy.lineage.format === 'grok_build' || policy.lineage.format === 'claude_code') {
    if (
      policy.lineage.threadIdentity !== 'none' ||
      policy.lineage.parentThread !== 'none' ||
      policy.lineage.subagentMarker !== 'none' ||
      policy.lineage.turnAncestry !== 'none'
    ) {
      throw invalid(
        `the ${policy.lineage.format === 'grok_build' ? 'Grok Build' : 'Claude Code'} projector does not support thread or parent lineage`,
      );
    }
  }
  if (
    policy.client.originator.mode !== 'none' &&
    !['codex', 'kimi_code'].includes(policy.lineage.format)
  ) {
    throw invalid('originator requires the Codex or Kimi Code projector');
  }
  if (policy.client.originator.mode === 'custom') validateOriginator(policy.client.originator.value);
}

export function validateOriginator(value: string): void {
  if (value.length === 0 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw invalid('request originator must be non-empty and contain no control characters');
  }
}

export const REQUEST_IDENTITY_RESERVED_HEADERS = new Set([
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-codex-parent-thread-id',
  'x-codex-installation-id',
  'x-openai-subagent',
  'x-codex-window-id',
  'x-codex-turn-metadata',
  'x-codex-turn-state',
  'x-grok-conv-id',
  'x-grok-session-id',
  'x-grok-req-id',
  'x-grok-turn-idx',
  'x-grok-agent-id',
  'x-grok-client-identifier',
  'x-grok-client-version',
  'x-grok-model-override',
  'x-claude-code-session-id',
  'x-opencode-session',
  'x-opencode-request',
  'x-opencode-client',
  'x-opencode-project',
  'x-msh-platform',
  'x-msh-version',
  'x-msh-device-name',
  'x-msh-device-model',
  'x-msh-os-version',
  'x-msh-device-id',
  'originator',
  'user-agent',
]);

function hasSelection(policy: { preset?: unknown; profile?: unknown; overrides?: unknown }): boolean {
  return policy.preset !== undefined || policy.profile !== undefined || policy.overrides !== undefined;
}

function hasDefinedLeaf(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== 'object') return true;
  return Object.values(value).some(hasDefinedLeaf);
}

function invalid(message: string): Error2 {
  return new Error2(RequestIdentityErrors.codes.REQUEST_IDENTITY_INVALID, message);
}

function assignDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) Reflect.set(target, key, cloneAssignedValue(value));
  }
}

function cloneAssignedValue<T>(value: T): T {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

import { describe, expect, it } from 'vitest';

import {
  requestIdentityFromWire,
  requestIdentityToWire,
  defaultOAuthRequestIdentity,
  resolveAuthoredRequestIdentity,
  resolveProviderRequestIdentity,
  resolveRequestIdentityLayers,
  resolveRequestIdentityLayersWith,
  RequestIdentityPolicySchema,
  RequestIdentityPolicyWireSchema,
  type RequestIdentityPolicy,
} from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity, resolveRequestIdentitySessionScope } from '#/kosong/requestIdentity/requestIdentityProjector';

const SNAPSHOT = {
  installationId: '00000000-0000-4000-8000-000000000001',
  sharedSessionId: '00000000-0000-4000-8000-000000000002',
  threadId: '00000000-0000-4000-8000-000000000003',
  agentSessionId: '00000000-0000-4000-8000-000000000004',
  logicalId: '00000000-0000-7000-8000-000000000005',
  turnIndex: 1,
  parentTurnId: '00000000-0000-7000-8000-000000000006',
  rootTurnId: '00000000-0000-7000-8000-000000000007',
  parentThreadId: '00000000-0000-4000-8000-000000000008',
  windowId: '00000000-0000-4000-8000-000000000003:1',
  setTurnState: () => undefined,
};

function project(
  policy: RequestIdentityPolicy,
  options: {
    isKimiProvider?: boolean;
    protocol?: 'openai_responses' | 'anthropic' | 'google-genai';
    model?: string;
    pricingModel?: string;
    isBranch?: boolean;
    hostRequestHeaders?: Readonly<Record<string, string>>;
    snapshot?: typeof SNAPSHOT;
  } = {},
) {
  return projectRequestIdentity({
    policy: resolveAuthoredRequestIdentity(policy),
    protocol: options.protocol ?? 'openai_responses',
    model: options.model ?? 'wire-model',
    pricingModel: options.pricingModel,
    isBranch: options.isBranch,
    rawSessionId: 'raw-session',
    rawAgentId: 'child',
    parentAgentId: 'main',
    subagentKind: 'agent',
    isKimiProvider: options.isKimiProvider ?? false,
    snapshot: options.snapshot ?? SNAPSHOT,
    runtimeVersion: '1.0.0',
    platform: 'linux',
    arch: 'x64',
    hostRequestHeaders: options.hostRequestHeaders,
  });
}

describe('request identity policy', () => {
  it.each([
    ['codex_compatible', 'codex', 'shared_session', 'codex'],
    ['claude_code_compatible', 'claude_code', 'shared_session', 'claude_code'],
    ['grok_build_compatible', 'grok_build', 'agent_session', 'grok_build'],
    ['opencode_compatible', 'opencode', 'agent_session', 'opencode'],
    ['kimi_code', 'kimi_code', 'agent_session', 'kimi_code'],
    ['none', 'none', 'none', 'none'],
  ] as const)('expands %s into complete orthogonal axes', (preset, format, scope, userAgent) => {
    const resolved = resolveAuthoredRequestIdentity({ preset });
    expect(resolved.lineage.format).toBe(format);
    expect(resolved.lineage.sessionScope).toBe(scope);
    expect(resolved.lineage.branchSessionScope).toBe('follow_session_scope');
    expect(resolved.client.userAgent).toBe(userAgent);
  });

  it.each([
    ['openai_responses', 'gpt-example', undefined, 'shared_session'],
    ['anthropic', 'claude-example', undefined, 'shared_session'],
    ['google-genai', 'opaque-model', undefined, 'agent_session'],
    ['anthropic', 'GeMiNi-4-carbon', undefined, 'agent_session'],
    ['anthropic', 'gemini/gemini-4-argon', undefined, 'agent_session'],
    ['anthropic', 'opaque-model', 'google/gemini_4', 'agent_session'],
    ['anthropic', 'not-gemini-4', undefined, 'shared_session'],
  ] as const)('resolves branch isolation from %s model %s pricing %s', (protocol, model, pricingModel, expected) => {
    const policy = resolveAuthoredRequestIdentity({ preset: 'claude_code_compatible' });
    const input = { policy, protocol, model, pricingModel, isBranch: true };
    expect(resolveRequestIdentitySessionScope(input)).toBe(expected);
    expect(resolveRequestIdentitySessionScope({ ...input, isBranch: false })).toBe('shared_session');
    for (const branchSessionScope of ['shared_session', 'agent_session'] as const) {
      const explicit = resolveAuthoredRequestIdentity({ preset: 'claude_code_compatible', overrides: { lineage: { branchSessionScope } } });
      expect(resolveRequestIdentitySessionScope({ ...input, policy: explicit })).toBe(branchSessionScope);
      expect(resolveRequestIdentitySessionScope({ ...input, policy: resolveAuthoredRequestIdentity({ preset: 'none', overrides: { lineage: { branchSessionScope } } }) })).toBe('none');
    }
  });

  it.each(['shared_session', 'agent_session'] as const)('uses the same effective %s scope in Codex headers, cache key and turn metadata', (branchSessionScope) => {
    const projection = project({ preset: 'codex_compatible', overrides: { lineage: { branchSessionScope } } }, { isBranch: true });
    const id = branchSessionScope === 'shared_session' ? SNAPSHOT.sharedSessionId : SNAPSHOT.agentSessionId;
    expect(projection.cacheKey).toBe(id);
    expect(projection.headers?.['session-id']).toBe(id);
    expect(projection.headers?.['thread-id']).toBe(SNAPSHOT.threadId);
    expect(projection.headers?.['x-codex-parent-thread-id']).toBe(SNAPSHOT.parentThreadId);
    expect(JSON.parse(projection.headers?.['x-codex-turn-metadata'] ?? '{}')).toMatchObject({ session_id: id, thread_id: SNAPSHOT.threadId });
    expect(projection.wire?.responsesClientMetadata).toMatchObject({ session_id: id, thread_id: SNAPSHOT.threadId });
  });

  it('shares Codex branch big ids by default and isolates Gemini gateway metadata ids', () => {
    expect(project({ preset: 'codex_compatible' }, { isBranch: true }).cacheKey).toBe(SNAPSHOT.sharedSessionId);
    const compactedBranch = projectRequestIdentity({
      policy: resolveAuthoredRequestIdentity({ preset: 'codex_compatible' }), protocol: 'openai_responses', model: 'gpt-example',
      rawSessionId: 'raw-session', rawAgentId: 'branch', isBranch: true, compactionWindow: 2,
      isKimiProvider: false, snapshot: SNAPSHOT, runtimeVersion: '1.0.0', platform: 'linux', arch: 'x64',
    });
    expect(compactedBranch.cacheKey).toBe(SNAPSHOT.sharedSessionId);
    expect(compactedBranch.headers?.['session-id']).toBe(SNAPSHOT.sharedSessionId);
    const policy = { preset: 'claude_code_compatible' } as const;
    for (const isBranch of [false, true]) {
      const projection = project(policy, { protocol: 'anthropic', model: 'gemini-4-hydrogen', isBranch });
      const id = isBranch ? SNAPSHOT.agentSessionId : SNAPSHOT.sharedSessionId;
      expect(projection.headers?.['X-Claude-Code-Session-Id']).toBe(id);
      expect(JSON.parse(projection.cacheKey ?? '{}')).toMatchObject({ session_id: id });
    }
  });

  it('projects OpenCode session and logical request ids without unrelated client lineage', () => {
    const projection = project({ profile: 'opencode' });
    expect(projection.headers).toEqual({
      'x-opencode-session': SNAPSHOT.agentSessionId,
      'x-opencode-request': SNAPSHOT.logicalId,
      'User-Agent': 'opencode/1.0.0',
    });
    expect(projection.cacheKey).toBeUndefined();
    expect(projection.wire?.responsesClientMetadata).toBeUndefined();
    const next = project({ profile: 'opencode' }, { snapshot: { ...SNAPSHOT, logicalId: 'next-turn' } });
    expect(next.headers?.['x-opencode-session']).toBe(SNAPSHOT.agentSessionId);
    expect(next.headers?.['x-opencode-request']).toBe('next-turn');
    expect(project({ profile: 'opencode', overrides: {
      lineage: { sessionScope: 'none' }, request: { logicalId: 'none' }, client: { userAgent: 'host' },
    } }).headers).toBeUndefined();
    expect(() => resolveRequestIdentityLayers({ profile: 'opencode', overrides: { lineage: { threadIdentity: 'agent' } } }))
      .toThrow('OpenCode projector does not support thread or parent lineage');
    expect(RequestIdentityPolicySchema.parse({ preset: 'opencode_compatible' })).toEqual({ preset: 'opencode_compatible' });
    expect(RequestIdentityPolicyWireSchema.parse({ overrides: { lineage: { format: 'opencode' }, client: { user_agent: 'opencode' } } }))
      .toEqual({ overrides: { lineage: { format: 'opencode' }, client: { user_agent: 'opencode' } } });
  });

  it('applies overrides leaf-by-leaf without replacing sibling defaults', () => {
    const resolved = resolveAuthoredRequestIdentity({
      preset: 'kimi_code',
      overrides: { client: { originator: { mode: 'custom', value: 'example-client' } } },
    });
    expect(resolved.client.originator).toEqual({ mode: 'custom', value: 'example-client' });
    expect(resolved.client.userAgent).toBe('kimi_code');
    expect(resolved.lineage.format).toBe('kimi_code');
  });

  it('projects enabled Codex format with disabled identity leaves from an empty snapshot', () => {
    const projected = projectRequestIdentity({
      policy: resolveAuthoredRequestIdentity({
        preset: 'none',
        overrides: {
          lineage: { format: 'codex' },
          client: { userAgent: 'host' },
        },
      }),
      protocol: 'openai_responses',
      model: 'wire-model',
      rawSessionId: 'session-example',
      rawAgentId: 'agent-example',
      isKimiProvider: false,
      snapshot: { setTurnState: () => undefined },
      runtimeVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
    });

    expect(projected.headers).toBeUndefined();
    expect(projected.cacheKey).toBeUndefined();
    expect(projected.wire).toMatchObject({
      suppressUserAgent: false,
      suppressIdentity: false,
      suppressMessagesMetadataUserId: true,
      responsesClientMetadata: undefined,
    });
  });

  it('defaults an omitted policy to Kimi Code', () => {
    expect(resolveProviderRequestIdentity(undefined).preset).toBe('kimi_code');
  });

  it.each([['oauth/openai-codex', 'codex'], ['oauth/grok-build', 'grok_build']] as const)(
    'uses the %s OAuth identity only below explicit global/provider/model layers', (key, profile) => {
      const provider = { type: 'openai_responses', oauth: { storage: 'file' as const, key } };
      const defaults = defaultOAuthRequestIdentity(provider);
      expect(resolveProviderRequestIdentity(provider).profile).toBe(profile);
      expect(resolveRequestIdentityLayers(defaults, { profile: 'none' }).profile).toBe('none');
      expect(resolveRequestIdentityLayers(defaults, { profile: 'kimi_code' }).profile).toBe('kimi_code');
      expect(resolveRequestIdentityLayers(defaults, undefined, { profile: 'opencode' }).profile).toBe('opencode');
      expect(resolveRequestIdentityLayers(defaults, { profile: 'none' }, undefined, { profile }).profile).toBe(profile);
      expect(resolveRequestIdentityLayersWith((id) => id === 'custom:example'
        ? { preset: 'opencode_compatible' } : id === profile
          ? { preset: profile === 'codex' ? 'codex_compatible' : 'grok_build_compatible' } : undefined,
      defaults, { profile: 'custom:example' }).profile).toBe('custom:example');
      expect(provider).not.toHaveProperty('requestIdentity');
    },
  );

  it('projects Grok Build lineage and none through the Chat Completions final fetch seam', () => {
    const input = { protocol: 'openai' as const, model: 'grok-example', rawSessionId: 'session-example',
      rawAgentId: 'agent-example', isKimiProvider: false, snapshot: SNAPSHOT,
      runtimeVersion: '1.0.0', platform: 'linux' as const, arch: 'x64' };
    expect(projectRequestIdentity({ ...input, policy: resolveAuthoredRequestIdentity({ profile: 'grok_build' }) }).headers)
      .toMatchObject({ 'x-grok-session-id': SNAPSHOT.agentSessionId, 'x-grok-req-id': SNAPSHOT.logicalId });
    expect(projectRequestIdentity({ ...input, policy: resolveAuthoredRequestIdentity({ profile: 'none' }) }).wire?.suppressIdentity).toBe(true);
  });

  it('resolves no authored layers byte-for-byte as the built-in Kimi policy', () => {
    expect(JSON.stringify(resolveRequestIdentityLayers())).toBe(
      JSON.stringify(resolveAuthoredRequestIdentity({ preset: 'kimi_code' })),
    );
  });

  it('accepts global-only presets and override-only layers', () => {
    expect(resolveRequestIdentityLayers({ preset: 'codex_compatible' }).preset).toBe(
      'codex_compatible',
    );
    const overridden = resolveRequestIdentityLayers({
      overrides: { client: { originator: { mode: 'custom', value: 'global-client' } } },
    });
    expect(overridden.client.originator).toEqual({ mode: 'custom', value: 'global-client' });
    expect(overridden.client.userAgent).toBe('kimi_code');
  });

  it('lets a provider preset reset the global layer completely', () => {
    expect(
      resolveRequestIdentityLayers(
        { preset: 'codex_compatible' },
        { preset: 'kimi_code' },
      ),
    ).toEqual(resolveAuthoredRequestIdentity({ preset: 'kimi_code' }));
  });

  it('lets an override-only provider inherit untouched global leaves', () => {
    const resolved = resolveRequestIdentityLayers(
      { preset: 'codex_compatible' },
      { overrides: { cache: { responses: 'none' } } },
    );
    expect(resolved.preset).toBe('codex_compatible');
    expect(resolved.lineage.format).toBe('codex');
    expect(resolved.client.originator).toEqual({ mode: 'codex_default' });
    expect(resolved.cache.responses).toBe('none');
  });

  it('treats originator as an atomic discriminated-union leaf', () => {
    const resolved = resolveRequestIdentityLayers(
      {
        overrides: { client: { originator: { mode: 'custom', value: 'global-client' } } },
      },
      { overrides: { client: { originator: { mode: 'none' } } } },
    );
    expect(resolved.client.originator).toEqual({ mode: 'none' });
    expect(resolved.client.originator).not.toHaveProperty('value');
  });

  it('isolates resolved originator references from authored input', () => {
    const originator = { mode: 'custom' as const, value: 'authored-client' };
    const authored: RequestIdentityPolicy = {
      overrides: { client: { originator } },
    };
    const resolved = resolveRequestIdentityLayers(authored);

    originator.value = 'mutated-authored';
    expect(resolved.client.originator).toEqual({
      mode: 'custom',
      value: 'authored-client',
    });

    if (resolved.client.originator.mode !== 'custom') throw new Error('expected custom originator');
    resolved.client.originator.value = 'mutated-resolved';
    expect(originator).toEqual({ mode: 'custom', value: 'mutated-authored' });
  });

  it('lets a model preset reset global and provider layers', () => {
    expect(
      resolveRequestIdentityLayers(
        { preset: 'codex_compatible' },
        { overrides: { client: { userAgent: 'host' } } },
        { preset: 'none' },
      ),
    ).toEqual(resolveAuthoredRequestIdentity({ preset: 'none' }));
  });

  it('lets an override-only model inherit provider and global leaves', () => {
    const resolved = resolveRequestIdentityLayers(
      { preset: 'codex_compatible' },
      { overrides: { client: { userAgent: 'host' } } },
      { overrides: { cache: { responses: 'none' } } },
    );
    expect(resolved.lineage.format).toBe('codex');
    expect(resolved.client.userAgent).toBe('host');
    expect(resolved.cache.responses).toBe('none');
  });

  it('validates every layer before applying a later preset', () => {
    expect(() =>
      resolveRequestIdentityLayers(
        { overrides: { lineage: { sessionScope: 'none' } } },
        { preset: 'none' },
      ),
    ).toThrow(/cache source/u);
  });

  it('keeps old explicit provider resolution exact', () => {
    const policy: RequestIdentityPolicy = {
      preset: 'grok_build_compatible',
      overrides: { client: { userAgent: 'host' } },
    };
    expect(resolveProviderRequestIdentity({ requestIdentity: policy })).toEqual(
      resolveAuthoredRequestIdentity(policy),
    );
  });

  it.each([RequestIdentityPolicySchema, RequestIdentityPolicyWireSchema])(
    'rejects recursively empty layers and accepts one override leaf',
    (schema) => {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ overrides: {} }).success).toBe(false);
      expect(schema.safeParse({ overrides: { lineage: {}, client: {} } }).success).toBe(false);
      const layer =
        schema === RequestIdentityPolicySchema
          ? { overrides: { client: { userAgent: 'host' } } }
          : { overrides: { client: { user_agent: 'host' } } };
      expect(schema.safeParse(layer).success).toBe(true);
    },
  );

  it('rejects the removed kiki preset name instead of treating it as an alias', () => {
    expect(RequestIdentityPolicySchema.safeParse({ preset: 'kiki' }).success).toBe(false);
    expect(RequestIdentityPolicyWireSchema.safeParse({ preset: 'kiki' }).success).toBe(false);
  });

  it('rejects control characters in the new originator axis', () => {
    expect(() =>
      resolveAuthoredRequestIdentity({
        preset: 'kimi_code',
        overrides: { client: { originator: { mode: 'custom', value: 'bad\r\nvalue' } } },
      }),
    ).toThrow(/control characters/u);
  });

  it('projects Kimi protocol identity while preserving the configured host product', () => {
    const kimi = project({ preset: 'kimi_code' }, { isKimiProvider: true });
    expect(kimi.headers).toMatchObject({
      'User-Agent': 'kiki-cli/1.0.0',
      'X-Msh-Platform': 'kimi_code_cli',
      'X-Msh-Version': '1.0.0',
      'X-Msh-Device-Id': SNAPSHOT.installationId,
    });
    expect(kimi.headers?.['User-Agent']).not.toContain('kimi-code');
    expect(kimi.headers?.['X-Msh-Device-Name']).toBeTruthy();
    expect(kimi.headers?.['X-Msh-Device-Model']).toBeTruthy();
    expect(kimi.headers?.['X-Msh-Os-Version']).toBeTruthy();
    expect(Object.keys(kimi.headers ?? {}).some((key) => key.startsWith('x-kiki-'))).toBe(false);
    expect(kimi.cacheKey).toBe(`session_${SNAPSHOT.agentSessionId}`);

    const compatible = project(
      { preset: 'kimi_code' },
      { hostRequestHeaders: { 'User-Agent': 'kimi-code-cli/1.0.0' } },
    );
    expect(compatible.headers).toEqual({ 'User-Agent': 'kimi-code-cli/1.0.0' });
    expect(compatible.cacheKey).toBe(`session_${SNAPSHOT.agentSessionId}`);
  });

  it.each(['openai_responses', 'anthropic'] as const)(
    'uses the same Kimi agent-session default for omitted, preset and profile policies on %s',
    (protocol) => {
      const policy = resolveRequestIdentityLayers();
      expect(policy.lineage.sessionScope).toBe('agent_session');
      expect(resolveAuthoredRequestIdentity({ preset: 'kimi_code' })).toEqual(policy);
      expect(resolveAuthoredRequestIdentity({ profile: 'kimi_code' })).toEqual(policy);
      expect(project({ profile: 'kimi_code' }, { protocol }).cacheKey).toBe(`session_${SNAPSHOT.agentSessionId}`);
      expect(project({
        profile: 'kimi_code',
        overrides: { lineage: { sessionScope: 'shared_session' } },
      }, { protocol }).cacheKey).toBe('raw-session');
      expect(project({ profile: 'none' }, { protocol }).cacheKey).toBeUndefined();
    },
  );

  it('namespaces agent-session wire identities by lineage format rather than the base preset', () => {
    const kimiFormat = project({
      preset: 'none',
      overrides: {
        lineage: { format: 'kimi_code', sessionScope: 'agent_session' },
        cache: { source: 'session', responses: 'prompt_cache_key' },
      },
    });
    expect(kimiFormat.cacheKey).toBe(`session_${SNAPSHOT.agentSessionId}`);
    const grokFormat = project({
      preset: 'kimi_code',
      overrides: {
        lineage: { format: 'grok_build' },
        cache: { messages: 'none' },
      },
    });
    expect(grokFormat.cacheKey).toBe(SNAPSHOT.agentSessionId);
    expect(grokFormat.headers?.['x-grok-session-id']).toBe(SNAPSHOT.agentSessionId);
  });

  it('round-trips snake-case public policy fields', () => {
    const authored = {
      preset: 'grok_build_compatible' as const,
      overrides: {
        client: { userAgent: 'grok_build' as const },
        request: { turnIndex: 'agent_session' as const },
      },
    };
    expect(requestIdentityFromWire(requestIdentityToWire(authored)!)).toEqual(authored);
  });

  it('rejects invalid cross-axis combinations', () => {
    expect(() =>
      resolveAuthoredRequestIdentity({
        preset: 'grok_build_compatible',
        overrides: { lineage: { sessionScope: 'shared_session' } },
      }),
    ).toThrow(/turnIndex/u);
    expect(() =>
      resolveAuthoredRequestIdentity({
        preset: 'none',
        overrides: { cache: { source: 'session' } },
      }),
    ).toThrow(/cache source/u);
    expect(() =>
      resolveAuthoredRequestIdentity({
        preset: 'grok_build_compatible',
        overrides: { lineage: { turnAncestry: 'spawn_context' } },
      }),
    ).toThrow(/parent lineage/u);
  });

  it.each([
    {
      name: 'session scope',
      overrides: {
        lineage: { sessionScope: 'none' as const },
        cache: { source: 'none' as const },
      },
      headers: ['session-id'],
      metadata: ['session_id'],
    },
    {
      name: 'thread identity',
      overrides: { lineage: { threadIdentity: 'none' as const } },
      headers: ['thread-id', 'x-client-request-id', 'x-codex-window-id'],
      metadata: ['thread_id', 'x-codex-window-id'],
    },
    {
      name: 'parent thread',
      overrides: { lineage: { parentThread: 'none' as const } },
      headers: ['x-codex-parent-thread-id'],
      metadata: ['x-codex-parent-thread-id'],
    },
    {
      name: 'subagent marker',
      overrides: { lineage: { subagentMarker: 'none' as const } },
      headers: ['x-openai-subagent'],
      metadata: ['x-openai-subagent'],
    },
    {
      name: 'turn ancestry',
      overrides: { lineage: { turnAncestry: 'none' as const } },
      headers: [],
      metadata: ['parent_turn_id', 'root_turn_id'],
    },
    {
      name: 'installation identity',
      overrides: { client: { installationIdentity: 'none' as const } },
      headers: [],
      metadata: ['x-codex-installation-id'],
    },
    {
      name: 'logical request id',
      overrides: { request: { logicalId: 'none' as const } },
      headers: [],
      metadata: ['turn_id'],
    },
    {
      name: 'originator',
      overrides: { client: { originator: { mode: 'none' as const } } },
      headers: ['originator'],
      metadata: [],
    },
  ])('makes the $name leaf authoritative', ({ overrides, headers, metadata }) => {
    const projected = project({ preset: 'codex_compatible', overrides });
    for (const header of headers) expect(projected.headers).not.toHaveProperty(header);
    for (const key of metadata) {
      expect(projected.wire?.responsesClientMetadata).not.toHaveProperty(key);
    }
  });

  it('makes the Responses cache leaf authoritative', () => {
    expect(
      project({
        preset: 'codex_compatible',
        overrides: { cache: { responses: 'none' } },
      }).cacheKey,
    ).toBeUndefined();
    expect(
      project({
        preset: 'codex_compatible',
        overrides: { cache: { source: 'none' } },
      }).cacheKey,
    ).toBeUndefined();
  });

  it('makes the Responses metadata leaf authoritative', () => {
    const projected = project({
      preset: 'codex_compatible',
      overrides: { responsesMetadata: 'none' },
    });
    expect(projected.wire?.responsesClientMetadata).toBeUndefined();
    expect(projected.headers).not.toHaveProperty('x-codex-turn-metadata');
    expect(projected.headers).not.toHaveProperty('x-codex-window-id');
    expect(projected.headers).toHaveProperty('thread-id', SNAPSHOT.threadId);
  });

  it('emits a captured turn state for any Codex Responses metadata without a thread identity', () => {
    const turnStateSnapshot = { ...SNAPSHOT, turnState: 'sticky-state' };

    expect(
      project({ preset: 'codex_compatible' }, { snapshot: turnStateSnapshot }).headers,
    ).toHaveProperty('x-codex-turn-state', 'sticky-state');
    expect(
      project(
        { preset: 'codex_compatible', overrides: { lineage: { threadIdentity: 'none' } } },
        { snapshot: turnStateSnapshot },
      ).headers,
    ).toHaveProperty('x-codex-turn-state', 'sticky-state');
    expect(
      project(
        { preset: 'codex_compatible', overrides: { responsesMetadata: 'none' } },
        { snapshot: turnStateSnapshot },
      ).headers,
    ).not.toHaveProperty('x-codex-turn-state');
    expect(
      project({ preset: 'kimi_code' }, { snapshot: turnStateSnapshot, isKimiProvider: true }).headers,
    ).not.toHaveProperty('x-codex-turn-state');
  });

  it('uses the selected session scope without changing the Codex wire format', () => {
    const projected = project({
      preset: 'codex_compatible',
      overrides: { lineage: { sessionScope: 'agent_session' } },
    });
    expect(projected.headers).toHaveProperty('session-id', SNAPSHOT.agentSessionId);
    expect(projected.cacheKey).toBe(SNAPSHOT.agentSessionId);
    expect(projected.wire?.responsesClientMetadata).toHaveProperty(
      'session_id',
      SNAPSHOT.agentSessionId,
    );
  });

  it.each([
    ['logical request id', { request: { logicalId: 'none' as const } }, 'x-grok-req-id'],
    ['turn index', { request: { turnIndex: 'none' as const } }, 'x-grok-turn-idx'],
    [
      'installation identity',
      { client: { installationIdentity: 'none' as const } },
      'x-grok-agent-id',
    ],
  ])('makes the Grok $name leaf authoritative', (_name, overrides, header) => {
    const projected = project({ preset: 'grok_build_compatible', overrides });
    expect(projected.headers).not.toHaveProperty(header);
  });

  it('treats userAgent=none as UA-only suppression when other identity axes remain', () => {
    const projected = project({
      preset: 'codex_compatible',
      overrides: { client: { userAgent: 'none' } },
    });
    expect(projected.headers).toMatchObject({
      'session-id': SNAPSHOT.sharedSessionId,
      'thread-id': SNAPSHOT.threadId,
      'x-kiki-internal-suppress-user-agent': '1',
    });
    expect(projected.headers).not.toHaveProperty('x-kiki-internal-suppress-request-identity');
    expect(projected.wire?.suppressIdentity).toBe(false);
  });

  it.each([RequestIdentityPolicySchema, RequestIdentityPolicyWireSchema])(
    'rejects unknown root and nested policy fields recursively',
    (schema) => {
      expect(schema.safeParse({ preset: 'none', future_root: true }).success).toBe(false);
      expect(
        schema.safeParse({
          preset: 'none',
          overrides: { request: { future_axis: 'value' } },
        }).success,
      ).toBe(false);
    },
  );

  it('maps each preset to its built-in identity profile and a profile layer to its base preset', () => {
    expect(resolveAuthoredRequestIdentity({ preset: 'codex_compatible' }).profile).toBe('codex');
    expect(resolveRequestIdentityLayers().profile).toBe('kimi_code');
    const resolved = resolveAuthoredRequestIdentity({ profile: 'claude_code' });
    expect(resolved).toMatchObject({ preset: 'claude_code_compatible', profile: 'claude_code' });
  });

  it('expands a custom profile through the lookup and layers overrides on top of its own', () => {
    const lookup = (id: string) => id === 'custom:x-1'
      ? { preset: 'codex_compatible' as const, overrides: { lineage: { subagentMarker: 'none' as const } } }
      : undefined;
    const resolved = resolveRequestIdentityLayersWith(lookup, { preset: 'none' }, {
      profile: 'custom:x-1',
      overrides: { lineage: { parentThread: 'none' } },
    });
    expect(resolved).toMatchObject({ profile: 'custom:x-1', preset: 'codex_compatible' });
    expect(resolved.lineage).toMatchObject({ subagentMarker: 'none', parentThread: 'none', threadIdentity: 'agent' });
    expect(() => resolveRequestIdentityLayersWith(lookup, { profile: 'custom:missing' })).toThrow('does not exist');
  });

  it.each([RequestIdentityPolicySchema, RequestIdentityPolicyWireSchema])(
    'rejects preset together with profile, and malformed profile ids',
    (schema) => {
      expect(schema.safeParse({ profile: 'custom:x-1' }).success).toBe(true);
      expect(schema.safeParse({ preset: 'none', profile: 'none' }).success).toBe(false);
      expect(schema.safeParse({ profile: 'Custom X' }).success).toBe(false);
      expect(schema.safeParse({ profile: 'custom:' }).success).toBe(false);
    },
  );

  it('rejects Claude Code lineage on thread axes and on non-Messages protocols', () => {
    expect(() => resolveAuthoredRequestIdentity({
      preset: 'claude_code_compatible',
      overrides: { lineage: { threadIdentity: 'agent' } },
    })).toThrow('Claude Code projector does not support thread');
    expect(() => project({ preset: 'claude_code_compatible' }, { protocol: 'openai_responses' }))
      .toThrow('only supports Anthropic Messages');
  });

  it('projects Claude Code session header and a JSON metadata user id', () => {
    const projected = project({ preset: 'claude_code_compatible' }, { protocol: 'anthropic' });
    expect(projected.headers).toMatchObject({
      'X-Claude-Code-Session-Id': SNAPSHOT.sharedSessionId,
      'User-Agent': 'claude-cli/1.0.0 (external, cli)',
    });
    expect(JSON.parse(projected.cacheKey ?? '')).toMatchObject({ session_id: SNAPSHOT.sharedSessionId, account_uuid: '' });
  });

  it('lets a rendered profile replace, remove and add headers, but never under true none', () => {
    const profile = {
      profileId: 'custom:x-1',
      version: '9.9.9',
      versionOrigin: 'fixed',
      userAgent: 'example/9.9.9',
      headers: [{ name: 'Originator', value: '' }, { name: 'X-Example', value: 'on' }],
      params: { service_tier: 'flex' },
    };
    const projected = projectRequestIdentity({
      policy: resolveAuthoredRequestIdentity({ preset: 'codex_compatible' }),
      protocol: 'openai_responses',
      model: 'wire-model',
      rawSessionId: 'raw-session',
      rawAgentId: 'main',
      isKimiProvider: false,
      snapshot: SNAPSHOT,
      runtimeVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      profile,
    });
    expect(projected.headers).toMatchObject({ 'User-Agent': 'example/9.9.9', 'X-Example': 'on' });
    expect(projected.headers).not.toHaveProperty('originator');
    expect(projected.params).toEqual({ service_tier: 'flex' });
    const none = projectRequestIdentity({
      policy: resolveAuthoredRequestIdentity({ preset: 'none' }),
      protocol: 'openai_responses',
      model: 'wire-model',
      rawSessionId: 'raw-session',
      rawAgentId: 'main',
      isKimiProvider: false,
      snapshot: SNAPSHOT,
      runtimeVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      profile,
    });
    expect(none.headers).not.toHaveProperty('X-Example');
    expect(none.params).toBeUndefined();
  });
});

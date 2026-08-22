import { describe, expect, it } from 'vitest';

import {
  requestIdentityFromWire,
  requestIdentityToWire,
  resolveAuthoredRequestIdentity,
  resolveProviderRequestIdentity,
  resolveRequestIdentityLayers,
  RequestIdentityPolicySchema,
  RequestIdentityPolicyWireSchema,
  type RequestIdentityPolicy,
} from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';

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
  options: { isKimiProvider?: boolean; protocol?: 'openai_responses' | 'anthropic' } = {},
) {
  return projectRequestIdentity({
    policy: resolveAuthoredRequestIdentity(policy),
    protocol: options.protocol ?? 'openai_responses',
    model: 'wire-model',
    rawSessionId: 'raw-session',
    rawAgentId: 'child',
    parentAgentId: 'main',
    subagentKind: 'agent',
    isKimiProvider: options.isKimiProvider ?? false,
    snapshot: SNAPSHOT,
    runtimeVersion: '1.0.0',
    platform: 'linux',
    arch: 'x64',
  });
}

describe('request identity policy', () => {
  it.each([
    ['codex_compatible', 'codex', 'shared_session', 'codex'],
    ['grok_build_compatible', 'grok_build', 'agent_session', 'grok_build'],
    ['kimi_code', 'kimi_code', 'shared_session', 'kimi_code'],
    ['none', 'none', 'none', 'none'],
  ] as const)('expands %s into complete orthogonal axes', (preset, format, scope, userAgent) => {
    const resolved = resolveAuthoredRequestIdentity({ preset });
    expect(resolved.lineage.format).toBe(format);
    expect(resolved.lineage.sessionScope).toBe(scope);
    expect(resolved.client.userAgent).toBe(userAgent);
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

  it('projects Kimi Code product identity without donor-absent lineage', () => {
    const kimi = project({ preset: 'kimi_code' }, { isKimiProvider: true });
    expect(kimi.headers).toMatchObject({
      'User-Agent': 'kimi-code-cli/1.0.0',
      'X-Msh-Platform': 'kimi_code_cli',
      'X-Msh-Version': '1.0.0',
      'X-Msh-Device-Id': SNAPSHOT.installationId,
    });
    expect(kimi.headers?.['X-Msh-Device-Name']).toBeTruthy();
    expect(kimi.headers?.['X-Msh-Device-Model']).toBeTruthy();
    expect(kimi.headers?.['X-Msh-Os-Version']).toBeTruthy();
    expect(Object.keys(kimi.headers ?? {}).some((key) => key.startsWith('x-kiki-'))).toBe(false);
    expect(kimi.cacheKey).toBe('raw-session');

    const thirdParty = project({ preset: 'kimi_code' });
    expect(thirdParty.headers).toEqual({ 'User-Agent': 'kimi-code-cli/1.0.0' });
    expect(thirdParty.cacheKey).toBe('raw-session');
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
});

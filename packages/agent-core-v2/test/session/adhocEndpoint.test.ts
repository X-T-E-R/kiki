import { describe, expect, it, vi } from 'vitest';
import { posix } from 'node:path';
import { normalizeAgentProfile } from '@kiki/agent-profiles';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { adhocEndpointModelId } from '@kiki/protocol';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { AdhocEndpointVault } from '#/session/adhocEndpoint/adhocEndpointVault';
import { materializeAdhocModel } from '#/session/adhocEndpoint/adhocEndpointRuntime';
import { assertEndpointConstraints, endpointThinking, resolveEndpointBinding } from '#/session/adhocEndpoint/endpointBinding';
import { assertEndpointSourceTrusted, authorizeEndpoint } from '#/session/adhocEndpoint/endpointConsent';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { createTestAgent } from '../harness';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';

const input = { base_url: 'https://eval.example.test/v1', model: 'eval-preview-model', api_key_env: 'EVAL_API_KEY' };
const profile = normalizeAgentProfile({ name: 'frontend', modelAlias: 'catalog-model', systemPrompt: () => 'Build the interface.', endpoint: input });

function testServices() {
  const ix = new TestInstantiationService();
  ix.stub(IConfigService, { get: <T>() => undefined as T });
  ix.stub(IAtomicDocumentStore, { get: async () => undefined });
  return ix;
}

describe('ad-hoc endpoint bindings', () => {
  it('preserves a frozen endpoint when rebuilding the registered profile context', async () => {
    const ctx = createTestAgent();
    try {
      const service = ctx.get(IAgentProfileService);
      const endpoint = new AdhocEndpointVault().bind(input);
      const selected = ctx.get(ISessionAgentProfileCatalog).getDefault();
      await service.bind({ resolvedProfile: selected, endpoint, thinking: 'high' });
      await service.rebuildPromptContext();
      expect(service.data().endpoint).toEqual(endpoint);
      expect(service.getRuntimeModel().id).toBe(adhocEndpointModelId(endpoint));
      expect(service.getEffectiveThinkingLevel()).toBe('high');
    } finally { await ctx.dispose(); }
  });

  it('clears both endpoint snapshots when switching back to a catalog model', async () => {
    const ctx = createTestAgent();
    try {
      const service = ctx.get(IAgentProfileService);
      const endpoint = new AdhocEndpointVault().bind(input);
      await service.bind({ resolvedProfile: ctx.get(ISessionAgentProfileCatalog).getDefault(), endpoint, thinking: 'high' });
      service.update({ modelAlias: 'mock-model' });
      expect(service.data().endpoint).toBeUndefined();
      expect(service.data().boundProfile?.endpoint).toBeUndefined();
      expect(service.getRuntimeModel().id).toBe('mock-model');
    } finally { await ctx.dispose(); }
  });

  it('does not discard a shared secret while another provisional call still needs it', () => {
    const vault = new AdhocEndpointVault();
    for (const id of ['first', 'second']) {
      vault.scrub('parent', { type: 'function', id, name: 'AgentRun', arguments: JSON.stringify({ api_key: 'sk-test-ephemeral-123' }) });
      vault.remap('parent', id, undefined, id);
    }
    const ref = vault.claim('parent', 'second')!;
    vault.discard('parent', ['first']);
    expect(vault.read(ref)).toBe('sk-test-ephemeral-123');
    vault.discard('parent', ['second']);
    expect(vault.read(ref)).toBeUndefined();
  });
  it('leaves non-AgentRun CallTool arguments and identity untouched', () => {
    const vault = new AdhocEndpointVault();
    const secret = 'sk-test-plugin-key-123';
    const call = {
      type: 'function' as const,
      id: 'plugin-call',
      name: 'CallTool',
      arguments: JSON.stringify({ name: 'plugin__lookup', arguments: { api_key: secret } }),
    };
    expect(vault.scrub('parent', call)).toBe(call);
    expect(vault.claim('parent', call.id)).toBeUndefined();
    expect(vault.redact(secret)).toBe(secret);
  });

  it('preserves nonsensitive malformed tool arguments unchanged', () => {
    const vault = new AdhocEndpointVault();
    const call = { type: 'function' as const, id: 'malformed', name: 'AgentRun', arguments: '{"profile":' };
    expect(vault.scrub('parent', call)).toBe(call);
    expect(call.arguments).toBe('{"profile":');
  });

  it.each(['API_KEY', String.raw`api_\u006bey`, String.raw`\u0061pi_key`])('replaces sensitive truncated JSON key %s with an invalid secret-free diagnostic stub', (key) => {
    const vault = new AdhocEndpointVault();
    const secret = 'sk-test-truncated-secret';
    const call = { type: 'function' as const, id: 'truncated', name: 'AgentRun', arguments: `{"${key}":"${secret}` };
    const scrubbed = vault.scrub('parent', call);
    expect(scrubbed.arguments).toBe('{"_redacted_truncated_json":');
    expect(() => JSON.parse(scrubbed.arguments ?? '')).toThrow();
    expect(scrubbed.arguments).not.toContain(secret);
    expect(vault.claim('parent', call.id)).toBeUndefined();
    expect(vault.redact(secret)).toBe(secret);
  });

  it('scrubs and claims a legitimate AgentRun CallTool wrapper', () => {
    const vault = new AdhocEndpointVault();
    const secret = 'sk-test-wrapped-endpoint-123';
    const call = {
      type: 'function' as const,
      id: 'wrapped-call',
      name: 'CallTool',
      arguments: JSON.stringify({
        name: 'AgentRun',
        arguments: { profile: 'frontend', endpoint: { base_url: 'https://eval.example.test/v1', model: 'eval-preview-model', api_key: secret } },
      }),
    };
    const scrubbed = vault.scrub('parent', call);
    expect(scrubbed).not.toBe(call);
    expect(JSON.parse(scrubbed.arguments ?? '{}')).toEqual({
      name: 'AgentRun',
      arguments: { profile: 'frontend', endpoint: { base_url: 'https://eval.example.test/v1', model: 'eval-preview-model', api_key: '[REDACTED]' } },
    });
    const ref = vault.claim('parent', call.id)!;
    expect(vault.read(ref)).toBe(secret);
    vault.discard('parent', [call.id]);
    expect(vault.read(ref)).toBeUndefined();
  });

  it('merges endpoint fields, isolates auth on destination changes, and never borrows auth for a catalog model', () => {
    const vault = new AdhocEndpointVault();
    const retained = resolveEndpointBinding(profile, { model: 'eval-next-model' }, undefined, vault)!;
    expect(retained.credential).toEqual({ kind: 'env', env: 'EVAL_API_KEY' });
    expect(resolveEndpointBinding(profile, undefined, 'catalog-model', vault)).toBeUndefined();
    expect(() => resolveEndpointBinding(profile, { base_url: 'https://other.example.test/v1' }, undefined, vault)).toThrow('credential_unavailable');
    expect(() => resolveEndpointBinding(profile, { provider_type: 'anthropic' }, undefined, vault)).toThrow('credential_unavailable');
    expect(() => resolveEndpointBinding({ ...profile, executor: 'external' }, {}, undefined, vault)).toThrow('native executor');
    expect(endpointThinking(retained)).toBe('medium');
    expect(endpointThinking(retained, 'high')).toBe('high');
    expect(() => endpointThinking(retained, 'on')).toThrow('Unsupported');
    const noThinking = vault.bind({ ...input, capabilities: ['tool_use'] });
    expect(endpointThinking(noThinking, 'high')).toBe('off');
    expect(noThinking.capabilities).toEqual(['tool_use']);
  });

  it('keeps frozen literal bindings readable after a cold restart and fails before request auth is sent', async () => {
    const live = new AdhocEndpointVault();
    const literal = live.bind({ ...input, api_key_env: undefined, api_key: 'sk-test-ephemeral-123' });
    expect(JSON.stringify(literal)).not.toContain('sk-test-ephemeral-123');
    expect(await materializeAdhocModel(literal, live).authProvider.getAuth()).toEqual({ apiKey: 'sk-test-ephemeral-123' });
    const cold = JSON.parse(JSON.stringify(literal)) as typeof literal;
    const restored = materializeAdhocModel(cold, new AdhocEndpointVault());
    expect(restored.name).toBe('eval-preview-model');
    expect(restored.capabilities.image_in).toBe(true);
    expect(restored.maxContextSize).toBe(131072);
    await expect(restored.authProvider.getAuth()).rejects.toThrow('credential_unavailable');
    const prior = process.env['EVAL_API_KEY'];
    try {
      process.env['EVAL_API_KEY'] = 'sk-test-current';
      const envModel = materializeAdhocModel(live.bind(input), new AdhocEndpointVault());
      expect(await envModel.authProvider.getAuth()).toEqual({ apiKey: 'sk-test-current' });
      process.env['EVAL_API_KEY'] = 'sk-test-updated';
      expect(await envModel.authProvider.getAuth()).toEqual({ apiKey: 'sk-test-updated' });
      delete process.env['EVAL_API_KEY'];
      await expect(envModel.authProvider.getAuth()).rejects.toThrow('credential_unavailable');
    } finally {
      if (prior === undefined) delete process.env['EVAL_API_KEY']; else process.env['EVAL_API_KEY'] = prior;
    }
  });

  it('enforces derived identity and raw upstream model denies without registering models', async () => {
    const ix = testServices();
    const endpoint = new AdhocEndpointVault().bind(input);
    const id = adhocEndpointModelId(endpoint);
    expect(() => { assertEndpointConstraints(endpoint, 'high', ix.get(IConfigService), [{ allowedModels: ['catalog-model'] }]); }).toThrow();
    expect(() => { assertEndpointConstraints(endpoint, 'high', ix.get(IConfigService), [{ denyModels: [endpoint.model] }]); }).toThrow();
    expect(() => { assertEndpointConstraints(endpoint, 'high', ix.get(IConfigService), [{ restrictModelsToMenu: true }]); }).toThrow();
    expect(() => { assertEndpointConstraints(endpoint, 'high', ix.get(IConfigService), [{ allowedModels: [id] }]); }).not.toThrow();
    await ix.dispose();
  });

  it.each([
    { workDir: '/workspace-alias' },
    { workDir: '/primary', additionalDirs: ['/workspace-alias'] },
  ])('checks workspace trust using canonical runtime paths for admitted roots %j', async (roots) => {
    const ix = testServices();
    const definition = parseAgentFileText({ path: '/repo/agents/eval.md', source: 'explicit', text: '---\nname: eval\ndescription: Evaluation\nbase_url: https://eval.example.test/v1\nmodel: eval-preview-model\napi_key_env: EVAL_API_KEY\n---\nEvaluate.' });
    const selected = normalizeAgentProfile({ name: 'eval', sourcePath: definition.path, fileDefinition: definition, endpoint: definition.endpoint, systemPrompt: () => '' });
    const get = vi.fn().mockResolvedValue(undefined);
    ix.stub(IAtomicDocumentStore, { get });
    await expect(assertEndpointSourceTrusted(selected, 'E:/host/workspace', ix.get(IAtomicDocumentStore), undefined, {
      path: { ...posix, separator: '/', delimiter: ':' }, roots, operatorRoots: [],
      realpath: async (path) => path === '/workspace-alias' ? '/repo' : path,
    })).rejects.toThrow('untrusted');
    expect(get).toHaveBeenCalled();
    await ix.dispose();
  });

  it('rejects untrusted project/plugin and in-workspace explicit endpoints even when unattended', async () => {
    const ix = testServices();
    for (const source of ['project', 'plugin', 'explicit'] as const) {
      const definition = parseAgentFileText({ path: '/workspace/agents/eval.md', source,
        text: '---\nname: eval\ndescription: Evaluation\nbase_url: https://eval.example.test/v1\nmodel: eval-preview-model\napi_key_env: EVAL_API_KEY\n---\nEvaluate.' });
      const selected = normalizeAgentProfile({ name: 'eval', sourcePath: definition.path, fileDefinition: definition, endpoint: definition.endpoint, systemPrompt: () => '' });
      await expect(assertEndpointSourceTrusted(selected, '/workspace', ix.get(IAtomicDocumentStore), undefined, {
        path: { ...posix, separator: '/', delimiter: ':' }, realpath: async (path) => path,
        roots: { workDir: '/workspace' }, operatorRoots: [],
      })).rejects.toThrow('untrusted');
    }
    await ix.dispose();
  });

  it('runs yolo without approval, asks the human once in auto/review, and scopes grants to credentials', async () => {
    const ix = testServices();
    const vault = new AdhocEndpointVault();
    const endpoint = vault.bind(input);
    let mode: 'yolo' | 'auto' | 'review' = 'yolo';
    ix.stub(IAgentPermissionModeService, { get mode() { return mode; } });
    const approval = vi.fn<import('#/agent/toolApproval/toolApproval').IAgentToolApprovalService['requestToolApproval']>().mockResolvedValue({ permissionDecision: 'approved' });
    ix.stub(IAgentToolApprovalService, { requestToolApproval: approval });
    const owner = { accessor: ix };
    const signal = new AbortController().signal;
    await authorizeEndpoint(endpoint, vault, owner, '/workspace', signal);
    expect(approval).not.toHaveBeenCalled();
    mode = 'auto';
    await authorizeEndpoint(endpoint, vault, owner, '/workspace', signal);
    await authorizeEndpoint(endpoint, vault, owner, '/workspace', signal);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval.mock.calls[0]?.[0].permissionAuthority).toBe('owner');
    mode = 'review';
    await authorizeEndpoint(vault.bind({ ...input, api_key_env: 'OTHER_EVAL_KEY' }), vault, owner, '/workspace', signal);
    expect(approval).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(approval.mock.calls)).toContain('env: OTHER_EVAL_KEY');
    await ix.dispose();
  });
});

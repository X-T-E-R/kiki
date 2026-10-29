import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IConfigService, IModelCatalog, IModelCatalogMutationService, IRequestAdmission } from '@kiki/agent-core-v2';
import { IMemorySelector, selectorStats } from '@kiki/agent-core-v2/app/memory/memorySelector';
import { reviewPermission } from '@kiki/agent-core-v2/agent/toolApproval/permissionReviewer';
import { moveReviewerKeyToConnection } from '@kiki/agent-core-v2/app/kosongConfig/reviewerConnection';
import { memoryAdvisorConfigSchema, type MemoryAdvisorConfig } from '@kiki/protocol';
import type { ReviewerDependencies } from '@kiki/agent-core-v2/agent/toolApproval/permissionReviewer';
import type { ResolvedToolExecutionHookContext } from '@kiki/agent-core-v2/agent/toolExecutor/toolHooks';
import type { PermissionConfig } from '@kiki/agent-core-v2/agent/permissionRules/configSection';
import type { ProvidersSection } from '@kiki/agent-core-v2/kosong/provider/provider';
import { startServer, type RunningServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let home: string | undefined;
let server: RunningServer | undefined;
let upstream: Server | undefined;
afterEach(async () => {
  await server?.close(); server = undefined;
  if (upstream !== undefined) { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream!.close(() => resolve())); upstream = undefined; }
  if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  home = undefined;
  vi.unstubAllEnvs();
});
async function boot(toml = '') {
  home = await mkdtemp(join(tmpdir(), 'kiki-decision-'));
  await writeFile(join(home, 'config.toml'), toml);
  server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  return server;
}
async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${server!.port}/api${path}`, { method, headers: authHeaders(server!, body === undefined ? {} : { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
  return response.status === 204 ? { code: 0, data: undefined } : await response.json() as { code: number; data: any; msg: string };
}
const attribution = { sessionId: 'synthetic-session', agentId: 'main', purpose: 'memory_advice', logicalRequestId: 'synthetic-request', waitBudget: { waitedMs: 0 } };
const context = { toolCall: { id: 'synthetic', name: 'Bash' }, args: { command: 'printf synthetic' }, execution: { accesses: [], shellContext: { runtimeId: 'local', cwd: '/example', pathClass: 'posix' } }, signal: new AbortController().signal, turnId: 1 } as unknown as ResolvedToolExecutionHookContext;
function reviewerDependencies(active: RunningServer): ReviewerDependencies {
  return { config: active.core.accessor.get(IConfigService), catalog: active.core.accessor.get(IModelCatalog), admission: active.core.accessor.get(IRequestAdmission),
    memory: { get: () => [{ role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Print the synthetic example.' }] }] } as unknown as ReviewerDependencies['memory'],
    workspace: { workDir: '/example' } as ReviewerDependencies['workspace'], owner: { sessionId: 'synthetic-session', agentId: 'main' } };
}

describe('decision connections', () => {
  it('uses one environment credential for both consumers without chat models, diagnoses changes, clears sources, and probes only confirmed synthetic data', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-env-key');
    const calls: { authorization?: string; body: any }[] = [];
    upstream = createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += String(chunk);
      const body = JSON.parse(text); calls.push({ authorization: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      const answers = Object.fromEntries(Object.entries(body.questions).map(([name, question]) => [name, (question as any).type === 'noul'
        ? { type: 'noul', noul: 0.99 }
        : { type: 'choice', choice: (question as any).criteria.read === undefined ? 'apply' : 'read', confidence: 0.99, probabilities: (question as any).criteria.read === undefined ? { apply: 0.99, history: 0.005, skip: 0.005 } : { read: 0.99, skip: 0.01 } }]));
      res.end(JSON.stringify({ answers }));
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const active = await boot();
    const source = { kind: 'connection', connection: 'judgment' };
    const created = await request('POST', '/providers', { id: 'judgment', type: 'system_one', base_url: `${origin}/v1`, default_model: 'any-remote-model' });
    expect(created.code).toBe(0);
    expect(created.data).toMatchObject({ service: 'decision', decision_protocol: 'system_one', default_model: 'any-remote-model', models: [], has_api_key: true, api_key_env: 'TYPESAFE_API_KEY' });
    expect((await request('GET', '/models')).data.items).toEqual([]);
    expect((await request('POST', '/models', { provider_id: 'judgment', remote_id: 'fake', max_context_size: 4096 })).code).not.toBe(0);
    expect((await request('POST', '/config', { permission: { reviewer: { source, backend: 'jev', model: 'legacy-reviewer' } } })).code).toBe(0);
    const advisor = (await request('PATCH', '/memory/settings', { enabled: false, advisor: { source, selector: { protocol: 'chat_json', model: 'legacy-advisor' }, egress_ack: [{ workspace_id: 'synthetic-workspace', destination: `judgment@${origin}` }] } })).data.advisor as MemoryAdvisorConfig;
    const selector = active.core.accessor.get(IMemorySelector);
    expect(selector.describe(advisor, 'synthetic-workspace')).toMatchObject({ state: 'ready', source_status: { state: 'ready', connection: 'judgment', protocol: 'system_one', origin, credential_source: 'env', credential_env: 'TYPESAFE_API_KEY' }, consent_required: false });
    expect(await selector.call({ config: advisor, stage: 'discover', query: 'Synthetic tea task', units: [{ handle: 'c0', text: 'Synthetic tea preference' }], signal: new AbortController().signal, attribution, stats: selectorStats() })).toEqual([{ handle: 'c0', use: 'read' }]);
    expect(await reviewPermission(reviewerDependencies(active), context, 'example', {})).toMatchObject({ outcome: 'allow', backend: 'jev' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.authorization === 'Bearer synthetic-env-key' && call.body.model === 'any-remote-model')).toBe(true);
    expect((await request('POST', '/decision/probe', { source, confirm_destination: 'wrong' })).data).toMatchObject({ ok: false });
    expect(calls).toHaveLength(2);
    expect((await request('POST', '/decision/probe', { source, confirm_destination: `judgment@${origin}` })).data).toMatchObject({ ok: true, duration_ms: expect.any(Number) });
    expect(calls.slice(2).every((call) => JSON.stringify(call.body).includes('Synthetic connection test'))).toBe(true);
    const before = calls.length;
    expect((await request('PATCH', '/providers/judgment', { api_key_env: 'TYPESAFE_API_KEY' })).code).toBe(0);
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(selector.describe(advisor).reason).toBe('auth');
    expect(await reviewPermission(reviewerDependencies(active), context, 'example', {})).toBeUndefined();
    expect(calls).toHaveLength(before);
    vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-env-key');
    expect((await request('PATCH', '/providers/judgment', { decision_endpoint: 'https://other.example.test/systemone' })).code).not.toBe(0);
    expect((await request('PATCH', '/providers/judgment', { base_url: `http://localhost:${port}/v1` })).code).toBe(0);
    expect(selector.describe(advisor, 'synthetic-workspace')).toMatchObject({ consent_required: true, origin: `http://localhost:${port}` });
    expect((await request('POST', '/providers', { id: 'ranker', type: 'pair_score', base_url: origin, default_model: 'any-ranker' })).code).toBe(0);
    expect((await request('POST', '/config', { permission: { reviewer: { source: { kind: 'connection', connection: 'ranker' } } } })).code).not.toBe(0);
    const off = await request('PATCH', '/memory/settings', { advisor: { mode: 'off' } });
    expect(off.data.advisor).toMatchObject({ mode: 'off', source, egress_ack: advisor.egress_ack });
    const deleted = await request('DELETE', '/providers/judgment');
    expect(deleted.code, JSON.stringify(deleted)).toBe(0);
    expect(selector.describe(advisor)).toMatchObject({ state: 'failed', reason: 'unconfigured', provider: 'judgment' });
    expect((await request('GET', '/config')).data.permission.reviewer.source_status).toMatchObject({ state: 'unconfigured', connection: 'judgment' });
    await request('PATCH', '/memory/settings', { advisor: { source: null } });
    const clearedAdvisor = (await request('GET', '/memory/settings')).data.advisor;
    expect(clearedAdvisor.source).toBeUndefined();
    expect(clearedAdvisor.selector).toBeUndefined();
    await request('POST', '/config', { permission: { reviewer: { source: null } } });
    const clearedReviewer = (await request('GET', '/config')).data.permission.reviewer;
    expect(clearedReviewer).toMatchObject({ backend: 'model' });
    expect(clearedReviewer.source).toBeUndefined();
    expect(clearedReviewer.model).toBeUndefined();
    expect(await reviewPermission(reviewerDependencies(active), context, 'example', {})).toBeUndefined();
    expect(JSON.stringify(await request('GET', '/config'))).not.toContain('synthetic-env-key');
    expect(await readFile(join(home!, 'config.toml'), 'utf8')).not.toContain('synthetic-env-key');
  }, 30_000);

  it('moves the saved legacy key on the server, preserves a conflicting connection, and retries partial stages safely', async () => {
    await boot('[permission.reviewer]\nbackend="jev"\napi_key="synthetic-old-key"\nmodel="any-reviewer"\n');
    const original = (await request('GET', '/config')).data.permission.reviewer;
    expect(original).toMatchObject({ backend: 'jev', apiKeySource: 'kiki' });
    await request('POST', '/providers', { id: 'typesafe', type: 'openai' });
    expect((await request('POST', '/decision/move-reviewer-key', { connection: 'typesafe' })).code).not.toBe(0);
    expect((await request('GET', '/config')).data.permission.reviewer.apiKeySource).toBe('kiki');
    const moved = await request('POST', '/decision/move-reviewer-key', { connection: 'judgment' });
    expect(moved.data).toEqual({ connection: 'judgment', state: 'complete', retryable: false });
    expect((await request('POST', '/decision/move-reviewer-key', { connection: 'judgment' })).data).toEqual(moved.data);
    const after = (await request('GET', '/config')).data.permission.reviewer;
    expect(after).toMatchObject({ source: { kind: 'connection', connection: 'judgment' } });
    const credentials = await readFile(join(home!, 'credentials', 'credentials.toml'), 'utf8');
    expect(credentials).toContain('[providers.judgment]');
    expect(credentials).not.toContain('[permission.reviewer]');
    expect(JSON.stringify(after)).not.toContain('synthetic-old-key');

    let permission: any = { reviewer: { backend: 'jev', apiKey: 'retry-key', model: 'custom' } };
    let providers: any = {};
    let fail = 1;
    let failCleanup = false;
    const config = { ready: Promise.resolve(), inspect: (domain: string) => ({ userValue: domain === 'providers' ? providers : permission }), get: () => providers,
      replaceSections: async (sections: any, _target: unknown, expected: unknown) => {
        expect(expected).toEqual({ permission, providers });
        const value = sections.permission;
        if (fail-- > 0 || (failCleanup && value.reviewer.apiKey === undefined)) throw new Error('synthetic save failure');
        permission = value;
      } } as unknown as IConfigService;
    const createProvider = vi.fn(async (input: any) => { providers[input.id] = { type: input.type, baseUrl: input.base_url, apiKey: input.api_key, defaultModel: input.default_model }; });
    const mutation = { createProvider } as unknown as IModelCatalogMutationService;
    expect(await moveReviewerKeyToConnection(config, mutation, 'retry')).toMatchObject({ state: 'connection_saved', retryable: true });
    expect(permission.reviewer.apiKey).toBe('retry-key');
    expect(await moveReviewerKeyToConnection(config, mutation, 'retry')).toMatchObject({ state: 'complete' });
    expect(createProvider).toHaveBeenCalledOnce();
    expect(permission.reviewer.apiKey).toBeUndefined();
    permission = { reviewer: { backend: 'jev', apiKey: 'cleanup-key', model: 'cleanup-model' } };
    failCleanup = true;
    expect(await moveReviewerKeyToConnection(config, mutation, 'cleanup')).toMatchObject({ state: 'source_switched', retryable: true });
    expect(permission.reviewer).toMatchObject({ source: { kind: 'connection', connection: 'cleanup' }, apiKey: 'cleanup-key' });
    failCleanup = false;
    expect(await moveReviewerKeyToConnection(config, mutation, 'cleanup')).toMatchObject({ state: 'complete' });
    expect(permission.reviewer.apiKey).toBeUndefined();
    permission = { reviewer: { backend: 'jev' } };
    await expect(moveReviewerKeyToConnection(config, mutation, 'unused')).rejects.toThrow('no saved legacy');
  }, 30_000);

  it.each([
    ['switch', 'permission', 'connection_saved'],
    ['switch', 'connection', 'connection_saved'],
    ['cleanup', 'key', 'source_switched'],
    ['cleanup', 'source', 'source_switched'],
    ['cleanup', 'connection', 'source_switched'],
  ] as const)('preserves a concurrent %s-stage %s change and reports %s', async (phase, change, state) => {
    const active = await boot('[permission.reviewer]\nbackend="jev"\napi_key="synthetic-old-key"\nmodel="synthetic-model"\n');
    const config = active.core.accessor.get(IConfigService);
    let concurrent: Promise<void> | undefined;
    let scheduled = false;
    const subscription = config.onDidChangeConfiguration((event) => {
      if (scheduled || event.domain !== (phase === 'switch' ? 'providers' : 'permission')) return;
      scheduled = true;
      const current = config.inspect<PermissionConfig>('permission').userValue;
      concurrent = change === 'connection'
        ? config.set('providers', { moved: { apiKey: 'synthetic-new-provider-key' } })
        : change === 'key' ? config.set('permission', { reviewer: { apiKey: 'synthetic-new-key' } })
          : config.replace('permission', { ...current, dangerousBash: 'off', reviewer: { ...current?.reviewer, source: { kind: 'model', model: 'newer-selection' } } });
    });
    try {
      const result = await moveReviewerKeyToConnection(config, active.core.accessor.get(IModelCatalogMutationService), 'moved');
      await concurrent;
      expect(scheduled).toBe(true);
      expect(result).toEqual({ connection: 'moved', state, retryable: true });
      const permission = config.inspect<PermissionConfig>('permission').userValue;
      expect(permission?.reviewer?.apiKey).toBe(change === 'key' ? 'synthetic-new-key' : 'synthetic-old-key');
      if (change === 'permission' || change === 'source') {
        expect(permission).toMatchObject({ dangerousBash: 'off', reviewer: { source: { kind: 'model', model: 'newer-selection' } } });
      }
      expect(config.inspect<ProvidersSection>('providers').userValue?.['moved']?.apiKey)
        .toBe(change === 'connection' ? 'synthetic-new-provider-key' : 'synthetic-old-key');
      const credentials = await readFile(join(home!, 'credentials', 'credentials.toml'), 'utf8');
      expect(credentials).toContain(change === 'key' ? 'synthetic-new-key' : 'synthetic-old-key');
    } finally { subscription.dispose(); }
  });

  it('keeps keyless legacy HTTP selectors usable and accepts arbitrary custom auth headers on new connections', async () => {
    const calls: { path: string; authorization?: string; token?: string | string[] }[] = [];
    upstream = createServer(async (req, res) => {
      for await (const _chunk of req) {}
      calls.push({ path: req.url ?? '', authorization: req.headers.authorization, token: req.headers['x-decision-token'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/unauthorized' || req.url === '/v1/forbidden') {
        res.statusCode = req.url === '/v1/unauthorized' ? 401 : 403;
        res.end('{}');
      } else res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }));
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const active = await boot();
    expect((await request('POST', '/providers', { id: 'local', type: 'openai', base_url: `${origin}/v1`, models: [{ remote_id: 'synthetic', max_context_size: 4096 }] })).code).toBe(0);
    const selector = active.core.accessor.get(IMemorySelector);
    const legacy = memoryAdvisorConfigSchema.parse({ selector: { protocol: 'pair_score', model: 'local/synthetic' }, egress_ack: [{ workspace_id: 'synthetic-workspace', destination: `local@${origin}` }] });
    const input = { stage: 'discover' as const, query: 'Synthetic tea task', units: [{ handle: 'c0', text: 'Synthetic tea preference' }], signal: new AbortController().signal, attribution, stats: selectorStats() };
    expect(selector.describe(legacy, 'synthetic-workspace')).toMatchObject({ state: 'ready', source_status: { state: 'ready', credential_source: 'none' }, consent_required: false });
    expect(await selector.call({ ...input, config: legacy })).toEqual([{ handle: 'c0', score: 0.9 }]);
    expect(input.stats.requests).toBe(1);
    expect(calls[0]).toEqual({ path: '/v1/rerank', authorization: undefined, token: undefined });
    expect((await request('POST', '/providers', { id: 'header-ranker', type: 'pair_score', base_url: `${origin}/v1`, default_model: 'synthetic-ranker' })).code).toBe(0);
    expect((await request('PATCH', '/providers/header-ranker', { custom_headers: { 'X-Decision-Token': 'synthetic-header-key' } })).code).toBe(0);
    const config = memoryAdvisorConfigSchema.parse({ source: { kind: 'connection', connection: 'header-ranker' }, egress_ack: [{ workspace_id: 'synthetic-workspace', destination: `header-ranker@${origin}` }] });
    expect(selector.describe(config, 'synthetic-workspace')).toMatchObject({ state: 'ready', source_status: { state: 'ready', credential_source: 'headers' }, consent_required: false });
    expect(await selector.call({ ...input, config })).toEqual([{ handle: 'c0', score: 0.9 }]);
    expect(calls[1]).toEqual({ path: '/v1/rerank', authorization: undefined, token: 'synthetic-header-key' });
    for (const decision_endpoint of ['/v1/unauthorized', '/v1/forbidden']) {
      expect((await request('PATCH', '/providers/header-ranker', { decision_endpoint })).code).toBe(0);
      await expect(selector.call({ ...input, config })).rejects.toMatchObject({ reason: 'auth' });
    }
    expect(calls).toHaveLength(4);
  });
});

import { createServer, type Server } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { IAgentExecutorRegistry, IAgentLifecycleService, IPluginService, IPluginSettingsService, ISessionManager } from '@kiki/agent-core-v2';
import { IAgentExecutionService } from '@kiki/agent-core-v2/agent/execution/execution';
import type { ExecutorInstanceConfig, GetExecutorModelsResponse, ListExecutorsResponse } from '@kiki/protocol';

import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const sourceId = 'plugin:fixture-account-source/accounts';
const pluginPath = fileURLToPath(new URL('../../agent-core-v2/test/fixtures/plugin-account-source', import.meta.url));
const agyFixture = fileURLToPath(new URL('../../agent-core-v2/test/fixtures/plugin-account-agy.mjs', import.meta.url));
const accounts = [
  { id: 'work', label: 'Work login', status: 'ready', oauthToken: 'fixture-oauth-secret' },
  { id: 'personal', label: 'Personal login', status: 'ready' },
  { id: 'signed-out', label: 'Old login', status: 'signed_out' },
];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture requires a loopback port');
  return address.port;
}

it('uses only the selected plugin account through the HTTP-to-harness execution path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-plugin-accounts-'));
  const audit = join(home, 'agy-audit');
  const codexPath = process.env['KIKI_TEST_CODEX_PATH'];
  const leaseEvents: Array<{ action: string; accountId?: string; instanceId?: string; proxy?: unknown }> = [];
  const observations: Array<{ account: string; path?: string; keyMatches: boolean; body: Record<string, unknown> }> = [];
  const leases = new Map<string, string>();
  const endpoints = new Map<string, number>();
  let nextLease = 0;
  const origin = (account: string) => createServer(async (req, res) => {
    const raw = await buffer(req);
    const body = raw.length === 0 ? {} : JSON.parse(raw.toString());
    const keyMatches = req.headers['x-goog-api-key'] === `fixture-capability-${account}`
      || req.headers.authorization === `Bearer fixture-capability-${account}`;
    observations.push({ account, path: req.url, keyMatches, body });
    if (!keyMatches || body.text === 'deny fixture') {
      res.writeHead(429); res.end(`Fixture source rejected the request: fixture-capability-${account}`); return;
    }
    if (req.url === '/v1/responses') {
      const message = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Codex fixture reply', annotations: [] }] };
      const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: body.model, output: [message],
        usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 5 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: 'Codex fixture reply' },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    res.end(`${account} fixture reply`);
  });
  const work = origin('work');
  const personal = origin('personal');
  const control = createServer(async (req, res) => {
    const input = JSON.parse((await buffer(req)).toString());
    res.setHeader('content-type', 'application/json');
    if (req.url === '/list') { leaseEvents.push({ action: 'list' }); res.end(JSON.stringify(accounts)); return; }
    if (req.url === '/release') {
      leaseEvents.push({ action: 'release', accountId: leases.get(input.leaseId) }); leases.delete(input.leaseId);
      res.end('{}'); return;
    }
    const { accountId, instanceId, proxy, engineId } = input;
    leaseEvents.push({ action: 'prepare', accountId, instanceId, proxy });
    if (!endpoints.has(accountId)) { res.writeHead(403); res.end('{}'); return; }
    const leaseId = `fixture-lease-${++nextLease}`;
    leases.set(leaseId, accountId);
    const codex = engineId === 'codex-app-server';
    res.end(JSON.stringify({ leaseId, connection: {
      protocol: codex ? 'openai-responses' : 'gemini-v1beta',
      baseUrl: `http://127.0.0.1:${endpoints.get(accountId)}${codex ? '/v1' : ''}`,
      apiKey: `fixture-capability-${accountId}`, modelIds: [codex ? 'gpt-5.4' : `${accountId}-fixture-model`],
    } }));
  });
  let server: RunningServer | undefined;
  try {
    await mkdir(audit);
    const workspace = join(home, 'workspace');
    const codexHome = join(home, 'codex');
    await Promise.all([mkdir(workspace), mkdir(codexHome)]);
    const [workPort, personalPort, controlPort] = await Promise.all([listen(work), listen(personal), listen(control)]);
    endpoints.set('work', workPort); endpoints.set('personal', personalPort);
    vi.stubEnv('AGY_BRIDGE_AUDIT_DIR', audit);
    vi.stubEnv('CODEX_HOME', codexHome);
    await writeFile(join(home, 'config.toml'), [
      '[search]', 'enabled = false', '[agent_executors.agy-cli]', 'label = "AGY CLI"', 'protocol = "acp-v1"',
      'model_binding = "argv"', 'model_args = ["--model", "{model}"]', 'model_config_category = "model"',
      'permission = { via = "config_option", config_id = "permission-mode", manual = "manual", auto = "auto", yolo = "yolo" }',
      'stdin_close_grace_ms = 2000', `sources = [{ id = "fixture", kind = "node-script", path = ${JSON.stringify(agyFixture)} }]`,
      ...(codexPath === undefined ? [] : ['[agent_executor_overrides.codex-app-server]', `bin_path = ${JSON.stringify(codexPath)}`]),
    ].join('\n'));
    const boot = () => startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    server = await boot();
    const call = async <T>(path: string, method = 'GET', body?: unknown) => {
      const response = await authedFetch(server!, `http://127.0.0.1:${server!.port}`, `/api${path}`, {
        method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      return await response.json() as { code: number; msg: string; data: T };
    };
    const ok = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
      const result = await call<T>(path, method, body);
      expect(result.code, result.msg).toBe(0);
      return result.data;
    };
    const manager = () => server!.core.accessor.get(ISessionManager);
    const executors = () => server!.core.accessor.get(IAgentExecutorRegistry);
    const plugins = () => server!.core.accessor.get(IPluginService);
    const list = async () => (await ok<ListExecutorsResponse>('/executors')).items;
    const create = async (executor: string) => (await ok<{ id: string }>('/sessions', 'POST', {
      metadata: { cwd: workspace }, agent_config: { execution: { executor }, permission_mode: 'yolo' },
    })).id;
    const send = async (sessionId: string, text: string) => {
      const receipt = await call(`/sessions/${sessionId}/prompts`, 'POST', { content: [{ type: 'text', text }] });
      if (receipt.code === 0) await manager().get(sessionId)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentExecutionService).settled();
      return receipt;
    };
    const initial = await list();
    expect(initial.filter((item) => item.id === 'agy-cli')).toHaveLength(1);
    expect(initial.filter((item) => item.instance)).toHaveLength(0);
    expect(await ok('/executors/agy-cli/account-sources')).toEqual({ items: [] });
    const plan = await plugins().previewPlugin({ source: pluginPath });
    await plugins().installPlugin({ source: pluginPath, fingerprint: plan.fingerprint, consent: true });
    await server.core.accessor.get(IPluginSettingsService).update({ pluginId: 'fixture-account-source', values: { controlPlane: `http://127.0.0.1:${controlPort}` } });
    const defaultRevision = executors().get('agy-cli')!.revision;
    expect(await ok('/executors/agy-cli/account-sources')).toEqual({ items: [{ id: sourceId, label: 'Fixture OAuth' }] });
    expect(leaseEvents).toEqual([]);
    const listed = await ok(`/executors/agy-cli/accounts?source=${encodeURIComponent(sourceId)}`);
    expect(listed).toEqual({ items: accounts.map(({ id, label, status }) => ({ id, label, status })) });
    const instance = (account_id: string, proxy: ExecutorInstanceConfig['proxy'], source_executor = 'agy-cli'): ExecutorInstanceConfig => ({
      source_executor, label: `Fixture ${account_id}`, configuration: { kind: 'plugin_account', source: sourceId, account_id }, proxy,
    });
    await ok('/config', 'POST', { agent_executor_instances: {
      'instance-work': instance('work', { kind: 'direct' }),
      'instance-personal': instance('personal', { kind: 'url', url: 'socks5://127.0.0.1:54321' }),
      'instance-signed-out': instance('signed-out', { kind: 'inherit' }),
      ...(codexPath === undefined ? {} : { 'instance-codex': instance('work', { kind: 'direct' }, 'codex-app-server') }),
    } });
    expect(await ok('/executors/instance-work/check', 'POST')).toMatchObject({ status: 'ready', credential_source: 'external_backend', credential_detail: expect.stringContaining('Work login') });
    expect(await ok('/executors/instance-signed-out/check', 'POST')).toMatchObject({ status: 'unavailable', login_status: 'logged_out' });
    const initialModels = await ok<GetExecutorModelsResponse>('/executors/instance-work/models:refresh', 'POST');
    expect(initialModels.effective.models).toMatchObject({ state: 'unknown' });
    expect(leaseEvents.every(({ action }) => action === 'list')).toBe(true);
    const [a, b, defaultAgy, unavailable] = await Promise.all(['instance-work', 'instance-personal', 'agy-cli', 'instance-signed-out'].map(create));
    expect((await Promise.all([send(a!, 'work request'), send(b!, 'personal request'), send(defaultAgy!, 'default request')])).map(({ code }) => code)).toEqual([0, 0, 0]);
    expect(leaseEvents.filter(({ action }) => action === 'prepare').toSorted((x, y) => x.accountId!.localeCompare(y.accountId!))).toEqual([
      { action: 'prepare', accountId: 'personal', instanceId: 'instance-personal', proxy: { mode: 'custom', url: 'socks5://127.0.0.1:54321' } },
      { action: 'prepare', accountId: 'work', instanceId: 'instance-work', proxy: { mode: 'direct' } },
    ]);
    expect(observations.toSorted((x, y) => x.account.localeCompare(y.account))).toMatchObject(['personal', 'work'].map((account) => ({
      account, keyMatches: true, path: `/v1beta/models/${account}-fixture-model:streamGenerateContent?alt=sse`, body: {
        model: `${account}-fixture-model`, settings: { modelProvider: 'gemini', toolPermission: 'always-proceed', customModelsConfig: { customModels: {
          [`${account}-fixture-model`]: { modelName: `gemini-api://models/${account}-fixture-model`, toolFormatterType: 'TOOL_FORMATTER_TYPE_NONE' },
        } } },
      },
    })));
    expect(observations.every(({ body }) => body['proxy'] === undefined)).toBe(true);
    const negotiated = await ok<GetExecutorModelsResponse>('/executors/instance-work/models:refresh', 'POST');
    expect(negotiated.effective.models).toMatchObject({ state: 'ready', values: ['work-fixture-model'] });
    const rejected = await send(unavailable!, 'must not fall back');
    expect(rejected.code).not.toBe(0);
    expect(rejected.msg).toContain(sourceId);
    expect(observations).toHaveLength(2);
    const nativeConversation = observations.find(({ account }) => account === 'work')!.body['conversation_id'];
    await manager().close(a!);
    await vi.waitFor(() => expect(leaseEvents).toContainEqual({ action: 'release', accountId: 'work' }));
    expect((await send(a!, 'restored request')).code).toBe(0);
    expect(observations.at(-1)).toMatchObject({ account: 'work', body: { conversation_id: nativeConversation } });
    await send(a!, 'deny fixture');
    expect(observations.filter(({ body }) => body['text'] === 'deny fixture')).toEqual([expect.objectContaining({ account: 'work' })]);
    await vi.waitFor(() => expect(leaseEvents.filter(({ action, accountId }) => action === 'release' && accountId === 'work')).toHaveLength(2));
    await send(b!, 'exit fixture');
    await vi.waitFor(() => expect(leaseEvents).toContainEqual({ action: 'release', accountId: 'personal' }));
    if (codexPath !== undefined) {
      const codex = await create('instance-codex');
      expect((await send(codex, 'codex fixture request')).code).toBe(0);
      expect(observations.at(-1)).toMatchObject({ account: 'work', path: '/v1/responses', keyMatches: true, body: { model: 'gpt-5.4' } });
    }
    const config = await ok('/config');
    const auditContent = await Promise.all((await readdir(audit)).filter((name) => name.endsWith('.ndjson')).map((name) => readFile(join(audit, name), 'utf8')));
    expect(JSON.stringify([listed, config, await list(), ...auditContent])).not.toMatch(/fixture-capability|fixture-lease|fixture-oauth/);
    expect(executors().get('agy-cli')!.revision).toBe(defaultRevision);
    await plugins().setPluginEnabled({ id: 'fixture-account-source', enabled: false });
    expect(await ok('/executors/agy-cli/account-sources')).toEqual({ items: [] });
    expect(await ok('/executors/instance-work/check', 'POST')).toMatchObject({ status: 'unavailable', diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'instance_account_source_unavailable' }),
    ]) });
    await ok('/executors/instance-work/registration:remove', 'POST');
    expect((await list()).filter(({ id }) => id === 'agy-cli')).toHaveLength(1);
    expect(executors().get('agy-cli')!.revision).toBe(defaultRevision);
  } finally {
    await server?.close();
    for (const endpoint of [work, personal, control]) endpoint.closeAllConnections();
    await Promise.all([work, personal, control].map(async (endpoint) => {
      if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }));
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 120_000);

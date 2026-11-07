import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { IAgentExecutorRegistry, IAgentLifecycleService, IAgentProfileService, IPluginService, ISessionManager } from '@kiki/agent-core-v2';
import { IAgentExecutionService } from '@kiki/agent-core-v2/agent/execution/execution';
import { createKlient as createHttpKlient } from '@kiki/klient/http';

import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const sourceId = 'plugin:fixture-quota/example';
const pluginPath = fileURLToPath(new URL('../../agent-core-v2/test/fixtures/plugin-quota-source', import.meta.url));
const fixture = fileURLToPath(new URL('../../agent-core-v2/test/fixtures/executor-instance-agent.mjs', import.meta.url));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Loopback listener has no port');
  return address.port;
}

it('selects AGY and another harness from config, then serves the same quota cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-executor-schedule-'));
  const counts = join(home, 'quota-reads.txt');
  const hits: string[] = [];
  const origin = createServer((req, res) => {
    hits.push(String(req.headers['x-fixture-account']));
    res.end('ok');
  });
  let server: RunningServer | undefined;
  try {
    const port = await listen(origin);
    const accountHome = async (id: string) => {
      const directory = join(home, id);
      await mkdir(directory);
      await writeFile(join(directory, 'account.json'), JSON.stringify({ id, key: 'fixture-key', endpoint: `http://127.0.0.1:${port}/messages` }));
      return directory;
    };
    const [mainHome, workHome, personalHome, otherHome] = await Promise.all([
      accountHome('main'), accountHome('work'), accountHome('personal'), accountHome('other'),
    ]);
    const descriptor = (label: string) => [
      `label = ${JSON.stringify(label)}`, 'protocol = "acp-v1"', 'home_env = "INSTANCE_HOME"', 'model_binding = "session_config"',
      `sources = [{ id = "fixture", kind = "node-script", path = ${JSON.stringify(fixture)} }]`,
    ];
    await writeFile(join(home, 'config.toml'), [
      '[search]', 'enabled = false',
      '[agent_executors.agy-cli]', ...descriptor('AGY CLI'),
      '[agent_executors.agy-cli.model_probe]', 'args = ["models"]', 'format = "lines"',
      '[agent_executor_overrides.agy-cli]', `home_dir = ${JSON.stringify(mainHome)}`,
      '[agent_executors.fixture-acp]', ...descriptor('Fixture harness'),
      '[agent_executors.fixture-acp.model_probe]', 'args = ["models"]', 'format = "lines"',
    ].join('\n'));
    const env = { ...process.env, QUOTA_COUNT_FILE: counts, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' };
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', env });
    const call = async <T>(path: string, method = 'GET', body?: unknown) => {
      const response = await authedFetch(server!, `http://127.0.0.1:${server!.port}`, `/api${path}`, {
        method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      return await response.json() as { code: number; msg: string; data: T };
    };
    const ok = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
      const result = await call<T>(path, method, body);
      expect(result.code, result.msg).toBe(0);
      return result.data;
    };
    const plugins = server.core.accessor.get(IPluginService);
    const plan = await plugins.previewPlugin({ source: pluginPath });
    await plugins.installPlugin({ source: pluginPath, fingerprint: plan.fingerprint, consent: true });
    const client = createHttpKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
    const instance = (source: string, label: string, path: string, account: string) => ({
      source_executor: source, label, configuration: { kind: 'config_directory' as const, path }, proxy: { kind: 'direct' as const },
      quota_account_id: account,
    });
    await client.rest!.config.patch({
      agent_executor_overrides: {
        'agy-cli': { quota_source: sourceId, defaults: { executor_instance: 'auto' } },
        'fixture-acp': { quota_source: sourceId },
      },
      agent_executor_instances: {
        'instance-work': instance('agy-cli', 'Work', workHome, 'work'),
        'instance-personal': instance('agy-cli', 'Personal', personalHome, 'personal'),
        'instance-other': { ...instance('fixture-acp', 'Other', otherHome, 'other'), launch: { env: { EXAMPLE_FLAG: '1' }, args: ['--example'] } },
      },
    });
    expect((await client.rest!.harnessQuota.cached()).sources.find((item) => item.id === sourceId)?.readings).toBeUndefined();
    const manager = () => server!.core.accessor.get(ISessionManager);
    const scheduleOf = (id: string) => manager().get(id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService).data().execution?.schedule;
    const create = async (executor: string, executor_instance?: 'main' | 'auto') => (await ok<{ id: string }>('/sessions', 'POST', {
      metadata: { cwd: home }, agent_config: { execution: executor_instance === undefined ? { executor } : { executor, overrides: { executor_instance } } },
    })).id;
    const send = async (sessionId: string) => {
      const receipt = await call(`/sessions/${sessionId}/prompts`, 'POST', { content: [{ type: 'text', text: 'Fixture request' }] });
      expect(receipt.code, receipt.msg).toBe(0);
      await manager().get(sessionId)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentExecutionService).settled();
    };
    const reads = async () => Number(await readFile(counts, 'utf8'));
    const auto = await create('agy-cli');
    await send(auto);
    expect(scheduleOf(auto)).toMatchObject({ instance: 'instance-work', choice: 'auto', source: 'harness-settings', quota_consulted: true, quota_source: sourceId });
    expect(hits.at(-1)).toBe('work');
    expect(await reads()).toBe(1);
    await send(auto);
    expect(await reads()).toBe(1);
    expect(scheduleOf(auto)?.instance).toBe('instance-work');
    const manualMain = await create('agy-cli', 'main');
    await send(manualMain);
    expect(scheduleOf(manualMain)).toMatchObject({ instance: 'main', choice: 'main', source: 'session', quota_consulted: false });
    expect(hits.at(-1)).toBe('main');
    expect(await reads()).toBe(1);
    const personal = await create('instance-personal');
    await send(personal);
    expect(scheduleOf(personal)).toMatchObject({ instance: 'instance-personal', choice: 'instance-personal', quota_consulted: false });
    expect(hits.at(-1)).toBe('personal');
    const otherSession = await create('instance-other');
    await send(otherSession);
    expect(scheduleOf(otherSession)?.instance).toBe('instance-other');
    expect(hits.at(-1)).toBe('other');
    expect(await reads()).toBe(1);
    const cached = await client.rest!.harnessQuota.cached();
    expect(cached.sources.find((item) => item.id === sourceId)?.readings?.map((item) => item.accountId)).toEqual(['work', 'personal', 'other']);
    const demanded = await client.rest!.harnessQuota.read(sourceId);
    expect(demanded.sources).toHaveLength(1);
    expect(await reads()).toBe(1);
    await client.rest!.config.patch({ agent_executor_instances: { 'instance-other': instance('fixture-acp', 'Other', otherHome, 'other') } });
    expect(server.core.accessor.get(IAgentExecutorRegistry).get('instance-other')?.env?.['EXAMPLE_FLAG']).toBe('1');
    expect(server.core.accessor.get(IAgentExecutorRegistry).get('instance-other')?.extraArgs).toEqual(['--example']);
    await client.close();
  } finally {
    await server?.close();
    origin.closeAllConnections();
    if (origin.listening) await new Promise<void>((resolve) => origin.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 90_000);

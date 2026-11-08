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
const grokSourceId = 'plugin:fixture-quota/grok';
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
  const grokCounts = join(home, 'quota-grok-reads.txt');
  const hits: string[] = [];
  const bodies: Array<{ pid?: number; exampleFlag?: string; extraFlag?: string; grokHome?: string; grokAuthPath?: string; xaiApiKey?: string; argv?: string[] }> = [];
  let holdOutbound = false;
  const heldReleases: Array<() => void> = [];
  const heldLive: Array<{ account: string; pid?: number }> = [];
  const droppedWhileHeld: string[] = [];
  let markPair = (): void => undefined;
  let pairReady = new Promise<void>((resolve) => { markPair = resolve; });
  let markCancelled = (): void => undefined;
  const aCancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
  const origin = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = raw === '' ? {} : JSON.parse(raw) as { pid?: number };
    bodies.push(parsed);
    const account = String(req.headers['x-fixture-account']);
    hits.push(account);
    if (holdOutbound) {
      heldLive.push({ account, pid: parsed.pid });
      if (new Set(heldLive.map((item) => item.account)).size >= 2) markPair();
      await new Promise<void>((resolve) => {
        heldReleases.push(resolve);
        res.once('close', () => {
          if (!res.writableEnded) {
            droppedWhileHeld.push(account);
            if (account === 'work') markCancelled();
          }
          resolve();
        });
      });
    }
    if (!res.destroyed && !res.writableEnded) res.end('ok');
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
    const grokAccountHome = async (dirName: string, email: string, token: string) => {
      const directory = join(home, dirName);
      await mkdir(directory);
      await writeFile(join(directory, 'auth.json'), JSON.stringify({
        'https://grok.com': { email, key: token, endpoint: `http://127.0.0.1:${port}/messages` },
      }));
      return directory;
    };
    const [mainHome, workHome, personalHome, otherHome, exhaustedHome, grokGlobalHome, grokAccountAHome, grokAccountBHome] = await Promise.all([
      accountHome('main'), accountHome('work'), accountHome('personal'), accountHome('other'), accountHome('exhausted'),
      grokAccountHome('grok-global-active', 'global-active@example.test', 'tok-global'),
      grokAccountHome('grok-acct-a', 'grok-a@example.test', 'tok-a'),
      grokAccountHome('grok-acct-b', 'grok-b@example.test', 'tok-b'),
    ]);
    const poisonedAuthFile = join(home, 'poisoned-grok-auth.json');
    await writeFile(poisonedAuthFile, JSON.stringify({
      'https://grok.com': { email: 'poisoned-host-env@example.test', key: 'tok-poisoned', endpoint: `http://127.0.0.1:${port}/messages` },
    }));
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
      '[agent_executor_overrides.grok-acp]',
      `bin_path = ${JSON.stringify(fixture)}`,
      `home_dir = ${JSON.stringify(grokGlobalHome)}`,
    ].join('\n'));
    const env = {
      ...process.env,
      QUOTA_COUNT_FILE: counts,
      GROK_HOME: grokGlobalHome,
      GROK_AUTH_PATH: poisonedAuthFile,
      XAI_API_KEY: 'host-xai-api-key',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    };
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
    const patchedConfig = await client.rest!.config.patch({
      agent_executor_overrides: {
        'agy-cli': { quota_source: sourceId, defaults: { executor_instance: 'auto' } },
        'fixture-acp': { quota_source: grokSourceId, defaults: { executor_instance: 'auto' } },
        'grok-acp': { quota_source: grokSourceId, defaults: { executor_instance: 'auto' } },
      },
      agent_executor_instances: {
        'instance-exhausted': instance('agy-cli', 'Exhausted', exhaustedHome, 'exhausted'),
        'instance-work': instance('agy-cli', 'Work', workHome, 'work'),
        'instance-personal': instance('agy-cli', 'Personal', personalHome, 'personal'),
        'instance-other-zero': instance('fixture-acp', 'Other exhausted', exhaustedHome, 'exhausted'),
        'instance-other': { ...instance('fixture-acp', 'Other', otherHome, 'other'), launch: { env: { EXAMPLE_FLAG: '1' }, args: ['--example'] } },
        'instance-grok-a': instance('grok-acp', 'Grok Account A', grokAccountAHome, 'grok-a@example.test'),
        'instance-grok-b': instance('grok-acp', 'Grok Account B', grokAccountBHome, 'grok-b@example.test'),
      },
    });
    expect(patchedConfig.raw?.['agent_executor_overrides']).toMatchObject({
      'agy-cli': { home_dir: mainHome, quota_source: sourceId, defaults: { executor_instance: 'auto' } },
      'fixture-acp': { quota_source: grokSourceId, defaults: { executor_instance: 'auto' } },
      'grok-acp': { home_dir: grokGlobalHome, quota_source: grokSourceId, defaults: { executor_instance: 'auto' } },
    });
    expect((await client.rest!.config.get()).raw?.['agent_executor_overrides']).toMatchObject({
      'agy-cli': { home_dir: mainHome, quota_source: sourceId, defaults: { executor_instance: 'auto' } },
      'fixture-acp': { quota_source: grokSourceId, defaults: { executor_instance: 'auto' } },
      'grok-acp': { home_dir: grokGlobalHome, quota_source: grokSourceId, defaults: { executor_instance: 'auto' } },
    });
    const countFile = async (name: string) => Number(await readFile(join(home, name), 'utf8').catch(() => '0'));
    const waitForCount = async (name: string, expected: number) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await countFile(name) >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`${name} stayed at ${await countFile(name)}`);
    };
    const quotaRead = (source: string, signal: AbortSignal) => authedFetch(server!, `http://127.0.0.1:${server!.port}`, '/api/harness-quota/read', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }), signal,
    });
    const hold = join(home, 'quota-hold');
    await writeFile(hold, '1');
    const cancelExample = new AbortController();
    const exampleSurvivor = quotaRead(sourceId, AbortSignal.timeout(20_000));
    const exampleCancelled = quotaRead(sourceId, AbortSignal.any([cancelExample.signal, AbortSignal.timeout(20_000)]));
    await waitForCount('example-started.txt', 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancelExample.abort();
    await expect(exampleCancelled).rejects.toThrow();
    expect(await countFile('example-started.txt')).toBe(1);
    expect(await countFile('example-cancelled.txt')).toBe(0);
    await rm(hold, { force: true });
    const shared = await (await exampleSurvivor).json() as { code: number; data: { sources: Array<{ readings?: Array<{ accountId: string }> }> } };
    expect(shared.code).toBe(0);
    expect(shared.data.sources[0]?.readings?.map((item) => item.accountId)).toEqual(['exhausted', 'work', 'personal', 'other']);
    expect(await countFile('quota-reads.txt')).toBe(1);
    await writeFile(hold, '1');
    const cancelGrok = new AbortController();
    const grokCancelled = quotaRead(grokSourceId, AbortSignal.any([cancelGrok.signal, AbortSignal.timeout(20_000)]));
    await waitForCount('grok-started.txt', 1);
    cancelGrok.abort();
    await expect(grokCancelled).rejects.toThrow();
    await waitForCount('grok-cancelled.txt', 1);
    expect(await countFile('quota-grok-reads.txt')).toBe(0);
    await rm(hold, { force: true });
    expect((await client.rest!.harnessQuota.cached()).sources.find((item) => item.id === sourceId)?.readings?.map((item) => item.accountId)).toEqual(['exhausted', 'work', 'personal', 'other']);
    expect((await client.rest!.harnessQuota.cached()).sources.find((item) => item.id === grokSourceId)?.readings).toBeUndefined();
    const manager = () => server!.core.accessor.get(ISessionManager);
    const scheduleOf = (id: string) => manager().get(id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService).data().execution?.schedule;
    const create = async (executor: string, overrides?: Record<string, unknown>) => (await ok<{ id: string }>('/sessions', 'POST', {
      metadata: { cwd: home }, agent_config: { execution: overrides === undefined ? { executor } : { executor, overrides } },
    })).id;
    const send = async (sessionId: string) => {
      const receipt = await call(`/sessions/${sessionId}/prompts`, 'POST', { content: [{ type: 'text', text: 'Fixture request' }] });
      expect(receipt.code, receipt.msg).toBe(0);
      await manager().get(sessionId)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentExecutionService).settled();
    };
    const reads = async () => Number(await readFile(counts, 'utf8'));
    const grokReads = async () => Number(await readFile(grokCounts, 'utf8'));
    const missingAccount = await call('/sessions', 'POST', {
      metadata: { cwd: home },
      agent_config: { execution: { executor: 'agy-cli', overrides: { executor_instance: { account_id: 'missing' } } } },
    });
    expect(missingAccount.code).toBe(40001);
    expect(missingAccount.msg).toContain('Executor account "missing" is not configured for "agy-cli"');
    const auto = await create('agy-cli');
    await send(auto);
    expect(scheduleOf(auto)).toMatchObject({ instance: 'instance-work', choice: 'auto', source: 'harness-settings', quota_consulted: true, quota_source: sourceId });
    expect(hits.at(-1)).toBe('work');
    expect(await reads()).toBe(1);
    await send(auto);
    expect(await reads()).toBe(1);
    expect(scheduleOf(auto)?.instance).toBe('instance-work');
    const manualMain = await create('agy-cli', { executor_instance: 'main' });
    await send(manualMain);
    expect(scheduleOf(manualMain)).toMatchObject({ instance: 'main', choice: 'main', source: 'session', quota_consulted: false });
    expect(hits.at(-1)).toBe('main');
    expect(await reads()).toBe(1);
    const explicitAccount = await create('agy-cli', { executor_instance: { account_id: 'personal' } });
    await send(explicitAccount);
    expect(scheduleOf(explicitAccount)).toMatchObject({ instance: 'instance-personal', choice: { account_id: 'personal' }, source: 'session', quota_consulted: false });
    expect(hits.at(-1)).toBe('personal');
    const personal = await create('instance-personal');
    await send(personal);
    expect(scheduleOf(personal)).toMatchObject({ instance: 'instance-personal', choice: 'instance-personal', quota_consulted: false });
    expect(hits.at(-1)).toBe('personal');
    const autoOther = await create('fixture-acp');
    await send(autoOther);
    expect(scheduleOf(autoOther)).toMatchObject({ instance: 'instance-other', choice: 'auto', source: 'harness-settings', quota_consulted: true, quota_source: grokSourceId });
    expect(hits.at(-1)).toBe('other');
    expect(bodies.at(-1)).toMatchObject({ exampleFlag: '1', argv: ['--example'] });
    expect(await grokReads()).toBe(1);
    const clearedLaunchSession = await create('instance-other', {
      executor_launch: { env: { EXAMPLE_FLAG: null, EXTRA_FLAG: '2' }, args: [] },
    });
    await send(clearedLaunchSession);
    expect(hits.at(-1)).toBe('other');
    expect(bodies.at(-1)?.exampleFlag).toBeUndefined();
    expect(bodies.at(-1)?.extraFlag).toBe('2');
    expect(bodies.at(-1)?.argv).toEqual([]);
    expect(await reads()).toBe(1);
    const grokAuto = await create('grok-acp');
    await send(grokAuto);
    expect(scheduleOf(grokAuto)).toMatchObject({ instance: 'instance-grok-b', choice: 'auto', source: 'harness-settings', quota_consulted: true, quota_source: grokSourceId });
    expect(hits.at(-1)).toBe('grok-b@example.test');
    expect(bodies.at(-1)).toMatchObject({ grokHome: grokAccountBHome });
    expect(bodies.at(-1)?.grokAuthPath).toBeUndefined();
    expect(bodies.at(-1)?.xaiApiKey).toBeUndefined();
    expect(await grokReads()).toBe(1);
    const grokExplicitAccountA = await create('grok-acp', { executor_instance: { account_id: 'grok-a@example.test' } });
    await send(grokExplicitAccountA);
    expect(scheduleOf(grokExplicitAccountA)).toMatchObject({ instance: 'instance-grok-a', choice: { account_id: 'grok-a@example.test' }, source: 'session', quota_consulted: false });
    expect(hits.at(-1)).toBe('grok-a@example.test');
    expect(bodies.at(-1)).toMatchObject({ grokHome: grokAccountAHome });
    expect(bodies.at(-1)?.grokAuthPath).toBeUndefined();
    expect(bodies.at(-1)?.xaiApiKey).toBeUndefined();
    expect(JSON.parse(await readFile(join(grokGlobalHome, 'auth.json'), 'utf8'))['https://grok.com'].email).toBe('global-active@example.test');
    const cached = await client.rest!.harnessQuota.cached();
    expect(cached.sources.find((item) => item.id === sourceId)?.readings?.map((item) => item.accountId)).toEqual(['exhausted', 'work', 'personal', 'other']);
    expect(cached.sources.find((item) => item.id === grokSourceId)?.readings?.map((item) => item.accountId)).toEqual(['exhausted', 'other', 'grok-b@example.test', 'grok-a@example.test']);
    const providerQuotaSnapshot = await ok<{ sources: Array<{ id: string; provider_id: string; kind: string }> }>('/usage/provider-quotas');
    const engineIdsInQuota = providerQuotaSnapshot.sources.filter((item) => item.kind === 'executor').map((item) => item.provider_id);
    expect(engineIdsInQuota).toEqual(expect.arrayContaining(['agy-cli', 'fixture-acp', 'grok-acp']));
    expect(engineIdsInQuota).not.toContain('instance-work');
    expect(engineIdsInQuota).not.toContain('instance-personal');
    expect(engineIdsInQuota).not.toContain('instance-grok-a');
    const demanded = await client.rest!.harnessQuota.read(sourceId);
    expect(demanded.sources).toHaveLength(1);
    expect(await reads()).toBe(1);
    await client.rest!.config.patch({ agent_executor_instances: { 'instance-other': instance('fixture-acp', 'Other', otherHome, 'other') } });
    expect(server.core.accessor.get(IAgentExecutorRegistry).get('instance-other')?.env?.['EXAMPLE_FLAG']).toBe('1');
    expect(server.core.accessor.get(IAgentExecutorRegistry).get('instance-other')?.extraArgs).toEqual(['--example']);
    const clearedDefaults = await client.rest!.config.patch({
      agent_executor_overrides: {
        'fixture-acp': { quota_source: null, defaults: { executor_instance: null } },
      },
    });
    expect(clearedDefaults.raw?.['agent_executor_overrides']).toMatchObject({
      'fixture-acp': { defaults: {} },
    });
    const fallbackMainSession = await create('fixture-acp');
    expect(scheduleOf(fallbackMainSession)).toMatchObject({ instance: 'main', choice: 'main', source: 'harness-default', quota_consulted: false });
    const sessionA = await create('agy-cli', { executor_instance: { account_id: 'work' } });
    const sessionB = await create('agy-cli', { executor_instance: { account_id: 'personal' } });
    holdOutbound = true;
    heldLive.length = 0;
    droppedWhileHeld.length = 0;
    heldReleases.length = 0;
    pairReady = new Promise<void>((resolve) => { markPair = resolve; });
    const promptOf = (sessionId: string, text: string) => call<{ prompt_id: string }>(`/sessions/${sessionId}/prompts`, 'POST', {
      content: [{ type: 'text', text }],
    });
    const pendingA = promptOf(sessionA, 'Account A');
    const pendingB = promptOf(sessionB, 'Account B');
    await Promise.race([
      pairReady,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('A and B subprocesses did not overlap')), 15_000)),
    ]);
    expect(heldLive.map((item) => item.account).sort()).toEqual(['personal', 'work']);
    expect(new Set(heldLive.map((item) => item.pid)).size).toBe(2);
    const [receiptA, receiptB] = await Promise.all([pendingA, pendingB]);
    expect(receiptA.code, receiptA.msg).toBe(0);
    expect(receiptB.code, receiptB.msg).toBe(0);
    const aborted = await call<{ aborted: boolean }>(`/sessions/${sessionA}/prompts/${receiptA.data.prompt_id}:abort`, 'POST', {});
    expect(aborted).toMatchObject({ code: 0, data: { aborted: true } });
    await Promise.race([
      aCancelled,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('Account A outbound request was not cancelled')), 5000)),
    ]);
    expect(droppedWhileHeld).toEqual(['work']);
    for (const release of heldReleases) release();
    const settle = (sessionId: string) => manager().get(sessionId)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentExecutionService).settled();
    await Promise.all([settle(sessionA), settle(sessionB)]);
    const page = async (sessionId: string) => call<{ items: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }>(`/sessions/${sessionId}/messages?page_size=20`);
    const textOf = (payload: { data: { items: Array<{ role: string; content: Array<{ type: string; text?: string }> }> } }) => payload.data.items
      .filter((item) => item.role === 'assistant')
      .flatMap((item) => item.content.filter((part) => part.type === 'text').map((part) => part.text ?? ''));
    expect(textOf(await page(sessionB))).toEqual(['ok']);
    expect(heldLive.find((item) => item.account === 'personal')?.pid).not.toBe(heldLive.find((item) => item.account === 'work')?.pid);
    await client.close();
  } finally {
    await server?.close();
    origin.closeAllConnections();
    if (origin.listening) await new Promise<void>((resolve) => origin.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 120_000);

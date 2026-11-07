import { createServer, type Server as HttpServer, type RequestListener } from 'node:http';
import { connect, createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { IAgentExecutorRegistry, IAgentLifecycleService, IAgentProfileService, ISessionManager } from '@kiki/agent-core-v2';
import { IAgentExecutionService } from '@kiki/agent-core-v2/agent/execution/execution';
import { publicExecutorInstance, type ExecutorCheckResponse, type ExecutorInstanceConfig, type ListExecutorsResponse } from '@kiki/protocol';

import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

async function listen(server: HttpServer | TcpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Loopback listener has no port');
  return address.port;
}

function fixtureSocks(destinationPort: number, received: (host: string) => void): TcpServer {
  return createTcpServer((socket) => {
    socket.once('data', (greeting) => {
      if (greeting[0] !== 5 || !greeting.includes(2)) { socket.destroy(); return; }
      socket.write(Buffer.from([5, 2]));
      socket.once('data', (auth) => {
        const userLen = auth[1]!;
        if (auth[0] !== 1 || auth.subarray(2, 2 + userLen).toString() !== 'fixture-user'
          || auth.subarray(3 + userLen).toString() !== 'fixture-proxy-secret') { socket.destroy(); return; }
        socket.write(Buffer.from([1, 0]));
        socket.once('data', (request) => {
          if (request[0] !== 5 || request[1] !== 1 || request[3] !== 3) { socket.destroy(); return; }
          received(request.subarray(5, 5 + request[4]!).toString());
          const upstream = connect(destinationPort, '127.0.0.1', () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            socket.pipe(upstream).pipe(socket);
          });
          upstream.on('error', () => socket.destroy());
          socket.on('close', () => upstream.destroy());
        });
      });
    });
  });
}

it('launches named harnesses through separate HTTP and SOCKS proxies, then restores the same account and session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-harness-instances-'));
  const fixture = fileURLToPath(new URL('../../agent-core-v2/test/fixtures/executor-instance-agent.mjs', import.meta.url));
  const a = 'instance-work';
  const b = 'instance-personal';
  const unsupported = 'instance-unsupported';
  const source = 'fixture-acp';
  const hits: Array<{ route: string; account: string; authorized: boolean; session: string; pid: number; noProxy?: string; hostMarker: string }> = [];
  const targets: string[] = [];
  const observe = (route: string): RequestListener => async (req, res) => {
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(Buffer.from(chunk));
    const account = String(req.headers['x-fixture-account']);
    const detail = JSON.parse(Buffer.concat(body).toString());
    hits.push({ route, account, authorized: req.headers.authorization === `Bearer fixture-key-${account}`,
      session: String(req.headers['x-fixture-session']), pid: detail.pid, noProxy: detail.noProxy, hostMarker: detail.inherited });
    res.end(`fixture-${route}-ok`);
  };
  const authorization = { username: 'fixture-http@user', password: 'fixture-http@user%:password' };
  const basic = `Basic ${Buffer.from(`${authorization.username}:${authorization.password}`).toString('base64')}`;
  const workRequest = observe('A');
  const http = createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== basic) {
      res.writeHead(407); res.end(); return;
    }
    workRequest(req, res);
  });
  const origin = createServer(observe('B'));
  const inherited = createServer(observe('host'));
  let socks: TcpServer | undefined;
  let server: RunningServer | undefined;
  try {
    const [httpPort, originPort, inheritedPort] = await Promise.all([listen(http), listen(origin), listen(inherited)]);
    socks = fixtureSocks(originPort, (host) => targets.push(host));
    const socksPort = await listen(socks);
    const socksUrl = `socks5h://fixture-user:fixture-proxy-secret@127.0.0.1:${socksPort}`;
    const hostProxy = `http://127.0.0.1:${inheritedPort}`;
    vi.stubEnv('HTTP_PROXY', hostProxy);
    vi.stubEnv('http_proxy', hostProxy);
    vi.stubEnv('NO_PROXY', 'host-bypass.example.test');
    vi.stubEnv('INSTANCE_HOST_MARKER', 'unchanged');
    const configDir = async (account: string, hostname = 'fixture.invalid') => {
      const directory = join(home, account);
      await mkdir(directory);
      await writeFile(join(directory, 'account.json'), JSON.stringify({ id: account, key: `fixture-key-${account}`, endpoint: `http://${hostname}:${originPort}/messages` }));
      return directory;
    };
    const [workHome, personalHome, defaultHome, directHome] = await Promise.all([configDir('work'), configDir('personal'), configDir('default'), configDir('direct', '127.0.0.1')]);
    vi.stubEnv('INSTANCE_HOME', defaultHome);
    await writeFile(join(home, 'config.toml'), [
      '[search]', 'enabled = false', '[agent_executors.fixture-acp]', 'label = "Fixture harness"', 'protocol = "acp-v1"',
      'home_env = "INSTANCE_HOME"', 'model_binding = "session_config"',
      `sources = [{ id = "fixture", kind = "node-script", path = ${JSON.stringify(fixture)} }]`,
      '[agent_executors.fixture-acp.model_probe]', 'args = ["models"]', 'format = "lines"',
    ].join('\n'));
    const env = { ...process.env, INSTANCE_SOCKS_PROXY: socksUrl };
    const boot = () => startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', env });
    server = await boot();
    const call = async <T>(path: string, method = 'GET', body?: unknown) => {
      const response = await authedFetch(server!, `http://127.0.0.1:${server!.port}`, `/api${path}`, {
        method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000),
      });
      return await response.json() as { code: number; msg: string; data: T };
    };
    const ok = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
      const result = await call<T>(path, method, body);
      expect(result.code, result.msg).toBe(0);
      return result.data;
    };
    const list = async () => (await ok<ListExecutorsResponse>('/executors')).items;
    const defaults = await list();
    expect(defaults.filter((item) => item.id === 'agy-cli')).toHaveLength(1);
    expect(defaults.some((item) => item.instance !== undefined)).toBe(false);
    const registry = server.core.accessor.get(IAgentExecutorRegistry);
    const defaultRevision = registry.get(source)!.revision;
    const agyRevision = registry.get('agy-cli')!.revision;
    const work: ExecutorInstanceConfig = { source_executor: source, label: 'Work', configuration: { kind: 'config_directory', path: workHome }, proxy: { kind: 'url', url: `http://127.0.0.1:${httpPort}`, authorization } };
    const personal: ExecutorInstanceConfig = { source_executor: source, label: 'Personal', configuration: { kind: 'config_directory', path: personalHome }, proxy: { kind: 'env', name: 'INSTANCE_SOCKS_PROXY' } };
    const patch = (entries: Record<string, ExecutorInstanceConfig>) => ok('/config', 'POST', { agent_executor_instances: entries });
    await patch({ [a]: work, [b]: personal, [unsupported]: { ...work, source_executor: 'agy-cli' } });
    const items = await list();
    expect(items.filter((item) => item.instance !== undefined).map((item) => item.id)).toEqual([b, unsupported, a]);
    expect(items.find((item) => item.id === a)).toMatchObject({ label: 'Work', protocol: 'acp-v1', instance: publicExecutorInstance(work), model_binding: 'mapped' });
    expect(items.find((item) => item.id === unsupported)).toMatchObject({ status: 'unavailable', configuration_issue: 'instance_configuration_unsupported' });
    const checked = await ok<ExecutorCheckResponse>(`/executors/${b}/check`, 'POST');
    const maskedVersion = 'instance-fixture 1.0.0 [redacted] [redacted] [redacted] [redacted] [redacted]';
    expect(checked).toMatchObject({ id: b, version: maskedVersion, selected_source: 'fixture', status: 'ready' });
    expect(await ok<ExecutorCheckResponse>(`/executors/${a}/check`, 'POST')).toMatchObject({ id: a, version: maskedVersion, status: 'ready' });
    expect(await ok<ExecutorCheckResponse>(`/executors/${unsupported}/check`, 'POST')).toMatchObject({ status: 'unavailable', diagnostics: [{ code: 'instance_configuration_unsupported' }] });
    const models = await ok(`/executors/${b}/models:refresh`, 'POST');
    expect(models).toMatchObject({ executor_id: b, effective: { models: { state: 'ready', values: ['fixture-model'] } } });
    expect(JSON.stringify([items, checked, models, await ok('/config'), await readFile(join(home, 'config.toml'), 'utf8')])).not.toMatch(/fixture-proxy-secret|fixture-key-personal|fixture-http-/);
    expect(registry.get(source)!.revision).toBe(defaultRevision);
    expect(registry.get('agy-cli')!.revision).toBe(agyRevision);
    const create = async (executor: string) => (await ok<{ id: string }>('/sessions', 'POST', { metadata: { cwd: home }, agent_config: { execution: { executor } } })).id;
    const manager = () => server!.core.accessor.get(ISessionManager);
    const main = (id: string) => manager().get(id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor;
    const send = async (sessionId: string, execution?: { executor: string }) => {
      const receipt = await call(`/sessions/${sessionId}/prompts`, 'POST', { content: [{ type: 'text', text: 'Fixture request' }], execution });
      if (receipt.code === 0) await main(sessionId).get(IAgentExecutionService).settled();
      return receipt;
    };
    const [workSession, personalSession, defaultSession] = await Promise.all([create(a), create(b), create(source)]);
    expect([main(workSession).get(IAgentProfileService).data().executorId, main(personalSession).get(IAgentProfileService).data().executorId]).toEqual([a, b]);
    expect((await Promise.all([send(workSession), send(personalSession), send(defaultSession)])).map((receipt) => receipt.code)).toEqual([0, 0, 0]);
    expect(hits.toSorted((x, y) => x.route.localeCompare(y.route))).toMatchObject([
      { route: 'A', account: 'work', authorized: true, hostMarker: 'unchanged', noProxy: expect.stringContaining('127.0.0.1') },
      { route: 'B', account: 'personal', authorized: true, hostMarker: 'unchanged', noProxy: expect.stringContaining('localhost') },
      { route: 'host', account: 'default', authorized: true, hostMarker: 'unchanged', noProxy: 'host-bypass.example.test' },
    ]);
    expect(new Set(hits.map((hit) => hit.pid)).size).toBe(3);
    expect(targets).toEqual(['fixture.invalid']);
    expect(process.env['HTTP_PROXY']).toBe(hostProxy);
    expect(process.env['NO_PROXY']).toBe('host-bypass.example.test');
    const original = hits.find((hit) => hit.route === 'A')!;
    await server.close();
    server = await boot();
    expect((await send(workSession)).code).toBe(0);
    expect(hits.at(-1)).toMatchObject({ route: 'A', account: 'work', session: original.session });
    expect(hits.at(-1)!.pid).not.toBe(original.pid);

    const changed: ExecutorInstanceConfig = { ...work, configuration: { kind: 'config_directory', path: directHome }, proxy: { kind: 'direct' } };
    await patch({ [a]: changed });
    const before = hits.length;
    expect((await send(workSession, { executor: a })).code).not.toBe(0);
    expect(hits).toHaveLength(before);
    await manager().close(workSession);
    expect((await send(workSession)).code).not.toBe(0);
    expect(hits).toHaveLength(before);
    const fresh = await create(a);
    expect((await send(fresh)).code).toBe(0);
    expect(hits.at(-1)).toMatchObject({ route: 'B', account: 'direct', authorized: true });
    expect(hits.at(-1)!.noProxy).toBeUndefined();
    expect(targets).toEqual(['fixture.invalid']);
    await ok(`/executors/${a}/registration:remove`, 'POST');
    expect((await list()).map((item) => item.id)).not.toContain(a);
    expect(server.core.accessor.get(IAgentExecutorRegistry).get(source)!.revision).toBe(defaultRevision);
    expect(server.core.accessor.get(IAgentExecutorRegistry).get('agy-cli')!.revision).toBe(agyRevision);
  } finally {
    await server?.close();
    for (const endpoint of [http, origin, inherited]) endpoint.closeAllConnections();
    await Promise.all([http, origin, inherited, socks].map(async (endpoint) => {
      if (endpoint?.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }));
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 90_000);

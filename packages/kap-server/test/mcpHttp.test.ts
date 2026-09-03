import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerKikiMcpHttp } from '../src/mcp/http';
import { createEnvSeatResolver, type SeatResolver } from '../src/mcp/seatResolver';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

const close: Array<() => Promise<void>> = [];

const exploreCatalogEntry = {
  profileName: 'explore',
  description: 'Map code without changing it.',
  whenToUse: 'Use for bounded evidence gathering.',
  modelAlias: 'grok-4.6',
  thinkingEffort: 'max',
  allowedModels: ['grok-4.6'],
  alternativeModels: [{ alias: 'glm-5.3-flash', when: 'Use for wide scans.', thinkingEffort: 'max' }],
  tools: 'Read, Grep',
};

describe('Kiki MCP HTTP transport', () => {
  afterEach(async () => {
    await Promise.all(close.splice(0).map((dispose) => dispose()));
  });

  it('round-trips initialize, tools/list, kiki_profiles, and kiki_list', async () => {
    const fetchMock = restFetch();
    const { url } = await listenMcp({
      resolver: createEnvSeatResolver({
        sessionId: 'session-operator',
        delegationToken: 'DELEGATION_SECRET',
      }),
      fetch: fetchMock,
      workspaceBySession: { 'session-operator': '/example/workspace' },
    });
    const { client } = await connect(url, 'DELEGATION_SECRET');

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['kiki_list', 'kiki_profiles']));

    const profiles = await client.callTool({ name: 'kiki_profiles', arguments: {} });
    expect(profiles.isError).not.toBe(true);
    expect(profiles.structuredContent).toMatchObject({
      profiles: [exploreCatalogEntry],
      binding: { sessionId: 'session-operator', workspacePath: '/example/workspace' },
    });

    const listed = await client.callTool({ name: 'kiki_list', arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      children: [{ taskName: 'child_one', profileName: 'explore' }],
      continuations: [{ dispatchId: 'dispatch_one', target: 'named', status: 'completed' }],
      binding: { sessionId: 'session-operator' },
    });
    expect(listed.structuredContent).not.toHaveProperty('dispatchables');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects a wrong bearer with HTTP 401 code/msg', async () => {
    const { url } = await listenMcp({
      resolver: createEnvSeatResolver({
        sessionId: 'session-operator',
        delegationToken: 'DELEGATION_SECRET',
      }),
      fetch: restFetch(),
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: 'unauthorized',
      msg: 'MCP seat authentication failed.',
    });
  });

  it('keeps two concurrent MCP sessions on distinct seats', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const href = fetchUrl(input);
      const sessionId = href.split('/sessions/')[1]?.split('/')[0] ?? '';
      seen.push(sessionId);
      return restResponse(sessionId);
    });
    const resolver: SeatResolver = {
      resolve(bearer) {
        if (bearer === 'TOKEN_A') {
          return { sessionId: 'session-a', delegationToken: 'TOKEN_A' };
        }
        if (bearer === 'TOKEN_B') {
          return { sessionId: 'session-b', delegationToken: 'TOKEN_B' };
        }
        return null;
      },
    };
    const { url } = await listenMcp({
      resolver,
      fetch: fetchMock,
      workspaceBySession: { 'session-a': '/example/a', 'session-b': '/example/b' },
    });
    const a = await connect(url, 'TOKEN_A');
    const b = await connect(url, 'TOKEN_B');

    const [listedA, listedB] = await Promise.all([
      a.client.callTool({ name: 'kiki_list', arguments: {} }),
      b.client.callTool({ name: 'kiki_list', arguments: {} }),
    ]);
    expect(listedA.structuredContent).toMatchObject({
      binding: { sessionId: 'session-a', workspacePath: '/example/a' },
      children: [{ taskName: 'child-session-a' }],
    });
    expect(listedB.structuredContent).toMatchObject({
      binding: { sessionId: 'session-b', workspacePath: '/example/b' },
      children: [{ taskName: 'child-session-b' }],
    });
    expect(seen).toEqual(expect.arrayContaining(['session-a', 'session-b']));
    expect(new Set(seen)).toEqual(new Set(['session-a', 'session-b']));
  });
});

describe('env seat resolver', () => {
  it('matches the embedded delegation token and rejects others', () => {
    const resolver = createEnvSeatResolver({
      sessionId: 'session-operator',
      delegationToken: 'DELEGATION_SECRET',
    });
    expect(resolver.resolve('DELEGATION_SECRET')).toEqual({
      sessionId: 'session-operator',
      delegationToken: 'DELEGATION_SECRET',
    });
    expect(resolver.resolve('other')).toBeNull();
    expect(resolver.resolve('DELEGATION_SECRE')).toBeNull();
  });
});

describe('Kiki MCP HTTP daemon mount', () => {
  const running: RunningServer[] = [];
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((dispose) => dispose()));
    for (const server of running.splice(0)) {
      await server.close();
    }
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('does not expose /mcp on a non-loopback bind', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-mcp-http-lan-'));
    homes.push(home);
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '0.0.0.0',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      insecureNoTls: true,
      bindClass: 'lan',
      externalDelegation: {
        principalId: 'example-principal',
        sessionId: 'session_operator',
        token: 'DELEGATION_SECRET',
      },
    });
    running.push(server);

    const response = await fetch(`http://127.0.0.1:${String(server.port)}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer DELEGATION_SECRET',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(404);
  });

  it('binds an attached env seat without inventing an empty workspace path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-mcp-http-attached-'));
    homes.push(home);
    const bootstrap = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    running.push(bootstrap);
    const created = await fetch(`http://127.0.0.1:${String(bootstrap.port)}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(bootstrap, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect(created.status).toBe(200);
    const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
    await bootstrap.close();
    running.pop();

    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: {
        principalId: 'example-principal',
        sessionId,
        token: 'DELEGATION_SECRET',
      },
    });
    running.push(server);
    const { client } = await connect(`http://127.0.0.1:${String(server.port)}/mcp`, 'DELEGATION_SECRET');
    const listed = await client.callTool({ name: 'kiki_list', arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      binding: { version: 1, sessionId, workspacePath: home },
    });
    const binding = (listed.structuredContent as { binding: { workspacePath?: string } }).binding;
    expect(binding.workspacePath).not.toBe('');
  });
});

async function listenMcp(opts: {
  readonly resolver: SeatResolver;
  readonly fetch: typeof fetch;
  readonly workspaceBySession?: Readonly<Record<string, string>>;
}): Promise<{ url: string }> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerKikiMcpHttp(app, {
    seatResolver: opts.resolver,
    serverOptions: { fetch: opts.fetch },
    resolveConfig: (seat) => ({
      endpoint: 'http://127.0.0.1:58627',
      token: 'KAP_TOKEN',
      delegationToken: seat.delegationToken,
      sessionId: seat.sessionId,
      workspacePath: opts.workspaceBySession?.[seat.sessionId],
    }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  close.push(() => app.close());
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}/mcp` };
}

async function connect(url: string, token: string): Promise<{ client: Client }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  close.unshift(async () => {
    await client.close();
    await transport.close();
  });
  return { client };
}

function restFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async () => restResponse('session-operator'));
}

function restResponse(sessionId: string): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        delegationId: `delegation_${sessionId}`,
        dispatchables: [{ kind: 'main' }, { kind: 'named', ...exploreCatalogEntry }],
        children: [{ taskName: sessionId === 'session-operator' ? 'child_one' : `child-${sessionId}`, profileName: 'explore' }],
        continuations: sessionId === 'session-operator'
          ? [{ dispatchId: 'dispatch_one', target: 'named', status: 'completed' }]
          : [],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

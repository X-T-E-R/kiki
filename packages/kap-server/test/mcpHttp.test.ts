import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerKikiMcpHttp } from '../src/mcp/http';
import { createEnvSeatResolver, type SeatResolver } from '../src/mcp/seatResolver';

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
        workspacePath: '/example/workspace',
      }),
      fetch: fetchMock,
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
        workspacePath: '/example/workspace',
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
          return { sessionId: 'session-a', delegationToken: 'TOKEN_A', workspacePath: '/example/a' };
        }
        if (bearer === 'TOKEN_B') {
          return { sessionId: 'session-b', delegationToken: 'TOKEN_B', workspacePath: '/example/b' };
        }
        return null;
      },
    };
    const { url } = await listenMcp({ resolver, fetch: fetchMock });
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
      workspacePath: '/example/workspace',
    });
    expect(resolver.resolve('DELEGATION_SECRET')).toEqual({
      sessionId: 'session-operator',
      delegationToken: 'DELEGATION_SECRET',
      workspacePath: '/example/workspace',
    });
    expect(resolver.resolve('other')).toBeNull();
    expect(resolver.resolve('DELEGATION_SECRE')).toBeNull();
  });
});

async function listenMcp(opts: {
  readonly resolver: SeatResolver;
  readonly fetch: typeof fetch;
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
      workspacePath: seat.workspacePath,
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

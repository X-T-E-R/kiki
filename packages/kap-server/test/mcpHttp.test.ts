import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SeatKlient } from '@moonshot-ai/klient/procedures';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerKikiMcpHttp } from '../src/mcp/http';
import {
  createCompositeSeatResolver,
  createEnvSeatResolver,
  type SeatResolver,
} from '../src/mcp/seatResolver';
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
    const { url } = await listenMcp({
      resolver: createEnvSeatResolver({
        seatId: 'seat-operator',
        principalId: 'principal-operator',
        sessionId: 'session-operator',
        delegationToken: 'DELEGATION_SECRET',
      }),
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
  });

  it('rejects a wrong bearer with HTTP 401 code/msg', async () => {
    const { url } = await listenMcp({
      resolver: createEnvSeatResolver({
        seatId: 'seat-operator',
        principalId: 'principal-operator',
        sessionId: 'session-operator',
        delegationToken: 'DELEGATION_SECRET',
      }),
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
    const resolver: SeatResolver = {
      async resolve(bearer) {
        if (bearer === 'TOKEN_A') {
          return { seatId: 'seat-a', principalId: 'principal-a', sessionId: 'session-a', delegationToken: 'TOKEN_A' };
        }
        if (bearer === 'TOKEN_B') {
          return { seatId: 'seat-b', principalId: 'principal-b', sessionId: 'session-b', delegationToken: 'TOKEN_B' };
        }
        return null;
      },
    };
    const { url } = await listenMcp({
      resolver,
      workspaceBySession: { 'session-a': '/example/a', 'session-b': '/example/b' },
      onCall: (sessionId) => seen.push(sessionId),
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

  it('closes factory-created clients once on session DELETE', async () => {
    const closed: string[] = [];
    const { url } = await listenMcp({
      resolver: createEnvSeatResolver({
        seatId: 'seat-operator',
        principalId: 'principal-operator',
        sessionId: 'session-operator',
        delegationToken: 'DELEGATION_SECRET',
      }),
      onKlientClose: (sessionId) => closed.push(sessionId),
    });
    const { transport } = await connect(url, 'DELEGATION_SECRET');

    await transport.terminateSession();
    await vi.waitFor(() => expect(closed).toEqual(['session-operator']));
  });

  it('closes factory-created clients when initialization does not complete', async () => {
    const closed: string[] = [];
    const { url } = await listenMcp({
      resolver: createEnvSeatResolver({
        seatId: 'seat-operator',
        principalId: 'principal-operator',
        sessionId: 'session-operator',
        delegationToken: 'DELEGATION_SECRET',
      }),
      onKlientClose: (sessionId) => closed.push(sessionId),
    });

    await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer DELEGATION_SECRET',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    await vi.waitFor(() => expect(closed).toEqual(['session-operator']));
  });

  it('closes every factory-created client once on app close', async () => {
    const closed: string[] = [];
    const mounted = await listenMcp({
      resolver: createEnvSeatResolver({
        seatId: 'seat-operator',
        principalId: 'principal-operator',
        sessionId: 'session-operator',
        delegationToken: 'DELEGATION_SECRET',
      }),
      onKlientClose: (sessionId) => closed.push(sessionId),
    });
    await connect(mounted.url, 'DELEGATION_SECRET');

    await mounted.app.close();
    await mounted.app.close();

    expect(closed).toEqual(['session-operator']);
  });
});

describe('env seat resolver', () => {
  it('matches the embedded delegation token and rejects others', async () => {
    const seat = {
      seatId: 'seat-operator',
      principalId: 'principal-operator',
      sessionId: 'session-operator',
      delegationToken: 'DELEGATION_SECRET',
    };
    const resolver = createEnvSeatResolver(seat);
    await expect(resolver.resolve('DELEGATION_SECRET')).resolves.toEqual(seat);
    await expect(resolver.resolve('other')).resolves.toBeNull();
    await expect(resolver.resolve('DELEGATION_SECRE')).resolves.toBeNull();
  });

  it('prefers a runtime seat resolver and falls back to the env seat', async () => {
    const runtimeSeat = {
      seatId: 'seat-runtime',
      principalId: 'principal-runtime',
      sessionId: 'session-runtime',
      delegationToken: 'RUNTIME',
    };
    const envSeat = {
      seatId: 'seat-env',
      principalId: 'principal-env',
      sessionId: 'session-env',
      delegationToken: 'ENV',
    };
    const runtime: SeatResolver = {
      async resolve(bearer) {
        return bearer === 'RUNTIME' ? runtimeSeat : null;
      },
    };
    const env = createEnvSeatResolver(envSeat);
    const resolver = createCompositeSeatResolver(runtime, env);
    await expect(resolver.resolve('RUNTIME')).resolves.toEqual(runtimeSeat);
    await expect(resolver.resolve('ENV')).resolves.toEqual(envSeat);
    await expect(resolver.resolve('OTHER')).resolves.toBeNull();
  });
});

describe('Kiki MCP HTTP daemon mount', () => {
  const running: RunningServer[] = [];
  const homes: string[] = [];
  const priorEnv: Array<[string, string | undefined]> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((dispose) => dispose()));
    for (const server of running.splice(0)) {
      await server.close();
    }
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
    for (const [name, value] of priorEnv.splice(0)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function pinEnv(name: string, value: string | undefined): void {
    priorEnv.push([name, process.env[name]]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

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
      mcpSeatResolver: {
        async resolve(bearer) {
          if (bearer !== 'DELEGATION_SECRET') return null;
          return {
            seatId: 'seat_operator',
            principalId: 'principal_operator',
            sessionId: 'session_operator',
            delegationToken: 'DELEGATION_SECRET',
          };
        },
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
    const procedureResponse = await fetch(
      `http://127.0.0.1:${String(server.port)}/api/klient/delegation/list`,
      {
        method: 'POST',
        headers: authHeaders(server, { 'content-type': 'application/json' }),
        body: '{}',
      },
    );
    expect(procedureResponse.status).toBe(404);
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

    pinEnv('KIKI_EXTERNAL_PRINCIPAL_ID', 'example-principal');
    pinEnv('KIKI_EXTERNAL_SESSION_ID', sessionId);
    pinEnv('KIKI_EXTERNAL_DELEGATION_TOKEN', 'DELEGATION_SECRET');
    pinEnv('KIKI_EXTERNAL_WORKSPACE_PATH', undefined);
    pinEnv('KIKI_EXTERNAL_MODEL_ALIAS', undefined);
    pinEnv('KIKI_EXTERNAL_THINKING_EFFORT', undefined);
    pinEnv('KIKI_EXTERNAL_PERMISSION_MODE', undefined);
    pinEnv('KIKI_EXTERNAL_SESSION_TITLE', undefined);

    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    running.push(server);
    const procedureUrl = `http://127.0.0.1:${String(server.port)}/api/klient/delegation/list`;
    const [seatResponse, daemonResponse, overrideResponse] = await Promise.all([
      fetch(procedureUrl, {
        method: 'POST',
        headers: { authorization: 'Bearer DELEGATION_SECRET', 'content-type': 'application/json' },
        body: '{}',
      }),
      fetch(procedureUrl, {
        method: 'POST',
        headers: authHeaders(server, { 'content-type': 'application/json' }),
        body: '{}',
      }),
      fetch(procedureUrl, {
        method: 'POST',
        headers: { authorization: 'Bearer DELEGATION_SECRET', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-other' }),
      }),
    ]);
    expect(seatResponse.status).toBe(200);
    expect((await seatResponse.json()) as { code: number }).toMatchObject({ code: 0 });
    expect(daemonResponse.status).toBe(401);
    expect((await overrideResponse.json()) as { code: number }).toMatchObject({ code: 40001 });

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
  readonly workspaceBySession?: Readonly<Record<string, string>>;
  readonly onCall?: (sessionId: string) => void;
  readonly onKlientClose?: (sessionId: string) => void;
}): Promise<{ url: string; app: FastifyInstance }> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerKikiMcpHttp(app, {
    seatResolver: opts.resolver,
    resolveKlient: (seat) => fakeSeatKlient(
      seat.seatId,
      seat.principalId,
      seat.sessionId,
      opts.workspaceBySession?.[seat.sessionId],
      opts.onCall,
      opts.onKlientClose,
    ),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  close.push(() => app.close());
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}/mcp`, app };
}

async function connect(url: string, token: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  close.unshift(async () => {
    await client.close();
    await transport.close();
  });
  return { client, transport };
}

function fakeSeatKlient(
  seatId: string,
  principalId: string,
  sessionId: string,
  workspacePath: string | undefined,
  onCall: ((sessionId: string) => void) | undefined,
  onKlientClose: ((sessionId: string) => void) | undefined,
): SeatKlient {
  const binding = { version: 1 as const, seatId, principalId, sessionId, workspacePath };
  return {
    async call(name: string) {
      onCall?.(sessionId);
      if (name === 'profiles') return { profiles: [exploreCatalogEntry], binding } as never;
      if (name === 'list') {
        return {
          version: 1,
          delegationId: `delegation_${sessionId}`,
          lifecycle: 'active',
          dispatchables: [{ kind: 'main' }, { kind: 'named', ...exploreCatalogEntry }],
          children: [{
            taskName: sessionId === 'session-operator' ? 'child_one' : `child-${sessionId}`,
            profileName: 'explore',
          }],
          continuations: sessionId === 'session-operator'
            ? [{
                dispatchId: 'dispatch_one',
                target: 'named',
                status: 'completed',
                createdAt: 1,
              }]
            : [],
          binding,
        } as never;
      }
      throw new Error(`Unexpected procedure ${name}`);
    },
    async close() {
      onKlientClose?.(sessionId);
    },
  } as unknown as SeatKlient;
}

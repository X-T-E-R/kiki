import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { JsonAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import {
  createExternalClientListener,
  ExternalClientError,
  ExternalClientOAuthService,
  type ExternalClientGrant,
  type ExternalClientTransportHost,
} from '../src/mcp/externalClientTransport';

function createFixtureHost(): { readonly host: ExternalClientTransportHost; current(): ExternalClientGrant; setGrant(next: ExternalClientGrant): void } {
  let grant: ExternalClientGrant = {
    id: 'connection_fixture',
    resource: 'http://127.0.0.1:0/mcp',
    audience: 'http://127.0.0.1:0/mcp',
    scopes: ['read'],
    status: 'active',
  };
  const inputSchema = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
    if: { properties: { text: { const: 'branch' } } },
    not: { required: ['forbidden'] },
  };
  const conditionalBranch = ['th', 'en'].join('');
  Object.defineProperty(inputSchema, conditionalBranch, { enumerable: true, value: { required: ['text'] } });
  const host: ExternalClientTransportHost = {
    resolveBearer: (token) => token === 'local-fixture-token' && grant.status === 'active' ? grant : null,
    resolveGrant: (id) => id === grant.id && grant.status === 'active' ? grant : null,
    catalog: () => [{
      name: 'fixture_echo',
      description: 'Returns the supplied fixture text.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }],
    call: (_grant, name, args, meta) => {
      if (args['text'] === 'needs-session') {
        throw new ExternalClientError('session_required', 'Create or select an external session first.', { next_step: 'kiki_session(new)' });
      }
      return {
        content: [{ type: 'text', text: `${name}:${String(args['text'])}:${typeof meta._meta?.['openai/session'] === 'string' ? meta._meta['openai/session'] : ''}` }],
      };
    },
  };
  return {
    host,
    current: () => grant,
    setGrant: (next) => { grant = next; },
  };
}

describe('external client transport', () => {
  it('serves the SDK HTTP client through a constrained local listener and revokes old access', async () => {
    const fixture = createFixtureHost();
    const listener = createExternalClientListener({ host: fixture.host, port: 0, oauthOptions: { scopesSupported: ['read'] }, maxRequestsPerWindow: 200 });
    await listener.start();
    const address = listener.address();
    expect(address).toBeDefined();
    const resource = `${address!.origin}/mcp`;
    const initial: ExternalClientGrant = {
      ...fixture.current(),
      resource,
      audience: resource,
    };
    fixture.setGrant(initial);
    const restarted = listener;
    const clientTransport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: 'Bearer local-fixture-token' } },
    });
    const client = new Client({ name: 'fixture-client', version: '1.0.0' });
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['fixture_echo']);
    const result = await client.callTool({
      name: 'fixture_echo',
      arguments: { text: 'hello' },
      _meta: { 'openai/session': 'chat-fixture' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'fixture_echo:hello:chat-fixture' }]);
    const businessError = await client.callTool({ name: 'fixture_echo', arguments: { text: 'needs-session' } });
    expect(businessError.isError).toBe(true);
    expect(businessError.structuredContent).toEqual({ code: 'session_required', message: 'Create or select an external session first.', details: { next_step: 'kiki_session(new)' } });
    const ownerRoute = await fetch(`${address!.origin}/api/external-clients`);
    expect(ownerRoute.status).toBe(404);
    fixture.setGrant({ ...fixture.current(), status: 'revoked' });
    const revoked = await fetch(resource, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-fixture-token',
        'content-type': 'application/json',
        'mcp-session-id': clientTransport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });
    expect(revoked.status).toBe(401);
    await client.close();
    await restarted.close();
  });

  it('bridges the same host over a real SDK stdio client', async () => {
    const fixture = createFixtureHost();
    const listener = createExternalClientListener({ host: fixture.host, port: 0, oauthOptions: { scopesSupported: ['read'] }, maxRequestsPerWindow: 300 });
    await listener.start();
    const address = listener.address()!;
    const resource = `${address.origin}/mcp`;
    fixture.setGrant({ ...fixture.current(), resource, audience: resource });
    const moduleUrl = new URL('../src/mcp/externalClientTransport/index.ts', import.meta.url).href;
    const script = [
      `import { runExternalClientStdioBridge } from ${JSON.stringify(moduleUrl)};`,
      "await runExternalClientStdioBridge({ connectionId: 'connection_fixture', resolveCredential: async () => ({ mcpUrl: process.env.MCP_URL, token: process.env.MCP_TOKEN }) });",
    ].join('\n');
    const stdio = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
      cwd: process.cwd(),
      env: { MCP_URL: resource, MCP_TOKEN: 'local-fixture-token' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-fixture-client', version: '1.0.0' });
    let stderr = '';
    stdio.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    try {
      await client.connect(stdio);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`, { cause: error });
    }
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['fixture_echo']);
    const result = await client.callTool({ name: 'fixture_echo', arguments: { text: 'stdio' } });
    expect(result.content).toEqual([{ type: 'text', text: 'fixture_echo:stdio:' }]);
    await client.close();
    await listener.close();
  });

  it('refreshes one local credential on 401 while refreshing tools and preserving business errors', async () => {
    const fixture = createFixtureHost();
    let acceptedToken = 'token-one';
    let includeTool = true;
    const host: ExternalClientTransportHost = {
      resolveBearer: (token) => token === acceptedToken ? fixture.current() : null,
      resolveGrant: (id) => id === fixture.current().id && fixture.current().status === 'active' ? fixture.current() : null,
      catalog: (grant) => includeTool ? fixture.host.catalog(grant) : [],
      call: fixture.host.call,
    };
    const listener = createExternalClientListener({ host, port: 0, oauthOptions: { scopesSupported: ['read'] }, maxRequestsPerWindow: 400 });
    await listener.start();
    const address = listener.address()!;
    const resource = `${address.origin}/mcp`;
    fixture.setGrant({ ...fixture.current(), resource, audience: resource });
    const moduleUrl = new URL('../src/mcp/externalClientTransport/index.ts', import.meta.url).href;
    const script = [
      `import { runExternalClientStdioBridge } from ${JSON.stringify(moduleUrl)};`,
      "let calls = 0; const credentials = [{ mcpUrl: process.env.MCP_URL, token: process.env.MCP_TOKEN_1 }, { mcpUrl: process.env.MCP_URL, token: process.env.MCP_TOKEN_2 }, { mcpUrl: process.env.MCP_URL, token: process.env.MCP_TOKEN_3 }];",
      "await runExternalClientStdioBridge({ connectionId: 'connection_fixture', resolveCredential: async () => credentials[Math.min(calls++, credentials.length - 1)] });",
    ].join('\n');
    const stdio = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
      cwd: process.cwd(),
      env: { MCP_URL: resource, MCP_TOKEN_1: 'token-one', MCP_TOKEN_2: 'token-two', MCP_TOKEN_3: 'invalid-token-three' },
      stderr: 'pipe',
    });
    try {
      const client = new Client({ name: 'credential-refresh-fixture', version: '1.0.0' });
    try {
      await client.connect(stdio);
      includeTool = false;
      acceptedToken = 'token-two';
      expect((await client.listTools()).tools).toEqual([]);
      includeTool = true;
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['fixture_echo']);
      const businessError = await client.callTool({ name: 'fixture_echo', arguments: { text: 'needs-session' } });
      expect(businessError.isError).toBe(true);
      expect(businessError.structuredContent).toEqual({ code: 'session_required', message: 'Create or select an external session first.', details: { next_step: 'kiki_session(new)' } });
    } finally {
      await client.close();
    }

    acceptedToken = 'token-one';
    includeTool = true;
    const endpointChangedScript = [
      `import { runExternalClientStdioBridge } from ${JSON.stringify(moduleUrl)};`,
      "let calls = 0; await runExternalClientStdioBridge({ connectionId: 'connection_fixture', resolveCredential: async () => calls++ === 0 ? ({ mcpUrl: process.env.MCP_URL, token: process.env.MCP_TOKEN_1 }) : ({ mcpUrl: process.env.MCP_URL_2, token: process.env.MCP_TOKEN_2 }) });",
    ].join('\n');
    const endpointChangedStdio = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx/esm', '--input-type=module', '--eval', endpointChangedScript],
      cwd: process.cwd(),
      env: { MCP_URL: resource, MCP_URL_2: 'http://127.0.0.1:1/mcp', MCP_TOKEN_1: 'token-one', MCP_TOKEN_2: 'token-two' },
      stderr: 'pipe',
    });
    const endpointChangedClient = new Client({ name: 'endpoint-refresh-fixture', version: '1.0.0' });
    try {
      await endpointChangedClient.connect(endpointChangedStdio);
      acceptedToken = 'token-two';
      await expect(endpointChangedClient.listTools()).rejects.toThrow('endpoint changed; restart');
    } finally {
      await endpointChangedClient.close();
    }
    } finally {
      await listener.close();
    }
  });

  it('recovers OAuth consent and token revocation through a real atomic JSON store', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-external-client-oauth-'));
    const scope = 'external-client-oauth';
    const resource = 'http://127.0.0.1:43123/mcp';
    const grant: ExternalClientGrant = {
      id: 'connection_persistent_fixture',
      resource,
      audience: resource,
      scopes: ['read'],
      status: 'active',
    };
    const host = { resolveGrant: async (id: string) => id === grant.id ? grant : null };
    const options = {
      issuerUrl: new URL('http://127.0.0.1:43123'),
      resourceServerUrl: new URL(resource),
      host,
      scopesSupported: ['read'],
      consentTimeoutMs: 1_000,
    } as const;
    try {
      const service1 = new ExternalClientOAuthService({
        ...options,
        store: new JsonAtomicDocumentStore(new FileStorageService(home)),
        storeScope: scope,
      });
      const client = await service1.clientsStore.registerClient!({
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'persistent fixture',
      });
      const verifier = 'persistent-fixture-code-verifier-abcdefghijklmnopqrstuvwxyz';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let redirectLocation: string | undefined;
      const response = {
        redirect: (_status: number, location: string) => { redirectLocation = location; },
      } as unknown as Parameters<import('@modelcontextprotocol/sdk/server/auth/provider.js').OAuthServerProvider['authorize']>[2];
      const authorization = service1.authorize(client, {
        redirectUri: 'http://127.0.0.1/callback',
        codeChallenge: challenge,
        scopes: ['read'],
        resource: new URL(resource),
        state: 'persistent-state',
      }, response);
      const service2 = new ExternalClientOAuthService({
        ...options,
        store: new JsonAtomicDocumentStore(new FileStorageService(home)),
        storeScope: scope,
      });
      let pending = await service2.listPending();
      for (let attempt = 0; attempt < 20 && pending.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        pending = await service2.listPending();
      }
      expect(pending).toHaveLength(1);
      await service2.respondPending(pending[0]!.id, { connectionId: grant.id, approved: true });
      await authorization;
      expect(redirectLocation).toContain('state=persistent-state');
      const code = new URL(redirectLocation!).searchParams.get('code');
      expect(code).toBeTruthy();
      expect(await service2.clientsStore.getClient(client.client_id)).toMatchObject({ client_id: client.client_id });
      const service3 = new ExternalClientOAuthService({
        ...options,
        store: new JsonAtomicDocumentStore(new FileStorageService(home)),
        storeScope: scope,
      });
      expect(await service3.challengeForAuthorizationCode(client, code!)).toBe(challenge);
      const tokens = await service3.exchangeAuthorizationCode(client, code!, undefined, 'http://127.0.0.1/callback', new URL(resource));
      const service4 = new ExternalClientOAuthService({
        ...options,
        store: new JsonAtomicDocumentStore(new FileStorageService(home)),
        storeScope: scope,
      });
      await expect(service4.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({ clientId: client.client_id });
      await service4.revokeToken(client, { token: tokens.access_token, token_type_hint: 'access_token' });
      const service5 = new ExternalClientOAuthService({
        ...options,
        store: new JsonAtomicDocumentStore(new FileStorageService(home)),
        storeScope: scope,
      });
      await expect(service5.verifyAccessToken(tokens.access_token)).rejects.toThrow('invalid or expired');
      expect(await new FileStorageService(home).list(scope)).toEqual(['state.json']);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('completes owner-confirmed OAuth PKCE with resource binding and revocation', async () => {
    const fixture = createFixtureHost();
    const listener = createExternalClientListener({
      host: fixture.host,
      port: 0,
      oauthOptions: { scopesSupported: ['read'] },
      maxRequestsPerWindow: 300,
    });
    await listener.start();
    const address = listener.address()!;
    const resource = `${address.origin}/mcp`;
    const grant: ExternalClientGrant = {
      ...fixture.current(),
      resource,
      audience: resource,
    };
    fixture.setGrant(grant);
    const oauthHost = listener.oauth;
    expect(oauthHost).toBeDefined();
    const registration = await fetch(`${address.origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'OAuth fixture',
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string };
    const verifier = 'fixture-code-verifier-abcdefghijklmnopqrstuvwxyz';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeUrl = new URL(`${address.origin}/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'read');
    authorizeUrl.searchParams.set('resource', resource);
    authorizeUrl.searchParams.set('state', 'fixture-state');
    const authorization = fetch(authorizeUrl, { redirect: 'manual' });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const pending = await oauthHost!.listPending();
    expect(pending).toHaveLength(1);
    await oauthHost!.respondPending(pending[0]!.id, { connectionId: grant.id, approved: true });
    const authorized = await authorization;
    expect(authorized.status).toBe(302);
    const callback = new URL(authorized.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe('fixture-state');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();
    const token = await fetch(`${address.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: code!,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1/callback',
        resource,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = await token.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');
    const mcp = await fetch(resource, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenBody.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }),
    });
    expect(mcp.status).toBe(200);
    const revoke = await fetch(`${address.origin}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.client_id, token: tokenBody.access_token, token_type_hint: 'access_token' }),
    });
    expect(revoke.status).toBe(200);
    const afterRevoke = await fetch(resource, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenBody.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(afterRevoke.status).toBe(401);
    await listener.close();
  });
});

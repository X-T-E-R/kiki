import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface Revealed {
  source: 'kiki' | 'environment' | 'local' | 'none';
  env_name?: string;
  value?: string;
}

const CONFIG = [
  '[providers.inline]',
  'type = "openai"',
  'api_key = "sk-fixture-inline"',
  'base_url = "https://api.example.test/v1"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  '',
  '[providers.bagged]',
  'type = "kimi"',
  '',
  '[providers.bagged.env]',
  'KIMI_API_KEY = "sk-fixture-bag"',
  '',
].join('\n');

const MCP = JSON.stringify({
  mcpServers: {
    remote: {
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Api-Key': 'hdr-fixture-value' },
      bearerTokenEnvVar: 'FIXTURE_MCP_TOKEN',
    },
    local: { transport: 'stdio', command: 'fixture-mcp', env: { FIXTURE_TOKEN: 'env-fixture-value' } },
  },
});

describe('server-v2 /api/secrets:reveal', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-secrets-'));
    vi.stubEnv('KIMI_API_KEY', 'sk-fixture-shell');
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-fixture-env');
    vi.stubEnv('FIXTURE_MCP_TOKEN', 'bearer-fixture-env');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) await server.close();
    server = undefined;
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function boot(): Promise<void> {
    await writeFile(join(home, 'config.toml'), CONFIG, 'utf8');
    await writeFile(join(home, 'mcp.json'), MCP, 'utf8');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<{ status: number; text: string; body: Envelope<T> }> {
    const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
    const init: RequestInit = {
      method,
      headers: auth ? authHeaders(server as RunningServer, headers) : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = await fetch(`${base}/api${path}`, init);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Envelope<T> };
  }

  const reveal = (ref: Record<string, unknown>) => call<Revealed>('POST', '/secrets:reveal', { ref });

  it('keeps every secret value out of the bulk config, provider and MCP reads', async () => {
    await boot();
    const config = await call<{ providers: Record<string, Record<string, unknown>> }>('GET', '/config');
    expect(config.body.code).toBe(0);
    expect(config.body.data.providers['inline']).toMatchObject({ has_api_key: true });
    expect(config.body.data.providers['inline']).not.toHaveProperty('api_key');
    expect(config.body.data.providers['kimi']).toMatchObject({ has_api_key: true, api_key_env: 'KIMI_API_KEY' });
    const providers = await call<{ items: Record<string, unknown>[] }>('GET', '/providers');
    const single = await call<Record<string, unknown>>('GET', '/providers/inline');
    const mcp = await call<{ name: string; config: Record<string, unknown> }[]>('GET', '/mcp/servers');
    expect(mcp.body.data.find((entry) => entry.name === 'remote')?.config).toMatchObject({ headerKeys: ['X-Api-Key'] });
    expect(mcp.body.data.find((entry) => entry.name === 'local')?.config).toMatchObject({ envKeys: ['FIXTURE_TOKEN'] });
    for (const text of [config.text, providers.text, single.text, mcp.text]) {
      for (const secret of ['sk-fixture-inline', 'sk-fixture-shell', 'sk-fixture-bag', 'hdr-fixture-value', 'env-fixture-value', 'bearer-fixture-env']) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('reveals a saved provider key with its source only on explicit request', async () => {
    await boot();
    expect((await reveal({ kind: 'provider_api_key', provider_id: 'inline' })).body.data)
      .toEqual({ source: 'kiki', value: 'sk-fixture-inline' });
  });

  it('reveals an environment-sourced provider key, provider env table first, then the process environment', async () => {
    await boot();
    expect((await reveal({ kind: 'provider_api_key', provider_id: 'kimi' })).body.data)
      .toEqual({ source: 'environment', env_name: 'KIMI_API_KEY', value: 'sk-fixture-shell' });
    expect((await reveal({ kind: 'provider_api_key', provider_id: 'bagged' })).body.data)
      .toEqual({ source: 'environment', env_name: 'KIMI_API_KEY', value: 'sk-fixture-bag' });
  });

  it('lets a key saved in Kiki override the environment and falls back to it once cleared', async () => {
    await boot();
    const saved = await call('POST', '/config', { permission: { reviewer: { backend: 'jev', api_key: 'ts-fixture-saved' } } });
    expect(saved.body.code).toBe(0);
    expect(saved.text).not.toContain('ts-fixture-saved');
    const echo = await call<{ permission: { reviewer: Record<string, unknown> } }>('GET', '/config');
    expect(echo.body.data.permission.reviewer).toMatchObject({ backend: 'jev', hasApiKey: true, apiKeySource: 'kiki' });
    expect(echo.body.data.permission.reviewer).not.toHaveProperty('jevConsent');
    expect((await reveal({ kind: 'reviewer_api_key' })).body.data).toEqual({ source: 'kiki', value: 'ts-fixture-saved' });

    const cleared = await call('POST', '/config', { permission: { reviewer: { api_key: null } } });
    expect(cleared.body.code).toBe(0);
    const after = await call<{ permission: { reviewer: Record<string, unknown> } }>('GET', '/config');
    expect(after.body.data.permission.reviewer).toMatchObject({
      backend: 'jev', apiKeySource: 'environment', apiKeyEnv: 'TYPESAFE_API_KEY',
    });
    expect(after.text).not.toContain('ts-fixture-env');
    expect((await reveal({ kind: 'reviewer_api_key' })).body.data)
      .toEqual({ source: 'environment', env_name: 'TYPESAFE_API_KEY', value: 'ts-fixture-env' });
  });

  it('reveals one MCP header, env value or bearer env value from a user-level entry', async () => {
    await boot();
    expect((await reveal({ kind: 'mcp_header', server: 'remote', key: 'x-api-key' })).body.data)
      .toEqual({ source: 'kiki', value: 'hdr-fixture-value' });
    expect((await reveal({ kind: 'mcp_env', server: 'local', key: 'FIXTURE_TOKEN' })).body.data)
      .toEqual({ source: 'kiki', value: 'env-fixture-value' });
    expect((await reveal({ kind: 'mcp_bearer_env', server: 'remote' })).body.data)
      .toEqual({ source: 'environment', env_name: 'FIXTURE_MCP_TOKEN', value: 'bearer-fixture-env' });
    const missing = await reveal({ kind: 'mcp_header', server: 'remote', key: 'X-Missing' });
    expect(missing.body.code).toBe(40001);
    expect(missing.text).not.toContain('hdr-fixture-value');
  });

  it('requires the bearer token and rejects unknown or OAuth references', async () => {
    await boot();
    const anonymous = await call('POST', '/secrets:reveal', { ref: { kind: 'provider_api_key', provider_id: 'inline' } }, false);
    expect(anonymous.status).toBe(401);
    expect(anonymous.text).not.toContain('sk-fixture-inline');
    expect((await reveal({ kind: 'oauth_token', provider_id: 'kimi' })).body.code).toBe(40001);
    expect((await reveal({ kind: 'provider_api_key', provider_id: 'absent' })).body.code).toBe(40001);
  });
});

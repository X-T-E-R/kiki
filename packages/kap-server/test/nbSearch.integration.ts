import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  data: T;
}

describe('server-v2 /api/v1/nb-search', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-nb-search-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function boot(config = ''): Promise<void> {
    if (config.length > 0) await writeFile(join(home, 'config.toml'), config, 'utf8');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function get<T>(path: string): Promise<Envelope<T>> {
    const response = await authedFetch(server as RunningServer, base, `/api/v1${path}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Envelope<T>;
  }

  it('reports an unconfigured search default as unavailable while keeping fetch ready', async () => {
    await boot();

    const response = await get<{
      search: { configured: boolean; available: boolean; issues: string[] };
      fetch: { configured: boolean; available: boolean; selection?: string };
    }>('/nb-search/test');

    expect(response.code).toBe(0);
    expect(response.data.search).toEqual({
      configured: false,
      available: false,
      issues: ['DEFAULT_NOT_CONFIGURED'],
    });
    expect(response.data.fetch.configured).toBe(true);
    expect(response.data.fetch.selection).toBe('direct.fetch -> jina.reader');
  });

  it('reports a configured lane and never exposes credential values', async () => {
    vi.stubEnv('TEAM_EXA_API_KEY', 'secret-value');
    await boot(`
[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "TEAM_EXA_API_KEY"

[nb_search.defaults]
search_lane = "exa.search"
`);

    const capabilities = await get<{
      search: { default_lane?: string };
    }>('/nb-search/capabilities');
    const status = await get<{
      search: { configured: boolean; available: boolean; selection?: string; issues: string[] };
    }>('/nb-search/test');

    expect(capabilities.data.search.default_lane).toBe('exa.search');
    expect(status.data.search).toEqual({
      configured: true,
      available: true,
      selection: 'exa.search',
      issues: [],
    });
    expect(JSON.stringify(capabilities)).not.toContain('secret-value');
    expect(JSON.stringify(status)).not.toContain('secret-value');
  });
});

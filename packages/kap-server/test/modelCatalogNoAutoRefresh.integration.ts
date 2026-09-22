import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IProviderDiscoveryService,
  type IProviderDiscoveryService as IProviderDiscoveryServiceType,
  type ScopeSeed,
} from '@kiki/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const LEGACY_ENV_KEYS = [
  'KIKI_MODEL_CATALOG_REFRESH_ON_START',
  'KIKI_MODEL_CATALOG_REFRESH_INTERVAL_MS',
] as const;

function discoveryStub(
  refreshProviderModels: IProviderDiscoveryServiceType['refreshProviderModels'],
): IProviderDiscoveryServiceType {
  return {
    _serviceBrand: undefined,
    refreshProviderModels,
    listDiscoveredModels: async () => ({ items: [] }),
  };
}

describe('server-v2 model catalog refresh triggers', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-catalog-no-auto-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
    for (const key of LEGACY_ENV_KEYS) {
      delete process.env[key];
    }
  });

  async function boot(toml: string | undefined, seeds: ScopeSeed): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  function countingDiscovery() {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [
      [IProviderDiscoveryService, discoveryStub(refreshProviderModels)],
    ] as unknown as ScopeSeed;
    return { refreshProviderModels, seeds };
  }

  it('never refreshes provider models at startup or on an interval, even with the legacy opt-in env set', async () => {
    const { refreshProviderModels, seeds } = countingDiscovery();
    process.env['KIKI_MODEL_CATALOG_REFRESH_ON_START'] = '1';
    process.env['KIKI_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '50';

    await boot(undefined, seeds);
    expect(refreshProviderModels).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('ignores a persisted [model_catalog] refresh block and fetches only through the explicit refresh route', async () => {
    const { refreshProviderModels, seeds } = countingDiscovery();
    const toml = [
      '[model_catalog]',
      'refresh_interval_ms = 50',
      'refresh_on_start = true',
      '',
    ].join('\n');

    await boot(toml, seeds);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refreshProviderModels).not.toHaveBeenCalled();

    const res = await authedFetch(server as RunningServer, base, '/api/providers:refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{ changed: unknown[] }>;
    expect(body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledTimes(1);
    expect(refreshProviderModels).toHaveBeenCalledWith({ scope: 'all' });
  });
});

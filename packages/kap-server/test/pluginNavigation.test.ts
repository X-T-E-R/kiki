import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { IPluginService } from '@kiki/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const PLUGIN_COUNT = 48;
const SKILLS_PER_PLUGIN = 5;
const TOOLS_PER_PLUGIN = 10;
const COLD_SESSION_COUNT = 900;
const COLD_NAVIGATION_SAMPLES = 8;
const WARM_NAVIGATION_SAMPLES = 20;
const ENDPOINT_SAMPLES = 12;
const WORKSPACE_ID = 'navigation-fixture-workspace';

type Envelope<T = unknown> = {
  code: number;
  msg?: string;
  data: T;
};

type TimedResponse = {
  ms: number;
  status?: number;
  code?: number;
  body?: unknown;
  error?: string;
};

type EndpointMetrics = {
  p50_ms: number;
  max_ms: number;
  samples: number;
  error_count: number;
};

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarize(samples: readonly TimedResponse[]): EndpointMetrics {
  const durations = samples.map((sample) => sample.ms).toSorted((a, b) => a - b);
  const errors = samples.filter((sample) => sample.error !== undefined || sample.status !== 200 || sample.code !== 0).length;
  return {
    p50_ms: rounded(durations[Math.floor((durations.length - 1) * 0.5)] ?? 0),
    max_ms: rounded(durations.at(-1) ?? 0),
    samples: samples.length,
    error_count: errors,
  };
}

async function boundedMap<T>(count: number, concurrency: number, fn: (index: number) => Promise<T>): Promise<T[]> {
  const results = Array.from({ length: count }) as T[];
  let next = 0;
  const workers = Array.from({ length: Math.min(count, concurrency) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      results[index] = await fn(index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function seedOfflinePricing(home: string): Promise<void> {
  await mkdir(join(home, 'model-pricing'), { recursive: true });
  await cp(
    join(import.meta.dirname, '../vendor/litellm/model_prices_and_context_window.json'),
    join(home, 'model-pricing/model_prices_and_context_window.json'),
  );
}

async function seedPlugins(home: string): Promise<void> {
  const installedAt = new Date().toISOString();
  const records = await boundedMap(PLUGIN_COUNT, 8, async (index) => {
    const id = `navigation-plugin-${String(index + 1).padStart(2, '0')}`;
    const root = join(home, 'plugins', 'managed', id);
    const skills = Array.from({ length: SKILLS_PER_PLUGIN }, (_, skillIndex) => `./skills/skill-${skillIndex + 1}`);
    await mkdir(root, { recursive: true });
    for (let skillIndex = 0; skillIndex < SKILLS_PER_PLUGIN; skillIndex += 1) {
      const skillDir = join(root, 'skills', `skill-${skillIndex + 1}`);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\nname: ${id}-skill-${skillIndex + 1}\ndescription: Small navigation fixture skill.\n---\nUse this fixture skill.\n`,
      );
    }
    await writeFile(join(root, 'entry.mjs'), 'export function register() {}\n');
    const tools = Array.from({ length: TOOLS_PER_PLUGIN }, (_, toolIndex) => ({
      schemaVersion: 1,
      name: `navigation_tool_${toolIndex + 1}`,
      description: 'Small navigation fixture tool.',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      accesses: [{ kind: 'all' }],
    }));
    await writeFile(join(root, 'kimi.plugin.json'), JSON.stringify({
      name: id,
      version: '1.0.0',
      description: 'Bounded plugin navigation fixture.',
      skills,
      'x-kiki': {
        engines: { kiki: '^0.4.1' },
        entry: './entry.mjs',
        tools,
      },
    }));
    return {
      id,
      root,
      source: 'local-path',
      enabled: true,
      defaultEnabled: true,
      installedAt,
      updatedAt: installedAt,
      originalSource: root,
    };
  });
  await mkdir(join(home, 'plugins'), { recursive: true });
  await writeFile(join(home, 'plugins', 'installed.json'), JSON.stringify({ version: 1, plugins: records }));
}

async function seedColdSessions(home: string): Promise<void> {
  const cwd = join(home, 'workspace');
  await mkdir(cwd, { recursive: true });
  const now = Date.now();
  await boundedMap(COLD_SESSION_COUNT, 32, async (index) => {
    const id = `cold-session-${String(index + 1).padStart(4, '0')}`;
    const createdAt = now + index;
    const sessionDir = join(home, 'sessions', WORKSPACE_ID, id);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      id,
      version: 2,
      title: `Cold fixture ${index + 1}`,
      lastPrompt: 'Bounded navigation fixture prompt.',
      createdAt,
      updatedAt: createdAt,
      archived: false,
      cwd,
      delivery: 'reply',
      agents: { main: { type: 'main', createdAt, status: 'completed' } },
      custom: {},
      isCustomTitle: false,
    }));
  });
  const timestamp = new Date(now).toISOString();
  await writeFile(join(home, 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: {
      [WORKSPACE_ID]: {
        root: cwd,
        name: 'Navigation fixture workspace',
        created_at: timestamp,
        last_opened_at: timestamp,
      },
    },
    deleted_workspace_ids: [],
  }));
}

async function timedGet(server: RunningServer, base: string, path: string, authenticated: boolean): Promise<TimedResponse> {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path}`, authenticated ? { headers: authHeaders(server) } : undefined);
    const body = await response.json() as Envelope;
    return { ms: performance.now() - started, status: response.status, code: body.code, body };
  } catch (error) {
    return { ms: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sampleGets(
  server: RunningServer,
  base: string,
  path: string,
  authenticated: boolean,
  count: number,
  concurrent: boolean,
): Promise<TimedResponse[]> {
  if (concurrent) {
    return Promise.all(Array.from({ length: count }, () => timedGet(server, base, path, authenticated)));
  }
  const samples: TimedResponse[] = [];
  for (let index = 0; index < count; index += 1) samples.push(await timedGet(server, base, path, authenticated));
  return samples;
}

function expectSuccessful(samples: readonly TimedResponse[], label: string): void {
  for (const sample of samples) {
    expect(sample.error, label).toBeUndefined();
    expect(sample.status, label).toBe(200);
    expect(sample.code, label).toBe(0);
  }
}

describe('isolated plugin navigation performance fixture', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let base = '';

  beforeEach(async () => {
    vi.stubEnv('KIKI_SEARCH_BACKEND', 'minidb');
    home = await mkdtemp(join(tmpdir(), 'kiki-plugin-navigation-'));
    await Promise.all([seedOfflinePricing(home), seedPlugins(home), seedColdSessions(home)]);
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('http://127.0.0.1:')) return realFetch(input as never, init);
      throw new Error(`Unexpected network access in isolated fixture: ${url}`);
    }));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  it('measures real HTTP navigation with 48 plugins and 900 cold sessions', async () => {
    const runningServer = server!;
    const coldNavigation = await sampleGets(runningServer, base, '/api/plugins/navigation', true, COLD_NAVIGATION_SAMPLES, true);
    const plugins = await timedGet(runningServer, base, '/api/plugins', true);
    const warmNavigation = await sampleGets(runningServer, base, '/api/plugins/navigation', true, WARM_NAVIGATION_SAMPLES, false);
    const health = await sampleGets(runningServer, base, '/api/healthz', false, ENDPOINT_SAMPLES, false);
    const sessions = await sampleGets(runningServer, base, '/api/sessions?page_size=50', true, ENDPOINT_SAMPLES, false);

    expectSuccessful(coldNavigation, 'cold navigation');
    expectSuccessful([plugins], 'plugin list');
    expectSuccessful(warmNavigation, 'warm navigation');
    expectSuccessful(health, 'health');
    expectSuccessful(sessions, 'session list');
    expect((plugins.body as Envelope<{ plugins: unknown[] }>).data.plugins).toHaveLength(PLUGIN_COUNT);
    expect((sessions[0]!.body as Envelope<{ items: unknown[] }>).data.items).toHaveLength(50);

    const actionStarted = performance.now();
    const disable = fetch(`${base}/api/plugins/navigation-plugin-01:disable`, {
      method: 'POST',
      headers: authHeaders(runningServer),
    }).then(async (response) => ({ status: response.status, body: await response.json() as Envelope }));
    const duringMutation = sampleGets(runningServer, base, '/api/plugins/navigation', true, WARM_NAVIGATION_SAMPLES, true);
    const [disabled, mutationNavigation] = await Promise.all([disable, duringMutation]);
    const disableMs = performance.now() - actionStarted;
    expect(disabled.status).toBe(200);
    expect(disabled.body.code).toBe(0);
    expectSuccessful(mutationNavigation, 'navigation during plugin disable');

    const enable = await fetch(`${base}/api/plugins/navigation-plugin-01:enable`, {
      method: 'POST',
      headers: authHeaders(runningServer),
    });
    const enabled = await enable.json() as Envelope;
    expect(enable.status).toBe(200);
    expect(enabled.code).toBe(0);

    const report = {
      fixture: {
        plugins: PLUGIN_COUNT,
        skills_per_plugin: SKILLS_PER_PLUGIN,
        tools_per_plugin: TOOLS_PER_PLUGIN,
        cold_sessions: COLD_SESSION_COUNT,
      },
      cold: { navigation: summarize(coldNavigation) },
      warm: { navigation: summarize(warmNavigation) },
      health: summarize(health),
      list: summarize(sessions),
      mutation: {
        kind: 'single-plugin-disable',
        action_ms: rounded(disableMs),
        navigation: summarize(mutationNavigation),
      },
    };
    console.log(`plugin-navigation-fixture ${JSON.stringify(report)}`);
    expect(report.cold.navigation.error_count).toBe(0);
    expect(report.warm.navigation.error_count).toBe(0);
    expect(report.health.error_count).toBe(0);
    expect(report.list.error_count).toBe(0);
    expect(report.mutation.navigation.error_count).toBe(0);

    const service = runningServer.core.accessor.get(IPluginService);
    expect((await service.listPlugins())).toHaveLength(PLUGIN_COUNT);
  }, 30_000);
});

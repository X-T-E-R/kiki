import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionIndex, type SessionSummary } from '@kiki/agent-core-v2';
import { Event } from '@kiki/agent-core-v2/_base/event';
import { usageResponseSchema, usageRescanStatusSchema, type UsageResponse } from '@kiki/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IModelPricingService } from '../src/pricing/modelPricingService';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface EnvelopeWire {
  code: number;
  msg: string;
  data: UsageResponse | null;
  request_id: string;
  details?: { path: string; message: string }[];
}

const DAY = 24 * 60 * 60 * 1000;
const BASE_TIME = Date.UTC(2026, 8, 1, 0, 0, 0);
const WS_A = 'ws_a';
const WS_B = 'ws_b';

const summaries: SessionSummary[] = [
  {
    id: 'session-high',
    workspaceId: WS_A,
    title: 'High',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 3 * DAY,
    archived: false,
  },
  {
    id: 'session-low',
    workspaceId: WS_A,
    title: 'Low',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 2 * DAY,
    archived: false,
  },
  {
    id: 'session-archived',
    workspaceId: WS_B,
    title: 'Archived',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + DAY,
    archived: true,
  },
];

function stubSessionIndex(): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: async () => ({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 }),
    onDidChangeStatus: Event.None as ISessionIndex['onDidChangeStatus'],
    status: () => ({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 }),
    listRecent: async (query) => {
      let items = summaries;
      if (query.workspaceIds !== undefined) {
        const allowed = new Set(query.workspaceIds);
        items = items.filter((item) => allowed.has(item.workspaceId));
      }
      const start = query.before === undefined
        ? 0
        : Math.max(0, items.findIndex((item) => item.id === query.before) + 1);
      const limit = query.limit ?? items.length;
      const page = items.slice(start, start + limit);
      return {
        items: page,
        nextCursor: start + page.length < items.length ? page.at(-1)?.id : undefined,
      };
    },
    get: async (id) => summaries.find((item) => item.id === id),
    count: async () => summaries.length,
    remove: async () => {},
  };
}

const pricingStub: IModelPricingService = {
  _serviceBrand: undefined,
  ready: Promise.resolve(),
  getPricing: async () => ({ items: [], overrides: {} }),
  setPricing: async () => ({ items: [], overrides: {} }),
  resolve: () => undefined,
  calculate: (model, usage) => {
    if (model === 'unknown-price') return undefined;
    return (
      (usage.inputOther ?? 0) +
      (usage.output ?? 0) +
      (usage.inputCacheRead ?? 0) +
      (usage.inputCacheCreation ?? 0)
    ) / 1000;
  },
  refreshNow: async () => false,
  status: () => ({ source: 'empty', keys: 0 }),
};

async function writeWire(
  home: string,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  const dir = join(home, 'sessions', workspaceId, sessionId, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'wire.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function usageRecord(
  time: number,
  model: string,
  output: number,
  attribution: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'usage.record',
    time,
    model,
    usage: {
      inputOther: output,
      output,
      inputCacheRead: output,
      inputCacheCreation: output,
    },
    ...attribution,
  };
}

describe('server /api/usage', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-usage-'));
    await writeWire(home, WS_A, 'session-high', 'main', [
      usageRecord(BASE_TIME + 60 * 60 * 1000, 'billing-a', 100),
      {
        type: 'usage',
        time: BASE_TIME + 60 * 60 * 1000,
        model: 'billing-a',
        usage: {
          inputOther: 100_000,
          output: 100_000,
          inputCacheRead: 100_000,
          inputCacheCreation: 100_000,
        },
      },
      usageRecord(BASE_TIME + DAY + 60 * 60 * 1000, 'billing-a', 50, {
        turnId: 7,
        agentId: 'agent-child',
        parentAgentId: 'main',
        provider: 'example-provider',
        modelAlias: 'alias-a',
        profileName: 'worker',
      }),
    ]);
    await writeWire(home, WS_A, 'session-low', 'main', [
      usageRecord(BASE_TIME + 2 * DAY + 2 * 60 * 60 * 1000, 'unknown-price', 10, {
        turnId: 3,
        agentId: 'main',
        modelAlias: 'alias-b',
      }),
    ]);
    await writeWire(home, WS_B, 'session-archived', 'main', [
      usageRecord(BASE_TIME + 3 * DAY + 2 * 60 * 60 * 1000, 'billing-a', 25, {
        turnId: 9,
        agentId: 'archived-agent',
        modelAlias: 'alias-a',
      }),
    ]);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [
        [ISessionIndex, stubSessionIndex()],
        [IModelPricingService, pricingStub],
      ],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  it('starts a full rescan through REST and exposes validated progress including archived sessions', async () => {
    const readStatus = async () => {
      const response = await authedFetch(server as RunningServer, base, '/api/usage/rescan');
      const envelope = await response.json() as { code: number; data: unknown };
      expect(envelope.code).toBe(0);
      return usageRescanStatusSchema.parse(envelope.data);
    };
    expect((await readStatus()).state).toBe('idle');
    const response = await authedFetch(server as RunningServer, base, '/api/usage/rescan', { method: 'POST' });
    const envelope = await response.json() as { code: number; data: unknown };
    expect(envelope.code).toBe(0);
    const started = usageRescanStatusSchema.parse(envelope.data);
    expect(started.state).toBe('running');
    let status = await readStatus();
    for (let attempt = 0; attempt < 100 && status.state === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await readStatus();
    }
    expect(status).toMatchObject({ state: 'completed', total_sessions: 3, scanned_sessions: 3, scanned_records: 5, error: null });
    expect(status.finished_at).not.toBeNull();
    expect((await getData('?include_archived=true')).summary.session_count).toBe(3);
  });

  it('reads and writes user pricing through the validated public route and updates usage without wire changes', async () => {
    await server?.close();
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home as string, logLevel: 'silent', seeds: [[ISessionIndex, stubSessionIndex()]] });
    base = `http://127.0.0.1:${server.port}`;
    const before = await getData();
    expect(before.reliability.unknown_price_models).toContain('billing-a');
    const prices = { input_cost_per_token: 0.01, output_cost_per_token: 0.02,
      cache_read_input_token_cost: 0.003, cache_creation_input_token_cost: 0.004, currency: 'USD' };
    const put = await authedFetch(server, base, '/api/usage/pricing', { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides: { 'billing-a': prices } }) });
    const saved = await put.json() as EnvelopeWire;
    expect(saved.code).toBe(0);
    expect(saved.data).toMatchObject({ overrides: { 'billing-a': prices } });
    const read = await authedFetch(server, base, '/api/usage/pricing?model=billing-a&model=unknown-price');
    expect((await read.json() as EnvelopeWire).data).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ model: 'billing-a', source: 'override', matched_key: 'billing-a', prices }),
      expect.objectContaining({ model: 'unknown-price', source: 'unknown', prices: null }),
    ]) });
    const after = await getData();
    expect(after.summary.cost_usd_estimated).toBeCloseTo(150 * 0.037);
    expect(after.reliability.unknown_price_models).not.toContain('billing-a');
    for (const overrides of [
      { bad: { ...prices, output_cost_per_token: -1 } },
      { bad: { ...prices, currency: 'not-a-currency' } },
      { bad: { ...prices, extra: true } },
    ]) {
      const invalid = await authedFetch(server, base, '/api/usage/pricing', { method: 'PUT',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides }) });
      expect((await invalid.json() as EnvelopeWire).code).toBe(40001);
    }
    const remove = await authedFetch(server, base, '/api/usage/pricing', { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides: { 'billing-a': null } }) });
    expect((await remove.json() as EnvelopeWire).code).toBe(0);
    expect((await getData()).reliability.unknown_price_models).toContain('billing-a');
  });

  async function get(query = ''): Promise<{ status: number; body: EnvelopeWire }> {
    const response = await authedFetch(server as RunningServer, base, `/api/usage${query}`);
    return { status: response.status, body: (await response.json()) as EnvelopeWire };
  }

  async function getData(query = ''): Promise<UsageResponse> {
    const { status, body } = await get(query);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.request_id).toBe('string');
    return usageResponseSchema.parse(body.data);
  }

  it('carries wire accounting provenance through the public response without hiding unpriced tokens', async () => {
    const at = BASE_TIME + 100 * DAY;
    await writeWire(home!, WS_A, 'session-high', 'main', [
      usageRecord(at, 'billing-a', 0, { usageKnown: false }),
      usageRecord(at + 1, 'billing-a', 0),
      usageRecord(at + 2, 'billing-a', 0, { usageKnown: true }),
      usageRecord(at + 3, 'billing-a', 5, { usageKnown: true }),
      usageRecord(at + 4, 'unknown-price', 2, { usageKnown: true }),
    ]);
    const data = await getData(`?range=custom&start_at=${at}&end_at=${at + 10}`);
    expect(data.summary).toMatchObject({
      tokens: { input_other: 7, output: 7, input_cache_read: 7, input_cache_creation: 7 },
      tokens_unknown: true,
      cost_unknown: true,
      cost_usd_estimated: 0.02,
    });
    expect(data.reliability.usage_coverage).toEqual({ known_records: 3, missing_records: 1, legacy_zero_records: 1 });
    expect(data.reliability.unknown_price_models).toEqual(['unknown-price']);
    expect(data.sessions.items[0]?.usage.tokens_unknown).toBe(true);
    const knownZero = await getData(`?range=custom&start_at=${at + 2}&end_at=${at + 3}`);
    expect(knownZero.summary).toMatchObject({ tokens_unknown: false, cost_unknown: false, cost_usd_estimated: 0 });
    expect(knownZero.reliability.usage_coverage).toEqual({ known_records: 1, missing_records: 0, legacy_zero_records: 0 });
  });

  it('defaults to all history, attributes legacy records to unknown, and ignores context usage events', async () => {
    const data = await getData();

    expect(data.query).toMatchObject({
      granularity: 'day',
      dimension: 'model',
      include_archived: false,
      range: { preset: 'all', start_at: null, end_at: null, defaulted_to_all_history: true },
    });
    expect(data.summary.tokens).toEqual({
      input_other: 160,
      output: 160,
      input_cache_read: 160,
      input_cache_creation: 160,
    });
    expect(data.summary.session_count).toBe(2);
    expect(data.trend.map((bucket) => bucket.start_at)).toEqual([
      BASE_TIME,
      BASE_TIME + DAY,
      BASE_TIME + 2 * DAY,
    ]);
    expect(data.trend[0]?.groups[0]).toMatchObject({
      key: 'unknown',
      provider: null,
      model_alias: null,
      agent_id: null,
    });
    expect(data.trend[0]?.drilldown.sessions).toEqual([
      {
        session_id: 'session-high',
        turn_ids: [],
        turn_count: 0,
        unknown_turn_records: 1,
        turn_ids_truncated: false,
      },
    ]);
    expect(data.trend.map((bucket) => [bucket.turn_count, bucket.request_count])).toEqual([
      [0, 1], [1, 1], [1, 1],
    ]);
    expect(data.sessions.items.find((item) => item.id === 'session-high')).toMatchObject({
      primary_model: 'billing-a',
      profile_names: ['worker'],
    });
    expect(data.reliability.unknown_price_models).toEqual(['unknown-price']);
    expect(data.reliability.includes_deleted_sessions).toBe(false);
  });

  it('combines granularity, custom range, agent dimension, workspace, and archive filters', async () => {
    const query = new URLSearchParams({
      granularity: 'five_hour',
      range: 'custom',
      dimension: 'agent',
      'workspace.id': WS_B,
      include_archived: 'true',
      start_at: String(BASE_TIME + 3 * DAY),
      end_at: String(BASE_TIME + 4 * DAY),
    });
    const data = await getData(`?${query}`);

    expect(data.query).toMatchObject({
      granularity: 'five_hour',
      dimension: 'agent',
      workspace_ids: [WS_B],
      include_archived: true,
    });
    expect(data.summary.session_count).toBe(1);
    expect(data.trend).toHaveLength(1);
    expect(data.trend[0]?.groups[0]?.key).toBe('archived-agent');
    expect(data.trend[0]?.drilldown).toEqual({
      sessions: [
        {
          session_id: 'session-archived',
          turn_ids: [9],
          turn_count: 1,
          unknown_turn_records: 0,
          turn_ids_truncated: false,
        },
      ],
      sessions_truncated: false,
    });
    expect(data.sessions.items[0]).toMatchObject({ id: 'session-archived', archived: true });
  });

  it('uses east-positive timezone offsets for day bucket boundaries', async () => {
    const east = await getData(
      `?workspace.id=${WS_A}&granularity=day&timezone_offset_minutes=480`,
    );
    expect(east.trend.map((bucket) => bucket.start_at)).toEqual([
      BASE_TIME - 8 * 60 * 60 * 1000,
      BASE_TIME + DAY - 8 * 60 * 60 * 1000,
      BASE_TIME + 2 * DAY - 8 * 60 * 60 * 1000,
    ]);

    const west = await getData(
      `?workspace.id=${WS_A}&granularity=day&timezone_offset_minutes=-300`,
    );
    expect(west.trend.map((bucket) => bucket.start_at)).toEqual([
      BASE_TIME - 19 * 60 * 60 * 1000,
      BASE_TIME + DAY - 19 * 60 * 60 * 1000,
      BASE_TIME + 2 * DAY - 19 * 60 * 60 * 1000,
    ]);
  });

  it('sorts session details by estimated cost and paginates with condition-bound tokens', async () => {
    const first = await getData('?page_size=1');
    expect(first.sessions.items.map((item) => item.id)).toEqual(['session-high']);
    expect(first.sessions.has_more).toBe(true);
    expect(first.sessions.next_page_token).not.toBeNull();

    const second = await getData(`?page_size=1&page_token=${first.sessions.next_page_token}`);
    expect(second.sessions.items.map((item) => item.id)).toEqual(['session-low']);
    expect(second.sessions.has_more).toBe(false);

    const drifted = await get(`?page_size=1&dimension=agent&page_token=${first.sessions.next_page_token}`);
    expect(drifted.status).toBe(200);
    expect(drifted.body.code).toBe(40922);
    expect(drifted.body.data).toBeNull();
  });

  it('returns validation envelopes for invalid custom ranges', async () => {
    const { status, body } = await get('?range=custom&start_at=100');
    expect(status).toBe(200);
    expect(body.code).toBe(40001);
    expect(body.data).toBeNull();
    expect(body.details).toContainEqual({ path: 'end_at', message: 'end_at is required for custom range' });
  });
});

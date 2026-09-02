import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionIndex, type SessionSummary } from '@moonshot-ai/agent-core-v2';
import { Event } from '@moonshot-ai/agent-core-v2/_base/event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IModelPricingService } from '../src/pricing/modelPricingService';
import { usageResponseSchema, type UsageResponse } from '../src/protocol/rest-usage';
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

describe('server /api/v2/usage', () => {
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
        agentId: 'agent-child',
        parentAgentId: 'main',
        provider: 'example-provider',
        modelAlias: 'alias-a',
        profileName: 'worker',
      }),
    ]);
    await writeWire(home, WS_A, 'session-low', 'main', [
      usageRecord(BASE_TIME + 2 * DAY + 2 * 60 * 60 * 1000, 'unknown-price', 10, {
        agentId: 'main',
        modelAlias: 'alias-b',
      }),
    ]);
    await writeWire(home, WS_B, 'session-archived', 'main', [
      usageRecord(BASE_TIME + 3 * DAY + 2 * 60 * 60 * 1000, 'billing-a', 25, {
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

  async function get(query = ''): Promise<{ status: number; body: EnvelopeWire }> {
    const response = await authedFetch(server as RunningServer, base, `/api/v2/usage${query}`);
    return { status: response.status, body: (await response.json()) as EnvelopeWire };
  }

  async function getData(query = ''): Promise<UsageResponse> {
    const { status, body } = await get(query);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.request_id).toBe('string');
    return usageResponseSchema.parse(body.data);
  }

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
    expect(data.sessions.items[0]).toMatchObject({ id: 'session-archived', archived: true });
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

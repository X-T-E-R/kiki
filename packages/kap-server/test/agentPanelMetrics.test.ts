import {
  IAgentProfileService,
  IAgentStateService,
  IAgentTokenCountingService,
  IAgentUsageService,
  IAppendLogStore,
  IUsageFactStore,
  summarizeUsageFacts,
  type UsageFactSnapshot,
  IFileSystemStorageService,
  ILogService,
  IInstantiationService,
  type IAgentScopeHandle,
  type Scope,
  type TokenUsage,
  type WireRecord,
} from '@kiki/agent-core-v2';
import { panelAccountingKey } from '@kiki/agent-core-v2/agent/usage/panelAccounting';
import { describe, expect, it, vi } from 'vitest';

import type { IModelPricingService } from '../src/pricing/modelPricingService';
import { readAgentPanelMetrics, readPersistedAgentPanelMetrics } from '../src/routes/agentPanelMetrics';

const ZERO_USAGE: TokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

function usage(inputOther: number, output: number): TokenUsage {
  return { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 };
}

function pricing(costs: Readonly<Record<string, number | undefined>>): IModelPricingService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    getPricing: async () => ({ items: [], overrides: {} }),
    setPricing: async () => ({ items: [], overrides: {} }),
    resolve: () => undefined,
    calculate: (model) => costs[model],
    refreshNow: async () => false,
    status: () => ({ source: 'empty', keys: 0 }),
  };
}

function liveAgent(
  byModel: Readonly<Record<string, TokenUsage>>,
  accounting?: {
    records: number;
    knownRecords?: number;
    knownByModel?: Readonly<Record<string, TokenUsage>>;
    incomplete: boolean;
  },
): IAgentScopeHandle {
  const total = Object.values(byModel).reduce<TokenUsage>(
    (sum, value) => ({
      inputOther: sum.inputOther + value.inputOther,
      output: sum.output + value.output,
      inputCacheRead: sum.inputCacheRead + value.inputCacheRead,
      inputCacheCreation: sum.inputCacheCreation + value.inputCacheCreation,
    }),
    { ...ZERO_USAGE },
  );
  const effectiveAccounting = accounting ?? {
    records: Object.keys(byModel).length,
    knownRecords: Object.keys(byModel).length,
    knownByModel: byModel,
    incomplete: false,
  };
  const services = {
    usage: { status: () => ({ byModel, total }) },
    state: { get: () => ({ ...effectiveAccounting, successfulCompactions: 0 }) },
    profile: { data: () => ({ executorId: 'native', modelCapabilities: { max_context_tokens: 4096 } }) },
    tokens: { statusSize: () => 0 },
  };
  return {
    accessor: {
      get: (identifier: unknown) => {
        if (identifier === IAgentUsageService) return services.usage;
        if (identifier === IAgentStateService) return services.state;
        if (identifier === IAgentProfileService) return services.profile;
        if (identifier === IAgentTokenCountingService) return services.tokens;
        throw new Error(`unexpected service ${String(identifier)}`);
      },
    },
  } as unknown as IAgentScopeHandle;
}

function record(
  model: string,
  value: TokenUsage,
  usageKnown?: boolean,
): WireRecord {
  return {
    type: 'usage.record',
    model,
    usage: value,
    usageKnown,
  } as WireRecord;
}

function persistedFixture(
  initial: readonly WireRecord[],
  throwAfter?: number,
  config: {
    readonly agentIds?: readonly string[];
    readonly beforeRead?: (scope: string, signal: AbortSignal | undefined) => Promise<void>;
    readonly recordBytes?: number;
  } = {},
) {
  let records = [...initial];
  let mtime = 1;
  let reads = 0;
  let lists = 0;
  const scopes: string[] = [];
  const documents = new Map<string, Uint8Array>();
  const serialize = () => Buffer.from(records.map((item) => JSON.stringify({ time: 1, ...item })).join('\n') + (records.length > 0 ? '\n' : ''));
  let wire = serialize();
  const bytes = () => wire;
  const storage = {
    pathFor: () => undefined,
    list: async () => {
      lists += 1;
      return config.agentIds ?? ['main'];
    },
    size: async () => bytes().length,
    mtime: async () => mtime,
    read: async (scope: string, key: string) => documents.get(`${scope}/${key}`),
    write: async (scope: string, key: string, value: Uint8Array) => { documents.set(`${scope}/${key}`, value); },
    readStream: (scope: string, _key: string, range: { start: number; end: number }, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> => {
      const scanning = options !== undefined;
      if (scanning) { reads += 1; scopes.push(scope); }
      return (async function* () {
        if (scanning) await config.beforeRead?.(scope, options?.signal);
        options?.signal?.throwIfAborted();
        const source = bytes().subarray(range.start, range.end + 1);
        if (source.length > 0) yield source;
        if (scanning && throwAfter !== undefined) throw new Error('fixture storage failure');
      })();
    },
  } as unknown as IFileSystemStorageService;
  const listeners = new Set<(event: { scope: string; key: string }) => void>();
  const appendLog = {
    generation: async () => 'legacy',
    onDidWrite: (listener: (event: { scope: string; key: string }) => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  } as unknown as IAppendLogStore;
  const log = {
    _serviceBrand: undefined,
    level: 'info',
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
    child: vi.fn(), setLevel: vi.fn(), flush: vi.fn(),
  };
  const facts: IUsageFactStore = {
    _serviceBrand: undefined,
    async read(scope) {
      const bytes = documents.get(`facts/${scope}`);
      return bytes === undefined ? { records: [] } : JSON.parse(Buffer.from(bytes).toString('utf8')) as UsageFactSnapshot;
    },
    async summary(scope, signal) {
      const snapshot = await facts.read(scope, undefined, signal);
      return { checkpoint: snapshot.checkpoint, totals: summarizeUsageFacts(snapshot.records) };
    },
    async commit(scope, start, checkpoint, records) {
      const previous = await facts.read(scope);
      documents.set(`facts/${scope}`, Buffer.from(JSON.stringify({ checkpoint, records: [...(start === 0 ? [] : previous.records), ...records] })));
    },
  };
  const core = {
    accessor: {
      get: (identifier: unknown) => {
        if (identifier === IUsageFactStore) return facts;
        if (identifier === IFileSystemStorageService) return storage;
        if (identifier === IAppendLogStore) return appendLog;
        if (identifier === ILogService) return log;
        if (identifier === IInstantiationService) return { onWillDispose: () => ({ dispose() {} }) };
        throw new Error(`unexpected service ${String(identifier)}`);
      },
    },
  } as unknown as Scope;
  return {
    core,
    log,
    setRecords(next: readonly WireRecord[]) {
      records = [...next];
      wire = serialize();
      mtime += 1;
    },
    notify(scope: string) {
      for (const listener of listeners) listener({ scope, key: 'wire.jsonl' });
    },
    projectionText: () => [...documents.values()].map((value) => Buffer.from(value).toString('utf8')).join('\n'),
    reads: () => reads,
    lists: () => lists,
    scopes: () => scopes,
  };
}

async function persisted(
  core: Scope,
  pricingService: IModelPricingService,
  key = 'default',
  options?: Parameters<typeof readPersistedAgentPanelMetrics>[4],
): Promise<Readonly<Record<string, ReturnType<typeof readAgentPanelMetrics>>>> {
  return readPersistedAgentPanelMetrics(
    core, `workspace-${key}`, `session-${key}`, pricingService, options,
  );
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('agent panel metrics cost provenance', () => {
  it('keeps the known live token and cost subtotals when another usage record is missing', () => {
    const known = usage(4, 3);
    const metrics = readAgentPanelMetrics(
      liveAgent({ known, missing: ZERO_USAGE }, {
        records: 2,
        knownRecords: 1,
        knownByModel: { known },
        incomplete: true,
      }),
      pricing({ known: 2, missing: 1 }),
    );
    expect(metrics).toMatchObject({
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 7,
      totalCostUsd: 2,
      usagePartial: true,
      costPartial: true,
    });
  });

  it('does not present an unknown-only live record as a known zero', () => {
    const metrics = readAgentPanelMetrics(
      liveAgent({ missing: ZERO_USAGE }, {
        records: 1,
        knownRecords: 0,
        knownByModel: {},
        incomplete: true,
      }),
      pricing({ missing: 0 }),
    );
    expect(metrics).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      totalCostUsd: null,
      usagePartial: true,
      costPartial: true,
    });
  });

  it('keeps an explicitly known zero when another live record is unknown', () => {
    const metrics = readAgentPanelMetrics(
      liveAgent({ free: ZERO_USAGE, missing: ZERO_USAGE }, {
        records: 2,
        knownRecords: 1,
        knownByModel: { free: ZERO_USAGE },
        incomplete: true,
      }),
      pricing({ free: 0, missing: 1 }),
    );
    expect(metrics).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      usagePartial: true,
      costPartial: true,
    });
  });

  it('degrades legacy incomplete live accounting without known provenance', () => {
    const metrics = readAgentPanelMetrics(
      liveAgent({ known: usage(4, 3), missing: ZERO_USAGE }, {
        records: 2,
        incomplete: true,
      }),
      pricing({ known: 2, missing: 1 }),
    );
    expect(metrics).toMatchObject({
      totalTokens: null,
      totalCostUsd: null,
      usagePartial: true,
      costPartial: true,
    });
  });

  it.each([
    { entries: [['known', 2], ['unknown', undefined]] as const },
    { entries: [['unknown', undefined], ['known', 2]] as const },
  ])('keeps known live prices regardless of model order', ({ entries }) => {
    const byModel = Object.fromEntries(entries.map(([model]) => [model, usage(1, 1)]));
    const metrics = readAgentPanelMetrics(
      liveAgent(byModel),
      pricing({ known: 2, unknown: undefined }),
    );
    expect(metrics).toMatchObject({ totalCostUsd: 2, costPartial: true });
  });

  it('treats a known zero price as known', () => {
    const metrics = readAgentPanelMetrics(
      liveAgent({ free: usage(1, 1) }),
      pricing({ free: 0 }),
    );
    expect(metrics).toMatchObject({ totalCostUsd: 0, costPartial: false });
  });

  it('reports null cost only when every live price is unknown', () => {
    const metrics = readAgentPanelMetrics(
      liveAgent({ unknown: usage(1, 1) }),
      pricing({ unknown: undefined }),
    );
    expect(metrics).toMatchObject({ totalCostUsd: null, costPartial: true });
  });
});

describe('persisted agent panel metrics provenance', () => {
  it('does not project unknown or legacy-zero usage as zero tokens', async () => {
    const fixture = persistedFixture([
      record('known-model', usage(4, 3), false),
      record('legacy-model', ZERO_USAGE),
    ]);
    const metrics = (await persisted(
      fixture.core,
      pricing({ 'known-model': 1, 'legacy-model': 1 }),
      'unknown',
    ))['main'];
    expect(metrics).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      totalCostUsd: null,
      usagePartial: true,
      costPartial: true,
    });
  });

  it('does not scan on an ordinary header read', async () => {
    const fixture = persistedFixture([
      record('known-model', usage(2, 3), true),
      record('known-model', usage(4, 5), true),
    ]);
    const pending = persisted(fixture.core, pricing({ 'known-model': 2 }), 'header', { settle: false });
    await expect(pending).resolves.toMatchObject({
      main: { totalTokens: null, usagePartial: true, usageSource: 'persisted' },
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(fixture.reads()).toBe(0);
    const again = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'header', { settle: false });
    expect(again['main']).toMatchObject({ totalTokens: null, usagePartial: true, usageSource: 'persisted' });
    expect(fixture.reads()).toBe(0);
  });

  it('cancels a complete scan without publishing and can resume on the next explicit read', async () => {
    const gate = deferred();
    const fixture = persistedFixture([
      record('known-model', usage(2, 3), true),
      record('known-model', usage(4, 5), true),
    ], undefined, {
      beforeRead: async () => { await gate.promise; },
    });
    const abort = new AbortController();
    const completing = persisted(fixture.core, pricing({ 'known-model': 2 }), 'refresh', {
      settle: true, complete: true, signal: abort.signal,
    });
    await vi.waitFor(() => { expect(fixture.reads()).toBe(1); });
    abort.abort();
    await expect(completing).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.reads()).toBe(1);
    const during = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'refresh', { settle: false });
    expect(during['main']).toMatchObject({ totalTokens: null, usagePartial: true });
    gate.resolve();
    await new Promise((resolve) => { setImmediate(resolve); });
    const header = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'refresh', { settle: false });
    expect(header['main']).toMatchObject({ totalTokens: null, usagePartial: true });
    const resumed = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'refresh', { settle: true, complete: true });
    expect(resumed['main']).toMatchObject({ totalTokens: 14, usagePartial: false });
    expect(fixture.reads()).toBe(2);
  });

  it('does not cache a capped usage prefix for a later header read', async () => {
    const fixture = persistedFixture([
      record('known-model', usage(2, 3), true),
      record('known-model', usage(4, 5), true),
    ]);
    const capped = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'capped', {
      settle: true,
      limits: { maxRecords: 1 },
    });
    expect(capped['main']).toMatchObject({ totalTokens: 5, usagePartial: true, usageSource: 'persisted' });
    expect(fixture.reads()).toBe(1);
    const header = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'capped', { settle: false });
    expect(header['main']).toMatchObject({ totalTokens: null, usagePartial: true, usageSource: 'persisted' });
    expect(fixture.reads()).toBe(1);
    const again = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'capped', {
      settle: true,
      limits: { maxRecords: 1 },
    });
    expect(again['main']).toMatchObject({ totalTokens: 14, usagePartial: false });
    expect(fixture.reads()).toBe(2);
    const completeHeader = await persisted(fixture.core, pricing({ 'known-model': 2 }), 'capped', { settle: false });
    expect(completeHeader['main']).toMatchObject({ totalTokens: 14, usagePartial: false });
  });

  it('projects explicitly known zero usage and zero cost as complete', async () => {
    const fixture = persistedFixture([record('free-model', ZERO_USAGE, true)]);
    const metrics = (await persisted(fixture.core, pricing({ 'free-model': 0 }), 'zero'))['main'];
    expect(metrics).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      usagePartial: false,
      costPartial: false,
    });
  });

  it.each([
    { entries: [['known-model', 2], ['unknown-model', undefined]] as const },
    { entries: [['unknown-model', undefined], ['known-model', 2]] as const },
  ])('retains known persisted usage and cost in mixed records', async ({ entries }) => {
    const records = entries.map(([model]) => record(
      model,
      model === 'known-model' ? usage(2, 3) : usage(7, 11),
      model === 'known-model',
    ));
    const fixture = persistedFixture(records);
    const metrics = (await persisted(
      fixture.core,
      pricing({ 'known-model': 2, 'unknown-model': undefined }),
      'mixed',
    ))['main'];
    expect(metrics).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      totalCostUsd: 2,
      usagePartial: true,
      costPartial: true,
    });
  });

  it.each([
    { entries: [['known-model', 2], ['unpriced-model', undefined]] as const },
    { entries: [['unpriced-model', undefined], ['known-model', 2]] as const },
  ])('keeps known cost when a known usage model is unpriced', async ({ entries }) => {
    const records = entries.map(([model]) => record(
      model,
      model === 'known-model' ? usage(2, 3) : usage(7, 11),
      true,
    ));
    const fixture = persistedFixture(records);
    const metrics = (await persisted(
      fixture.core,
      pricing({ 'known-model': 2, 'unpriced-model': undefined }),
      'unpriced',
    ))['main'];
    expect(metrics).toMatchObject({
      inputTokens: 9,
      outputTokens: 14,
      totalTokens: 23,
      totalCostUsd: 2,
      usagePartial: false,
      costPartial: true,
    });
  });

  it('rejects bad records without dropping valid known usage', async () => {
    const fixture = persistedFixture([
      { type: 'usage.record', model: 'bad-model', usage: { inputOther: -1 } } as unknown as WireRecord,
      { type: 'usage.record', model: 'bad-known-model', usage: ZERO_USAGE, usageKnown: 'invalid' } as unknown as WireRecord,
      record('known-model', usage(2, 3), true),
    ]);
    const metrics = (await persisted(fixture.core, pricing({ 'known-model': 2 }), 'bad'))['main'];
    expect(metrics).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      totalCostUsd: 2,
      usagePartial: true,
      costPartial: true,
    });
  });

  it('marks known cost partial after a later bad usage record', async () => {
    const fixture = persistedFixture([
      record('known-model', usage(2, 3), true),
      { type: 'usage.record', model: 'bad-model', usage: { inputOther: -1 } } as unknown as WireRecord,
    ]);
    const metrics = (await persisted(fixture.core, pricing({ 'known-model': 2 }), 'bad-after-known'))['main'];
    expect(metrics).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      totalCostUsd: 2,
      usagePartial: true,
      costPartial: true,
    });
  });

  it('marks known cost partial after append-log reading fails', async () => {
    const fixture = persistedFixture([record('known-model', usage(2, 3), true)], 0);
    const metrics = (await persisted(fixture.core, pricing({ 'known-model': 2 }), 'read-failure'))['main'];
    expect(metrics).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      totalCostUsd: 2,
      usagePartial: true,
      costPartial: true,
    });
  });
});

describe('persisted agent panel metrics cache scope', () => {
  it('persists only usage projection records, never historical tool bodies', async () => {
    const fixture = persistedFixture([
      { type: 'context.append_loop_event', event: { type: 'tool.result', output: 'example tool body'.repeat(8192) } } as unknown as WireRecord,
      record('model', usage(2, 3), true),
    ]);
    const metrics = (await persisted(fixture.core, pricing({ model: 1 }), 'source-bytes', { complete: true }))['main'];
    expect(metrics).toMatchObject({ totalTokens: 5, usagePartial: false });
    expect(fixture.projectionText()).not.toContain('example tool body');
    expect(fixture.projectionText()).toContain('inputOther');
    expect(fixture.log.info).toHaveBeenCalledWith('agent panel usage projection read',
      expect.objectContaining({ agents_count: 1, partial: false }));
  });

  it('lets unrelated event-loop work run during a complete scan without losing usage', async () => {
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => { clock += 1; return clock; });
    let unrelatedRan = false;
    const scheduled = setImmediate(() => { unrelatedRan = true; });
    try {
      const fixture = persistedFixture(Array.from({ length: 1024 }, () => record('model', usage(1, 0), true)));
      const metrics = (await persisted(fixture.core, pricing({ model: 1 }), 'cooperative', { complete: true }))['main'];
      expect(unrelatedRan).toBe(true);
      expect(metrics).toMatchObject({ totalTokens: 1024, usagePartial: false });
    } finally {
      clearImmediate(scheduled);
      now.mockRestore();
    }
  });

  it('does not share entries between core scopes', async () => {
    const first = persistedFixture([record('model', usage(1, 0), true)]);
    const second = persistedFixture([record('model', usage(9, 0), true)]);
    const modelPricing = pricing({ model: 1 });
    const firstMetrics = (await persisted(first.core, modelPricing))['main'];
    const secondMetrics = (await persisted(second.core, modelPricing))['main'];
    expect(firstMetrics?.totalTokens).toBe(1);
    expect(secondMetrics?.totalTokens).toBe(9);
    expect(first.reads()).toBe(1);
    expect(second.reads()).toBe(1);
  });

  it('refreshes a mutable persisted subtotal immediately when live accounting records advance', async () => {
    const fixture = persistedFixture([record('model', usage(1, 0), true)]);
    const modelPricing = pricing({ model: 1 });
    const options = { mutableAgentIds: ['main'], mutableUsageRecords: { main: 1 } };
    expect((await persisted(fixture.core, modelPricing, 'settled-generation', options))['main']?.totalTokens).toBe(1);
    fixture.setRecords([record('model', usage(1, 0), true), record('model', usage(2, 0), true)]);
    const next = { ...options, mutableUsageRecords: { main: 2 } };
    expect((await persisted(fixture.core, modelPricing, 'settled-generation', next))['main']?.totalTokens).toBe(3);
    expect((await persisted(fixture.core, modelPricing, 'settled-generation', next))['main']?.totalTokens).toBe(3);
    expect(fixture.reads()).toBe(2);
  });

  it('keeps mutable usage growth cached for five seconds and refreshes after thirty seconds', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const fixture = persistedFixture([record('model', usage(1, 0), true)]);
      const modelPricing = pricing({ model: 1 });
      const mutable = { mutableAgentIds: ['main'] } as const;
      expect((await persisted(fixture.core, modelPricing, 'ttl', mutable))['main']?.totalTokens).toBe(1);
      fixture.setRecords([record('model', usage(2, 0), true)]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await persisted(fixture.core, modelPricing, 'ttl', mutable))['main']?.totalTokens).toBe(1);
      expect(fixture.reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(25_001);
      expect((await persisted(fixture.core, modelPricing, 'ttl', mutable))['main']?.totalTokens).toBe(2);
      expect(fixture.reads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes skipped agents from the scan and the result', async () => {
    const fixture = persistedFixture([record('model', usage(3, 0), true)], undefined, {
      agentIds: ['main', 'child-1'],
    });
    const metrics = await persisted(fixture.core, pricing({ model: 1 }), 'skip', {
      skipAgentIds: ['child-1'],
    });
    expect(Object.keys(metrics)).toEqual(['main']);
    expect(fixture.reads()).toBe(1);
    expect(fixture.scopes()[0]).toContain('main');
  });

  it('refreshes mutable agents after the mutable ttl while immutable agents stay cached', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
        agentIds: ['main', 'child-1'],
      });
      const modelPricing = pricing({ model: 1 });
      const mutable = { mutableAgentIds: ['main'] } as const;
      const first = await persisted(fixture.core, modelPricing, 'ttl-split', mutable);
      expect(first['main']?.totalTokens).toBe(1);
      expect(fixture.reads()).toBe(2);
      fixture.setRecords([record('model', usage(2, 0), true)]);
      await vi.advanceTimersByTimeAsync(31_000);
      const second = await persisted(fixture.core, modelPricing, 'ttl-split', mutable);
      expect(second['main']?.totalTokens).toBe(2);
      expect(second['child-1']?.totalTokens).toBe(1);
      expect(fixture.reads()).toBe(3);
      await vi.advanceTimersByTimeAsync(600_000);
      const third = await persisted(fixture.core, modelPricing, 'ttl-split', mutable);
      expect(third['child-1']?.totalTokens).toBe(2);
      expect(third['main']?.totalTokens).toBe(2);
      expect(fixture.reads()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('folds concurrent cache misses into one persisted scan', async () => {
    const entered = deferred();
    const release = deferred();
    const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
      beforeRead: async () => { entered.resolve(); await release.promise; },
    });
    const modelPricing = pricing({ model: 1 });
    const calls = Array.from({ length: 24 }, () => persisted(fixture.core, modelPricing, 'singleflight'));
    await entered.promise;
    expect(fixture.reads()).toBe(1);
    release.resolve();
    const results = await Promise.all(calls);
    expect(results.every((metrics) => metrics['main']?.totalTokens === 1)).toBe(true);
    expect(fixture.reads()).toBe(1);
    expect(fixture.log.info).toHaveBeenCalledWith(
      'agent panel persisted metrics scan shared',
      expect.objectContaining({ cache_state: 'shared' }),
    );
  });

  it('does not share a persisted scan across different agent selections', async () => {
    const entered = deferred();
    const release = deferred();
    const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
      beforeRead: async (scope) => {
        if (!scope.includes('child-1')) return;
        entered.resolve();
        await release.promise;
      },
    });
    const modelPricing = pricing({ model: 1 });
    const first = persisted(fixture.core, modelPricing, 'selection-flight', {
      agentIds: ['child-1'],
    });
    await entered.promise;
    const second = persisted(fixture.core, modelPricing, 'selection-flight', {
      agentIds: ['child-2'],
    });
    expect(fixture.reads()).toBe(1);
    release.resolve();
    const [firstMetrics, secondMetrics] = await Promise.all([first, second]);
    expect(fixture.reads()).toBe(2);
    expect(firstMetrics['child-1']?.totalTokens).toBe(1);
    expect(secondMetrics['child-2']?.totalTokens).toBe(1);
  });

  it('does not share a persisted scan across different limits', async () => {
    const entered = deferred();
    const release = deferred();
    let invocation = 0;
    const fixture = persistedFixture([
      record('model', usage(1, 0), true),
      record('model', usage(2, 0), true),
    ], undefined, {
      beforeRead: async () => {
        invocation += 1;
        if (invocation !== 1) return;
        entered.resolve();
        await release.promise;
      },
    });
    const modelPricing = pricing({ model: 1 });
    const first = persisted(fixture.core, modelPricing, 'limits-flight', {
      limits: { maxRecords: 1 },
    });
    await entered.promise;
    const second = persisted(fixture.core, modelPricing, 'limits-flight', {
      limits: { maxRecords: 2 },
    });
    expect(fixture.reads()).toBe(1);
    release.resolve();
    const [firstMetrics, secondMetrics] = await Promise.all([first, second]);
    expect(fixture.reads()).toBe(2);
    expect(firstMetrics['main']).toMatchObject({ totalTokens: 1, usagePartial: true });
    expect(secondMetrics['main']).toMatchObject({ totalTokens: 3, usagePartial: false });
  });

  it('starts cache ttl when a scan completes', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const entered = deferred();
      const release = deferred();
      const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
        beforeRead: async () => { entered.resolve(); await release.promise; },
      });
      const modelPricing = pricing({ model: 1 });
      const first = persisted(fixture.core, modelPricing, 'completion-ttl', {
        limits: { wallTimeMs: 10_000 },
        mutableAgentIds: ['main'],
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      release.resolve();
      await first;
      fixture.setRecords([record('model', usage(2, 0), true)]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect((await persisted(fixture.core, modelPricing, 'completion-ttl', { mutableAgentIds: ['main'] }))['main']?.totalTokens).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect((await persisted(fixture.core, modelPricing, 'completion-ttl', { mutableAgentIds: ['main'] }))['main']?.totalTokens).toBe(2);
      expect(fixture.reads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks usage and cost partial when the record budget is reached', async () => {
    const fixture = persistedFixture([
      record('model', usage(1, 0), true),
      record('model', usage(2, 0), true),
      record('model', usage(4, 0), true),
    ]);
    const metrics = (await persisted(fixture.core, pricing({ model: 1 }), 'record-budget', {
      limits: { maxRecords: 2 },
    }))['main'];
    expect(metrics).toMatchObject({ totalTokens: 3, usagePartial: true, costPartial: true });
    expect(fixture.log.info).toHaveBeenCalledWith(
      'agent panel usage projection read', expect.objectContaining({ partial: true }),
    );
  });

  it('marks usage and cost partial when the byte budget is reached', async () => {
    const fixture = persistedFixture([record('model', usage(1, 0), true)]);
    const metrics = (await persisted(fixture.core, pricing({ model: 1 }), 'byte-budget', {
      limits: { maxBytes: 1 },
    }))['main'];
    expect(metrics).toMatchObject({ totalTokens: null, usagePartial: true, costPartial: true });
    expect(fixture.log.info).toHaveBeenCalledWith(
      'agent panel usage projection read', expect.objectContaining({ partial: true }),
    );
  });

  it('marks usage and cost partial when the wall-time budget is reached', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const entered = deferred();
      const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
        beforeRead: async (_scope, signal) => {
          entered.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
          });
        },
      });
      const call = persisted(fixture.core, pricing({ model: 1 }), 'wall-budget', {
        limits: { wallTimeMs: 10 },
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(11);
      const metrics = (await call)['main'];
      expect(metrics).toMatchObject({ totalTokens: null, usagePartial: true, costPartial: true });
      expect(fixture.log.info).toHaveBeenCalledWith(
        'agent panel usage projection read', expect.objectContaining({ partial: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a shared scan alive while another waiter remains', async () => {
    const entered = deferred();
    const release = deferred();
    let scanSignal: AbortSignal | undefined;
    const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
      beforeRead: async (_scope, signal) => {
        scanSignal = signal;
        entered.resolve();
        await release.promise;
      },
    });
    const controller = new AbortController();
    const first = persisted(fixture.core, pricing({ model: 1 }), 'shared-abort', {
      signal: controller.signal,
    });
    const second = persisted(fixture.core, pricing({ model: 1 }), 'shared-abort');
    await entered.promise;
    controller.abort(new DOMException('one caller left', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(scanSignal?.aborted).toBe(false);
    release.resolve();
    expect((await second)['main']?.totalTokens).toBe(1);
  });

  it('cancels the underlying scan when its last waiter aborts', async () => {
    const entered = deferred();
    let scanSignal: AbortSignal | undefined;
    const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
      beforeRead: async (_scope, signal) => {
        scanSignal = signal;
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
        });
      },
    });
    const controller = new AbortController();
    const call = persisted(fixture.core, pricing({ model: 1 }), 'abort', {
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort(new DOMException('caller left', 'AbortError'));
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(scanSignal?.aborted).toBe(true);
  });

  it.each(['main', 'child-1'])('scans only the requested %s wire instead of an 82-agent roster', async (agentId) => {
    const fixture = persistedFixture([record('model', usage(3, 0), true)], undefined, {
      agentIds: ['main', ...Array.from({ length: 81 }, (_, index) => `child-${index + 1}`)],
    });
    const metrics = await persisted(fixture.core, pricing({ model: 1 }), `targeted-${agentId}`, {
      agentIds: [agentId],
    });
    expect(Object.keys(metrics)).toEqual([agentId]);
    expect(metrics[agentId]?.totalTokens).toBe(3);
    expect(fixture.lists()).toBe(0);
    expect(fixture.reads()).toBe(1);
    expect(fixture.scopes()[0]).toContain(agentId);
    expect(fixture.log.info).toHaveBeenCalledWith(
      'agent panel usage projection read',
      expect.objectContaining({ targeted: true, agents_count: 1, partial: false }),
    );
  });

  it('invalidates cached entries when an agent goes live and when it dies', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const fixture = persistedFixture([record('model', usage(1, 0), true)], undefined, {
        agentIds: ['main', 'child-1'],
      });
      const modelPricing = pricing({ model: 1 });
      const cold = await persisted(fixture.core, modelPricing, 'live-invalidate');
      expect(cold['child-1']?.totalTokens).toBe(1);
      expect(fixture.reads()).toBe(2);
      fixture.setRecords([record('model', usage(5, 0), true)]);
      const live = await persisted(fixture.core, modelPricing, 'live-invalidate', {
        skipAgentIds: ['child-1'],
      });
      expect(live['child-1']).toBeUndefined();
      expect(fixture.reads()).toBe(2);
      const afterDeath = await persisted(fixture.core, modelPricing, 'live-invalidate');
      expect(afterDeath['child-1']?.totalTokens).toBe(5);
      expect(fixture.reads()).toBe(3);
      const cachedAfterDeath = await persisted(fixture.core, modelPricing, 'live-invalidate');
      expect(cachedAfterDeath['child-1']?.totalTokens).toBe(5);
      expect(fixture.reads()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest session entry after reaching the per-core capacity', async () => {
    const fixture = persistedFixture([record('model', usage(1, 0), true)]);
    const modelPricing = pricing({ model: 1 });
    for (let index = 0; index < 1025; index += 1) {
      await persisted(fixture.core, modelPricing, `capacity-${index}`);
    }
    expect(fixture.reads()).toBe(1025);
    fixture.setRecords([record('model', usage(2, 0), true)]);
    expect((await persisted(fixture.core, modelPricing, 'capacity-0'))['main']?.totalTokens).toBe(2);
    expect(fixture.reads()).toBe(1026);
  });
});


describe('usage projection maintenance', () => {
  it('separates completed unknown usage from a source still waiting to be read', async () => {
    const fixture = persistedFixture([record('model', ZERO_USAGE, false)]);
    const empty = await persisted(fixture.core, pricing({ model: 1 }), 'knowledge', { settle: false });
    expect(empty['main']).toMatchObject({ totalTokens: null, usageComplete: false, usagePartial: true });
    const counted = await persisted(fixture.core, pricing({ model: 1 }), 'knowledge');
    expect(counted['main']).toMatchObject({ totalTokens: null, usageComplete: true, usagePartial: true });
    const live = readAgentPanelMetrics(liveAgent({ model: ZERO_USAGE }, {
      records: 1, knownRecords: 0, knownByModel: {}, incomplete: true,
    }), pricing({ model: 1 }));
    expect(live).toMatchObject({ totalTokens: null, usageComplete: true, usagePartial: true });
  });

  it('reprices the same cached facts without rereading wire', async () => {
    const fixture = persistedFixture([record('model', usage(4, 3), true)]);
    expect((await persisted(fixture.core, pricing({ model: 1 }), 'price'))['main']?.totalCostUsd).toBe(1);
    expect((await persisted(fixture.core, pricing({ model: 5 }), 'price'))['main']?.totalCostUsd).toBe(5);
    expect((await persisted(fixture.core, pricing({ model: undefined }), 'price'))['main']).toMatchObject({ totalTokens: 7, totalCostUsd: null, costPartial: true });
    expect(fixture.reads()).toBe(1);
  });

  it('invalidates targeted cached facts on append and rewrite events without waiting for ttl', async () => {
    const fixture = persistedFixture([record('model', usage(1, 0), true)]);
    const modelPricing = pricing({ model: 1 });
    expect((await persisted(fixture.core, modelPricing, 'events'))['main']?.totalTokens).toBe(1);
    fixture.setRecords([record('model', usage(1, 0), true), record('model', usage(4, 0), true)]);
    fixture.notify('sessions/workspace-events/session-events/agents/main');
    expect((await persisted(fixture.core, modelPricing, 'events'))['main']?.totalTokens).toBe(5);
    fixture.setRecords([record('model', usage(2, 0), true)]);
    fixture.notify('sessions/workspace-events/session-events/agents/main');
    expect((await persisted(fixture.core, modelPricing, 'events'))['main']?.totalTokens).toBe(2);
    expect(fixture.reads()).toBe(3);
  });
});

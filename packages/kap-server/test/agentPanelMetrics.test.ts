import {
  IAgentProfileService,
  IAgentStateService,
  IAgentTokenCountingService,
  IAgentUsageService,
  IAppendLogStore,
  IFileSystemStorageService,
  ILogService,
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
  } = {},
) {
  let records = [...initial];
  let reads = 0;
  let lists = 0;
  const scopes: string[] = [];
  const storage = {
    list: async () => {
      lists += 1;
      return config.agentIds ?? ['main'];
    },
  } as unknown as IFileSystemStorageService;
  const appendLog = {
    read: <R>(scope: string, _key: string, options?: { signal?: AbortSignal }): AsyncIterable<R> => {
      reads += 1;
      scopes.push(scope);
      return (async function* () {
        await config.beforeRead?.(scope, options?.signal);
        for (const [index, item] of records.entries()) {
          options?.signal?.throwIfAborted();
          yield item as R;
          if (throwAfter !== undefined && index >= throwAfter) throw new Error('fixture append-log failure');
        }
      })();
    },
  } as unknown as IAppendLogStore;
  const log = {
    _serviceBrand: undefined,
    level: 'info',
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
    child: vi.fn(), setLevel: vi.fn(), flush: vi.fn(),
  };
  const core = {
    accessor: {
      get: (identifier: unknown) => {
        if (identifier === IFileSystemStorageService) return storage;
        if (identifier === IAppendLogStore) return appendLog;
        if (identifier === ILogService) return log;
        throw new Error(`unexpected service ${String(identifier)}`);
      },
    },
  } as unknown as Scope;
  return {
    core,
    log,
    setRecords(next: readonly WireRecord[]) {
      records = [...next];
    },
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
      expect(fixture.reads()).toBe(5);
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
    await vi.waitFor(() => { expect(fixture.reads()).toBe(2); });
    release.resolve();
    const [firstMetrics, secondMetrics] = await Promise.all([first, second]);
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
    await vi.waitFor(() => { expect(fixture.reads()).toBe(2); });
    release.resolve();
    const [firstMetrics, secondMetrics] = await Promise.all([first, second]);
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
    expect(fixture.log.warn).toHaveBeenCalledWith(
      'agent panel persisted metrics scan budget reached',
      expect.objectContaining({ records_count: 2, cancellation_reason: 'record_budget' }),
    );
  });

  it('marks usage and cost partial when the byte budget is reached', async () => {
    const fixture = persistedFixture([record('model', usage(1, 0), true)]);
    const metrics = (await persisted(fixture.core, pricing({ model: 1 }), 'byte-budget', {
      limits: { maxBytes: 1 },
    }))['main'];
    expect(metrics).toMatchObject({ totalTokens: null, usagePartial: true, costPartial: true });
    expect(fixture.log.warn).toHaveBeenCalledWith(
      'agent panel persisted metrics scan budget reached',
      expect.objectContaining({ cancellation_reason: 'byte_budget' }),
    );
  });

  it('marks usage and cost partial when the wall-time budget is reached', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const entered = deferred();
      const fixture = persistedFixture([], undefined, {
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
      expect(fixture.log.warn).toHaveBeenCalledWith(
        'agent panel persisted metrics scan budget reached',
        expect.objectContaining({ cancellation_reason: 'wall_time_budget' }),
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
    const fixture = persistedFixture([], undefined, {
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

  it('scans only the selected child without listing the session roster', async () => {
    const fixture = persistedFixture([record('model', usage(3, 0), true)], undefined, {
      agentIds: ['main', 'child-1', 'child-2'],
    });
    const metrics = await persisted(fixture.core, pricing({ model: 1 }), 'targeted', {
      agentIds: ['child-1'],
    });
    expect(Object.keys(metrics)).toEqual(['child-1']);
    expect(metrics['child-1']?.totalTokens).toBe(3);
    expect(fixture.lists()).toBe(0);
    expect(fixture.reads()).toBe(1);
    expect(fixture.scopes()[0]).toContain('child-1');
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

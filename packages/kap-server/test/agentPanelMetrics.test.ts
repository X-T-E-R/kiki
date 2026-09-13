import {
  IAgentProfileService,
  IAgentStateService,
  IAgentTokenCountingService,
  IAgentUsageService,
  IAppendLogStore,
  IFileSystemStorageService,
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
  accounting: { records: number; incomplete: boolean } = { records: 1, incomplete: false },
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
  const services = {
    usage: { status: () => ({ byModel, total }) },
    state: { get: () => ({ ...accounting, successfulCompactions: 0 }) },
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

function persistedFixture(initial: readonly WireRecord[], throwAfter?: number) {
  let records = [...initial];
  let reads = 0;
  const storage = {
    list: async () => ['main'],
  } as unknown as IFileSystemStorageService;
  const appendLog = {
    read: <R>(_scope: string): AsyncIterable<R> => {
      reads += 1;
      return (async function* () {
        for (const [index, item] of records.entries()) {
          yield item as R;
          if (throwAfter !== undefined && index >= throwAfter) throw new Error('fixture append-log failure');
        }
      })();
    },
  } as unknown as IAppendLogStore;
  const core = {
    accessor: {
      get: (identifier: unknown) => {
        if (identifier === IFileSystemStorageService) return storage;
        if (identifier === IAppendLogStore) return appendLog;
        throw new Error(`unexpected service ${String(identifier)}`);
      },
    },
  } as unknown as Scope;
  return {
    core,
    setRecords(next: readonly WireRecord[]) {
      records = [...next];
    },
    reads: () => reads,
  };
}

async function persisted(
  core: Scope,
  pricingService: IModelPricingService,
  revision = '',
  key = 'default',
): Promise<Readonly<Record<string, ReturnType<typeof readAgentPanelMetrics>>>> {
  return readPersistedAgentPanelMetrics(core, `workspace-${key}`, `session-${key}`, pricingService, revision);
}

describe('agent panel metrics cost provenance', () => {
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
      '',
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
    const metrics = (await persisted(fixture.core, pricing({ 'free-model': 0 }), '', 'zero'))['main'];
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
      '',
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
      '',
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
    const metrics = (await persisted(fixture.core, pricing({ 'known-model': 2 }), '', 'bad'))['main'];
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
    const metrics = (await persisted(fixture.core, pricing({ 'known-model': 2 }), '', 'bad-after-known'))['main'];
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
    const metrics = (await persisted(fixture.core, pricing({ 'known-model': 2 }), '', 'read-failure'))['main'];
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
    const firstMetrics = (await persisted(first.core, modelPricing, 'r1'))['main'];
    const secondMetrics = (await persisted(second.core, modelPricing, 'r1'))['main'];
    expect(firstMetrics?.totalTokens).toBe(1);
    expect(secondMetrics?.totalTokens).toBe(9);
    expect(first.reads()).toBe(1);
    expect(second.reads()).toBe(1);
  });

  it('keeps usage growth cached for five seconds and refreshes after thirty seconds', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const fixture = persistedFixture([record('model', usage(1, 0), true)]);
      const modelPricing = pricing({ model: 1 });
      expect((await persisted(fixture.core, modelPricing, 'recorded-complete', 'ttl'))['main']?.totalTokens).toBe(1);
      fixture.setRecords([record('model', usage(2, 0), true)]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await persisted(fixture.core, modelPricing, 'recorded-complete', 'ttl'))['main']?.totalTokens).toBe(1);
      expect(fixture.reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(25_001);
      expect((await persisted(fixture.core, modelPricing, 'recorded-complete', 'ttl'))['main']?.totalTokens).toBe(2);
      expect(fixture.reads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a session entry when the roster revision changes', async () => {
    const fixture = persistedFixture([record('model', usage(1, 0), true)]);
    const modelPricing = pricing({ model: 1 });
    expect((await persisted(fixture.core, modelPricing, 'recorded-complete'))['main']?.totalTokens).toBe(1);
    fixture.setRecords([record('model', usage(2, 0), true)]);
    expect((await persisted(fixture.core, modelPricing, 'recorded-incomplete'))['main']?.totalTokens).toBe(2);
    expect(fixture.reads()).toBe(2);
    fixture.setRecords([record('model', usage(3, 0), true)]);
    expect((await persisted(fixture.core, modelPricing, 'recorded-complete'))['main']?.totalTokens).toBe(3);
    expect(fixture.reads()).toBe(3);
  });

  it('evicts the oldest session entry after reaching the per-core capacity', async () => {
    const fixture = persistedFixture([record('model', usage(1, 0), true)]);
    const modelPricing = pricing({ model: 1 });
    for (let index = 0; index < 257; index += 1) {
      await persisted(fixture.core, modelPricing, 'stable', `capacity-${index}`);
    }
    expect(fixture.reads()).toBe(257);
    fixture.setRecords([record('model', usage(2, 0), true)]);
    expect((await persisted(fixture.core, modelPricing, 'stable', 'capacity-0'))['main']?.totalTokens).toBe(2);
    expect(fixture.reads()).toBe(258);
  });
});

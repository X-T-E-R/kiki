// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { USAGE_FILTERS_STORAGE_KEY, type UsageResponseWire } from '../lib/usageV2';
import { UsagePage } from './UsagePage';
import { subscribeUsageFreshness } from '../lib/usageFreshness';
import { writeLastSessionId } from '@kiki/session-core/settings';
import type { Klient } from '@kiki/klient';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const getUsage = vi.fn();
const getUsageRescan = vi.fn();
const startUsageRescan = vi.fn();
const getSession = vi.fn();
const listWorkspaces = vi.fn();
const getRequestGovernance = vi.fn().mockResolvedValue({ domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 1, asOf: '2026-01-01T12:00:00Z', active: 3, queued: 2, coverage: { native: 'managed', external: 'unmanaged' }, dimensions: [], rules: [], waiting: [] });
const setRequestGovernanceRules = vi.fn().mockResolvedValue({});
const listModels = vi.fn().mockResolvedValue({ items: [] });
const listProviders = vi.fn().mockResolvedValue({ items: [] });

vi.mock('../state/connection', () => ({
  useOptionalConnection: () => undefined,
  useConnection: () => ({ scopeId: 'test-domain', wsStatus: 'open', client: { getUsage, getUsageRescan, startUsageRescan, getSession, listWorkspaces, getRequestGovernance, setRequestGovernanceRules, listModels, listProviders } }),
}));

function tokens(inputOther: number, cacheRead = 0) {
  return {
    input_other: inputOther,
    output: Math.round(inputOther / 10),
    input_cache_read: cacheRead,
    input_cache_creation: 0,
  };
}

function usageResponse(overrides: {
  defaulted?: boolean;
  costUnknown?: boolean;
  tokensUnknown?: boolean;
  summaryTokens?: ReturnType<typeof tokens>;
  sessionTokens?: ReturnType<typeof tokens>;
  trendTokens?: ReturnType<typeof tokens>;
  summaryCost?: number;
  unknownPriceModels?: string[];
  usageCoverage?: {
    known_records: number;
    missing_records: number;
    legacy_zero_records: number;
  };
  incompleteReason?: 'session_cap' | 'record_budget' | 'deadline' | null;
  incompleteSessions?: number;
  sessions?: { id: string; title?: string; cost?: number }[];
  hasMore?: boolean;
  nextPageToken?: string | null;
  trendGroups?: { key: string; cost: number; provider?: string | null; profile?: string | null }[];
} = {}): UsageResponseWire {
  const items = (overrides.sessions ?? [{ id: 's_1', title: 'Alpha session', cost: 1.5 }]).map(
    (item) => ({
      id: item.id,
      workspace_id: 'wd_1',
      title: item.title ?? null,
      created_at: 1000,
      updated_at: 2000,
      archived: false,
      deleted: false,
      usage: {
        tokens: overrides.sessionTokens ?? tokens(1000, 500),
        tokens_unknown: overrides.tokensUnknown,
        cost_usd_estimated: item.cost ?? 1,
        cost_unknown: overrides.costUnknown ?? false,
      },
      unknown_price_models: overrides.unknownPriceModels ?? [],
    }),
  );
  const day = new Date(2026, 8, 1).getTime();
  return {
    query: {
      granularity: 'day',
      range: {
        preset: 'all',
        start_at: null,
        end_at: null,
        defaulted_to_all_history: overrides.defaulted ?? false,
      },
      dimension: 'model',
      models: [],
      providers: [],
      agent_ids: [],
      workspace_ids: [],
      include_archived: true,
      timezone_offset_minutes: 0,
    },
    summary: {
      tokens: overrides.summaryTokens ?? tokens(5000, 2500),
      tokens_unknown: overrides.tokensUnknown,
      cost_usd_estimated: overrides.summaryCost ?? 3.25,
      cost_unknown: overrides.costUnknown ?? false,
      session_count: items.length,
    },
    trend: [
      {
        key: String(day),
        start_at: day,
        end_at: day + 24 * 3600_000,
        groups: (overrides.trendGroups ?? [
          { key: 'k2-thinking', cost: 2.4, provider: 'kimi', profile: 'general' },
          { key: 'claude-sonnet-4.5', cost: 0.85, provider: 'anthropic', profile: 'explore' },
        ]).map(
          (group) => ({
            key: group.key,
            tokens: overrides.trendTokens ?? tokens(5000, 2500),
            tokens_unknown: overrides.tokensUnknown,
            cost_usd_estimated: group.cost,
            cost_unknown: overrides.costUnknown ?? false,
            provider: group.provider ?? null,
            model_alias: group.key === 'unknown' ? null : group.key,
            agent_id: null,
            parent_agent_id: null,
            profile_name: group.profile ?? (group.key === 'unknown' ? null : 'default'),
          }),
        ),
        drilldown: {
          sessions: [
            {
              session_id: 's_1',
              turn_ids: [1, 2],
              turn_count: 2,
              unknown_turn_records: 0,
              turn_ids_truncated: false,
            },
          ],
          sessions_truncated: false,
        },
      },
    ],
    sessions: {
      items,
      total: items.length,
      has_more: overrides.hasMore ?? false,
      next_page_token: overrides.nextPageToken ?? null,
    },
    reliability: {
      complete: (overrides.incompleteReason === null || overrides.incompleteReason === undefined) && (overrides.incompleteSessions ?? 0) === 0,
      usage_coverage: overrides.usageCoverage,
      coverage: { earliest_at: day, latest_at: day + 2 * 24 * 3600_000 },
      scanned_sessions: items.length,
      incomplete_sessions: overrides.incompleteSessions ?? 0,
      unknown_price_models: overrides.unknownPriceModels ?? [],
      includes_deleted_sessions: false,
      incomplete_reason: overrides.incompleteReason ?? null,
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <span data-location-probe>{`${location.pathname}${location.search}`}</span>;
}

async function renderPage(entry = '/usage?panel=history', options: { flush?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[entry]}>
            <UsagePage onToggleSidebar={() => {}} />
            <LocationProbe />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  if (options.flush !== false) {
    // Flush react-query promise resolution + re-render (a few macrotask turns).
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  }
  return { container, root, queryClient };
}

async function openLiveStrip(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>('[data-usage-strip-toggle]')!;
  if (toggle.getAttribute('aria-expanded') === 'false') {
    await act(async () => { toggle.click(); });
  }
}

async function openReliability(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>('[data-usage-reliability-toggle]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('[data-usage-reliability]')).toBeNull();
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[data-usage-reliability]')?.id).toBe(toggle.getAttribute('aria-controls'));
}

/** Calls to the main paged query (it requests the 25-row session page). */
function mainCalls() {
  return getUsage.mock.calls.filter(
    ([query]) => (query as Record<string, unknown>)['page_size'] === 25,
  );
}

beforeEach(() => {
  localStorage.clear();
  getUsage.mockReset();
  getUsageRescan.mockReset();
  startUsageRescan.mockReset();
  getUsageRescan.mockResolvedValue({ state: 'idle', scanned_sessions: 0, total_sessions: 0, scanned_records: 0, started_at: null, finished_at: null, error: null });
  getSession.mockReset();
  listWorkspaces.mockReset();
  getUsage.mockImplementation(async (query: Record<string, unknown>) =>
    usageResponse({ defaulted: query['range'] === undefined }),
  );
  getSession.mockRejectedValue(new Error('no session'));
  listWorkspaces.mockResolvedValue({ items: [{ id: 'wd_1', name: 'Workspace One' }] });
});

describe('UsagePage (V2)', () => {
  it('opens today with one request and shares its real summary with the strip', async () => {
    let complete!: (response: UsageResponseWire) => void;
    getUsage.mockImplementation(() => new Promise<UsageResponseWire>((resolve) => { complete = resolve; }));
    const { container, root, queryClient } = await renderPage('/usage', { flush: false });
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getUsage.mock.calls[0]?.[0]).toMatchObject({ range: 'today', page_size: 25 });
    expect(container.querySelector('[data-usage-summary-cost]')).toBeNull();
    await act(async () => { complete(usageResponse({ summaryCost: 8.75 })); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('8.75');
    await openLiveStrip(container);
    expect(container.querySelector('[data-usage-strip-tokens]')?.textContent).toContain('8.75');
    await act(async () => { root.unmount(); });
    queryClient.clear();
  });

  it('defers a separate today strip until the filtered dashboard has arrived', async () => {
    let complete!: (response: UsageResponseWire) => void;
    getUsage.mockImplementation((query: Record<string, unknown>) => query['page_size'] === 1
      ? Promise.resolve(usageResponse({ summaryCost: 4.5 }))
      : new Promise<UsageResponseWire>((resolve) => { complete = resolve; }));
    const { container, root, queryClient } = await renderPage('/usage?range=last_7_days', { flush: false });
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getUsage.mock.calls[0]?.[0]).toMatchObject({ range: 'last_7_days' });
    await act(async () => { complete(usageResponse({ summaryCost: 12 })); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getUsage).toHaveBeenCalledTimes(2);
    expect(getUsage.mock.calls[1]?.[0]).toMatchObject({ range: 'today', page_size: 1 });
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('12.00');
    await openLiveStrip(container);
    expect(container.querySelector('[data-usage-strip-tokens]')?.textContent).toContain('4.50');
    await act(async () => { root.unmount(); });
    queryClient.clear();
  });

  it('recovers an initial failure without starting a competing today request', async () => {
    getUsage.mockRejectedValueOnce(new Error('usage read unavailable')).mockResolvedValue(usageResponse({ summaryCost: 2.5 }));
    const { container, root, queryClient } = await renderPage('/usage');
    expect(getUsage).toHaveBeenCalledTimes(1);
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reload')!;
    expect(container.textContent).toContain('Your time range and filters are kept');
    // No raw diagnostics next to the recovery action.
    expect(container.textContent).not.toContain('usage read unavailable');
    expect(retry).toBeDefined();
    await act(async () => { retry.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getUsage).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('2.50');
    await openLiveStrip(container);
    expect(container.querySelector('[data-usage-strip-tokens]')?.textContent).toContain('2.50');
    await act(async () => { root.unmount(); });
    queryClient.clear();
  });
  it('refreshes the current dashboard, strip and session automatically on settled usage', async () => {
    writeLastSessionId('usage-session');
    let cost = 3.25;
    getUsage.mockImplementation(async () => usageResponse({ summaryCost: cost }));
    getSession.mockImplementation(async () => ({ id: 'usage-session', title: 'Usage session', usage: { total_cost_usd: cost } }));
    const { container, root, queryClient } = await renderPage();
    let notify!: (payload: { sessionId: string; agentId: string }) => void;
    const dispose = vi.fn();
    const on = vi.fn((_name, listener) => { notify = listener; return { ready: Promise.resolve(), dispose }; });
    const source = { events: { on } } as unknown as Pick<Klient, 'events'>;
    let off!: () => void;
    await act(async () => { off = subscribeUsageFreshness(source, queryClient); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(on).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('3.25');
    await openLiveStrip(container);
    const priorSessionReads = getSession.mock.calls.length;
    cost = 7.5;
    await act(async () => { notify({ sessionId: 'usage-session', agentId: 'main' }); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('7.50');
    expect(container.querySelector('[data-usage-strip]')?.textContent).toContain('7.50');
    expect(getSession.mock.calls.length).toBeGreaterThan(priorSessionReads);
    expect(on).toHaveBeenCalledTimes(1);
    off();
    expect(dispose).toHaveBeenCalledTimes(1);
    const afterDispose = getUsage.mock.calls.length;
    notify({ sessionId: 'usage-session', agentId: 'main' });
    await act(async () => { await Promise.resolve(); });
    expect(getUsage).toHaveBeenCalledTimes(afterDispose);
    await act(async () => { root.unmount(); });
    queryClient.clear();
  });
  it('opens history by default and offers History, the combined Live tab and Export', async () => {
    const { container, root } = await renderPage('/usage');
    expect([...container.querySelectorAll<HTMLElement>('[data-usage-panel]')].map((node) => node.dataset['usagePanel'])).toEqual(['history', 'realtime', 'export']);
    expect(container.querySelector('[data-usage-panel="history"]')?.getAttribute('aria-current')).toBe('page');
    expect(mainCalls().length).toBeGreaterThan(0);
    expect(container.querySelector('[data-governance-active]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-panel="realtime"]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-empty]')).not.toBeNull();
    expect(container.querySelector('[data-usage-rescan]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-panel="history"]')!.click(); });
    await openReliability(container);
    await act(async () => { root.unmount(); });
  });

  it.each(['realtime', 'limits'])('preserves the %s deep link in the combined Live tab', async (panel) => {
    const { container, root } = await renderPage(`/usage?panel=${panel}`);
    expect(container.querySelector('[data-usage-panel="realtime"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-rules]')).not.toBeNull();
    expect(mainCalls()).toHaveLength(0);
    if (panel === 'limits') expect(document.activeElement).toBe(container.querySelector('#usage-limits'));
    expect(container.querySelector('[data-location-probe]')?.textContent).toBe(`/usage?panel=${panel}`);
    await act(async () => { root.unmount(); });
  });

  it('defaults historical usage to local today without an all-history notice', async () => {
    const { container } = await renderPage();
    const main = mainCalls();
    expect(main.length).toBeGreaterThan(0);
    expect(main[0]?.[0]).toMatchObject({
      granularity: 'five_hour',
      range: 'today',
      dimension: 'model',
    });
    expect(container.querySelector('[data-usage-all-history]')).toBeNull();
    await openReliability(container);
    expect(container.textContent).toContain('Deleted sessions are not included');
  });

  it('keeps explicit all-history URL semantics', async () => {
    const { container } = await renderPage('/usage?range=all');
    const main = mainCalls();
    expect(main[0]?.[0]).toMatchObject({ granularity: 'five_hour', dimension: 'model' });
    expect((main[0]?.[0] as Record<string, unknown>)['range']).toBeUndefined();
    expect(container.querySelector('[data-usage-all-history]')?.textContent).toContain(
      'All history',
    );
  });

  it.each([
    ['all', { range: 'all' }],
    ['last_7_days', { range: 'last_7_days' }],
    ['custom', { range: 'custom', startAt: 1000, endAt: 2000 }],
  ] as const)('always defaults a query-less visit to today despite stored %s', async (_label, storedRange) => {
    localStorage.setItem(
      USAGE_FILTERS_STORAGE_KEY,
      JSON.stringify({
        granularity: 'month',
        dimension: 'agent',
        workspaceId: 'ws-old',
        includeArchived: false,
        ...storedRange,
      }),
    );
    const { container } = await renderPage();
    const main = mainCalls();
    expect(main.length).toBeGreaterThan(0);
    expect(main[0]?.[0]).toMatchObject({
      granularity: 'five_hour',
      range: 'today',
      dimension: 'model',
      include_archived: 'true',
    });
    expect((main[0]?.[0] as Record<string, unknown>)['workspace.id']).toBeUndefined();
    expect((main[0]?.[0] as Record<string, unknown>)['start_at']).toBeUndefined();
    expect((main[0]?.[0] as Record<string, unknown>)['end_at']).toBeUndefined();
    expect(container.querySelector('[data-usage-all-history]')).toBeNull();
  });

  it('refetches today usage when local midnight and the timezone offset change', async () => {
    vi.useFakeTimers();
    const timezone = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(480);
    try {
      vi.setSystemTime(new Date(2026, 8, 1, 23, 59, 30));
      await renderPage('/usage?range=today', { flush: false });
      for (let i = 0; i < 5; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      }
      const initial = mainCalls()[0]?.[0] as Record<string, unknown>;
      expect(initial).toMatchObject({ range: 'today', timezone_offset_minutes: -480 });

      const callsBeforeMidnight = mainCalls().length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      for (let i = 0; i < 5; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      }
      expect(mainCalls().length).toBeGreaterThan(callsBeforeMidnight);
      expect(mainCalls().at(-1)?.[0]).toMatchObject({
        range: 'today',
        timezone_offset_minutes: -480,
      });

      const callsBeforeOffsetChange = mainCalls().length;
      timezone.mockReturnValue(360);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      for (let i = 0; i < 5; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      }
      expect(mainCalls().length).toBeGreaterThan(callsBeforeOffsetChange);
      expect(mainCalls().at(-1)?.[0]).toMatchObject({
        range: 'today',
        timezone_offset_minutes: -360,
      });
    } finally {
      timezone.mockRestore();
      vi.useRealTimers();
    }
  });

  it('carries every URL axis into the API query', async () => {
    localStorage.setItem(
      USAGE_FILTERS_STORAGE_KEY,
      JSON.stringify({
        granularity: 'day',
        range: 'all',
        dimension: 'project',
        includeArchived: true,
      }),
    );
    await renderPage(
      '/usage?granularity=five_hour&range=last_7_days&dimension=agent&workspace=wd_1&include_archived=false',
    );
    expect(mainCalls()[0]?.[0]).toMatchObject({
      granularity: 'five_hour',
      range: 'last_7_days',
      dimension: 'agent',
      'workspace.id': 'wd_1',
      include_archived: 'false',
    });
  });

  it('does not render zero-valued statistics while usage is loading', async () => {
    getUsage.mockImplementation(() => new Promise<UsageResponseWire>(() => {}));
    const { container, root } = await renderPage();
    expect(container.textContent).not.toContain('Estimated cost');
    expect(container.querySelector('[data-usage-reliability]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('shows a failed request and retry rather than empty statistics', async () => {
    getUsage.mockRejectedValue(new Error('usage fixture unavailable'));
    const { container, root } = await renderPage();
    // The reader keeps their conditions and is offered one way forward; the
    // technical detail stays out of the page.
    expect(container.textContent).toContain('Your time range and filters are kept');
    expect(container.textContent).not.toContain('usage fixture unavailable');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Reload')).toBe(true);
    expect(container.textContent).not.toContain('Estimated cost');
    expect(container.querySelector('[data-usage-reliability]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it.each([
    ['en', 'Some usage is unknown', 'Rescan all'],
    ['zh', '部分用量未知', '全量重扫'],
  ])('collapses all reliability warnings into one disclosure in %s', async (locale, label, action) => {
    localStorage.setItem('kiki.locale', locale);
    getUsage.mockImplementation(async () => usageResponse({
      costUnknown: true,
      tokensUnknown: true,
      unknownPriceModels: ['example-model-a', 'example-model-b'],
      incompleteReason: 'record_budget',
      incompleteSessions: 4,
      usageCoverage: { known_records: 21, missing_records: 5, legacy_zero_records: 0 },
    }));
    const { container, root } = await renderPage();
    const toggle = container.querySelector<HTMLButtonElement>('[data-usage-reliability-toggle]')!;
    expect(toggle.textContent).toBe(label);
    expect(container.textContent?.split(label).length).toBe(2);
    expect(container.querySelector('[data-usage-rescan-start]')?.textContent).toBe(action);
    expect(container.textContent).not.toContain('example-model-a');
    expect(container.querySelector('[data-usage-incomplete]')).toBeNull();
    expect(container.querySelector('[data-usage-accounting-missing]')).toBeNull();
    expect(container.querySelector('[data-usage-accounting-notices]')).toBeNull();
    await openReliability(container);
    expect(container.querySelector('[data-usage-unpriced-models]')?.textContent).toContain('example-model-a');
    expect(container.querySelector('[data-usage-incomplete]')).not.toBeNull();
    expect(container.querySelector('[data-usage-accounting-missing]')).not.toBeNull();
    expect(container.querySelector('[data-usage-reliability] [data-usage-accounting-known-subtotal]')).not.toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('example-model-a');
    expect(container.querySelector('[data-usage-accounting-notices]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it.each([
    [
      'provider-missing',
      true,
      { known_records: 0, missing_records: 2, legacy_zero_records: 0 },
    ],
    ['true-zero', false, { known_records: 1, missing_records: 0, legacy_zero_records: 0 }],
  ] as const)(
    'distinguishes %s token totals from a known zero',
    async (_label, tokensUnknown, usageCoverage) => {
      getUsage.mockImplementation(async () =>
        usageResponse({
          tokensUnknown,
          summaryTokens: tokens(0),
          sessionTokens: tokens(0),
          trendTokens: tokens(0),
          summaryCost: 0,
          sessions: [{ id: 's_accounting', title: 'Accounting', cost: 0 }],
          trendGroups: [{ key: 'accounting', cost: 0 }],
          usageCoverage,
        }),
      );
      const { container } = await renderPage();
      const summaryTokens = container.querySelector('[data-usage-summary-tokens]')?.textContent;
      const summaryCost = container.querySelector('[data-usage-summary-cost]')?.textContent;
      await openLiveStrip(container);
      const stripTokens = container.querySelector('[data-usage-strip-tokens]')?.textContent;
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-tab="sessions"]')!.click(); });
      const sessionTokens = container.querySelector('[data-usage-session-tokens="s_accounting"]')?.textContent;
      const sessionCost = container.querySelector('[data-usage-session-cost="s_accounting"]')?.textContent;
      if (tokensUnknown) {
        expect(summaryTokens).toContain('—');
        // A recorded cost of zero is a real zero, not a missing figure: the
        // price side is judged on its own flag, not on the token total.
        expect(summaryCost).not.toContain('—');
        expect(stripTokens).toContain('—');
        expect(sessionTokens).toContain('—');
        expect(sessionCost).not.toContain('—');
        expect(container.querySelector('[data-usage-trend] [data-bucket]')?.getAttribute('title')).toContain('—');
        await openReliability(container);
        expect(container.querySelector('[data-usage-accounting-missing]')).not.toBeNull();
      } else {
        expect(summaryTokens).not.toContain('—');
        expect(summaryTokens).toContain('0');
        expect(summaryCost).not.toContain('—');
        expect(stripTokens).not.toContain('—');
        expect(sessionTokens).not.toContain('—');
        expect(sessionCost).not.toContain('—');
        expect(container.querySelector('[data-usage-accounting-missing]')).toBeNull();
      }
    },
  );

  it('keeps absent accounting metadata backward compatible with known zeros', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({
        summaryTokens: tokens(0),
        sessionTokens: tokens(0),
        trendTokens: tokens(0),
        summaryCost: 0,
        sessions: [{ id: 's_legacy-client', title: 'Legacy client', cost: 0 }],
        trendGroups: [{ key: 'legacy-client', cost: 0 }],
      }),
    );
    const { container } = await renderPage();
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).toContain('0');
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-accounting-notices]')).toBeNull();
  });

  it('shows a distinct legacy-zero provenance notice', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({
        tokensUnknown: true,
        summaryTokens: tokens(0),
        sessionTokens: tokens(0),
        trendTokens: tokens(0),
        summaryCost: 0,
        usageCoverage: { known_records: 0, missing_records: 0, legacy_zero_records: 3 },
      }),
    );
    const { container } = await renderPage();
    expect(container.querySelector('[data-usage-accounting-missing]')).toBeNull();
    await openReliability(container);
    expect(container.querySelector('[data-usage-accounting-legacy-zero]')).not.toBeNull();
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).toContain('—');
  });

  it('retains positive known subtotals when some token records are missing', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({
        tokensUnknown: true,
        summaryTokens: tokens(10),
        sessionTokens: tokens(10),
        trendTokens: tokens(10),
        summaryCost: 2,
        sessions: [{ id: 's_mixed', title: 'Mixed', cost: 2 }],
        trendGroups: [{ key: 'mixed', cost: 2 }],
        usageCoverage: { known_records: 1, missing_records: 2, legacy_zero_records: 0 },
      }),
    );
    const { container } = await renderPage();
    await openReliability(container);
    expect(container.querySelector('[data-usage-accounting-missing]')).not.toBeNull();
    expect(container.querySelector('[data-usage-accounting-known-subtotal]')).not.toBeNull();
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).not.toContain('—');
    // A partial token record keeps its known subtotal; the row is not blanked out.
    expect(container.querySelector('[data-usage-breakdown-tokens="mixed"]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-breakdown-tokens="mixed"]')?.textContent).toContain('11');
    expect(container.querySelector('[data-usage-breakdown-cost="mixed"]')?.textContent).not.toContain('—');
  });

  it('shows positive token and cost subtotals when pricing is unknown', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({ defaulted: true, costUnknown: true, unknownPriceModels: ['mystery-1'] }),
    );
    const { container } = await renderPage();
    expect(container.querySelector('[data-usage-reliability-toggle]')?.textContent).toContain('Some usage is unknown');
    expect(container.textContent).not.toContain('mystery-1');
    expect(container.textContent).not.toContain('partially unknown');
    // Cost and token provenance are judged separately, so the priced part is
    // still labelled and shown rather than blanked by a missing token record.
    expect(container.textContent).toContain('Recorded estimated cost');
    await openReliability(container);
    expect(container.querySelector('[data-usage-unpriced-models]')?.textContent).toContain('mystery-1');
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).not.toContain('—');
  });

  it('shows the incomplete notice when the server reports one', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({ defaulted: true, incompleteReason: 'session_cap', incompleteSessions: 4 }),
    );
    const { container } = await renderPage();
    expect(container.querySelector('[data-usage-reliability-toggle]')?.textContent).toContain('Some usage is unknown');
    await openReliability(container);
    expect(container.querySelector('[data-usage-incomplete]')?.textContent).toContain('session limit');
    expect(container.querySelector('[data-usage-incomplete]')?.textContent).toContain('4 sessions');
  });

  it('locates a deep-linked session in the sessions tab', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({
        defaulted: true,
        sessions: [
          { id: 's_1', title: 'Alpha session', cost: 1.5 },
          { id: 's_2', title: 'Beta session', cost: 0.5 },
        ],
      }),
    );
    const { container } = await renderPage('/usage?session=s_2');
    expect(container.textContent).toContain('Located session');
    expect(container.querySelector('[data-usage-session="s_2"]')).not.toBeNull();
    expect(container.querySelector('[data-usage-session="s_1"]')).toBeNull();
  });

  it('pages sessions with the server token and keeps the filters', async () => {
    let calls = 0;
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['page_size'] === 1) return usageResponse();
      calls += 1;
      return calls === 1
        ? usageResponse({ hasMore: true, nextPageToken: 'tok_2', sessions: [{ id: 's_1' }] })
        : usageResponse({ sessions: [{ id: 's_2' }] });
    });
    const { container } = await renderPage('/usage?range=this_week&view=sessions');
    const more = container.querySelector<HTMLButtonElement>('[data-usage-load-more]');
    expect(more).not.toBeNull();
    await act(async () => { more!.click(); });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    const pageTokens = getUsage.mock.calls
      .map(([query]) => (query as Record<string, unknown>)['page_token'])
      .filter((token) => token !== undefined);
    expect(pageTokens).toEqual(['tok_2']);
    expect(container.querySelector('[data-usage-session="s_2"]')).not.toBeNull();
  });

  it('auto-pages until a deep-linked session on a later page is found', async () => {
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['page_size'] === 1) return usageResponse();
      const token = query['page_token'];
      if (token === undefined) {
        return usageResponse({ hasMore: true, nextPageToken: 'tok_2', sessions: [{ id: 's_1' }] });
      }
      if (token === 'tok_2') {
        return usageResponse({ hasMore: true, nextPageToken: 'tok_3', sessions: [{ id: 's_2' }] });
      }
      return usageResponse({ sessions: [{ id: 's_3', title: 'Target session' }] });
    });
    const { container } = await renderPage('/usage?session=s_3');
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    const pageTokens = getUsage.mock.calls
      .map(([query]) => (query as Record<string, unknown>)['page_token'])
      .filter((token) => token !== undefined);
    expect(pageTokens).toEqual(['tok_2', 'tok_3']);
    // The target on the last page is located and the list filters to it.
    expect(container.querySelector('[data-usage-session="s_3"]')).not.toBeNull();
    expect(container.querySelector('[data-usage-session="s_1"]')).toBeNull();
    expect(container.textContent).toContain('Located session');
    expect(container.textContent).not.toContain('outside the current result set');
    expect(container.querySelector('[data-usage-locating]')).toBeNull();
  });

  it('reports not-in-page only after the locator walk exhausts every page', async () => {
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['page_size'] === 1) return usageResponse();
      const token = query['page_token'];
      if (token === undefined) {
        return usageResponse({ hasMore: true, nextPageToken: 'tok_2', sessions: [{ id: 's_1' }] });
      }
      return usageResponse({ sessions: [{ id: 's_2' }] });
    });
    const { container } = await renderPage('/usage?session=s_absent');
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    const pageTokens = getUsage.mock.calls
      .map(([query]) => (query as Record<string, unknown>)['page_token'])
      .filter((token) => token !== undefined);
    expect(pageTokens).toEqual(['tok_2']);
    // The exhausted walk says so in place instead of leaving a spinner.
    expect(container.querySelector('[data-usage-locating]')?.textContent)
      .toContain('outside the current result set');
  });

  it('reads the prior period only after the reader asks for it', async () => {
    getUsage.mockImplementation(async (query: Record<string, unknown>) =>
      query['start_at'] !== undefined
        ? usageResponse({ summaryCost: 1 })
        : usageResponse({ summaryCost: 3.25 }),
    );
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // Nothing but the current range has been read so far.
    expect(getUsage.mock.calls.every(([query]) => (query as Record<string, unknown>)['start_at'] === undefined)).toBe(true);
    expect(container.querySelector('[data-usage-compare="delta"]')).toBeNull();

    await act(async () => { container.querySelector<HTMLInputElement>('[data-usage-compare]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const priorCall = getUsage.mock.calls.find(([query]) => (query as Record<string, unknown>)['start_at'] !== undefined);
    expect(priorCall).toBeDefined();
    const query = priorCall![0] as Record<string, unknown>;
    const DAY = 86_400_000;
    // The prior window is the same seven-day span moved back by its own length,
    // asked for as an explicit range rather than a re-read of a preset.
    expect(query['range']).toBe('last_7_days');
    expect(Number(query['start_at'])).toBeGreaterThan(0);
    const priorLength = Number(query['end_at']) - Number(query['start_at']);
    expect(priorLength).toBeLessThan(7 * DAY);
    expect(priorLength).toBeGreaterThan(6 * DAY);
    const delta = container.querySelector('[data-usage-compare="delta"]');
    expect(delta).not.toBeNull();
    // No "−0%": a change that rounds to nothing is shown without a sign.
    expect(delta!.textContent).not.toContain('−0');
    expect(delta!.textContent).not.toContain('+0');
    expect(delta!.textContent).toContain('%');
    await act(async () => { root.unmount(); });
  });

  it('keeps the current period readable when the prior read fails', async () => {
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['start_at'] !== undefined) throw new Error('prior window unavailable');
      return usageResponse({ summaryCost: 3.25 });
    });
    const { container, root } = await renderPage('/usage?range=last_7_days&compare=previous');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The current totals and the source table stay readable.
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('3.25');
    expect(container.querySelector('[data-usage-breakdown-row="k2-thinking"]')).not.toBeNull();
    expect(container.querySelector('[data-usage-compare-error]')?.textContent).toContain('Prior usage could not be loaded');
    expect(container.querySelector('[data-usage-compare-error]')?.textContent).toContain('Retry comparison');
    // Nothing claims a growth number.
    expect(container.querySelector('[data-usage-compare="delta"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('refuses a comparison for unbounded all-history', async () => {
    const { container, root } = await renderPage('/usage?range=all');
    const toggle = container.querySelector<HTMLInputElement>('[data-usage-compare]')!;
    expect(toggle.disabled).toBe(true);
    expect(container.textContent).toContain('Comparison needs a bounded range');
    await act(async () => { root.unmount(); });
  });

  it('reads the native provider axis and filters a known source by its raw value', async () => {
    const { container, root } = await renderPage('/usage?group_by=provider');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ dimension: 'provider' });
    // The kimi row offers its exact filter, not its row key.
    const kimiRow = [...container.querySelectorAll<HTMLElement>('[data-usage-breakdown-row]')]
      .find((row) => row.textContent?.includes('kimi'))!;
    // The row key is the server's opaque identity, not the filter value.
    expect(kimiRow.dataset['usageBreakdownRow']?.startsWith('provider:')).toBe(true);
    await act(async () => { kimiRow.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => {
      kimiRow.querySelector<HTMLButtonElement>('[data-usage-source-filter]')!.click();
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ dimension: 'provider', provider: 'kimi' });
    expect(container.querySelector('[data-location-probe]')?.textContent).toContain('provider=kimi');
    expect(container.querySelector('[data-usage-filter-chip="provider"]')?.textContent).toContain('kimi');
    await act(async () => { root.unmount(); });
  });

  it('gives an unattributed source no filter and no sentinel query', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({
        trendGroups: [
          { key: 'k2-thinking', cost: 2.4, provider: 'kimi', profile: 'general' },
          { key: 'unknown', cost: 0.85 },
        ],
      }),
    );
    const { container, root } = await renderPage('/usage?group_by=provider');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const unknownRow = container.querySelector<HTMLElement>('[data-usage-breakdown-row="unknown"]')!;
    expect(unknownRow).not.toBeNull();
    await act(async () => { unknownRow.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    // The unknown row keeps its amount and explains why it has no filter.
    expect(container.querySelector('[data-usage-breakdown-cost="unknown"]')?.textContent).not.toContain('—');
    const detailsId = unknownRow.querySelector('button[aria-expanded]')!.getAttribute('aria-controls')!;
    expect(container.querySelector(`#${detailsId}`)?.textContent).toContain('no exact filter');
    expect(unknownRow.querySelector('[data-usage-source-filter]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('keeps the page filters when a source row only narrows its own axis', async () => {
    // The page is reading one provider. Following a model row must not drop
    // that provider and quietly widen the trace to every provider's sessions.
    const { container, root } = await renderPage('/usage?range=last_7_days&group_by=model&provider=kimi');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = container.querySelector<HTMLElement>('[data-usage-breakdown-row="k2-thinking"]')!;
    await act(async () => { row.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-usage-source-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trace = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    // The row's own axis narrows to its raw value; the page's provider stays,
    // so the trace cannot widen to the same model under another provider.
    expect(trace['model']).toBe('k2-thinking');
    expect(trace['provider']).toBe('kimi');
    // And the exact window, not the whole preset.
    expect(trace['range']).toBe('custom');
    expect(Number(trace['end_at']) - Number(trace['start_at'])).toBe(7 * 86_400_000);
    await act(async () => { root.unmount(); });
  });

  it('keeps every page filter for a provider axis trace, including agents and archive', async () => {
    const { container, root } = await renderPage(
      '/usage?range=last_7_days&group_by=provider&provider=anthropic&agent.id=agent-7&include_archived=false',
    );
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The provider row's key is an opaque identity; find the row by what it
    // displays rather than by re-escaping the server's key in a selector.
    const row = [...container.querySelectorAll<HTMLElement>('[data-usage-breakdown-row]')]
      .find((candidate) => candidate.textContent?.includes('kimi'))!;
    expect(row.dataset['usageBreakdownRow']?.startsWith('provider:')).toBe(true);
    await act(async () => { row.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-usage-source-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trace = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    // Provider axis: the row replaces the provider value...
    expect(trace['provider']).toBe('kimi');
    // ...and the agent scope, the archive flag and the window all survive.
    expect(trace['agent.id']).toEqual(['agent-7']);
    expect(trace['include_archived']).toBe('false');
    expect(trace['dimension']).toBe('provider');
    expect(trace['range']).toBe('custom');
    await act(async () => { root.unmount(); });
  });

  it('keeps the page profile and agent scope for a profile axis trace', async () => {
    const { container, root } = await renderPage(
      '/usage?range=last_7_days&group_by=profile&profile=explore&agent.id=agent-3',
    );
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = [...container.querySelectorAll<HTMLElement>('[data-usage-breakdown-row]')]
      .find((candidate) => candidate.textContent?.includes('explore'))!;
    expect(row.dataset['usageBreakdownRow']?.startsWith('profile:')).toBe(true);
    await act(async () => { row.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-usage-source-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trace = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(trace['dimension']).toBe('profile');
    expect(trace['profile']).toEqual(['explore']);
    expect(trace['agent.id']).toEqual(['agent-3']);
    await act(async () => { root.unmount(); });
  });

  it('keeps the page filters when the trace is opened without a row', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days&provider=kimi&model=k2-thinking');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-open-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trace = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    // No row means no narrowing: the trace is the page's own read.
    expect(trace['provider']).toBe('kimi');
    expect(trace['model']).toBe('k2-thinking');
    expect(trace['range']).toBe('custom');
    await act(async () => { root.unmount(); });
  });

  it('gives an unknown source row a trace that keeps the base scope and no sentinel', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({
        trendGroups: [
          { key: 'k2-thinking', cost: 2.4, provider: 'kimi', profile: 'general' },
          { key: 'unknown', cost: 0.85 },
        ],
      }),
    );
    const { container, root } = await renderPage('/usage?range=last_7_days&group_by=provider&provider=kimi');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const unknownRow = container.querySelector<HTMLElement>('[data-usage-breakdown-row="unknown"]')!;
    expect(unknownRow).not.toBeNull();
    await act(async () => { unknownRow.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => { unknownRow.querySelector<HTMLButtonElement>('[data-usage-source-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trace = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    // The unknown row has no raw value, so it keeps what the page already had
    // and never sends an "unknown" filter the API would ignore.
    expect(trace['provider']).toBe('kimi');
    expect(trace['provider']).not.toBe('unknown');
    expect(trace['profile']).toBeUndefined();
    await act(async () => { root.unmount(); });
  });

  it('opens the real record from the trace and comes back to the same period', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-open-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const sheet = [...document.body.querySelectorAll<HTMLElement>('[data-usage-session-panel]')].at(-1)!;
    const locate = sheet.querySelector<HTMLButtonElement>('[data-usage-trace-locate="s_1"]')!;
    await act(async () => { locate.click(); });
    // Locating expands the wire's own turn attribution for this window.
    const turn = sheet.querySelector<HTMLButtonElement>('[data-usage-trace-turn="1"]');
    expect(turn).not.toBeNull();
    await act(async () => { turn!.click(); });
    expect(container.querySelector('[data-location-probe]')?.textContent).toBe('/s/s_1?turn=1');
    await act(async () => { root.unmount(); });
  });

  it('says so when a period carries no turn attribution instead of faking one', async () => {
    // Two sessions, and the wire's turn attribution covers only one of them.
    getUsage.mockImplementation(async () =>
      usageResponse({ sessions: [{ id: 's_1' }, { id: 's_no_turns' }] }),
    );
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-open-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const sheet = [...document.body.querySelectorAll<HTMLElement>('[data-usage-session-panel]')].at(-1)!;
    // The attributed session offers real turn locators.
    const attributed = sheet.querySelector<HTMLButtonElement>('[data-usage-trace-locate="s_1"]')!;
    await act(async () => { attributed.click(); });
    expect(attributed.closest('li')!.querySelector('[data-usage-trace-turns]')).not.toBeNull();

    // The one without attribution says so, instead of a locator that would
    // land nowhere.
    const unattributed = sheet.querySelector<HTMLButtonElement>('[data-usage-trace-locate="s_no_turns"]')!;
    await act(async () => { unattributed.click(); });
    const row = unattributed.closest('li')!;
    expect(row.querySelector('[data-usage-trace-turns]')).toBeNull();
    expect(row.querySelector('[data-usage-trace-no-turns]')?.textContent).toContain('Open the session');
    await act(async () => { root.unmount(); });
  });

  it('does not reuse the today summary for a model-filtered read', async () => {
    const { container, root } = await renderPage('/usage?model=k2-thinking');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // A summary narrowed to one model is not "all of today", so opening the
    // strip reads on its own instead of borrowing the main result.
    await openLiveStrip(container);
    const strip = getUsage.mock.calls.find(([query]) => (query as Record<string, unknown>)['page_size'] === 1);
    expect(strip).toBeDefined();
    expect((strip![0] as Record<string, unknown>)['model']).toBeUndefined();
    expect(container.querySelector('[data-usage-strip-tokens]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('still reuses the today summary for a grouped but unscoped read', async () => {
    const { container, root } = await renderPage('/usage?group_by=profile&granularity=day');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // Grouping and granularity do not narrow records, so one request serves both
    // and opening the strip issues none.
    await openLiveStrip(container);
    expect(getUsage.mock.calls.filter(([query]) => (query as Record<string, unknown>)['page_size'] === 1)).toHaveLength(0);
    expect(container.querySelector('[data-usage-strip-tokens]')?.textContent).toContain('3.25');
    await act(async () => { root.unmount(); });
  });

  it('opens the session trace on request and scopes it to the selected period', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const panelsBefore = document.body.querySelectorAll('[data-usage-session-panel]').length;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-open-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The trace opens as a side sheet, which portals outside the page tree.
    expect(document.body.querySelectorAll('[data-usage-session-panel]')).toHaveLength(panelsBefore + 1);
    const traceCall = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    // An explicit [A,B) custom window, so the sessions behind the number are
    // the ones that produced it rather than a whole preset re-read.
    expect(traceCall['range']).toBe('custom');
    expect(Number(traceCall['start_at'])).toBeGreaterThan(0);
    expect(Number(traceCall['end_at']) - Number(traceCall['start_at'])).toBe(7 * 86_400_000);
    await act(async () => { root.unmount(); });
  });

  it('keeps the source search local: totals and the chart do not change', async () => {
    const { container, root } = await renderPage();
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const headline = container.querySelector('[data-usage-summary-cost]')?.textContent;
    const callsBefore = getUsage.mock.calls.length;
    const search = container.querySelector<HTMLInputElement>('[data-usage-source-search]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'zzz-no-such-source');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-usage-source-empty]')?.textContent).toContain('No source matches');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toBe(headline);
    expect(getUsage.mock.calls.length).toBe(callsBefore);
    await act(async () => { root.unmount(); });
  });

  it('changes one axis at a time and keeps the range and filters', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days&workspace=wd_1');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-grouping="provider"]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ dimension: 'provider', range: 'last_7_days', 'workspace.id': 'wd_1' });
    // Only one axis is ever listed at a time.
    expect(container.querySelectorAll('[data-usage-sources]')).toHaveLength(1);
    expect(container.querySelector('[data-usage-sources="provider"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('persists an explicit range selection for URL revisits', async () => {
    await renderPage('/usage?range=this_month');
    const stored = localStorage.getItem(USAGE_FILTERS_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject({ range: 'this_month' });
  });

  it('switches detail tabs and offers the 5h granularity from the rhythm tab', async () => {
    const { container } = await renderPage('/usage?granularity=day');
    const rhythm = container.querySelector<HTMLButtonElement>('[data-usage-tab="fiveHour"]');
    expect(rhythm).not.toBeNull();
    await act(async () => { rhythm!.click(); });
    expect(container.querySelector('[data-usage-fivehour-hint]')).not.toBeNull();
    const switcher = container.querySelector<HTMLButtonElement>(
      '[data-usage-fivehour-hint] button',
    );
    await act(async () => { switcher!.click(); });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ granularity: 'five_hour' });
  });

  it.each(['agent', 'session'])(
    'restores the advanced breakdown tab directly from ?view=breakdown&dimension=%s',
    async (dimension) => {
      const { container } = await renderPage(`/usage?view=breakdown&dimension=${dimension}`);
      expect(mainCalls()[0]?.[0]).toMatchObject({ dimension });
      const breakdownTab = container.querySelector('[data-usage-tab="breakdown"]');
      expect(breakdownTab?.getAttribute('aria-selected')).toBe('true');
      // The breakdown view is on screen, not the sessions list.
      expect(container.querySelector('[data-usage-sessions]')).toBeNull();
      expect(container.textContent).toContain('k2-thinking');
    },
  );

  it.each(['model', 'provider', 'profile'])(
    'reads ?dimension=%s as the source axis, not the agent tree',
    async (dimension) => {
      const { container } = await renderPage(`/usage?dimension=${dimension}`);
      expect(mainCalls()[0]?.[0]).toMatchObject({ dimension });
      // The axis is on screen as the source table, with no advanced tab.
      expect(container.querySelector(`[data-usage-sources="${dimension}"]`)).not.toBeNull();
      expect(container.querySelector('[data-usage-tab="breakdown"]')).toBeNull();
      expect(container.textContent).toContain('k2-thinking');
    },
  );

  it('writes the detail tab into the URL so the view is shareable', async () => {
    const { container } = await renderPage('/usage?dimension=agent');
    // A bare advanced-dimension link still opens on the source table.
    expect(
      container.querySelector('[data-usage-tab="sources"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    const probe = () => container.querySelector('[data-location-probe]')?.textContent ?? '';
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-tab="breakdown"]')!.click();
    });
    expect(probe()).toContain('view=breakdown');
    expect(probe()).toContain('dimension=agent');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-tab="fiveHour"]')!.click();
    });
    expect(probe()).toContain('view=five_hour');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-tab="sessions"]')!.click();
    });
    expect(probe()).toContain('view=sessions');
    expect(probe()).toContain('dimension=agent');
  });

  it('renders the 5h rhythm tab with per-window session and turn detail', async () => {
    const { container } = await renderPage('/usage?view=five_hour&granularity=five_hour');
    expect(
      container.querySelector('[data-usage-tab="fiveHour"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    const view = container.querySelector('[data-usage-fivehour]');
    expect(view).not.toBeNull();
    expect(view!.querySelector('[data-usage-fivehour-window]')).not.toBeNull();
    // The seeded bucket drilldown renders the session and its turn locators.
    expect(view!.textContent).toContain('s_1');
    expect(view!.querySelector('[data-usage-turn="1"]')).not.toBeNull();
    expect(view!.querySelector('[data-usage-turn="2"]')).not.toBeNull();
    expect(view!.textContent).toContain('2 turns');
  });

  it('turn locators navigate to the session at the turn', async () => {
    const { container } = await renderPage('/usage?view=five_hour&granularity=five_hour');
    const probe = () => container.querySelector('[data-location-probe]')?.textContent ?? '';
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-turn="2"]')!.click();
    });
    expect(probe()).toBe('/s/s_1?turn=2');
  });

  it('scopes the source table to a selected bar and leaves the headline total alone', async () => {
    const { container } = await renderPage();
    const headline = container.querySelector('[data-usage-summary-cost]')?.textContent;
    expect(container.querySelector('[data-usage-source-scope]')?.textContent).toContain('the whole range');
    expect(container.querySelector('[data-usage-drilldown]')).toBeNull();
    const tracesBefore = document.body.querySelectorAll('[data-usage-session-panel]').length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!.click();
    });
    // The period title and its own clear action appear; the cost headline and
    // the bar selection both survive.
    expect(container.querySelector('[data-usage-source-scope]')?.textContent).toContain('Selected period');
    expect(container.querySelector('[data-usage-clear-bucket]')).not.toBeNull();
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toBe(headline);
    // Selecting a bar never opens a session trace on its own.
    expect(document.body.querySelectorAll('[data-usage-session-panel]')).toHaveLength(tracesBefore);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-clear-bucket]')!.click(); });
    expect(container.querySelector('[data-usage-source-scope]')?.textContent).toContain('the whole range');
  });

  it('keeps the bar selection in the URL and in the visit snapshot', async () => {
    const { container } = await renderPage();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!.click();
    });
    expect(container.querySelector('[data-location-probe]')?.textContent).toMatch(/bucket=\d+/);
  });

  it('rejects an inverted custom date range locally instead of querying', async () => {
    const startAt = new Date(2026, 7, 20).getTime();
    const endAt = new Date(2026, 7, 26).getTime();
    const { container } = await renderPage(
      `/usage?range=custom&start_at=${startAt}&end_at=${endAt}`,
    );
    const endInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="End date"]',
    );
    const startInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Start date"]',
    );
    expect(endInput).not.toBeNull();
    // Mutual constraints keep the picker from forming an inverted pair.
    expect(endInput!.min).toBe('2026-08-20');
    expect(startInput!.max).toBe('2026-08-25');

    const setDateValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // An end before the start is blocked: field-level error, no new query.
    const callsBefore = mainCalls().length;
    await act(async () => { setDateValue(endInput!, '2026-08-19'); });
    expect(container.querySelector('[data-usage-range-error]')?.textContent).toContain(
      'earlier than the end date',
    );
    expect(endInput!.getAttribute('aria-invalid')).toBe('true');
    expect(mainCalls().length).toBe(callsBefore);

    // A valid end clears the error and issues the query with the new bounds.
    await act(async () => { setDateValue(endInput!, '2026-08-27'); });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(container.querySelector('[data-usage-range-error]')).toBeNull();
    const last = mainCalls().at(-1)?.[0] as Record<string, unknown>;
    expect(last['range']).toBe('custom');
    expect(last['end_at']).toBe(new Date(2026, 7, 28).getTime());
  });
});

describe('UsagePage manual full rescan', () => {
  it('moves the same rescan control between rows based on available space without squeezing the range', async () => {
    let width = 1104;
    let rangeWidth = 520;
    let measure = () => {};
    const originalObserver = globalThis.ResizeObserver;
    const disconnect = vi.fn();
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, this.querySelector('[data-axis="range"]') ? rangeWidth : 220, 32);
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { measure = callback; }
      observe() {}
      disconnect = disconnect;
    });
    try {
      getUsageRescan.mockResolvedValue({ state: 'running', scanned_sessions: 3, total_sessions: 10, scanned_records: 900, started_at: 1, finished_at: null, error: null });
      const { container, root } = await renderPage();
      const filter = container.querySelector<HTMLElement>('[data-usage-filters]')!;
      const button = container.querySelector('[data-usage-rescan-start]');
      const progress = container.querySelector('progress');
      expect(filter.dataset['actionsRow']).toBe('range');
      width = 700;
      await act(async () => { measure(); });
      expect(filter.dataset['actionsRow']).toBe('secondary');
      width = 1104;
      rangeWidth = 940;
      await act(async () => { measure(); });
      expect(filter.dataset['actionsRow']).toBe('secondary');
      rangeWidth = 520;
      await act(async () => { measure(); });
      expect(filter.dataset['actionsRow']).toBe('range');
      expect(container.querySelector('[data-usage-rescan-start]')).toBe(button);
      expect(container.querySelector('progress')).toBe(progress);
      expect(getUsageRescan).toHaveBeenCalledTimes(1);
      await act(async () => { root.unmount(); });
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      clientWidth.mockRestore();
      bounds.mockRestore();
      vi.stubGlobal('ResizeObserver', originalObserver);
    }
  });

  it('places the action beside archived sessions without a standalone hint', async () => {
    const { container, root } = await renderPage();
    const control = container.querySelector('[data-usage-filters] [data-usage-rescan]')!;
    expect(control.querySelector('[role="switch"]')).not.toBeNull();
    expect(control.querySelector('[data-usage-rescan-start]')?.textContent).toBe('Rescan all');
    expect(container.querySelectorAll('[data-usage-rescan-start]')).toHaveLength(1);
    expect(container.textContent).not.toContain('this may take a while');
    await act(async () => { root.unmount(); });
  });

  it('starts without a confirmation, polls progress and refreshes history on completion', async () => {
    vi.useFakeTimers();
    try {
      const running = { state: 'running', scanned_sessions: 3, total_sessions: 10, scanned_records: 900, started_at: 1, finished_at: null, error: null };
      startUsageRescan.mockResolvedValue(running);
      const { container, root } = await renderPage('/usage?panel=history', { flush: false });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const button = container.querySelector<HTMLButtonElement>('[data-usage-rescan-start]')!;
      expect(button.title).toContain('all historical');
      await act(async () => { button.click(); });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(startUsageRescan).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Rescanning…');
      expect(container.querySelector('[data-usage-filters] progress')?.getAttribute('value')).toBe('3');
      expect(container.querySelector('progress')?.max).toBe(10);
      expect(container.textContent).toContain('3/10 sessions');
      expect(container.textContent).not.toContain('900 records read');
      expect(container.querySelector('[data-usage-rescan] [role="status"]')?.getAttribute('title')).toBe('900 records read');
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      const beforeCompletion = mainCalls().length;
      getUsageRescan.mockResolvedValue({ ...running, state: 'completed', scanned_sessions: 10, finished_at: 2 });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(container.textContent).toContain('Rescanned 10 sessions');
      expect(container.querySelector('progress')).toBeNull();
      expect(button.disabled).toBe(false);
      expect(mainCalls().length).toBeGreaterThan(beforeCompletion);
      const statusCalls = getUsageRescan.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(getUsageRescan).toHaveBeenCalledTimes(statusCalls);
      await act(async () => { root.unmount(); });
    } finally { vi.useRealTimers(); }
  });

  it('shows a human failure message without raw diagnostics and allows another attempt', async () => {
    getUsageRescan.mockResolvedValue({ state: 'failed', scanned_sessions: 2, total_sessions: 5, scanned_records: 12, started_at: 1, finished_at: 2, error: 'Checkpoint unavailable for instance-example' });
    const { container, root } = await renderPage();
    expect(container.querySelector('[data-usage-rescan] [role="alert"]')?.textContent).toBe('Rescan failed. Try again.');
    expect(container.textContent).not.toContain('Checkpoint');
    expect(container.textContent).not.toContain('instance-example');
    expect(container.querySelector<HTMLButtonElement>('[data-usage-rescan-start]')?.disabled).toBe(false);
    await act(async () => { root.unmount(); });
  });

  it('recovers an unavailable progress request without claiming the rescan failed', async () => {
    vi.useFakeTimers();
    try {
      getUsageRescan.mockRejectedValueOnce(new Error('Connection unavailable'));
      const { container, root } = await renderPage('/usage?panel=history', { flush: false });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const alert = container.querySelector('[data-usage-rescan] [role="alert"]')?.textContent;
      expect(alert).toBe('Progress unavailable. Reconnecting…');
      expect(alert).not.toContain('Rescan failed');
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(getUsageRescan).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-usage-rescan] [role="alert"]')).toBeNull();
      await act(async () => { root.unmount(); });
    } finally { vi.useRealTimers(); }
  });

  it('does not mount the history action on live governance panels', async () => {
    const { container, root } = await renderPage('/usage?panel=realtime');
    expect(container.querySelector('[data-usage-rescan]')).toBeNull();
    expect(getUsageRescan).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});

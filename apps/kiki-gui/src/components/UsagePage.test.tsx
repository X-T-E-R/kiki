// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import { ApiError } from '../lib/client';
import { USAGE_FILTERS_STORAGE_KEY, type UsageResponseWire } from '../lib/usageV2';
import { UsagePage } from './UsagePage';
import { usagePanelFromSearch } from './UsageNavigation';
import { detectActiveAnchors, resolveAnchorElement } from './discovery/DiscoveryContext';
import { subscribeUsageFreshness } from '../lib/usageFreshness';
import { writeLastSessionId } from '@kiki/session-core/settings';
import { configureSpaceStorage } from '@kiki/session-core/storage';
import type { Klient } from '@kiki/klient';

const containers: HTMLDivElement[] = [];
const mounted: { root: ReturnType<typeof createRoot>; queryClient: QueryClient }[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root, queryClient } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    queryClient.clear();
  }
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
const listWorkspaceCatalog = vi.fn();
const getRequestGovernance = vi.fn().mockResolvedValue({ domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 1, asOf: '2026-01-01T12:00:00Z', active: 3, queued: 2, coverage: { native: 'managed', external: 'unmanaged' }, dimensions: [], rules: [], waiting: [] });
const setRequestGovernanceRules = vi.fn().mockResolvedValue({});
const listModels = vi.fn().mockResolvedValue({ items: [] });
const listProviders = vi.fn().mockResolvedValue({ items: [] });
const listNamedAgentProfiles = vi.fn().mockResolvedValue({ items: [] });
const getUsagePricing = vi.fn().mockResolvedValue({ items: [] });
const getProviderQuotas = vi.fn().mockResolvedValue({ generated_at: '2026-01-01T00:00:00Z', sources: [] });

let currentScopeId = 'test-domain';

vi.mock('../state/connection', () => ({
  useOptionalConnection: () => undefined,
  // `klient` without the export route: the export view renders its own
  // "not offered by this server" state when a test opens it.
  useConnection: () => ({ scopeId: currentScopeId, wsStatus: 'open', klient: {}, meta: {}, config: { url: '' }, sshLabel: null, client: { getUsage, getUsageRescan, startUsageRescan, getSession, listWorkspaces, listWorkspaceCatalog, getRequestGovernance, setRequestGovernanceRules, listModels, listProviders, listNamedAgentProfiles, getUsagePricing, getProviderQuotas } }),
}));

function tokens(inputOther: number, cacheRead = 0) {
  return {
    input_other: inputOther,
    output: Math.round(inputOther / 10),
    input_cache_read: cacheRead,
    input_cache_creation: 0,
  };
}

type UsageImportProgress = {
  verified_sources: number;
  total_sources: number;
  read_bytes: number;
  total_bytes: number;
};

type UsageResponseFixture = Omit<UsageResponseWire, 'reliability'> & {
  reliability: UsageResponseWire['reliability'] & { import_progress?: UsageImportProgress };
};

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
  rangeStartAt?: number | null;
  rangeEndAt?: number | null;
  rangePreset?: UsageResponseWire['query']['range']['preset'];
  trendBuckets?: UsageResponseWire['trend'];
  importProgress?: UsageImportProgress;
} = {}): UsageResponseFixture {
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
        preset: overrides.rangePreset ?? 'all',
        start_at: overrides.rangeStartAt ?? null,
        end_at: overrides.rangeEndAt ?? null,
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
    trend: overrides.trendBuckets ?? [
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
      import_progress: overrides.importProgress,
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <span data-location-probe data-location-hash={location.hash}>{`${location.pathname}${location.search}`}</span>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function renderPage(entry = '/usage?panel=history', options: { flush?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  mounted.push({ root, queryClient });
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

async function openCalendar(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>('[data-usage-custom-range-trigger]')!;
  expect(trigger).not.toBeNull();
  if (document.body.querySelector('[data-usage-calendar-popover]') === null) {
    await act(async () => { trigger.click(); });
  }
  const popover = document.body.querySelector<HTMLElement>('[data-usage-calendar-popover]')!;
  expect(popover).not.toBeNull();
  return popover;
}

async function openReliability(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>('[data-usage-reliability-toggle]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.body.querySelector('[data-usage-reliability]')).toBeNull();
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(document.body.querySelector('[data-usage-reliability]')?.id).toBe(toggle.getAttribute('aria-controls'));
}

/** Calls to the main paged query (it requests the 25-row session page). */
function mainCalls() {
  return getUsage.mock.calls.filter(
    ([query]) => (query as Record<string, unknown>)['page_size'] === 25,
  );
}

beforeEach(() => {
  currentScopeId = 'test-domain';
  configureSpaceStorage(null);
  localStorage.clear();
  getUsage.mockReset();
  getUsageRescan.mockReset();
  startUsageRescan.mockReset();
  getUsageRescan.mockResolvedValue({ state: 'idle', scanned_sessions: 0, total_sessions: 0, scanned_records: 0, started_at: null, finished_at: null, error: null });
  getSession.mockReset();
  listWorkspaces.mockReset();
  listWorkspaceCatalog.mockReset();
  getRequestGovernance.mockClear();
  listModels.mockClear();
  listProviders.mockClear();
  listNamedAgentProfiles.mockReset();
  listNamedAgentProfiles.mockResolvedValue({ items: [] });
  getUsagePricing.mockReset();
  getUsagePricing.mockResolvedValue({ items: [] });
  getProviderQuotas.mockReset();
  getProviderQuotas.mockResolvedValue({ generated_at: '2026-01-01T00:00:00Z', sources: [] });
  getUsage.mockImplementation(async (query: Record<string, unknown>) =>
    usageResponse({ defaulted: query['range'] === undefined }),
  );
  getSession.mockRejectedValue(new Error('no session'));
  listWorkspaces.mockResolvedValue({ items: [{ id: 'wd_1', name: 'Workspace One' }] });
  listWorkspaceCatalog.mockResolvedValue({ items: [{ id: 'wd_1', name: 'Workspace One', root: '/path/wd_1', created_at: 0, last_opened_at: 0, pinned: false }] });
});

describe('UsagePage (V2)', () => {
  it('opens today with one primary usage request and no cross-tab strip, session, or quota reads', async () => {
    let complete!: (response: UsageResponseWire) => void;
    getUsage.mockImplementation(() => new Promise<UsageResponseWire>((resolve) => { complete = resolve; }));
    const { container, root, queryClient } = await renderPage('/usage?panel=history', { flush: false });
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getUsage.mock.calls[0]?.[0]).toMatchObject({ range: 'today', page_size: 25 });
    expect(getUsage.mock.calls[0]?.[1]).toEqual({ signal: expect.any(AbortSignal) });
    expect(container.querySelector('[data-usage-summary-cost]')).toBeNull();
    await act(async () => { complete(usageResponse({ summaryCost: 8.75 })); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
    expect(getProviderQuotas).not.toHaveBeenCalled();
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('8.75');
    expect(container.querySelector('[data-usage-quota-strip]')).toBeNull();
    expect(container.querySelector('[data-usage-strip]')).toBeNull();
    await act(async () => { root.unmount(); });
    queryClient.clear();
  });

  it.each([
    ['en', 'Counting 2/5'],
    ['zh', '统计中 2/5'],
  ])('shows the localized counting progress instead of zeroes for an empty partial scan (%s)', async (locale, counting) => {
    localStorage.setItem('kiki.locale', locale);
    getUsage.mockResolvedValue(usageResponse({
      summaryTokens: tokens(0),
      summaryCost: 0,
      incompleteReason: 'deadline',
      importProgress: { verified_sources: 2, total_sources: 5, read_bytes: 2048, total_bytes: 4096 },
    }));
    const { container, root } = await renderPage('/usage?panel=history');
    expect(container.querySelector('[data-usage-scan-counting]')?.textContent).toContain(counting);
    expect(container.querySelector('[data-usage-scan-bytes]')?.textContent).toBe('2.0 KB / 4.0 KB');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toBe('—');
    await act(async () => { root.unmount(); });
  });

  it('keeps the legacy partial counting label when import progress is unavailable', async () => {
    getUsage.mockResolvedValue(usageResponse({
      summaryTokens: tokens(0),
      summaryCost: 0,
      incompleteReason: 'deadline',
    }));
    const { container, root } = await renderPage('/usage?panel=history');
    expect(container.querySelector('[data-usage-scan-counting]')?.textContent).toBe('Counting…');
    expect(container.querySelector('[data-usage-scan-bytes]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('removes the pending progress pill after a partial scan completes', async () => {
    let mainCallsCount = 0;
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['page_size'] === 25) {
        mainCallsCount += 1;
        return mainCallsCount === 1
          ? usageResponse({ incompleteReason: 'deadline', importProgress: { verified_sources: 4, total_sources: 9, read_bytes: 4096, total_bytes: 9216 } })
          : usageResponse();
      }
      return usageResponse();
    });
    const { container, root } = await renderPage('/usage?panel=history');
    expect(container.querySelector('[data-usage-scan-counting]')?.textContent).toContain('Counting 4/9');
    expect(container.querySelector('[data-usage-scan-bytes]')?.textContent).toBe('4.0 KB / 9.0 KB');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-usage-scan-pending]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('recovers an initial failure without starting competing secondary requests', async () => {
    getUsage.mockRejectedValueOnce(new Error('usage read unavailable')).mockResolvedValue(usageResponse({ summaryCost: 2.5 }));
    const { container, root, queryClient } = await renderPage('/usage?panel=history');
    expect(getUsage).toHaveBeenCalledTimes(1);
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reload')!;
    expect(container.textContent).toContain('Your time range and filters are kept');
    expect(container.textContent).not.toContain('usage read unavailable');
    expect(retry).toBeDefined();
    await act(async () => { retry.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getUsage).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('2.50');
    await act(async () => { root.unmount(); });
    queryClient.clear();
  });
  it.each(['today', 'last_7_days', 'custom&start_at=1790467200000&end_at=1793059200000'])(
    'continues a bounded partial %s query until the complete total arrives without cancelling it',
    async (range) => {
      let complete!: (response: UsageResponseWire) => void;
      let signal: AbortSignal | undefined;
      getUsage.mockResolvedValueOnce(usageResponse({ incompleteReason: 'record_budget', summaryCost: 1.25 }))
        .mockImplementationOnce((_query, options) => {
          signal = options.signal;
          return new Promise<UsageResponseWire>((resolve) => { complete = resolve; });
        })
        .mockResolvedValue(usageResponse({ summaryCost: 8.5 }));
      const { container } = await renderPage(`/usage?panel=history&range=${range}`);
      expect(container.querySelector('[data-usage-scan-pending]')).not.toBeNull();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(mainCalls()).toHaveLength(2);
      expect(mainCalls()[1]?.[0]).toEqual(mainCalls()[0]?.[0]);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(signal?.aborted).toBe(false);
      expect(mainCalls()).toHaveLength(2);
      await act(async () => { complete(usageResponse({ summaryCost: 8.5 })); });
      for (let index = 0; index < 5; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(container.querySelector('[data-usage-scan-pending]')).toBeNull();
      expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('8.50');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(mainCalls()).toHaveLength(2);
    },
  );

  it('does not retry an unadvanceable session cap automatically', async () => {
    getUsage.mockResolvedValue(usageResponse({ incompleteReason: 'session_cap' }));
    await renderPage('/usage?panel=history&range=last_7_days');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(mainCalls()).toHaveLength(1);
  });

  it('refreshes the current dashboard automatically on settled usage', async () => {
    writeLastSessionId('usage-session');
    let cost = 3.25;
    getUsage.mockImplementation(async () => usageResponse({ summaryCost: cost }));
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
    cost = 7.5;
    await act(async () => { notify({ sessionId: 'usage-session', agentId: 'main' }); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toContain('7.50');
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

  it('opens Live when no panel is given, with Usage and Quotas as the other views', async () => {
    const { container, root } = await renderPage('/usage');
    expect([...container.querySelectorAll<HTMLElement>('[data-usage-panel]')].map((node) => node.dataset['usagePanel'])).toEqual(['realtime', 'history', 'quota']);
    expect([...container.querySelectorAll<HTMLElement>('[data-usage-panel]')].map((node) => node.textContent)).toEqual(['Live', 'Usage', 'Quotas']);
    expect(container.querySelector('header h1')?.textContent).toBe('Activity');
    expect(container.querySelector('[data-usage-panel="realtime"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[data-request-governance]')).not.toBeNull();
    expect(container.querySelector('[data-usage-filters]')).toBeNull();
    expect(mainCalls()).toHaveLength(0);
    await act(async () => { root.unmount(); });
  });

  it('reaches model prices and export from the header ⋯ instead of the tab strip', async () => {
    getUsage.mockImplementation(async () => usageResponse({ unknownPriceModels: ['mystery-9'] }));
    const { container, root } = await renderPage('/usage?panel=history');
    await act(async () => { container.querySelector<HTMLButtonElement>('header [data-usage-more]')!.click(); });
    const menu = document.querySelector('[data-usage-more-menu][role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['Model prices (1 missing)', 'Export']);
    await act(async () => { items[1]!.click(); });
    expect(container.querySelector('[data-location-probe]')?.textContent).toBe('/usage?panel=export');
    // Export is a view without a tab: no tab claims to be current.
    expect(container.querySelector('[data-usage-panel][aria-current="page"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('keeps historical reads out of the Live view and reads no rule catalogs until the inline editor is opened when rules are empty', async () => {
    const { container, root } = await renderPage('/usage?panel=realtime');
    expect(container.querySelector('[data-usage-panel="realtime"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-usage-filters]')).toBeNull();
    expect(resolveAnchorElement('usage-filter')).toBeNull();
    expect(mainCalls()).toHaveLength(0);
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(listWorkspaceCatalog).not.toHaveBeenCalled();
    expect(container.querySelector('[data-governance-rules-summary]')).not.toBeNull();
    expect(container.querySelector('[data-governance-rules]')).toBeNull();
    expect(listModels).not.toHaveBeenCalled();
    expect(listProviders).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-manage]')!.click(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-governance-empty]')).not.toBeNull();
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
    expect(container.querySelector('[data-usage-rescan]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-panel="history"]')!.click(); });
    expect(container.querySelector('[data-location-probe]')?.textContent).toBe('/usage?panel=history');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().length).toBeGreaterThan(0);
    await openReliability(container);
    await act(async () => { root.unmount(); });
  });

  it('exposes the history filter bar as the discovery tour usage-filter anchor', async () => {
    const { container, root } = await renderPage('/usage?panel=history');
    const filters = container.querySelector('[data-usage-filters]');
    expect(filters).not.toBeNull();
    expect(resolveAnchorElement('usage-filter')).toBe(filters);
    expect(detectActiveAnchors()).toContain('usage-filter');
    await act(async () => { root.unmount(); });
  });

  it.each([
    ['/usage?panel=history', 'history'],
    ['/usage?panel=realtime', 'realtime'],
    ['/usage?panel=limits', 'realtime'],
    ['/usage?panel=quota', 'quota'],
    ['/usage?panel=export', 'export'],
    ['/usage?range=last_7_days', 'history'],
    ['/usage?session=s_1', 'history'],
    ['/usage?view=sessions', 'history'],
    ['/usage?metric=tokens', 'history'],
    ['/usage?unrelated=state', 'realtime'],
    ['/usage', 'realtime'],
  ] as const)('resolves %s to the %s panel', (search, expected) => {
    expect(usagePanelFromSearch(search.slice('/usage'.length))).toBe(expected);
  });

  it('keeps panel=history explicit when clearing a deep-linked history parameter back to default', async () => {
    const { container, root } = await renderPage('/usage?metric=cost');
    expect(container.querySelector('[data-usage-panel="history"]')?.getAttribute('aria-current')).toBe('page');
    const tokensButton = container.querySelector<HTMLButtonElement>('button[data-trend-metric="tokens"]');
    expect(tokensButton).not.toBeNull();
    await act(async () => { tokensButton!.click(); });
    expect(container.querySelector('[data-location-probe]')?.textContent).toBe('/usage?panel=history');
    expect(container.querySelector('[data-usage-panel="history"]')?.getAttribute('aria-current')).toBe('page');
    await act(async () => { root.unmount(); });
  });

  it('does not start historical queries or locator paging on an explicit realtime link', async () => {
    getUsage.mockImplementation(async () => usageResponse({ hasMore: true, nextPageToken: 'tok_2' }));
    const { container, root } = await renderPage('/usage?panel=realtime&range=all&view=sessions&session=s_later');
    expect(container.querySelector('[data-usage-panel="realtime"]')?.getAttribute('aria-current')).toBe('page');
    expect(mainCalls()).toHaveLength(0);
    expect(getUsage).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(listWorkspaceCatalog).not.toHaveBeenCalled();
    // The rule editor stays folded on Live, and the disabled historical filter
    // observers must not read the catalogs either.
    expect(listModels).not.toHaveBeenCalled();
    expect(listProviders).not.toHaveBeenCalled();
    expect(container.querySelector('[data-usage-locating]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('aborts an in-flight history read when leaving the history panel', async () => {
    const signals: AbortSignal[] = [];
    getUsage.mockImplementation((_query: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      return new Promise<UsageResponseWire>(() => {});
    });
    const { container, root } = await renderPage('/usage?panel=history', { flush: false });
    expect(signals).toHaveLength(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-panel="realtime"]')!.click();
      await Promise.resolve();
    });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it('aborts the superseded history read when filters change', async () => {
    const signals: AbortSignal[] = [];
    getUsage.mockImplementation((_query: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      return new Promise<UsageResponseWire>(() => {});
    });
    const { container, root } = await renderPage('/usage?panel=history&range=last_7_days', { flush: false });
    expect(signals).toHaveLength(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-axis="range"] [data-axis-value="this_month"]')!.click();
      await Promise.resolve();
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it('renders ProviderQuotaPanel when panel=quota', async () => {
    const { container, root } = await renderPage('/usage?panel=quota');
    expect(container.querySelector('[data-usage-panel="quota"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[data-provider-quota-panel]')).not.toBeNull();
    expect(container.querySelector('[data-request-governance]')).toBeNull();
    expect(container.querySelector('[data-usage-filters]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it.each(['realtime', 'limits'] as const)('preserves the %s deep link in the combined Live tab and opens #usage-limits inline for limits', async (panel) => {
    const { container, root } = await renderPage(`/usage?panel=${panel}`);
    expect(container.querySelector('[data-usage-panel="realtime"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-rules-summary]')).not.toBeNull();
    expect(container.querySelector('[data-governance-rules]') !== null).toBe(panel === 'limits');
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
      granularity: 'hour',
      range: 'today',
      dimension: 'model',
    });
    expect(container.querySelector('[data-usage-all-history]')).toBeNull();
    await openReliability(container);
    expect(document.body.querySelector('[data-usage-reliability]')?.textContent).toContain('Deleted sessions are not included');
  });

  it('keeps explicit all-history URL semantics without an all-history defensive banner', async () => {
    const { container } = await renderPage('/usage?range=all');
    const main = mainCalls();
    expect(main[0]?.[0]).toMatchObject({ granularity: 'week', dimension: 'model' });
    expect((main[0]?.[0] as Record<string, unknown>)['range']).toBeUndefined();
    expect(container.querySelector('[data-usage-all-history]')).toBeNull();
    expect(container.textContent).not.toContain('no time filter applied');
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
      granularity: 'hour',
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
      '/usage?granularity=day&range=last_7_days&dimension=agent&workspace=wd_1&include_archived=false',
    );
    expect(mainCalls()[0]?.[0]).toMatchObject({
      granularity: 'day',
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
    ['en', 'Partial', 'Rescan all'],
    ['zh', '部分统计', '全量重扫'],
  ])('keeps the reliability status as a compact icon button and popover in %s', async (locale, label, action) => {
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
    expect(toggle.textContent).toBe('');
    expect(toggle.getAttribute('aria-label')).toContain(label);
    expect(container.querySelector('[data-usage-filters] [data-usage-rescan-start]')).toBeNull();
    expect(container.textContent).not.toContain('example-model-a');
    expect(container.querySelector('[data-usage-incomplete]')).toBeNull();
    expect(container.querySelector('[data-usage-accounting-missing]')).toBeNull();
    expect(container.querySelector('[data-usage-accounting-notices]')).toBeNull();
    await openReliability(container);
    expect(document.body.querySelector('[data-usage-reliability] [data-usage-rescan-start]')?.textContent).toBe(action);
    expect(document.body.querySelector('[data-usage-unpriced-models]')?.textContent).toContain('example-model-a');
    expect(document.body.querySelector('[data-usage-incomplete]')).toBeNull();
    expect(document.body.querySelector('[data-usage-accounting-missing]')).not.toBeNull();
    expect(document.body.querySelector('[data-usage-reliability] [data-usage-accounting-known-subtotal]')).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('[data-usage-reliability]')).toBeNull();
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
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-tab="sessions"]')!.click(); });
      const sessionTokens = container.querySelector('[data-usage-session-tokens="s_accounting"]')?.textContent;
      const sessionCost = container.querySelector('[data-usage-session-cost="s_accounting"]')?.textContent;
      if (tokensUnknown) {
        expect(summaryTokens).toContain('—');
        // A recorded cost of zero is a real zero, not a missing figure: the
        // price side is judged on its own flag, not on the token total.
        expect(summaryCost).not.toContain('—');
        expect(sessionTokens).toContain('—');
        expect(sessionCost).not.toContain('—');
        expect(container.querySelector('[data-usage-trend] [data-bucket]')?.getAttribute('title')).toContain('—');
        await openReliability(container);
        expect(document.body.querySelector('[data-usage-accounting-missing]')).not.toBeNull();
      } else {
        expect(summaryTokens).not.toContain('—');
        expect(summaryTokens).toContain('0');
        expect(summaryCost).not.toContain('—');
        expect(sessionTokens).not.toContain('—');
        expect(sessionCost).not.toContain('—');
        expect(document.body.querySelector('[data-usage-accounting-missing]')).toBeNull();
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
    expect(document.body.querySelector('[data-usage-accounting-legacy-zero]')).not.toBeNull();
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
    expect(document.body.querySelector('[data-usage-accounting-missing]')).not.toBeNull();
    expect(container.querySelector('[data-usage-accounting-known-subtotal]')).not.toBeNull();
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).not.toContain('—');
    // A partial token record keeps its known subtotal; the row is not blanked out.
    expect(container.querySelector('[data-usage-breakdown-tokens="mixed"]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-breakdown-tokens="mixed"]')?.textContent).toContain('11');
    expect(container.querySelector('[data-usage-breakdown-cost="mixed"]')?.textContent).not.toContain('—');
  });

  it('shows positive token and cost subtotals with an unpriced quick-fix trigger when pricing is unknown', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({ defaulted: true, costUnknown: true, unknownPriceModels: ['mystery-1'] }),
    );
    const { container } = await renderPage();
    expect(container.querySelector('[data-usage-reliability-toggle]')?.getAttribute('aria-label')).toContain('Partial');
    expect(container.textContent).not.toContain('mystery-1');
    expect(container.textContent).not.toContain('partially unknown');
    expect(container.textContent).not.toContain('Some records have no price');
    expect(container.textContent).toContain('Estimated cost');
    const unpricedBtn = container.querySelector<HTMLButtonElement>('[data-usage-unpriced-trigger]')!;
    expect(unpricedBtn).not.toBeNull();
    expect(unpricedBtn.textContent).toBe('');
    expect(unpricedBtn.getAttribute('title')).toContain('1 unpriced model');
    expect(unpricedBtn.getAttribute('aria-label')).toContain('1 unpriced model');
    await openReliability(container);
    expect(document.body.querySelector('[data-usage-unpriced-models]')?.textContent).toContain('mystery-1');
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).not.toContain('—');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).not.toContain('—');
  });

  it('keeps incomplete accounting as a compact icon status with popover', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({ defaulted: true, incompleteReason: 'session_cap', incompleteSessions: 4 }),
    );
    const { container } = await renderPage();
    const toggle = container.querySelector<HTMLButtonElement>('[data-usage-reliability-toggle]')!;
    expect(toggle.querySelector('[data-icon="partial"]')).not.toBeNull();
    expect(toggle.textContent).toBe('');
    await openReliability(container);
    expect(document.body.querySelector('[data-usage-incomplete]')).toBeNull();
  });

  it('does not present an unfinished zero scan as empty usage and resumes counting on demand', async () => {
    const partial = usageResponse({ summaryTokens: tokens(0), summaryCost: 0, incompleteReason: 'deadline', incompleteSessions: 1 });
    getUsage.mockResolvedValue({ ...partial, trend: [] });
    const { container, root } = await renderPage();
    expect(container.querySelector('[data-usage-scan-counting]')?.textContent).toBe('Counting…');
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toBe('—');
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).toBe('—');
    expect(container.querySelector('[data-usage-summary-cache]')?.textContent).toBe('—');
    expect(container.textContent).not.toContain('No usage in this range yet.');
    const before = getUsage.mock.calls.length;
    getUsage.mockResolvedValue(usageResponse());
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-continue-scan]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(getUsage.mock.calls.length).toBeGreaterThan(before);
    expect(startUsageRescan).not.toHaveBeenCalled();
    expect(container.querySelector('[data-usage-scan-pending]')).toBeNull();
    expect(container.querySelector('[data-usage-summary-tokens]')?.textContent).not.toBe('—');
    await act(async () => { root.unmount(); });
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

  it('drops a stale page token and refetches only the first page on 40922', async () => {
    let firstPage = true;
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['page_size'] === 1) return usageResponse();
      if (query['page_token'] === undefined) {
        if (firstPage) {
          firstPage = false;
          return usageResponse({ hasMore: true, nextPageToken: 'stale-token', sessions: [{ id: 'stale-first' }] });
        }
        return usageResponse({ sessions: [{ id: 'fresh-first' }] });
      }
      throw new ApiError({ code: ErrorCode.PAGE_TOKEN_MISMATCH, msg: 'stale page token', data: null });
    });
    const { container, root } = await renderPage('/usage?range=this_week&view=sessions');
    const more = container.querySelector<HTMLButtonElement>('[data-usage-load-more]');
    expect(more).not.toBeNull();
    await act(async () => { more!.click(); });
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const pageCalls = getUsage.mock.calls
      .filter(([query]) => (query as Record<string, unknown>)['page_size'] === 25)
      .map(([query]) => (query as Record<string, unknown>)['page_token']);
    expect(pageCalls).toEqual([undefined, 'stale-token', undefined]);
    expect(container.querySelector('[data-usage-session="fresh-first"]')).not.toBeNull();
    expect(container.querySelector('[data-usage-session="stale-first"]')).toBeNull();
    await act(async () => { root.unmount(); });
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

    const cal = await openCalendar(container);
    await act(async () => { cal.querySelector<HTMLElement>('[data-usage-compare]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const priorCall = getUsage.mock.calls.find(([query]) => (query as Record<string, unknown>)['start_at'] !== undefined);
    expect(priorCall).toBeDefined();
    expect(priorCall![1]).toEqual({ signal: expect.any(AbortSignal) });
    const query = priorCall![0] as Record<string, unknown>;
    const DAY = 86_400_000;
    // The prior window is the same seven-day span moved back by its own length,
    // asked for as an explicit custom window rather than a preset.
    expect(query['range']).toBe('custom');
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

  it('shows a cache-hit-rate change in percentage points, not a scaled ratio', async () => {
    // The current period reads a 50% cache hit rate and the prior 40%, so the
    // change is +10 percentage points. The point outcome already carries points,
    // so the cell prints "+10.0 pp" instead of multiplying it into a
    // +1000.0 pp growth claim. The helper counts the cache read against fresh +
    // cached input, so 2 000/4 000 reads as 50% and 1 600/4 000 as 40%.
    getUsage.mockImplementation(async (query: Record<string, unknown>) =>
      query['start_at'] === undefined
        ? usageResponse({ summaryTokens: tokens(2000, 2000), trendTokens: tokens(2000, 2000) })
        : usageResponse({ summaryTokens: tokens(2400, 1600), trendTokens: tokens(2400, 1600) }),
    );
    const { container, root } = await renderPage('/usage?range=last_7_days&metric=cache');
    const cal = await openCalendar(container);
    await act(async () => { cal.querySelector<HTMLElement>('[data-usage-compare]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const points = container.querySelector('[data-usage-kpi="cache"] [data-usage-compare="delta"]');
    expect(points).not.toBeNull();
    expect(points!.textContent).toBe('+10.0 pp');
    expect(points!.textContent).not.toContain('1000');
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

  it('refuses a comparison for unbounded all-history via disabled tooltip only', async () => {
    const { container, root } = await renderPage('/usage?range=all');
    const cal = await openCalendar(container);
    const toggle = cal.querySelector<HTMLElement>('[data-usage-compare]')!;
    const wrap = cal.querySelector<HTMLElement>('[data-usage-compare-wrap]')!;
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(wrap.getAttribute('title')).toContain('Comparison needs a bounded range');
    expect(container.textContent).not.toContain('Comparison needs a bounded range');
    await act(async () => { root.unmount(); });
  });

  it('aligns compare window with resolved server query.range timestamps and handles bucket compare', async () => {
    // Server returned range is Oct 1 - Oct 8 (start: 1790784000000, end: 1791388800000)
    // whereas client system clock might be Oct 28.
    const serverStart = 1790784000000;
    const serverEnd = 1791388800000;
    const bucketStart = 1791043200000;
    const bucketEnd = 1791129600000;
    const customBucket: UsageResponseWire['trend'][0] = {
      key: String(bucketStart),
      start_at: bucketStart,
      end_at: bucketEnd,
      groups: [
        {
          key: 'k2-thinking',
          tokens: tokens(5000, 2500),
          tokens_unknown: false,
          cost_usd_estimated: 10,
          cost_unknown: false,
          provider: 'kimi',
          model_alias: 'k2-thinking',
          agent_id: null,
          parent_agent_id: null,
          profile_name: 'default',
        },
      ],
      drilldown: { sessions: [], sessions_truncated: false },
    };

    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['start_at'] !== undefined) {
        return usageResponse({
          rangePreset: 'custom',
          rangeStartAt: Number(query['start_at']),
          rangeEndAt: Number(query['end_at']),
          summaryCost: 5,
        });
      }
      return usageResponse({
        rangePreset: 'last_7_days',
        rangeStartAt: serverStart,
        rangeEndAt: serverEnd,
        summaryCost: 15,
        trendBuckets: [customBucket],
      });
    });

    const { container, root } = await renderPage('/usage?range=today&compare=previous');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // Whole-range comparison should be requested using server range minus its resolved span:
    const compareCalls = getUsage.mock.calls.filter(([q]) => (q as Record<string, unknown>)['start_at'] !== undefined);
    expect(compareCalls.length).toBeGreaterThan(0);
    const wholeRangeCompare = compareCalls[0]?.[0] as Record<string, unknown>;
    expect(wholeRangeCompare['range']).toBe('custom');
    expect(wholeRangeCompare['start_at']).toBe(serverStart - (serverEnd - serverStart));
    expect(wholeRangeCompare['end_at']).toBe(serverStart);

    // Now click the specific bucket
    const bucketEl = container.querySelector<HTMLElement>('[data-usage-trend] [data-bucket]')!;
    expect(bucketEl).not.toBeNull();
    await act(async () => { bucketEl.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // The bucket comparison should request [bucketStart - 7d, bucketEnd - 7d]
    const bucketCompareCalls = getUsage.mock.calls.filter(([q]) => {
      const query = q as Record<string, unknown>;
      return query['start_at'] === bucketStart - (serverEnd - serverStart);
    });
    expect(bucketCompareCalls.length).toBeGreaterThan(0);
    const bucketCompare = bucketCompareCalls[0]?.[0] as Record<string, unknown>;
    expect(bucketCompare['range']).toBe('custom');
    expect(bucketCompare['start_at']).toBe(bucketStart - (serverEnd - serverStart));
    expect(bucketCompare['end_at']).toBe(bucketEnd - (serverEnd - serverStart));

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
    // The unknown row keeps its amount without defensive prose and exposes no exact filter.
    expect(container.querySelector('[data-usage-breakdown-cost="unknown"]')?.textContent).not.toContain('—');
    expect(unknownRow.querySelector('[data-usage-source-filter]')).toBeNull();
    expect(unknownRow.querySelector('[data-usage-row-filter]')).toBeNull();
    expect(container.textContent).not.toContain('no exact filter');
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

  it('switches to Sessions via the flat tab bar, and opens the SidePanel trace with base filters preserved when a bucket is selected', async () => {
    const { container, root } = await renderPage('/usage?range=today&provider=kimi&model=k2-thinking');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-tab="sessions"]')!.click(); });
    expect(container.querySelector('[data-usage-sessions]')).not.toBeNull();
    expect(document.body.querySelector('[data-usage-session-panel]')).toBeNull();

    // Back on Model with a selected hourly bucket, View sessions in this period opens the SidePanel trace with base filters preserved.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-tab="model"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-open-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trace = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(trace['provider']).toBe('kimi');
    expect(trace['model']).toBe('k2-thinking');
    expect(trace['range']).toBe('custom');
    expect(container.querySelector('[data-usage-sessions]')).toBeNull();
    expect(document.body.querySelector('[data-usage-session-panel]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('drills down from a 7-day daily bar into hourly view and restores via breadcrumb or Escape', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dayBar = container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!;
    expect(dayBar).not.toBeNull();
    await act(async () => { dayBar.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ range: 'custom', granularity: 'hour' });
    const backBtn = container.querySelector<HTMLButtonElement>('[data-usage-drilldown-back]');
    expect(backBtn).not.toBeNull();
    await act(async () => { backBtn!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ range: 'last_7_days', granularity: 'day' });
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

  it('opens the real record from a source row trace SidePanel without leaving Sources, and closes back to Sources', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-row-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // Main page stays on Sources rather than stacking SessionsTab above UsageSessionPanel.
    expect(container.querySelector('[data-usage-sources]')).not.toBeNull();
    expect(container.querySelector('[data-usage-sessions]')).toBeNull();
    expect(container.querySelector('[data-location-probe]')?.textContent).not.toContain('view=sessions');
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
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-row-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const sheet = [...document.body.querySelectorAll<HTMLElement>('[data-usage-session-panel]')].at(-1)!;
    // The attributed session offers real turn locators.
    const attributed = sheet.querySelector<HTMLButtonElement>('[data-usage-trace-locate="s_1"]')!;
    await act(async () => { attributed.click(); });
    expect(attributed.closest('li')!.querySelector('[data-usage-trace-turns]')).not.toBeNull();

    // The one without attribution disables the locator cleanly without defensive prose.
    const unattributed = sheet.querySelector<HTMLButtonElement>('[data-usage-trace-locate="s_no_turns"]')!;
    expect(unattributed.disabled).toBe(true);
    expect(unattributed.title).toContain('No turn attribution');
    const row = unattributed.closest('li')!;
    expect(row.querySelector('[data-usage-trace-turns]')).toBeNull();
    expect(row.querySelector('[data-usage-trace-no-turns]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('filters directly in Plausible style when clicking a source row name and toggles off on second click', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const rowNameBtn = container.querySelector<HTMLButtonElement>('[data-usage-row-name-filter="k2-thinking"]')!;
    expect(rowNameBtn).not.toBeNull();
    await act(async () => { rowNameBtn.click(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ model: 'k2-thinking' });
    expect(container.querySelector('[data-usage-filter-chip="model"]')?.textContent).toContain('k2-thinking');

    const toggleOffBtn = container.querySelector<HTMLButtonElement>('[data-usage-row-name-filter="k2-thinking"]')!;
    await act(async () => { toggleOffBtn.click(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect((mainCalls().at(-1)?.[0] as Record<string, unknown>)['model']).toBeUndefined();
    await act(async () => { root.unmount(); });
  });

  it('opens the session trace SidePanel on row request, scopes it to the range, and closes cleanly on Escape back to Sources', async () => {
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const panelsBefore = document.body.querySelectorAll('[data-usage-session-panel]').length;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-row-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The trace opens as a side sheet, which portals outside the page tree while Sources stays active.
    expect(document.body.querySelectorAll('[data-usage-session-panel]')).toHaveLength(panelsBefore + 1);
    expect(container.querySelector('[data-usage-sources]')).not.toBeNull();
    expect(container.querySelector('[data-usage-sessions]')).toBeNull();
    const traceCall = getUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(getUsage.mock.calls.at(-1)?.[1]).toEqual({ signal: expect.any(AbortSignal) });
    expect(traceCall['range']).toBe('custom');
    expect(Number(traceCall['start_at'])).toBeGreaterThan(0);
    expect(Number(traceCall['end_at']) - Number(traceCall['start_at'])).toBe(
      new Date(Number(traceCall['end_at'])).getTime() - new Date(Number(traceCall['start_at'])).getTime(),
    );

    const sheet = [...document.body.querySelectorAll<HTMLElement>('[data-usage-session-panel]')].at(-1)!;
    await act(async () => {
      sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.body.querySelectorAll('[data-usage-session-panel]')).toHaveLength(panelsBefore);
    expect(container.querySelector('[data-usage-sources]')).not.toBeNull();
    expect(container.querySelector('[data-usage-sessions]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('marks a trace summary cost subtotal when pricing is incomplete', async () => {
    getUsage.mockImplementation(async () => usageResponse({ costUnknown: true, tokensUnknown: true, summaryCost: 2, unknownPriceModels: ['example-model'] }));
    const { container, root } = await renderPage('/usage?range=last_7_days');
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-row-sessions]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const total = document.body.querySelector('[data-usage-trace-total]');
    expect(total?.textContent).toContain('$2.00');
    expect(total?.querySelector('[data-usage-accounting-known-subtotal]')).not.toBeNull();
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

  it('flattens detail tabs to Model, Provider, Workspace, Agent profile, and Sessions and degrades legacy ?view=five_hour gracefully', async () => {
    const { container } = await renderPage('/usage?view=five_hour&granularity=day');
    const tabs = [...container.querySelectorAll<HTMLElement>('[data-usage-tab]')].map((el) => el.dataset['usageTab']);
    expect(tabs).toEqual(['model', 'provider', 'workspace', 'profile', 'sessions']);
    expect(container.querySelector('[data-usage-tab="model"]')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-usage-fivehour-hint]')).toBeNull();
    expect(container.querySelector('[data-usage-sources]')).not.toBeNull();
  });

  it.each(['agent', 'session'])(
    'restores the advanced breakdown tab directly from ?view=breakdown&dimension=%s',
    async (dimension) => {
      const { container } = await renderPage(`/usage?view=breakdown&dimension=${dimension}`);
      expect(mainCalls()[0]?.[0]).toMatchObject({ dimension });
      const breakdownTab = container.querySelector('[data-usage-tab="breakdown"]');
      expect(breakdownTab?.getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('[data-usage-sessions]')).toBeNull();
      expect(container.textContent).toContain('k2-thinking');
    },
  );

  it.each([
    ['model', 'k2-thinking'],
    ['provider', 'kimi'],
    ['profile', 'general'],
  ] as const)(
    'reads ?dimension=%s as the flat source axis tab without nested sub-tabs',
    async (dimension, expectedRowLabel) => {
      const { container } = await renderPage(`/usage?dimension=${dimension}`);
      expect(mainCalls()[0]?.[0]).toMatchObject({ dimension });
      expect(container.querySelector(`[data-usage-sources="${dimension}"]`)).not.toBeNull();
      expect(container.querySelector(`[data-usage-tab="${dimension}"]`)?.getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('[data-usage-tab="breakdown"]')).toBeNull();
      expect(container.textContent).toContain(expectedRowLabel);
    },
  );

  it('writes the detail tab into the URL so the view is shareable', async () => {
    const { container } = await renderPage('/usage?dimension=agent');
    // A bare advanced-dimension link still opens on the Model source table.
    expect(
      container.querySelector('[data-usage-tab="model"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    const probe = () => container.querySelector('[data-location-probe]')?.textContent ?? '';
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-tab="breakdown"]')!.click();
    });
    expect(probe()).toContain('view=breakdown');
    expect(probe()).toContain('dimension=agent');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-tab="sessions"]')!.click();
    });
    expect(probe()).toContain('view=sessions');
    expect(probe()).toContain('dimension=agent');
  });

  it('heads the detail chapter with its view switcher, so each view sits under the tab that chose it', async () => {
    const { container } = await renderPage();
    expect(container.querySelectorAll('[data-usage-tabs]')).toHaveLength(1);
    const chapter = container.querySelector('[data-usage-detail]')!;
    const tabs = chapter.querySelector('[data-usage-tabs]')!;
    const sources = chapter.querySelector('[data-usage-sources]')!;
    expect(tabs.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-tab="sessions"]')!.click(); });
    // The sessions view replaces the sources view in place; the sources-only
    // scope line goes with it instead of heading a list it no longer scopes.
    expect(chapter.querySelector('[data-usage-sessions]')).not.toBeNull();
    expect(chapter.querySelector('[data-usage-sources]')).toBeNull();
    expect(chapter.querySelector('[data-usage-source-scope]')).toBeNull();
  });

  it('scopes the source table to a selected bar and leaves the headline total alone', async () => {
    const { container } = await renderPage();
    const headline = container.querySelector('[data-usage-summary-cost]')?.textContent;
    expect(container.querySelector('[data-usage-source-scope]')).toBeNull();
    expect(container.querySelector('[data-usage-drilldown]')).toBeNull();
    const tracesBefore = document.body.querySelectorAll('[data-usage-session-panel]').length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!.click();
    });
    // The period pill and its own clear action appear; the cost headline and
    // the bar selection both survive.
    expect(container.querySelector('[data-usage-clear-bucket]')).not.toBeNull();
    expect(container.querySelector('[data-usage-source-scope]')).not.toBeNull();
    expect(container.querySelector('[data-usage-summary-cost]')?.textContent).toBe(headline);
    // Selecting a bar never opens a session trace on its own.
    expect(document.body.querySelectorAll('[data-usage-session-panel]')).toHaveLength(tracesBefore);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-clear-bucket]')!.click(); });
    expect(container.querySelector('[data-usage-source-scope]')).toBeNull();
  });

  it('keeps the bar selection in the URL and in the visit snapshot', async () => {
    const { container } = await renderPage();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!.click();
    });
    expect(container.querySelector('[data-location-probe]')?.textContent).toMatch(/bucket=\d+/);
  });

  it('selects custom date ranges via the 2-month calendar popover and auto-orders reversed clicks without error', async () => {
    const startAt = new Date(2026, 7, 20).getTime();
    const endAt = new Date(2026, 7, 26).getTime();
    const { container, root } = await renderPage(
      `/usage?range=custom&start_at=${startAt}&end_at=${endAt}`,
    );
    expect(container.querySelector('input[type="date"]')).toBeNull();

    const cal = await openCalendar(container);
    const laterDay = cal.querySelector<HTMLButtonElement>('[data-calendar-day="2026-08-26"]')!;
    const earlierDay = cal.querySelector<HTMLButtonElement>('[data-calendar-day="2026-08-18"]')!;
    expect(laterDay).not.toBeNull();
    expect(earlierDay).not.toBeNull();

    const callsBefore = mainCalls().length;
    // First click starts selection without firing an intermediate query.
    await act(async () => { laterDay.click(); });
    expect(mainCalls().length).toBe(callsBefore);

    // Second click on an earlier date automatically swaps start/end instead of showing a validation error.
    await act(async () => { earlierDay.click(); });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(container.querySelector('[data-usage-range-error]')).toBeNull();
    const last = mainCalls().at(-1)?.[0] as Record<string, unknown>;
    expect(last['range']).toBe('custom');
    expect(last['start_at']).toBe(new Date(2026, 7, 18).getTime());
    expect(last['end_at']).toBe(new Date(2026, 7, 27).getTime());
    await act(async () => { root.unmount(); });
  });
});

describe('UsagePage manual full rescan', () => {
  it('places view tabs under the page header, granularity in TrendChart, and tucks rescan inside the reliability popover', async () => {
    const { container, root } = await renderPage();
    const header = container.querySelector('[data-page-header-inner="dashboard"]')!;
    expect(header).not.toBeNull();
    expect(header.querySelector('[data-usage-panel]')).toBeNull();
    expect(header.querySelector('[data-usage-more]')).not.toBeNull();
    const nav = container.querySelector('[data-usage-nav]')!;
    expect(nav).not.toBeNull();
    expect(header.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.querySelector('[data-usage-panel="history"]')).not.toBeNull();

    expect(container.querySelector('[data-usage-filters] [data-usage-reliability-toggle]')).not.toBeNull();
    expect(container.querySelector('[data-usage-filters] [data-usage-rescan]')).toBeNull();
    expect(container.querySelector('[data-usage-summary-activity]')).not.toBeNull();
    expect(container.querySelector('[data-usage-filters] [data-axis="granularity"]')).toBeNull();
    expect(container.querySelector('[data-usage-trend-card] [data-axis="granularity"]')).toBeNull();
    expect(container.querySelector('[data-usage-trend-card] [data-axis-select]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('exposes the rescan action inside the reliability popover without a standalone hint', async () => {
    const { container, root } = await renderPage();
    await openReliability(container);
    const control = document.body.querySelector('[data-usage-reliability] [data-usage-rescan]')!;
    expect(control.querySelector('[data-usage-rescan-start]')?.textContent).toBe('Rescan all');
    expect(document.body.querySelectorAll('[data-usage-rescan-start]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('this may take a while');
    await act(async () => { root.unmount(); });
  });

  it('starts without a confirmation, shows active progress badge, polls progress and refreshes history on completion', async () => {
    vi.useFakeTimers();
    try {
      const running = { state: 'running', scanned_sessions: 3, total_sessions: 10, scanned_records: 900, started_at: 1, finished_at: null, error: null };
      startUsageRescan.mockResolvedValue(running);
      const { container, root } = await renderPage('/usage?panel=history', { flush: false });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await openReliability(container);
      const popover = document.body.querySelector('[data-usage-reliability]')!;
      const button = popover.querySelector<HTMLButtonElement>('[data-usage-rescan-start]')!;
      expect(button.title).toContain('all historical');
      await act(async () => { button.click(); });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(startUsageRescan).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Rescanning…');
      expect(container.querySelector('[data-usage-rescan-running] progress')?.getAttribute('value')).toBe('3');
      expect(popover.querySelector('progress')?.max).toBe(10);
      expect(popover.textContent).toContain('3/10 sessions');
      expect(popover.textContent).not.toContain('900 records read');
      expect(popover.querySelector('[data-usage-rescan] [role="status"]')?.getAttribute('title')).toBe('900 records read');
      const beforeCompletion = mainCalls().length;
      getUsageRescan.mockResolvedValue({ ...running, state: 'completed', scanned_sessions: 10, finished_at: 2 });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await act(async () => { await Promise.resolve(); });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(popover.textContent).toContain('Rescanned 10 sessions');
      expect(popover.querySelector('progress')).toBeNull();
      expect(container.querySelector('[data-usage-rescan-running]')).toBeNull();
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
    expect(container.querySelector('[data-usage-rescan-alert]')?.textContent).toBe('Rescan failed. Try again.');
    await openReliability(container);
    const popover = document.body.querySelector('[data-usage-reliability]')!;
    expect(popover.querySelector('[data-usage-rescan] [role="alert"]')?.textContent).toBe('Rescan failed. Try again.');
    expect(document.body.textContent).not.toContain('Checkpoint');
    expect(document.body.textContent).not.toContain('instance-example');
    expect(popover.querySelector<HTMLButtonElement>('[data-usage-rescan-start]')?.disabled).toBe(false);
    await act(async () => { root.unmount(); });
  });

  it('recovers an unavailable progress request without claiming the rescan failed', async () => {
    vi.useFakeTimers();
    try {
      getUsageRescan.mockRejectedValueOnce(new Error('Connection unavailable'));
      const { container, root } = await renderPage('/usage?panel=history', { flush: false });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(container.querySelector('[data-usage-rescan-alert]')?.textContent).toBe('Progress unavailable. Reconnecting…');
      await openReliability(container);
      const popover = document.body.querySelector('[data-usage-reliability]')!;
      const alert = popover.querySelector('[data-usage-rescan] [role="alert"]')?.textContent;
      expect(alert).toBe('Progress unavailable. Reconnecting…');
      expect(alert).not.toContain('Rescan failed');
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      await act(async () => { await Promise.resolve(); });
      for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(getUsageRescan).toHaveBeenCalledTimes(2);
      expect(popover.querySelector('[data-usage-rescan] [role="alert"]')).toBeNull();
      expect(container.querySelector('[data-usage-rescan-alert]')).toBeNull();
      await act(async () => { root.unmount(); });
    } finally { vi.useRealTimers(); }
  });

  it('does not mount the history action on live governance panels', async () => {
    const { container, root } = await renderPage('/usage?panel=realtime');
    expect(container.querySelector('[data-usage-rescan]')).toBeNull();
    expect(getUsageRescan).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it('navigates to the provider quota panel and renders quota content', async () => {
    const { container, root } = await renderPage('/usage?panel=quota');
    expect(container.querySelector('[data-provider-quota-panel]')).not.toBeNull();
    expect(container.querySelector('[data-usage-nav-item="quota"]')?.getAttribute('aria-current')).toBe('page');
    await act(async () => { root.unmount(); });
  });
});

describe('UsagePage redesign: multi-select filter bar, KPI metrics & zero defensive prose', () => {
  it('supports 2-stage usage-ranked Filter popover, instant cross-category search, multi-select chips, URL sync and 1-click Clear', async () => {
    listModels.mockResolvedValue({
      items: [
        { id: 'acme/model-alpha', provider_id: 'acme', display_name: 'Model Alpha' },
        { id: 'k2-thinking', provider_id: 'kimi', display_name: 'Kimi K2 Thinking' },
      ],
    });
    listProviders.mockResolvedValue({ items: [{ id: 'acme' }, { id: 'kimi' }] });
    const { container, root } = await renderPage('/usage?panel=history');

    // Stage 1: Open + Filter composer -> clean 4-category list
    const addBtn = container.querySelector<HTMLButtonElement>('[data-usage-add-filter]')!;
    expect(addBtn).not.toBeNull();
    await act(async () => { addBtn.click(); });
    const popover = document.body.querySelector('[data-usage-filter-popover]')!;
    expect(popover).not.toBeNull();
    expect(
      [...popover.querySelectorAll<HTMLElement>('[data-usage-filter-category]')].map((el) => el.dataset['usageFilterCategory']),
    ).toEqual(['model', 'provider', 'workspace', 'profile']);

    // Stage 2: Drill into Model -> ranked by actual spend ($2.40 k2-thinking first), unused catalog folded
    await act(async () => {
      popover.querySelector<HTMLButtonElement>('[data-usage-filter-category="model"]')!.click();
    });
    const rankedOptions = [...popover.querySelectorAll<HTMLElement>('[data-usage-facet-option]')];
    expect(rankedOptions[0]?.dataset['usageFacetOption']).toBe('model:k2-thinking');
    expect(rankedOptions[0]?.textContent).toContain('$2.40');
    expect(popover.querySelector('[data-usage-facet-option="model:acme/model-alpha"]')).toBeNull();
    const unusedToggle = popover.querySelector<HTMLButtonElement>('[data-usage-filter-unused-toggle]')!;
    expect(unusedToggle).not.toBeNull();
    await act(async () => { unusedToggle.click(); });
    const alphaOption = popover.querySelector<HTMLButtonElement>('[data-usage-facet-option="model:acme/model-alpha"]')!;
    expect(alphaOption).not.toBeNull();
    // Unused toggle stays above expanded unused options rather than getting pushed below them.
    expect(unusedToggle.compareDocumentPosition(alphaOption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { alphaOption.click(); });
    await act(async () => {
      popover.querySelector<HTMLButtonElement>('[data-usage-facet-option="model:k2-thinking"]')!.click();
    });

    // Workspace facet on default groupBy=model does not fabricate partial $ sums or fold workspaces into unused.
    await act(async () => {
      popover.querySelector<HTMLButtonElement>('[data-usage-filter-back]')!.click();
    });
    await act(async () => {
      popover.querySelector<HTMLButtonElement>('[data-usage-filter-category="workspace"]')!.click();
    });
    expect(popover.querySelector('[data-usage-filter-unused-toggle]')).toBeNull();
    expect(popover.querySelector('[data-usage-facet-option="workspace:wd_1"]')?.textContent).not.toContain('$');

    // Return to Stage 1 and run instant cross-category search without firing extra API calls
    await act(async () => {
      popover.querySelector<HTMLButtonElement>('[data-usage-filter-back]')!.click();
    });
    const callsBeforeSearch = getUsage.mock.calls.length;
    const search = popover.querySelector<HTMLInputElement>('[data-usage-filter-search]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'explore');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(getUsage.mock.calls.length).toBe(callsBeforeSearch);
    const profileOption = popover.querySelector<HTMLButtonElement>('[data-usage-facet-option="profile:explore"]')!;
    await act(async () => { profileOption.click(); });

    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // Repeated arrays sent to URL & API
    const probeText = container.querySelector('[data-location-probe]')?.textContent ?? '';
    expect(probeText).toContain('model=acme%2Fmodel-alpha');
    expect(probeText).toContain('model=k2-thinking');
    expect(probeText).toContain('profile=explore');
    expect(mainCalls().at(-1)?.[0]).toMatchObject({
      model: ['acme/model-alpha', 'k2-thinking'],
      profile: ['explore'],
    });

    // Interactive chips rendered
    const modelChip = container.querySelector('[data-usage-filter-chip="model"]')!;
    expect(modelChip.textContent).toContain('Model Alpha +1');
    expect(container.querySelector('[data-usage-filter-chip="profile"]')?.textContent).toContain('explore');

    // 1-click Clear resets all scope filters while preserving range & groupBy
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-clear-filters]')!.click();
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-usage-filter-chips]')).toBeNull();
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ range: 'today', dimension: 'model' });
    expect((mainCalls().at(-1)?.[0] as Record<string, unknown>)['model']).toBeUndefined();
    await act(async () => { root.unmount(); });
  });

  it('toggles multi-value filters directly from Sources quick-filter buttons and opens PricingPanel from unpriced badge', async () => {
    const { container, root } = await renderPage('/usage?panel=history&range=last_7_days');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-row-filter="k2-thinking"]')!.click();
    });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ model: 'k2-thinking' });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-row-filter="claude-sonnet-4.5"]')!.click();
    });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ model: ['k2-thinking', 'claude-sonnet-4.5'] });

    // Toggling k2 off leaves only sonnet
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-row-filter="k2-thinking"]')!.click();
    });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ model: 'claude-sonnet-4.5' });

    // Unpriced amber badge opens PricingPanel directly
    getUsage.mockResolvedValue(usageResponse({ costUnknown: true, unknownPriceModels: ['mystery-9'] }));
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-clear-filters]')!.click(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const unpricedTrigger = container.querySelector<HTMLButtonElement>('[data-usage-unpriced-trigger]')!;
    expect(unpricedTrigger).not.toBeNull();
    await act(async () => { unpricedTrigger.click(); });
    expect(document.body.querySelector('[data-usage-pricing-panel]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('renders honest turns/requests in Activity & Pace and omits all resident defensive prose in EN and ZH', async () => {
    const day = new Date(2026, 8, 1).getTime();
    getUsage.mockResolvedValue(usageResponse({
      costUnknown: true,
      unknownPriceModels: ['mystery-9'],
      trendBuckets: [{
        key: String(day),
        start_at: day,
        end_at: day + 24 * 3600_000,
        turn_count: 14,
        request_count: 23,
        groups: [{
          key: 'k2-thinking',
          tokens: tokens(5000, 2500),
          cost_usd_estimated: 1.4,
          cost_unknown: false,
          provider: 'kimi',
          model_alias: 'k2-thinking',
          agent_id: null,
          parent_agent_id: null,
          profile_name: 'general',
        }],
        drilldown: { sessions: [], sessions_truncated: false },
      }],
    }));

    for (const locale of ['en', 'zh'] as const) {
      localStorage.setItem('kiki.locale', locale);
      const { container, root } = await renderPage('/usage?panel=history&range=all');
      const activity = container.querySelector('[data-usage-summary-activity]')?.textContent ?? '';
      expect(activity).toContain('14');
      expect(activity).toContain('23');
      const text = container.textContent ?? '';
      for (const banned of [
        'Comparison needs a bounded range',
        'Some records have no price',
        '部分记录缺价',
        'Highest cost first',
        '按费用从高到低排列',
        'About these totals',
        '统计说明',
        'Select a period to read its sources',
        '点一根柱子',
        'no time filter applied',
        '未套用时间过滤',
        'Cache hit rate for the prior period',
        '前期的缓存命中率',
      ]) {
        expect(text).not.toContain(banned);
      }
      await act(async () => { root.unmount(); });
    }
  });

  it('shows cache savings only when USD base and cache-read rates resolve for all cache-read models', async () => {
    getUsagePricing.mockResolvedValue({
      items: [
        {
          model: 'k2-thinking',
          source: 'catalog',
          prices: {
            currency: 'USD',
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.000015,
            cache_read_input_token_cost: 0.0000003,
          },
        },
        {
          model: 'claude-sonnet-4.5',
          source: 'catalog',
          prices: {
            currency: 'USD',
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.000015,
            cache_read_input_token_cost: 0.0000003,
          },
        },
      ],
    });
    const { container, root } = await renderPage('/usage?panel=history&range=last_7_days');
    expect(container.querySelector('[data-usage-cache-savings]')?.textContent).toContain('$0.013');
    await act(async () => { root.unmount(); });

    // Partial pricing (missing one model) hides savings rather than fabricating a number
    getUsagePricing.mockResolvedValue({
      items: [
        {
          model: 'k2-thinking',
          source: 'catalog',
          prices: {
            currency: 'USD',
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.000015,
            cache_read_input_token_cost: 0.0000003,
          },
        },
      ],
    });
    const second = await renderPage('/usage?panel=history&range=last_7_days');
    expect(second.container.querySelector('[data-usage-cache-savings]')).toBeNull();
    await act(async () => { second.root.unmount(); });
  });

  it('keeps QuotaHeadroomStrip out of the Usage history tab so Live, Usage, and Quotas stay cleanly separated', async () => {
    const { container, root } = await renderPage('/usage?panel=history');
    expect(container.querySelector('[data-usage-quota-strip]')).toBeNull();
    expect(container.querySelector('[data-usage-live-band]')).toBeNull();
    expect(getProviderQuotas).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it('displays session primary_model and profile_names and filters Sessions tab locally', async () => {
    const base = usageResponse({
      sessions: [
        { id: 's_alpha', title: 'Design pass', cost: 2.1 },
        { id: 's_beta', title: 'Fix query', cost: 0.9 },
      ],
    });
    base.sessions.items[0]!.primary_model = 'claude-opus-4-6';
    base.sessions.items[0]!.profile_names = ['frontend'];
    base.sessions.items[1]!.primary_model = 'k2-thinking';
    base.sessions.items[1]!.profile_names = ['explore'];
    getUsage.mockResolvedValue(base);

    const { container, root } = await renderPage('/usage?panel=history&view=sessions');
    const alphaRow = container.querySelector('[data-usage-session="s_alpha"]')!;
    expect(alphaRow.textContent).toContain('claude-opus-4-6');
    expect(alphaRow.textContent).toContain('frontend');

    const search = container.querySelector<HTMLInputElement>('[data-usage-sessions-search]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'explore');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-usage-session="s_alpha"]')).toBeNull();
    expect(container.querySelector('[data-usage-session="s_beta"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('renders dash + KnownSubtotalMarker instead of $0.00 * on unpriced zero-cost source and session rows', async () => {
    const base = usageResponse({
      costUnknown: true,
      unknownPriceModels: ['mystery-9'],
      sessions: [
        { id: 's_unpriced', title: 'Unpriced run', cost: 0 },
        { id: 's_partial', title: 'Partial run', cost: 1.5 },
      ],
      trendGroups: [
        { key: 'mystery-9', cost: 0, provider: 'local', profile: 'default' },
        { key: 'k2-thinking', cost: 1.5, provider: 'kimi', profile: 'default' },
      ],
    });
    base.sessions.items[1]!.usage.cost_unknown = true;
    getUsage.mockResolvedValue(base);

    const { container, root } = await renderPage('/usage?panel=history');
    const sourceCost = container.querySelector('[data-usage-breakdown-cost="mystery-9"]')!;
    expect(sourceCost.textContent).toContain('—');
    expect(sourceCost.textContent).not.toContain('$0.00');
    expect(sourceCost.textContent).not.toContain('*');
    expect(sourceCost.querySelector('[data-usage-accounting-known-subtotal]')).not.toBeNull();

    const partialSourceCost = container.querySelector('[data-usage-breakdown-cost="k2-thinking"]')!;
    expect(partialSourceCost.textContent).toContain('$1.50');
    expect(partialSourceCost.querySelector('[data-usage-accounting-known-subtotal]')).not.toBeNull();

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-tab="sessions"]')!.click(); });
    const unpricedSessionCost = container.querySelector('[data-usage-session-cost="s_unpriced"]')!;
    expect(unpricedSessionCost.textContent).toContain('—');
    expect(unpricedSessionCost.textContent).not.toContain('$0.00');
    expect(unpricedSessionCost.querySelector('[data-usage-accounting-known-subtotal]')).not.toBeNull();
    expect(container.querySelector('[data-usage-session-cost="s_partial"]')?.textContent).toContain('$1.50');
    await act(async () => { root.unmount(); });
  });

  it('uses axis-aware unknown labels and preserves cache savings across Group by tabs via model attribution', async () => {
    getUsagePricing.mockResolvedValue({
      items: [
        {
          model: 'k2-thinking',
          source: 'catalog',
          prices: { currency: 'USD', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.0000003 },
        },
        {
          model: 'claude-sonnet-4.5',
          source: 'catalog',
          prices: { currency: 'USD', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.0000003 },
        },
      ],
    });
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['dimension'] === 'project') {
        return usageResponse({
          trendGroups: [
            { key: 'wd_1', cost: 2.0, provider: null, profile: null },
            { key: 'unknown', cost: 0.5, provider: null, profile: null },
          ],
        });
      }
      return usageResponse();
    });

    const { container, root } = await renderPage('/usage?panel=history&dimension=project');
    expect(mainCalls().at(-1)?.[0]).toMatchObject({ dimension: 'project' });
    expect(container.querySelector('[data-usage-breakdown-row="unknown"]')?.textContent).toContain('unknown workspace');
    expect(container.querySelector('[data-usage-cache-savings]')?.textContent).toContain('$0.013');
    await act(async () => { root.unmount(); });
  });

  it('supports keyboard ArrowDown/Enter selection and Escape focus return for + Filter and chip triggers', async () => {
    listModels.mockResolvedValue({
      items: [{ id: 'k2-thinking', provider_id: 'kimi', display_name: 'Kimi K2 Thinking' }],
    });
    const { container, root } = await renderPage('/usage?panel=history');

    // Open via + Filter, navigate with ArrowDown + Enter, then Escape returns focus to + Filter
    const addBtn = container.querySelector<HTMLButtonElement>('[data-usage-add-filter]')!;
    addBtn.focus();
    await act(async () => { addBtn.click(); });
    const search = document.body.querySelector<HTMLInputElement>('[data-usage-filter-search]')!;
    expect(document.activeElement).toBe(search);

    // Stage 1 Enter drills into Model; Stage 2 Enter selects the top-ranked model, then Escape returns focus to + Filter
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const stage2Search = document.body.querySelector<HTMLInputElement>('[data-usage-filter-search]')!;
    await act(async () => {
      stage2Search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const popover = document.body.querySelector<HTMLElement>('[data-usage-filter-popover]')!;
    await act(async () => {
      popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[data-usage-filter-popover]')).toBeNull();
    expect(document.activeElement).toBe(addBtn);

    // Open via the rendered filter chip button, then Escape returns focus to that chip button
    const chipBtn = container.querySelector<HTMLButtonElement>('[data-usage-filter-chip="model"] button')!;
    expect(chipBtn).not.toBeNull();
    chipBtn.focus();
    await act(async () => { chipBtn.click(); });
    const reopened = document.body.querySelector<HTMLElement>('[data-usage-filter-popover]')!;
    expect(reopened).not.toBeNull();
    await act(async () => {
      reopened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[data-usage-filter-popover]')).toBeNull();
    expect(document.activeElement).toBe(chipBtn);
    await act(async () => { root.unmount(); });
  });

  it('uses dialog ActionSheet in phone mode with container initial focus, listbox keyboard navigation, and fallback focus return', async () => {
    const originalMatchMedia = window.matchMedia;
    const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse) and (max-width: 639px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMediaMock });

    try {
      listModels.mockResolvedValue({
        items: [
          { id: 'k2-thinking', provider_id: 'kimi', display_name: 'Kimi K2 Thinking' },
          { id: 'claude-sonnet-4.5', provider_id: 'anthropic', display_name: 'Claude Sonnet 4.5' },
        ],
      });
      const { container, root } = await renderPage('/usage?panel=history');

      const addBtn = container.querySelector<HTMLButtonElement>('[data-usage-add-filter]')!;
      addBtn.focus();
      await act(async () => { addBtn.click(); });

      const sheet = document.body.querySelector<HTMLElement>('[data-usage-filter-popover] .kiki-action-sheet')!;
      expect(sheet).not.toBeNull();
      expect(sheet.getAttribute('role')).toBe('dialog');
      // Focus moves off + Filter onto the dialog container so pressing Enter selects an option instead of closing.
      expect(document.activeElement).toBe(sheet);
      expect(document.activeElement).not.toBe(addBtn);

      // Stage 1 Enter drills into Model; Stage 2 Enter selects the top-ranked model
      await act(async () => {
        sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      await act(async () => {
        sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(document.body.querySelector('[data-usage-filter-popover] .kiki-action-sheet')).not.toBeNull();
      expect(container.querySelector('[data-usage-filter-chip="model"]')).not.toBeNull();

      await act(async () => {
        sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await act(async () => { await Promise.resolve(); });
      expect(document.body.querySelector('[data-usage-filter-popover] .kiki-action-sheet')).toBeNull();
      expect(document.activeElement).toBe(addBtn);

      // Open via the model chip, remove the only selected model so the chip unmounts, then Escape falls back to + Filter.
      const chipBtn = container.querySelector<HTMLButtonElement>('[data-usage-filter-chip="model"] button')!;
      chipBtn.focus();
      await act(async () => { chipBtn.click(); });
      const reopenedSheet = document.body.querySelector<HTMLElement>('[data-usage-filter-popover] .kiki-action-sheet')!;
      await act(async () => {
        reopenedSheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(container.querySelector('[data-usage-filter-chip="model"]')).toBeNull();

      await act(async () => {
        reopenedSheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await act(async () => { await Promise.resolve(); });
      expect(document.activeElement).toBe(addBtn);
      await act(async () => { root.unmount(); });
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: originalMatchMedia });
    }
  });

  it('keeps cache savings badge steady without flicker or redundant model queries when switching Group by tabs', async () => {
    getUsagePricing.mockResolvedValue({
      items: [
        {
          model: 'k2-thinking',
          source: 'catalog',
          prices: { currency: 'USD', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.0000003 },
        },
        {
          model: 'claude-sonnet-4.5',
          source: 'catalog',
          prices: { currency: 'USD', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.0000003 },
        },
      ],
    });
    const { container, root } = await renderPage('/usage?panel=history&range=last_7_days');
    expect(container.querySelector('[data-usage-cache-savings]')?.textContent).toContain('$0.013');
    getUsage.mockClear();

    for (const nextGroup of ['provider', 'profile', 'workspace'] as const) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-usage-grouping="${nextGroup}"]`)!.click();
      });
      // Immediately after switching Group by (even before async refetch settles), cache savings stays visible.
      expect(container.querySelector('[data-usage-cache-savings]')?.textContent).toContain('$0.013');
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(container.querySelector('[data-usage-cache-savings]')?.textContent).toContain('$0.013');
    }

    // Because groupBy=model seeded the groupBy-independent modelAttributionQuery key, zero extra page_size=1&dimension=model calls were needed.
    const modelAttributionCalls = getUsage.mock.calls.filter(
      ([q]) => (q as Record<string, unknown>)['page_size'] === 1 && (q as Record<string, unknown>)['dimension'] === 'model',
    );
    expect(modelAttributionCalls).toHaveLength(0);
    await act(async () => { root.unmount(); });
  });

  it('supports legacy ?session_id= deep links and clears observed filter facets when switching Space scopeId', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({
        sessions: [
          { id: 's_1', title: 'Alpha session', cost: 1.5 },
          { id: 's_legacy', title: 'Legacy linked session', cost: 0.75 },
        ],
        trendGroups: [
          { key: currentScopeId === 'space-a' ? 'space-a-exclusive-model' : 'space-b-model', cost: 1.5, provider: 'kimi', profile: 'default' },
        ],
      }),
    );

    const legacyRender = await renderPage('/usage?session_id=s_legacy');
    expect(legacyRender.container.querySelector('[data-usage-panel="history"]')?.getAttribute('aria-current')).toBe('page');
    expect(legacyRender.container.textContent).toContain('Located session');
    expect(legacyRender.container.querySelector('[data-usage-session="s_legacy"]')).not.toBeNull();
    expect(legacyRender.container.querySelector('[data-usage-session="s_1"]')).toBeNull();
    await act(async () => { legacyRender.root.unmount(); });

    currentScopeId = 'space-a';
    listModels.mockResolvedValue({ items: [] });
    const spaceRender = await renderPage('/usage?panel=history');
    await act(async () => {
      spaceRender.container.querySelector<HTMLButtonElement>('[data-usage-add-filter]')!.click();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-usage-filter-category="model"]')!.click();
    });
    expect(document.body.querySelector('[data-usage-filter-popover]')?.textContent).toContain('space-a-exclusive-model');

    // Switch Space scopeId and rerender in place: stale observed facets from space-a are purged.
    currentScopeId = 'space-b';
    await act(async () => {
      spaceRender.root.render(
        <QueryClientProvider client={spaceRender.queryClient}>
          <I18nProvider>
            <MemoryRouter initialEntries={['/usage?panel=history']}>
              <UsagePage onToggleSidebar={() => {}} />
              <LocationProbe />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.body.querySelector('[data-usage-filter-popover]')?.textContent).not.toContain('space-a-exclusive-model');
    await act(async () => { spaceRender.root.unmount(); });
  });

  it('renders Total Token KPI and full-width Chinese colons on filter chips in zh locale', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    const { container, root } = await renderPage('/usage?panel=history&model=k2-thinking&include_archived=false');
    const tokenKpi = container.querySelector('[data-usage-kpi="tokens"]')!;
    expect(tokenKpi.textContent).toContain('总 Token');
    expect(tokenKpi.textContent).not.toContain('总 tokens');

    const modelChipBtn = container.querySelector<HTMLButtonElement>('[data-usage-filter-chip="model"] button')!;
    expect(modelChipBtn.textContent).toContain('模型：');
    expect(modelChipBtn.getAttribute('title')).toBe('模型：k2-thinking');

    // Archived toggle stays quietly inside the Filter menu and never poses as a fake filter pill.
    expect(container.querySelector('[data-usage-filter-chip="archived"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('pauses secondary compare and model-attribution queries while main usageQuery is still importing', async () => {
    let mainReady = false;
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['page_size'] === 25) {
        return mainReady
          ? usageResponse({ summaryCost: 9 })
          : usageResponse({ incompleteReason: 'deadline', summaryCost: 3 });
      }
      return usageResponse({ summaryCost: 4 });
    });

    const { container, root } = await renderPage('/usage?panel=history&range=last_7_days&group_by=provider&compare=previous');
    // While reliability.complete === false, only the primary page_size=25 query has fired.
    const secondaryWhileImporting = getUsage.mock.calls.filter(
      ([q]) => (q as Record<string, unknown>)['page_size'] === 1,
    );
    expect(secondaryWhileImporting).toHaveLength(0);
    expect(container.querySelector('[data-usage-scan-pending]')).not.toBeNull();

    // Advance main query to complete: secondary compare and model-attribution queries now fire.
    mainReady = true;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const secondaryAfterReady = getUsage.mock.calls.filter(
      ([q]) => (q as Record<string, unknown>)['page_size'] === 1,
    );
    expect(secondaryAfterReady.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[data-usage-scan-pending]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('caps sessionLocator auto-pagination at 4 follow-up pages instead of draining unbounded history', async () => {
    let pageNum = 1;
    getUsage.mockImplementation(async (query: Record<string, unknown>) => {
      if (query['page_size'] === 1) return usageResponse();
      const current = pageNum;
      pageNum += 1;
      return usageResponse({
        hasMore: current < 18,
        nextPageToken: `tok_${current + 1}`,
        sessions: [{ id: `s_page_${current}` }],
      });
    });

    const { container, root } = await renderPage('/usage?session=s_very_old');
    for (let i = 0; i < 15; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }

    const pageTokens = getUsage.mock.calls
      .map(([q]) => (q as Record<string, unknown>)['page_token'])
      .filter((tok) => tok !== undefined);
    expect(pageTokens).toEqual(['tok_2', 'tok_3', 'tok_4', 'tok_5']);
    expect(container.querySelector('[data-usage-locating]')?.textContent)
      .toContain('outside the current result set');
    expect(container.querySelector('[data-usage-load-more]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('renders 1-decimal cache hit %, instant floating trend tooltip on focus/hover, and single-column detail layout with 0 extra queries', async () => {
    const rawWsId = 'wd_orphan_workspace_9f8e7d6c5b4a';
    const rawSessionId = 'session_afecd3f8-d450-434a-ae3a-d9e35f728b9d';
    const base = usageResponse({
      summaryTokens: { input_other: 58, output: 200, input_cache_read: 942, input_cache_creation: 0 },
      sessions: [
        { id: rawSessionId, title: undefined, cost: 2.75 },
      ],
    });
    base.sessions.items[0]!.title = null;
    base.sessions.items[0]!.workspace_id = rawWsId;
    base.sessions.items[0]!.primary_model = 'k2-thinking';
    getUsage.mockResolvedValue(base);

    const { container, root } = await renderPage('/usage?panel=history');
    expect(getUsage).toHaveBeenCalledTimes(1);

    // 942 / (942 + 58) = 94.2%
    expect(container.querySelector('[data-usage-summary-cache]')?.textContent).toBe('94.2%');
    expect(container.querySelector('[data-usage-top-sessions]')).toBeNull();
    expect(container.querySelector('[data-usage-sessions]')).toBeNull();

    // Hover/focus on a TrendChart bucket surfaces the floating readout card immediately
    expect(container.querySelector('[data-usage-trend-tooltip]')).toBeNull();
    const bucketBtn = container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!;
    await act(async () => {
      bucketBtn.focus();
      bucketBtn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    const tooltip = container.querySelector('[data-usage-trend-tooltip]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain('k2-thinking');

    await act(async () => { root.unmount(); });
  });

  it('virtualizes 10,000 session rows into a bounded DOM window and filters cleanly', async () => {
    const tenThousand = Array.from({ length: 10_000 }, (_, i) => ({
      id: `s_scale_${i}`,
      title: i === 7777 ? 'Needle target session' : `Session ${i}`,
      cost: Math.max(0.01, (10_000 - i) * 0.001),
    }));
    getUsage.mockResolvedValue(usageResponse({ sessions: tenThousand }));

    const { container, root } = await renderPage('/usage?panel=history&view=sessions');
    const list = container.querySelector('[data-usage-sessions-virtualized="true"]');
    expect(list).not.toBeNull();
    const mountedRows = container.querySelectorAll('[data-usage-session]');
    expect(mountedRows.length).toBeGreaterThan(5);
    expect(mountedRows.length).toBeLessThanOrEqual(50);

    const searchInput = container.querySelector<HTMLInputElement>('[data-usage-sessions-search]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(searchInput, 'Needle target');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const filteredRows = container.querySelectorAll('[data-usage-session]');
    expect(filteredRows).toHaveLength(1);
    expect(filteredRows[0]?.getAttribute('data-usage-session')).toBe('s_scale_7777');
    expect(filteredRows[0]?.textContent).toContain('7778');

    await act(async () => { root.unmount(); });
  });
});

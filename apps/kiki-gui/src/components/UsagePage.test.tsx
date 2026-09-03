// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { USAGE_FILTERS_STORAGE_KEY, type UsageResponseWire } from '../lib/usageV2';
import { UsagePage } from './UsagePage';

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
const getSession = vi.fn();
const listWorkspaces = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: { getUsage, getSession, listWorkspaces } }),
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
  unknownPriceModels?: string[];
  incompleteReason?: 'session_cap' | 'record_budget' | 'deadline' | null;
  incompleteSessions?: number;
  sessions?: { id: string; title?: string; cost?: number }[];
  hasMore?: boolean;
  nextPageToken?: string | null;
  trendGroups?: { key: string; cost: number; provider?: string | null }[];
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
        tokens: tokens(1000, 500),
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
      workspace_ids: [],
      include_archived: true,
      timezone_offset_minutes: 0,
    },
    summary: {
      tokens: tokens(5000, 2500),
      cost_usd_estimated: 3.25,
      cost_unknown: overrides.costUnknown ?? false,
      session_count: items.length,
    },
    trend: [
      {
        key: String(day),
        start_at: day,
        end_at: day + 24 * 3600_000,
        groups: (overrides.trendGroups ?? [{ key: 'k2-thinking', cost: 3.25, provider: 'kimi' }]).map(
          (group) => ({
            key: group.key,
            tokens: tokens(5000, 2500),
            cost_usd_estimated: group.cost,
            cost_unknown: false,
            provider: group.provider ?? null,
            model_alias: group.key === 'unknown' ? null : group.key,
            agent_id: null,
            parent_agent_id: null,
            profile_name: null,
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

async function renderPage(entry = '/usage') {
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
  // Flush react-query promise resolution + re-render (a few macrotask turns).
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return { container, root };
}

/** Calls to the main paged query (the live strip asks for range=today). */
function mainCalls() {
  return getUsage.mock.calls.filter(
    ([query]) => (query as Record<string, unknown>)['range'] !== 'today',
  );
}

beforeEach(() => {
  localStorage.clear();
  getUsage.mockReset();
  getSession.mockReset();
  listWorkspaces.mockReset();
  getUsage.mockImplementation(async () => usageResponse({ defaulted: true }));
  getSession.mockRejectedValue(new Error('no session'));
  listWorkspaces.mockResolvedValue({ items: [{ id: 'wd_1', name: 'Workspace One' }] });
});

describe('UsagePage (V2)', () => {
  it('defaults to all history and says so explicitly', async () => {
    const { container } = await renderPage();
    const main = mainCalls();
    expect(main.length).toBeGreaterThan(0);
    // range is omitted so the server marks the response defaulted_to_all_history.
    expect(main[0]?.[0]).toMatchObject({ granularity: 'day', dimension: 'model' });
    expect((main[0]?.[0] as Record<string, unknown>)['range']).toBeUndefined();
    expect(container.querySelector('[data-usage-all-history]')?.textContent).toContain(
      'All history',
    );
    expect(container.querySelector('[data-usage-reliability]')).not.toBeNull();
    expect(container.textContent).toContain('Deleted sessions are not included');
  });

  it('carries every URL axis into the API query', async () => {
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

  it('flags partially-unknown pricing on the cost KPI', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({ defaulted: true, costUnknown: true, unknownPriceModels: ['mystery-1'] }),
    );
    const { container } = await renderPage();
    expect(container.textContent).toContain('partially unknown');
    expect(container.textContent).toContain('mystery-1');
    expect(container.textContent).toContain('Estimated cost');
  });

  it('shows the incomplete notice when the server reports one', async () => {
    getUsage.mockImplementation(async () =>
      usageResponse({ defaulted: true, incompleteReason: 'session_cap', incompleteSessions: 4 }),
    );
    const { container } = await renderPage();
    expect(container.querySelector('[data-usage-incomplete]')?.textContent).toContain(
      'Session scan cap reached',
    );
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
      if (query['range'] === 'today') return usageResponse();
      calls += 1;
      return calls === 1
        ? usageResponse({ hasMore: true, nextPageToken: 'tok_2', sessions: [{ id: 's_1' }] })
        : usageResponse({ sessions: [{ id: 's_2' }] });
    });
    const { container } = await renderPage('/usage?range=this_week');
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
      if (query['range'] === 'today') return usageResponse();
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
      if (query['range'] === 'today') return usageResponse();
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
    expect(container.textContent).toContain('outside the current result set');
    expect(container.querySelector('[data-usage-locating]')).toBeNull();
  });

  it('persists the range selection for query-less revisits', async () => {
    await renderPage('/usage?range=this_month');
    const stored = localStorage.getItem(USAGE_FILTERS_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject({ range: 'this_month' });
  });

  it('switches detail tabs and offers the 5h granularity from the rhythm tab', async () => {
    const { container } = await renderPage();
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

  it.each(['model', 'agent', 'project', 'session'])(
    'restores the breakdown tab directly from ?view=breakdown&dimension=%s',
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

  it('writes the detail tab into the URL so the view is shareable', async () => {
    const { container } = await renderPage('/usage?dimension=agent');
    // A bare dimension link still opens on the sessions tab.
    expect(
      container.querySelector('[data-usage-tab="sessions"]')?.getAttribute('aria-selected'),
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
    expect(probe()).not.toContain('view=');
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

  it('shows the bucket drilldown with turn locators when a trend bucket is selected', async () => {
    const { container } = await renderPage();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-usage-trend] [data-bucket]')!.click();
    });
    const panel = container.querySelector('[data-usage-drilldown]');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain('s_1');
    expect(panel!.querySelector('[data-usage-turn="1"]')).not.toBeNull();
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

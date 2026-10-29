// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSnapshot, Session, Workspace, WorkspaceCatalogEntry } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import { ApiError, KikiClient, MEMORY_REVISION_CONFLICT, MEMORY_TYPES, type MemoryEntry, type MemoryJournalRecord, type MemorySettings } from '../lib/client';
import { MemoryPage, MEMORY_SETTINGS_QUERY_KEY } from './MemoryPage';
import { getToasts } from '../lib/toasts';
import { memorySourceTargets } from './useMemorySources';
import { memorySnapshot } from './MemoryHistory';
import type { ToolBlock } from '@kiki/session-core/session';
import { MemoryToolRow } from './MemoryToolRow';
import { MemoryAdvisorSwitch } from './memory/MemoryAdvisorSwitch';
import { parseMemoryReadResult, parseMemorySearchSummary, parseMemoryWriteResult } from './memory/memoryReceipt';
import { DirtyGuardContext, useDirtyGuardState } from './dirtyGuard';
import { detectActiveAnchors, resolveAnchorElement } from './discovery/DiscoveryContext';

const listBots = vi.hoisted(() => vi.fn(async () => [] as { personaId: string; name: string; homeSessionId: string; hidden: boolean; pinned: boolean }[]));
vi.mock('../lib/botRooms', () => ({ BOTS_QUERY_KEY: ['bots'], useBotRoomApi: () => ({ listBots }) }));

const client = new KikiClient({ baseUrl: 'http://example.test', token: 'example-token' });
vi.mock('../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => ({ client }),
}));

const entries: MemoryEntry[] = MEMORY_TYPES.flatMap((type) =>
  (['match', 'other', 'archived'] as const).map((variant) => ({
    id: `m_${type}_${variant}`,
    type,
    title: `${type} ${variant}`,
    body: variant === 'other' ? 'Unrelated content.' : 'Needle content.',
    status: variant === 'archived' ? 'archived' : 'active',
    pinned: false,
    created: '2026-01-01T12:00:00Z',
    updated: '2026-01-01T12:00:00Z',
    source: { writer: 'user' },
    reason: 'Test memory filters',
    revision: 'revision-example',
  })),
);
const requests: URL[] = [];
const mounted: { root: Root; container: HTMLDivElement; queryClient: QueryClient }[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  requests.length = 0;
  listBots.mockReset().mockResolvedValue([]);
  vi.spyOn(client, 'listPersonas').mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    let data: unknown;
    if (url.pathname === '/api/memory/settings') {
      data = { enabled: true, approval: 'auto', budget: 2000, workspaces: {} };
    } else {
      if (url.pathname !== '/api/memory/global') throw new Error(`Unexpected request: ${url.pathname}`);
      requests.push(url);
      const type = url.searchParams.get('type');
      const query = url.searchParams.get('query')?.toLowerCase() ?? '';
      const includeInactive = url.searchParams.get('include_inactive') === 'true';
      data = { items: entries.filter((entry) =>
        (type === null || entry.type === type)
        && (includeInactive || entry.status === 'active')
        && `${entry.title} ${entry.body}`.toLowerCase().includes(query)) };
    }
    return new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
});
afterEach(async () => {
  for (const { root, container, queryClient } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function RouteProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <div hidden><output data-memory-route>{location.search}</output><button type="button" data-route-back onClick={() => { void navigate(-1); }}>Back</button></div>;
}

const routeParams = (container: HTMLElement) => new URLSearchParams(container.querySelector('[data-memory-route]')!.textContent!);

async function mountPage(path = '/memory', workspaces: readonly WorkspaceCatalogEntry[] = [], workspacesLoading = false, liveDirectory = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container, queryClient });
  function DirectoryPage() {
    // App's own directory read: metadata-only catalog rows.
    const directory = useQuery({ queryKey: ['workspaces', 'catalog'], queryFn: () => client.listWorkspaceCatalog() });
    return <MemoryPage workspaceOptions={directory.data?.items ?? []} workspacesLoading={directory.isPending} onNavigate={() => {}} onToggleSidebar={() => {}} />;
  }
  const rerender = async (nextWorkspaces: readonly WorkspaceCatalogEntry[], loading = false) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter initialEntries={[path]}>
              <RouteProbe />
              {liveDirectory ? <DirectoryPage /> : <MemoryPage workspaceOptions={nextWorkspaces} workspacesLoading={loading} onNavigate={() => {}} onToggleSidebar={() => {}} />}
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flush();
  };
  await rerender(workspaces, workspacesLoading);
  return { container, queryClient, rerender };
}

/** The same page inside the app-wide dirty guard, so the editor's own
 *  reporting is observed where the shell really keeps it. */
async function mountGuardedPage(path = '/memory', workspaces: readonly WorkspaceCatalogEntry[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container, queryClient });
  function Guarded() {
    const location = useLocation();
    const rawNavigate = useNavigate();
    const guard = useDirtyGuardState(location, (target, options) => {
      if (typeof target === 'number') void rawNavigate(target);
      else void rawNavigate(target, options);
    });
    return (
      <DirtyGuardContext.Provider value={guard.value}>
        <MemoryPage workspaceOptions={workspaces} onNavigate={() => {}} onToggleSidebar={() => {}} />
        <output data-guard-dirty>{String(guard.value.dirty)}</output>
        <output data-guard-pending>{String(guard.pending)}</output>
        <button type="button" data-guard-confirm onClick={() => { void guard.confirm(); }}>confirm</button>
        <button type="button" data-guard-cancel onClick={() => { guard.cancel(); }}>cancel</button>
      </DirtyGuardContext.Provider>
    );
  }
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}><RouteProbe /><Guarded /></MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return { container, queryClient };
}

async function renderPage(path = '/memory', workspaces: readonly WorkspaceCatalogEntry[] = []) {
  return (await mountPage(path, workspaces)).container;
}

function rowIds(container: HTMLElement) {
  return [...container.querySelectorAll('[data-memory-row]')].map((row) => row.getAttribute('data-memory-row')).sort();
}

async function selectType(container: HTMLElement, type: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-memory-type-filter="${type}"]`)!;
  await act(async () => { button.click(); });
  await flush();
  expect(button.getAttribute('aria-pressed')).toBe('true');
}

async function search(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[data-memory-search]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function toggleInactive(container: HTMLElement) {
  await act(async () => { container.querySelector<HTMLInputElement>('[data-memory-show-inactive] input[type="checkbox"]')!.click(); });
  await flush();
}

describe('MemoryPage filters', () => {
  it('sends each type to the server and replaces the rows, with all restoring the full active list', async () => {
    const container = await renderPage();
    const activeIds = entries.filter((entry) => entry.status === 'active').map((entry) => entry.id).sort();
    expect(rowIds(container)).toEqual(activeIds);
    for (const type of MEMORY_TYPES) {
      await selectType(container, type);
      expect(requests.at(-1)!.searchParams.get('type')).toBe(type);
      expect(rowIds(container)).toEqual([`m_${type}_match`, `m_${type}_other`]);
    }
    await selectType(container, 'all');
    expect(rowIds(container)).toEqual(activeIds);
    expect(requests[0]!.searchParams.has('type')).toBe(false);
  });

  it('combines each type and all with search and show archived', async () => {
    const container = await renderPage();
    await search(container, '  needle  ');
    for (const type of MEMORY_TYPES) {
      await selectType(container, type);
      expect(rowIds(container)).toEqual([`m_${type}_match`]);
      await toggleInactive(container);
      expect(rowIds(container)).toEqual([`m_${type}_archived`, `m_${type}_match`]);
      expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({ type, query: 'needle', include_inactive: 'true' });
      await toggleInactive(container);
    }
    await selectType(container, 'all');
    expect(rowIds(container)).toEqual(MEMORY_TYPES.map((type) => `m_${type}_match`).sort());
    await toggleInactive(container);
    expect(rowIds(container)).toEqual(entries.filter((entry) => entry.body.includes('Needle')).map((entry) => entry.id).sort());
    expect(requests.at(-1)!.searchParams.has('type')).toBe(false);
  });

  it('shows the filtered empty state and clears all filters back to the full list', async () => {
    const container = await renderPage();
    await selectType(container, 'reference');
    await toggleInactive(container);
    await search(container, 'absent');
    expect(rowIds(container)).toEqual([]);
    const empty = container.querySelector('[data-memory-empty]')!;
    expect(empty.textContent).toContain('Nothing matches these filters.');
    await act(async () => { empty.querySelector<HTMLButtonElement>('button')!.click(); });
    await flush();
    expect(container.querySelector('[data-memory-empty]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-memory-search]')!.value).toBe('');
    expect(container.querySelector('[data-memory-type-filter="all"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('[data-memory-show-inactive] input[type="checkbox"]')!.checked).toBe(false);
    expect(rowIds(container)).toEqual(entries.filter((entry) => entry.status === 'active').map((entry) => entry.id).sort());
  });
});

const workspace = { id: 'wd_current', name: 'Workshop', root: '/fixture/workshop', created_at: '2026-01-01', last_opened_at: '2026-01-01', session_count: 0, pinned: false, isGit: false } satisfies Workspace;
const enabledSettings: MemorySettings = { enabled: true, approval: 'auto', budget: 2000, workspaces: {} };
const fixtureEntry = (fields: Partial<MemoryEntry>): MemoryEntry => ({ ...entries[0]!, ...fields });
const sourceKey = (target: { scope: string; workspaceId?: string; personaId?: string }) => `${target.scope}:${target.workspaceId ?? ''}:${target.personaId ?? ''}`;
function seedMemories(data: Record<string, MemoryEntry[]>, settings = enabledSettings) {
  vi.spyOn(client, 'getMemorySettings').mockResolvedValue(settings);
  vi.spyOn(client, 'memoryJournal').mockResolvedValue([]);
  return vi.spyOn(client, 'listMemory').mockImplementation(async (target, query) => ({ items: (data[sourceKey(target)] ?? []).filter((entry) =>
    (query?.include_inactive || entry.status === 'active')
    && (query?.type === undefined || query.type === entry.type)
    && `${entry.title} ${entry.body}`.toLowerCase().includes(query?.query?.trim().toLowerCase() ?? '')) }));
}
function seedBot(shared?: ('global' | 'workspace')[]) {
  const snapshot: PersonaSnapshot = {
    definition: { id: 'lin-lan', name: 'Lin Lan', description: 'Release coordination', memory: shared === undefined ? undefined : { shared }, homeWorkspace: '/fixture/bot-home' },
    revision: 'persona_revision', examples: 'Keep this example.',
  };
  vi.mocked(client.listPersonas).mockResolvedValue([{ id: 'lin-lan', name: 'Lin Lan', archived: false, revision: snapshot.revision }]);
  listBots.mockResolvedValue([{ personaId: 'lin-lan', name: 'Lin Lan', homeSessionId: 'session_bot_home', hidden: true, pinned: false }]);
  vi.spyOn(client, 'getSession').mockResolvedValue({ id: 'session_bot_home', workspace_id: 'wd_home' } as Session);
  vi.spyOn(client, 'getPersona').mockResolvedValue(snapshot);
  return snapshot;
}
async function click(container: HTMLElement, selector: string) {
  const button = (selector.startsWith('[data-option-value=')
    ? document.querySelector<HTMLElement>(`[data-select-panel] ${selector}`)
    : container.querySelector<HTMLElement>(selector))!;
  expect(button).not.toBeNull();
  await act(async () => {
    await vi.waitFor(() => { expect((button as HTMLButtonElement).disabled).not.toBe(true); });
    button.click();
  });
  await flush();
}
function rawSnapshot(entry: MemoryEntry) {
  const { body, revision: _revision, ...metadata } = entry;
  return `---\n${JSON.stringify(metadata)}\n---\n${body}\n`;
}

describe('MemoryPage advisor switch', () => {
  const advisorRead = (mode: 'off' | 'rank') => ({
    ...enabledSettings, effective_enabled: true,
    advisor: { mode, selector: { protocol: 'chat_json' as const, model: 'cheap-judge' }, first_step_wait_ms: 1500, timeout_ms: 6000, max_calls_per_turn: 3, candidate_chars: 120, catalog_page_items: 40, max_catalog_pages: 2, max_full_units: 8, judge_input_tokens: 12000, apply_to_children: true, egress_ack: [] },
    advisor_status: { state: mode === 'off' ? 'off' as const : 'ready' as const, consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0 },
  });

  it('turns the advisor off from the header without touching the memory switch', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_global' })] });
    vi.spyOn(client, 'getMemoryAdvisorSettings').mockResolvedValue(advisorRead('rank'));
    const patch = vi.spyOn(client, 'patchMemoryAdvisorSettings').mockImplementation(async () => advisorRead('off'));
    const memoryPatch = vi.spyOn(client, 'patchMemorySettings');
    const container = await renderPage('/memory');
    const header = container.querySelector('[data-memory-advisor-header]')!;
    expect(header.querySelector('[data-memory-advisor-state]')?.textContent).toBe('Ready');
    await act(async () => { header.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await flush();
    expect(patch).toHaveBeenCalledWith({ advisor: { mode: 'off' } }, undefined);
    expect(memoryPatch).not.toHaveBeenCalled();
    expect(header.querySelector('[data-memory-advisor-state]')?.textContent).toBe('Off');
    // Memory itself stays on and the entries stay listed.
    expect(rowIds(container)).toEqual(['m_global']);
  });

  it('re-reads the advisor when memory is switched on here, instead of keeping its paused read', async () => {
    let memoryOn = false;
    seedMemories({ 'global::': [] }, { ...enabledSettings, enabled: false });
    vi.mocked(client.getMemorySettings).mockImplementation(async () => ({ ...enabledSettings, enabled: memoryOn }));
    vi.spyOn(client, 'patchMemorySettings').mockImplementation(async (patch) => { memoryOn = patch.enabled ?? memoryOn; return { ...enabledSettings, enabled: memoryOn }; });
    const advisorReads = vi.spyOn(client, 'getMemoryAdvisorSettings').mockImplementation(async () => {
      const read = advisorRead('rank');
      return memoryOn ? read : { ...read, enabled: false, effective_enabled: false, advisor_status: { ...read.advisor_status, state: 'disabled' as const } };
    });
    const { container, queryClient } = await mountPage('/memory');
    // A paused read is already cached, as the settings card would have left it.
    await act(async () => { await queryClient.fetchQuery({ queryKey: ['memory-settings', 'advisor', null], queryFn: () => client.getMemoryAdvisorSettings() }); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-memory-enable]')!.click(); });
    await flush();
    expect(advisorReads.mock.calls.length).toBeGreaterThan(1);
    expect(container.querySelector('[data-memory-advisor-header] [data-memory-advisor-state]')?.textContent).toBe('Ready');
  });

  it('sends an advisor still waiting for a source straight to Who decides', async () => {
    const read = advisorRead('rank');
    vi.spyOn(client, 'getMemoryAdvisorSettings').mockResolvedValue({ ...read, advisor: { ...read.advisor, selector: undefined } as never,
      advisor_status: { ...read.advisor_status, state: 'unconfigured' as const, reason: 'unconfigured' as const } });
    const onNavigate = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mounted.push({ root, container, queryClient });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><I18nProvider><MemoryAdvisorSwitch onNavigate={onNavigate} /></I18nProvider></QueryClientProvider>);
    });
    await flush();
    const setup = container.querySelector<HTMLButtonElement>('[data-memory-advisor-setup]')!;
    expect(setup.textContent).toBe('Choose a source');
    await act(async () => { setup.click(); });
    expect(onNavigate).toHaveBeenCalledWith('/settings/ai?tab=providers#st-card-decision-connections');
  });

  it('shows a failed switch as a retryable toast and keeps the saved state', async () => {
    seedMemories({ 'global::': [] });
    vi.spyOn(client, 'getMemoryAdvisorSettings').mockResolvedValue(advisorRead('rank'));
    vi.spyOn(client, 'patchMemoryAdvisorSettings').mockRejectedValue(new Error('config is read-only'));
    const container = await renderPage('/memory');
    const header = container.querySelector('[data-memory-advisor-header]')!;
    await act(async () => { header.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await flush();
    const toast = getToasts().at(-1);
    expect(toast?.text).toBe('Could not switch Memory Advisor: config is read-only');
    expect(toast?.retry).toBeDefined();
    expect(header.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });
});

describe('MemoryPage sources', () => {
  it('puts global first only for a workspace following global, and changing the switch updates the list', async () => {
    const global = fixtureEntry({ id: 'm_global', title: 'Global preference' });
    const own = fixtureEntry({ id: 'm_workspace', title: 'Workspace rule', pinned: true });
    seedMemories({ 'global::': [global], 'workspace:wd_current:': [own] });
    vi.spyOn(client, 'patchWorkspaceMemorySettings').mockImplementation(async (_id, enabled) => {
      vi.mocked(client.getMemorySettings).mockResolvedValue({ ...enabledSettings, workspaces: enabled === null ? {} : { wd_current: enabled } });
      return { workspace_id: workspace.id, enabled, effective_enabled: enabled !== false };
    });
    const container = await renderPage('/memory?workspace=wd_current', [workspace]);
    expect([...container.querySelectorAll('[data-memory-source]')].map((node) => node.getAttribute('data-memory-source'))).toEqual(['global', 'workspace:wd_current']);
    expect([...container.querySelectorAll('[data-memory-row]')].map((node) => node.getAttribute('data-memory-row'))).toEqual(['m_global', 'm_workspace']);
    await click(container, '[data-memory-ws-option="true"]');
    expect(rowIds(container)).toEqual(['m_workspace']);
    await click(container, '[data-memory-ws-option="false"]');
    expect(rowIds(container)).toEqual(['m_workspace']);
    expect(container.querySelector('[data-memory-scope-off]')).not.toBeNull();
    await click(container, '[data-memory-ws-option][data-memory-ws-option="null"]');
    expect(client.patchWorkspaceMemorySettings).toHaveBeenLastCalledWith(workspace.id, null);
    expect(container.querySelector('[data-memory-ws-option][data-memory-ws-option="null"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(await client.getMemorySettings()).toEqual(enabledSettings);
    expect(rowIds(container)).toEqual(['m_global', 'm_workspace']);
  });

  it('reaches a hidden Bot’s home memory through its workspace slice', async () => {
    seedBot([]);
    const list = seedMemories({
      'persona::lin-lan': [fixtureEntry({ id: 'm_persona', title: 'Personal preference' })],
      'persona_workspace:wd_home:lin-lan': [fixtureEntry({ id: 'm_home', title: 'Bot home rule' })],
      'global::': [fixtureEntry({ id: 'm_shared' })],
    });
    const container = await renderPage('/memory?persona=lin-lan', [workspace]);
    await flush();
    expect(container.querySelector('[data-memory-scope-kind]')?.getAttribute('data-memory-scope-kind')).toBe('persona');
    // Long-term stays long-term: the home slice is one picker step away, not projected.
    expect(rowIds(container)).toEqual(['m_persona']);
    expect(list.mock.calls.some(([target]) => target.scope === 'global')).toBe(false);
    expect(container.querySelector<HTMLInputElement>('#memory-share-global')!.checked).toBe(false);
    await click(container, '#memory-shard-picker');
    await click(container, '[data-option-value="wd_home"]');
    expect(rowIds(container)).toEqual(['m_home', 'm_persona']);
    expect(container.querySelector('[data-memory-source="workspace:wd_home/persona:lin-lan"]')?.textContent).toContain('Role · Lin Lan');
    await search(container, 'home rule');
    expect(rowIds(container)).toEqual(['m_home']);
    expect(list.mock.calls.slice(-2).every(([, query]) => query?.query === 'home rule')).toBe(true);
  });

  it('reflects default-on persona sharing and saves changes with the persona revision and unrelated fields intact', async () => {
    const snapshot = seedBot();
    seedMemories({
      'global::': [fixtureEntry({ id: 'm_global' })],
      'workspace:wd_home:': [fixtureEntry({ id: 'm_workspace' })],
      'persona::lin-lan': [fixtureEntry({ id: 'm_persona' })],
    });
    const put = vi.spyOn(client, 'putPersona').mockImplementation(async (input) => {
      const next = { ...input, revision: 'persona_next' };
      vi.mocked(client.getPersona).mockResolvedValue(next);
      return next;
    });
    const container = await renderPage('/memory?persona=lin-lan', [workspace]);
    await flush();
    expect([...container.querySelectorAll('[data-memory-source]')].map((node) => node.getAttribute('data-memory-source'))).toEqual(['global', 'workspace:wd_home', 'persona:lin-lan']);
    expect(container.querySelector<HTMLInputElement>('#memory-share-global')!.checked).toBe(true);
    await click(container, '#memory-share-global');
    expect(put).toHaveBeenCalledWith({ ...snapshot, definition: { ...snapshot.definition, memory: { shared: ['workspace'] } } });
    expect(rowIds(container)).toEqual(['m_persona', 'm_workspace']);
  });

  it('keeps duplicate ids in different namespaces distinct and writes to the selected source', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_same', title: 'Global body' })], 'workspace:wd_current:': [fixtureEntry({ id: 'm_same', title: 'Workspace body' })] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_same' }), operationId: 'op_pin' });
    const container = await renderPage('/memory?workspace=wd_current', [workspace]);
    await click(container, '[data-memory-source="global"] [data-memory-row]');
    expect(container.querySelector('[data-memory-detail]')?.textContent).toContain('Global body');
    await click(container, '[data-memory-pin]');
    expect(put.mock.calls[0]![0]).toEqual({ scope: 'global' });
    await click(container, '[data-memory-source="workspace:wd_current"] [data-memory-row]');
    expect(container.querySelector('[data-memory-detail]')?.textContent).toContain('Workspace body');
    expect(client.memoryJournal).toHaveBeenLastCalledWith({ scope: 'workspace', workspaceId: workspace.id }, 'm_same');
  });

  it('deduplicates the Bot home scope and treats persona policy separately from workspace enablement', () => {
    expect(memorySourceTargets('wd_home', 'lin-lan', 'wd_home', { ...enabledSettings, workspaces: { wd_home: true } }, [])).toEqual([
      { scope: 'persona', personaId: 'lin-lan' }, { scope: 'persona_workspace', personaId: 'lin-lan', workspaceId: 'wd_home' },
    ]);
    expect(memorySourceTargets('wd_home', 'lin-lan', 'wd_home', enabledSettings, ['global'])[0]).toEqual({ scope: 'global' });
    expect(memorySourceTargets('wd_home', undefined, undefined, { ...enabledSettings, workspaces: { wd_home: true } })).toEqual([{ scope: 'workspace', workspaceId: 'wd_home' }]);
  });
});

describe('MemoryPage history detail', () => {
  it('opens archived content and shows the full change in the history panel', async () => {
    const before = fixtureEntry({ id: 'm_history', title: 'Original rule', body: 'The full original body.\nSecond paragraph.', reason: 'Original reason', revision: 'rev_before' });
    const after = { ...before, status: 'archived' as const, reason: 'Retired after the migration.', revision: 'rev_after', updated: '2026-02-02T12:00:00Z' };
    seedMemories({ 'global::': [after] });
    const record: MemoryJournalRecord = { id: after.id, operationId: 'op_archive', action: 'archive', at: after.updated, writer: 'user', before: rawSnapshot(before), beforeRevision: before.revision, afterRevision: after.revision };
    vi.mocked(client.memoryJournal).mockResolvedValue([record]);
    const container = await renderPage();
    await toggleInactive(container);
    await click(container, '[data-memory-row="m_history"]');
    expect(container.querySelector('[data-memory-read-body]')?.textContent).toBe(before.body);
    expect(container.querySelector('[data-memory-editor]')).toBeNull();
    expect(container.querySelector('[data-memory-read-reason]')?.textContent).toBe(after.reason);
    await click(container, '[data-memory-history-record="op_archive"]');
    const panel = document.querySelector<HTMLElement>('[data-memory-history-detail="op_archive"]')!;
    expect(panel).not.toBeNull();
    const content = panel.textContent!;
    for (const value of ['rev_before → rev_after', 'Before this change', 'After this change', before.body, before.reason, after.reason, 'Global', '2026']) expect(content).toContain(value);
    const undo = vi.spyOn(client, 'undoMemory').mockResolvedValue({ entry: before });
    await click(container, '[data-memory-undo="op_archive"]');
    expect(undo).toHaveBeenCalledWith({ scope: 'global' }, 'op_archive');
    expect(vi.mocked(client.memoryJournal).mock.calls.length).toBeGreaterThan(1);
  });

  it('shows replacement provenance and reads the retirement reason from the replacement, not the old creation reason', async () => {
    const previous = fixtureEntry({ id: 'm_old', status: 'superseded', reason: 'Old creation reason', superseded_by: 'm_new' });
    const next = fixtureEntry({ id: 'm_new', title: 'Current rule', reason: 'The API changed.', supersedes: previous.id, supersedes_revision: previous.revision });
    seedMemories({ 'global::': [previous] });
    vi.spyOn(client, 'getMemory').mockResolvedValue({ ...next, reason: 'An unrelated later edit.', revision: 'rev_later' });
    vi.mocked(client.memoryJournal).mockImplementation(async (_target, id) => id === next.id ? [
      { id: next.id, operationId: 'op_supersede', action: 'supersede', at: next.updated, writer: 'agent', before: null, beforeRevision: null, afterRevision: next.revision },
      { id: next.id, operationId: 'op_edit', action: 'update', at: next.updated, writer: 'user', before: rawSnapshot(next), beforeRevision: next.revision, afterRevision: 'rev_later' },
    ] : []);
    const container = await renderPage();
    await toggleInactive(container);
    await click(container, '[data-memory-row]');
    expect(container.querySelector('[data-memory-detail]')?.textContent).toContain('Current rule');
    expect(container.querySelector('[data-memory-read-reason]')?.textContent).toBe('The API changed.');
  });

  it.each([false, true])('does not offer a no-op replacement link when the replacement is absent from its namespace (other namespace: %s)', async (otherNamespace) => {
    const previous = fixtureEntry({ id: 'm_old', title: 'Retired rule', status: 'superseded', superseded_by: 'm_new' });
    const next = fixtureEntry({ id: 'm_new', title: 'Replacement outside the list', reason: 'Replaced after migration.' });
    seedMemories({
      'global::': [previous],
      'workspace:wd_current:': otherNamespace ? [fixtureEntry({ id: next.id, title: 'Unrelated workspace rule' })] : [],
    });
    const get = vi.spyOn(client, 'getMemory').mockResolvedValue(next);
    vi.mocked(client.memoryJournal).mockImplementation(async (_target, id) => id === next.id ? [
      { id: next.id, operationId: 'op_supersede', action: 'supersede', at: next.updated, writer: 'agent', before: null, beforeRevision: null, afterRevision: next.revision },
    ] : []);
    const container = await renderPage('/memory?workspace=wd_current', [workspace]);
    await toggleInactive(container);
    await click(container, '[data-memory-source="global"] [data-memory-row="m_old"]');
    expect(get).toHaveBeenCalledWith({ scope: 'global' }, next.id);
    expect(container.querySelector<HTMLElement>('[data-memory-detail]')?.dataset['memoryDetail']).toBe(previous.id);
    expect(container.querySelector('[data-memory-detail]')?.textContent).toContain(next.title);
    expect(container.querySelector('[data-memory-read-reason]')?.textContent).toBe(next.reason);
    expect(container.querySelector('[data-memory-open-replacement]')).toBeNull();
  });

  it('opens a replacement when it is present in the same namespace', async () => {
    const previous = fixtureEntry({ id: 'm_old', status: 'superseded', superseded_by: 'm_new' });
    const next = fixtureEntry({ id: 'm_new', title: 'Current rule' });
    seedMemories({ 'global::': [previous, next] });
    vi.spyOn(client, 'getMemory').mockResolvedValue(next);
    const container = await renderPage();
    await toggleInactive(container);
    await click(container, '[data-memory-row="m_old"]');
    await click(container, '[data-memory-open-replacement]');
    expect(container.querySelector<HTMLElement>('[data-memory-detail]')?.dataset['memoryDetail']).toBe(next.id);
    expect(container.querySelector('[data-memory-read-body]')?.textContent).toBe(next.body);
  });

  it('reconstructs an older result by matching revision rather than journal position', async () => {
    const first = fixtureEntry({ id: 'm_history', body: 'First body', revision: 'rev_first' });
    const middle = { ...first, body: 'Intermediate body', revision: 'rev_middle' };
    const current = { ...first, body: 'Latest body', revision: 'rev_current' };
    seedMemories({ 'global::': [current] });
    vi.mocked(client.memoryJournal).mockResolvedValue([
      { id: first.id, action: 'update', operationId: 'op_first', at: first.updated, writer: 'agent', before: rawSnapshot(first), beforeRevision: first.revision, afterRevision: middle.revision },
      { id: first.id, action: 'undo', operationId: 'op_unrelated', at: first.updated, writer: 'user', before: null, beforeRevision: null, afterRevision: null },
      { id: first.id, action: 'update', operationId: 'op_next', at: first.updated, writer: 'agent', before: rawSnapshot(middle), beforeRevision: middle.revision, afterRevision: current.revision },
    ]);
    const container = await renderPage();
    await click(container, '[data-memory-row]');
    await click(container, '[data-memory-history-record="op_first"]');
    const content = document.querySelector('[data-memory-history-detail="op_first"]')!.textContent!;
    expect(content).toContain('Intermediate body');
    expect(content).toContain('First body');
    expect(content).not.toContain('Latest body');
    // The panel steps through the entry's records newest-first.
    const newer = document.querySelector<HTMLButtonElement>('[data-memory-history-nav="newer"]')!;
    const older = document.querySelector<HTMLButtonElement>('[data-memory-history-nav="older"]')!;
    expect(older.disabled).toBe(true);
    expect(newer.disabled).toBe(false);
    await act(async () => { newer.click(); });
    await flush();
    expect(document.querySelector('[data-memory-history-detail="op_unrelated"]')).not.toBeNull();
    expect(document.querySelector('[data-memory-history-detail="op_first"]')).toBeNull();
  });

  it('keeps the recorded basis and the writer apart, and invents neither', async () => {
    const human = fixtureEntry({ id: 'm_human', title: 'Report at decision points', basis: { kind: 'human', note: 'The user asked for this cadence.', refs: ['session_x#turn-6'] } });
    const derived = fixtureEntry({ id: 'm_derived', title: 'GPU schedule', basis: { kind: 'derived', note: 'Kiki worked the numbers out itself.' }, validity: { check: 'Check the current schedule first.' } });
    const plain = fixtureEntry({ id: 'm_plain', title: 'Written before the field existed' });
    seedMemories({ 'global::': [human, derived, plain] });
    const container = await renderPage('/memory');
    await click(container, '[data-memory-row="m_human"]');
    const read = container.querySelector('[data-memory-read="m_human"]')!;
    // The content basis and the session that last wrote it are two facts.
    expect(read.querySelector('[data-memory-basis="human"]')?.textContent).toContain('you asked for');
    expect(read.querySelector('[data-memory-basis-note]')?.textContent).toContain('cadence');
    expect(read.querySelector('[data-memory-basis-refs]')?.textContent).toContain('session_x#turn-6');
    expect(read.querySelector('[data-memory-validity-state]')?.getAttribute('data-memory-validity-state')).toBe('unrecorded');
    // An agent's write is not presented as the user's authorization.
    expect(read.textContent).not.toContain('asked for this cadence. by the user');
    await click(container, '[data-memory-detail-back]');

    await click(container, '[data-memory-row="m_derived"]');
    const checked = container.querySelector('[data-memory-read="m_derived"]')!;
    expect(checked.querySelector('[data-memory-basis="derived"]')?.textContent).toContain('inference');
    expect(checked.querySelector('[data-memory-validity-state="recheck"]')?.textContent).toContain('Check the current schedule first.');
    await click(container, '[data-memory-detail-back]');

    // An entry with no recorded basis says so, rather than claiming one.
    await click(container, '[data-memory-row="m_plain"]');
    expect(container.querySelector('[data-memory-read="m_plain"] [data-memory-basis="unrecorded"]')?.textContent).toContain('Not recorded');
  });

  it('marks the rows a reader must act on before relying on the content', async () => {
    const recheck = fixtureEntry({ id: 'm_recheck', title: 'Check me', validity: { check: 'Check the schedule.' } });
    const expired = fixtureEntry({ id: 'm_expired', title: 'Past its endpoint', validity: { check: 'Re-authorize.', until: '2026-01-01T00:00:00Z' } });
    const plain = fixtureEntry({ id: 'm_plain', title: 'No check recorded' });
    seedMemories({ 'global::': [recheck, expired, plain] });
    const container = await renderPage('/memory');
    const state = (id: string) => container.querySelector(`[data-memory-row="${id}"]`)?.getAttribute('data-memory-validity');
    expect(state('m_recheck')).toBe('recheck');
    expect(state('m_expired')).toBe('expired');
    expect(state('m_plain')).toBe('unrecorded');
    // Only the two actionable states earn a mark; a missing check is not a
    // defect the reader has to triage in the list.
    const marks = [...container.querySelectorAll('[data-memory-row-validity]')].map((node) => node.getAttribute('data-memory-row-validity'));
    expect(marks).toEqual(['recheck', 'expired']);
  });

  it('names the entry a consolidation retired this one into, and can open it', async () => {
    const kept = fixtureEntry({ id: 'm_kept', title: 'The retained rule' });
    const retired = fixtureEntry({ id: 'm_retired', title: 'The old rule', status: 'archived', covered_by: { id: 'm_kept', revision: 'rev_kept' } });
    seedMemories({ 'global::': [kept, retired] });
    vi.spyOn(client, 'getMemory').mockResolvedValue(kept);
    const container = await renderPage('/memory');
    await toggleInactive(container);
    await click(container, '[data-memory-row="m_retired"]');
    expect(container.querySelector('[data-memory-covered-by="m_kept"]')?.textContent).toContain('m_kept');
    await click(container, '[data-memory-open-covered]');
    expect(container.querySelector('[data-memory-read="m_kept"]')).not.toBeNull();
  });

  it('carries the recorded basis and check through an edit instead of dropping them', async () => {
    const entry = fixtureEntry({ id: 'm_edit', title: 'Editable rule', basis: { kind: 'human', note: 'The user set this.' }, validity: { check: 'Check before reuse.' } });
    seedMemories({ 'global::': [entry] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry, operationId: 'op_1', outcome: 'applied' });
    const container = await renderPage('/memory');
    await click(container, '[data-memory-row="m_edit"]');
    await click(container, '[data-memory-edit]');
    await fillDraft(container, 'Editable rule');
    const input = container.querySelector<HTMLTextAreaElement>('[data-memory-body]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Rewritten body.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenCalledWith({ scope: 'global' }, 'm_edit', expect.objectContaining({
      action: 'update', body: 'Rewritten body.',
      // Rewording a rule is not a change of the evidence behind it.
      basis: entry.basis, validity: entry.validity,
    }));
  });

  it('does not claim a save that changed nothing was a new version', async () => {
    const entry = fixtureEntry({ id: 'm_same', title: 'Unchanged rule' });
    seedMemories({ 'global::': [entry] });
    vi.spyOn(client, 'putMemory').mockResolvedValue({ entry, operationId: null, outcome: 'unchanged' });
    const container = await renderPage('/memory');
    await click(container, '[data-memory-row="m_same"]');
    await click(container, '[data-memory-edit]');
    const input = container.querySelector<HTMLInputElement>('[data-memory-reason]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Checking whether it already matches.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click(container, '[data-memory-save]');
    // The toast store is module state, so read it directly rather than through
    // the app shell this test does not mount.
    expect(getToasts().map((toast) => toast.text).join(' ')).toContain('did not change');
  });

  it('does not invent snapshots for missing or hand-edited metadata', () => {
    expect(memorySnapshot(null, null)).toBeUndefined();
    expect(memorySnapshot('---\ntitle: Hand edited\n---\nOriginal body', 'rev')).toBeUndefined();
    expect(memorySnapshot('---\n{}\n---\nOriginal body', 'rev')).toBeUndefined();
    const original = fixtureEntry({ body: 'Body\nwith lines.' });
    expect(memorySnapshot(rawSnapshot(original).replace(/\n/g, '\r\n'), original.revision)?.title).toBe(original.title);
  });
});

describe('MemoryPage scope switcher', () => {
  // The hundred-plus listing the App-level query hands the page: catalog rows
  // carry no `session_count` / `isGit`, and the picker still searches and scopes.
  const manyWorkspaces = Array.from({ length: 120 }, (_, index) => ({
    id: `wd_${String(index).padStart(3, '0')}`,
    name: index === 42 ? 'docs-site' : `project-${String(index).padStart(3, '0')}`,
    root: `/fixture/ws/${index}`,
    created_at: '2026-01-01',
    last_opened_at: '2026-01-01',
    pinned: false,
  } satisfies WorkspaceCatalogEntry));

  const scopeKind = (container: HTMLElement) => container.querySelector('[data-memory-scope-kind]')?.getAttribute('data-memory-scope-kind');
  const sourceKeys = (container: HTMLElement) => [...container.querySelectorAll('[data-memory-source]')].map((node) => node.getAttribute('data-memory-source'));

  async function typeCombobox(container: HTMLElement, value: string) {
    const input = document.querySelector<HTMLInputElement>('[data-select-panel] input[role="combobox"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
  }

  it('defaults to global: fixed kind labels and no object row', async () => {
    const container = await renderPage();
    expect(scopeKind(container)).toBe('global');
    expect(container.querySelector('[data-memory-kind="global"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-memory-kind="global"]')?.textContent).toContain('Global');
    expect(container.querySelector('[data-memory-kind="workspace"]')?.textContent).toContain('Workspace');
    expect(container.querySelector('[data-memory-kind="persona"]')?.textContent).toContain('Persona');
    expect(container.querySelector('[data-memory-scope-target]')).toBeNull();
    expect(container.querySelector('#memory-workspace-picker')).toBeNull();
    expect(container.querySelector('[data-memory-workspace-switch]')).toBeNull();
  });

  it('searches a hundred-plus workspace list and picks one', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_shared' })], 'workspace:wd_042:': [fixtureEntry({ id: 'm_docs' })] });
    const container = await renderPage('/memory', manyWorkspaces);
    await click(container, '[data-memory-kind="workspace"]');
    expect(scopeKind(container)).toBe('workspace');
    await click(container, '#memory-workspace-picker');
    expect(document.querySelectorAll('[data-select-panel] [data-option-value]').length).toBe(120);
    await typeCombobox(container, 'docs');
    expect(document.querySelectorAll('[data-select-panel] [data-option-value]').length).toBe(1);
    await click(container, '[data-option-value="wd_042"]');
    expect(scopeKind(container)).toBe('workspace');
    expect(container.querySelector('[data-memory-workspace-switch]')).not.toBeNull();
    expect(sourceKeys(container)).toEqual(['global', 'workspace:wd_042']);
    expect(rowIds(container)).toEqual(['m_docs', 'm_shared']);
    // The kind label stays fixed; the picked object shows on the row-2 picker.
    expect(container.querySelector('[data-memory-kind="workspace"]')?.textContent).toContain('Workspace');
    expect(container.querySelector('#memory-workspace-picker')?.textContent).toContain('docs-site');
  });

  it('keeps workspace and persona mutually exclusive', async () => {
    seedBot();
    seedMemories({ 'global::': [], 'workspace:wd_current:': [], 'workspace:wd_home:': [], 'persona::lin-lan': [] });
    const container = await renderPage('/memory?workspace=wd_current', [workspace]);
    expect(scopeKind(container)).toBe('workspace');
    await click(container, '[data-memory-kind="persona"]');
    expect(scopeKind(container)).toBe('persona');
    expect(container.querySelector('#memory-persona-picker')).not.toBeNull();
    expect(container.querySelector('[data-memory-workspace-switch]')).toBeNull();
    await click(container, '[data-memory-kind="workspace"]');
    expect(scopeKind(container)).toBe('workspace');
    expect(container.querySelector('#memory-persona-picker')).toBeNull();
    expect(container.querySelector('[data-memory-kind="persona"]')?.textContent).toContain('Persona');
    await click(container, '[data-memory-kind="global"]');
    expect(scopeKind(container)).toBe('global');
    expect(container.querySelector('[data-memory-scope-target]')).toBeNull();
  });

  it('persona scope defaults to long-term memory and narrows to a workspace slice', async () => {
    seedBot([]);
    seedMemories({
      'persona::lin-lan': [fixtureEntry({ id: 'm_persona' })],
      'persona_workspace:wd_home:lin-lan': [fixtureEntry({ id: 'm_home' })],
      'persona_workspace:wd_current:lin-lan': [fixtureEntry({ id: 'm_current' })],
      'workspace:wd_current:': [fixtureEntry({ id: 'm_ws' })],
      'global::': [],
    });
    const container = await renderPage('/memory?persona=lin-lan', [workspace]);
    await flush();
    expect(scopeKind(container)).toBe('persona');
    // Long-term by default: no persona_workspace slice leaks in, not even the Bot's home.
    expect(rowIds(container)).toEqual(['m_persona']);
    await click(container, '#memory-shard-picker');
    await click(container, '[data-option-value="wd_current"]');
    expect(scopeKind(container)).toBe('persona');
    expect(rowIds(container)).toEqual(['m_current', 'm_persona']);
    await click(container, '#memory-shard-picker');
    await typeCombobox(container, 'long');
    await click(container, '[data-option-value=""]');
    expect(rowIds(container)).toEqual(['m_persona']);
  });

  it('keeps three kinds for empty directories and shows disabled object pickers instead of a writable fallback', async () => {
    const list = seedMemories({ 'global::': [fixtureEntry({ id: 'm_global' })] });
    const container = await renderPage();
    expect([...container.querySelectorAll('[data-memory-kind]')].map((node) => node.getAttribute('data-memory-kind'))).toEqual(['global', 'workspace', 'persona']);
    await click(container, '[data-memory-kind="workspace"]');
    expect(scopeKind(container)).toBe('workspace');
    expect(container.querySelector<HTMLButtonElement>('#memory-workspace-picker')?.disabled).toBe(true);
    expect(container.querySelector('[data-memory-scope-empty]')?.textContent).toBe('No workspaces yet.');
    expect(routeParams(container).has('workspace')).toBe(false);
    expect(container.querySelector('[data-memory-new]')).toBeNull();
    await click(container, '[data-memory-kind="persona"]');
    expect(scopeKind(container)).toBe('persona');
    expect(container.querySelector<HTMLButtonElement>('#memory-persona-picker')?.disabled).toBe(true);
    expect(container.querySelector('[data-memory-scope-empty]')?.textContent).toBe('No personas yet.');
    expect(container.querySelector('[data-memory-new]')).toBeNull();
    expect(list.mock.calls.every(([target]) => target.scope === 'global')).toBe(true);
  });

  it('treats an empty workspace URL parameter as global even with an empty directory', async () => {
    const list = seedMemories({ 'global::': [fixtureEntry({ id: 'm_global' })] });
    const container = await renderPage('/memory?workspace=');
    expect(scopeKind(container)).toBe('global');
    expect(rowIds(container)).toEqual(['m_global']);
    expect(list.mock.calls.every(([target]) => target.scope === 'global')).toBe(true);
  });

  it('treats an empty persona workspace URL parameter as long-term rather than an empty-id slice', async () => {
    seedBot([]);
    const list = seedMemories({ 'persona::lin-lan': [fixtureEntry({ id: 'm_persona' })] });
    const container = await renderPage('/memory?persona=lin-lan&workspace=', [workspace]);
    expect(scopeKind(container)).toBe('persona');
    expect(rowIds(container)).toEqual(['m_persona']);
    expect(list.mock.calls.every(([target]) => target.scope === 'persona')).toBe(true);
    expect(container.querySelector('#memory-shard-picker')?.textContent).toContain('Long-term');
  });

  it.each([
    { id: 'wd_removed', workspaces: [workspace] },
    { id: 'garbage-range', workspaces: [] },
  ])('falls back to persona long-term for unknown range $id and can read and write a valid slice afterwards', async ({ id, workspaces }) => {
    seedBot([]);
    const list = seedMemories({
      'persona::lin-lan': [fixtureEntry({ id: 'm_persona' })],
      [`persona_workspace:${id}:lin-lan`]: [fixtureEntry({ id: 'm_unknown' })],
      'persona_workspace:wd_home:lin-lan': [fixtureEntry({ id: 'm_home' })],
      'persona_workspace:wd_current:lin-lan': [fixtureEntry({ id: 'm_current' })],
    });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_created' }), operationId: 'op_create' });
    const container = await renderPage(`/memory?persona=lin-lan&workspace=${id}`, workspaces);
    expect(scopeKind(container)).toBe('persona');
    expect(container.querySelector('[data-memory-kind="persona"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('#memory-shard-picker')?.textContent).toContain('Long-term');
    expect(rowIds(container)).toEqual(['m_persona']);
    expect(list.mock.calls.every(([target]) => target.scope === 'persona' && target.personaId === 'lin-lan')).toBe(true);

    const createMemory = async () => {
      await click(container, '[data-memory-new]');
      await act(async () => {
        const title = container.querySelector<HTMLInputElement>('[data-memory-title]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'A new rule');
        title.dispatchEvent(new Event('input', { bubbles: true }));
        const body = container.querySelector<HTMLTextAreaElement>('[data-memory-body]')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(body, 'Keep the selected namespace.');
        body.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click(container, '[data-memory-save]');
    };
    await createMemory();
    expect(put).toHaveBeenLastCalledWith({ scope: 'persona', personaId: 'lin-lan' }, 'new', expect.objectContaining({ action: 'create' }));
    const validId = workspaces.length === 0 ? 'wd_home' : workspace.id;
    await click(container, '#memory-shard-picker');
    await click(container, `[data-option-value="${validId}"]`);
    expect(routeParams(container).get('workspace')).toBe(validId);
    expect(rowIds(container)).toEqual(validId === 'wd_home' ? ['m_home', 'm_persona'] : ['m_current', 'm_persona']);
    await createMemory();
    expect(put).toHaveBeenLastCalledWith({ scope: 'persona_workspace', personaId: 'lin-lan', workspaceId: validId }, 'new', expect.objectContaining({ action: 'create' }));
    expect(list.mock.calls.some(([target]) => target.workspaceId === id)).toBe(false);
    expect(put.mock.calls.some(([target]) => target.workspaceId === id)).toBe(false);
  });

  it.each(['wd_removed', ''])('falls back to global for an invalid workspace deep link %s in a loaded directory', async (id) => {
    const list = seedMemories({ 'global::': [fixtureEntry({ id: 'm_global' })] });
    const container = await renderPage(`/memory?workspace=${id}`, [workspace]);
    expect(scopeKind(container)).toBe('global');
    expect(rowIds(container)).toEqual(['m_global']);
    expect(container.querySelector('#memory-workspace-picker')).toBeNull();
    expect(list.mock.calls.every(([target]) => target.scope === 'global')).toBe(true);
    await click(container, '[data-memory-kind="workspace"]');
    expect(scopeKind(container)).toBe('workspace');
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
  });

  it.each([
    { personaId: 'removed-persona', workspaceId: undefined, expectedKind: 'global' },
    { personaId: '', workspaceId: undefined, expectedKind: 'global' },
    { personaId: 'removed-persona', workspaceId: 'wd_current', expectedKind: 'workspace' },
    { personaId: 'removed-persona', workspaceId: 'wd_removed', expectedKind: 'global' },
    { personaId: 'archived-persona', workspaceId: undefined, expectedKind: 'global' },
  ])('recovers invalid persona $personaId and workspace $workspaceId to the actual namespace', async ({ personaId, workspaceId, expectedKind }) => {
    vi.mocked(client.listPersonas).mockResolvedValue([{ id: 'archived-persona', name: 'Archived persona', archived: true, revision: 'rev_archived' }]);
    const list = seedMemories({
      'global::': [fixtureEntry({ id: 'm_global' })],
      'workspace:wd_current:': [fixtureEntry({ id: 'm_workspace' })],
      'workspace:wd_removed:': [fixtureEntry({ id: 'm_wrong_namespace' })],
    });
    const params = new URLSearchParams({ persona: personaId });
    if (workspaceId !== undefined) params.set('workspace', workspaceId);
    const container = await renderPage(`/memory?${params}`, [workspace]);
    expect(scopeKind(container)).toBe(expectedKind);
    expect(container.querySelector('#memory-persona-picker')).toBeNull();
    expect(rowIds(container)).toEqual(expectedKind === 'workspace' ? ['m_global', 'm_workspace'] : ['m_global']);
    expect(list.mock.calls.some(([target]) => target.workspaceId === 'wd_removed')).toBe(false);
    await click(container, '[data-memory-kind="global"]');
    expect(routeParams(container).has('persona')).toBe(false);
    expect(routeParams(container).has('workspace')).toBe(false);
  });

  it('restores an out-of-directory Bot home deep link as a persona slice and preserves unrelated URL params', async () => {
    seedBot([]);
    const list = seedMemories({
      'persona::lin-lan': [fixtureEntry({ id: 'm_persona' })],
      'persona_workspace:wd_home:lin-lan': [fixtureEntry({ id: 'm_home' })],
    });
    const container = await renderPage('/memory?persona=lin-lan&workspace=wd_home&origin=example', [workspace]);
    expect(scopeKind(container)).toBe('persona');
    expect(rowIds(container)).toEqual(['m_home', 'm_persona']);
    expect(container.querySelector('#memory-shard-picker')?.textContent).toContain('Home workspace');
    expect(list.mock.calls.every(([target]) => target.personaId === 'lin-lan')).toBe(true);
    await click(container, '[data-memory-kind="workspace"]');
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
    expect(routeParams(container).has('persona')).toBe(false);
    expect(routeParams(container).get('origin')).toBe('example');
    await click(container, '[data-route-back]');
    expect(scopeKind(container)).toBe('persona');
    expect(routeParams(container).get('workspace')).toBe('wd_home');
    expect(rowIds(container)).toEqual(['m_home', 'm_persona']);
    await click(container, '[data-memory-kind="global"]');
    expect([...routeParams(container)]).toEqual([['origin', 'example']]);
  });

  it('does not commit an empty workspace search result and recovers the option list after clearing the query', async () => {
    seedMemories({ 'global::': [], 'workspace:wd_current:': [] });
    const container = await renderPage('/memory?workspace=wd_current', [workspace]);
    await click(container, '#memory-workspace-picker');
    await typeCombobox(container, 'not-a-workspace');
    expect(document.querySelectorAll('[data-select-panel] [data-option-value]').length).toBe(0);
    expect(document.querySelector('[data-select-panel] [role="listbox"]')?.textContent).toContain('not-a-workspace');
    const input = document.querySelector<HTMLInputElement>('[data-select-panel] input[role="combobox"]')!;
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
    expect(container.querySelector('#memory-workspace-picker')?.getAttribute('aria-expanded')).toBe('true');
    await typeCombobox(container, '');
    expect(document.querySelectorAll('[data-select-panel] [data-option-value]').length).toBe(1);
    await click(container, '[data-option-value="wd_current"]');
    expect(container.querySelector('#memory-workspace-picker')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('waits for the persona directory before restoring a persona deep link without requesting another namespace', async () => {
    seedBot([]);
    const personaList = [{ id: 'lin-lan', name: 'Lin Lan', archived: false, revision: 'persona_revision' }];
    let resolvePersonas!: (items: typeof personaList) => void;
    vi.mocked(client.listPersonas).mockReturnValue(new Promise((resolve) => { resolvePersonas = resolve; }));
    const list = seedMemories({
      'persona::lin-lan': [fixtureEntry({ id: 'm_persona' })],
      'persona_workspace:wd_current:lin-lan': [fixtureEntry({ id: 'm_current' })],
    });
    const container = await renderPage('/memory?persona=lin-lan&workspace=wd_current', [workspace]);
    expect(list).not.toHaveBeenCalled();
    expect(container.querySelector('[data-memory-new]')).toBeNull();
    expect(scopeKind(container)).toBe('persona');
    expect(container.querySelector('[data-memory-kind="persona"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-memory-kind="persona"]')?.textContent).toContain('Persona');
    expect(routeParams(container).get('persona')).toBe('lin-lan');
    await act(async () => { resolvePersonas(personaList); });
    await flush();
    expect(scopeKind(container)).toBe('persona');
    expect(container.querySelector('[data-memory-kind="persona"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('#memory-persona-picker')?.textContent).toContain('Lin Lan');
    expect(rowIds(container)).toEqual(['m_current', 'm_persona']);
    expect(list.mock.calls.every(([target]) => target.personaId === 'lin-lan')).toBe(true);
  });

  it('resets filters, detail and new drafts when changing namespaces, and Back restores the workspace URL', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_global' })], 'workspace:wd_current:': [fixtureEntry({ id: 'm_workspace' })] });
    const container = await renderPage('/memory?workspace=wd_current', [workspace]);
    await selectType(container, entries[0]!.type);
    await search(container, 'needle');
    await toggleInactive(container);
    await click(container, '[data-memory-row="m_workspace"]');
    expect(container.querySelector('[data-memory-detail]')).not.toBeNull();
    await click(container, '[data-memory-new]');
    expect(container.querySelector('[data-memory-editor="new"]')).not.toBeNull();
    await click(container, '[data-memory-kind="global"]');
    expect(rowIds(container)).toEqual(['m_global']);
    expect(container.querySelector('[data-memory-detail]')).toBeNull();
    expect(container.querySelector('[data-memory-editor]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-memory-search]')!.value).toBe('');
    expect(container.querySelector('[data-memory-type-filter="all"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('[data-memory-show-inactive] input[type="checkbox"]')!.checked).toBe(false);
    await click(container, '[data-route-back]');
    expect(scopeKind(container)).toBe('workspace');
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
    expect(rowIds(container)).toEqual(['m_global', 'm_workspace']);
    expect(container.querySelector('[data-memory-editor]')).toBeNull();
  });
});

describe('MemoryPage empty states', () => {
  it('treats whitespace-only search as no filter and omits the URL query parameter', async () => {
    const activeIds = entries.filter((entry) => entry.status === 'active').map((entry) => entry.id).toSorted();
    const container = await renderPage();
    await search(container, '   ');
    expect(requests.at(-1)!.searchParams.has('query')).toBe(false);
    expect(rowIds(container)).toEqual(activeIds);
    await search(container, '');
    expect(rowIds(container)).toEqual(activeIds);
  });

  it('offers a new memory from an empty namespace and returns to the unfiltered empty state', async () => {
    seedMemories({ 'global::': [] });
    const container = await renderPage();
    const empty = container.querySelector('[data-memory-empty]')!;
    expect(empty).not.toBeNull();
    expect(empty.textContent).not.toContain('Nothing matches these filters.');
    expect(empty.querySelector('button')).toBeNull();
    await search(container, '   ');
    expect(container.querySelector('[data-memory-empty] button')).toBeNull();
    await click(container, '[data-memory-new]');
    expect(container.querySelector('[data-memory-empty]')).toBeNull();
    expect(container.querySelector('[data-memory-editor]')).not.toBeNull();
    await click(container, '[data-memory-detail-back]');
    expect(container.querySelector('[data-memory-editor]')).toBeNull();
    expect(container.querySelector('[data-memory-empty]')).not.toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function fillDraft(container: HTMLElement, title = 'Keep this draft') {
  await act(async () => {
    for (const [selector, value] of [['[data-memory-title]', title], ['[data-memory-body]', 'Write only to the selected range.']]) {
      const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector!)!;
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

const kindNames = (container: HTMLElement) => [...container.querySelectorAll('[data-memory-kind]')].map((node) => node.getAttribute('data-memory-kind'));

describe('MemoryPage pending range regressions', () => {
  it('waits for a legal persona workspace deep link before listing or creating, then keeps its draft across directory refresh', async () => {
    seedBot([]);
    const list = seedMemories({ 'persona::lin-lan': [], 'persona_workspace:wd_current:lin-lan': [fixtureEntry({ id: 'm_current' })] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_created' }), operationId: 'op_create' });
    const { container, rerender } = await mountPage('/memory?persona=lin-lan&workspace=wd_current', [], true);
    expect(kindNames(container)).toEqual(['global', 'workspace', 'persona']);
    expect(container.querySelector('#memory-shard-picker')?.textContent).toContain('Loading workspaces');
    expect(container.querySelector('#memory-shard-picker')?.textContent).not.toContain('Long-term');
    expect(list).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(container.querySelector('[data-memory-new]')).toBeNull();
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
    await rerender([workspace]);
    expect(rowIds(container)).toEqual(['m_current']);
    expect(container.querySelector('#memory-shard-picker')?.textContent).toContain(workspace.name);
    await click(container, '[data-memory-new]');
    await fillDraft(container);
    const editor = container.querySelector('[data-memory-editor]');
    await rerender([workspace], true);
    await rerender([workspace]);
    expect(container.querySelector('[data-memory-editor]')).toBe(editor);
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Keep this draft');
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenLastCalledWith({ scope: 'persona_workspace', personaId: 'lin-lan', workspaceId: workspace.id }, 'new', expect.objectContaining({ action: 'create' }));
    expect(list.mock.calls.every(([target]) => target.personaId === 'lin-lan')).toBe(true);
  });

  it('shows a recoverable directory error after pending and retries the shared App query without reading or writing the fallback', async () => {
    seedBot([]);
    const list = seedMemories({ 'persona_workspace:wd_current:lin-lan': [fixtureEntry({ id: 'm_current' })] });
    const put = vi.spyOn(client, 'putMemory');
    const directory = deferred<Awaited<ReturnType<KikiClient['listWorkspaceCatalog']>>>();
    const readDirectory = vi.spyOn(client, 'listWorkspaceCatalog').mockReturnValueOnce(directory.promise).mockResolvedValue({ items: [workspace] });
    const { container } = await mountPage('/memory?persona=lin-lan&workspace=wd_current', [], false, true);
    expect(list).not.toHaveBeenCalled();
    await act(async () => { directory.reject(new Error('Directory unavailable')); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Directory unavailable');
    expect(container.querySelector('[data-memory-scope-loading]')).toBeNull();
    expect(container.querySelector('[data-memory-new]')).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    await click(container, '[data-memory-scope-retry]');
    expect(readDirectory).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rowIds(container)).toEqual(['m_current']);
    expect(container.querySelector('#memory-shard-picker')?.textContent).toContain(workspace.name);
    expect(list.mock.calls.some(([target]) => target.workspaceId === workspace.id)).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it('falls back only after a pending range is proven unknown in the loaded directory', async () => {
    seedBot([]);
    const list = seedMemories({ 'persona::lin-lan': [fixtureEntry({ id: 'm_persona' })] });
    const { container, rerender } = await mountPage('/memory?persona=lin-lan&workspace=wd_removed', [], true);
    expect(list).not.toHaveBeenCalled();
    await rerender([workspace]);
    expect(rowIds(container)).toEqual(['m_persona']);
    expect(container.querySelector('#memory-shard-picker')?.textContent).toContain('Long-term');
    expect(list.mock.calls.every(([target]) => target.scope === 'persona')).toBe(true);
  });

  it('keeps a chosen valid object and its draft when the earlier pending range arrives', async () => {
    seedBot([]);
    const list = seedMemories({ 'persona::lin-lan': [], 'persona_workspace:wd_current:lin-lan': [] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_created' }), operationId: 'op_create' });
    const { container, rerender } = await mountPage('/memory?persona=lin-lan&workspace=wd_later', [workspace], true);
    expect(list).not.toHaveBeenCalled();
    await click(container, '#memory-shard-picker');
    await click(container, '[data-option-value="wd_current"]');
    await click(container, '[data-memory-new]');
    await fillDraft(container);
    await rerender([workspace, { ...workspace, id: 'wd_later', name: 'Later project' }]);
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Keep this draft');
    await click(container, '[data-memory-save]');
    expect(put.mock.calls.every(([target]) => target.workspaceId === workspace.id)).toBe(true);
    expect(list.mock.calls.some(([target]) => target.workspaceId === 'wd_later')).toBe(false);
  });

  it('does not restore an obsolete pending URL after switching to global and back while loading', async () => {
    seedBot([]);
    const list = seedMemories({ 'global::': [], 'persona::lin-lan': [], 'persona_workspace:wd_current:lin-lan': [] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_created' }), operationId: 'op_create' });
    const { container, rerender } = await mountPage('/memory?persona=lin-lan&workspace=wd_current', [], true);
    expect(list).not.toHaveBeenCalled();
    await click(container, '[data-memory-kind="global"]');
    await click(container, '[data-memory-new]');
    await fillDraft(container);
    await rerender([workspace]);
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Keep this draft');
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenLastCalledWith({ scope: 'global' }, 'new', expect.anything());
    expect(list.mock.calls.every(([target]) => target.scope === 'global')).toBe(true);
    await click(container, '[data-route-back]');
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
    await click(container, '[data-memory-new]');
    await fillDraft(container);
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenLastCalledWith({ scope: 'persona_workspace', personaId: 'lin-lan', workspaceId: workspace.id }, 'new', expect.anything());
  });

  it.each([undefined, 'wd_home'])('does not block persona range %s on an unrelated directory and preserves a legal Bot-home draft', async (range) => {
    seedBot([]);
    const list = seedMemories({ 'persona::lin-lan': [], 'persona_workspace:wd_home:lin-lan': [] });
    const { container, rerender } = await mountPage(`/memory?persona=lin-lan${range === undefined ? '' : `&workspace=${range}`}`, [], true);
    expect(container.querySelector('[data-memory-new]')).not.toBeNull();
    await click(container, '[data-memory-new]');
    await fillDraft(container);
    await rerender([workspace]);
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Keep this draft');
    expect(list.mock.calls.some(([target]) => target.scope === 'persona_workspace')).toBe(range !== undefined);
  });

  it('distinguishes loading, empty, and populated object controls while keeping all three kinds', async () => {
    seedMemories({ 'global::': [], 'workspace:wd_current:': [] });
    const personas = deferred<Awaited<ReturnType<KikiClient['listPersonas']>>>();
    vi.mocked(client.listPersonas).mockReturnValue(personas.promise);
    const { container, rerender } = await mountPage('/memory', [], true);
    expect(kindNames(container)).toEqual(['global', 'workspace', 'persona']);
    expect(container.querySelector('[data-memory-new]')).not.toBeNull();
    await click(container, '[data-memory-kind="workspace"]');
    expect(container.querySelector('#memory-workspace-picker')?.textContent).toContain('Loading workspaces');
    expect(container.querySelector('[data-memory-new]')).toBeNull();
    await rerender([]);
    expect(container.querySelector('#memory-workspace-picker')?.textContent).toContain('No workspaces yet.');
    await rerender([workspace]);
    await click(container, '#memory-workspace-picker');
    await click(container, '[data-option-value="wd_current"]');
    expect(container.querySelector('#memory-workspace-picker')?.textContent).toContain(workspace.name);
    await click(container, '[data-memory-kind="persona"]');
    expect(container.querySelector('#memory-persona-picker')?.textContent).toContain('Loading personas');
    await act(async () => { personas.resolve([]); });
    await flush();
    expect(container.querySelector('#memory-persona-picker')?.textContent).toContain('No personas yet.');
    expect(kindNames(container)).toEqual(['global', 'workspace', 'persona']);
    expect(container.querySelector('[data-memory-new]')).toBeNull();
  });

  it('does not let a failed persona directory block global memory', async () => {
    const list = seedMemories({ 'global::': [fixtureEntry({ id: 'm_global' })] });
    vi.mocked(client.listPersonas).mockRejectedValue(new Error('Persona directory unavailable'));
    const container = await renderPage();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rowIds(container)).toEqual(['m_global']);
    expect(list.mock.calls.every(([target]) => target.scope === 'global')).toBe(true);
  });

  it.each([undefined, 'wd_removed'])('waits for a workspace deep link, then uses the loaded-directory result (%s)', async (unknown) => {
    const id = unknown ?? workspace.id;
    const list = seedMemories({ 'global::': [], 'workspace:wd_current:': [] });
    const { container, rerender } = await mountPage(`/memory?workspace=${id}`, [], true);
    expect(list).not.toHaveBeenCalled();
    expect(container.querySelector('[data-memory-workspace-switch]')).toBeNull();
    expect(container.querySelector('[data-memory-new]')).toBeNull();
    await rerender([workspace]);
    expect(container.querySelector('[data-memory-scope-kind]')?.getAttribute('data-memory-scope-kind')).toBe(unknown === undefined ? 'workspace' : 'global');
    expect(list.mock.calls.some(([target]) => target.workspaceId === 'wd_removed')).toBe(false);
  });
});

describe('MemoryPage replacement loading', () => {
  it.each([true, false])('hides raw replacement ids while pending, then preserves the real link decision (found: %s)', async (found) => {
    const previous = fixtureEntry({ id: 'm_old', status: 'superseded', superseded_by: 'm_internal_replacement' });
    const next = fixtureEntry({ id: 'm_internal_replacement', title: 'Readable replacement title' });
    seedMemories({ 'global::': [previous, next] });
    const replacement = deferred<MemoryEntry>();
    const get = vi.spyOn(client, 'getMemory').mockReturnValue(replacement.promise);
    const container = await renderPage();
    await toggleInactive(container);
    await click(container, '[data-memory-row="m_old"]');
    expect(get).toHaveBeenCalledWith({ scope: 'global' }, next.id);
    expect(container.querySelector('[data-memory-replacement-text]')?.textContent).toContain('Loading memory');
    expect(container.querySelector('[data-memory-replacement-text]')?.textContent).not.toContain(next.id);
    expect(container.querySelector('[data-memory-open-replacement]')).toBeNull();
    await act(async () => { if (found) replacement.resolve(next); else replacement.reject(new Error('Not in this namespace')); });
    await flush();
    if (found) {
      expect(container.querySelector('[data-memory-open-replacement]')?.textContent).toContain(next.title);
      await click(container, '[data-memory-open-replacement]');
      expect(container.querySelector('[data-memory-detail]')?.getAttribute('data-memory-detail')).toBe(next.id);
    } else {
      expect(container.querySelector('[data-memory-open-replacement]')).toBeNull();
      expect(container.querySelector('[data-memory-replacement-text]')?.textContent).toContain(next.id);
    }
  });
});

/**
 * An unsaved memory draft is a draft like any other: it reports itself to the
 * guard the shell already owns, it survives a read-back that brings a newer
 * revision, and it is measured against the revision it started from.
 */
describe('MemoryPage editor draft', () => {
  it('reports the editor to the app-wide guard as soon as a field is typed', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_open', title: 'Open this' })] });
    const { container } = await mountGuardedPage();
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('false');

    await click(container, '[data-memory-row="m_open"]');
    await click(container, '[data-memory-edit]');
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('false');

    await fillDraft(container);
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('true');

    // Putting the stored text back is not a change any more.
    await click(container, '[data-memory-discard]');
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('false');
  });

  it('asks before switching entries or going back, and keeps the draft when the reader cancels', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_one', title: 'First' }), fixtureEntry({ id: 'm_two', title: 'Second' })] });
    const { container } = await mountGuardedPage();
    await click(container, '[data-memory-row="m_one"]');
    await click(container, '[data-memory-edit]');
    await fillDraft(container, 'Unsaved draft');

    // Choosing another entry would unmount the editor.
    await click(container, '[data-memory-row="m_two"]');
    expect(container.querySelector('[data-guard-pending]')?.textContent).toBe('true');
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Unsaved draft');
    await click(container, '[data-guard-cancel]');
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Unsaved draft');

    // Accepting leaves, and the draft is gone because the reader said so.
    await click(container, '[data-memory-row="m_two"]');
    await click(container, '[data-guard-confirm]');
    expect(container.querySelector('[data-guard-pending]')?.textContent).toBe('false');
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')).toBeNull();
    expect(container.querySelector('[data-memory-detail]')?.getAttribute('data-memory-detail')).toBe('m_two');
  });

  it('asks before Back leaves the editor, the same way', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_one', title: 'First' })] });
    const { container } = await mountGuardedPage();
    await click(container, '[data-memory-row="m_one"]');
    await click(container, '[data-memory-edit]');
    await fillDraft(container, 'Unsaved draft');

    await click(container, '[data-memory-detail-back]');
    expect(container.querySelector('[data-guard-pending]')?.textContent).toBe('true');
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Unsaved draft');
    await click(container, '[data-guard-confirm]');
    expect(container.querySelector('[data-memory-editor]')).toBeNull();
  });

  it('asks before Close drops a draft, and keeps pin and delete out of an open edit', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_one', title: 'First' })] });
    const { container } = await mountGuardedPage();
    await click(container, '[data-memory-row="m_one"]');
    expect(container.querySelector('[data-memory-pin]')).not.toBeNull();
    await click(container, '[data-memory-edit]');
    // A pin mid-edit would move the revision under the draft.
    expect(container.querySelector('[data-memory-pin]')).toBeNull();
    expect(container.querySelector('[data-memory-delete]')).toBeNull();
    await fillDraft(container, 'Unsaved draft');

    await click(container, '[data-memory-edit]');
    expect(container.querySelector('[data-guard-pending]')?.textContent).toBe('true');
    await click(container, '[data-guard-cancel]');
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Unsaved draft');

    await click(container, '[data-memory-edit]');
    await click(container, '[data-guard-confirm]');
    expect(container.querySelector('[data-memory-editor]')).toBeNull();
    expect(container.querySelector('[data-memory-pin]')).not.toBeNull();
  });

  it('does not ask twice for an explicit discard', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_open' })] });
    const { container } = await mountGuardedPage();
    await click(container, '[data-memory-row="m_open"]');
    await click(container, '[data-memory-edit]');
    await fillDraft(container);
    await click(container, '[data-memory-discard]');
    // The editor is clean now, so leaving it has nothing to confirm.
    await click(container, '[data-memory-detail-back]');
    expect(container.querySelector('[data-guard-pending]')?.textContent).toBe('false');
    expect(container.querySelector('[data-memory-editor]')).toBeNull();
  });

  it('keeps the draft and its own revision when a newer revision is read back', async () => {
    const original = fixtureEntry({ id: 'm_open', title: 'Stored title', body: 'Stored body.', revision: 'revision-1' });
    let current = original;
    seedMemories({ 'global::': [original] });
    const put = vi.spyOn(client, 'putMemory').mockImplementation(async () => ({ entry: current, operationId: 'op_update' }));
    const { container, queryClient } = await mountGuardedPage();
    await click(container, '[data-memory-row="m_open"]');
    await click(container, '[data-memory-edit]');
    await fillDraft(container, 'My unsaved memory');

    // Another window saves. The list read-back brings a different revision of
    // the same entry into the very component holding the draft.
    current = { ...original, title: 'Other window memory', body: 'Other window body.', revision: 'revision-2' };
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['memory'] }); });
    await flush();

    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('My unsaved memory');
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('true');

    // The save is measured against what the reader was looking at, so the
    // server refuses rather than silently dropping the newer text.
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenLastCalledWith({ scope: 'global' }, 'm_open', expect.objectContaining({
      action: 'update', expected_revision: 'revision-1', title: 'My unsaved memory',
    }));
  });

  it('counts a typed reason as an unsaved change', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_open' })] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_open' }), operationId: 'op_update' });
    const { container } = await mountGuardedPage();
    await click(container, '[data-memory-row="m_open"]');
    await click(container, '[data-memory-edit]');
    expect(container.querySelector<HTMLButtonElement>('[data-memory-save]')?.disabled).toBe(true);
    await act(async () => {
      const reason = container.querySelector<HTMLInputElement>('[data-memory-reason]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reason, 'Because the release moved');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('true');
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenLastCalledWith({ scope: 'global' }, 'm_open', expect.objectContaining({
      reason: 'Because the release moved', action: 'update',
    }));
  });
});

describe('MemoryPage global switch', () => {
  it('renders load failure instead of turning-off intro when settings query fails, without repeating error in header', async () => {
    seedMemories({ 'global::': [] });
    vi.mocked(client.getMemorySettings).mockRejectedValue(new Error('Network offline'));
    const { container } = await mountPage('/memory', []);
    const errorBlock = container.querySelector('[data-memory-settings-error]');
    expect(errorBlock).not.toBeNull();
    expect(errorBlock?.textContent).toContain('Network offline');
    expect(container.querySelector('[data-memory-intro]')).toBeNull();
    expect(container.querySelector('[data-memory-enable]')).toBeNull();
    // Header status node is present and does not duplicate the error string
    const headerStatus = container.querySelector('header [data-memory-status]');
    expect(headerStatus).not.toBeNull();
    expect(headerStatus!.textContent).not.toContain('Network offline');
  });

  it('keeps single error in header when background refetch fails with cached settings preserved in body', async () => {
    seedMemories({ 'global::': [] });
    vi.mocked(client.getMemorySettings).mockResolvedValueOnce(enabledSettings);
    const { container, queryClient } = await mountPage('/memory', []);
    // Initial mount succeeds with settings enabled and active view present
    expect(container.querySelector('header [data-memory-status]')?.textContent).toContain('On');
    expect(container.querySelector('[data-memory-settings-error]')).toBeNull();

    // Background refetch rejects: query has cached data so body stays intact, error reports in header
    vi.mocked(client.getMemorySettings).mockRejectedValueOnce(new Error('Background sync failed'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: MEMORY_SETTINGS_QUERY_KEY }).catch(() => {});
    });
    await flush();

    // Body still renders cached content without settings error block
    expect(container.querySelector('[data-memory-settings-error]')).toBeNull();
    // Header status node provides the single failure feedback
    const headerStatus = container.querySelector('header [data-memory-status]');
    expect(headerStatus).not.toBeNull();
    expect(headerStatus!.textContent).toContain('Background sync failed');
    // Whole page has only one error notification in header, no second error in body
    const allAlerts = container.querySelectorAll('[role="alert"]');
    expect(allAlerts.length).toBe(0);
  });

  it('marks every workspace effective read stale after this page turns memory on', async () => {
    // The settings card holds a computed `effective_enabled` per workspace.
    // This page is the other entry that writes the global switch, so its save
    // has to reach those reads too: a card open in another window would
    // otherwise keep showing the state the switch just replaced.
    let global = false;
    seedMemories({ 'global::': [] });
    vi.mocked(client.getMemorySettings).mockImplementation(async () => ({ ...enabledSettings, enabled: global }));
    const readWorkspace = vi.spyOn(client, 'getWorkspaceMemorySettings')
      .mockImplementation(async (id: string) => ({ workspace_id: id, enabled: null, effective_enabled: global }));
    vi.spyOn(client, 'patchMemorySettings').mockImplementation(async (patch: { enabled?: boolean }) => {
      global = patch.enabled ?? global;
      return { ...enabledSettings, enabled: global };
    });

    const { container, queryClient } = await mountPage('/memory', []);
    // The read the settings card would already have made.
    await act(async () => {
      await queryClient.prefetchQuery({
        queryKey: ['memory-workspace-settings', workspace.id],
        queryFn: () => client.getWorkspaceMemorySettings(workspace.id),
      });
    });
    expect(readWorkspace).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(['memory-workspace-settings', workspace.id])?.isInvalidated).toBe(false);

    // Memory is off, so the page offers one switch.
    await click(container, '[data-memory-enable]');
    expect(client.patchMemorySettings).toHaveBeenCalledWith({ enabled: true });
    await flush();

    // The stale read is now stale for real, not only in this component's head.
    expect(queryClient.getQueryState(['memory-workspace-settings', workspace.id])?.isInvalidated).toBe(true);
  });
});

describe('MemoryPage workspace override', () => {
  const otherWorkspace = { ...workspace, id: 'wd_other', name: 'Archive' };

  async function primedPage() {
    seedMemories({ 'global::': [] });
    const readWorkspace = vi.spyOn(client, 'getWorkspaceMemorySettings')
      .mockImplementation(async (id: string) => ({ workspace_id: id, enabled: null, effective_enabled: true }));
    vi.spyOn(client, 'patchWorkspaceMemorySettings')
      .mockImplementation(async (id: string, enabled: boolean | null) => ({ workspace_id: id, enabled, effective_enabled: enabled !== false }));
    const page = await mountPage(`/memory?workspace=${workspace.id}`, [workspace, otherWorkspace]);
    // The reads the settings card would already have made: this workspace's
    // own state, and one it has nothing to do with.
    for (const id of [workspace.id, otherWorkspace.id]) {
      await act(async () => {
        await page.queryClient.prefetchQuery({
          queryKey: ['memory-workspace-settings', id],
          queryFn: () => client.getWorkspaceMemorySettings(id),
        });
      });
    }
    expect(readWorkspace).toHaveBeenCalledTimes(2);
    return page;
  }

  it('marks this workspace own card read stale after the page writes its override', async () => {
    // The card shows a computed `effective_enabled`; this page is the other
    // entry that writes the same field, so its save has to reach that read.
    const { container, queryClient } = await primedPage();
    const readsBefore = vi.mocked(client.getMemorySettings).mock.calls.length;

    await click(container, '[data-memory-ws-option="false"]');
    expect(client.patchWorkspaceMemorySettings).toHaveBeenLastCalledWith(workspace.id, false);
    await flush();

    expect(queryClient.getQueryState(['memory-workspace-settings', workspace.id])?.isInvalidated).toBe(true);
    // The page still re-reads the global settings: their `workspaces` map is
    // what the header and this very switch render from.
    expect(vi.mocked(client.getMemorySettings).mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('leaves another workspace read alone, because an override is that workspace own state', async () => {
    const { container, queryClient } = await primedPage();

    await click(container, '[data-memory-ws-option="false"]');
    await flush();

    // One workspace's override decides nothing about the next one, so the
    // other card keeps the read it already made.
    expect(queryClient.getQueryState(['memory-workspace-settings', otherWorkspace.id])?.isInvalidated).toBe(false);
  });
});


/**
 * A pending entry is a proposal, not the fact. What accepting it will do to
 * the entry it supersedes is the proposal's own `pending_action`, and the
 * buttons have to say that rather than presenting a retirement as a keep.
 */
describe('MemoryPage inbox proposals', () => {
  const candidate = (id: string, fields: Partial<MemoryEntry> = {}): MemoryEntry => ({
    ...fixtureEntry({ id, status: 'pending', title: `Candidate ${id}`, body: 'Proposed body.' }),
    supersedes: 'm_target', supersedes_revision: 'revision-target', ...fields,
  });

  async function openInbox(inbox: readonly MemoryEntry[]) {
    seedMemories({ 'global::': [] });
    vi.mocked(client.getMemorySettings).mockResolvedValue({ ...enabledSettings, approval: 'review' });
    vi.spyOn(client, 'memoryInbox').mockResolvedValue({ items: inbox });
    const container = await renderPage('/memory');
    await click(container, '[data-memory-tab="inbox"]');
    return container;
  }

  it('accepts an update proposal on the candidate id, leaving the original id to the store', async () => {
    const entry = candidate('m_candidate', { pending_action: 'update' });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_target' }), operationId: 'op_keep' });
    const container = await openInbox([entry]);

    expect(container.querySelector('[data-memory-inbox-action="update"]')?.textContent).toBe('Applying this replaces the text of the entry it supersedes.');
    expect(container.querySelector('[data-memory-inbox-keep]')?.textContent).toBe('Keep');

    await click(container, '[data-memory-inbox-keep]');
    // The decision is made about the candidate; which action that performs on
    // the original entry is the store's, not this page's.
    expect(put).toHaveBeenCalledWith({ scope: 'global' }, 'm_candidate', expect.objectContaining({
      action: 'update', expected_revision: entry.revision,
    }));
  });

  it('names an archive proposal as an archive, not as a re-activation', async () => {
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: fixtureEntry({ id: 'm_target' }), operationId: 'op_archive' });
    const container = await openInbox([candidate('m_candidate', { pending_action: 'archive' })]);

    // "Keep" here would promise the reader the opposite of what happens.
    expect(container.querySelector('[data-memory-inbox-keep]')?.textContent).toBe('Archive it');
    expect(container.querySelector('[data-memory-inbox-action="archive"]')?.textContent).toBe('Applying this archives the entry it supersedes.');

    await click(container, '[data-memory-inbox-keep]');
    expect(put).toHaveBeenCalledWith({ scope: 'global' }, 'm_candidate', expect.objectContaining({ action: 'update' }));
  });

  it('discards only the candidate, so the entry it proposed to change is untouched', async () => {
    const remove = vi.spyOn(client, 'deleteMemory').mockResolvedValue({ operation_id: 'op_drop' });
    const put = vi.spyOn(client, 'putMemory');
    const container = await openInbox([candidate('m_candidate', { pending_action: 'archive' })]);

    await click(container, '[data-memory-inbox-discard]');
    expect(remove).toHaveBeenCalledWith({ scope: 'global' }, 'm_candidate', expect.any(String));
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps the plain wording for a pending entry that proposes nothing', async () => {
    const container = await openInbox([candidate('m_candidate')]);
    expect(container.querySelector('[data-memory-inbox-action]')).toBeNull();
    expect(container.querySelector('[data-memory-inbox-keep]')?.textContent).toBe('Keep');
  });
});


describe('memory S4 logic contracts', () => {
  const receipt = (fields: Record<string, unknown> = {}) => ({
    id: 'm_located', title: 'Located rule', scope: 'global', status: 'active', revision: 'r1',
    outcome: 'applied', operation_id: 'op_real', target: { scope: 'global', id: 'm_located', expected_revision: 'r1' }, ...fields,
  });
  async function renderRow(payload: unknown, name = 'MemoryWrite') {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container, queryClient });
    const block: ToolBlock = { kind: 'tool', id: 'tool-memory', toolCallId: 'call-memory', name,
      argsText: '', args: {}, display: undefined, description: undefined, status: 'done',
      output: JSON.stringify(payload), isError: undefined, durationMs: undefined, progressText: undefined };
    await act(async () => { root.render(<I18nProvider><MemoryRouter><RouteProbe /><MemoryToolRow block={block} /></MemoryRouter></I18nProvider>); });
    await flush();
    return container;
  }

  it.each([null, undefined, '', '   '])('does not invent Undo for a repeated pending proposal with operation %s', async (operation_id) => {
    const payload = receipt({ outcome: 'pending', status: 'pending', operation_id });
    expect(parseMemoryWriteResult(JSON.stringify(payload))?.operation_id).toBeNull();
    const container = await renderRow(payload);
    expect(container.querySelector('[data-memory-tool-view]')).not.toBeNull();
    expect(container.querySelector('[data-memory-tool-undo]')).toBeNull();
    await click(container, '[data-memory-tool-toggle]');
    expect(container.querySelector('[data-memory-tool-pending]')?.textContent).toBe('This is a pending proposal and is not in effect yet.');
  });

  it.each([
    { scope: 'global', owner: { kind: 'global' }, target: { scope: 'global' }, search: { entry: 'm_located' } },
    { scope: 'workspace', owner: { kind: 'workspace', workspaceId: 'wd_current' }, target: { scope: 'workspace', workspaceId: 'wd_current' }, search: { entry: 'm_located', workspace: 'wd_current' } },
    { scope: 'persona', owner: { kind: 'persona', personaId: 'lin-lan' }, target: { scope: 'persona', personaId: 'lin-lan' }, search: { entry: 'm_located', persona: 'lin-lan' } },
    { scope: 'persona_workspace', owner: { kind: 'persona_workspace', personaId: 'lin-lan', workspaceId: 'wd_home' }, target: { scope: 'persona_workspace', personaId: 'lin-lan', workspaceId: 'wd_home' }, search: { entry: 'm_located', persona: 'lin-lan', workspace: 'wd_home' } },
  ])('View and Undo use the real $scope namespace and entry identity', async ({ scope, owner, target, search }) => {
    const undo = vi.spyOn(client, 'undoMemory').mockResolvedValue({ entry: null });
    const session = vi.spyOn(client, 'getSession');
    const container = await renderRow(receipt({ scope, owner_scope: owner, target: { scope, id: 'm_located', expected_revision: 'r1' } }));
    await click(container, '[data-memory-tool-view]');
    expect(Object.fromEntries(routeParams(container))).toEqual(search);
    expect(session).not.toHaveBeenCalled();
    await click(container, '[data-memory-tool-undo]');
    expect(undo).toHaveBeenCalledWith(target, 'op_real');
    expect(container.querySelector('[data-memory-tool-undone]')).not.toBeNull();
  });

  it('does not demote an incomplete persona-workspace locator to another namespace', async () => {
    const undo = vi.spyOn(client, 'undoMemory');
    const container = await renderRow(receipt({ scope: 'persona_workspace', owner_scope: { kind: 'persona_workspace', workspaceId: 'wd_home' } }));
    await click(container, '[data-memory-tool-view]');
    expect(routeParams(container).toString()).toBe('');
    expect(getToasts().at(-1)?.text).toBe('Could not complete that: This record is missing location information.');
    await click(container, '[data-memory-tool-undo]');
    expect(undo).not.toHaveBeenCalled();
    expect(container.querySelector('[data-memory-tool-undone]')).toBeNull();
    expect(getToasts().at(-1)?.text).toBe('Could not undo: This record is missing location information.');
  });

  it('keeps a conflicting Undo visible without claiming that newer content was restored', async () => {
    const { ApiError, MEMORY_REVISION_CONFLICT } = await import('../lib/client');
    vi.spyOn(client, 'undoMemory').mockRejectedValue(new ApiError({ code: MEMORY_REVISION_CONFLICT, msg: 'Conflict', data: null }));
    const container = await renderRow(receipt());
    await click(container, '[data-memory-tool-undo]');
    expect(container.querySelector('[data-memory-tool-undone]')).toBeNull();
    expect(container.querySelector('[data-memory-tool-undo]')).not.toBeNull();
    expect(getToasts().at(-1)?.text).toBe('Changed since — review it in Memory');
  });

  it.each([
    { complete: true, exhausted: true, next_cursor: null, expected: '0 matches', partial: false, hasMore: false },
    { complete: true, exhausted: false, next_cursor: 'next', expected: '0 results on this page, more pages remain', partial: false, hasMore: true },
    { complete: true, exhausted: false, next_cursor: null, expected: '0 results on this page, more pages remain', partial: false, hasMore: true },
    { complete: false, exhausted: true, next_cursor: null, expected: '0 results, maybe more', partial: true, hasMore: false },
  ])('distinguishes empty results from incomplete inventory and remaining pages ($complete/$exhausted/$next_cursor)', async ({ complete, exhausted, next_cursor, expected, partial, hasMore }) => {
    const payload = { items: [], mode: 'search', next_cursor, coverage: { scopes: [{ kind: 'global' }], statuses: ['active'], complete, exhausted, warnings: [] } };
    expect(parseMemorySearchSummary(JSON.stringify(payload))).toEqual({ count: 0, partial, hasMore, warnings: [] });
    const container = await renderRow(payload, 'MemorySearch');
    expect(container.textContent).toContain(expected);
    expect(parseMemorySearchSummary('[]')).toEqual({ count: 0, partial: false, hasMore: false, warnings: [] });
  });

  it('reads owning scope objects, complete metadata and old wire arrays without rewriting them', () => {
    const entry = fixtureEntry({ id: 'm_read', basis: { kind: 'human', note: 'Explicit request' }, validity: { check: 'Check current permission.' } });
    const current = parseMemoryReadResult(JSON.stringify([{ ...entry, scope: { kind: 'persona_workspace', workspaceId: 'wd_home', personaId: 'lin-lan' }, target: { scope: 'persona_workspace', id: entry.id, expected_revision: entry.revision }, complete: false }]));
    expect(current?.items[0]?.owner_scope).toEqual({ scope: 'persona_workspace', workspaceId: 'wd_home', personaId: 'lin-lan' });
    expect(current?.items[0]?.entry.basis?.note).toBe('Explicit request');
    expect(current?.items[0]?.applicability).toBe('recheck');
    expect(current?.complete).toBe(false);
    expect(parseMemoryReadResult(JSON.stringify([entry]))?.items).toHaveLength(1);
    expect(parseMemoryWriteResult(JSON.stringify(receipt({ outcome: undefined })))?.outcome).toBe('applied');
  });

  it('opens a same-ID workspace entry rather than its shared global copy, including an archived entry', async () => {
    seedMemories({ 'global::': [fixtureEntry({ id: 'm_located', body: 'Global copy.' })], 'workspace:wd_current:': [fixtureEntry({ id: 'm_located', status: 'archived', body: 'Workspace archive.' })] });
    const container = await renderPage('/memory?workspace=wd_current&entry=m_located&inactive=true', [workspace]);
    expect(container.querySelector('[data-memory-read-body]')?.textContent).toBe('Workspace archive.');
    expect(container.querySelector<HTMLInputElement>('[data-memory-show-inactive] input[type="checkbox"]')?.checked).toBe(true);
  });

  it('opens persona-workspace detail with the ID from View', async () => {
    seedBot([]);
    seedMemories({ 'persona::lin-lan': [fixtureEntry({ id: 'm_located', body: 'Long-term copy.' })], 'persona_workspace:wd_home:lin-lan': [fixtureEntry({ id: 'm_located', body: 'Workspace-specific rule.' })] });
    const container = await renderPage('/memory?persona=lin-lan&workspace=wd_home&entry=m_located', [workspace]);
    expect(container.querySelector('[data-memory-read-body]')?.textContent).toBe('Workspace-specific rule.');
  });

  it('opens a pending create in the inbox and preserves metadata when accepting it', async () => {
    const entry = fixtureEntry({ id: 'm_proposal', status: 'pending', basis: { kind: 'derived', note: 'Proposed from observation.' }, validity: { check: 'Check the current scope.' } });
    seedMemories({ 'global::': [] }, { ...enabledSettings, approval: 'review' });
    vi.spyOn(client, 'memoryInbox').mockResolvedValue({ items: [entry] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: { ...entry, status: 'active' }, outcome: 'applied', operationId: 'op_accept' });
    const container = await renderPage('/memory?entry=m_proposal&tab=inbox');
    expect(container.querySelector('[data-memory-tab="inbox"]')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-memory-inbox-provenance]')?.textContent).toContain('Proposed from observation.');
    await click(container, '[data-memory-inbox-keep]');
    expect(put).toHaveBeenCalledWith({ scope: 'global' }, entry.id, expect.objectContaining({ action: 'update', expected_revision: entry.revision, basis: entry.basis, validity: entry.validity }));
    expect(put.mock.calls[0]?.[2].covered_by).toBeUndefined();
  });

  it('preserves metadata while pinning and leaves a legacy validity omitted, never null', async () => {
    const entry = fixtureEntry({ id: 'm_pin', basis: { kind: 'observed', note: 'Checked in the source.' }, validity: { check: 'Read current source.', until: '2030-01-01T00:00:00Z' } });
    seedMemories({ 'global::': [entry] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry, outcome: 'applied', operationId: 'op_pin' });
    const container = await renderPage();
    await click(container, '[data-memory-row="m_pin"]');
    await click(container, '[data-memory-pin]');
    expect(put).toHaveBeenCalledWith({ scope: 'global' }, entry.id, expect.objectContaining({ pinned: true, expected_revision: entry.revision, basis: entry.basis, validity: entry.validity }));
    const legacy = fixtureEntry({ id: 'm_legacy' });
    expect(memorySnapshot(rawSnapshot(legacy), legacy.revision)?.validity).toBeUndefined();
    expect(memorySnapshot(rawSnapshot(entry), entry.revision)?.basis).toEqual(entry.basis);
    expect(memorySnapshot(rawSnapshot(entry), entry.revision)?.validity).toEqual(entry.validity);
  });
});


describe('memory covered-by and journal metadata', () => {
  it.each(['same', 'changed', 'archived', 'missing'])('checks the retained current entry after a merge (%s)', async (state) => {
    const kept = fixtureEntry({ id: 'm_kept', title: 'Retained rule', revision: state === 'changed' ? 'r2' : 'r1', status: state === 'archived' ? 'archived' : 'active' });
    const retired = fixtureEntry({ id: 'm_retired', status: 'archived', covered_by: { id: kept.id, revision: 'r1' } });
    seedMemories({ 'global::': [retired, kept] });
    const get = vi.spyOn(client, 'getMemory');
    if (state === 'missing') get.mockRejectedValue(new Error('Unavailable'));
    else get.mockResolvedValue(kept);
    const container = await renderPage('/memory?entry=m_retired&inactive=true');
    expect(get).toHaveBeenCalledWith({ scope: 'global' }, kept.id);
    const message = container.querySelector('[data-memory-covered-state]');
    if (state === 'same') expect(message).toBeNull();
    else expect(message?.textContent).toContain(state === 'missing' ? 'could not be loaded' : 'has changed');
  });

  it('shows each real journal version with its own basis, check and covered-by identity', async () => {
    const before = fixtureEntry({ id: 'm_history', revision: 'r1', body: 'Earlier rule.', basis: { kind: 'human', note: 'Earlier human requirement.' }, validity: { check: 'Earlier check.' } });
    const after = { ...before, revision: 'r2', status: 'archived' as const, body: 'Stored rule.', basis: { kind: 'observed' as const, note: 'Later source evidence.', refs: ['example.test/source'] }, validity: { check: 'Later check.' }, covered_by: { id: 'm_retained', revision: 'kept-r1' } };
    seedMemories({ 'global::': [after] });
    vi.spyOn(client, 'getMemory').mockResolvedValue(fixtureEntry({ id: 'm_retained', revision: 'kept-r1' }));
    vi.mocked(client.memoryJournal).mockResolvedValue([{ operationId: 'op_history', action: 'archive', id: before.id, at: before.updated, writer: 'user', before: rawSnapshot(before), beforeRevision: before.revision, afterRevision: after.revision }]);
    const container = await renderPage('/memory?entry=m_history&inactive=true');
    await click(container, '[data-memory-history-record="op_history"]');
    const dialog = document.querySelector('[data-memory-history-detail="op_history"]')!;
    expect(dialog.textContent).toContain('Earlier rule.');
    expect(dialog.textContent).toContain('Stored rule.');
    expect([...dialog.querySelectorAll('[data-memory-basis-note]')].map((node) => node.textContent)).toEqual(['Later source evidence.', 'Earlier human requirement.']);
    expect([...dialog.querySelectorAll('[data-memory-validity-check]')].map((node) => node.textContent)).toEqual(['Later check.', 'Earlier check.']);
    expect(dialog.querySelector('[data-memory-covered-by="m_retained"]')?.textContent).toContain('m_retained');
    expect(memorySnapshot(rawSnapshot(after), after.revision)?.covered_by).toEqual({ id: 'm_retained', revision: 'kept-r1' });
  });
});

describe('MemoryPage pending View location', () => {
  const proposals = Array.from({ length: 24 }, (_, index) => fixtureEntry({ id: `m_pending_${String(index).padStart(2, '0')}`, title: `Review proposal ${index + 1}`, status: 'pending', body: `Proposed condition ${index + 1}.` }));
  const sought = proposals[20]!;
  const scrolled: HTMLElement[] = [];
  let previousScroll: PropertyDescriptor | undefined;
  beforeEach(() => {
    scrolled.length = 0;
    previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value(this: HTMLElement) { scrolled.push(this); } });
  });
  afterEach(() => {
    if (previousScroll === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
  });

  it.each([
    { suffix: '', target: { scope: 'global' as const } },
    { suffix: '&persona=lin-lan&workspace=wd_current', target: { scope: 'persona_workspace' as const, personaId: 'lin-lan', workspaceId: 'wd_current' } },
  ])('locates the 21st pending card after loading in its own $target.scope without approving or hiding neighbours', async ({ suffix, target }) => {
    if (target.scope === 'persona_workspace') seedBot([]);
    seedMemories({ 'global::': [], 'persona::lin-lan': [], 'persona_workspace:wd_current:lin-lan': [] }, { ...enabledSettings, approval: 'review' });
    const inbox = deferred<{ items: readonly MemoryEntry[] }>();
    const read = vi.spyOn(client, 'memoryInbox').mockReturnValue(inbox.promise);
    const put = vi.spyOn(client, 'putMemory');
    const remove = vi.spyOn(client, 'deleteMemory');
    const container = await renderPage(`/memory?entry=${sought.id}&tab=inbox${suffix}`, [workspace]);
    expect(scrolled).toEqual([]);
    expect(container.querySelector('[data-memory-inbox]')).toBeNull();
    await act(async () => { inbox.resolve({ items: proposals }); });
    await flush();
    const card = container.querySelector<HTMLElement>(`[data-memory-inbox-row="${sought.id}"]`)!;
    expect([...container.querySelectorAll<HTMLElement>('[data-memory-inbox-row]')].map((node) => node.dataset['memoryInboxRow'])).toEqual(proposals.map((entry) => entry.id));
    expect(scrolled).toEqual([card]);
    expect(document.activeElement).toBe(card);
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(read).toHaveBeenCalledWith(target, { page_size: 20 }, expect.any(AbortSignal));
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('leaves all proposals usable when the linked pending ID is absent, without picking or approving another one', async () => {
    seedMemories({ 'global::': [] }, { ...enabledSettings, approval: 'review' });
    vi.spyOn(client, 'memoryInbox').mockResolvedValue({ items: proposals });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: proposals[0]!, operationId: 'op_keep', outcome: 'applied' });
    const container = await renderPage('/memory?entry=m_missing&tab=inbox');
    expect(scrolled).toEqual([]);
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(container.querySelectorAll('[data-memory-inbox-row]')).toHaveLength(24);
    expect(put).not.toHaveBeenCalled();
    await click(container, `[data-memory-inbox-row="${proposals[0]!.id}"] [data-memory-inbox-keep]`);
    expect(put).toHaveBeenCalledWith({ scope: 'global' }, proposals[0]!.id, expect.objectContaining({ expected_revision: proposals[0]!.revision }));
  });

  it('keeps the existing empty-inbox state when the linked proposal no longer exists', async () => {
    seedMemories({ 'global::': [] }, { ...enabledSettings, approval: 'review' });
    vi.spyOn(client, 'memoryInbox').mockResolvedValue({ items: [] });
    const container = await renderPage('/memory?entry=m_missing&tab=inbox');
    expect(container.querySelector('[data-memory-inbox-empty]')).not.toBeNull();
    expect(scrolled).toEqual([]);
  });

  it('does not repeat the pending landing on background refresh or discard an entry draft after leaving the inbox', async () => {
    const entry = fixtureEntry({ id: 'm_editable' });
    seedMemories({ 'global::': [entry] }, { ...enabledSettings, approval: 'review' });
    const read = vi.spyOn(client, 'memoryInbox').mockResolvedValue({ items: proposals });
    const { container, queryClient } = await mountGuardedPage(`/memory?entry=${sought.id}&tab=inbox`);
    expect(scrolled).toHaveLength(1);
    const otherAction = container.querySelector<HTMLButtonElement>('[data-memory-inbox-keep]')!;
    await act(async () => { otherAction.focus(); });
    read.mockResolvedValue({ items: proposals.map((proposal) => proposal.id === sought.id ? { ...proposal, revision: 'pending-r2', title: 'Refreshed proposal 21' } : proposal) });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['memory-inbox'] }); });
    await flush();
    expect(container.querySelector(`[data-memory-inbox-row="${sought.id}"]`)?.textContent).toContain('Refreshed proposal 21');
    expect(scrolled).toHaveLength(1);
    expect(document.activeElement).toBe(otherAction);
    await click(container, '[data-memory-tab="entries"]');
    await click(container, '[data-memory-row="m_editable"]');
    await click(container, '[data-memory-edit]');
    await fillDraft(container, 'Keep my entry draft');
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['memory-inbox'] }); });
    await flush();
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Keep my entry draft');
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('true');
    expect(scrolled).toHaveLength(1);
  });
});


describe('MemoryPage bounded vertical continuation', () => {
  it('shows early pages while automatically reaching the source suffix, keeps bad-record diagnostics, and approves the complete proposal via real client/routes/store', async () => {
    const { memoryContinuationFixture } = await import('../../../../packages/kap-server/test/fixtures/memoryContinuation');
    const fixture = await memoryContinuationFixture();
    const release = deferred<void>();
    const releaseDetail = deferred<void>();
    const applied = deferred<{ code: number; msg: string }>();
    let hold = false;
    let firstListPage = false;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/memory/global' && hold) await release.promise;
      if (url.pathname === '/api/memory/global/m_pending_4' && (init?.method ?? 'GET') === 'GET') await releaseDetail.promise;
      const response = await fixture.fetch(input, init);
      if (init?.method === 'PUT') applied.resolve(await response.clone().json());
      if (url.pathname === '/api/memory/global') {
        calls++;
        const envelope = await response.clone().json();
        if (!firstListPage && envelope.data?.items?.length > 0) { firstListPage = true; hold = true; }
      }
      return response;
    }));
    try {
      const { container, queryClient } = await mountPage();
      for (let index = 0; index < 60 && rowIds(container).length === 0; index++) await flush();
      expect(firstListPage).toBe(true);
      expect(rowIds(container).length).toBeGreaterThan(0);
      expect(rowIds(container).length).toBeLessThan(5);
      expect(container.querySelector('[data-memory-continuing]')).not.toBeNull();
      expect(container.querySelector('[data-memory-empty]')).toBeNull();
      hold = false;
      release.resolve();
      for (let index = 0; index < 100 && container.querySelector('[data-memory-continuing]') !== null; index++) await flush();
      expect(rowIds(container)).toHaveLength(5);
      expect(rowIds(container)).toContain('m_active_4');
      expect(calls).toBeGreaterThan(5);
      const cache = queryClient.getQueriesData<{ items: MemoryEntry[] }>({ queryKey: ['memory'] });
      expect(cache.flatMap(([, page]) => page?.items ?? []).every((entry) => entry.body.length <= 160)).toBe(true);
      await click(container, '[data-memory-row="m_active_4"]');
      await vi.waitFor(async () => {
        await flush();
        expect(container.textContent).toContain('END-active-4');
      });
      await click(container, '[data-memory-tab="inbox"]');
      for (let index = 0; index < 100 && container.querySelectorAll('[data-memory-inbox-row]').length < 5; index++) await flush();
      expect(container.querySelectorAll('[data-memory-inbox-row]')).toHaveLength(5);
      expect(container.querySelector('[data-memory-coverage]')?.textContent).toContain('1 memory records were skipped');
      expect(container.querySelector('[data-memory-inbox-empty]')).toBeNull();
      await click(container, '[data-memory-inbox-row="m_pending_4"] [data-memory-inbox-read]');
      const proposal = container.querySelector('[data-memory-inbox-row="m_pending_4"]')!;
      expect(proposal.querySelector('[role="status"]')?.textContent).toContain('Loading memory');
      expect(proposal.textContent).not.toContain('END-pending-4');
      releaseDetail.resolve();
      await vi.waitFor(async () => {
        await flush();
        expect(proposal.textContent).toContain('END-pending-4');
        expect(proposal.querySelector('[role="status"]')).toBeNull();
      });
      await click(container, '[data-memory-inbox-row="m_pending_4"] [data-memory-inbox-keep]');
      let receipt: { code: number; msg: string } | undefined;
      await act(async () => { receipt = await applied.promise; });
      expect(receipt).toMatchObject({ code: 0 });
      const accepted = await fixture.store.get({ kind: 'global' }, 'm_pending_4');
      expect(accepted?.status).toBe('active');
      expect(accepted?.body).toContain('END-pending-4');
      expect(accepted?.body.length).toBeGreaterThan(160);
      expect(accepted?.basis).toEqual({ kind: 'observed', note: 'Fixture observation.' });
    } finally {
      release.resolve();
      releaseDetail.resolve();
      for (const mountedPage of mounted.splice(0)) {
        await act(async () => { mountedPage.root.unmount(); });
        mountedPage.queryClient.clear(); mountedPage.container.remove();
      }
      await fixture.close();
    }
  }, 60_000);

  it('preserves already-read rows when continuation fails instead of presenting an empty or complete list', async () => {
    seedMemories({ 'global::': [] });
    const entry = fixtureEntry({ id: 'm_readable' });
    vi.mocked(client.listMemory).mockResolvedValueOnce({ items: [entry], next_cursor: 'continue-example', coverage: { scopes: [{ kind: 'global' }], statuses: ['active'], exhausted: false, complete: true, warnings: [] } }).mockRejectedValueOnce(new Error('Source changed during continuation'));
    const container = await renderPage('/memory');
    expect(rowIds(container)).toEqual(['m_readable']);
    expect(container.querySelector('[data-memory-coverage]')?.textContent).toContain('Source changed during continuation');
    expect(container.querySelector('[data-memory-empty]')).toBeNull();
  });
});


it('MemoryPage continuation retains one current cumulative diagnostic instead of adding prior skip totals', async () => {
  const { continueMemory } = await import('./memory/continueMemory');
  const coverage = { scopes: [{ kind: 'global' as const }], statuses: ['active' as const], complete: false, exhausted: false };
  let index = 0;
  const totals = ['1 memory records were skipped', '2 memory records were skipped'];
  const result = await continueMemory(async () => ({ items: [], next_cursor: ++index < 2 ? 'second' : null, coverage: { ...coverage, exhausted: index === 2, warnings: [totals[index - 1]!] } }), () => {}, new AbortController().signal);
  expect(result.coverage?.warnings).toEqual([totals[1]]);
  expect(result.coverage?.complete).toBe(false);
});


it('MemoryPage continuation refuses to approve a newer full proposal fetched from a short preview', async () => {
  const entry = fixtureEntry({ id: 'm_long_proposal', status: 'pending', body: 'Proposed original content. '.repeat(20) });
  seedMemories({ 'global::': [] }, { ...enabledSettings, approval: 'review' });
  vi.spyOn(client, 'memoryInbox').mockResolvedValue({ items: [entry] });
  vi.spyOn(client, 'getMemory').mockResolvedValue({ ...entry, revision: 'newer-proposal', body: 'A different proposal.' });
  const put = vi.spyOn(client, 'putMemory');
  const container = await renderPage('/memory?tab=inbox');
  await click(container, '[data-memory-inbox-keep]');
  expect(put).not.toHaveBeenCalled();
  expect(getToasts().some((toast) => toast.text.includes('changed since you opened it'))).toBe(true);
  expect(container.querySelectorAll('[data-memory-inbox-row]')).toHaveLength(1);
});

it('MemoryPage M1 layout places status in header, keeps fixed split columns with empty detail placeholder, and uses amber for incomplete coverage without read error', async () => {
  const entry = fixtureEntry({ id: 'm_layout' });
  seedMemories({ 'global::': [entry] });
  vi.mocked(client.listMemory).mockResolvedValue({
    items: [entry],
    next_cursor: null,
    coverage: { scopes: [{ kind: 'global' }], statuses: ['active'], exhausted: true, complete: false, warnings: ['1 memory records were skipped'] },
  });
  const container = await renderPage('/memory');
  const headerStatus = container.querySelector('header [data-memory-status]');
  expect(headerStatus?.textContent).toContain('On');
  expect(headerStatus?.textContent).toContain('Memory settings');
  const grid = container.querySelector('[data-memory-list-detail]')!;
  expect(grid.className).toContain('lg:grid-cols-[340px_minmax(0,1fr)]');
  expect(container.querySelector('[data-memory-detail-empty]')?.textContent).toContain('Select a memory on the left to inspect its details and history.');
  const coverage = container.querySelector('[data-memory-coverage]')!;
  expect(coverage.className).toContain('text-amber-ink');
  expect(coverage.className).not.toContain('text-danger');
});

it('MemoryPage keeps the list and the detail in separate scroll panes instead of moving both together', async () => {
  seedMemories({ 'global::': [fixtureEntry({ id: 'm_first' }), fixtureEntry({ id: 'm_second' })] });
  const container = await renderPage('/memory');
  const consolePane = container.querySelector<HTMLElement>('[data-memory-console]')!;
  const rows = container.querySelector<HTMLElement>('[data-memory-rows]')!;
  const detailPane = container.querySelector<HTMLElement>('[data-memory-detail-pane]')!;
  // The console stops scrolling once the ledger is split, so neither column can
  // drag the other, and the filters sit above the rows pane instead of inside
  // it, so a long list cannot carry them away.
  expect(consolePane.className).toContain('lg:overflow-hidden');
  expect(rows.className).toContain('lg:overflow-y-auto');
  expect(detailPane.className).toContain('lg:overflow-y-auto');
  expect(rows.contains(container.querySelector('[data-memory-search]'))).toBe(false);
  expect(consolePane.contains(rows)).toBe(true);
  expect(consolePane.contains(detailPane)).toBe(true);
  // jsdom lays nothing out, so each pane's offset is stated here to observe
  // which element a selection moves. Real scrolling is proven on a real build
  // by scripts/visual-proof-memory-scroll.mjs.
  let listOffset = 240;
  Object.defineProperty(rows, 'scrollTop', { configurable: true, get: () => listOffset, set: (value: number) => { listOffset = value; } });
  let paneOffset = 120;
  Object.defineProperty(detailPane, 'scrollTop', { configurable: true, get: () => paneOffset, set: (value: number) => { paneOffset = value; } });
  await click(container, '[data-memory-row="m_first"]');
  expect(container.querySelector('[data-memory-detail]')?.getAttribute('data-memory-detail')).toBe('m_first');
  expect(paneOffset).toBe(0);
  expect(listOffset).toBe(240);
  paneOffset = 96;
  await click(container, '[data-memory-row="m_second"]');
  expect(container.querySelector('[data-memory-detail]')?.getAttribute('data-memory-detail')).toBe('m_second');
  expect(paneOffset).toBe(0);
  expect(listOffset).toBe(240);
});

it('MemoryPage discovery anchor exposes the scope group as the memory-scope tour target', async () => {
  seedMemories({ 'global::': [] });
  const container = await renderPage('/memory');
  const scope = container.querySelector('[data-memory-scope-kind]');
  expect(scope).not.toBeNull();
  expect(resolveAnchorElement('memory-scope')).toBe(scope);
  expect(detectActiveAnchors()).toContain('memory-scope');
});

describe('MemoryPage governed store', () => {
  const sqlite = { version: 1, epoch: 3, backend: 'sqlite', mode: 'active', migrationId: '00000000-0000-4000-8000-000000000001' } as const;
  const legacy = { version: 1, epoch: 0, backend: 'legacy', mode: 'active' } as const;
  const current = () => fixtureEntry({ id: 'm_deploy', title: 'Deployment procedure', body: 'Use 5 workers.', revision: 'mem2:rev-current' });

  it('keeps a file store that is not migrating readable and editable, with no upgrade shown and no manual migration', async () => {
    const list = seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(legacy);
    const provenance = vi.spyOn(client, 'memoryProvenance');
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: current(), operationId: 'op_1', outcome: 'applied' });
    const container = await renderPage();
    expect(container.querySelector('[data-memory-store="legacy"]')!.textContent).toBe('File store');
    for (const selector of ['[data-memory-write-hold]', '[data-memory-upgrade]', '[data-memory-recover]', '[data-memory-upgrade-retry]']) expect(container.querySelector(selector)).toBeNull();
    expect(container.textContent).not.toMatch(/upgrad|older writers|stopped every/iu);
    expect(list).toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[data-memory-new]')!.disabled).toBe(false);
    await click(container, '[data-memory-row="m_deploy"]');
    for (const selector of ['[data-memory-edit]', '[data-memory-pin]', '[data-memory-delete]']) expect(container.querySelector(selector)).not.toBeNull();
    expect(container.querySelector('[data-memory-forget-open]')).toBeNull();
    await click(container, '[data-memory-edit]');
    const input = container.querySelector<HTMLTextAreaElement>('[data-memory-body]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Use 4 workers.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenCalledWith({ scope: 'global' }, 'm_deploy', expect.objectContaining({ action: 'update', body: 'Use 4 workers.' }));
    expect(provenance).not.toHaveBeenCalled();
  });

  it('keeps the page editable when the server cannot report its store', async () => {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockRejectedValue(new Error('no route'));
    const container = await renderPage();
    expect(container.querySelector('[data-memory-store="unknown"]')).not.toBeNull();
    await click(container, '[data-memory-row="m_deploy"]');
    expect(container.querySelector('[data-memory-edit]')).not.toBeNull();
    expect(container.querySelector('[data-memory-forget-open]')).toBeNull();
    expect(container.querySelector('[data-memory-governance]')).toBeNull();
  });

  it('lists decisions and sources, marks the ruling in force, and opens an earlier revision', async () => {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({
      sources: [{ id: 's1', scope: 'memory/global', objectId: 'm_deploy', payload: '{}', locator: 'session_example#turn-2', learnedAt: '2026-01-01T12:00:00Z' }],
      adjudications: [
        { id: 'd1', scope: 'memory/global', objectId: 'm_deploy', kind: 'correction', revision: 'mem2:rev-old', reason: 'Owner instruction', sourceIds: ['s1'] },
        { id: 'd2', scope: 'memory/global', objectId: 'm_deploy', kind: 'correction', revision: 'mem2:rev-current', reason: 'Lowered after the incident', sourceIds: ['s1'] },
      ],
      relatedObjectIds: ['m_deploy', 'm_other'],
    });
    const revision = vi.spyOn(client, 'memoryRevision').mockResolvedValue({ ...current(), body: 'Use 9 workers.', revision: 'mem2:rev-old', historical: true });
    const container = await renderPage();
    await click(container, '[data-memory-row="m_deploy"]');
    expect(container.querySelector('[data-memory-current-revision="mem2:rev-current"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-decision-current="true"]')?.textContent).toContain('Lowered after the incident');
    expect(container.querySelector('[data-memory-source-record="s1"]')?.textContent).toContain('session_example#turn-2');
    expect(container.querySelector('[data-memory-shared-source="1"]')).not.toBeNull();
    await click(container, '[data-memory-open-revision="mem2:rev-old"]');
    expect(revision).toHaveBeenCalledWith({ scope: 'global' }, 'm_deploy', 'mem2:rev-old', expect.anything());
    expect(document.querySelector('[data-memory-revision-detail="mem2:rev-old"]')?.textContent).toContain('Use 9 workers.');
  });

  it('forgets exactly the previewed set with the previewed revisions, and never offers Undo', async () => {
    const other = fixtureEntry({ id: 'm_other', title: 'Shares the source', revision: 'mem2:rev-other' });
    seedMemories({ 'global::': [current(), other] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy', 'm_other'] });
    vi.spyOn(client, 'previewMemoryForget').mockResolvedValue({ generation: 7, targets: [
      { id: 'm_deploy', expectedRevision: 'mem2:rev-current', entry: current() },
      { id: 'm_other', expectedRevision: 'mem2:rev-other', entry: other },
    ] });
    const forget = vi.spyOn(client, 'forgetMemory')
      .mockRejectedValueOnce(new ApiError({ code: MEMORY_REVISION_CONFLICT, msg: 'Forget preview changed', data: null }))
      .mockResolvedValue({ operation_id: 'op', forgotten: ['m_deploy', 'm_other'] });
    const container = await renderPage();
    await click(container, '[data-memory-row="m_deploy"]');
    await click(container, '[data-memory-forget-open]');
    const dialog = () => document.querySelector<HTMLElement>('[data-memory-forget="m_deploy"]')!;
    expect(dialog().querySelector('[data-memory-forget-scope="2"]')).not.toBeNull();
    expect([...dialog().querySelectorAll('[data-memory-forget-target]')].map((row) => row.getAttribute('data-memory-forget-revision'))).toEqual(['mem2:rev-current', 'mem2:rev-other']);
    expect(document.querySelector<HTMLButtonElement>('[data-memory-forget-confirm]')!.disabled).toBe(true);
    await act(async () => { document.querySelector<HTMLInputElement>('[data-memory-forget-ack]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-memory-forget-confirm]')!.click(); });
    await flush();
    expect(document.querySelector('[data-memory-forget-stale]')).not.toBeNull();
    expect(document.querySelector('[data-memory-forget-confirm]')).toBeNull();
    const firstOperation = forget.mock.calls[0]![1];
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-memory-forget-repreview]')!.click(); });
    await flush();
    await act(async () => { document.querySelector<HTMLInputElement>('[data-memory-forget-ack]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-memory-forget-confirm]')!.click(); });
    await flush();
    expect(forget).toHaveBeenLastCalledWith({ scope: 'global' }, expect.stringMatching(/^[0-9a-f-]{36}$/), [
      { id: 'm_deploy', expectedRevision: 'mem2:rev-current' }, { id: 'm_other', expectedRevision: 'mem2:rev-other' },
    ]);
    expect(forget.mock.calls[1]![1]).not.toBe(firstOperation);
    expect(document.querySelector('[data-memory-forget]')).toBeNull();
    expect(container.querySelector('[data-memory-detail="m_deploy"]')).toBeNull();
    const toast = getToasts().at(-1)!;
    expect(toast.text).toBe('Forgot 2 entries.');
    expect(toast.retry).toBeUndefined();
  });

  it('keeps ordinary Delete undoable and worded apart from Forget', async () => {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    const container = await renderPage();
    await click(container, '[data-memory-row="m_deploy"]');
    expect(container.querySelector('[data-memory-delete]')?.textContent).toBe('Delete');
    expect(container.querySelector('[data-memory-forget-open]')?.textContent).toBe('Forget permanently');
    await click(container, '[data-memory-delete]');
    expect(document.body.textContent).toContain('You can undo this from the entry history.');
  });

  it('reads everything but withholds every edit in read-only recovery, and resumes with the exact recovery id and epoch', async () => {
    seedMemories({ 'global::': [current()] }, { ...enabledSettings, approval: 'review' });
    vi.spyOn(client, 'memoryInbox').mockResolvedValue({ items: [fixtureEntry({ id: 'm_pending', status: 'pending', title: 'Proposal', revision: 'mem2:p' })] });
    const readonly = { ...sqlite, epoch: 4, mode: 'readonly', recoveryId: '2b9a3c3e-0b7c-4d1e-9a51-7f0c1d2e3f40' } as const;
    const authority = vi.spyOn(client, 'memoryAuthority').mockResolvedValue(readonly);
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    const resume = vi.spyOn(client, 'resumeMemoryEditing').mockResolvedValue({ ...sqlite, epoch: 5 });
    const container = await renderPage();
    expect(container.querySelector('[data-memory-store="readonly"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-write-hold="readonly"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-memory-new]')!.disabled).toBe(true);
    await click(container, '[data-memory-row="m_deploy"]');
    expect(container.querySelector('[data-memory-read-body]')?.textContent).toBe('Use 5 workers.');
    expect(container.querySelector('[data-memory-governance="governed"]')).not.toBeNull();
    for (const selector of ['[data-memory-edit]', '[data-memory-pin]', '[data-memory-delete]', '[data-memory-forget-open]', '[data-memory-detail] [data-memory-undo]']) expect(container.querySelector(selector)).toBeNull();
    await click(container, '[data-memory-tab="inbox"]');
    expect(container.querySelector<HTMLButtonElement>('[data-memory-inbox-keep]')!.disabled).toBe(true);
    authority.mockResolvedValue({ ...sqlite, epoch: 5 });
    await click(container, '[data-memory-resume]');
    expect(resume).toHaveBeenCalledWith(readonly.recoveryId, 4);
    expect(container.querySelector('[data-memory-write-hold]')).toBeNull();
  });

  it('shows the running upgrade with its real counts and offers no migration control', async () => {
    const list = seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue({ ...legacy, mode: 'migrating', migration: { id: '00000000-0000-4000-8000-000000000002', namespaces: ['memory/global', 'memory/personas/lin-lan', 'memory/workspaces/wd_a'], index: 1, after: 'm_release_owner', issues: [], phase: 'importing' } });
    const retry = vi.spyOn(client, 'retryMemoryMigration');
    const container = await renderPage();
    const status = container.querySelector('[data-memory-write-hold="migrating"] [data-memory-upgrade="importing"]')!;
    expect(status.querySelector('[data-memory-upgrade-progress="1/3"]')!.textContent).toBe('1 of 3 imported');
    expect(status.textContent).toContain('memory/personas/lin-lan · m_release_owner');
    expect(status.textContent).not.toMatch(/%/u);
    for (const selector of ['[data-memory-resume]', '[data-memory-recover]', '[data-memory-upgrade-retry]', '[data-memory-row]']) expect(container.querySelector(selector)).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('keeps an open draft when the store turns read-only, sends no save, and saves the same draft after editing resumes', async () => {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    const put = vi.spyOn(client, 'putMemory').mockResolvedValue({ entry: current(), operationId: 'op_saved', outcome: 'applied' });
    const { container, queryClient } = await mountPage();
    await click(container, '[data-memory-row="m_deploy"]');
    await click(container, '[data-memory-edit]');
    await fillDraft(container, 'Draft written before recovery');
    await flush();
    const readonly = { ...sqlite, epoch: 4, mode: 'readonly' as const, recoveryId: '2b9a3c3e-0b7c-4d1e-9a51-7f0c1d2e3f40' };
    await act(async () => { queryClient.setQueryData(['memory-authority'], readonly); });
    await flush();
    const save = container.querySelector<HTMLButtonElement>('[data-memory-save]')!;
    expect(container.querySelector<HTMLInputElement>('[data-memory-title]')?.value).toBe('Draft written before recovery');
    expect(save.disabled).toBe(true);
    await act(async () => { save.click(); });
    await flush();
    expect(put).not.toHaveBeenCalled();
    expect(container.querySelector('[data-memory-write-hold="readonly"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-memory-edit]')?.textContent).toBe('Close');
    await act(async () => { queryClient.setQueryData(['memory-authority'], { ...sqlite, epoch: 5 }); });
    await flush();
    await click(container, '[data-memory-save]');
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![2]).toMatchObject({ title: 'Draft written before recovery', expected_revision: 'mem2:rev-current' });
  });

  it('holds an open forget confirmation when the store stops accepting writes', async () => {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    vi.spyOn(client, 'previewMemoryForget').mockResolvedValue({ generation: 1, targets: [{ id: 'm_deploy', expectedRevision: 'mem2:rev-current', entry: current() }] });
    const forget = vi.spyOn(client, 'forgetMemory').mockResolvedValue({ operation_id: 'op', forgotten: ['m_deploy'] });
    const { container, queryClient } = await mountPage();
    await click(container, '[data-memory-row="m_deploy"]');
    await click(container, '[data-memory-forget-open]');
    await act(async () => { document.querySelector<HTMLInputElement>('[data-memory-forget-ack]')!.click(); });
    await act(async () => { queryClient.setQueryData(['memory-authority'], { ...sqlite, mode: 'migrating', backend: 'legacy' }); });
    await flush();
    const confirm = document.querySelector<HTMLButtonElement>('[data-memory-forget-confirm]')!;
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector('[data-memory-forget-held="migrating"]')).not.toBeNull();
    expect(document.querySelector('[data-memory-forget-target="m_deploy"]')).not.toBeNull();
    await act(async () => { confirm.click(); });
    await flush();
    expect(forget).not.toHaveBeenCalled();
    await act(async () => { queryClient.setQueryData(['memory-authority'], sqlite); });
    await flush();
    expect(document.querySelector('[data-memory-forget-held]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-memory-forget-confirm]')!.disabled).toBe(false);
  });

  it('does not paint a late provenance answer for one workspace onto the same id in the next', async () => {
    const beta = { ...workspace, id: 'wd_beta', name: 'Beta', root: '/fixture/beta' };
    const shared = fixtureEntry({ id: 'm_same', title: 'Same id in both', revision: 'mem2:same' });
    seedMemories({ 'workspace:wd_current:': [shared], 'workspace:wd_beta:': [shared] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
    const late = deferred<Awaited<ReturnType<typeof client.memoryProvenance>>>();
    const provenance = vi.spyOn(client, 'memoryProvenance').mockImplementation(async (target) => target.workspaceId === 'wd_current'
      ? late.promise
      : { sources: [], adjudications: [], relatedObjectIds: ['m_same'] });
    const container = await renderPage('/memory?workspace=wd_current&entry=m_same', [workspace, beta]);
    expect(provenance).toHaveBeenCalledWith({ scope: 'workspace', workspaceId: 'wd_current' }, 'm_same', expect.anything());
    await click(container, '#memory-workspace-picker');
    await click(container, '[data-option-value="wd_beta"]');
    expect(routeParams(container).get('workspace')).toBe('wd_beta');
    await click(container, '[data-memory-row="m_same"]');
    await act(async () => {
      late.resolve({ sources: [], adjudications: [{ id: 'd', scope: 'memory/workspaces/wd_current', objectId: 'm_same', kind: 'correction', revision: 'mem2:same', reason: 'Only true in the first workspace', sourceIds: [] }], relatedObjectIds: ['m_same'] });
    });
    await flush();
    const panel = container.querySelector('[data-memory-governance="governed"]')!.textContent!;
    expect(panel).not.toContain('Only true in the first workspace');
    expect(panel).toContain('No decisions recorded yet.');
  });
});

describe('MemoryPage Markdown round trip', () => {
  const sqlite = { version: 1, epoch: 3, backend: 'sqlite', mode: 'active', migrationId: '00000000-0000-4000-8000-000000000001' } as const;
  const current = () => fixtureEntry({ id: 'm_deploy', title: 'Deployment procedure', body: 'Use 5 workers.', revision: 'mem2:rev-current' });
  const exported = '---\n{"format":"kiki-memory-v1","scope":{"kind":"global"},"id":"m_deploy","revision":"mem2:rev-current"}\n---\nUse 4 workers.\n';
  const incoming = { format: 'kiki-memory-v1', scope: { kind: 'global' }, id: 'm_deploy', revision: 'mem2:rev-current', origin: { id: 'm_deploy', revision: 'mem2:rev-current' }, source: { writer: 'user' }, type: 'feedback', title: 'Deployment procedure', body: 'Use 4 workers.', status: 'active', pinned: false, validity: null } as const;
  const appliable = (token = 'token-1') => ({ incoming, current: current(), action: 'update', canApply: true, previewToken: token, expiresAt: new Date(Date.now() + 600_000).toISOString() } as const);

  function governed() {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    return vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
  }
  const dialog = () => document.querySelector<HTMLElement>('[data-memory-import]')!;
  const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
  async function press(selector: string) {
    await act(async () => { button(selector)!.click(); });
    await flush();
  }
  async function type(selector: string, value: string) {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function chooseFile(text: string, name = 'deployment-procedure-m_deploy.md') {
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([text], name, { type: 'text/markdown' })], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
  }
  async function openFilled(container: HTMLElement) {
    await click(container, '[data-memory-import-open]');
    await chooseFile(exported);
    await type('[data-memory-import-reason]', 'Lowered after review');
  }

  it('exports the current revision as a Markdown download, also while edits are held', async () => {
    const authority = governed();
    authority.mockResolvedValue({ ...sqlite, mode: 'readonly', recoveryId: 'recovery-1' });
    const exportMarkdown = vi.spyOn(client, 'exportMemoryMarkdown').mockResolvedValue({ markdown: exported, entry: current() });
    const createUrl = vi.fn((_blob: Blob) => 'blob:example');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const container = await renderPage();
    expect(container.querySelector<HTMLButtonElement>('[data-memory-import-open]')!.disabled).toBe(true);
    await click(container, '[data-memory-row="m_deploy"]');
    await click(container, '[data-memory-export]');
    expect(exportMarkdown).toHaveBeenCalledWith({ scope: 'global' }, 'm_deploy');
    expect(createUrl.mock.calls[0]![0].type).toBe('text/markdown;charset=utf-8');
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(getToasts().some((toast) => toast.text === 'Exported deployment-procedure-m_deploy.md')).toBe(true);
  });

  it('previews the file against the stored entry, confirms only the token once, and reads the entry back', async () => {
    governed();
    const preview = vi.spyOn(client, 'previewMemoryImport').mockResolvedValue(appliable());
    const apply = vi.spyOn(client, 'applyMemoryImport').mockResolvedValue({ entry: { ...current(), body: 'Use 4 workers.', revision: 'mem2:rev-next' }, operationId: 'op' });
    const read = vi.spyOn(client, 'getMemory').mockResolvedValue({ ...current(), body: 'Use 4 workers.', revision: 'mem2:rev-next', reason: 'Lowered after review' });
    const container = await renderPage();
    await openFilled(container);
    expect(document.querySelector<HTMLInputElement>('[data-memory-import-locator]')!.value).toBe('deployment-procedure-m_deploy.md');
    expect(button('[data-memory-import-confirm]')).toBeNull();
    await press('[data-memory-import-preview]');
    expect(preview).toHaveBeenCalledWith({ scope: 'global' }, { markdown: exported, sourceLocator: 'deployment-procedure-m_deploy.md', reason: 'Lowered after review' });
    expect(dialog().querySelector('[data-memory-import-current]')!.textContent).toContain('Use 5 workers.');
    expect(dialog().querySelector('[data-memory-import-incoming]')!.textContent).toContain('Use 4 workers.');
    await act(async () => { button('[data-memory-import-confirm="update"]')!.click(); button('[data-memory-import-confirm="update"]')!.click(); });
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toBe('token-1');
    expect(apply.mock.calls[0]![2]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(read).toHaveBeenCalledWith({ scope: 'global' }, 'm_deploy');
    expect(document.querySelector('[data-memory-import-applied="m_deploy"]')!.textContent).toContain('Lowered after review');
  });

  it('offers no confirm for a conflicting file, and previews again after a stale token without losing the file', async () => {
    governed();
    const preview = vi.spyOn(client, 'previewMemoryImport')
      .mockResolvedValueOnce({ incoming, current: { ...current(), revision: 'mem2:rev-newer' }, action: 'update', canApply: false, issue: { code: 'revision_conflict', recovery: 'Export the current entry again.' } })
      .mockResolvedValueOnce(appliable('token-a'))
      .mockResolvedValueOnce(appliable('token-b'));
    const apply = vi.spyOn(client, 'applyMemoryImport')
      .mockRejectedValueOnce(new ApiError({ code: MEMORY_REVISION_CONFLICT, msg: 'revision conflict', data: null, details: { code: 'revision_conflict', recovery: 'x' } }))
      .mockResolvedValue({ entry: current(), operationId: 'op' });
    vi.spyOn(client, 'getMemory').mockResolvedValue(current());
    const container = await renderPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    expect(dialog().querySelector('[data-memory-import-issue="revision_conflict"]')!.textContent).toContain('Export the current version');
    expect(dialog().textContent).not.toContain('Export the current entry again.');
    expect(button('[data-memory-import-confirm]')).toBeNull();
    expect(button('[data-memory-import-export-current]')).not.toBeNull();
    await type('[data-memory-import-reason]', 'Merged the newer revision');
    expect(dialog().querySelector('[data-memory-import-issue]')).toBeNull();
    await press('[data-memory-import-preview]');
    await press('[data-memory-import-confirm="update"]');
    expect(dialog().querySelector('[data-memory-import-stale="refused"]')).not.toBeNull();
    expect(button('[data-memory-import-confirm]')).toBeNull();
    const firstOperation = apply.mock.calls[0]![2];
    await press('[data-memory-import-preview]');
    expect(preview).toHaveBeenCalledTimes(3);
    expect(preview.mock.calls[2]![1].markdown).toBe(exported);
    await press('[data-memory-import-confirm="update"]');
    expect(apply.mock.calls[1]![1]).toBe('token-b');
    expect(apply.mock.calls[1]![2]).not.toBe(firstOperation);
  });

  it('lets an expired preview of a new entry be previewed again from the same file', async () => {
    governed();
    const fresh = { ...incoming, id: 'new', revision: null, origin: null, title: 'Release freeze' } as const;
    const preview = vi.spyOn(client, 'previewMemoryImport')
      .mockResolvedValueOnce({ incoming: fresh, current: null, action: 'create', canApply: true, previewToken: 'token-old', expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .mockRejectedValueOnce(new ApiError({ code: 40001, msg: 'Memory import preview is invalid, expired or from a different authority state', data: null, details: { code: 'invalid_input', recovery: 'Preview again.' } }));
    const container = await renderPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    expect(dialog().querySelector('[data-memory-import-stale="expired"]')).not.toBeNull();
    expect(dialog().querySelector('[data-memory-import-current]')!.textContent).toContain('Nothing stored yet.');
    expect(button('[data-memory-import-confirm]')).toBeNull();
    expect(button('[data-memory-import-export-current]')).toBeNull();
    await press('[data-memory-import-preview]');
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[1]![1].markdown).toBe(exported);
  });

  it('closes the confirmation for a forgotten source instead of asking to export it', async () => {
    governed();
    vi.spyOn(client, 'previewMemoryImport').mockResolvedValue(appliable());
    const apply = vi.spyOn(client, 'applyMemoryImport').mockRejectedValue(new ApiError({ code: 40001, msg: 'This exact Markdown source has been forgotten', data: null, details: { code: 'inactive_target', recovery: 'Use a distinct new source.' } }));
    const container = await renderPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    await press('[data-memory-import-confirm="update"]');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(dialog().querySelector('[data-memory-import-closed]')).not.toBeNull();
    expect(button('[data-memory-import-confirm]')).toBeNull();
    expect(button('[data-memory-import-preview]')).toBeNull();
    expect(button('[data-memory-import-export-current]')).toBeNull();
  });

  it('holds the confirmation when the store turns read-only, and drops the token when the epoch moves', async () => {
    governed();
    vi.spyOn(client, 'previewMemoryImport').mockResolvedValue(appliable());
    const apply = vi.spyOn(client, 'applyMemoryImport');
    const { container, queryClient } = await mountPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    expect(button('[data-memory-import-confirm="update"]')).not.toBeNull();
    await act(async () => { queryClient.setQueryData(['memory-authority'], { ...sqlite, epoch: 4, mode: 'readonly', recoveryId: 'recovery-1' }); });
    await flush();
    expect(document.querySelector('[data-memory-import-held="readonly"]')).not.toBeNull();
    expect(dialog().querySelector('[data-memory-import-stale="moved"]')).not.toBeNull();
    expect(button('[data-memory-import-confirm]')).toBeNull();
    expect(button('[data-memory-import-preview]')!.disabled).toBe(true);
    await act(async () => { button('[data-memory-import-preview]')!.click(); });
    expect(apply).not.toHaveBeenCalled();
    await act(async () => { queryClient.setQueryData(['memory-authority'], { ...sqlite, epoch: 5 }); });
    await flush();
    expect(document.querySelector('[data-memory-import-held]')).toBeNull();
    expect(button('[data-memory-import-confirm]')).toBeNull();
    expect(button('[data-memory-import-preview]')!.disabled).toBe(false);
  });

  it('explains a file from another scope in its own words and keeps it for retry', async () => {
    governed();
    vi.spyOn(client, 'previewMemoryImport').mockRejectedValue(new ApiError({ code: 40001, msg: 'Markdown scope does not match the selected owner', data: null, details: { code: 'scope_mismatch', recovery: 'Select the exported workspace and persona.' } }));
    const container = await renderPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    const refused = dialog().querySelector('[data-memory-import-refused="scope_mismatch"]')!;
    expect(refused.textContent).toContain('different scope');
    expect(refused.textContent).not.toContain('Select the exported workspace');
    expect(dialog().querySelector('[data-memory-import-file]')!.getAttribute('data-memory-import-file')).toBe('deployment-procedure-m_deploy.md');
  });

  it('drops an open import with its token when the scope changes', async () => {
    governed();
    seedMemories({ 'global::': [current()], 'workspace:wd_current:': [] });
    vi.spyOn(client, 'previewMemoryImport').mockResolvedValue(appliable());
    const container = await renderPage('/memory', [workspace]);
    await openFilled(container);
    await press('[data-memory-import-preview]');
    expect(button('[data-memory-import-confirm="update"]')).not.toBeNull();
    await click(container, '[data-memory-kind="workspace"]');
    expect(document.querySelector('[data-memory-import]')).toBeNull();
  });
});

describe('MemoryPage Markdown import recovery', () => {
  const sqlite = { version: 1, epoch: 3, backend: 'sqlite', mode: 'active', migrationId: '00000000-0000-4000-8000-000000000001' } as const;
  const current = () => fixtureEntry({ id: 'm_deploy', title: 'Deployment procedure', body: 'Use 5 workers.', revision: 'mem2:rev-current' });
  const exported = '---\n{"format":"kiki-memory-v1"}\n---\nUse 4 workers.\n';
  const incoming = { format: 'kiki-memory-v1', scope: { kind: 'global' }, id: 'm_deploy', revision: 'mem2:rev-current', origin: { id: 'm_deploy', revision: 'mem2:rev-current' }, source: { writer: 'user' }, type: 'feedback', title: 'Deployment procedure', body: 'Use 4 workers.', status: 'active', pinned: false, validity: null } as const;
  const appliable = (token = 'token-1') => ({ incoming, current: current(), action: 'update', canApply: true, previewToken: token, expiresAt: new Date(Date.now() + 600_000).toISOString() } as const);
  const dialog = () => document.querySelector<HTMLElement>('[data-memory-import]')!;
  const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector);

  function governed() {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(sqlite);
  }
  async function press(selector: string) {
    await act(async () => { button(selector)!.click(); });
    await flush();
  }
  async function type(selector: string, value: string) {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function choose(...files: File[]) {
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    for (const file of files) {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    }
    await flush();
  }
  const markdownFile = (name = 'deployment.md', text = exported) => new File([text], name, { type: 'text/markdown' });
  async function openFilled(container: HTMLElement) {
    await click(container, '[data-memory-import-open]');
    await choose(markdownFile());
    await type('[data-memory-import-reason]', 'Lowered after review');
  }

  it('keeps the import receipt when reading back fails, and retries only the read', async () => {
    governed();
    vi.spyOn(client, 'previewMemoryImport').mockResolvedValue(appliable());
    const apply = vi.spyOn(client, 'applyMemoryImport').mockResolvedValue({ entry: { ...current(), body: 'Use 4 workers.', revision: 'mem2:rev-next' }, operationId: 'op-import-1' });
    const read = vi.spyOn(client, 'getMemory')
      .mockRejectedValueOnce(new ApiError({ code: 50000, msg: 'read failed', data: null }))
      .mockResolvedValueOnce({ ...current(), body: 'Use 4 workers, then 3.', revision: 'mem2:rev-later' });
    const container = await renderPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    await press('[data-memory-import-confirm="update"]');
    const applied = document.querySelector('[data-memory-import-applied="m_deploy"]')!;
    expect(applied.getAttribute('data-memory-import-operation')).toBe('op-import-1');
    expect(applied.querySelector('[data-memory-import-readback-failed]')!.textContent).toContain('could not be read back');
    expect(applied.querySelector('[data-memory-import-readback]')).toBeNull();
    expect(applied.textContent).not.toContain('This is what memory holds now');
    await press('[data-memory-import-reread]');
    expect(read).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-memory-import-readback="mem2:rev-later"]')).not.toBeNull();
    expect(document.querySelector('[data-memory-import-applied]')!.textContent).toContain('Use 4 workers, then 3.');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)('drops a preview %s that arrives after the epoch moved, keeping the chosen file', async (outcome) => {
    governed();
    const late = deferred<Awaited<ReturnType<typeof client.previewMemoryImport>>>();
    const preview = vi.spyOn(client, 'previewMemoryImport').mockReturnValueOnce(late.promise).mockResolvedValueOnce(appliable('token-new'));
    const apply = vi.spyOn(client, 'applyMemoryImport').mockResolvedValue({ entry: current(), operationId: 'op' });
    vi.spyOn(client, 'getMemory').mockResolvedValue(current());
    const { container, queryClient } = await mountPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    await act(async () => { queryClient.setQueryData(['memory-authority'], { ...sqlite, epoch: 4 }); });
    await flush();
    await act(async () => {
      if (outcome === 'success') late.resolve(appliable('token-old'));
      else late.reject(new ApiError({ code: 40001, msg: 'Markdown scope does not match', data: null, details: { code: 'scope_mismatch', recovery: 'x' } }));
    });
    await flush();
    expect(button('[data-memory-import-confirm]')).toBeNull();
    expect(dialog().querySelector('[data-memory-import-preview-result]')).toBeNull();
    expect(dialog().querySelector('[data-memory-import-refused]')).toBeNull();
    expect(dialog().querySelector('[data-memory-import-file]')!.getAttribute('data-memory-import-file')).toBe('deployment.md');
    expect(button('[data-memory-import-preview]')!.disabled).toBe(false);
    await press('[data-memory-import-preview]');
    await press('[data-memory-import-confirm="update"]');
    expect(preview).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toBe('token-new');
  });

  it('turns an unreadable file into a local error the reader can recover from', async () => {
    governed();
    const container = await renderPage();
    await click(container, '[data-memory-import-open]');
    const broken = markdownFile('broken.md');
    const original = FileReader.prototype.readAsText;
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader, blob: Blob) {
      if (blob === broken) { queueMicrotask(() => { this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>); }); return; }
      original.call(this, blob);
    });
    await choose(broken);
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('Could not read broken.md');
    expect(dialog().querySelector('[data-memory-import-file]')!.getAttribute('data-memory-import-file')).toBe('');
    expect(button('[data-memory-import-pick]')!.disabled).toBe(false);
    await choose(markdownFile('fixed.md'));
    expect(dialog().querySelector('[data-memory-import-file]')!.getAttribute('data-memory-import-file')).toBe('fixed.md');
    expect(dialog().textContent).not.toContain('Could not read');
  });

  it('keeps the later file when an earlier read finishes last', async () => {
    governed();
    const container = await renderPage();
    await click(container, '[data-memory-import-open]');
    const slow = markdownFile('first.md', '---\n{}\n---\nfirst\n');
    const fast = markdownFile('second.md', '---\n{}\n---\nsecond\n');
    const pending: (() => void)[] = [];
    const original = FileReader.prototype.readAsText;
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader, blob: Blob) {
      if (blob === slow) { pending.push(() => { original.call(this, blob); }); return; }
      original.call(this, blob);
    });
    await choose(slow, fast);
    expect(dialog().querySelector('[data-memory-import-file]')!.getAttribute('data-memory-import-file')).toBe('second.md');
    await act(async () => { pending.forEach((run) => { run(); }); });
    await flush();
    expect(dialog().querySelector('[data-memory-import-file]')!.getAttribute('data-memory-import-file')).toBe('second.md');
    const preview = vi.spyOn(client, 'previewMemoryImport').mockResolvedValue(appliable());
    await type('[data-memory-import-reason]', 'Pick the second');
    await press('[data-memory-import-preview]');
    expect(preview.mock.calls[0]![1].markdown).toContain('second');
  });

  it('shows a pin-only change next to the stored entry, with the object and base revision', async () => {
    governed();
    vi.spyOn(client, 'previewMemoryImport').mockResolvedValue({ ...appliable(), incoming: { ...incoming, body: 'Use 5 workers.', pinned: true } });
    const container = await renderPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    const stored = dialog().querySelector('[data-memory-import-current]')!;
    const file = dialog().querySelector('[data-memory-import-incoming]')!;
    expect(stored.querySelector('[data-memory-import-meta-pinned]')!.getAttribute('data-memory-import-meta-pinned')).toBe('false');
    expect(file.querySelector('[data-memory-import-meta-pinned]')!.getAttribute('data-memory-import-meta-pinned')).toBe('true');
    expect(file.querySelector('[data-memory-import-meta-changed="pinned"]')).not.toBeNull();
    expect(stored.querySelector('[data-memory-import-meta-changed]')).toBeNull();
    expect(file.querySelector('[data-memory-import-meta-id="m_deploy"]')).not.toBeNull();
    expect(file.querySelector('[data-memory-import-meta-revision="mem2:rev-current"]')!.getAttribute('title')).toBe('mem2:rev-current');
    expect(file.querySelector('[data-memory-import-meta-scope]')!.textContent).toBe('Global');
    expect(file.textContent).not.toContain('kiki-memory-v1');
  });

  it('marks no pin change when only the content differs', async () => {
    governed();
    vi.spyOn(client, 'previewMemoryImport').mockResolvedValue(appliable());
    const container = await renderPage();
    await openFilled(container);
    await press('[data-memory-import-preview]');
    expect(dialog().querySelector('[data-memory-import-meta-changed]')).toBeNull();
    expect([...dialog().querySelectorAll('[data-memory-import-meta-pinned]')].map((node) => node.getAttribute('data-memory-import-meta-pinned'))).toEqual(['false', 'false']);
  });
});

describe('MemoryPage automatic upgrade', () => {
  const operation = '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8';
  const namespaces = ['memory/global', 'memory/personas/lin-lan'];
  const sqlite = { version: 1, epoch: 3, backend: 'sqlite', mode: 'active', migrationId: operation } as const;
  const issues = [
    { scope: 'memory/global', key: 'm_deploy', issue: 'legacy_journal_head_mismatch' },
    { scope: 'memory/global', key: 'm_owner', issue: 'current_revision_preserved' },
    { scope: 'memory/personas/lin-lan', key: '', issue: 'legacy_inventory_incomplete' },
    { scope: 'memory/global', key: 'm_a', issue: 'legacy_head_missing' },
    { scope: 'memory/global', key: 'm_b', issue: 'duplicate_legacy_identity' },
    { scope: 'memory/global', key: 'notes.md', issue: 'unreadable_source' },
  ];
  const failed = { version: 1, epoch: 2, backend: 'legacy', mode: 'migrating', migration: { id: operation, namespaces, index: 2, issues, phase: 'failed', failure: { code: 'memory.source_invalid', message: 'Memory source validation found 6 issue(s); repair the listed sources and retry this operation' } } } as const;
  const running = { ...failed, migration: { id: operation, namespaces, index: 0, issues: [], phase: 'importing' } } as const;
  const current = () => fixtureEntry({ id: 'm_deploy', title: 'Deployment procedure', revision: 'mem2:rev-current' });

  it('lists the sources that stopped the upgrade in its own words, without the raw English message', async () => {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(failed);
    const container = await renderPage();
    const status = container.querySelector('[data-memory-upgrade="failed"]')!;
    expect(status.querySelector('[data-memory-upgrade-failure="memory.source_invalid"]')!.textContent).toBe('6 sources need repair. Fix them, then retry the upgrade.');
    expect(container.querySelector('[data-memory-store]')!.textContent).toBe('Upgrade stopped');
    expect(status.textContent).not.toContain('Memory source validation found');
    expect(status.querySelectorAll('[data-memory-upgrade-issue]')).toHaveLength(5);
    expect(status.querySelector('[data-memory-upgrade-issue="legacy_journal_head_mismatch"]')!.textContent).toContain('memory/global · m_deploy');
    await click(container, '[data-memory-upgrade-issues-toggle]');
    const unknown = container.querySelector('[data-memory-upgrade-issue="unreadable_source"]')!;
    expect(unknown.textContent).toContain('This source could not be imported');
    expect(unknown.textContent).toContain('unreadable_source');
    expect(container.querySelector('[data-memory-upgrade-progress="2/2"]')).not.toBeNull();
  });

  it('retries the same operation, and after a lost answer reads the status instead of retrying blindly', async () => {
    seedMemories({ 'global::': [current()] });
    const authority = vi.spyOn(client, 'memoryAuthority').mockResolvedValue(failed);
    const retry = vi.spyOn(client, 'retryMemoryMigration').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const container = await renderPage();
    const reads = authority.mock.calls.length;
    authority.mockResolvedValue(running);
    await click(container, '[data-memory-upgrade-retry]');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(operation);
    expect(authority.mock.calls.length).toBeGreaterThan(reads);
    expect(container.querySelector('[data-memory-upgrade="importing"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-upgrade-retry-unconfirmed]')).not.toBeNull();
    expect(container.querySelector('[data-memory-upgrade-retry]')).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('re-reads entries when the upgrade completes, keeping the selected entry and reaching edits', async () => {
    const list = seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue(running);
    const { container, queryClient } = await mountPage('/memory?entry=m_deploy');
    expect(list).not.toHaveBeenCalled();
    expect(container.querySelector('[data-memory-detail]')).toBeNull();
    await act(async () => { queryClient.setQueryData(['memory-authority'], sqlite); });
    await flush();
    expect(list).toHaveBeenCalled();
    expect(container.querySelector('[data-memory-upgrade]')).toBeNull();
    expect(container.querySelector('[data-memory-detail="m_deploy"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-edit]')).not.toBeNull();
    expect(container.querySelector('[data-memory-store="governed"]')).not.toBeNull();
  });

  it('leaves read-only recovery to its own resume and offers no upgrade retry', async () => {
    seedMemories({ 'global::': [current()] });
    vi.spyOn(client, 'memoryProvenance').mockResolvedValue({ sources: [], adjudications: [], relatedObjectIds: ['m_deploy'] });
    vi.spyOn(client, 'memoryAuthority').mockResolvedValue({ ...sqlite, mode: 'readonly', recoveryId: 'recovery-1' });
    const retry = vi.spyOn(client, 'retryMemoryMigration');
    const container = await renderPage();
    expect(container.querySelector('[data-memory-write-hold="readonly"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-resume]')).not.toBeNull();
    expect(container.querySelector('[data-memory-upgrade]')).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });
});

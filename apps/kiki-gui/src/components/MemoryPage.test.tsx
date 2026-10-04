// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSnapshot, Session, Workspace } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import { KikiClient, MEMORY_TYPES, type MemoryEntry, type MemoryJournalRecord, type MemorySettings } from '../lib/client';
import { MemoryPage } from './MemoryPage';
import { memorySourceTargets } from './useMemorySources';
import { memorySnapshot } from './MemoryHistory';
import { DirtyGuardContext, useDirtyGuardState } from './dirtyGuard';

const listBots = vi.hoisted(() => vi.fn(async () => [] as { personaId: string; name: string; homeSessionId: string; hidden: boolean; pinned: boolean }[]));
vi.mock('../lib/botRooms', () => ({ BOTS_QUERY_KEY: ['bots'], useBotRoomApi: () => ({ listBots }) }));

const client = new KikiClient({ baseUrl: 'http://example.test', token: 'example-token' });
vi.mock('../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => undefined,
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

async function mountPage(path = '/memory', workspaces: readonly Workspace[] = [], workspacesLoading = false, liveDirectory = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container, queryClient });
  function DirectoryPage() {
    const directory = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces() });
    return <MemoryPage workspaceOptions={directory.data?.items ?? []} workspacesLoading={directory.isPending} onNavigate={() => {}} onToggleSidebar={() => {}} />;
  }
  const rerender = async (nextWorkspaces: readonly Workspace[], loading = false) => {
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
async function mountGuardedPage(path = '/memory', workspaces: readonly Workspace[] = []) {
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

async function renderPage(path = '/memory', workspaces: readonly Workspace[] = []) {
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
  await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
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
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
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
  const button = container.querySelector<HTMLElement>(selector)!;
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

  it('does not invent snapshots for missing or hand-edited metadata', () => {
    expect(memorySnapshot(null, null)).toBeUndefined();
    expect(memorySnapshot('---\ntitle: Hand edited\n---\nOriginal body', 'rev')).toBeUndefined();
    expect(memorySnapshot('---\n{}\n---\nOriginal body', 'rev')).toBeUndefined();
    const original = fixtureEntry({ body: 'Body\nwith lines.' });
    expect(memorySnapshot(rawSnapshot(original).replace(/\n/g, '\r\n'), original.revision)?.title).toBe(original.title);
  });
});

describe('MemoryPage scope switcher', () => {
  const manyWorkspaces = Array.from({ length: 120 }, (_, index) => ({
    id: `wd_${String(index).padStart(3, '0')}`,
    name: index === 42 ? 'docs-site' : `project-${String(index).padStart(3, '0')}`,
    root: `/fixture/ws/${index}`,
    created_at: '2026-01-01',
    last_opened_at: '2026-01-01',
    session_count: 0,
    pinned: false,
    isGit: false,
  } satisfies Workspace));

  const scopeKind = (container: HTMLElement) => container.querySelector('[data-memory-scope-kind]')?.getAttribute('data-memory-scope-kind');
  const sourceKeys = (container: HTMLElement) => [...container.querySelectorAll('[data-memory-source]')].map((node) => node.getAttribute('data-memory-source'));

  async function typeCombobox(container: HTMLElement, value: string) {
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
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
    expect(container.querySelectorAll('[data-option-value]').length).toBe(120);
    await typeCombobox(container, 'docs');
    expect(container.querySelectorAll('[data-option-value]').length).toBe(1);
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
    expect(container.querySelectorAll('[data-option-value]').length).toBe(0);
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('not-a-workspace');
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(routeParams(container).get('workspace')).toBe(workspace.id);
    expect(container.querySelector('#memory-workspace-picker')?.getAttribute('aria-expanded')).toBe('true');
    await typeCombobox(container, '');
    expect(container.querySelectorAll('[data-option-value]').length).toBe(1);
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
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
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
    const directory = deferred<Awaited<ReturnType<KikiClient['listWorkspaces']>>>();
    const readDirectory = vi.spyOn(client, 'listWorkspaces').mockReturnValueOnce(directory.promise).mockResolvedValue({ items: [workspace] });
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
    vi.spyOn(client, 'memoryInbox').mockResolvedValue(inbox);
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

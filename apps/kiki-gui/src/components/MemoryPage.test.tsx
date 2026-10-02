// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSnapshot, Session, Workspace } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import { KikiClient, MEMORY_TYPES, type MemoryEntry, type MemoryJournalRecord, type MemorySettings } from '../lib/client';
import { MemoryPage } from './MemoryPage';
import { memorySourceTargets } from './useMemorySources';
import { memorySnapshot } from './MemoryHistory';

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

async function renderPage(path = '/memory', workspaces: readonly Workspace[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container, queryClient });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <MemoryPage workspaceOptions={workspaces} onNavigate={() => {}} onToggleSidebar={() => {}} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
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

  it('includes a hidden Bot’s home memory even when opened from a different workspace', async () => {
    seedBot([]);
    const list = seedMemories({
      'persona::lin-lan': [fixtureEntry({ id: 'm_persona', title: 'Personal preference' })],
      'persona_workspace:wd_home:lin-lan': [fixtureEntry({ id: 'm_home', title: 'Bot home rule' })],
      'persona_workspace:wd_current:lin-lan': [fixtureEntry({ id: 'm_current' })],
      'global::': [fixtureEntry({ id: 'm_shared' })],
    });
    const container = await renderPage('/memory?workspace=wd_current&persona=lin-lan', [workspace]);
    await flush();
    expect(rowIds(container)).toEqual(['m_current', 'm_home', 'm_persona']);
    expect(container.querySelector('[data-memory-source="workspace:wd_home/persona:lin-lan"]')?.textContent).toContain('Bot · Lin Lan');
    expect(list.mock.calls.some(([target]) => target.scope === 'global')).toBe(false);
    expect(container.querySelector<HTMLInputElement>('#memory-share-global')!.checked).toBe(false);
    await search(container, 'home rule');
    expect(rowIds(container)).toEqual(['m_home']);
    expect(list.mock.calls.slice(-3).every(([, query]) => query?.query === 'home rule')).toBe(true);
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
  it('opens archived content and expands full before/after snapshots, revision chain, reason, scope and time', async () => {
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
    await click(container, '[data-memory-history-record="op_archive"] summary');
    const details = container.querySelector<HTMLDetailsElement>('[data-memory-history-record]')!;
    expect(details.open).toBe(true);
    const content = details.textContent!;
    for (const value of ['rev_before → rev_after', 'Before this change', 'After this change', before.body, before.reason, after.reason, 'Global', 'Scope', '2026']) expect(content).toContain(value);
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
    await click(container, '[data-memory-history-record="op_first"] summary');
    const content = container.querySelector('[data-memory-history-detail="op_first"]')!.textContent!;
    expect(content).toContain('Intermediate body');
    expect(content).toContain('First body');
    expect(content).not.toContain('Latest body');
  });

  it('does not invent snapshots for missing or hand-edited metadata', () => {
    expect(memorySnapshot(null, null)).toBeUndefined();
    expect(memorySnapshot('---\ntitle: Hand edited\n---\nOriginal body', 'rev')).toBeUndefined();
    expect(memorySnapshot('---\n{}\n---\nOriginal body', 'rev')).toBeUndefined();
    const original = fixtureEntry({ body: 'Body\nwith lines.' });
    expect(memorySnapshot(rawSnapshot(original).replace(/\n/g, '\r\n'), original.revision)?.title).toBe(original.title);
  });
});

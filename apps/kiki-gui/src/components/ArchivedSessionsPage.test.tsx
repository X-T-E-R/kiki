// @vitest-environment jsdom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListSessionsResponse, Session, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { KikiClient, type ListSessionsOptions } from '../lib/client';
import { clearToasts, getToasts } from '../lib/toasts';
import { writeTopLevelThreads } from '../lib/threadDisplayMemory';
import { ArchivedSessionsPage } from './ArchivedSessionsPage';
import { SessionsSection } from './settings/SessionsSection';

// The import-history card on this settings section is gated by a capability
// probe; this slice must not change it, so it is stubbed off and the rest of
// the section renders exactly as it does in the app.
vi.mock('../lib/importHistory', () => ({ useImportHistoryEnabled: () => ({ enabled: false }) }));

const client = new KikiClient({ baseUrl: 'http://example.test', token: 'example-token' });

// The page reads the scope with the client, so the mock hands out both and can
// be re-pointed at another home the way a connection switch does.
let scopeId = 'local';
let pageClient = client;
vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: pageClient, scopeId }),
  useOptionalConnection: () => ({ client: pageClient, scopeId }),
}));

const WORKSPACES: readonly Workspace[] = [
  { id: 'ws-1', root: '/w/research', name: 'Research', created_at: '2026-01-01T00:00:00Z', last_opened_at: '2026-01-02T00:00:00Z', session_count: 3, pinned: false, isGit: true },
  { id: 'ws-2', root: '/w/workshop', name: 'Workshop', created_at: '2026-01-01T00:00:00Z', last_opened_at: '2026-01-02T00:00:00Z', session_count: 1, pinned: false, isGit: false },
];

function archived(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    workspace_id: 'ws-1',
    title: `Archived ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    busy: false,
    pending_interaction: 'none',
    archived: true,
    metadata: { cwd: '/w/research' },
    agent_config: {},
    usage: {},
    permission_rules: [],
    message_count: 3,
    last_seq: 7,
    ...patch,
  } as Session;
}

const mounted: { root: Root; container: HTMLDivElement; queryClient: QueryClient }[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  scopeId = 'local';
  pageClient = client;
  // The toast queue is a module-level store shared by every test in the file,
  // so each case starts from an empty one rather than reading another's.
  clearToasts();
});
afterEach(async () => {
  for (const { root, container, queryClient } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    container.remove();
  }
  vi.restoreAllMocks();
  localStorage.clear();
});

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function settleDebounce() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
  await flush();
}

function RouteProbe() {
  const location = useLocation();
  return <output hidden data-archive-route>{location.pathname}</output>;
}

async function mountPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container, queryClient });
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter initialEntries={['/archived']}>
              <RouteProbe />
              <ArchivedSessionsPage onToggleSidebar={() => {}} />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
  });
  await flush();
  return { container, queryClient, root };
}

/** The wire query the page sends, narrowed to the fields this page uses. */

/** The wire query the page sends, narrowed to the fields this page uses. */
type ListSessionsQuery = Pick<ListSessionsOptions, 'archived_only' | 'page_size' | 'before_id' | 'q' | 'include_archive'>;

function listSpy(implement: (query: ListSessionsQuery) => ListSessionsResponse) {
  return vi.spyOn(client, 'listSessions').mockImplementation(async (query = {}) => implement(query ?? {}));
}

/** The server's archive as a store the test deletes from, so a fresh read is real. */
function archiveFixture(rows: readonly Session[], serverPageSize = 50) {
  let held = [...rows];
  const list = (query: ListSessionsQuery): ListSessionsResponse => {
    const term = query.q?.toLowerCase() ?? '';
    const matches = held.filter((session) => session.title.toLowerCase().includes(term));
    const start = query.before_id === undefined
      ? 0
      : matches.findIndex((session) => session.id === query.before_id) + 1;
    const page = matches.slice(start, start + serverPageSize);
    const hasMore = start + serverPageSize < matches.length;
    return {
      items: [...page],
      has_more: hasMore,
      next_cursor: hasMore ? page.at(-1)?.id : undefined,
    };
  };
  return Object.assign(list, {
    /** Everything the connection still holds, in every page. */
    all: () => held.map((session) => session.id),
    forget: (id: string) => { held = held.filter((session) => session.id !== id); },
  });
}

function rowIds(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll<HTMLElement>('[data-archive-item]')].map((row) => row.dataset['archiveItem'] ?? null);
}

async function click(element: Element | null | undefined) {
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}

function confirmDialog(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="alertdialog"]') as HTMLElement;
}

async function typeSearch(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[data-archive-search]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settleDebounce();
}

describe('ArchivedSessionsPage', () => {
  it('lists archived conversations with their workspace and time, and never asks for the unarchived list', async () => {
    const list = listSpy(archiveFixture([archived('one'), archived('two', { workspace_id: 'ws-2' })]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);

    const { container } = await mountPage();

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ archived_only: true, page_size: 50, before_id: undefined }));
    expect(list.mock.calls.every(([query]) => query?.include_archive === undefined)).toBe(true);
    expect(rowIds(container)).toEqual(['one', 'two']);
    const first = container.querySelector('[data-archive-item="one"]')!;
    expect(first.querySelector('[data-archive-open]')?.textContent).toContain('Archived one');
    expect(first.querySelector('[data-archive-open]')?.textContent).toContain('Research');
    expect(container.querySelector('[data-archive-item="two"]')?.textContent).toContain('Workshop');
    expect(container.querySelector('[data-archive-empty]')).toBeNull();
  });

  it('walks older pages with the server cursor and says when the archive ends', async () => {
    const list = listSpy(archiveFixture([archived('page-1-a'), archived('page-1-b'), archived('page-2-a')], 2));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);

    const { container } = await mountPage();
    expect(rowIds(container)).toEqual(['page-1-a', 'page-1-b']);
    expect(container.querySelector('[data-archive-end]')).toBeNull();

    await click(container.querySelector('[data-archive-load-older]'));

    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before_id: 'page-1-b' }));
    expect(rowIds(container)).toEqual(['page-1-a', 'page-1-b', 'page-2-a']);
    expect(container.querySelector('[data-archive-end]')).not.toBeNull();
    expect(container.querySelector('[data-archive-count]')?.textContent).toBe('3');
  });

  it('sends the typed text as the server query and drops it from an empty page', async () => {
    const list = listSpy(archiveFixture([archived('matching', { title: 'Release notes' }), archived('other', { title: 'Unrelated' })]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);

    const { container } = await mountPage();
    await typeSearch(container, 'release');

    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'release', archived_only: true }));
    expect(rowIds(container)).toEqual(['matching']);
    await typeSearch(container, 'nothing here');
    expect(container.querySelector('[data-archive-empty]')?.textContent).toContain('nothing here');
  });

  it('opens an archived conversation on the existing read route', async () => {
    listSpy(archiveFixture([archived('open-me')]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-open="open-me"]'));

    expect(container.querySelector('[data-archive-route]')?.textContent).toBe('/s/open-me');
  });

  it('returns to session settings from the archive page', async () => {
    listSpy(archiveFixture([archived('one')]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-back]'));

    expect(container.querySelector('[data-archive-route]')?.textContent).toBe('/settings/sessions');
  });

  it('cancelling a single delete writes nothing and keeps the row', async () => {
    listSpy(archiveFixture([archived('keep-me')]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    const deleteOne = vi.spyOn(client, 'deleteArchivedSession');

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-delete="keep-me"]'));

    const dialog = confirmDialog(container);
    expect(dialog.textContent).toContain('Archived keep-me');
    expect(dialog.textContent).toContain('archived conversations attached to it are deleted with it');
    expect(dialog.textContent).toContain('promoted to the top level are not deleted with it');

    await click(dialog.querySelector('[data-autofocus], button:not([data-confirm-action])'));
    await flush();

    expect(deleteOne).not.toHaveBeenCalled();
    expect(rowIds(container)).toEqual(['keep-me']);
  });

  it('holds back the promoted top-level conversations, shows the row as pending, and reads the archive fresh', async () => {
    writeTopLevelThreads('local', new Set(['promoted']));
    const server = archiveFixture([archived('root'), archived('promoted')]);
    listSpy(server);
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    let release = (): void => {};
    const deleteOne = vi.spyOn(client, 'deleteArchivedSession').mockImplementation((id, options) => new Promise((resolve) => {
      release = () => {
        // The server removes the row, holding back whatever the caller
        // excluded: the promoted top-level row is not one of the deleted
        // ids, so it stays archived and is listed again by the fresh read.
        for (const excluded of options?.exclude_session_ids ?? []) expect(excluded).not.toBe(id);
        server.forget(id);
        resolve({ deleted_ids: [id], failed: [] });
      };
    }));

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-delete="root"]'));
    const dialog = confirmDialog(container);

    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await flush(2);

    expect(deleteOne).toHaveBeenCalledWith('root', { exclude_session_ids: ['promoted'] });
    expect(container.querySelector('[data-archive-delete="root"]')?.getAttribute('aria-label')).toBe('Deleting');
    expect(confirmDialog(container).querySelector('[data-confirm-action="confirm"]')?.hasAttribute('disabled')).toBe(true);

    await act(async () => { release(); });
    await flush();

    // Fresh from the server: the deleted row is gone and the promoted one is
    // still archived, because the delete held it back.
    expect(rowIds(container)).toEqual(['promoted']);
    expect(container.querySelector('[data-archive-item="root"]')).toBeNull();
    expect(getToasts().at(-1)).toMatchObject({ tone: 'success', text: 'Deleted Archived root' });
  });

  it('lists every member a partial family delete could not remove, not just a count', async () => {
    const server = archiveFixture([archived('root'), archived('child-a'), archived('child-b')]);
    listSpy(server);
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    const deleteOne = vi.spyOn(client, 'deleteArchivedSession').mockImplementation(async () => {
      // The root goes, two members do not: a toast count would hide both.
      server.forget('root');
      return {
        deleted_ids: ['root'],
        failed: [
          { id: 'child-a', title: 'Archived child-a', message: 'conversation is still attached to a live run' },
          { id: 'child-b', message: 'conversation is locked by an open editor' },
        ],
      };
    });

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-delete="root"]'));
    await click(confirmDialog(container).querySelector('[data-confirm-action="confirm"]'));
    await flush();

    expect(deleteOne).toHaveBeenCalledTimes(1);
    const listed = [...container.querySelectorAll('[data-archive-failed-item]')];
    expect(listed.length, 'each undeleted member is named').toBe(2);
    expect(listed[0]!.textContent).toContain('Archived child-a');
    expect(listed[0]!.textContent).toContain('still attached to a live run');
    expect(listed[1]!.textContent).toContain('Archived child-b');
    expect(listed[1]!.textContent).toContain('locked by an open editor');
    // Fresh: the survivors are back on screen under their own rows.
    expect(rowIds(container)).toEqual(['child-a', 'child-b']);
  });

  it('holds a partial result until it is dismissed or replaced', async () => {
    listSpy(archiveFixture([archived('stuck')]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    vi.spyOn(client, 'deleteArchivedSession')
      .mockResolvedValue({ deleted_ids: [], failed: [{ id: 'stuck', message: 'conversation is still attached to a live run' }] });

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-delete="stuck"]'));
    await click(confirmDialog(container).querySelector('[data-confirm-action="confirm"]'));
    await flush();

    // A later unrelated read must not wipe what the user has not acted on yet.
    await typeSearch(container, 'stuck');
    expect(container.querySelector('[data-archive-failed-item="stuck"]'), 'the result survives a re-read').not.toBeNull();

    await click(container.querySelector('[data-archive-error-dismiss]'));
    expect(container.querySelector('[data-archive-error]')).toBeNull();
  });

  it('keeps the row pending until the fresh read has answered, not just while the request is in flight', async () => {
    const server = archiveFixture([archived('root')]);
    // The first read answers; every re-read after it is held open.
    let releaseFresh = (): void => {};
    let reads = 0;
    const list = vi.spyOn(client, 'listSessions').mockImplementation(async (query = {}) => {
      reads += 1;
      if (reads > 1) await new Promise<void>((resolve) => { releaseFresh = resolve; });
      return server(query ?? {});
    });
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    // The delete itself answers at once: the pending state has to outlive it.
    const deleteOne = vi.spyOn(client, 'deleteArchivedSession').mockImplementation(async () => {
      server.forget('root');
      return { deleted_ids: ['root'], failed: [] };
    });

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-delete="root"]'));
    await click(confirmDialog(container).querySelector('[data-confirm-action="confirm"]'));
    await flush(3);

    expect(deleteOne).toHaveBeenCalledTimes(1);
    expect(reads > 1, 'the delete must have triggered a fresh read').toBe(true);
    // The delete answered, but the fresh read has not: the row is still
    // pending, and the bulk action is not yet safe to offer.
    expect(container.querySelector('[data-archive-delete="root"]')?.getAttribute('aria-label')).toBe('Deleting');
    const bulk = container.querySelector('[data-archive-delete-all]');
    expect(bulk?.hasAttribute('disabled'), 'the bulk action stays disabled until the list is fresh').toBe(true);

    const deleteAll = vi.spyOn(client, 'deleteAllArchivedSessions').mockResolvedValue({ deleted_ids: [], failed: [] });
    // A disabled control drops the click on its own; nothing has to cooperate.
    await act(async () => { (bulk as HTMLButtonElement | null)?.click(); });
    await flush();
    expect(deleteAll, 'a second deletion cannot start against a list that is still pre-delete').not.toHaveBeenCalled();

    await act(async () => { releaseFresh(); });
    await flush();
    expect(container.querySelector('[data-archive-delete="root"]'), 'the fresh read drops the deleted row').toBeNull();
    expect(container.querySelector('[data-archive-item]')?.getAttribute('aria-label')).toBeUndefined();
    expect(container.querySelector('[data-archive-empty]')?.textContent).toContain('No archived conversations');
    expect(list).toHaveBeenCalled();
  });

  it('lets a late success from the previous scope toast nothing and refresh only its own cache', async () => {
    const remoteClient = new KikiClient({ baseUrl: 'http://example.test', token: 'example-token' });
    const local = archiveFixture([archived('local-only')]);
    const remote = archiveFixture([archived('remote-only')]);

    scopeId = 'local';
    pageClient = client;
    const localList = listSpy(local);
    const localDelete = vi.spyOn(client, 'deleteArchivedSession');
    let settleDelete = (): void => {};
    // A real success: this path pushes a toast, which is the module-level store
    // the scope key cannot switch off.
    localDelete.mockImplementation(() => new Promise((resolve) => {
      settleDelete = () => { local.forget('local-only'); resolve({ deleted_ids: ['local-only'], failed: [] }); };
    }));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);

    // One QueryClient per scope, as the connection provider does.
    const localQueries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const remoteQueries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let queries = localQueries;
    const localInvalidate = vi.spyOn(localQueries, 'invalidateQueries');
    const remoteInvalidate = vi.spyOn(remoteQueries, 'invalidateQueries');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container, queryClient: localQueries });
    const render = async () => {
      await act(async () => {
        root.render(
          <StrictMode>
            <QueryClientProvider client={queries}>
              <I18nProvider>
                <MemoryRouter initialEntries={['/archived']}>
                  <RouteProbe />
                  <ArchivedSessionsPage onToggleSidebar={() => {}} />
                </MemoryRouter>
              </I18nProvider>
            </QueryClientProvider>
          </StrictMode>,
        );
      });
      await flush();
    };
    await render();

    await click(container.querySelector('[data-archive-delete="local-only"]'));
    await act(async () => { confirmDialog(container).querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await flush(2);
    expect(localDelete).toHaveBeenCalledTimes(1);

    // The connection changes while that deletion is still in flight.
    pageClient = remoteClient;
    scopeId = 'remote:example.test';
    queries = remoteQueries;
    vi.spyOn(remoteClient, 'listSessions').mockImplementation(async (query = {}) => remote(query ?? {}));
    vi.spyOn(remoteClient, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    await render();

    expect(rowIds(container)).toEqual(['remote-only']);
    expect(remoteInvalidate, 'the new scope has not deleted anything yet').not.toHaveBeenCalled();

    // The old request answers now, as a success.
    await act(async () => { settleDelete(); });
    await flush();

    expect(getToasts().length, 'a success from the previous scope must not toast into this one').toBe(0);
    expect(container.querySelector('[data-archive-error]')).toBeNull();
    expect(rowIds(container)).toEqual(['remote-only']);
    // It did refresh: its own list, not this one's.
    expect(localInvalidate, 'the scope that deleted must still re-read its own archive').toHaveBeenCalled();
    expect(remoteInvalidate, 'the new scope must not be invalidated by the old one').not.toHaveBeenCalled();

    // And this scope is usable on its own terms.
    expect(container.querySelector('[data-archive-delete="remote-only"]')).not.toBeNull();
    void localList;
  });

  it('names an unnamed failure by its loaded title, or "Untitled" plus the id that tells it apart', async () => {
    listSpy(archiveFixture([archived('listed')]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    const deleteAll = vi.spyOn(client, 'deleteAllArchivedSessions').mockResolvedValue({
      deleted_ids: [],
      failed: [
        // Blank server titles still use the loaded title or the untitled fallback.
        { id: 'listed', title: ' ', message: 'conversation is still attached to a live run' },
        { id: 'session_opaque_9f2', title: '', message: 'workspace is read-only' },
      ],
    });

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-delete-all]'));
    await click(confirmDialog(container).querySelector('[data-confirm-action="confirm"]'));
    await flush();

    const items = [...container.querySelectorAll('[data-archive-failed-item]')];
    expect(items.length, 'every undeleted entry is listed, not summarised').toBe(2);
    expect(items[0]!.textContent).toContain('Archived listed');
    expect(items[0]!.textContent).toContain('still attached to a live run');
    expect(items[1]!.textContent).toContain('Untitled conversation');
    expect(items[1]!.textContent).toContain('workspace is read-only');
    // Two entries that share no title still have to be distinguishable.
    expect(items[1]!.textContent).toContain('session_opaque_9f2');
  });

  it('keeps delete all reachable when the search matches nothing, because its scope is the whole archive', async () => {
    listSpy(archiveFixture([archived('findable')]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    const deleteAll = vi.spyOn(client, 'deleteAllArchivedSessions').mockResolvedValue({ deleted_ids: [], failed: [] });

    const { container } = await mountPage();
    await typeSearch(container, 'nothing matches this');

    expect(container.querySelector('[data-archive-empty]')?.textContent).toContain('No archived conversation matches');
    const bulk = container.querySelector('[data-archive-delete-all]');
    expect(bulk, 'a search miss must not hide the one action the search does not scope').not.toBeNull();
    await click(bulk);
    await click(confirmDialog(container).querySelector('[data-confirm-action="confirm"]'));
    await flush();
    // And it still reaches the whole archive, not the empty result on screen.
    expect(deleteAll).toHaveBeenCalledWith();
  });

  it('delete all reaches past the current search and page, and a partial result is not a success', async () => {
    const server = archiveFixture([archived('listed-a'), archived('listed-b')], 1);
    listSpy(server);
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    const deleteAll = vi.spyOn(client, 'deleteAllArchivedSessions').mockImplementation(async () => {
      // Four archived conversations across both pages; the route deletes the
      // three it can and reports the one it cannot.
      for (const id of ['listed-a', 'listed-b', 'off-screen']) server.forget(id);
      return {
        deleted_ids: ['listed-a', 'listed-b', 'off-screen'],
        failed: [{ id: 'stuck-anywhere', title: 'Hidden three', message: 'conversation is still attached to a live run' }],
      };
    });

    const { container } = await mountPage();
    await click(container.querySelector('[data-archive-load-older]'));
    await typeSearch(container, 'listed');

    await click(container.querySelector('[data-archive-delete-all]'));
    const dialog = confirmDialog(container);
    expect(dialog.textContent).toContain('permanently deletes every archived conversation on this connection');
    expect(dialog.textContent).toContain('regardless of the current search or loaded pages');
    expect(dialog.textContent).toContain('It cannot be undone.');
    expect(dialog.textContent).toContain('Unarchived conversations stay.');

    await click(dialog.querySelector('[data-confirm-action="confirm"]'));
    await flush();

    // No filters ride along: the server decides the whole archive, not the view.
    expect(deleteAll).toHaveBeenCalledWith();
    expect(getToasts().some((toast) => toast.tone === 'success')).toBe(false);
    expect(getToasts().some((toast) => toast.text.includes('Deleted 3 of 4'))).toBe(true);
    // The undeleted entry is on the result surface, named and reasoned.
    const kept = container.querySelector('[data-archive-failed-item]');
    expect(kept?.textContent).toContain('Hidden three');
    expect(kept?.textContent).toContain('still attached to a live run');
    // Fresh: nothing deleted remains on screen, and the search miss still
    // offers the operation that does not depend on the search.
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelector('[data-archive-delete-all]')).not.toBeNull();
    expect(container.querySelector('[data-archive-empty]')?.textContent).toContain('No archived conversation matches');
  });

  it('withdraws the bulk action only when the unfiltered archive is genuinely empty', async () => {
    listSpy(archiveFixture([]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);

    const { container } = await mountPage();
    expect(container.querySelector('[data-archive-empty]')?.textContent).toContain('No archived conversations');
    expect(container.querySelector('[data-archive-delete-all]')).toBeNull();
    expect(container.querySelector('[data-archive-list]')).toBeNull();
  });

  it('re-reads under the new scope instead of showing the previous connection archive', async () => {
    const list = listSpy(archiveFixture([archived('local-only')]));
    vi.spyOn(client, 'listWorkspaces').mockResolvedValue({ items: [...WORKSPACES] } as never);
    const first = await mountPage();
    expect(rowIds(first.container)).toEqual(['local-only']);
    // Unmount so the next mount reads under the new scope's own query key.
    await act(async () => { first.root.unmount(); });
    mounted.length = 0;
    first.container.remove();

    scopeId = 'remote:example.test';
    list.mockImplementation(async (query = {}) => archiveFixture([archived('remote-only')])(query ?? {}));
    const { container } = await mountPage();

    expect(list).toHaveBeenCalled();
    expect(rowIds(container)).toEqual(['remote-only']);
    expect(container.querySelector('[data-archive-item="local-only"]')).toBeNull();
  });
});

/**
 * The way in. The section renders as a whole, so this also holds the rest of
 * Settings → Sessions to its current shape: the archive entry is added, and
 * nothing else on the section moves or disappears.
 */
describe('SessionsSection archive entry', () => {
  it('offers the archive first and leaves the other session cards where they were', async () => {
    vi.spyOn(client, 'getConfig').mockResolvedValue({ interaction: {}, session_title: {} } as never);
    vi.spyOn(client, 'meta').mockResolvedValue({ experimental_flags: {} } as never);
    vi.spyOn(client, 'listModels').mockResolvedValue({ items: [] } as never);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container, queryClient });
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <I18nProvider>
              <MemoryRouter initialEntries={['/settings/sessions']}>
                <RouteProbe />
                <SessionsSection />
              </MemoryRouter>
            </I18nProvider>
          </QueryClientProvider>
        </StrictMode>,
      );
    });
    await flush();

    const cards = [...container.querySelectorAll<HTMLElement>('[data-settings-card]')]
      .map((card) => card.dataset['settingsCard'] ?? null);
    expect(cards).toEqual([
      'st-card-archived',
      'st-card-defaults',
      'st-card-questions',
      'st-card-session-title',
      'st-card-agent-messaging',
    ]);

    const entry = container.querySelector('[data-settings-open-archived]')!;
    expect(entry.textContent).toContain('Manage archived conversations');
    await click(entry);
    expect(container.querySelector('[data-archive-route]')?.textContent).toBe('/archived');
  });
});
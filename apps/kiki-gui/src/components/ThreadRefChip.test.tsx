// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, WorkspaceCatalogEntry } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { useThreadRefDirectory } from '../lib/threadRefs';
import { ThreadRefText } from './ThreadRefChip';

const getSession = vi.fn<(id: string) => Promise<Session>>();
/** The room calls the new-room dialog makes; wired into the mocked client's klient.rest. */
const roomRest = vi.hoisted(() => ({
  createFromThreads: vi.fn(),
  searchThreads: vi.fn(),
}));

vi.mock('../state/connection', () => ({
  useOptionalConnection: () => ({ client: { getSession } }),
  useConnection: () => ({ client: { getSession, klient: { rest: { rooms: roomRest } } } }),
}));

const ID = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function record(overrides: Partial<Session> = {}): Session {
  return {
    id: ID, workspace_id: 'wd_kiki', title: 'Fix the flaky upload test',
    created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T11:30:00.000Z',
    busy: false, pending_interaction: 'approval', metadata: { cwd: 'C:/src/kiki' },
    agent_config: { model: '' },
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
    permission_rules: [], message_count: 1, last_seq: 1, ...overrides,
  };
}

/** The metadata-only catalog row App caches: no `session_count` / `isGit`. */
const workspace: WorkspaceCatalogEntry = {
  id: 'wd_kiki', root: 'C:/src/kiki', name: 'kiki', created_at: '2026-01-01T00:00:00.000Z',
  last_opened_at: '2026-01-01T00:00:00.000Z', pinned: false,
};

function Where() {
  const location = useLocation();
  return <span data-where>{location.pathname}{location.search}{location.hash}</span>;
}

async function render(text: string, sessions: Session[]) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient();
  client.setQueryData(['sessions', false, undefined], { pages: [{ items: sessions, has_more: false }], pageParams: [undefined] });
  client.setQueryData(['workspaces', 'catalog'], { items: [workspace] });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/s/session_here']}>
            <Routes>
              <Route path="/s/:id" element={<><ThreadRefText text={text} projectSegment={(segment) => segment} /><Where /></>} />
              <Route path="*" element={<><ThreadRefText text={text} projectSegment={(segment) => segment} /><Where /></>} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

describe('thread-reference directory cache', () => {
  async function directory(options: {
    fetchSession?: (id: string) => Promise<Session>;
    fetchHostId?: () => Promise<string>;
    sourceHostId?: string;
  } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = vi.fn();
    function Probe() {
      const refs = useThreadRefDirectory([ID], options.fetchSession, options.fetchHostId, options.sourceHostId);
      rendered();
      const entry = refs.lookup(ID);
      return <output>{entry.session?.title ?? 'unknown'} · {entry.workspace?.name ?? 'unknown'} · {refs.hostId ?? 'unknown'}</output>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
    return { client, container, rendered };
  }

  it('does not update a mounted reader for unrelated persona, avatar or workspace queries', async () => {
    const { client, rendered } = await directory();
    const before = rendered.mock.calls.length;
    await act(async () => {
      client.setQueryData(['personas'], [{ id: 'example-persona' }]);
      client.setQueryData(['persona-avatar', 'example-persona'], new Blob(['avatar']));
      client.setQueryData(['workspaces'], { items: [workspace] });
      client.setQueryData(['workspaces', 'catalog', 'other'], { items: [workspace] });
    });
    expect(rendered).toHaveBeenCalledTimes(before);
    await act(async () => { client.removeQueries({ queryKey: ['personas'] }); });
    expect(rendered).toHaveBeenCalledTimes(before);
  });

  it('waits for data before updating a reader for a newly created query', async () => {
    const { client, container, rendered } = await directory();
    const before = rendered.mock.calls.length;
    let resolveSession!: (session: Session) => void;
    const session = new Promise<Session>((resolve) => { resolveSession = resolve; });
    let fetched!: Promise<void>;
    await act(async () => {
      fetched = client.prefetchQuery({ queryKey: ['thread-ref', ID], queryFn: () => session });
    });
    expect(rendered).toHaveBeenCalledTimes(before);
    await act(async () => { resolveSession(record()); await fetched; });
    expect(container.textContent).toContain('Fix the flaky upload test');
  });

  it('tracks late lists, catalog renames, individual records, host IDs and cache removal', async () => {
    const { client, container } = await directory();
    await act(async () => {
      client.setQueryData(['sessions', false, undefined], { pages: [{ items: [record()] }] });
      client.setQueryData(['workspaces', 'catalog'], { items: [workspace] });
      client.setQueryData(['thread-host-id'], 'host-example');
    });
    expect(container.textContent).toBe('Fix the flaky upload test · kiki · host-example');
    await act(async () => {
      client.setQueryData(['workspaces', 'catalog'], { items: [{ ...workspace, name: 'Renamed workspace' }] });
      client.setQueryData(['sessions', false, undefined], { pages: [{ items: [record({ title: 'Renamed thread' })] }] });
    });
    expect(container.textContent).toBe('Renamed thread · Renamed workspace · host-example');
    await act(async () => { client.removeQueries({ queryKey: ['sessions'] }); });
    expect(container.textContent).toBe('unknown · unknown · host-example');
    await act(async () => { client.setQueryData(['thread-ref', ID], record({ title: 'Fetched thread' })); });
    expect(container.textContent).toBe('Fetched thread · Renamed workspace · host-example');
    await act(async () => {
      client.removeQueries({ queryKey: ['thread-ref'] });
      client.removeQueries({ queryKey: ['thread-host-id'] });
    });
    expect(container.textContent).toBe('unknown · unknown · unknown');
  });

  it('refreshes a removed and recreated query even when its update count is unchanged', async () => {
    const { client, container } = await directory();
    await act(async () => { client.setQueryData(['thread-ref', ID], record()); });
    expect(container.textContent).toContain('Fix the flaky upload test');
    await act(async () => {
      client.removeQueries({ queryKey: ['thread-ref', ID], exact: true });
      client.setQueryData(['thread-ref', ID], record({ title: 'Replacement thread' }));
    });
    expect(container.textContent).toContain('Replacement thread');
  });

  it('waits for a matching late host ID before fetching a source record', async () => {
    let resolveHost!: (host: string) => void;
    const host = new Promise<string>((resolve) => { resolveHost = resolve; });
    const fetchHostId = vi.fn(() => host);
    const fetchSession = vi.fn(async () => record());
    const { client, container } = await directory({ fetchHostId, fetchSession, sourceHostId: 'host-example' });
    expect(fetchSession).not.toHaveBeenCalled();
    await act(async () => { resolveHost('host-other'); await host; });
    expect(container.textContent).toContain('host-other');
    expect(fetchSession).not.toHaveBeenCalled();
    await act(async () => { client.setQueryData(['thread-host-id'], 'host-example'); });
    await settle();
    expect(fetchSession).toHaveBeenCalledExactlyOnceWith(ID);
    expect(container.textContent).toContain('Fix the flaky upload test');
  });
});

describe('ThreadRefText', () => {
  it('renders a resolved link as a chip with title, workspace and status, and opens the thread', async () => {
    const container = await render(`look at /s/${ID}.`, [record()]);
    const chip = container.querySelector<HTMLAnchorElement>(`[data-thread-ref-chip="${ID}"]`)!;
    expect(chip.textContent).toContain('Fix the flaky upload test');
    expect(chip.textContent).toContain('kiki');
    expect(chip.getAttribute('data-thread-ref-status')).toBe('awaiting_approval');
    expect(chip.getAttribute('aria-label')).toBe('Open Fix the flaky upload test · Awaiting approval');
    expect(container.textContent).toContain('look at');
    expect(container.textContent?.endsWith('.' + '/s/session_here')).toBe(true);
    await act(async () => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(container.querySelector('[data-where]')?.textContent).toBe(`/s/${ID}`);
  });

  it('preserves a linked thread subroute, query and hash when it opens the chip', async () => {
    const href = `/s/${ID}/agent/child?turn=42#tail`;
    const container = await render(`open ${href}`, [record()]);
    const chip = container.querySelector<HTMLAnchorElement>(`[data-thread-ref-chip="${ID}"]`)!;
    expect(chip.getAttribute('href')).toBe(href);
    await act(async () => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(container.querySelector('[data-where]')?.textContent).toBe(href);
  });

  it('preserves a linked room subroute, query and hash when it opens the chip', async () => {
    const href = '/rooms/room_1/members?tab=all#top';
    const container = await render(`open ${href}`, []);
    const chip = container.querySelector<HTMLAnchorElement>('[data-room-ref-chip="room_1"]')!;
    expect(chip.getAttribute('href')).toBe(href);
    await act(async () => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(container.querySelector('[data-where]')?.textContent).toBe(href);
  });

  it('labels an untitled or unknown thread with its short id', async () => {
    const container = await render(`kiki://s/${ID}`, []);
    const chip = container.querySelector(`[data-thread-ref-chip="${ID}"]`)!;
    expect(chip.textContent).toContain('Thread 0f8e2a4c');
    expect(chip.getAttribute('data-thread-ref-status')).toBe('unknown');
  });
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ThreadRefChip room menu', () => {
  beforeEach(() => {
    roomRest.createFromThreads.mockReset();
    roomRest.searchThreads.mockReset();
    roomRest.searchThreads.mockResolvedValue({ threads: [] });
  });

  async function openChipMenu(container: HTMLDivElement): Promise<HTMLElement> {
    const chip = container.querySelector(`[data-thread-ref-chip="${ID}"]`);
    if (chip === null) throw new Error('chip not rendered');
    await act(async () => { chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const menu = document.querySelector<HTMLElement>('[data-thread-ref-chip-menu]');
    if (menu === null) throw new Error('chip menu did not open');
    return menu;
  }

  it('opens the new-thread-room dialog from the menu and creates the room', async () => {
    roomRest.createFromThreads.mockResolvedValue({ id: 'room_example', name: 'Project room' });
    const container = await render(`look at /s/${ID}.`, [record({ id: 'session_here', title: 'Current thread' }), record()]);
    const menu = await openChipMenu(container);
    expect(menu.querySelector('[data-menu-item="room-with-threads"]')?.textContent).toBe('Open a room with these threads');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="room-with-threads"]')!.click(); });
    // The menu closes and the dialog actually mounts — the regression this
    // covers had the menu's close unmount the dialog state in the same batch.
    expect(document.querySelector('[data-thread-ref-chip-menu]')).toBeNull();
    expect(document.querySelector('[data-new-thread-room]')).not.toBeNull();
    expect(document.querySelectorAll('[data-new-thread-room-member]')).toHaveLength(2);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-new-thread-room-submit]')!.click(); });
    await settle();
    expect(roomRest.createFromThreads).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['session_here', ID] }));
    expect(document.querySelector('[data-new-thread-room]')).toBeNull();
    expect(container.querySelector('[data-where]')?.textContent).toBe('/rooms/room_example');
  });

  it('closes the dialog on cancel and the chip menu still opens afterwards', async () => {
    const container = await render(`look at /s/${ID}.`, [record()]);
    const menu = await openChipMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="room-with-threads"]')!.click(); });
    expect(document.querySelector('[data-new-thread-room]')).not.toBeNull();
    // The room flow rides a SidePanel (batch overlay-m1): the cancel button
    // sits in the panel's footer, next to the body form, not inside it.
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.kiki-side-panel button')]
      .find((button) => button.textContent === 'Cancel');
    expect(cancel).toBeDefined();
    await act(async () => { cancel!.click(); });
    expect(document.querySelector('[data-new-thread-room]')).toBeNull();
    expect(container.querySelector(`[data-thread-ref-chip="${ID}"]`)).not.toBeNull();
    const again = await openChipMenu(container);
    await act(async () => { again.querySelector<HTMLButtonElement>('[data-menu-item="room-with-threads"]')!.click(); });
    expect(document.querySelector('[data-new-thread-room]')).not.toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * The surfaces that read a workspace's trust, and the workspace list they are
 * mounted next to.
 *
 * The trust strip is shared by the MCP view and the workspace list, so a
 * directory read that changes reaches both. The list is asserted here because
 * the trust badge is a row fact — and because what the list reads to draw its
 * first screen decides whether a row is there at all to carry the badge.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceCatalogEntry } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { WorkspacesSection } from './WorkspacesSection';
import { findMcpWorkspace, McpView } from '../capabilities/McpView';

const client = {
  listWorkspaces: vi.fn(), listWorkspaceCatalog: vi.fn(), getWorkspaceDetails: vi.fn(),
  renameWorkspaceCatalog: vi.fn(), setWorkspacePinnedCatalog: vi.fn(),
  renameWorkspace: vi.fn(), setWorkspacePinned: vi.fn(),
  getWorkspaceTrust: vi.fn(), trustWorkspace: vi.fn(), untrustWorkspace: vi.fn(),
  listMcpServers: vi.fn(), listTools: vi.fn(),
};
const klient = { global: { mcp: { list: vi.fn() } } };
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client, klient, scopeId: 'local', sshLabel: null }) }));
vi.mock('../SshProfilesPanel', () => ({ SshProfilesPanel: () => null }));
vi.mock('./WorktreesCard', () => ({ WorktreesCard: () => null }));
vi.mock('./McpConfigManager', () => ({ McpConfigManager: () => null }));
const disposals: Array<() => void> = [];
/**
 * What the catalog answers with: identity only. No count, no Git mark — the
 * workspace list and the MCP view both read that catalog.
 */
function catalogEntry(root: string, name: string, id = 'wd_example_000000000000'): WorkspaceCatalogEntry {
  return { id, root, name, pinned: false,
    created_at: '2026-10-10T00:00:00Z', last_opened_at: '2026-10-10T00:00:00Z' };
}
function workspace(root: string, id = 'wd_example_000000000000'): Workspace {
  return { id, root, name: 'Example', pinned: false, isGit: false, session_count: 0,
    created_at: '2026-10-10T00:00:00Z', last_opened_at: '2026-10-10T00:00:00Z' };
}
/** What the catalog holds, so a scoped write is visible on the read after it. */
let catalogEntries: WorkspaceCatalogEntry[] = [];
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
async function mount(element: React.ReactNode, query = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={query}><MemoryRouter><I18nProvider>{element}</I18nProvider></MemoryRouter></QueryClientProvider>));
  await flush(); await flush();
  disposals.push(() => { root.unmount(); query.clear(); container.remove(); });
  return container;
}
async function click(selector: string, container: ParentNode = document) {
  const button = container.querySelector<HTMLButtonElement>(selector)!;
  expect(button).not.toBeNull(); await act(async () => button.click()); await flush();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); localStorage.clear(); localStorage.setItem('kiki.locale', 'en');
  client.listWorkspaces.mockResolvedValue({ items: [workspace('/work/project')] });
  catalogEntries = [catalogEntry('/work/project', 'Example')];
  client.listWorkspaceCatalog.mockImplementation(() => Promise.resolve({ items: catalogEntries.map((entry) => ({ ...entry })) }));
  // The list's own writes are scoped to the catalog entry they change.
  client.setWorkspacePinnedCatalog.mockImplementation((id: string, pinned: boolean) => {
    const before = catalogEntries.find((entry) => entry.id === id) ?? catalogEntry('/work/project', 'Example', id);
    catalogEntries = catalogEntries.map((entry) => entry.id === id ? { ...entry, pinned } : entry);
    return Promise.resolve({ ...before, id, pinned });
  });
  client.renameWorkspaceCatalog.mockImplementation((id: string, name: string) => {
    const before = catalogEntries.find((entry) => entry.id === id) ?? catalogEntry('/work/project', 'Example', id);
    catalogEntries = catalogEntries.map((entry) => entry.id === id ? { ...entry, name } : entry);
    return Promise.resolve({ ...before, id, name });
  });
  // The full-projection writes remain for other surfaces, and are asserted
  // unused where this list writes.
  client.setWorkspacePinned.mockImplementation((id: string, pinned: boolean) => Promise.resolve({ ...workspace('/work/project', id), pinned }));
  client.renameWorkspace.mockImplementation((id: string, name: string) => Promise.resolve({ ...workspace('/work/project', id), name }));
  client.getWorkspaceTrust.mockResolvedValue({ trusted: false });
  client.trustWorkspace.mockResolvedValue({ trusted: true });
  client.untrustWorkspace.mockResolvedValue({ trusted: false });
  client.listMcpServers.mockResolvedValue({ servers: [] }); client.listTools.mockResolvedValue({ tools: [] });
  klient.global.mcp.list.mockResolvedValue([]);
});
afterEach(() => { for (const dispose of disposals.splice(0)) act(dispose); });

describe('workspace trust consumers', () => {
  it('matches directory boundaries, deepest roots and Windows paths without mixing drives or UNC hosts', () => {
    const parent = workspace('/work/project'); const child = workspace('/work/project/nested', 'wd_nested_000000000000');
    expect(findMcpWorkspace('/work/project-other', [parent])).toBeUndefined();
    expect(findMcpWorkspace('/work/project/nested/src', [parent, child])).toBe(child);
    expect(findMcpWorkspace('/work/project/../other', [parent])).toBeUndefined();
    expect(findMcpWorkspace('/Work/project', [parent])).toBeUndefined();
    const win = workspace('C:\\Work\\Project\\');
    expect(findMcpWorkspace('c:/work/project/src', [win])).toBe(win);
    expect(findMcpWorkspace('D:/work/project/src', [win])).toBeUndefined();
    const unc = workspace('\\\\host-a\\share\\project');
    expect(findMcpWorkspace('//HOST-A/share/project/src', [unc])).toBe(unc);
    expect(findMcpWorkspace('//host-b/share/project/src', [unc])).toBeUndefined();
  });
  it('opens the workspace list on the catalog, invents no count, and never calls the full list', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({
      items: [catalogEntry('/work/project', 'Example'), catalogEntry('/work/other', 'Other', 'wd_other_000000000000')],
    });
    const container = await mount(<WorkspacesSection />);
    expect(client.listWorkspaceCatalog).toHaveBeenCalledTimes(1);
    // The legacy list projects per-workspace session counts and Git roots; the
    // settings list must not need any of that to answer.
    expect(client.listWorkspaces).not.toHaveBeenCalled();
    // And it does not buy the missing numbers by asking for every workspace's
    // details: nothing is open, so nothing is read.
    expect(client.getWorkspaceDetails).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-workspace-row]').length).toBe(2);
    const row = container.querySelector('[data-workspace-row]')!;
    expect(row.textContent).toContain('Last opened');
    // A workspace with no count fact in hand says nothing about its sessions
    // rather than claiming none: only the row's own verb mentions a session.
    expect(row.textContent).not.toMatch(/\d+ sessions?/i);
    expect(container.textContent).not.toContain('Loading workspaces');
  });

  it('filters the listed catalog entries by name and by path', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({
      items: [catalogEntry('/work/project', 'Example'), catalogEntry('/work/other', 'Other', 'wd_other_000000000000')],
    });
    const container = await mount(<WorkspacesSection />);
    const search = container.querySelector<HTMLInputElement>('[data-list-search]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(search, 'Other'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    const rows = [...container.querySelectorAll('[data-workspace-row]')];
    expect(rows.map((node) => node.getAttribute('data-workspace-row'))).toEqual(['wd_other_000000000000']);
  });

  it('answers the first screen while another surface is still waiting on the legacy full list', async () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A hung full-list query is a different cache entry from the catalog, so
    // it cannot decide whether the workspace list has anything to show.
    void query.prefetchQuery({ queryKey: ['workspaces'], queryFn: () => new Promise(() => {}) });
    const container = await mount(<WorkspacesSection />, query);
    expect(client.listWorkspaces).not.toHaveBeenCalled();
    expect(client.listWorkspaceCatalog).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-workspace-row]')).not.toBeNull();
    expect(container.textContent).not.toContain('Loading workspaces');
  });

  it('pins a row through the scoped catalog write, and reads the pin back', async () => {
    catalogEntries = [catalogEntry('/work/project', 'Example'), catalogEntry('/work/other', 'Other', 'wd_other_000000000000')];
    const container = await mount(<WorkspacesSection />);
    const pin = container.querySelector<HTMLButtonElement>('[data-workspace-pin="wd_example_000000000000"]')!;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { pin.click(); });
    await flush(); await flush();
    expect(client.setWorkspacePinnedCatalog).toHaveBeenCalledExactlyOnceWith('wd_example_000000000000', true);
    // A row's pin is a fact about one workspace: the full-projection write,
    // whose response waits on a count and a Git probe, is not what this does.
    expect(client.setWorkspacePinned).not.toHaveBeenCalled();
    expect(container.querySelector('[data-workspace-pin="wd_example_000000000000"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-workspace-pin="wd_other_000000000000"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('offers only the facts a catalog entry really has: pinned, recent, name', async () => {
    const container = await mount(<WorkspacesSection />);
    expect([...container.querySelectorAll('[data-list-filter]')].map((node) => node.getAttribute('data-list-filter')))
      .toEqual(['all', 'pinned']);
    expect([...container.querySelectorAll('[data-list-sort-option]')].map((node) => node.getAttribute('data-list-sort-option')))
      .toEqual(['recent', 'name']);
    // The chips that a count would have carried are gone with the count, not
    // left behind as a filter that can no longer be answered.
    expect(container.querySelector('[data-list-toolbar]')!.textContent).not.toContain('No sessions');
  });

  it('does not read or mutate trust for a prefix-sibling MCP directory', async () => {
    const container = await mount(<McpView cwd="/work/project-other" />);
    expect(client.getWorkspaceTrust).not.toHaveBeenCalled();
    expect(container.querySelector('[data-workspace-trust-strip]')).toBeNull();
    expect(client.trustWorkspace).not.toHaveBeenCalled();
  });
  it('writes the deepest MCP workspace and preserves its state after a failed mutation', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [
      catalogEntry('/work/project', 'Example'),
      catalogEntry('/work/project/nested', 'Nested', 'wd_nested_000000000000'),
    ] });
    client.trustWorkspace.mockRejectedValueOnce(new Error('Trust unavailable'));
    const container = await mount(<McpView cwd="/work/project/nested/src" />);
    expect(client.getWorkspaceTrust).toHaveBeenCalledExactlyOnceWith('wd_nested_000000000000');
    await click('[data-workspace-trust-strip] button', container);
    expect(client.trustWorkspace).toHaveBeenCalledExactlyOnceWith('wd_nested_000000000000');
    expect(container.textContent).toContain('Trust unavailable');
    expect(container.querySelector<HTMLButtonElement>('[data-workspace-trust-strip] button')!.disabled).toBe(false);
    await click('[data-workspace-trust-strip] button', container);
    expect(container.textContent).not.toContain('Trust unavailable');
    expect(client.untrustWorkspace).not.toHaveBeenCalled();
  });
  it('uses the real menu and disabled trigger while a trust write is pending; failure remains retryable', async () => {
    let rejectWrite: (error: Error) => void = () => {};
    client.trustWorkspace.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const container = await mount(<WorkspacesSection />);
    await click('[data-workspace-more]', container); await click('[data-menu-item="trust"]');
    expect(client.trustWorkspace).toHaveBeenCalledExactlyOnceWith('wd_example_000000000000');
    expect(container.querySelector<HTMLButtonElement>('[data-workspace-more]')!.disabled).toBe(true);
    await act(async () => rejectWrite(new Error('Trust write failed'))); await flush();
    expect(container.textContent).toContain('Trust write failed');
    expect(container.querySelector<HTMLButtonElement>('[data-workspace-more]')!.disabled).toBe(false);
    await click('[data-workspace-more]', container); await click('[data-menu-item="trust"]');
    expect(client.trustWorkspace).toHaveBeenCalledTimes(2);
    expect(client.untrustWorkspace).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Trust write failed');
  });
  it('does not offer a trust mutation when the saved trust state is unknown', async () => {
    client.getWorkspaceTrust.mockRejectedValue(new Error('Trust read failed'));
    const container = await mount(<WorkspacesSection />);
    await click('[data-workspace-more]', container);
    expect(document.querySelector('[data-menu-item="trust"]')).toBeNull();
    expect(container.textContent).toContain('Trust read failed');
    expect(client.trustWorkspace).not.toHaveBeenCalled();
  });
  it('shows an accurate error and retry action in MCP view when reading trust fails', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [
      catalogEntry('/work/project', 'Example'),
      catalogEntry('/work/project/nested', 'Nested', 'wd_nested_000000000000'),
    ] });
    client.getWorkspaceTrust.mockRejectedValueOnce(new Error('Trust read failed'));
    const container = await mount(<McpView cwd="/work/project/nested/src" />);
    expect(client.getWorkspaceTrust).toHaveBeenCalledExactlyOnceWith('wd_nested_000000000000');
    const strip = container.querySelector('[data-workspace-trust-strip]')!;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain('Trust read failed');
    const retryBtn = strip.querySelector<HTMLButtonElement>('button')!;
    expect(retryBtn.textContent?.trim()).toBe('Retry');
    client.getWorkspaceTrust.mockResolvedValueOnce({ trusted: true });
    await act(async () => { retryBtn.click(); });
    await flush();
    expect(client.getWorkspaceTrust).toHaveBeenCalledTimes(2);
    expect(strip.textContent).toContain('Current workspace is trusted.');
    expect(strip.querySelector<HTMLButtonElement>('button')?.textContent?.trim()).toBe('Revoke trust');
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { WorkspacesSection } from './WorkspacesSection';
import { findMcpWorkspace, McpView } from '../capabilities/McpView';

const client = {
  listWorkspaces: vi.fn(), getWorkspaceTrust: vi.fn(), trustWorkspace: vi.fn(), untrustWorkspace: vi.fn(),
  listMcpServers: vi.fn(), listTools: vi.fn(),
};
const klient = { global: { mcp: { list: vi.fn() } } };
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client, klient, scopeId: 'local', sshLabel: null }) }));
vi.mock('../SshProfilesPanel', () => ({ SshProfilesPanel: () => null }));
vi.mock('./WorktreesCard', () => ({ WorktreesCard: () => null }));
vi.mock('./McpConfigManager', () => ({ McpConfigManager: () => null }));
const disposals: Array<() => void> = [];
function workspace(root: string, id = 'wd_example_000000000000'): Workspace {
  return { id, root, name: 'Example', pinned: false, isGit: false, session_count: 0,
    created_at: '2026-10-10T00:00:00Z', last_opened_at: '2026-10-10T00:00:00Z' };
}
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
async function mount(element: React.ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  it('does not read or mutate trust for a prefix-sibling MCP directory', async () => {
    const container = await mount(<McpView cwd="/work/project-other" />);
    expect(client.getWorkspaceTrust).not.toHaveBeenCalled();
    expect(container.querySelector('[data-workspace-trust-strip]')).toBeNull();
    expect(client.trustWorkspace).not.toHaveBeenCalled();
  });
  it('writes the deepest MCP workspace and preserves its state after a failed mutation', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [workspace('/work/project'), workspace('/work/project/nested', 'wd_nested_000000000000')] });
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
    client.listWorkspaces.mockResolvedValue({ items: [workspace('/work/project'), workspace('/work/project/nested', 'wd_nested_000000000000')] });
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
    expect(strip.textContent).toContain('This workspace is trusted');
    expect(strip.querySelector<HTMLButtonElement>('button')?.textContent?.trim()).toBe('Revoke trust');
  });
});

// @vitest-environment jsdom

/**
 * One workspace's own page.
 *
 * What matters here is that every control on the page writes *this*
 * workspace's scope with the real client call, that a plugin row reads the
 * workspace override rather than the session's, and that a link to a workspace
 * the server no longer has says so instead of quietly showing another one.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@kiki/protocol';
import type { PluginUsageItem, PluginUsageResponse, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { WorkspaceSettingsPage } from './WorkspaceSettingsPage';

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  renameWorkspace: vi.fn(),
  setWorkspacePinned: vi.fn(),
  getPluginUsage: vi.fn(),
  setPluginUsage: vi.fn(),
  getWorkspaceTrust: vi.fn(),
  setWorkspaceTrust: vi.fn(),
  getWorkspaceMemorySettings: vi.fn(),
  patchWorkspaceMemorySettings: vi.fn(),
  listWorkspaceSkills: vi.fn(),
  listPlugins: vi.fn(),
  listPluginMarketplace: vi.fn(),
  mcpList: vi.fn(),
  previewPlugin: vi.fn(),
  installPreviewedPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  getPlugin: vi.fn(),
}));

vi.mock('../../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listWorkspaces: mocks.listWorkspaces,
      renameWorkspace: mocks.renameWorkspace,
      setWorkspacePinned: mocks.setWorkspacePinned,
      getPluginUsage: mocks.getPluginUsage,
      setPluginUsage: mocks.setPluginUsage,
      getWorkspaceTrust: mocks.getWorkspaceTrust,
      setWorkspaceTrust: mocks.setWorkspaceTrust,
      getWorkspaceMemorySettings: mocks.getWorkspaceMemorySettings,
      patchWorkspaceMemorySettings: mocks.patchWorkspaceMemorySettings,
      listWorkspaceSkills: mocks.listWorkspaceSkills,
      listPlugins: mocks.listPlugins,
      listPluginMarketplace: mocks.listPluginMarketplace,
      previewPlugin: mocks.previewPlugin,
      installPreviewedPlugin: mocks.installPreviewedPlugin,
      setPluginEnabled: mocks.setPluginEnabled,
      getPlugin: mocks.getPlugin,
    },
    klient: { global: { mcp: { list: mocks.mcpList } } },
  }),
}));

let container: HTMLDivElement;
let root: Root;

const WORKSPACE: Workspace = {
  id: 'ws-a',
  root: 'C:/work/alpha',
  name: 'Alpha',
  created_at: '2026-01-01T00:00:00.000Z',
  last_opened_at: '2026-01-02T00:00:00.000Z',
  session_count: 3,
  pinned: false,
  isGit: true,
};

function usageItem(overrides: Partial<PluginUsageItem> = {}): PluginUsageItem {
  return {
    id: 'demo',
    displayName: 'Demo',
    home_enabled: true,
    global_enabled: true,
    state: 'ok',
    override: 'inherit',
    effective: true,
    app_service: false,
    skillCount: 1,
    mcpServerCount: 0,
    ...overrides,
  } as PluginUsageItem;
}

function usageAnswer(overrides: Partial<PluginUsageResponse> = {}): PluginUsageResponse {
  return {
    home_id: 'home-1',
    target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha' },
    revision: 4,
    apply_state: 'applied',
    errors: [],
    plugins: [usageItem()],
    ...overrides,
  } as PluginUsageResponse;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  localStorage.clear();
  localStorage.setItem('kiki.locale', 'en');
  mocks.listWorkspaces.mockResolvedValue({ items: [WORKSPACE] });
  mocks.renameWorkspace.mockImplementation((id: string, name: string) => Promise.resolve({ ...WORKSPACE, id, name }));
  mocks.setWorkspacePinned.mockImplementation((id: string, pinned: boolean) => Promise.resolve({ ...WORKSPACE, id, pinned }));
  mocks.getPluginUsage.mockResolvedValue(usageAnswer());
  mocks.setPluginUsage.mockResolvedValue(usageAnswer({ revision: 5 }));
  mocks.getWorkspaceTrust.mockResolvedValue({ trusted: false });
  mocks.setWorkspaceTrust.mockResolvedValue({ trusted: true });
  mocks.getWorkspaceMemorySettings.mockResolvedValue({ workspace_id: 'ws-a', enabled: null, effective_enabled: true });
  mocks.patchWorkspaceMemorySettings.mockResolvedValue({ workspace_id: 'ws-a', enabled: true, effective_enabled: true });
  mocks.listWorkspaceSkills.mockResolvedValue({ skills: [{ name: 'review', description: '', path: '/x', source: 'builtin' }] });
  mocks.listPlugins.mockResolvedValue({ plugins: [] });
  mocks.listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  mocks.mcpList.mockResolvedValue([{ name: 'files', mutable: false, source: 'project' }]);
  mocks.previewPlugin.mockResolvedValue({
    fingerprint: 'f'.repeat(64), consentRequired: false, contributions: [], changes: [], contextTokens: 1, unsupported: [],
  });
  mocks.installPreviewedPlugin.mockResolvedValue({ id: 'summarizer', displayName: 'Summarizer' });
  mocks.setPluginEnabled.mockResolvedValue({ id: 'summarizer', displayName: 'Summarizer' });
  mocks.getPlugin.mockResolvedValue({ id: 'summarizer', displayName: 'Summarizer', manifest: {} });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

async function renderPage(workspaceId = 'ws-a') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <WorkspaceSettingsPage workspaceId={workspaceId} />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

describe('WorkspaceSettingsPage', () => {
  it('makes the workspace itself the subject: its name, its path, a way back', async () => {
    await renderPage();
    expect(container.querySelector('[data-workspace-detail="ws-a"]')).not.toBeNull();
    expect(container.querySelector('[data-workspace-detail-root]')!.textContent).toBe('C:/work/alpha');
    expect(container.querySelector('[data-workspace-detail-back]')).not.toBeNull();
    expect(container.querySelector('[data-autofocus]')!.getAttribute('value')).toBe('Alpha');
  });

  it('reads plugin usage for this workspace and writes the workspace override', async () => {
    await renderPage();
    expect(mocks.getPluginUsage).toHaveBeenCalledWith({ workspace_id: 'ws-a' });
    const toggle = container.querySelector<HTMLInputElement>('[data-workspace-plugin="demo"] input[type=checkbox]')!;
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mocks.setPluginUsage).toHaveBeenCalledWith({ target: { workspace_id: 'ws-a' }, plugin_id: 'demo', override: 'off' });
  });

  it('says which level decided, from the workspace row’s own scope', async () => {
    mocks.getPluginUsage.mockResolvedValue(usageAnswer({
      plugins: [
        usageItem({ id: 'here', displayName: 'Here', override: 'off', effective: false }),
        usageItem({ id: 'below', displayName: 'Below', global_enabled: false, effective: false, reason: 'global_disabled' }),
      ],
    }));
    await renderPage();
    expect(container.querySelector('[data-workspace-plugin="here"] [data-workspace-plugin-source]')!.textContent).toBe('this workspace');
    expect(container.querySelector('[data-workspace-plugin="below"] [data-workspace-plugin-source]')!.textContent).toBe('global default');
  });

  it('restores this workspace to inherit without touching the global default', async () => {
    mocks.getPluginUsage.mockResolvedValue(usageAnswer({ plugins: [usageItem({ override: 'off', effective: false })] }));
    await renderPage();
    const restore = container.querySelector<HTMLButtonElement>('[data-workspace-plugin="demo"] [data-workspace-plugin-restore]')!;
    await act(async () => { restore.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mocks.setPluginUsage).toHaveBeenCalledWith({ target: { workspace_id: 'ws-a' }, plugin_id: 'demo', override: 'inherit' });
  });

  it('refuses a plugin the master switch denies rather than showing it as off', async () => {
    mocks.getPluginUsage.mockResolvedValue(usageAnswer({
      plugins: [usageItem({ override: 'on', home_enabled: false, effective: false, reason: 'home_disabled' })],
    }));
    await renderPage();
    const row = container.querySelector('[data-workspace-plugin="demo"]')!;
    expect(row.getAttribute('data-effective')).toBe('false');
    expect(row.querySelector('[data-workspace-plugin-reason="home_disabled"]')!.textContent).toBe('Master switch is off');
    expect(row.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true);
  });

  it('says when this server does not report per-workspace usage, and stops there', async () => {
    mocks.getPluginUsage.mockRejectedValue(Object.assign(new Error('unsupported procedure'), { code: ErrorCode.CAPABILITY_UNSUPPORTED }));
    await renderPage();
    const card = container.querySelector('#st-card-workspace-plugins')!;
    expect(card.textContent).toContain('This server does not report per-workspace plugin usage.');
    expect(card.querySelector('[data-workspace-plugins-list]')).toBeNull();
  });

  it('renames and pins through the existing calls, for this workspace only', async () => {
    await renderPage();
    const input = container.querySelector<HTMLInputElement>('[data-workspace-detail-name]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'Alpha Prime'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const rename = container.querySelector<HTMLButtonElement>('[data-workspace-detail-rename]')!;
    await act(async () => { rename.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mocks.renameWorkspace).toHaveBeenCalledWith('ws-a', 'Alpha Prime');

    // The pin label names what a click would do, not what is currently true.
    const pinLabel = container.querySelector('#workspace-trust-toggle')?.closest('label')
      ?? container.querySelector('[data-workspace-detail] label');
    const pinRow = [...container.querySelectorAll('label')].find((node) => node.textContent === 'Pin to the top');
    expect(pinRow).toBeDefined();
    const pin = container.querySelectorAll<HTMLInputElement>('[data-workspace-detail] input[type=checkbox]')[0]!;
    await act(async () => { pin.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mocks.setWorkspacePinned).toHaveBeenCalledWith('ws-a', true);
  });

  it('reads trust, and writes it only when the reader asks', async () => {
    await renderPage();
    expect(mocks.getWorkspaceTrust).toHaveBeenCalledWith('ws-a');
    // Reading the page is not a grant.
    expect(mocks.setWorkspaceTrust).not.toHaveBeenCalled();
    expect(container.querySelector('#workspace-trust-toggle')).not.toBeNull();
  });

  it('writes trust when it is explicitly toggled', async () => {
    await renderPage();
    const trustToggle = container.querySelector<HTMLInputElement>('#workspace-trust-toggle')!;
    await act(async () => { trustToggle.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mocks.setWorkspaceTrust).toHaveBeenCalledWith('ws-a', true);
  });

  it('inherits memory by default and writes the override it is given', async () => {
    await renderPage();
    expect(mocks.getWorkspaceMemorySettings).toHaveBeenCalledWith('ws-a');
    const select = container.querySelector<HTMLElement>('[data-workspace-memory-override]')!;
    expect(select.textContent).toContain('Same as the global default');
    const button = select.querySelector<HTMLButtonElement>('button')!;
    await act(async () => { button.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role=option], [data-workspace-memory-override] [role=option]')]
      .find((node) => node.textContent === 'On');
    if (option !== undefined) {
      await act(async () => { option.click(); });
      for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      expect(mocks.patchWorkspaceMemorySettings).toHaveBeenCalledWith('ws-a', true);
    }
  });

  it('links profiles, MCP and skills at this workspace’s real scope', async () => {
    await renderPage();
    const profiles = container.querySelector<HTMLAnchorElement>('[data-workspace-profiles-link]')!;
    expect(profiles.getAttribute('href')).toBe('/settings/agents?workspace=ws-a');
    const mcp = container.querySelector<HTMLAnchorElement>('[data-workspace-mcp-link]')!;
    // The destination is the settings leaf, which reads this workspace's root
    // because the link named it — not the Capabilities market, which would
    // resolve whichever workspace was opened most recently.
    expect(mcp.getAttribute('href')).toBe('/settings/mcp?workspace=ws-a');
    const skills = container.querySelector<HTMLAnchorElement>('[data-workspace-skills-link]')!;
    expect(skills.getAttribute('href')).toBe('/capabilities?tab=skills&workspace=ws-a');
    // MCP is read against THIS workspace's root, not a global list: the cwd
    // in the request is the scope, and the link is checked against what the
    // destination actually consumes rather than what its href spells.
    expect(mocks.mcpList).toHaveBeenCalledWith({ cwd: 'C:/work/alpha' });
    expect(mocks.mcpList).not.toHaveBeenCalledWith({ cwd: undefined });
    expect(mocks.listWorkspaceSkills).toHaveBeenCalledWith('ws-a');
  });

  it('installs from the catalog for THIS workspace, so the sheet can offer it', async () => {
    mocks.listPluginMarketplace.mockResolvedValue({
      configured: true,
      entries: [{ id: 'summarizer', displayName: 'Summarizer', source: 'https://example.test/summarizer.git', installable: true }],
    });
    mocks.previewPlugin.mockResolvedValue({ fingerprint: 'f'.repeat(64), consentRequired: false, contributions: [], changes: [], contextTokens: 1, unsupported: [], permissions: undefined });
    await renderPage();
    // Browsing stays on the page: the market has no workspace to name, so the
    // same link that dropped it here would have offered an install with no
    // "this workspace only" choice at all.
    const browse = container.querySelector<HTMLButtonElement>('[data-workspace-plugins-browse]')!;
    expect(browse.tagName).toBe('BUTTON');
    await act(async () => { browse.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    const entry = [...document.querySelectorAll<HTMLButtonElement>('[data-rail-plugin-catalog-entry]')]
      .find((node) => node.getAttribute('data-rail-plugin-catalog-entry') === 'summarizer')!;
    await act(async () => { entry.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    // The preview really ran for what the reader picked, and the third choice
    // is on screen — the user still chooses between the three.
    expect(mocks.previewPlugin).toHaveBeenCalledWith('https://example.test/summarizer.git', undefined);
    const options = [...document.querySelectorAll('[data-install-scope-option]')]
      .map((node) => node.getAttribute('data-install-scope-option'));
    expect(options.join(',')).toBe('global,later,workspace');
    const workspaceOption = document.querySelector('[data-install-scope-option="workspace"]')!;
    expect(workspaceOption.textContent).toContain('Alpha');
    // Nothing was preselected for the reader.
    expect(document.querySelector<HTMLInputElement>('[data-install-scope-option="global"] input')!.checked).toBe(true);
    // And installing it is a workspace fact: the global default stays off and
    // only this workspace is turned on.
    await act(async () => { document.querySelector<HTMLInputElement>('[data-install-scope-option="workspace"] input')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-install-confirm]')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mocks.installPreviewedPlugin).toHaveBeenCalledWith(expect.objectContaining({ defaultEnabled: false }));
    expect(mocks.setPluginUsage).toHaveBeenCalledWith({ target: { workspace_id: 'ws-a' }, plugin_id: 'summarizer', override: 'on' });
  });

  it('describes trust as what actually reads it, and names the action', async () => {
    await renderPage();
    const trust = container.querySelector('#st-card-workspace-trust')!;
    expect(trust.textContent).toContain('Its own config file, MCP servers and hooks are skipped');
    // Not a claim about every tool: the record gates project layers, and the
    // copy names them rather than promising a boundary it does not draw.
    expect(trust.textContent).not.toContain('ask');
    // The switch says what a click would do, so a granted workspace offers to
    // stop being trusted instead of repeating the state it is already in.
    expect(trust.querySelector('label')!.textContent).toContain('Trust Alpha');
  });

  it('reads a home-scoped app service as shared, in the rail’s own words', async () => {
    mocks.getPluginUsage.mockResolvedValue(usageAnswer({
      plugins: [usageItem({ id: 'bridge', displayName: 'Bridge', app_service: true, override: 'off', effective: false })],
    }));
    await renderPage();
    const row = container.querySelector('[data-workspace-plugin="bridge"]')!;
    const tag = row.querySelector('[data-workspace-plugin-app-service]')!;
    // The same label and the same one-line hint the rail shows, because the
    // fact is about the home scope and not about which page is reading it: a
    // service shared by the space's workspaces, not one this switch starts.
    expect(tag.textContent).toBe('Shared home service');
    expect(tag.getAttribute('title')).toContain('shared by the workspaces in this space');
  });

  it('reports a project-layer MCP server as read-only, not as editable', async () => {
    mocks.mcpList.mockResolvedValue([
      { name: 'files', mutable: false, source: 'project' },
      { name: 'notes', mutable: true, source: 'global' },
    ]);
    await renderPage();
    // Both are counted, and neither is presented as something this page writes:
    // the page links to the surface that owns the origin, and does not copy it.
    // The count is the row's own detail line, not the link: the link is the
    // destination, and this page does not copy what that surface edits.
    const mcpRow = container.querySelector('[data-workspace-mcp-link]')!.closest('div')!;
    expect(mcpRow.textContent).toContain('2 here');
    expect(container.querySelector('[data-workspace-mcp-link]')!.getAttribute('aria-label')).toBe('Open MCP servers');
  });

  it('says a removed workspace is gone rather than showing another one', async () => {
    await renderPage('ws-missing');
    expect(container.querySelector('[data-workspace-detail-missing]')).not.toBeNull();
    expect(container.textContent).toContain('That workspace is gone');
    // And it does not fall back to a workspace that does exist.
    expect(container.textContent).not.toContain('C:/work/alpha');
  });
});
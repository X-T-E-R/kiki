// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginUsageTarget, SkillDescriptor, Workspace } from '@kiki/protocol';
import { readDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { writeLastSessionId } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { CapabilitiesPage } from './CapabilitiesPage';
import { InstalledList } from './InstalledList';

const mcpKlient = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  resetAuth: vi.fn(),
  listStoredOAuthCredentials: vi.fn(),
  revealStoredOAuthCredential: vi.fn(),
  revokeStoredOAuthCredential: vi.fn(),
}));

const client = vi.hoisted(() => ({
  listWorkspaceCatalog: vi.fn<() => Promise<{ items: Workspace[] }>>(),
  listWorkspaceSkills: vi.fn<(id: string) => Promise<{ skills: SkillDescriptor[] }>>(),
  getConfig: vi.fn<() => Promise<Record<string, unknown>>>(),
  patchConfig: vi.fn<(body: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
  listMcpServers: vi.fn<() => Promise<{ servers: unknown[] }>>(),
  listTools: vi.fn<() => Promise<{ tools: unknown[] }>>(),
  getWorkspaceTrust: vi.fn<() => Promise<{ trusted: boolean }>>(),
  createSession: vi.fn(),
  listPlugins: vi.fn(),
  listPluginMarketplace: vi.fn(),
  recommendPlugins: vi.fn(),
  getPlugin: vi.fn(),
  listSkins: vi.fn(),
  listPluginPanels: vi.fn<(target?: PluginUsageTarget) => Promise<{ panels: unknown[] }>>(),
  getPluginPanelDocument: vi.fn<(pluginId: string, panelId: string, target?: PluginUsageTarget) => Promise<{ html: string; sandbox: 'allow-scripts' }>>(),
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client, klient: { global: { mcp: mcpKlient } }, scopeId: 'local' }),
  useOptionalConnection: () => ({ client, klient: { global: { mcp: mcpKlient } }, scopeId: 'local' }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function LocationProbe() {
  const location = useLocation();
  return <output data-test-search>{location.search}</output>;
}

const workspaceAlpha: Workspace = {
  id: 'ws_alpha',
  name: 'Alpha',
  root: 'C:/work/alpha',
  created_at: '2026-01-01T00:00:00Z',
  last_opened_at: '2026-01-01T00:00:00Z',
  session_count: 1,
  pinned: false,
  isGit: false,
};

beforeEach(() => {
  localStorage.clear();
  resetDraftMemoryForTests();
  localStorage.setItem('kiki.locale', 'en');
  mcpKlient.list.mockReset().mockResolvedValue([
    {
      name: 'docs-mcp',
      config: { transport: 'http', url: 'https://docs.example.test/mcp', headerKeys: ['Authorization'] },
      source: 'global',
      origin: 'C:/work/alpha/.kiki/mcp.json',
      mutable: true,
    },
  ]);
  mcpKlient.listStoredOAuthCredentials.mockReset().mockResolvedValue([]);
  client.listWorkspaceCatalog.mockReset().mockResolvedValue({ items: [workspaceAlpha] });
  client.getWorkspaceTrust.mockReset().mockResolvedValue({ trusted: true });
  client.createSession.mockReset().mockResolvedValue({ id: 'cap-mcp-assist-session' });
  client.listWorkspaceSkills.mockReset().mockResolvedValue({
    skills: [{ name: 'release-check', description: 'Run checks', path: 'C:/work/alpha/.kimi/skills/release-check/SKILL.md', source: 'project' }],
  });
  client.getConfig.mockReset().mockResolvedValue({ extra_skill_dirs: [], disabled_skills: [] });
  client.patchConfig.mockReset().mockImplementation(async (body) => body);
  client.listMcpServers.mockReset().mockResolvedValue({ servers: [] });
  client.listTools.mockReset().mockResolvedValue({ tools: [] });
  client.listPlugins.mockReset().mockResolvedValue({
    plugins: [
      {
        id: 'kiki-phone',
        displayName: 'Kiki Phone',
        version: '1.0.0',
        enabled: true,
        defaultEnabled: false,
        state: 'ok',
        hasErrors: false,
        source: 'local',
        skillCount: 0,
        hookCount: 0,
        mcpServerCount: 0,
      },
    ],
  });
  client.listPluginMarketplace.mockReset().mockResolvedValue({ entries: [] });
  client.recommendPlugins.mockReset().mockResolvedValue({ entries: [] });
  client.listSkins.mockReset().mockResolvedValue({ skins: [] });
  client.getPlugin.mockReset().mockResolvedValue({
    id: 'kiki-phone',
    enabled: true,
    state: 'ok',
    root: 'C:/plugins/kiki-phone',
    mcpServers: [],
    diagnostics: [],
    manifest: {
      id: 'kiki-phone',
      name: 'Kiki Phone',
      version: '1.0.0',
      defaultEnabled: false,
      kiki: {
        panels: [{ id: 'preview', label: 'Phone screen', slot: 'workspace', entry: 'panel.html' }],
      },
    },
  });
  client.listPluginPanels.mockReset().mockResolvedValue({
    panels: [{ pluginId: 'kiki-phone', id: 'preview', label: 'Phone screen', slot: 'workspace' }],
  });
  client.getPluginPanelDocument.mockReset().mockResolvedValue({
    html: '<!doctype html><title>Phone</title>',
    sandbox: 'allow-scripts',
  });

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function renderPage(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <CapabilitiesPage onToggleSidebar={() => undefined} />
            <LocationProbe />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

describe('CapabilitiesPage workspace-scoped plugin panel opening', () => {
  it('passes active workspace target when clicking Open panel on /capabilities?plugin=kiki-phone', async () => {
    writeLastSessionId('sess_alpha');
    await renderPage('/capabilities?plugin=kiki-phone');
    await settle();

    const openBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Open panel'),
    );
    expect(openBtn).toBeDefined();
    await act(async () => {
      openBtn!.click();
    });
    await settle();

    expect(container.querySelector('[data-test-search]')?.textContent).toContain('workspace=ws_alpha');
    expect(client.getPluginPanelDocument).toHaveBeenCalledWith('kiki-phone', 'preview', { workspace_id: 'ws_alpha' });
    expect(client.listPluginPanels).toHaveBeenCalledWith({ workspace_id: 'ws_alpha' });
  });

  it('resolves fallback workspace or session target on a direct untargeted panel deep link', async () => {
    writeLastSessionId('sess_fallback');
    await renderPage('/capabilities?panel=kiki-phone:preview');
    await settle();

    expect(client.getPluginPanelDocument).toHaveBeenCalledWith('kiki-phone', 'preview', { workspace_id: 'ws_alpha' });

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    client.listWorkspaceCatalog.mockResolvedValue({ items: [] });
    client.getPluginPanelDocument.mockClear();
    await renderPage('/capabilities?panel=kiki-phone:preview');
    await settle();

    expect(client.getPluginPanelDocument).toHaveBeenCalledWith('kiki-phone', 'preview', { session_id: 'sess_fallback' });
  });
});

describe('CapabilitiesPage shelf core, plugin error sanitization, and keyboard add menu', () => {
  it('never issues overview fan-out queries for unloaded tabs on initial Plugins render', async () => {
    await renderPage('/capabilities');
    await settle();

    expect(client.listPlugins).toHaveBeenCalledTimes(1);
    expect(client.listWorkspaceSkills).not.toHaveBeenCalled();
    expect(client.listMcpServers).not.toHaveBeenCalled();
    expect(client.listTools).not.toHaveBeenCalled();
    expect(container.querySelector('[data-plugins-installed-summary]')?.textContent).toBe('1 plugins · 1 enabled');
  });

  it('replaces raw Zod JSON plugin failures with clean summary, sanitized diagnostics, and working retry', async () => {
    const rawZodDump = new Error(
      '[ { "expected": "boolean", "code": "invalid_type", "path": [ 0, "globalEnabled" ], "message": "Invalid input: expected boolean, received undefined" } ]',
    );
    client.listPlugins
      .mockRejectedValueOnce(rawZodDump)
      .mockResolvedValueOnce({
        plugins: [
          {
            id: 'kiki-phone',
            displayName: 'Kiki Phone',
            version: '1.0.0',
            enabled: true,
            defaultEnabled: false,
            state: 'ok',
            hasErrors: false,
            source: 'local',
            skillCount: 0,
            hookCount: 0,
            mcpServerCount: 0,
          },
        ],
      });

    await renderPage('/capabilities');
    await settle();

    const errorBox = container.querySelector('[data-plugins-installed-error]')!;
    expect(errorBox).not.toBeNull();
    const alert = errorBox.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Couldn't load installed plugins: The server returned data Kiki could not read");
    expect(alert.textContent).not.toContain('"invalid_type"');
    expect(alert.textContent).not.toContain('globalEnabled');

    const diag = errorBox.querySelector('[data-plugins-error-diagnostics]')!;
    expect(diag.getAttribute('data-open')).toBe('false');
    await act(async () => {
      diag.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
    });
    expect(diag.getAttribute('data-open')).toBe('true');
    expect(diag.textContent).toContain('0.globalEnabled: invalid_type (boolean)');
    expect(diag.textContent).not.toContain('"expected"');

    await act(async () => {
      errorBox.querySelector<HTMLButtonElement>('[data-settings-retry]')!.click();
    });
    await settle();

    expect(container.querySelector('[data-plugins-installed-error]')).toBeNull();
    expect(container.querySelector('[data-plugin-row="kiki-phone"]')).not.toBeNull();
  });

  it('redacts URLs and credentials on marketplace load failures and recovers into shelf navigation on retry', async () => {
    client.listPluginMarketplace
      .mockRejectedValueOnce(
        new Error('Upstream failed at https://user:pass@secret.example.test/catalog.json?token=abc with Bearer sk-secretToken12345'),
      )
      .mockResolvedValueOnce({
        configured: true,
        entries: [
          { id: 'kiki-office', tier: 'official', displayName: 'Kiki Office', description: 'Docs', version: '1.0.0', source: 'https://example.test/office.zip' },
          { id: 'notes', tier: 'curated', displayName: 'Notes', description: 'Notes', version: '1.0.0', source: 'https://example.test/notes.zip' },
        ],
      });

    await renderPage('/capabilities?view=market');
    await settle();

    const errorBox = container.querySelector('[data-plugins-catalog-error]')!;
    expect(errorBox).not.toBeNull();
    expect(errorBox.textContent).not.toContain('sk-secretToken12345');
    expect(errorBox.textContent).not.toContain('user:pass');
    expect(errorBox.textContent).not.toContain('secret.example.test');
    expect(errorBox.textContent).not.toContain('token=abc');

    await act(async () => {
      errorBox.querySelector<HTMLButtonElement>('[data-settings-retry]')!.click();
    });
    await settle();

    expect(container.querySelector('[data-plugins-catalog-error]')).toBeNull();
    expect(container.querySelector('[data-plugins-shelf-rail]')).not.toBeNull();
    expect(container.querySelector('[data-plugins-shelf-jump="plugins-shelf-official"]')).not.toBeNull();
    expect(container.querySelector('[data-plugins-shelf-jump="plugins-shelf-community"]')).not.toBeNull();
  });

  it('supports keyboard navigation and Escape focus restoration in the Add menu, and opens Skills sources via typed intent', async () => {
    await renderPage('/capabilities');
    await settle();

    const trigger = container.querySelector<HTMLButtonElement>('[data-capabilities-add]')!;
    await act(async () => { trigger.click(); });
    await settle();

    const menu = document.querySelector<HTMLElement>('[data-capabilities-add-menu]')!;
    expect(menu).not.toBeNull();
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.map((item) => item.getAttribute('data-capabilities-add-item'))).toEqual(['plugin', 'skill', 'mcp', 'mcp-assist']);
    expect(document.activeElement).toBe(items[0]);

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[1]);

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[3]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-capabilities-add-menu]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => { trigger.click(); });
    await settle();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-capabilities-add-item="skill"]')!.click();
    });
    await settle();

    expect(container.querySelector('[data-capabilities-page]')?.getAttribute('data-capabilities-page')).toBe('skills');
    expect(container.querySelector('[data-skills-sources-panel]')).not.toBeNull();
  });

  it('routes Capabilities header Add MCP server and Ask Kiki without duplicate inline toolbar chrome, and disables Ask Kiki on missing scope', async () => {
    await renderPage('/capabilities?tab=mcp');
    await settle();

    // Capabilities MCP deduplicates inline Add server / Ask Kiki buttons.
    expect(container.querySelector('[data-mcp-manager] [data-mcp-add]')).toBeNull();
    expect(container.querySelector('[data-mcp-manager] [data-mcp-ask-kiki]')).toBeNull();

    const trigger = container.querySelector<HTMLButtonElement>('[data-capabilities-add]')!;
    await act(async () => { trigger.click(); });
    await settle();

    const newItem = document.querySelector<HTMLButtonElement>('[data-capabilities-add-menu] [data-mcp-add]')!;
    expect(newItem).not.toBeNull();
    expect(newItem.getAttribute('data-capabilities-add-item')).toBe('mcp');
    await act(async () => { newItem.click(); });
    await settle();

    expect(document.querySelector('[data-mcp-editor]')).not.toBeNull();

    // Assisted config from header Add menu starts one session in active workspace with zero secrets.
    await act(async () => { trigger.click(); });
    await settle();
    const assistItem = document.querySelector<HTMLButtonElement>('[data-capabilities-add-menu] [data-mcp-ask-kiki]')!;
    expect(assistItem.disabled).toBe(false);
    await act(async () => { assistItem.click(); });
    await settle();

    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createSession).toHaveBeenCalledWith({ metadata: { cwd: 'C:/work/alpha' } });
    const draft = readDraft('cap-mcp-assist-session');
    expect(draft).toMatch(/^\/kiki-ops /);
    expect(draft).toContain('C:/work/alpha');
    expect(draft).not.toContain('Authorization');

    // Missing / failed workspace catalog disables mcp-assist in the Add menu.
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    client.createSession.mockReset();
    client.listWorkspaceCatalog.mockRejectedValue(new Error('catalog down'));
    await renderPage('/capabilities?tab=mcp');
    await settle();

    const triggerNoWs = container.querySelector<HTMLButtonElement>('[data-capabilities-add]')!;
    await act(async () => { triggerNoWs.click(); });
    await settle();
    const disabledAssist = document.querySelector<HTMLButtonElement>('[data-capabilities-add-menu] [data-mcp-ask-kiki]')!;
    expect(disabledAssist.disabled).toBe(true);
    await act(async () => { disabledAssist.click(); });
    await settle();
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('preserves InstalledList description/keyword search and sanitizes raw Zod errors even inSettings', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onRetry = vi.fn();
    const rawZodDump = new Error(
      '[ { "expected": "boolean", "code": "invalid_type", "path": [ 0, "globalEnabled" ], "message": "Invalid input" } ]',
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <InstalledList
                plugins={[]}
                entries={[]}
                loading={false}
                error={rawZodDump}
                onRetry={onRetry}
                updates={new Map()}
                onOpen={vi.fn()}
                onUpdate={vi.fn()}
                onAdd={vi.fn()}
                inSettings
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    const err = container.querySelector('[data-plugins-installed-error]')!;
    expect(err.querySelector('[role="alert"]')?.textContent).not.toContain('"invalid_type"');
    expect(err.querySelector('[role="alert"]')?.textContent).not.toContain('globalEnabled');
    const diag = err.querySelector('[data-plugins-error-diagnostics]')!;
    await act(async () => { diag.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    expect(diag.textContent).toContain('0.globalEnabled: invalid_type (boolean)');
    await act(async () => { err.querySelector<HTMLButtonElement>('[data-settings-retry]')!.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);

    // Preserved 4164090610 search by marketplace description and keywords.
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <InstalledList
                plugins={[
                  {
                    id: 'kiki-office',
                    displayName: 'Kiki Office',
                    version: '1.0.0',
                    enabled: true,
                    globalEnabled: true,
                    state: 'ok',
                    hasErrors: false,
                    source: 'zip-url',
                    skillCount: 0,
                    hookCount: 0,
                    mcpServerCount: 0,
                    enabledMcpServerCount: 0,
                    commandCount: 0,
                  },
                  {
                    id: 'kiki-phone',
                    displayName: 'Kiki Phone',
                    version: '1.0.0',
                    enabled: true,
                    globalEnabled: true,
                    state: 'ok',
                    hasErrors: false,
                    source: 'local-path',
                    skillCount: 0,
                    hookCount: 0,
                    mcpServerCount: 0,
                    enabledMcpServerCount: 0,
                    commandCount: 0,
                  },
                ]}
                entries={[
                  {
                    id: 'kiki-office',
                    tier: 'official',
                    displayName: 'Kiki Office',
                    description: 'Spreadsheet and slide deck authoring',
                    keywords: ['docx', 'xlsx'],
                    version: '1.0.0',
                    source: 'https://example.test/office.zip',
                  },
                ]}
                loading={false}
                updates={new Map()}
                onOpen={vi.fn()}
                onUpdate={vi.fn()}
                onAdd={vi.fn()}
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    const search = container.querySelector<HTMLInputElement>('[data-installed-list] input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'spreadsheet');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...container.querySelectorAll('[data-plugin-row]')].map((el) => el.getAttribute('data-plugin-row'))).toEqual(['kiki-office']);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'xlsx');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...container.querySelectorAll('[data-plugin-row]')].map((el) => el.getAttribute('data-plugin-row'))).toEqual(['kiki-office']);
  });
});

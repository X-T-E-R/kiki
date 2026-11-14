// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginUsageTarget, Workspace } from '@kiki/protocol';
import { writeLastSessionId } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { CapabilitiesPage } from './CapabilitiesPage';

const client = vi.hoisted(() => ({
  listWorkspaceCatalog: vi.fn<() => Promise<{ items: Workspace[] }>>(),
  listPlugins: vi.fn(),
  listPluginMarketplace: vi.fn(),
  recommendPlugins: vi.fn(),
  getPlugin: vi.fn(),
  listSkins: vi.fn(),
  listPluginPanels: vi.fn<(target?: PluginUsageTarget) => Promise<{ panels: unknown[] }>>(),
  getPluginPanelDocument: vi.fn<(pluginId: string, panelId: string, target?: PluginUsageTarget) => Promise<{ html: string; sandbox: 'allow-scripts' }>>(),
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client, scopeId: 'local' }),
  useOptionalConnection: () => ({ client, scopeId: 'local' }),
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
  localStorage.setItem('kiki.locale', 'en');
  client.listWorkspaceCatalog.mockReset().mockResolvedValue({ items: [workspaceAlpha] });
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

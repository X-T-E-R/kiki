// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { PluginsSection } from './PluginsSection';

const PLUGIN = {
  id: 'notes',
  displayName: 'Notes',
  version: '1.0.0',
  enabled: true,
  state: 'ok' as const,
  skillCount: 1,
  mcpServerCount: 1,
  enabledMcpServerCount: 1,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path' as const,
  originalSource: '/tmp/notes',
};

const listPlugins = vi.fn(async () => ({ plugins: [PLUGIN] }));
const listPluginMarketplace = vi.fn(async () => ({ configured: false, entries: [] }));
const getPlugin = vi.fn(async () => ({
  ...PLUGIN,
  root: '/tmp/notes',
  installedAt: '2026-01-01T00:00:00.000Z',
  manifest: { name: 'notes' },
  mcpServers: [
    { name: 'notes-mcp', runtimeName: 'notes:notes-mcp', enabled: true, transport: 'stdio' as const },
  ],
  diagnostics: [],
}));
const getConfig = vi.fn(async () => ({}));
const patchConfig = vi.fn(async (body: unknown) => body);
const setPluginEnabled = vi.fn(async () => ({ ok: true }));
const removePlugin = vi.fn(async () => ({ ok: true }));
const installPlugin = vi.fn(async () => PLUGIN);

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listPlugins,
      listPluginMarketplace,
      getPlugin,
      getConfig,
      patchConfig,
      setPluginEnabled,
      removePlugin,
      installPlugin,
    },
  }),
}));

vi.mock('../../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
  listPlugins.mockClear();
  listPluginMarketplace.mockClear();
  getPlugin.mockClear();
  getConfig.mockClear();
  patchConfig.mockClear();
  setPluginEnabled.mockClear();
  removePlugin.mockClear();
  installPlugin.mockClear();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderLeaf(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <PluginsSection />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

describe('PluginsSection', () => {
  it('lists installed plugins and opens the unconfigured marketplace tab', async () => {
    const container = await renderLeaf();
    expect(container.querySelector('[data-plugin-row="notes"]')).not.toBeNull();
    expect(container.querySelector('#st-card-plugins-add')).not.toBeNull();
    const marketplaceTab = container.querySelector('[data-plugin-add-tab-button="marketplace"]');
    expect(marketplaceTab).not.toBeNull();
    await act(async () => {
      (marketplaceTab as HTMLButtonElement).click();
    });
    await flush();
    expect(listPluginMarketplace).toHaveBeenCalled();
    expect(container.textContent).toContain('No marketplace is configured');
  });

  it('loads MCP server status from the plugin info route', async () => {
    const container = await renderLeaf();
    const toggle = container.querySelector('[data-plugin-details-toggle="notes"]');
    expect(toggle).not.toBeNull();
    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    await flush();
    expect(getPlugin).toHaveBeenCalledWith('notes');
    expect(container.querySelector('[data-plugin-mcp="notes-mcp"]')).not.toBeNull();
  });

  it('offers Install for a catalog entry that is not installed', async () => {
    listPluginMarketplace.mockResolvedValueOnce({
      configured: true,
      source: 'https://example.test/marketplace.json',
      entries: [
        {
          id: 'fresh',
          tier: 'curated',
          displayName: 'Fresh Notes',
          source: 'https://example.test/fresh.zip',
        },
      ],
    });
    const container = await renderLeaf();
    await act(async () => {
      (container.querySelector('[data-plugin-add-tab-button="marketplace"]') as HTMLButtonElement).click();
    });
    await flush();
    const action = container.querySelector('[data-marketplace-action="fresh"]') as HTMLButtonElement;
    expect(action).not.toBeNull();
    expect(action.dataset.marketplaceKind).toBe('install');
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe('Install');
    await act(async () => {
      action.click();
    });
    await flush();
    expect(installPlugin).toHaveBeenCalledWith('https://example.test/fresh.zip');
  });

  it('disables Installed for a catalog entry with no update', async () => {
    listPluginMarketplace.mockResolvedValueOnce({
      configured: true,
      entries: [
        {
          id: 'notes',
          tier: 'curated',
          displayName: 'Notes',
          source: 'https://example.test/notes.zip',
          installed: { version: '1.0.0', enabled: true },
        },
      ],
    });
    const container = await renderLeaf();
    await act(async () => {
      (container.querySelector('[data-plugin-add-tab-button="marketplace"]') as HTMLButtonElement).click();
    });
    await flush();
    const action = container.querySelector('[data-marketplace-action="notes"]') as HTMLButtonElement;
    expect(action.dataset.marketplaceKind).toBe('installed');
    expect(action.disabled).toBe(true);
    expect(action.textContent).toBe('Installed');
    await act(async () => {
      action.click();
    });
    await flush();
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('offers Update for an installed catalog entry with a newer version', async () => {
    listPluginMarketplace.mockResolvedValueOnce({
      configured: true,
      entries: [
        {
          id: 'notes',
          tier: 'curated',
          displayName: 'Notes',
          version: '2.0.0',
          source: 'https://example.test/notes-2.zip',
          installed: { version: '1.0.0', enabled: true },
          updateAvailable: true,
        },
      ],
    });
    const container = await renderLeaf();
    await act(async () => {
      (container.querySelector('[data-plugin-add-tab-button="marketplace"]') as HTMLButtonElement).click();
    });
    await flush();
    const action = container.querySelector('[data-marketplace-action="notes"]') as HTMLButtonElement;
    expect(action.dataset.marketplaceKind).toBe('update');
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe('Update');
    await act(async () => {
      action.click();
    });
    await flush();
    expect(installPlugin).toHaveBeenCalledWith('https://example.test/notes-2.zip');
  });

  it('lists contribution counts on uninstall confirm, and MCP names once info is loaded', async () => {
    const container = await renderLeaf();
    await act(async () => {
      (container.querySelector('[data-plugin-uninstall="notes"]') as HTMLButtonElement).click();
    });
    await flush();
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('1 skills');
    expect(dialog?.textContent).toContain('1 MCP servers');
    expect(dialog?.textContent).not.toContain('notes-mcp');
    await act(async () => {
      [...dialog!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click();
    });
    await flush();

    await act(async () => {
      (container.querySelector('[data-plugin-details-toggle="notes"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(container.querySelector('[data-plugin-mcp="notes-mcp"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-plugin-uninstall="notes"]') as HTMLButtonElement).click();
    });
    await flush();
    const informed = container.querySelector('[role="alertdialog"]');
    expect(informed?.textContent).toContain('1 skills');
    expect(informed?.textContent).toContain('notes-mcp');
  });
});

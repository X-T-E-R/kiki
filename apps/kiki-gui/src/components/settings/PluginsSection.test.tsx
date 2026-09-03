// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { PluginMarketplaceEntry, PluginMarketplaceResponse } from '../../lib/client';
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
const listPluginMarketplace = vi.fn(async (): Promise<PluginMarketplaceResponse> => ({
  configured: false,
  entries: [],
}));
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

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function labeledButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
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
    expect(container.querySelector('[data-marketplace-empty]')).not.toBeNull();
    expect(container.textContent).toContain('Save a catalog URL to show its plugins here.');
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
        } satisfies PluginMarketplaceEntry,
      ],
    });
    const container = await renderLeaf();
    await act(async () => {
      (container.querySelector('[data-plugin-add-tab-button="marketplace"]') as HTMLButtonElement).click();
    });
    await flush();
    const action = container.querySelector('[data-marketplace-action="fresh"]') as HTMLButtonElement;
    expect(action).not.toBeNull();
    expect(action.dataset['marketplaceKind']).toBe('install');
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
        } satisfies PluginMarketplaceEntry,
      ],
    });
    const container = await renderLeaf();
    await act(async () => {
      (container.querySelector('[data-plugin-add-tab-button="marketplace"]') as HTMLButtonElement).click();
    });
    await flush();
    const action = container.querySelector('[data-marketplace-action="notes"]') as HTMLButtonElement;
    expect(action.dataset['marketplaceKind']).toBe('installed');
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
        } satisfies PluginMarketplaceEntry,
      ],
    });
    const container = await renderLeaf();
    await act(async () => {
      (container.querySelector('[data-plugin-add-tab-button="marketplace"]') as HTMLButtonElement).click();
    });
    await flush();
    const action = container.querySelector('[data-marketplace-action="notes"]') as HTMLButtonElement;
    expect(action.dataset['marketplaceKind']).toBe('update');
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
    expect(dialog?.textContent).toContain('1 skill');
    expect(dialog?.textContent).toContain('1 MCP server');
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
    expect(informed?.textContent).toContain('1 skill');
    expect(informed?.textContent).toContain('notes-mcp');
  });

  it('saves and clears the marketplace catalog URL', async () => {
    const source = 'https://example.test/marketplace.json';
    patchConfig.mockImplementation(async (body: unknown) => {
      const patch = body as { plugins?: { marketplace_url?: string } };
      return { plugins: { marketplaceUrl: patch.plugins?.marketplace_url } };
    });
    listPluginMarketplace
      .mockResolvedValueOnce({ configured: false, entries: [] })
      .mockResolvedValueOnce({
        configured: true,
        source,
        entries: [
          {
            id: 'fresh',
            tier: 'curated',
            displayName: 'Fresh',
            source: 'https://example.test/fresh.zip',
          } satisfies PluginMarketplaceEntry,
        ],
      })
      .mockResolvedValueOnce({ configured: false, entries: [] });
    const container = await renderLeaf();
    await click(container.querySelector('[data-plugin-add-tab-button="marketplace"]')!);
    await flush();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="https://example.test/marketplace.json"]')!;
    expect(input).not.toBeNull();
    await setInputValue(input, source);
    await click(labeledButton(container, 'Save catalog URL'));
    await flush();
    expect(patchConfig).toHaveBeenCalledWith({
      plugins: { marketplace_url: source },
      replace_domains: ['plugins'],
    });
    expect(container.querySelector('[data-marketplace-row="fresh"]')).not.toBeNull();
    await setInputValue(input, '');
    await click(labeledButton(container, 'Save catalog URL'));
    await flush();
    expect(patchConfig).toHaveBeenLastCalledWith({
      plugins: { marketplace_url: undefined },
      replace_domains: ['plugins'],
    });
    expect(container.querySelector('[data-marketplace-empty]')).not.toBeNull();
  });

  it('installs from a local path and reports success', async () => {
    const container = await renderLeaf();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="C:/plugins/example"]')!;
    await setInputValue(input, '/tmp/fresh-plugin');
    await click(labeledButton(container, 'Install'));
    await flush();
    expect(installPlugin).toHaveBeenCalledWith('/tmp/fresh-plugin');
    expect(container.textContent).toContain('Installed Notes.');
  });

  it('toggles a plugin off through the enable switch', async () => {
    const container = await renderLeaf();
    const toggle = container.querySelector('[data-plugin-row="notes"] [role="switch"]') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    await flush();
    expect(setPluginEnabled).toHaveBeenCalledWith('notes', false);
  });

  it('confirms uninstall and removes the plugin', async () => {
    const container = await renderLeaf();
    await click(container.querySelector('[data-plugin-uninstall="notes"]')!);
    await flush();
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Uninstall Notes?');
    await click(labeledButton(dialog as HTMLElement, 'Uninstall'));
    await flush();
    expect(removePlugin).toHaveBeenCalledWith('notes');
  });

  it('surfaces API errors from enable, install, and catalog save', async () => {
    setPluginEnabled.mockRejectedValueOnce(new Error('enable failed'));
    installPlugin.mockRejectedValueOnce(new Error('install failed'));
    patchConfig.mockRejectedValueOnce(new Error('save failed'));
    const container = await renderLeaf();
    await click(container.querySelector('[data-plugin-row="notes"] [role="switch"]')!);
    await flush();
    expect(container.textContent).toContain('enable failed');

    const pathInput = container.querySelector<HTMLInputElement>('input[placeholder="C:/plugins/example"]')!;
    await setInputValue(pathInput, '/tmp/broken');
    await click(labeledButton(container, 'Install'));
    await flush();
    expect(container.textContent).toContain('install failed');

    await click(container.querySelector('[data-plugin-add-tab-button="marketplace"]')!);
    await flush();
    const sourceInput = container.querySelector<HTMLInputElement>('input[placeholder="https://example.test/marketplace.json"]')!;
    await setInputValue(sourceInput, 'https://example.test/marketplace.json');
    await click(labeledButton(container, 'Save catalog URL'));
    await flush();
    expect(container.textContent).toContain('save failed');
  });

  it('retries a failed installed-plugin list', async () => {
    listPlugins
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValueOnce({ plugins: [PLUGIN] });
    const container = await renderLeaf();
    expect(container.textContent).toContain('list failed');
    expect(container.querySelector('[data-plugin-row="notes"]')).toBeNull();
    await click(container.querySelector('[data-plugins-retry]')!);
    await flush();
    expect(container.querySelector('[data-plugin-row="notes"]')).not.toBeNull();
  });
});

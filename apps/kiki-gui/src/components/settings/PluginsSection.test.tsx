// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { CapabilityStatus, PluginInfo, PluginMarketplaceEntry, PluginMarketplaceResponse } from '../../lib/client';
import { PluginsView, type PluginsRoute } from '../capabilities/PluginsView';
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
const getPlugin = vi.fn(async (): Promise<PluginInfo> => ({
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
const PLAN = {
  id: 'catalog-notes', version: '1.2.0', fingerprint: 'f'.repeat(64), changes: [] as string[], consentRequired: true,
  permissions: { exec: ['officecli'], fs: 'outside' as const },
  contributions: ['tool:office_view', 'tool:office_set', 'skill:0'], contextTokens: 900, unsupported: [] as string[],
};
const previewPlugin = vi.fn(async () => PLAN);
const installPreviewedPlugin = vi.fn(async () => ({ ...PLUGIN, id: 'catalog-notes', displayName: 'Catalog Notes', enabled: false }));
const rollbackPlugin = vi.fn(async () => ({ ok: true }));
const installPluginPrerequisite = vi.fn(async () => ({ ok: true }));
const recommendPlugins = vi.fn(async () => ({ entries: [] }));
const listPluginPanels = vi.fn(async () => ({ panels: [] }));
const listSkins = vi.fn(async () => ({ items: [], directory: '/tmp/themes', skipped: [] }));
const WEBBRIDGE: CapabilityStatus = {
  id: 'kimi-webbridge', displayName: 'WebBridge', description: 'Browser bridge',
  supported: true, state: 'not_installed',
  steps: [
    { id: 'daemon', state: 'missing' }, { id: 'skill', state: 'missing' },
    { id: 'extension', state: 'missing' },
  ],
  install: { running: false },
  plan: {
    artifact: { version: 'v2.0.22', url: 'https://cdn.kimi.com/webbridge/v2.0.22/releases/example',
      sha256: 'a'.repeat(64), metadataUrl: 'https://cdn.kimi.com/webbridge/v2.0.22/version.json', maxBytes: 1024 },
    destination: '/home/example/.kimi-webbridge/bin/kimi-webbridge',
    browserExtensionUrl: 'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc',
    note: 'Not an independent publisher signature',
  },
};
const getCapability = vi.fn(async (): Promise<CapabilityStatus> => WEBBRIDGE);
const installCapability = vi.fn(async (): Promise<CapabilityStatus> => ({ ...WEBBRIDGE, install: { running: true } }));

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
      previewPlugin,
      installPreviewedPlugin,
      rollbackPlugin,
      installPluginPrerequisite,
      recommendPlugins,
      listPluginPanels,
      listSkins,
      getCapability,
      installCapability,
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
  previewPlugin.mockClear();
  installPreviewedPlugin.mockClear();
  getCapability.mockReset();
  getCapability.mockResolvedValue(WEBBRIDGE);
  installCapability.mockReset();
  installCapability.mockResolvedValue({ ...WEBBRIDGE, install: { running: true } });
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

function ViewHarness({ initial }: { readonly initial: PluginsRoute }) {
  const [route, setRoute] = useState<PluginsRoute>(initial);
  return <PluginsView route={route} onRoute={setRoute} />;
}

async function renderView(initial: PluginsRoute = { view: 'installed' }): Promise<HTMLDivElement> {
  return renderInto(<ViewHarness initial={initial} />);
}

async function renderLeaf(): Promise<HTMLDivElement> {
  return renderInto(<PluginsSection />);
}

async function renderInto(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <MemoryRouter>
            {node}
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function catalog(entries: readonly PluginMarketplaceEntry[]): PluginMarketplaceResponse {
  return { configured: true, source: 'https://example.test/marketplace.json', entries };
}

const ENTRY: PluginMarketplaceEntry = {
  id: 'catalog-notes',
  tier: 'curated',
  displayName: 'Catalog Notes',
  description: 'A catalog entry.',
  version: '1.2.0',
  keywords: ['notes'],
  source: 'https://example.test/catalog-notes.zip',
};

describe('PluginsSection', () => {
  it('opens on the installed list with an enable switch per plugin', async () => {
    const container = await renderView();
    expect(listPlugins).toHaveBeenCalled();
    expect(container.querySelector('[data-plugins-view="installed"]')).not.toBeNull();
    const row = container.querySelector('[data-plugin-row="notes"]')!;
    expect(row.textContent).toContain('Notes');
    expect(row.textContent).toContain('v1.0.0');
    // Not in the catalog and installed from a folder: labelled by origin, not a separate view.
    expect(row.getAttribute('data-plugin-origin')).toBe('local');
    expect(row.textContent).toContain('Local folder');
    expect(row.textContent).toContain('/tmp/notes');
    expect(row.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles a plugin off through the enable switch', async () => {
    const container = await renderView();
    await click(container.querySelector('[data-plugin-row="notes"] input[type="checkbox"]')!);
    await flush();
    expect(setPluginEnabled).toHaveBeenCalledWith('notes', false);
  });

  it('opens the detail with contributions, needs and a folded Advanced block', async () => {
    getPlugin.mockResolvedValueOnce({
      ...PLUGIN, root: '/tmp/notes', installedAt: '2026-01-01T00:00:00.000Z', mcpServers: [], diagnostics: [],
      manifest: {
        name: 'notes',
        'x-kiki': {
          permissions: { exec: ['officecli'] },
          tools: [{ schemaVersion: 1, name: 'office_view', description: 'Get an overview. More text.', accesses: [{ kind: 'file', operation: 'read', path: '$.file' }] }],
          panels: [{ schemaVersion: 1, id: 'manuscript', label: 'Manuscript', slot: 'workspace', path: './panel.html' }],
          themes: [{ schemaVersion: 1, id: 'dusk', label: 'Dusk', base: 'dark', path: './dusk.json' }],
          prerequisites: { schemaVersion: 1, items: [{ id: 'officecli', kind: 'executable', required: true, version: '1.0.152' }] },
        },
      },
    });
    const container = await renderView();
    await click(container.querySelector('[data-plugin-row="notes"] button')!);
    await flush();
    const detail = container.querySelector('[data-plugin-detail="notes"]')!;
    expect(detail.querySelector('[data-plugin-contribution="tools"]')?.textContent).toContain('office_view');
    expect(detail.querySelector('[data-plugin-contribution="panels"]')?.textContent).toContain('Manuscript');
    expect(detail.querySelector('[data-plugin-contribution="themes"]')?.textContent).toContain('Dusk');
    expect(detail.querySelector('[data-plugin-needs]')?.textContent).toContain('Run programs');
    expect(detail.querySelector('[data-plugin-prerequisite="officecli"]')?.textContent).toContain('1.0.152');
    const advanced = detail.querySelector('[data-plugin-advanced]')!;
    expect(advanced.getAttribute('data-open')).toBe('false');
    await click(advanced.querySelector('button[aria-expanded]')!);
    expect(advanced.getAttribute('data-open')).toBe('true');
    expect(advanced.textContent).toContain('/tmp/notes');
  });

  it('removes a plugin only after the named confirmation, keeping data by default', async () => {
    const container = await renderView();
    await click(container.querySelector('[data-plugin-row="notes"] button')!);
    await flush();
    await click(container.querySelector('[data-plugin-advanced] button[aria-expanded]')!);
    await click(container.querySelector('[data-plugin-remove="notes"]')!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Remove Notes?');
    expect(removePlugin).not.toHaveBeenCalled();
    await click(dialog.querySelector('[data-plugin-remove-confirm]')!);
    await flush();
    expect(removePlugin).toHaveBeenCalledWith('notes', { deleteData: false });
  });

  it('shows the marketplace one step back, and installs through preview and consent', async () => {
    listPluginMarketplace.mockResolvedValue(catalog([ENTRY]));
    const container = await renderView();
    await click(container.querySelector('[data-plugins-tab] [data-segment="market"]')!);
    await flush();
    expect(container.querySelector('[data-plugins-view="market"]')).not.toBeNull();
    await click(container.querySelector('[data-catalog-install="catalog-notes"]')!);
    await flush();
    expect(previewPlugin).toHaveBeenCalledWith(ENTRY.source, undefined);
    expect(installPreviewedPlugin).not.toHaveBeenCalled();
    const sheet = document.querySelector('[data-install-flow]')!;
    expect(sheet.textContent).toContain('It will be able to');
    expect(sheet.textContent).toContain('officecli');
    const confirm = document.querySelector<HTMLButtonElement>('[data-install-confirm]')!;
    expect(confirm.textContent).toBe('Allow and install');
    await click(confirm);
    await flush();
    expect(installPreviewedPlugin).toHaveBeenCalledWith({ source: ENTRY.source, sha256: undefined, fingerprint: PLAN.fingerprint, consent: true });
    expect(setPluginEnabled).toHaveBeenCalledWith('catalog-notes', true);
    expect(document.querySelector('[data-install-done]')).not.toBeNull();
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('installs a permission-free plugin with a plain Install and leaves state alone on failure', async () => {
    listPluginMarketplace.mockResolvedValue(catalog([ENTRY]));
    previewPlugin.mockResolvedValueOnce({ ...PLAN, consentRequired: false, permissions: undefined, contributions: ['theme:dusk'] } as never);
    installPreviewedPlugin.mockRejectedValueOnce(new Error('The plugin changed since it was reviewed.'));
    const container = await renderView();
    await click(container.querySelector('[data-plugins-tab] [data-segment="market"]')!);
    await flush();
    await click(container.querySelector('[data-catalog-install="catalog-notes"]')!);
    await flush();
    expect(document.querySelector('[data-install-no-permissions]')).not.toBeNull();
    const confirm = document.querySelector<HTMLButtonElement>('[data-install-confirm]')!;
    expect(confirm.textContent).toBe('Install');
    await click(confirm);
    await flush();
    expect(document.querySelector('[data-install-error]')?.textContent).toContain('changed since it was reviewed');
    expect(setPluginEnabled).not.toHaveBeenCalled();
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('shelves the catalog, marks updates, and never offers Install for an installed entry', async () => {
    listPluginMarketplace.mockResolvedValue(catalog([
      { ...ENTRY, id: 'official-one', tier: 'official', displayName: 'Official One' },
      { ...ENTRY, id: 'notes', displayName: 'Notes', installed: { version: '1.0.0', enabled: true } },
      { ...ENTRY, id: 'notes-next', displayName: 'Notes Next', installed: { version: '1.0.0', enabled: true }, updateAvailable: true },
    ]));
    const container = await renderView();
    await click(container.querySelector('[data-plugins-tab] [data-segment="market"]')!);
    await flush();
    expect(container.querySelector('#plugins-shelf-featured [data-catalog-row="official-one"]')).not.toBeNull();
    expect(container.querySelector('[data-catalog-row="notes"]')?.getAttribute('data-catalog-state')).toBe('installed');
    expect(container.querySelector('[data-catalog-install="notes"]')).toBeNull();
    expect(container.querySelector('[data-catalog-row="notes-next"]')?.getAttribute('data-catalog-state')).toBe('update');
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('explains an unconfigured catalog instead of showing an empty list', async () => {
    const container = await renderView();
    await click(container.querySelector('[data-plugins-tab] [data-segment="market"]')!);
    await flush();
    expect(container.textContent).toContain('No plugin catalog is set on this server.');
  });

  it('keeps only server defaults in settings and links management to the Capabilities page', async () => {
    const container = await renderLeaf();
    expect(container.querySelector('[data-plugin-row]')).toBeNull();
    expect(container.querySelector('[data-plugins-view]')).toBeNull();
    expect(container.querySelector('[data-capability-link="plugins"]')?.textContent).toContain('1 plugin installed · 1 on');
    expect(container.querySelector('[data-capability-link-open="plugins"]')?.getAttribute('href')).toBe('/capabilities');
    expect(container.querySelector('[data-catalog-source] input')).not.toBeNull();
  });

  it('manages an installed plugin from its row: update hint, menu, and a confirmed remove', async () => {
    listPluginMarketplace.mockResolvedValue(catalog([{ ...ENTRY, id: 'notes', displayName: 'Notes', tier: 'official', version: '1.1.0', homepage: 'https://example.test/notes', installed: { version: '1.0.0', enabled: true }, updateAvailable: true }]));
    const container = await renderView();
    const row = container.querySelector('[data-plugin-row="notes"]')!;
    expect(row.getAttribute('data-plugin-origin')).toBe('official');
    expect(row.querySelector('[data-plugin-update="notes"]')?.textContent).toBe('Update to 1.1.0');
    await click(row.querySelector('[data-plugin-more="notes"]')!);
    const items = [...document.querySelectorAll('[data-plugin-card-menu] [data-menu-item]')].map((item) => item.getAttribute('data-menu-item'));
    expect(items).toEqual(['update', 'details', 'toggle', 'homepage', 'copy', 'remove']);
    await click(document.querySelector('[data-plugin-card-menu] [data-menu-item="remove"]')!);
    expect(removePlugin).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Remove Notes?');
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Remove plugin')!);
    await flush();
    expect(removePlugin).toHaveBeenCalledWith('notes', { deleteData: false });
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('marks installed catalog entries in the market without a toggle', async () => {
    listPluginMarketplace.mockResolvedValue(catalog([ENTRY, { ...ENTRY, id: 'notes', displayName: 'Notes', installed: { version: '1.0.0', enabled: true } }]));
    const container = await renderView({ view: 'market' });
    expect(container.querySelector('[data-installed-strip]')).toBeNull();
    expect(container.querySelector('[data-catalog-row="notes"]')?.textContent).toContain('Installed');
    await click(container.querySelector('[data-catalog-more="notes"]')!);
    const items = [...document.querySelectorAll('[data-plugin-card-menu] [data-menu-item]')].map((item) => item.getAttribute('data-menu-item'));
    expect(items).not.toContain('toggle');
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('never prepares runtime merely by browsing or viewing the consent plan', async () => {
    const container = await renderLeaf();
    expect(getCapability).toHaveBeenCalledWith('kimi-webbridge');
    expect(container.querySelector('[data-webbridge-state="not_installed"]')).not.toBeNull();
    expect(installCapability).not.toHaveBeenCalled();
    await click(container.querySelector('[data-webbridge-prepare]')!);
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('SHA-256');
    expect(installCapability).not.toHaveBeenCalled();
    await click(labeledButton(container.querySelector('[role="alertdialog"]') as HTMLElement, 'Cancel'));
    expect(installCapability).not.toHaveBeenCalled();
  });

  it('submits the pinned digest only after confirmation and supports a separate health check', async () => {
    const container = await renderLeaf();
    await click(container.querySelector('[data-webbridge-prepare]')!);
    await click(labeledButton(container.querySelector('[role="alertdialog"]') as HTMLElement, 'Prepare runtime…'));
    await flush();
    expect(installCapability).toHaveBeenCalledWith('kimi-webbridge', WEBBRIDGE.plan?.artifact.sha256);
    expect(installPlugin).not.toHaveBeenCalled();
    expect(setPluginEnabled).not.toHaveBeenCalled();
    await click(container.querySelector('[data-webbridge-check]')!);
    expect(getCapability.mock.calls.length).toBeGreaterThan(1);
    expect(container.querySelector('[data-webbridge-extension]')?.getAttribute('rel')).toContain('noopener');
  });

  it('shows a failed runtime attempt with a retry and never reports disconnected extension as ready', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'partial', install: { running: false, error: 'checksum mismatch' },
      steps: [ { id: 'daemon', state: 'ok' }, { id: 'skill', state: 'ok' }, { id: 'extension', state: 'missing' } ] });
    const container = await renderLeaf();
    expect(container.querySelector('[data-webbridge-state="partial"]')).not.toBeNull();
    expect(container.textContent).toContain('checksum mismatch');
    expect(container.querySelector('[data-webbridge-prepare]')).toBeNull();
    expect(container.querySelector('[data-webbridge-extension]')).not.toBeNull();
    getCapability.mockResolvedValue({ ...WEBBRIDGE, install: { running: false, error: 'checksum mismatch' } });
    await click(container.querySelector('[data-webbridge-check]')!);
    await flush();
    expect(container.querySelector('[data-webbridge-prepare]')?.textContent).toBe('Retry runtime…');
  });

  it('labels a failed detection step with its own copy instead of the raw step id', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'partial',
      steps: [{ id: 'detect', state: 'failed', detail: 'Loopback health endpoint refused the connection' }] });
    const container = await renderLeaf();
    const step = container.querySelector('[data-webbridge-step="detect"]')!;
    expect(step.textContent).toContain('Health check');
    expect(step.textContent).toContain('Check failed');
    expect(step.textContent).not.toContain('detect');
  });

  it('shows observed functionality as ready but distinguishes missing identity and package attestation', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'ready',
      install: { running: false, note: 'existing-loopback-daemon-observed-identity-unverified' },
      steps: [
        { id: 'daemon-binary', state: 'missing', optional: true },
        { id: 'daemon', state: 'ok', detail: 'Loopback status reports running; process identity is not authenticated' },
        { id: 'skill', state: 'ok' }, { id: 'extension', state: 'ok' },
        { id: 'daemon-identity', state: 'missing', optional: true,
          detail: 'Unverified: the loopback status cannot authenticate the responding process or browser extension' },
        { id: 'plugin-integrity', state: 'missing', optional: true,
          detail: 'Unverified: publisher URL does not prove ZIP integrity or daemon compatibility' },
      ] });
    const container = await renderLeaf();
    expect(container.querySelector('[data-webbridge-state="ready"]')).not.toBeNull();
    expect(container.querySelector('[data-webbridge-step="daemon"]')?.getAttribute('data-webbridge-step-kind')).toBe('function');
    expect(container.querySelector('[data-webbridge-step="plugin-integrity"]')?.getAttribute('data-webbridge-step-kind')).toBe('verification');
    expect(container.querySelector('[data-webbridge-step="daemon-identity"]')?.textContent).toContain('Unverified');
    expect(container.textContent).toContain('ZIP integrity');
    expect(container.querySelector('[data-webbridge-install-note]')?.textContent).toContain('process identity');
    expect(container.querySelector('[data-webbridge-prepare]')).toBeNull();
    expect(installCapability).not.toHaveBeenCalled();
  });

  it('retries a failed installed-plugin list', async () => {
    listPlugins
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValueOnce({ plugins: [PLUGIN] });
    const container = await renderView();
    expect(container.textContent).toContain('list failed');
    expect(container.querySelector('[data-plugin-row="notes"]')).toBeNull();
  });
});

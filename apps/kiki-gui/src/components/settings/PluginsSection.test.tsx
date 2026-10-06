// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { pluginSettingsIdFromQuery } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import type { CapabilityStatus, PluginInfo, PluginMarketplaceEntry, PluginMarketplaceResponse } from '../../lib/client';
import { PluginsView, type PluginsRoute } from '../capabilities/PluginsView';
import { BrowserControlSection } from './BrowserControlSection';
import { PluginsSection } from './PluginsSection';
import { SettingsNavTree } from './SettingsNav';

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

const listPlugins = vi.fn(async (): Promise<{ plugins: readonly (typeof PLUGIN | Record<string, unknown>)[] }> => ({ plugins: [PLUGIN] }));
const checkPluginUpdates = vi.fn(async (): Promise<readonly unknown[]> => []);
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
const installPreviewedPlugin = vi.fn(async (): Promise<Record<string, unknown>> => ({ ...PLUGIN, id: 'catalog-notes', displayName: 'Catalog Notes', enabled: false }));
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
const getPluginSettings = vi.fn(async (): Promise<{ schema?: unknown; values: Record<string, string | number | boolean>; secretsConfigured: string[] }> => ({
  values: {},
  secretsConfigured: [],
}));
const getCapability = vi.fn(async (): Promise<CapabilityStatus> => WEBBRIDGE);
const installCapability = vi.fn(async (): Promise<CapabilityStatus> => ({ ...WEBBRIDGE, install: { running: true } }));

// Both connection accessors read one client, so the page and the navigation it
// sits beside are looking at the same server the way they do in the app. The
// client object is hoisted with the factory, because a mock factory runs before
// the file's own declarations.
const mocks = vi.hoisted(() => ({ client: {} as Record<string, unknown> }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: mocks.client, scopeId: 'scope-test' }),
  useOptionalConnection: () => ({ client: mocks.client, scopeId: 'scope-test' }),
}));

vi.mock('../../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

// Fill the hoisted client now that every mock function exists.
Object.assign(mocks.client, {
  listPlugins,
  checkPluginUpdates,
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
  getPluginSettings,
  getCapability,
  installCapability,
});

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
  checkPluginUpdates.mockReset();
  checkPluginUpdates.mockResolvedValue([]);
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
  getPluginSettings.mockReset();
  getPluginSettings.mockResolvedValue({ values: {}, secretsConfigured: [] });
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

/** The settings leaf with no plugin named: the installed list. */
async function renderLeaf(): Promise<HTMLDivElement> {
  return renderInto(<PluginsSection pluginId={null} />);
}

/** One plugin's own settings page. */
async function renderPlugin(pluginId: string): Promise<HTMLDivElement> {
  return renderInto(<PluginsSection pluginId={pluginId} />);
}

/** The browser page, which now owns the WebBridge readiness card. */
async function renderBrowser(): Promise<HTMLDivElement> {
  return renderInto(<BrowserControlSection />);
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

/**
 * The leaf mounted at a settings route, with the query read the way the real
 * page reads it. Navigation inside it moves a real location, so the same
 * assertions hold for a click, a pasted link and the back button.
 */
/** The route the mounted leaf is sitting on, as the address bar would show it. */
function locationOf(container: HTMLElement): string | null {
  return container.querySelector('[data-location-probe]')?.textContent ?? null;
}

function LeafAtRoute() {
  const { search } = useLocation();
  // The navigation is mounted with the page, the way the real settings screen
  // mounts it: the two must stay in step about what is installed.
  return <>
    <LocationProbe />
    <SettingsNavTree active="plugins" onNavigate={() => {}} />
    <PluginsSection pluginId={pluginSettingsIdFromQuery(search)} />
  </>;
}

function LocationProbe() {
  const location = useLocation();
  return <span data-location-probe>{location.pathname}{location.search}</span>;
}

async function renderLeafAt(path: string): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  // One client for the whole mount, so a query that lands later is the same
  // cached answer every mounted surface reads.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  leafHandles = { queryClient };
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <LeafAtRoute />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

let leafHandles: { queryClient?: QueryClient } = {};

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
    expect(sheet.querySelector('[data-install-permissions] [data-permission-boundary]')?.textContent).toContain('not a sandbox');
    const confirm = document.querySelector<HTMLButtonElement>('[data-install-confirm]')!;
    expect(confirm.textContent).toBe('Allow and install');
    await click(confirm);
    await flush();
    expect(installPreviewedPlugin).toHaveBeenCalledWith({ source: ENTRY.source, sha256: undefined, fingerprint: PLAN.fingerprint, consent: true });
    expect(setPluginEnabled).toHaveBeenCalledWith('catalog-notes', true);
    expect(document.querySelector('[data-install-done]')).not.toBeNull();
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('carries the catalog digest from detail through preview and the confirmed installation', async () => {
    const entry = { ...ENTRY, sha256: 'b'.repeat(64), installable: true };
    listPluginMarketplace.mockResolvedValue(catalog([entry]));
    const container = await renderView({ view: 'detail', id: entry.id });
    await click(container.querySelector(`[data-plugin-install="${entry.id}"]`)!);
    await flush();
    expect(previewPlugin).toHaveBeenCalledExactlyOnceWith(entry.source, entry.sha256);
    expect(installPreviewedPlugin).not.toHaveBeenCalled();
    await click(document.querySelector('[data-install-confirm]')!);
    await flush();
    expect(installPreviewedPlugin).toHaveBeenCalledExactlyOnceWith({ source: entry.source, sha256: entry.sha256,
      fingerprint: PLAN.fingerprint, consent: true });
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('keeps a catalog entry unavailable for installation on both market and detail', async () => {
    const entry = { ...ENTRY, installable: false };
    listPluginMarketplace.mockResolvedValue(catalog([entry]));
    const container = await renderView({ view: 'market' });
    expect(container.querySelector(`[data-catalog-install="${entry.id}"]`)).toBeNull();
    await click(container.querySelector(`[data-catalog-row="${entry.id}"] button`)!);
    await flush();
    const install = container.querySelector<HTMLButtonElement>(`[data-plugin-install="${entry.id}"]`)!;
    expect(install.disabled).toBe(true);
    await click(install);
    expect(previewPlugin).not.toHaveBeenCalled();
    expect(installPreviewedPlugin).not.toHaveBeenCalled();
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

  it('shelves the catalog by what it declares, marks updates, and never offers Install for an installed entry', async () => {
    listPluginMarketplace.mockResolvedValue(catalog([
      { ...ENTRY, id: 'official-one', tier: 'official', displayName: 'Official One' },
      { ...ENTRY, id: 'notes', displayName: 'Notes', tier: 'curated', installed: { version: '1.0.0', enabled: true } },
      { ...ENTRY, id: 'notes-next', displayName: 'Notes Next', tier: 'curated', installed: { version: '1.0.0', enabled: true }, updateAvailable: true },
    ]));
    const container = await renderView();
    await click(container.querySelector('[data-plugins-tab] [data-segment="market"]')!);
    await flush();
    // Official and community entries get their own blocks, from the tier the
    // catalog states, with no per-package rule anywhere in the client.
    expect(container.querySelector('#plugins-shelf-official [data-catalog-row="official-one"]')).not.toBeNull();
    expect(container.querySelector('#plugins-shelf-community [data-catalog-row="notes"]')).not.toBeNull();
    expect(container.querySelector('[data-catalog-row="notes"]')?.getAttribute('data-catalog-state')).toBe('installed');
    expect(container.querySelector('[data-catalog-install="notes"]')).toBeNull();
    expect(container.querySelector('[data-catalog-row="notes-next"]')?.getAttribute('data-catalog-state')).toBe('update');
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('gives a catalog-declared package family its own block and lists every entry in it', async () => {
    const family = [
      { ...ENTRY, id: 'media-entry', tier: 'official' as const, displayName: 'Media', group: 'media' },
      { ...ENTRY, id: 'media-one', tier: 'official' as const, displayName: 'Provider One', group: 'media' },
      { ...ENTRY, id: 'media-two', tier: 'official' as const, displayName: 'Provider Two', group: 'media' },
    ];
    listPluginMarketplace.mockResolvedValue(catalog(family));
    const container = await renderView();
    await click(container.querySelector('[data-plugins-tab] [data-segment="market"]')!);
    await flush();
    // All three are drawn. A "see more" fold is how a reader concludes a
    // package does not exist, so a catalog this short is never folded.
    for (const entry of family) {
      expect(container.querySelector(`[data-catalog-row="${entry.id}"]`), entry.id).not.toBeNull();
    }
    expect(container.querySelector('[data-plugins-shelf-more]')).toBeNull();
    expect(container.querySelector('#plugins-shelf-official-media')).not.toBeNull();
    listPluginMarketplace.mockResolvedValue({ configured: false, entries: [] });
  });

  it('checks GitHub only when a GitHub install exists and flags its update without installing', async () => {
    await renderView();
    expect(checkPluginUpdates).not.toHaveBeenCalled();

    const GITHUB = {
      ...PLUGIN, id: 'lint', displayName: 'Lint', version: '0.4.0', source: 'github' as const,
      originalSource: 'https://github.com/example/lint/tree/main',
      github: { owner: 'example', repo: 'lint', ref: { kind: 'branch' as const, value: 'main' }, installedSha: 'a'.repeat(40) },
    };
    listPlugins.mockResolvedValue({ plugins: [PLUGIN, { ...GITHUB, enabled: false }] });
    checkPluginUpdates.mockResolvedValue([{
      id: 'lint', source: 'github', current: { kind: 'branch', value: 'main' }, latest: { kind: 'branch', value: 'main' },
      displayVersion: '9e8d7c6b5a41', updateAvailable: true,
    }]);
    const container = await renderView();
    await flush();
    expect(checkPluginUpdates).toHaveBeenCalledTimes(1);
    expect(previewPlugin).not.toHaveBeenCalled();
    expect(installPreviewedPlugin).not.toHaveBeenCalled();
    // The update group leads the healthy ones, and the row offers the same Update button as catalog updates.
    const groups = [...container.querySelectorAll('[data-list-group]')].map((node) => node.getAttribute('data-list-group'));
    expect(groups).toEqual(['updates', 'on']);
    const row = container.querySelector('[data-list-group="updates"] [data-plugin-row="lint"]')!;
    expect(row.querySelector('[data-plugin-update="lint"]')?.textContent).toBe('Update to 9e8d7c6b5a41');
    expect(container.querySelector('[data-plugins-update-check="checked"]')?.textContent).toContain('nothing installs on its own');

    // Update reuses the preview sheet on the plugin's own source and keeps it off.
    previewPlugin.mockResolvedValueOnce({ ...PLAN, id: 'lint', version: '0.4.0', consentRequired: false, changes: [], permissions: undefined as never });
    installPreviewedPlugin.mockResolvedValueOnce({ ...GITHUB, enabled: false });
    await click(row.querySelector('[data-plugin-update="lint"]')!);
    await flush();
    expect(previewPlugin).toHaveBeenCalledWith(GITHUB.originalSource, undefined);
    expect(installPreviewedPlugin).not.toHaveBeenCalled();
    expect(document.querySelector('[data-install-no-changes]')).not.toBeNull();
    const confirm = document.querySelector<HTMLButtonElement>('[data-install-confirm]')!;
    expect(confirm.textContent).toBe('Update');
    await click(confirm);
    await flush();
    expect(installPreviewedPlugin).toHaveBeenCalledWith({ source: GITHUB.originalSource, sha256: undefined, fingerprint: PLAN.fingerprint, consent: false });
    expect(setPluginEnabled).not.toHaveBeenCalled();
    listPlugins.mockResolvedValue({ plugins: [PLUGIN] });
  });

  it('states the trust boundary next to declared permissions on the detail page', async () => {
    getPlugin.mockResolvedValueOnce({
      ...PLUGIN, root: '/tmp/notes', installedAt: '2026-01-01T00:00:00.000Z',
      manifest: { name: 'notes', 'x-kiki': { permissions: { exec: ['officecli'], fs: 'outside' } } },
      mcpServers: [], diagnostics: [],
    });
    const container = await renderView({ view: 'detail', id: 'notes' });
    await flush();
    const boundary = container.querySelector('[data-plugin-needs] [data-permission-boundary]');
    expect(boundary?.textContent).toContain('not approval of each call');
    expect(boundary?.textContent).toContain('not a sandbox');
  });

  it('never shows an empty market for a server that has not configured a catalog address', async () => {
    // No address configured is the normal case, not a broken one: the server
    // serves the bundled official catalog, so a fresh install still browses.
    listPluginMarketplace.mockResolvedValue({
      configured: true,
      source: 'builtin:kiki-official-plugins',
      entries: [
        { ...ENTRY, id: 'kiki-office', tier: 'official', displayName: 'Kiki Office Suite', version: '0.1.0' },
        { ...ENTRY, id: 'kiki-extract', tier: 'official', displayName: 'Kiki Extract', version: '0.1.0' },
      ],
    });
    const container = await renderView();
    await click(container.querySelector('[data-plugins-tab] [data-segment="market"]')!);
    await flush();
    expect(container.textContent).not.toContain('No plugin catalog is set on this server.');
    expect(container.querySelector('#plugins-shelf-official [data-catalog-row="kiki-office"]')).not.toBeNull();
    expect(container.querySelector('#plugins-shelf-official [data-catalog-row="kiki-extract"]')).not.toBeNull();
  });

  it('lists the installed plugins as the settings leaf, with no form to edit in place', async () => {
    const container = await renderLeaf();
    const row = container.querySelector('[data-plugin-row="notes"]')!;
    expect(row.textContent).toContain('Notes');
    expect(row.textContent).toContain('v1.0.0');
    expect(row.textContent).toContain('Local folder');
    expect(row.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    // The market stays in Capabilities: this leaf links there once, and offers
    // no catalog address of its own.
    expect(container.querySelector('[data-plugins-market-link]')?.getAttribute('href')).toBe('/capabilities');
    expect(container.querySelector('[data-catalog-source]')).toBeNull();
    // Configuration happens on the plugin's own page, never inside this list.
    expect(container.querySelector('[data-plugin-settings]')).toBeNull();
  });

  it('sends a plugin row to that plugin\'s own settings page', async () => {
    // The row navigates and the route decides what renders, so the leaf is
    // mounted through the same route the row points to — which is what a copied
    // link, a refresh and the back button do too.
    const container = await renderLeafAt('/settings/plugins?plugin=notes');
    expect(container.querySelector('[data-plugin-settings-page="notes"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-settings-page="notes"]')?.textContent).toContain('Notes');
    expect(locationOf(container)).toBe('/settings/plugins?plugin=notes');
    await click(container.querySelector('[data-plugin-settings-back]')!);
    await flush();
    expect(container.querySelector('[data-plugin-settings-page]')).toBeNull();
    expect(container.querySelector('[data-plugin-row="notes"]')).not.toBeNull();
    expect(locationOf(container)).toBe('/settings/plugins');
  });

  it('reaches a plugin\'s page from the list, and back, in one visit', async () => {
    const container = await renderLeafAt('/settings/plugins');
    await click(container.querySelector('[data-plugin-open-settings="notes"]')!);
    await flush();
    expect(locationOf(container)).toBe('/settings/plugins?plugin=notes');
    expect(container.querySelector('[data-plugin-settings-page="notes"]')).not.toBeNull();
  });

  it('toggles a plugin from the installed list without opening its settings', async () => {
    const container = await renderLeaf();
    await click(container.querySelector('[data-plugin-row="notes"] input[type="checkbox"]')!);
    await flush();
    expect(setPluginEnabled).toHaveBeenCalledWith('notes', false);
  });

  it('gives an installed plugin its own page: name, a way back, its switch and its form', async () => {
    getPluginSettings.mockResolvedValue({
      schema: { schema: { properties: { workspace: { type: 'string', title: 'Workspace' } } } },
      values: { workspace: 'notes-1' },
      secretsConfigured: [],
    });
    const container = await renderPlugin('notes');
    // The form is a query of its own, so it can land a tick after the page does.
    await flush();
    expect(container.querySelector('[data-plugin-settings-page="notes"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-settings-back]')).not.toBeNull();
    // The plugin's own declared form is here, once, and nowhere else.
    expect(container.querySelector('[data-plugin-settings="notes"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-setting="workspace"]')).not.toBeNull();
  });

  it('says a plugin is not installed rather than opening some other plugin in its place', async () => {
    const container = await renderPlugin('never-installed');
    const missing = container.querySelector('[data-plugin-settings-missing="never-installed"]')!;
    expect(missing.textContent).toContain('never-installed');
    expect(missing.querySelector('[data-plugin-settings-back]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-settings-page]')).toBeNull();
  });

  it('removes a plugin from its own page through the existing confirmation', async () => {
    getPluginSettings.mockResolvedValue({ values: {}, secretsConfigured: [] });
    const container = await renderPlugin('notes');
    await click(container.querySelector('[data-plugin-remove="notes"]')!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Remove Notes?');
    expect(removePlugin).not.toHaveBeenCalled();
    await click(dialog.querySelector('button:last-child')!);
    await flush();
    expect(removePlugin).toHaveBeenCalledWith('notes', { deleteData: false });
    getPluginSettings.mockResolvedValue({ values: {}, secretsConfigured: [] });
  });

  it('keeps the navigation in step with the installed list as it changes', async () => {
    // The list is what fetches; a plugin's own page and the navigation only
    // read. So the navigation has to follow that one query: it must show what
    // the server has reported, and stop showing it once the list moves on —
    // without an unrelated re-render happening to re-read the cache.
    listPlugins.mockResolvedValue({
      plugins: [PLUGIN, { ...PLUGIN, id: 'later', displayName: 'Later', enabled: false }],
    });
    const container = await renderLeafAt('/settings/plugins');
    // The list is a query of its own, so it lands a tick after the page does.
    await flush();
    await flush();
    const seen = () => [...container.querySelectorAll('[data-settings-nav-plugin]')]
      .map((node) => node.getAttribute('data-settings-nav-plugin'));
    expect(seen()).toEqual(['notes', 'later']);

    // Open a plugin's own page the way a reader does, by clicking its row.
    await click(container.querySelector('[data-plugin-open-settings="notes"]')!);
    await flush();
    expect(locationOf(container)).toBe('/settings/plugins?plugin=notes');
    // The navigation is still naming both plugins on the sub-page.
    expect(seen()).toEqual(['notes', 'later']);

    // The list changes while that page is open — the navigation follows it
    // without anything else having to re-render it.
    listPlugins.mockResolvedValue({ plugins: [{ ...PLUGIN, id: 'later', displayName: 'Later' }] });
    await leafHandles.queryClient!.invalidateQueries({ queryKey: ['plugins'] });
    await flush();
    expect(seen(), 'a plugin gone from the list must leave the navigation').toEqual(['later']);
    // Hand the shared mock back the way the rest of the file expects to find it.
    listPlugins.mockResolvedValue({ plugins: [PLUGIN] });
  });

  it('shows a plugin with no settings schema as a management page, not an empty form', async () => {
    getPluginSettings.mockResolvedValue({ values: {}, secretsConfigured: [] });
    const container = await renderPlugin('notes');
    expect(container.querySelector('[data-plugin-settings="notes"]')).toBeNull();
    // What still applies to it is real: the switch and the removal stay.
    expect(container.querySelector('[data-plugin-remove="notes"]')).not.toBeNull();
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
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
    const container = await renderBrowser();
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
    const container = await renderBrowser();
    await click(container.querySelector('[data-webbridge-prepare]')!);
    await click(labeledButton(container.querySelector('[role="alertdialog"]') as HTMLElement, 'Set up WebBridge…'));
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
    const container = await renderBrowser();
    expect(container.querySelector('[data-webbridge-state="partial"]')).not.toBeNull();
    expect(container.textContent).toContain('checksum mismatch');
    expect(container.querySelector('[data-webbridge-prepare]')).toBeNull();
    expect(container.querySelector('[data-webbridge-extension]')).not.toBeNull();
    getCapability.mockResolvedValue({ ...WEBBRIDGE, install: { running: false, error: 'checksum mismatch' } });
    await click(container.querySelector('[data-webbridge-check]')!);
    await flush();
    expect(container.querySelector('[data-webbridge-prepare]')?.textContent).toBe('Try setup again…');
  });

  it('names the blocking step by label and never prints the detector sentence', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'partial',
      steps: [{ id: 'detect', state: 'failed', detail: 'Loopback health endpoint refused the connection' }] });
    const container = await renderBrowser();
    expect(container.querySelector('[data-webbridge-blocking]')?.textContent).toBe('These parts are not ready: Health check.');
    expect(container.textContent).not.toContain('Loopback health endpoint refused the connection');
  });

  it('shows a working runtime as one status line and nothing else', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'ready',
      install: { running: false, note: 'existing-loopback-daemon-observed-identity-unverified' },
      steps: [
        { id: 'daemon-binary', state: 'missing', optional: true, reason: 'binary_unverified',
          detail: 'Unverified: installed daemon binary does not match the pinned release SHA-256' },
        { id: 'daemon', state: 'ok', reason: 'daemon_loopback_unauthenticated',
          detail: 'Loopback status reports running; process identity is not authenticated' },
        { id: 'skill', state: 'ok' }, { id: 'extension', state: 'ok' },
        { id: 'daemon-identity', state: 'missing', optional: true, reason: 'daemon_identity_unverified',
          detail: 'Unverified: the loopback status cannot authenticate the responding process or browser extension' },
        { id: 'plugin-integrity', state: 'missing', optional: true, reason: 'plugin_integrity_unverified',
          detail: 'Unverified: publisher URL does not prove ZIP integrity or daemon compatibility' },
      ] });
    const container = await renderBrowser();
    expect(container.querySelector('[data-webbridge-state="ready"]')?.textContent).toBe('Working');
    // The card is the status, the extension link, and the two actions. The
    // attestation sentences are gone rather than moved somewhere else.
    expect(container.querySelector('[data-webbridge-details]')).toBeNull();
    expect(container.querySelector('[data-webbridge-install-note]')).toBeNull();
    expect(container.querySelector('[data-webbridge-step]')).toBeNull();
    const text = container.textContent ?? '';
    for (const gone of [
      'Unverified:', 'does not match the pinned release', 'identity is not authenticated',
      'Service identity', 'Plugin package integrity', 'Check details', 'unverified',
      'not authenticated', 'compatibility',
    ]) {
      expect(text, `still shows: ${gone}`).not.toContain(gone);
    }
    expect(container.querySelector('[data-webbridge-check]')).not.toBeNull();
    expect(container.querySelector('[data-webbridge-extension]')).not.toBeNull();
    expect(container.querySelector('[data-webbridge-prepare]')).toBeNull();
    expect(installCapability).not.toHaveBeenCalled();
  });

  it('never renders an install note the client does not understand', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'ready',
      install: { running: false, note: 'some future installer sentence' },
      steps: [{ id: 'daemon', state: 'ok' }, { id: 'skill', state: 'ok' }, { id: 'extension', state: 'ok' }] });
    const container = await renderBrowser();
    expect(container.textContent).not.toContain('some future installer sentence');
    expect(container.textContent).toContain('Working');
  });

  it('names the one blocking step when the runtime is only partly up', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'partial',
      steps: [
        { id: 'daemon', state: 'ok' },
        { id: 'skill', state: 'ok' },
        { id: 'extension', state: 'missing', reason: 'extension_not_connected' },
      ] });
    const container = await renderBrowser();
    expect(container.querySelector('[data-webbridge-state="partial"]')?.textContent).toBe('Set up, but not everything is working');
    // Only the step that blocks the feature is named; the healthy ones are not.
    expect(container.querySelector('[data-webbridge-blocking]')?.textContent).toBe('These parts are not ready: Browser extension.');
  });

  it('names a required missing service binary instead of a health check', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'partial',
      steps: [
        { id: 'daemon-binary', state: 'missing' },
        { id: 'daemon', state: 'missing' },
        { id: 'daemon-identity', state: 'missing', optional: true },
      ] });
    const container = await renderBrowser();
    const blocking = container.querySelector('[data-webbridge-blocking]')?.textContent;
    expect(blocking).toBe('These parts are not ready: Service binary、Local service.');
    expect(blocking).not.toContain('Health check');
    expect(container.querySelector('[data-webbridge-details]')).toBeNull();
  });

  it('offers setup again for a missing local service and labels it by what it does', async () => {
    getCapability.mockResolvedValue({ ...WEBBRIDGE, state: 'not_installed',
      steps: [{ id: 'daemon', state: 'missing' }, { id: 'skill', state: 'missing', reason: 'plugin_not_installed' }] });
    const container = await renderBrowser();
    expect(container.querySelector('[data-webbridge-state="not_installed"]')?.textContent).toBe('Not set up on this machine yet');
    expect(container.querySelector('[data-webbridge-prepare]')?.textContent).toBe('Set up WebBridge…');
    expect(container.querySelector('[data-webbridge-check]')?.textContent).toBe('Check again');
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

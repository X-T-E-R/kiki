// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SettingsPage scope header: a workspace-scoped section (Skills' catalog,
 * MCP's config card) reports its selected workspace, and the header names it
 * in lockstep with the card-level selector. Also covers the batch-3 leaf
 * mounts and the retired-capabilities legacy redirects.
 */

import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_SEARCH_SPEC } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import * as clipboard from '../lib/clipboard';
import { SettingsPage } from './SettingsPage';
import { DirtyGuardContext, useDirtyGuardState, type GuardedNavigate } from './dirtyGuard';
import { SectionCard, SettingsCardMountContext } from './settings/SectionCard';
import { SettingsPaneBoundary } from './settings/SettingsPaneBoundary';
import { clearNavHistory, getUiSnapshot, recordNavigation, saveUiSnapshot } from '../lib/navHistory';
import { commitText, pickOption } from './settings/testControls';

const WORKSPACES = {
  items: [
    { id: 'ws-alpha', name: 'Alpha', root: '/tmp/alpha', last_opened_at: '2026-09-01T00:00:00Z', pinned: false },
    { id: 'ws-beta', name: 'Beta', root: '/tmp/beta', last_opened_at: '2026-08-01T00:00:00Z', pinned: false },
  ],
};

/**
 * A small stand-in for `/memory/settings`'s advisor half with the server's
 * sparse-merge rules: `advisor: null` removes the block, `selector: null`
 * clears the model, anything omitted is kept.
 */
type AdvisorFake = { advisor?: Record<string, unknown>; status: Record<string, unknown>; patches: unknown[]; memoryEnabled: boolean; modelBaseUrl?: string; modelEffectiveBaseUrl?: string };
const advisorFake: AdvisorFake = { status: {}, patches: [], memoryEnabled: true };
function advisorResponse(workspaceId?: string) {
  const advisor: Record<string, unknown> | undefined = advisorFake.advisor === undefined ? undefined : {
    mode: 'rank', timeout_ms: 6000, max_calls_per_turn: 3, candidate_chars: 120,
    catalog_page_items: 40, max_catalog_pages: 2, max_full_units: 8, judge_input_tokens: 12000, apply_to_children: true, egress_ack: [],
    ...advisorFake.advisor,
  };
  const legacy = advisor?.['selector'] as { protocol: string; model: string } | undefined;
  const source = advisor?.['source'] as { kind: string; connection?: string; model?: string } | undefined;
  // A decision connection reports `<connection>@<origin>`; a chat model or an older selector its provider.
  const selector = source?.kind === 'connection'
    ? { protocol: 'system_one', model: source.model ?? 'jev-latest' }
    : source?.kind === 'model' ? { protocol: 'chat_json', model: source.model! } : legacy;
  const destination = selector === undefined ? undefined
    : source?.kind === 'connection' ? `${source.connection}@https://api.typesafe.ai` : 'openai:https://api.example.test';
  // Choosing a source and leaving the advisor on is the decision to use it: no separate OK.
  const configured = advisor?.['mode'] === 'off' ? 'off' : selector === undefined ? 'unconfigured' : 'ready';
  const state = advisorFake.memoryEnabled ? configured : 'disabled';
  return {
    enabled: advisorFake.memoryEnabled, approval: 'auto' as const, budget: 2000, workspaces: {}, effective_enabled: advisorFake.memoryEnabled, advisor,
    advisor_status: {
      state, consent_required: false, reason: state === 'unconfigured' ? 'unconfigured' : undefined,
      destination, origin: destination === undefined ? undefined : source?.kind === 'connection' ? 'https://api.typesafe.ai' : 'https://api.example.test',
      protocol: selector?.protocol, model: selector?.model,
      first_step_wait_default_ms: selector === undefined ? undefined : selector.protocol === 'chat_json' ? 1500 : 3000,
      source_status: source === undefined ? undefined : { state: 'ready', connection: source.connection, model: selector?.model, protocol: selector?.protocol, destination },
      logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0, ...advisorFake.status,
    },
  };
}

const MCP_ENTRY = {
  name: 'old-server',
  config: { transport: 'stdio' as const, command: 'node', args: ['server.js'] },
  source: 'global' as const,
  origin: '/tmp/mcp.json',
  mutable: true,
};

const klient = {
  global: {
    env: vi.fn(async () => ({ os: 'linux', arch: 'x64', home: '/tmp' })),
    board: { read: vi.fn() },
    mcp: {
      list: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      add: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      update: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      remove: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      test: vi.fn(async () => ({ success: true, output: '' })),
      listStoredOAuthCredentials: vi.fn(async () => []),
    },
  },
};

const client = {
  getConfig: vi.fn(async () => ({})),
  getCapability: vi.fn(async () => ({ id: 'kiki-computer', state: 'ready', install: { running: false }, steps: [] })),
  setBrowserControlEnabled: vi.fn(async () => ({})),
  setComputerControlEnabled: vi.fn(async () => ({})),
  installCapability: vi.fn(async () => ({ id: 'kiki-computer', state: 'ready', install: { running: false }, steps: [] })),
  meta: vi.fn(async (): Promise<{ experimental_flags?: Record<string, boolean> }> => ({
    experimental_flags: {
      'tool-select': true,
      task_wait: true,
      desktop_search: true,
      persistence_minidb_readmodel: true,
      auto_session_title: true,
      subagent_release_idle: true,
      'agent-profile-routes': true,
      external_delegation_mcp: true,

      image_format_conversion: false,
      native_ssh: false,
      session_idle_eviction: false,
    },
  })),
  listWorkspaces: vi.fn(async () => WORKSPACES),
  listWorkspaceCatalog: vi.fn(async () => WORKSPACES),
  klient: { rest: undefined as { connections: { list: () => Promise<unknown>; handshake: () => Promise<unknown> } } | undefined },
  getWorkspaceDetails: vi.fn(() => new Promise(() => {})),
  getWorkspaceTrust: vi.fn(async () => ({ trusted: false })),
  getPluginUsage: vi.fn(async ({ workspace_id }: { workspace_id: string }) => ({
    home_id: 'test-home', target: { workspace_id, ...WORKSPACES.items.find((workspace) => workspace.id === workspace_id) },
    revision: 1, apply_state: 'applied', errors: [], plugins: [],
  })),
  listDiscoveredModels: vi.fn(async () => ({ items: [] })),
  refreshAllProviders: vi.fn(async () => ({ changed: [], unchanged: [], failed: [], discovered: [] })),
  createModel: vi.fn(),
  listMcpServers: vi.fn(async () => ({ servers: [] })),
  listPlugins: vi.fn(async () => ({ plugins: [] })),
  listPluginMarketplace: vi.fn(async () => ({ configured: false, entries: [] })),
  getPlugin: vi.fn(async () => ({
    id: 'fixture-plugin',
    displayName: 'fixture-plugin',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    root: '/tmp/plugin',
    installedAt: '2026-01-01T00:00:00.000Z',
    mcpServers: [],
    diagnostics: [],
  })),
  installPlugin: vi.fn(async () => ({ id: 'installed' })),
  setPluginEnabled: vi.fn(async () => ({ ok: true })),
  removePlugin: vi.fn(async () => ({ ok: true })),
  listWorkspaceSkills: vi.fn(async () => ({ skills: [] })),
  listTools: vi.fn(async () => ({ tools: [] })),
  listNamedAgentProfiles: vi.fn(async () => ({ items: [] })),
  getMemorySettings: vi.fn(async () => ({ enabled: true, approval: 'auto', budget: 2000, workspaces: {} as Record<string, boolean> })),
  memoryAuthority: vi.fn(async (): Promise<unknown> => ({ version: 1, epoch: 0, backend: 'sqlite', mode: 'normal' })),
  patchMemorySettings: vi.fn(async (patch: { enabled?: boolean; approval?: string; budget?: number }) => ({ enabled: true, approval: 'auto', budget: 2000, workspaces: {}, ...patch })),
  getWorkspaceMemorySettings: vi.fn(async (id: string) => ({ workspace_id: id, enabled: null as boolean | null, effective_enabled: true })),
  patchWorkspaceMemorySettings: vi.fn(async (id: string, enabled: boolean | null) => ({ workspace_id: id, enabled, effective_enabled: enabled !== false })),
  getMemoryAdvisorSettings: vi.fn(async (workspaceId?: string) => advisorResponse(workspaceId)),
  patchMemoryAdvisorSettings: vi.fn(async (patch: { advisor?: Record<string, unknown> | null }, workspaceId?: string) => {
    advisorFake.patches.push(patch);
    if (patch.advisor === null) advisorFake.advisor = undefined;
    else if (patch.advisor !== undefined) {
      const next = { ...advisorFake.advisor, ...patch.advisor };
      if (patch.advisor['selector'] === null) delete next['selector'];
      if (patch.advisor['first_step_wait_ms'] === null) delete next['first_step_wait_ms'];
      advisorFake.advisor = next;
    }
    return advisorResponse(workspaceId);
  }),
  listSessions: vi.fn(async (query: { workspace_id?: string }) => ({ items: query.workspace_id === 'ws-alpha' ? [] : [
    { id: 'ses-1', title: 'Refactor memory', busy: true, workspace_id: 'ws-beta' },
    { id: 'ses-2', title: 'Old notes', busy: false, workspace_id: 'ws-beta' },
  ], has_more: false })),
  getMemoryAdvisorStatus: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  probeMemoryAdvisor: vi.fn(async () => ({ ok: true, duration_ms: 412, usage_known: true, input_tokens: 180, output_tokens: 12, status: advisorResponse().advisor_status })),
  listModels: vi.fn(async () => ({ items: [
    { id: 'cheap-judge', provider_id: 'openai', remote_id: 'cheap-judge-1', max_context_size: 128000 },
  ] })),
  listProviders: vi.fn(async () => ({ items: [
    { id: 'openai', type: 'openai', base_url: 'https://api.example.test/v1', has_api_key: true, status: 'ok' },
    // A decision service: Jev reading its key from the server environment.
    { id: 'typesafe', type: 'system_one', service: 'decision', decision_protocol: 'system_one', base_url: 'https://api.typesafe.ai/v1', default_model: 'jev-latest', api_key_env: 'TYPESAFE_API_KEY', has_api_key: false, status: 'connected' },
  ] })),
  getModel: vi.fn(async (id: string) => ({ id, provider_id: 'openai', provider_source: 'explicit', base_url: advisorFake.modelBaseUrl, effective_base_url: advisorFake.modelEffectiveBaseUrl, revision: 'r1', issues: [] })),
  getProviderEntity: vi.fn(async (id: string) => ({ id, type: 'openai', base_url: 'https://api.example.test/v1', has_api_key: true, status: 'ok', revision: 'rev-1', custom_header_keys: [], env_keys: [] })),
  getCatalogProvider: vi.fn(async (id: string) => ({ id, name: id, wire_type: null, guessed: false, needs_base_url: false, base_url: null, rejected: false, reject_reason: null, env_key: null, models: [] })),
  patchConfig: vi.fn(async () => ({})),
  requestIdentity: {
    get: vi.fn(async () => ({ profiles: [], usage: [], observations: [], tracks: [], manifest_url: null })),
  },
};

const connectionMock = vi.hoisted(() => ({ token: '', url: 'http://127.0.0.1:8080', applyConnection: vi.fn() }));
vi.mock('../state/connection', () => ({
  useOptionalConnection: () => ({
    client,
    config: { url: connectionMock.url, token: connectionMock.token },
    scopeId: 'direct:http://127.0.0.1:8080',
  }),
  useConnection: () => ({
    client,
    klient,
    config: { url: connectionMock.url, token: connectionMock.token },
    scopeId: 'direct:http://127.0.0.1:8080',
    sshLabel: null,
    meta: { server_version: 'test', backend: 'v2' },
    wsStatus: 'open',
    socket: { nudge: vi.fn() },
    activateLocal: vi.fn(),
    disconnect: vi.fn(),
    applyConnection: connectionMock.applyConnection,
  }),
}));

vi.mock('../host', () => ({
  useHost: () => ({ kind: 'browser', connection: {} }),
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  // jsdom has no CSS.escape; the card ids are already selector-safe.
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  // …and no scrollIntoView, which the search-flash scroll runs on a card hit.
  Element.prototype.scrollIntoView ??= () => {};
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  connectionMock.token = '';
  connectionMock.url = 'http://127.0.0.1:8080';
  connectionMock.applyConnection.mockClear();
  klient.global.mcp.list.mockReset();
  klient.global.mcp.add.mockReset();
  klient.global.mcp.update.mockReset();
  klient.global.mcp.remove.mockReset();
  klient.global.mcp.test.mockReset();
  klient.global.mcp.listStoredOAuthCredentials.mockReset();
  klient.global.mcp.list.mockResolvedValue([]);
  klient.global.mcp.add.mockResolvedValue([]);
  klient.global.mcp.update.mockResolvedValue([]);
  klient.global.mcp.remove.mockResolvedValue([]);
  klient.global.mcp.test.mockResolvedValue({ success: true, output: '' });
  klient.global.mcp.listStoredOAuthCredentials.mockResolvedValue([]);
  client.listNamedAgentProfiles.mockClear();
  client.getMemorySettings.mockClear();
  client.memoryAuthority.mockReset();
  client.memoryAuthority.mockImplementation(async () => ({ version: 1, epoch: 0, backend: 'sqlite', mode: 'normal' }));
  client.patchMemorySettings.mockClear();
  client.getWorkspaceMemorySettings.mockClear();
  client.patchWorkspaceMemorySettings.mockClear();
  client.patchMemoryAdvisorSettings.mockClear();
  client.probeMemoryAdvisor.mockClear();
  advisorFake.advisor = undefined;
  advisorFake.status = {};
  advisorFake.patches = [];
  advisorFake.memoryEnabled = true;
  advisorFake.modelBaseUrl = undefined;
  advisorFake.modelEffectiveBaseUrl = undefined;
  client.listSessions.mockClear();
  client.getMemoryAdvisorStatus.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
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

function GuardedSettingsFixture() {
  const location = useLocation();
  const navigate = useNavigate();
  const rawNavigate = useCallback<GuardedNavigate>((target, options) => {
    if (typeof target === 'number') void navigate(target);
    else void navigate(target, options);
  }, [navigate]);
  const guard = useDirtyGuardState(location, rawNavigate);
  return (
    <DirtyGuardContext.Provider value={guard.value}>
      <SettingsPage onToggleSidebar={() => {}} />
      <output data-test-location data-test-location-key={location.key}>{location.pathname}{location.search}{location.hash}</output>
      <button data-test-dirty onClick={() => { guard.value.reportDirty('fixture-editor', true); }}>Edit draft</button>
      {guard.pending ? <>
        <button data-test-cancel onClick={guard.cancel}>Stay</button>
        <button data-test-confirm onClick={() => { void guard.confirm(); }}>Discard and leave</button>
      </> : null}
    </DirtyGuardContext.Provider>
  );
}

async function renderSettings(initialPath: string, handles?: { queryClient?: QueryClient; guarded?: boolean }): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (handles !== undefined) handles.queryClient = queryClient;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="/settings/:section?" element={handles?.guarded === true
                ? <GuardedSettingsFixture /> : <SettingsPage onToggleSidebar={() => {}} />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function setTextarea(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A promise a test resolves by hand, to hold a card's own read open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function scopeHeader(container: HTMLDivElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-settings-intro]')!;
}

describe('SettingsPage panel scopes', () => {
  it('keeps the workspace breadcrumb for a cached catalog row and clears it on return', async () => {
    const container = await renderSettings('/settings/workspaces');
    const title = () => container.querySelector('[data-settings-page-title]')?.textContent;
    await click(container.querySelector('[data-workspace-open="ws-alpha"]')!);
    await flush();
    expect(title()).toBe('Alpha');
    await click(container.querySelector('[data-workspace-detail-back]')!);
    await flush();
    expect(title()).toBe('Workspaces');
    await click(container.querySelector('[data-workspace-open="ws-beta"]')!);
    await flush();
    expect(title()).toBe('Beta');
    expect(container.querySelector('[data-workspace-detail-name]')?.textContent).toBe('Beta');
  });

  it('names a cold workspace detail breadcrumb from the catalog without waiting for stats', async () => {
    const container = await renderSettings('/settings/workspaces?workspace=ws-beta');
    await flush();
    expect(container.querySelector('[data-settings-page-title]')?.textContent).toBe('Beta');
    expect(container.querySelector('[data-workspace-detail-stats]')?.textContent).toContain('Loading');
  });
  it('manages MCP in place on the settings leaf, next to its timeouts', async () => {
    const container = await renderSettings('/settings/mcp');
    // Batch X: the link card is gone — the manager itself lives on the leaf,
    // reading the same runtime join the Capabilities page does.
    expect(container.querySelector('[data-mcp-global]')).not.toBeNull();
    expect(container.querySelector('#st-card-mcp [data-capability-link-open="mcp"]')).toBeNull();
    expect(container.querySelector('#workspace-mcp-select')).toBeNull();
  });

  it('shows the connected server on the connections panel that edits models', async () => {
    const container = await renderSettings('/settings/ai?tab=providers');
    expect(container.querySelector('#st-card-providers [data-settings-panel-scope]')?.textContent).toContain('connected server');
  });

  it('says nothing about where changes go while connected to the local server', async () => {
    const general = await renderSettings('/settings/general');
    // Device cards on a device page carry no repeated tag.
    expect(general.querySelector('#st-card-composer [data-settings-panel-scope]')?.className).toContain('sr-only');
    for (const page of [general, await renderSettings('/settings/permissions')]) {
      expect(page.querySelector('[data-settings-page-status]')).toBeNull();
      expect(page.querySelector('[data-settings-remote-line]')).toBeNull();
      expect(page.textContent).not.toMatch(/This device|All sessions|Applies to all your sessions|Only affects this app|127\.0\.0\.1/);
    }
  });

  it('adds one quiet line naming a remote server on server pages only', async () => {
    connectionMock.url = 'https://kiki.example.net';
    const permissions = await renderSettings('/settings/permissions');
    const line = permissions.querySelector('[data-settings-remote-line]')!;
    expect(line.textContent).toBe('Saved on the remote server you’re connected to.');
    expect(line.getAttribute('title')).toBe('Connected to kiki.example.net');
    // The address stays in the tooltip; the nav never mentions the server.
    expect(permissions.querySelector('nav')?.textContent ?? '').not.toContain('kiki.example.net');
    // General only changes this app, so it has nothing to say about the server.
    const general = await renderSettings('/settings/general');
    expect(general.querySelector('[data-settings-remote-line]')).toBeNull();
  });

  it('keeps the remote-server and unsaved lines on a single plugin page', async () => {
    // The plugin page drops the section's orientation sentence because the card
    // heading already says it. It must not drop the two facts that are not
    // restated anywhere else: where a change is written, and whether one is
    // waiting to be saved.
    connectionMock.url = 'https://kiki.example.net';
    const container = await renderSettings('/settings/plugins?plugin=kiki-notes', { guarded: true });
    await flush();
    expect(container.querySelector('[data-settings-intro]')).toBeNull();
    expect(container.querySelector('[data-settings-remote-line]')).not.toBeNull();
    expect(container.querySelector('[data-settings-page-status]')).not.toBeNull();

    (container.querySelector('[data-test-dirty]') as HTMLButtonElement).click();
    await flush();
    const unsaved = container.querySelector('[data-settings-unsaved]');
    expect(unsaved).not.toBeNull();
    expect(unsaved?.textContent).toContain('Unsaved changes');
    // Both facts still stand together: the line is not replaced by the other.
    expect(container.querySelector('[data-settings-remote-line]')).not.toBeNull();
  });

  it('shows the Extensions & tools page intro on /settings/mcp and keeps the timeouts card title concise', async () => {
    const mcp = await renderSettings('/settings/mcp');
    expect(mcp.querySelector('[data-settings-intro]')?.textContent).toBe('Manage skills, MCP tool servers, and installed plugins.');
    expect(mcp.textContent).not.toContain('Server-wide MCP timeouts.');
    expect(mcp.querySelector('#st-card-mcp-timeouts')).not.toBeNull();
  });

  it('opens the catalog-refresh card under maintenance on the providers tab, also from a retired models link', async () => {
    client.refreshAllProviders.mockClear();
    client.createModel.mockClear();
    const container = await renderSettings('/settings/ai?tab=models#st-card-catalog-refresh');
    await flush();
    const card = container.querySelector('#st-card-catalog-refresh');
    expect(card).not.toBeNull();
    expect(container.querySelector('[data-ai-tab="models"]')).toBeNull();
    expect(container.querySelector('[data-ai-tab="providers"]')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-models-maintenance]')?.hasAttribute('open')).toBe(true);
    expect(card!.textContent).toContain('Add models from your connections');
    expect(card!.textContent).toContain('Click Get models to query supported models from your providers.');
    expect(client.refreshAllProviders).not.toHaveBeenCalled();
    const reads = client.listDiscoveredModels.mock.calls.length;
    await click([...card!.querySelectorAll('button')].find((button) => button.textContent === 'Get models')!);
    await flush();
    expect(client.refreshAllProviders).toHaveBeenCalledTimes(1);
    expect(client.listDiscoveredModels.mock.calls.length).toBeGreaterThan(reads);
    expect(client.createModel).not.toHaveBeenCalled();
  });

  it('shows memory beside sessions and edits the global settings on the page', async () => {
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    expect(container.querySelector('[data-settings-page-title]')?.textContent).toBe('Memory');
    expect(container.querySelector('#st-card-memory')).not.toBeNull();
    expect(container.querySelector('#st-card-memory-workspaces')).not.toBeNull();
    // A workspace override is written on the workspace's own page, never here:
    // no selector and no override control lives on this page any more.
    expect(container.querySelector('[data-memory-workspace-select]')).toBeNull();
    expect(container.querySelector('[data-memory-workspace-override]')).toBeNull();
    expect(client.getWorkspaceMemorySettings).not.toHaveBeenCalled();
    expect(client.patchWorkspaceMemorySettings).not.toHaveBeenCalled();
    // One visible label per row: the switch keeps its name for assistive tech only.
    const toggleRow = container.querySelector('#memory-enabled')!.closest('[data-settings-field]')!;
    expect(toggleRow.querySelector('span.sr-only')?.textContent).toBe('Allow memory');
    expect([...toggleRow.querySelectorAll('label, span')].filter((node) => node.textContent === 'Allow memory' && !node.classList.contains('sr-only') && node.children.length === 0)).toHaveLength(1);

    await pickOption(container.querySelector('[data-memory-approval]')!, 'Review in Inbox');
    expect(client.patchMemorySettings).toHaveBeenCalledWith({ approval: 'review' });

    // K04 keeps the text limit under Advanced; it still commits on Enter.
    const advanced = container.querySelector<HTMLDetailsElement>('[data-memory-advanced]')!;
    expect(advanced.open).toBe(false);
    expect(advanced.contains(container.querySelector('[data-memory-budget]'))).toBe(true);
    // The way into the memory page sits on the card heading, not in the rows.
    expect(container.querySelector('#st-card-memory [data-settings-card-actions] [data-memory-settings-link]')).not.toBeNull();
    expect(container.querySelector('[data-memory-budget-save]')).toBeNull();
    const budget = container.querySelector<HTMLInputElement>('[data-memory-budget]')!;
    expect(budget.value).toBe('2000');
    await commitText(budget, '1735');
    expect(client.patchMemorySettings).toHaveBeenCalledWith({ budget: 1735 });
    await flush();
    expect(budget.value).toBe('1735');
    expect(client.patchWorkspaceMemorySettings).not.toHaveBeenCalled();
  });

  it('turning memory off re-reads the advisor, whose status is on the same page', async () => {
    // The global switch decides the advisor's `disabled` state too, and the
    // advisor card shares this page: a save must re-read its status or the
    // card keeps saying Ready.
    let global = true;
    client.getMemorySettings.mockImplementation(async () => ({ enabled: global, approval: 'auto' as const, budget: 2000, workspaces: {} }));
    client.patchMemorySettings.mockImplementation(async (patch: { enabled?: boolean }) => {
      global = patch.enabled ?? global;
      return { enabled: global, approval: 'auto' as const, budget: 2000, workspaces: {} };
    });

    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    await flush();
    const advisorReads = client.getMemoryAdvisorSettings.mock.calls.length;

    await click(container.querySelector('#memory-enabled')!);
    await flush();
    await flush();

    expect(client.patchMemorySettings).toHaveBeenCalledWith({ enabled: false });
    expect(client.getMemoryAdvisorSettings.mock.calls.length).toBeGreaterThan(advisorReads);
    expect(container.querySelector<HTMLInputElement>('#memory-enabled')!.checked).toBe(false);
  });

  it('shows one upgrade line instead of every card failing while memory is being upgraded', async () => {
    client.memoryAuthority.mockImplementation(async () => ({
      version: 1, epoch: 0, backend: 'legacy', mode: 'migrating',
      migration: { id: '00000000-0000-4000-8000-000000000000', namespaces: [], index: 0, issues: [], phase: 'failed' },
    }));
    client.getMemorySettings.mockImplementation(async () => { throw Object.assign(new Error('Memory startup migration failed'), { code: 40001 }); });
    const container = await renderSettings('/settings/memory');
    await flush();
    await flush();
    expect(container.querySelector('[data-memory-settings-upgrading="failed"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-settings-open-upgrade]')?.getAttribute('href')).toBe('/memory');
    expect(container.querySelector('#memory-enabled')).toBeNull();
    expect(container.textContent).not.toContain('服务器返回了无法识别的数据');
    expect(container.textContent).not.toContain('could not be read');
  });

  it('updates the capability config the allow switch reads, then retries a failed save', async () => {
    const state = { allowed: true, host_locked: false, default_on: true, origin: 'home' as const, unresolved: false };
    client.getConfig.mockResolvedValue({
      optional_capabilities: {
        browser: { ...state, default_on: false },
        computer: { ...state, default_on: false },
        memory: { ...state },
        thread: state,
        web: state,
      },
    });
    let enabled = true;
    let fail = true;
    client.getMemorySettings.mockImplementation(async () => ({ enabled, approval: 'auto' as const, budget: 2000, workspaces: {} }));
    client.patchMemorySettings.mockImplementation(async (patch: { enabled?: boolean }) => {
      if (fail && patch.enabled === false) {
        fail = false;
        throw new Error('memory save failed');
      }
      enabled = patch.enabled ?? enabled;
      return { enabled, approval: 'auto' as const, budget: 2000, workspaces: {} };
    });
    const container = await renderSettings('/settings/memory');
    await flush();
    const allow = () => container.querySelector<HTMLInputElement>('#memory-enabled')!;
    const fallback = () => container.querySelector<HTMLInputElement>('#memory-default-on')!;
    expect(allow().checked).toBe(true);
    expect(fallback().disabled).toBe(false);

    await click(allow());
    await flush();
    expect(client.patchMemorySettings).toHaveBeenLastCalledWith({ enabled: false });
    expect(allow().checked).toBe(true);
    expect(fallback().disabled).toBe(false);

    await click(allow());
    await flush();
    await flush();
    expect(client.patchMemorySettings).toHaveBeenLastCalledWith({ enabled: false });
    expect(allow().checked).toBe(false);
    expect(fallback().disabled).toBe(true);

    await click(allow());
    await flush();
    await flush();
    expect(client.patchMemorySettings).toHaveBeenLastCalledWith({ enabled: true });
    expect(allow().checked).toBe(true);
    expect(fallback().disabled).toBe(false);
  });

  it('lists only the workspaces that differ, as read-only links to their own pages', async () => {
    client.getMemorySettings.mockResolvedValue({ enabled: true, approval: 'review' as const, budget: 2000, workspaces: { 'ws-alpha': false } });
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    const list = container.querySelector('[data-memory-exceptions]')!;
    // One row per exception: name, state, the way into the workspace's own
    // memory card. Nothing on this page writes the override.
    const row = list.querySelector<HTMLAnchorElement>('[data-memory-exception-open="ws-alpha"]')!;
    expect(row.textContent).toContain('Alpha');
    expect(row.textContent).toContain('Off');
    expect(row.getAttribute('href')).toBe('/settings/workspaces?workspace=ws-alpha#st-card-workspace-memory');
    expect(container.querySelector('[data-memory-workspace-override]')).toBeNull();
    expect(client.patchWorkspaceMemorySettings).not.toHaveBeenCalled();
    // The common case — no overrides anywhere — is one quiet line, not a form.
    expect(container.textContent).not.toContain('Follow global');
  });

  it('says every workspace follows global when none differs, and refuses an out-of-range budget', async () => {
    client.getMemorySettings.mockResolvedValueOnce({ enabled: true, approval: 'review', budget: 2000, workspaces: {} });
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    expect(container.querySelector('[data-memory-exceptions-empty]')?.textContent).toContain('Every workspace follows the global setting.');
    const budget = container.querySelector<HTMLInputElement>('[data-memory-budget]')!;
    expect(budget.value).toBe('2000');
    const writes = client.patchMemorySettings.mock.calls.length;
    await commitText(budget, '4001');
    expect(client.patchMemorySettings.mock.calls.length).toBe(writes);
    expect(budget.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Enter a whole number from 0 to 4,000.');
  });
});

describe('SettingsPage memory advisor', () => {
  const card = (container: HTMLElement) => container.querySelector<HTMLElement>('#st-card-memory-advisor')!;

  it('starts on but asking for a model, and never offers to send before one is saved', async () => {
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    expect(card(container)).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('#memory-advisor-enabled')!.checked).toBe(true);
    expect(card(container).querySelector('[data-memory-advisor-status]')?.getAttribute('data-memory-advisor-status')).toBe('unconfigured');
    expect(card(container).textContent).toContain('Needs a source');
    expect(card(container).querySelector('[data-memory-advisor-test]')).toBeNull();
    // Engine tuning sits in the card's own 高级 fold.
    expect(card(container).querySelector('[data-memory-advisor-advanced]')).not.toBeNull();
    expect(client.getMemoryAdvisorSettings).toHaveBeenCalledWith('ws-beta');
  });

  it('shows the chosen source read-only, works without a separate OK and probes the reported destination', async () => {
    advisorFake.advisor = { source: { kind: 'connection', connection: 'typesafe' } };
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    expect(card(container).querySelector('[data-decision-summary="memory"]')?.hasAttribute('data-decision-problem')).toBe(false);
    // The card has no model, protocol or endpoint fields of its own any more.
    expect(card(container).querySelector('#memory-advisor-model')).toBeNull();
    expect(card(container).querySelector('[data-memory-advisor-endpoint]')).toBeNull();
    expect(card(container).querySelector('[data-decision-summary="memory"] [data-decision-summary-value]')?.textContent).toBe('typesafe · jev-latest');
    // No sending-out block, OK button or workspace picker; the destination
    // diagnostic and the tuning numbers sit in the card's 高级 fold.
    expect(card(container).querySelector('[data-memory-advisor-egress]')).toBeNull();
    expect(card(container).querySelector('[data-memory-advisor-allow]')).toBeNull();
    expect(card(container).querySelector('[data-memory-advisor-workspace]')).toBeNull();
    const fold = card(container).querySelector<HTMLDetailsElement>('[data-memory-advisor-advanced]')!;
    expect(fold).not.toBeNull();
    fold.open = true;
    expect(fold.querySelector('[data-memory-advisor-destination]')).not.toBeNull();
    expect(fold.querySelector('[data-memory-advisor-timeout-ms]')).not.toBeNull();
    expect(card(container).textContent).toContain('Ready');
    expect(advisorFake.patches).toEqual([]);

    await click(card(container).querySelector('[data-memory-advisor-test]')!);
    await flush();
    expect(client.probeMemoryAdvisor).toHaveBeenCalledWith('typesafe@https://api.typesafe.ai');
  });

  it('echoes an older model setting as the source in effect and links to Decision models', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    const container = await renderSettings('/settings/memory', { guarded: true });
    expect(card(container).querySelector('[data-decision-summary-value]')?.textContent).toBe('Still using the source saved in the older settings: cheap-judge.');
    await click(card(container).querySelector('[data-decision-change]')!);
    await flush();
    expect(container.querySelector('[data-test-location]')?.textContent ?? '').toContain('/settings/ai?tab=providers#st-card-decision-connections');
  });
  it('turns only the advisor off: the mode alone is written, memory stays on, the model and consent stay', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' }, egress_ack: [{ workspace_id: 'ws-beta', destination: 'openai:https://api.example.test' }] };
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    const memoryWrites = client.patchMemorySettings.mock.calls.length;
    await click(container.querySelector('#memory-advisor-enabled')!);
    await flush();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: { mode: 'off' } });
    expect(client.patchMemorySettings.mock.calls.length).toBe(memoryWrites);
    expect(container.querySelector<HTMLInputElement>('#memory-enabled')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('#memory-advisor-enabled')!.checked).toBe(false);
    expect(card(container).textContent).toContain('cheap-judge');
    await click(container.querySelector('#memory-advisor-enabled')!);
    await flush();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: { mode: 'rank' } });
    expect(card(container).textContent).toContain('Ready');
  });

  it('shows a failed switch as an error and leaves the saved state unchanged', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    client.patchMemoryAdvisorSettings.mockRejectedValueOnce(new Error('config is read-only'));
    const container = await renderSettings('/settings/memory');
    await click(container.querySelector('#memory-advisor-enabled')!);
    await flush();
    expect(card(container).querySelector('[role="alert"]')?.textContent).toContain('Could not save Memory Advisor settings: config is read-only');
    expect(container.querySelector<HTMLInputElement>('#memory-advisor-enabled')!.checked).toBe(true);
  });

  it('shows the first-step wait the source uses by default and resets an explicit value without saving the default', async () => {
    advisorFake.advisor = { source: { kind: 'connection', connection: 'judge' } };
    const container = await renderSettings('/settings/memory');
    const fold = card(container).querySelector<HTMLDetailsElement>('[data-memory-advisor-advanced]')!;
    fold.open = true;
    const wait = () => fold.querySelector<HTMLInputElement>('[data-memory-advisor-first-step-wait-ms]')!;
    expect(wait().value).toBe('3000');
    expect(fold.querySelector('[data-memory-advisor-wait-default]')).not.toBeNull();
    expect(fold.querySelector('[data-memory-advisor-wait-reset]')).toBeNull();
    await commitText(wait(), '1500');
    await flush();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: { first_step_wait_ms: 1500 } });
    expect(wait().value).toBe('1500');
    expect(fold.querySelector('[data-memory-advisor-wait-default]')).toBeNull();
    await click(fold.querySelector('[data-memory-advisor-wait-reset]')!);
    await flush();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: { first_step_wait_ms: null } });
    expect(advisorFake.advisor).not.toHaveProperty('first_step_wait_ms');
    expect(wait().value).toBe('3000');
    advisorFake.advisor = { source: { kind: 'model', model: 'cheap-judge' } };
    const chat = await renderSettings('/settings/memory');
    expect(card(chat).querySelector<HTMLInputElement>('[data-memory-advisor-first-step-wait-ms]')!.value).toBe('1500');
  });

  it('removes the whole block at once and offers Undo with the captured config', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    const container = await renderSettings('/settings/memory');
    await click(card(container).querySelector('[data-memory-advisor-remove]')!);
    await flush();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: null });
    // Reversible with the same data: the toast writes the captured advisor back.
    const { getToasts } = await import('../lib/toasts');
    const undo = getToasts().find((toast) => toast.undo !== undefined);
    expect(undo).toBeDefined();
    await undo!.undo!.run();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: advisorFake.advisor });
  });

  it('tunes the advisor numbers in the advisor card’s advanced fold, inside the schema range', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    const container = await renderSettings('/settings/memory');
    const fold = container.querySelector<HTMLDetailsElement>('[data-memory-advisor-advanced]')!;
    expect(fold).not.toBeNull();
    fold.open = true;
    const tuning = fold.querySelector<HTMLElement>('[data-memory-advisor-tuning]')!;
    expect(tuning).not.toBeNull();
    const timeout = tuning.querySelector<HTMLInputElement>('[data-memory-advisor-timeout-ms]')!;
    expect(timeout.value).toBe('6000');
    await commitText(timeout, '99');
    expect(timeout.getAttribute('aria-invalid')).toBe('true');
    expect(tuning.textContent).toContain('Enter a whole number from 100 to 60000.');
    await commitText(timeout, '9000');
    await flush();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: { timeout_ms: 9000 } });
    // The destination diagnostic moved with the numbers.
    expect(tuning.querySelector('[data-memory-advisor-destination]')?.textContent).toBe('openai:https://api.example.test');
  });

  it('reports a failed removal in place and retries from the same button', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    const container = await renderSettings('/settings/memory');
    client.patchMemoryAdvisorSettings.mockRejectedValueOnce(new Error('config is read-only'));
    await click(card(container).querySelector('[data-memory-advisor-remove]')!);
    await flush();
    expect(document.querySelector('[data-memory-advisor-remove-error], [data-memory-advisor-settings] [role="alert"]')?.textContent).toContain('config is read-only');
    expect(advisorFake.advisor).toBeDefined();
    await click(card(container).querySelector('[data-memory-advisor-remove]')!);
    await flush();
    expect(advisorFake.patches.at(-1)).toEqual({ advisor: null });
  });

  it('accepts one heading-switch write at a time', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    let release!: () => void;
    client.patchMemoryAdvisorSettings.mockImplementationOnce(async (patch: { advisor?: Record<string, unknown> | null }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      advisorFake.patches.push(patch);
      advisorFake.advisor = { ...advisorFake.advisor, ...patch.advisor };
      return advisorResponse();
    });
    const container = await renderSettings('/settings/memory');
    const toggle = () => container.querySelector<HTMLInputElement>('#memory-advisor-enabled')!;
    await click(toggle());
    expect(toggle().disabled).toBe(true);
    await click(toggle());
    expect(client.patchMemoryAdvisorSettings).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await flush();
    expect(advisorFake.patches).toEqual([{ advisor: { mode: 'off' } }]);
    expect(toggle().disabled).toBe(false);
  });

  it('turning memory off updates the advisor on the same screen', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' }, egress_ack: [{ workspace_id: 'ws-beta', destination: 'openai:https://api.example.test' }] };
    client.patchMemorySettings.mockImplementationOnce(async (patch: { enabled?: boolean }) => {
      advisorFake.memoryEnabled = patch.enabled ?? true;
      return { enabled: advisorFake.memoryEnabled, approval: 'auto', budget: 2000, workspaces: {} };
    });
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    expect(card(container).textContent).toContain('Ready');
    await click(container.querySelector('#memory-enabled')!);
    await flush();
    expect(card(container).textContent).toContain('Paused while memory is off');
    expect(card(container).querySelector('[data-memory-advisor-memory-off]')).not.toBeNull();
    // Memory off is not the advisor off: its own switch and model are untouched.
    expect(container.querySelector<HTMLInputElement>('#memory-advisor-enabled')!.checked).toBe(true);
    expect(advisorFake.patches).toEqual([]);
  });

  it('reads a running agent\'s status on request and keeps a cold session distinct', async () => {
    advisorFake.advisor = { selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    const fold = container.querySelector<HTMLDetailsElement>('[data-memory-advisor-advanced]')!;
    fold.open = true;
    const runtime = () => fold.querySelector<HTMLElement>('[data-memory-advisor-runtime]')!;
    expect(client.getMemoryAdvisorStatus).not.toHaveBeenCalled();
    expect(client.listSessions).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: 'ws-beta' }));
    client.getMemoryAdvisorStatus.mockResolvedValueOnce({
      state: 'failed', reason: 'timeout', consent_required: false, logical_calls: 2, requests: 3, retries: 1,
      recommended_count: 0, displaced_ids: [], unjudged_count: 4, enumeration: 'partial',
    });
    await click(runtime().querySelector('[data-memory-advisor-runtime-read]')!);
    await flush();
    expect(client.getMemoryAdvisorStatus).toHaveBeenLastCalledWith('ses-1', 'main');
    const result = runtime().querySelector('[data-memory-advisor-runtime-result]')!;
    expect(result.getAttribute('data-memory-advisor-runtime-result')).toBe('failed');
    expect(result.textContent).toContain('Not working, keyword match in use');
    expect(result.textContent).toContain('The model did not answer in time.');
    expect(result.textContent).toContain('Requests3');
    expect(result.textContent).toContain('Not judged4');
    expect(result.textContent).toContain('Partial');
    // Another session hides the previous result instead of showing it as its own.
    await pickOption(runtime().querySelector('[data-memory-advisor-runtime-session]')!, 'Old notes');
    expect(runtime().querySelector('[data-memory-advisor-runtime-result]')).toBeNull();
    client.getMemoryAdvisorStatus.mockResolvedValueOnce(null);
    await click(runtime().querySelector('[data-memory-advisor-runtime-read]')!);
    await flush();
    expect(client.getMemoryAdvisorStatus).toHaveBeenLastCalledWith('ses-2', 'main');
    expect(runtime().querySelector('[data-memory-advisor-runtime-result]')?.getAttribute('data-memory-advisor-runtime-result')).toBe('none');
    expect(runtime().textContent).toContain('No running status yet.');
  });
});

describe('SettingsPage batch-3 leaves', () => {
  it('mounts the skills leaf with discovery defaults and the catalog managed in place', async () => {
    const container = await renderSettings('/settings/skills');
    expect(container.querySelector('#st-card-caps')).not.toBeNull();
    expect(container.querySelector('#st-card-caps [data-settings-panel-scope]')?.textContent).toContain('connected server');
    // Batch X: the catalog is managed on the leaf itself; the Capabilities
    // page stays one click away as a plain secondary link.
    expect(container.querySelector('#st-card-skill-catalog [data-skills-view]')).not.toBeNull();
    expect(container.querySelector('#st-card-skill-catalog [data-skills-browse-link]')?.getAttribute('href')).toBe('/capabilities?tab=skills');
    expect(container.querySelector('#st-card-skill-catalog [data-capability-link-open="skills"]')).toBeNull();
  });

  it('renders and saves the GUI request timeout in seconds', async () => {
    localStorage.removeItem('kiki.settings');
    const container = await renderSettings('/settings/connection');
    const card = container.querySelector('#st-card-conn-timeout')!;
    const input = card.querySelector<HTMLInputElement>('#st-conn-request-timeout')!;
    expect(input.value).toBe('30');
    expect(card.textContent).toContain('Request timeout');

    // The field saves itself on Enter; there is no separate Save button.
    expect(card.querySelector('button:not([data-setting-help])')).toBeNull();
    await commitText(input, '120');
    await flush();

    expect(JSON.parse(localStorage.getItem('kiki.settings') ?? '{}')).toMatchObject({
      requestTimeoutSeconds: 120,
    });
    expect(card.querySelector('[data-saved-tick]')?.textContent).toBe('Saved');

    // Out-of-range input stays in the field with a message and is not written.
    await commitText(input, '2');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(JSON.parse(localStorage.getItem('kiki.settings') ?? '{}')).toMatchObject({ requestTimeoutSeconds: 120 });
  });

  it('saves an unlimited reading timeout independently of ordinary request timeouts', async () => {
    localStorage.removeItem('kiki.settings');
    const container = await renderSettings('/settings/connection');
    const input = container.querySelector<HTMLInputElement>('#st-conn-reading-timeout')!;
    expect(input.value).toBe('0');
    expect(container.querySelector<HTMLInputElement>('#st-conn-request-timeout')!.value).toBe('30');
    await commitText(input, '3600');
    expect(JSON.parse(localStorage.getItem('kiki.settings') ?? '{}')).toMatchObject({ readingTimeoutSeconds: 3600 });
    expect(container.querySelector<HTMLInputElement>('#st-conn-request-timeout')!.value).toBe('30');
    await commitText(input, '-1');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(JSON.parse(localStorage.getItem('kiki.settings') ?? '{}')).toMatchObject({ readingTimeoutSeconds: 3600 });
    await commitText(input, '0');
    expect(JSON.parse(localStorage.getItem('kiki.settings') ?? '{}')).toMatchObject({ readingTimeoutSeconds: 0 });
  });

  it('reveals, edits, and overwrites the saved connection token', async () => {
    connectionMock.token = 'saved-token';
    const container = await renderSettings('/settings/connection');
    const card = container.querySelector('#st-card-conn-server')!;
    expect(card.querySelector('[data-conn-url]')?.textContent).toBe('http://127.0.0.1:8080');
    expect(card.querySelector('[data-conn-no-token]')).toBeNull();
    // The browser cannot restart the desktop's own server, so the card is
    // absent there rather than a "desktop only" shell.
    expect(container.querySelector('#st-card-conn-owned')).toBeNull();

    await click(card.querySelector('[data-conn-edit]')!);
    const urlInput = card.querySelector<HTMLInputElement>('#st-conn-url')!;
    await setInput(urlInput, 'http://127.0.0.1:9090');
    expect(card.querySelector('[data-settings-draft="connection-endpoint"]')?.getAttribute('data-dirty')).toBe('true');
    await click(card.querySelector('[data-settings-discard="connection-endpoint"]')!);
    expect(card.querySelector('form')).toBeNull();
    expect(card.querySelector('[data-conn-url]')?.textContent).toBe('http://127.0.0.1:8080');

    await click(card.querySelector('[data-conn-edit]')!);
    const token = card.querySelector<HTMLInputElement>('#st-conn-token')!;
    // Stored and masked: the field never carries the value until asked.
    expect(token.value).not.toContain('saved-token');
    expect(token.readOnly).toBe(true);
    await click(card.querySelector('[aria-label="Show Bearer token"]')!);
    expect(token.value).toBe('saved-token');
    await click(card.querySelector('[data-secret-edit]')!);
    expect(token.readOnly).toBe(false);
    await setInput(token, 'replacement-token');
    await act(async () => {
      card.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(connectionMock.applyConnection).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:8080', token: 'replacement-token',
    });
  });

  it('mounts the mcp leaf with its manager and timeouts', async () => {
    const container = await renderSettings('/settings/mcp');
    expect(container.querySelector('[data-mcp-global]')).not.toBeNull();
    expect(container.querySelector('#st-card-mcp [data-capability-link="mcp"]')).toBeNull();
    expect(container.querySelector('#st-card-mcp-timeouts')).not.toBeNull();
  });

  it('saves MCP timeouts only after an edit and keeps the dirty draft across config refetches', async () => {
    client.getConfig.mockResolvedValueOnce({ mcp: { startupTimeoutMs: 30000, toolTimeoutMs: 60000 } });
    client.patchConfig.mockResolvedValueOnce({ mcp: { startupTimeoutMs: 45000, toolTimeoutMs: 60000 } });
    const handles: { queryClient?: QueryClient } = {};
    const container = await renderSettings('/settings/mcp', handles);
    const card = container.querySelector('#st-card-mcp-timeouts')!;
    const inputs = card.querySelectorAll('input');
    const startup = inputs[0]!;
    expect(startup.value).toBe('30000');
    expect(inputs[1]!.value).toBe('60000');
    // Not the first button: each timeout now carries an on-demand help trigger
    // ahead of the commit row.
    const save = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    expect(save.disabled).toBe(true);

    await setInput(startup, '45000');
    expect(save.disabled).toBe(false);

    // A shared-config echo while dirty must not clobber the draft.
    await act(async () => {
      handles.queryClient!.setQueryData(['config'], { mcp: { startupTimeoutMs: 99000 } });
    });
    expect(startup.value).toBe('45000');

    await click(save);
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({
      mcp: { startup_timeout_ms: 45000, tool_timeout_ms: 60000 },
      replace_domains: ['mcp'],
    });
    expect(save.disabled).toBe(true);
    // Success is the transient saved tick, not a boxed message.
    expect(card.querySelector('[data-saved-tick]')?.textContent).toBe('Saved');
  });

  it('reads an empty MCP timeout as the default and keeps the clearing rule on demand', async () => {
    const container = await renderSettings('/settings/mcp');
    await flush();
    const card = container.querySelector('#st-card-mcp-timeouts')!;
    // The first screen says what the unit is and that empty means the default.
    const visible = card.textContent ?? '';
    expect(visible).toContain('Server-wide MCP timeouts in milliseconds. Leave a field empty to use the default.');
    // The consequence of clearing a saved value is not on it.
    expect(visible).not.toContain('clearing a field that has a value removes it');
    expect(card.querySelector('[data-setting-help-bubble]')).toBeNull();

    // Each timeout says so behind its own trigger.
    for (const trigger of card.querySelectorAll<HTMLButtonElement>('[data-setting-help]')) {
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
      });
      expect(document.body.textContent).toContain('clearing a field that has a value removes it');
    }
  });

  it('clears an MCP timeout back to the default when the field is emptied', async () => {
    client.getConfig.mockResolvedValue({ mcp: { startupTimeoutMs: 30000 } });
    client.patchConfig.mockResolvedValueOnce({ mcp: {} });
    const container = await renderSettings('/settings/mcp');
    const card = container.querySelector('#st-card-mcp-timeouts')!;
    const startup = card.querySelectorAll('input')[0]!;
    expect(startup.value).toBe('30000');
    await setInput(startup, '');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    await flush();
    // Empty is `undefined` on the wire: the saved override is removed, not set to zero.
    expect(client.patchConfig).toHaveBeenCalledWith({
      mcp: { startup_timeout_ms: undefined, tool_timeout_ms: undefined },
      replace_domains: ['mcp'],
    });
    expect(startup.value).toBe('');
  });

  it('splits the retired automation leaf into permissions and hooks', async () => {
    const container = await renderSettings('/settings/automation');
    expect(container.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(container.querySelector('#st-card-reviewer')).not.toBeNull();
    expect(container.querySelector('#st-card-tools')).not.toBeNull();
    expect(container.querySelector('#st-card-tool-experiments')).toBeNull();
    expect(container.querySelector('#st-card-hooks')).toBeNull();
    const hooks = await renderSettings('/settings/hooks');
    expect(hooks.querySelector('#st-card-hooks')).not.toBeNull();
    expect(hooks.querySelector('[data-settings-intro]')?.textContent).toContain('Rules that run when an event happens.');
  });

  it('redirects the retired runtime leaf to the tasks page', async () => {
    const container = await renderSettings('/settings/runtime');
    expect(container.querySelector('#st-card-runtime')).toBeNull();
    expect(container.querySelector('#st-card-task-policy')).not.toBeNull();
    expect(container.querySelector('#st-card-cron')).toBeNull();
    expect(container.querySelector('#st-card-tools')).toBeNull();
  });

  it.each([
    ['/settings/extensions', '#st-card-plugins'],
    ['/settings/environment-tools', '[data-settings-page-title]'],
    ['/settings/remote', '#st-card-conn-server'],
    ['/settings/system', '#st-card-cron'],
  ] as const)('keeps the retired combined page %s resolving', async (path, cardSelector) => {
    localStorage.setItem('kiki.locale', 'en');
    const container = await renderSettings(path);
    expect(container.querySelector('[data-settings-page-title]')?.textContent).not.toContain('does not exist');
    expect(container.querySelector(cardSelector)).not.toBeNull();
  });

  it('follows the retired connection external tab to the moved Cloudflare card', async () => {
    localStorage.setItem('kiki.locale', 'en');
    // Inbound connections read through the HTTP facade; without it the pane
    // boundary catches the throw and the page shows no cards at all.
    client.klient.rest = { connections: { list: async () => [], handshake: async () => ({}) } };
    try {
      const container = await renderSettings('/settings/connection?tab=external', { guarded: true });
      await vi.waitFor(() => {
        expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/connection-services?tab=web#st-card-conn-external');
      });
      // The tunnel sits with browser access: the tab that gives a browser an address.
      await vi.waitFor(() => {
        expect(container.querySelector('#st-card-conn-external')).not.toBeNull();
        expect(container.querySelector('#st-card-web-access')).not.toBeNull();
        expect(container.querySelector('#st-card-external-clients')).toBeNull();
      });
    } finally {
      client.klient.rest = undefined;
    }
  });

  it('moves between access tabs by keyboard and holds a dirty draft before leaving', async () => {
    localStorage.setItem('kiki.locale', 'en');
    client.klient.rest = { connections: { list: async () => [], handshake: async () => ({}) } };
    try {
      const container = await renderSettings('/settings/connection-services', { guarded: true });
      await flush();
      const tab = (id: string) => container.querySelector<HTMLButtonElement>(`[data-access-tab="${id}"]`)!;
      const location = () => container.querySelector('[data-test-location]')?.textContent;
      const press = async (key: string) => {
        await act(async () => {
          (document.activeElement ?? tab('web')).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
        await flush();
      };
      expect(tab('web').getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('#st-card-web-access')).not.toBeNull();
      act(() => { tab('web').focus(); });

      await press('ArrowRight');
      expect(document.activeElement).toBe(tab('kiki'));
      expect(location()).toBe('/settings/connection-services?tab=kiki');
      expect(container.querySelector('[data-access-panel="kiki"] #st-card-inbound-connections')).not.toBeNull();

      await press('End');
      expect(document.activeElement).toBe(tab('clients'));
      expect(tab('clients').getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('[data-access-panel="clients"] #st-card-external-clients')).not.toBeNull();

      await press('ArrowRight');
      expect(document.activeElement).toBe(tab('web'));
      expect(location()).toBe('/settings/connection-services?tab=web');

      await press('End');
      await press('Home');
      expect(document.activeElement).toBe(tab('web'));
      expect(location()).toBe('/settings/connection-services?tab=web');

      // A tab switch is a navigation: an unsaved draft holds it until the reader decides.
      await click(container.querySelector('[data-test-dirty]')!);
      await click(tab('clients'));
      expect(container.querySelector('[data-test-confirm]')).not.toBeNull();
      expect(location()).toBe('/settings/connection-services?tab=web');
      expect(tab('web').getAttribute('aria-selected')).toBe('true');
      await click(container.querySelector('[data-test-cancel]')!);
      expect(location()).toBe('/settings/connection-services?tab=web');
      await click(tab('clients'));
      await click(container.querySelector('[data-test-confirm]')!);
      await flush();
      expect(location()).toBe('/settings/connection-services?tab=clients');
      expect(tab('clients').getAttribute('aria-selected')).toBe('true');
    } finally {
      client.klient.rest = undefined;
    }
  });

  it('mounts the split runtime content on its new leaves', async () => {
    const tasks = await renderSettings('/settings/tasks');
    expect(tasks.querySelector('#st-card-task-policy')).not.toBeNull();
    expect(tasks.querySelector('#st-card-task-policy')!.textContent).toContain('Maximum running tasks');
    expect(tasks.querySelector('#st-card-cron')).toBeNull();

    const sessions = await renderSettings('/settings/communication');
    const messaging = sessions.querySelector('#st-card-agent-messaging')!;
    expect(messaging).not.toBeNull();
    expect(messaging.textContent).toContain('Allow threads');
    expect(messaging.textContent).toContain('Subagents can notify their parent');
    expect(sessions.querySelector('#st-card-token-counting')).toBeNull();

    const runtimeTab = await renderSettings('/settings/sessions?tab=runtime');
    expect(runtimeTab.querySelector('#st-card-resource-limits')).not.toBeNull();
    expect(runtimeTab.querySelector('#st-card-resource-limits')!.textContent).toContain('Workspace idle reclamation (s)');
    expect(runtimeTab.querySelector('#st-card-session-residency')).not.toBeNull();

    const defaultsTab = await renderSettings('/settings/ai?tab=defaults');
    expect(defaultsTab.querySelector('#st-card-token-counting')).not.toBeNull();
    expect(defaultsTab.querySelector('#st-card-retry')).not.toBeNull();

    const developer = await renderSettings('/settings/advanced');
    expect(developer.querySelector('#st-card-token-counting')).toBeNull();
    expect(developer.querySelector('#st-card-resource-limits')).toBeNull();
    expect(developer.querySelector('#st-card-retry')).toBeNull();
    expect(developer.querySelector('#st-card-session-residency')).toBeNull();
    expect(developer.querySelector('#st-card-memory-advisor-tuning')).toBeNull();
    // Cron is a read-only readout here, not a form.
    expect(developer.querySelector('#st-card-cron [data-settings-diagnostics]')).not.toBeNull();
    const diagnosticsScope = developer.querySelector('#st-card-cron [data-settings-panel-scope]');
    expect(diagnosticsScope?.getAttribute('data-settings-panel-scope')).toBe('readOnly');
    expect(diagnosticsScope?.textContent).toBe('diagnostic view');
    expect(developer.querySelector('#st-card-cron input, #st-card-cron [role="switch"]')).toBeNull();

    const agents = await renderSettings('/settings/agents');
    await flush();
    expect(agents.querySelector('#st-card-agent-runtime')).not.toBeNull();
    expect(agents.querySelector('#st-card-agent-runtime')!.textContent).toContain('Identity display name');
    expect(agents.querySelector('#st-card-agent-runtime')!.textContent).toContain('Extra agent directories');
  });

  it('saves the task policy card with the narrow task-domain patch', async () => {
    client.getConfig.mockResolvedValueOnce({ task: { maxRunningTasks: 4 } });
    client.patchConfig.mockResolvedValueOnce({ task: { maxRunningTasks: 6 } });
    client.patchConfig.mockClear();
    const container = await renderSettings('/settings/tasks');
    const card = container.querySelector('#st-card-task-policy')!;
    const input = card.querySelector('input')!;
    expect(input.value).toBe('4');
    const save = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    expect(save.disabled).toBe(true);

    await setInput(input, '6');
    expect(save.disabled).toBe(false);
    await click(save);
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ max_running_tasks: 6 }),
      replace_domains: ['task'],
    }));
    expect(card.querySelector('[data-saved-tick]')?.textContent).toBe('Saved');
  });

  it('keeps plan defaults on sessions and puts each flag on its feature page', async () => {
    const tasks = await renderSettings('/settings/tasks');
    expect(tasks.querySelector('#st-card-agent-board')).toBeNull();
    // /settings/tasks redirects to the Background work tab of /settings/sessions.
    expect(tasks.querySelector('#st-card-task-policy')).not.toBeNull();
    expect(tasks.querySelector('[data-sessions-tab="runtime"]')?.getAttribute('aria-selected')).toBe('true');
    const behavior = await renderSettings('/settings/sessions?tab=behavior');
    expect(behavior.querySelector('#st-card-defaults')).not.toBeNull();
    expect(behavior.querySelector('#st-card-questions')).not.toBeNull();
    const sessions = await renderSettings('/settings/sessions');
    expect(sessions.querySelector('#st-card-session-title')).not.toBeNull();
    // Session titles are switched by their own card, so they get no second row.
    expect(sessions.querySelector('[data-experimental-row="auto_session_title"]')).toBeNull();
    const homes: [string, string[]][] = [
      ['/settings/agents', ['agent-profile-routes', 'subagent_release_idle']],
      ['/settings/subagents', ['agent-profile-routes', 'subagent_release_idle']],
      ['/settings/mcp', ['tool-select', 'external_delegation_mcp']],
      ['/settings/tasks', ['session_idle_eviction', 'task_wait']],
      ['/settings/search?tab=advanced', ['desktop_search']],
      ['/settings/browser-control', ['native_browser']],
      ['/settings/developer', ['persistence_minidb_readmodel']],
    ];
    const baseMeta = await client.meta();
    client.meta.mockResolvedValue({ experimental_flags: { ...baseMeta.experimental_flags, native_browser: true } });
    client.klient.rest = { connections: { list: async () => [], handshake: async () => ({}) }, browser: { list: async () => ({ connections: [] }) } } as never;
    for (const [path, flags] of homes) {
      const page = await renderSettings(path);
      await flush();
      const rows = [...page.querySelectorAll('[data-experimental-row]')].map((row) => row.getAttribute('data-experimental-row'));
      expect(rows, path).toEqual(flags);
      for (const row of page.querySelectorAll('[data-experimental-row]')) {
        expect(row.querySelector('[data-experimental-tag]')?.textContent).toBe('Experimental');
        expect(row.querySelector('[data-experimental-effect]')?.textContent).not.toBe('');
      }
    }
  });

  it('keeps Labs as a read-only index linking every flag to its page', async () => {
    client.meta.mockResolvedValue({ experimental_flags: { 'tool-select': true, task_wait: true, desktop_search: true, persistence_minidb_readmodel: true, auto_session_title: true, subagent_release_idle: true, 'agent-profile-routes': true, external_delegation_mcp: true, image_format_conversion: false, native_ssh: false, session_idle_eviction: false } });
    const labs = await renderSettings('/settings/labs');
    await flush();
    const card = labs.querySelector('#st-card-labs')!;
    // No switches here: one control per flag, on its feature page.
    expect(card.querySelector('[data-experimental-row]')).toBeNull();
    expect(card.querySelector('[role="group"]')).toBeNull();
    const link = (flag: string) => card.querySelector(`[data-labs-entry="${flag}"] a`)?.getAttribute('href');
    expect(link('agent-profile-routes')).toBe('/settings/agents#st-card-exp-agents');
    expect(link('external_delegation_mcp')).toBe('/settings/extensions#st-card-exp-extensions');
    expect(link('subagent_release_idle')).toBe('/settings/agents#st-card-exp-agents');
    expect(link('desktop_search')).toBe('/settings/search#st-card-exp-search');
    expect(link('auto_session_title')).toBe('/settings/sessions#st-card-session-title');
    // Every flag the server reports is listed, including ones switched by a feature card.
    expect(card.querySelectorAll('[data-labs-entry]').length).toBe(11);
  });

  it('names flags this app has no copy for by their id, so two stay tellable apart', async () => {
    const reported = await client.meta();
    client.meta.mockResolvedValue({ experimental_flags: { ...reported.experimental_flags, vendor_alpha: true, vendor_beta: false } });
    try {
      const labs = await renderSettings('/settings/labs');
      await flush();
      const name = (flag: string) => labs.querySelector(`[data-labs-entry="${flag}"] [data-labs-unknown]`);
      expect(name('vendor_alpha')?.textContent).toBe('vendor_alpha');
      expect(name('vendor_beta')?.textContent).toBe('vendor_beta');
      // Visible text, not a hover title: no hidden-at-narrow class on the name.
      expect(name('vendor_alpha')?.className).not.toContain('hidden');
      // No invented meaning for an unknown flag; known flags keep their own name.
      expect(labs.querySelector('[data-labs-entry="vendor_alpha"]')?.textContent).not.toContain('Server-specific feature');
      expect(labs.querySelector('[data-labs-entry="desktop_search"] [data-labs-unknown]')).toBeNull();
    } finally {
      client.meta.mockImplementation(async () => reported);
    }
  });

  it('saves an experimental row on change with a narrow experimental patch', async () => {
    client.getConfig.mockResolvedValue({ experimental: { desktop_search: false } });
    client.patchConfig.mockClear();
    const mcp = await renderSettings('/settings/mcp');
    await flush();
    const on = mcp.querySelector<HTMLButtonElement>('[data-experimental-row="tool-select"] [data-experimental-choice="on"]')!;
    await click(on);
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({
      experimental: { desktop_search: false, 'tool-select': true },
      replace_domains: ['experimental'],
    });
    client.getConfig.mockResolvedValue({});
  });

  it('redirects the retired experimental URL to the labs index on developer', async () => {
    const container = await renderSettings('/settings/experimental', { guarded: true });
    expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/developer#st-card-labs');
    expect(container.querySelector('#st-card-labs')).not.toBeNull();
    expect(container.querySelector('#st-card-advanced')).not.toBeNull();
    expect(scopeHeader(container).textContent).toBe('Engine parameters, low-level configuration, system diagnostics, and experimental feature index.');
    expect(container.querySelector('#st-card-labs [data-labs-index]')).not.toBeNull();
    expect(container.querySelector('#st-card-labs [role="switch"]')).toBeNull();
  });

  it('sends an old single-flag card link to the flag’s new row', async () => {
    const container = await renderSettings('/settings/agents#st-card-mcp-delegation');
    await flush();
    expect(container.querySelector('#st-card-exp-extensions [data-experimental-row="external_delegation_mcp"]')).not.toBeNull();
  });

  it('mounts the developer page with the cron readout first and raw JSON after', async () => {
    const container = await renderSettings('/settings/developer');
    const card = container.querySelector('#st-card-advanced')!;
    expect(card).not.toBeNull();
    expect(scopeHeader(container).textContent).toBe('Engine parameters, low-level configuration, system diagnostics, and experimental feature index.');
    expect(card.textContent).toContain('Advanced configuration for permissions, loop controls, and background tasks. Validated on save.');
    expect(card.textContent).not.toContain('kap-server');
    const order = [...container.querySelectorAll('[data-settings-card]')].map((node) => node.id);
    expect(order).toEqual(['st-card-cron', 'st-card-advanced', 'st-card-labs', 'st-card-exp-developer']);

    const writes = client.patchConfig.mock.calls.length;
    await setTextarea(card.querySelector('textarea')!, '{');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save advanced domains')!);
    expect(client.patchConfig.mock.calls.length).toBe(writes);
    expect(card.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  it('saves advanced settings without the retired services domain', async () => {
    client.getConfig.mockResolvedValueOnce({
      permission: { mode: 'manual' },
      services: { legacy: true },
      loop_control: { max_steps_per_turn: 12 },
      background: { max_running_tasks: 2 },
    });
    client.patchConfig.mockResolvedValueOnce({
      permission: { mode: 'manual' },
      loop_control: { max_steps_per_turn: 12 },
      background: { max_running_tasks: 2 },
    });
    client.patchConfig.mockClear();
    const container = await renderSettings('/settings/advanced');
    const card = container.querySelector('#st-card-advanced')!;
    const textarea = card.querySelector('textarea')!;
    expect(textarea.value).not.toContain('services');

    const saveButton = [...card.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save advanced domains',
    )!;
    await setTextarea(textarea, `${textarea.value}\n`);
    await click(saveButton);
    await flush();

    expect(client.patchConfig).toHaveBeenCalledWith({
      permission: { mode: 'manual' },
      loop_control: { max_steps_per_turn: 12 },
      background: { max_running_tasks: 2 },
    });
  });

  it('mounts profiles and governance with a single editable timeout field', async () => {
    client.getConfig.mockResolvedValueOnce({
      subagent: { timeoutMs: 3_600_000, maxDirectChildren: 16, maxTotalSubagents: 0 },
    });
    const container = await renderSettings('/settings/subagents');
    await flush();
    expect(container.querySelector('#st-card-subagent-profiles')).toBeNull();
    expect(container.querySelector('#st-card-subagents')).not.toBeNull();
    const limits = container.querySelector('#st-card-subagent-limits')!;
    expect(limits.querySelector<HTMLInputElement>('input')!.value).toBe('1');
    expect(container.querySelector('#st-card-subagent-timeout')).toBeNull();
  });

  it('shows one unified agent list and editor separate from subagent governance', async () => {
    const container = await renderSettings('/settings/agents');
    await flush();
    expect(container.querySelector('#st-card-main-agents [data-team-view]')).not.toBeNull();
    expect(container.querySelector('#st-card-main-agents [data-team-table]')).not.toBeNull();
    // The editor is a sheet opened from a row, not a side-by-side detail pane.
    expect(container.querySelector('[data-profile-editor]')).toBeNull();
    expect(container.querySelector('#st-card-subagent-profiles')).toBeNull();
    expect(container.querySelector('#st-card-subagents')).toBeNull();
    // The profile-routes flag is one Experimental row at the end of the page.
    expect(container.querySelector('#st-card-agent-profile-routes')).toBeNull();
    expect(container.querySelector('#st-card-exp-agents [data-experimental-row="agent-profile-routes"]')).not.toBeNull();
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith('ws-alpha');
  });

  it('redirects bare /settings/capabilities to the skills leaf', async () => {
    const container = await renderSettings('/settings/capabilities');
    await flush();
    expect(container.querySelector('#st-card-caps')).not.toBeNull();
    expect(container.querySelector('#st-card-skill-catalog')).not.toBeNull();
  });

  it('follows a legacy capabilities card hash to its new leaf', async () => {
    const container = await renderSettings('/settings/capabilities#st-card-mcp');
    await flush();
    expect(container.querySelector('#st-card-mcp')).not.toBeNull();
    expect(container.querySelector('#st-card-mcp-timeouts')).not.toBeNull();
  });

  it('lands the dissolved sidecar card on the active execution-limits editor', async () => {
    const container = await renderSettings('/settings/agents#st-card-sidecar');
    await flush();
    expect(container.querySelector('#st-card-subagent-limits')).not.toBeNull();
    expect(container.querySelector('#st-card-sidecar')).toBeNull();
  });

  it('mounts the plugins leaf with the installed-plugins card', async () => {
    const container = await renderSettings('/settings/plugins');
    await flush();
    expect(container.querySelector('#st-card-plugins')).not.toBeNull();
    // The list is the leaf's subject; the market is reached by one link, and no
    // configuration form opens in place.
    expect(container.querySelector('#st-card-plugins [data-plugins-installed-empty], #st-card-plugins [data-plugins-installed-list]')).not.toBeNull();
    expect(container.querySelector('#st-card-plugins [data-plugins-market-link]')?.getAttribute('href')).toBe('/capabilities');
    expect(container.querySelector('#st-card-plugins [data-plugin-settings]')).toBeNull();
    // The browser runtime card is a browser fact, not a plugin one.
    expect(container.querySelector('#st-card-webbridge')).toBeNull();
    expect(client.listPlugins).toHaveBeenCalled();
  });

  it('does not show a relocation announcement on a legacy capabilities URL', async () => {
    const container = await renderSettings('/settings/skills?from=capabilities&workspace=ws-beta&token=tok');
    await flush();
    expect(container.querySelector('[data-capabilities-shim-note]')).toBeNull();
    expect(container.textContent).not.toContain('split into dedicated settings pages');
    expect(container.querySelector('#st-card-skill-catalog')).not.toBeNull();
  });

  it('saves tool policy with the narrow patch and invalidates only the tools query', async () => {
    const handles: { queryClient?: QueryClient } = {};
    const container = await renderSettings('/settings/automation', handles);
    await flush();
    const queryClient = handles.queryClient!;
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    client.patchConfig.mockClear();
    const card = container.querySelector('#st-card-tools')!;
    const mode = card.querySelector('[data-tool-mode]')!;
    await pickOption(mode, 'Only allow selected tools');
    await pickOption(mode, 'Follow each agent');
    const saveButton = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save tool policy')!;
    await click(saveButton);
    await flush();
    // The save is the narrow tools-domain patch, and the tools list (whose
    // descriptor `active` flags derive from the policy) is invalidated —
    // mcp-servers is not, this save never touches the mcp domain.
    expect(client.patchConfig).toHaveBeenCalledWith({
      tools: { enabled: [], disabled: [] },
      replace_domains: ['tools'],
    });
    const invalidated = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey?: unknown[] }).queryKey);
    expect(invalidated).toContainEqual(['tools']);
    expect(invalidated).not.toContainEqual(['mcp-servers']);
  });

  it('switches tabs on Extensions & tools and Browser & computer while preserving ?plugin= and legacy redirects', async () => {
    const extensions = await renderSettings('/settings/extensions', { guarded: true });
    await flush();
    expect(extensions.querySelector('[data-extensions-tab="plugins"]')?.getAttribute('aria-selected')).toBe('true');
    expect(extensions.querySelector('#st-card-plugins')).not.toBeNull();

    await click(extensions.querySelector('[data-extensions-tab="skills"]')!);
    await flush();
    expect(extensions.querySelector('[data-test-location]')?.textContent).toBe('/settings/extensions?tab=skills');
    expect(extensions.querySelector('#st-card-caps')).not.toBeNull();
    expect(extensions.querySelector('#st-card-skill-catalog')).not.toBeNull();

    await click(extensions.querySelector('[data-extensions-tab="mcp"]')!);
    await flush();
    expect(extensions.querySelector('[data-test-location]')?.textContent).toBe('/settings/extensions?tab=mcp');
    expect(extensions.querySelector('#st-card-mcp')).not.toBeNull();

    // Browser & computer renders its halves as switchable tabs; the legacy
    // computer-control address still resolves to the same section.
    client.klient.rest = { connections: { list: async () => [], handshake: async () => ({}) }, browser: { list: async () => ({ connections: [] }) } } as never;
    const browser = await renderSettings('/settings/browser-control', { guarded: true });
    await flush();
    expect(browser.querySelector('#st-card-browser-enabled')).not.toBeNull();
    expect(browser.querySelector('[data-browser-control-tab="computer"]')).not.toBeNull();

    const computerTab = await renderSettings('/settings/browser-control?tab=computer', { guarded: true });
    await flush();
    expect(computerTab.querySelector('#st-card-computer-enabled')).not.toBeNull();

    const legacyComputer = await renderSettings('/settings/computer-control', { guarded: true });
    await flush();
    expect(legacyComputer.querySelector('[data-test-location]')?.textContent).toBe('/settings/browser-control?tab=computer');
    expect(legacyComputer.querySelector('#st-card-computer-enabled')).not.toBeNull();
  });

  it('switches between Agents & profiles and Dispatch & subagents tabs on Agents', async () => {
    const agents = await renderSettings('/settings/agents', { guarded: true });
    await flush();
    expect(agents.querySelector('[data-agents-tab="profiles"]')?.getAttribute('aria-selected')).toBe('true');
    expect(agents.querySelector('#st-card-main-agents')).not.toBeNull();

    await click(agents.querySelector('[data-agents-tab="dispatch"]')!);
    await flush();
    expect(agents.querySelector('[data-test-location]')?.textContent).toBe('/settings/agents?tab=dispatch');
    expect(agents.querySelector('#st-card-subagents')).not.toBeNull();
    expect(agents.querySelector('#st-card-subagent-tool-defaults')).not.toBeNull();
  });
});

describe('SettingsPage search ownership', () => {
  it('indexes every card the settings page renders', async () => {
    const reported = await client.meta();
    const originalMeta = client.meta.getMockImplementation();
    client.meta.mockResolvedValue({
      experimental_flags: {
        ...reported.experimental_flags,
        plugin_workspace_usage: true,
        plugin_app_lifecycle: true,
        work_presets: true,
        external_clients: true,
      },
    });
    client.klient.rest = { connections: { list: async () => [], handshake: async () => ({}) } };
    try {
    const general = await renderSettings('/settings/general');
    const agents = await renderSettings('/settings/agents');
    const subagents = await renderSettings('/settings/subagents');
    const mcp = await renderSettings('/settings/mcp');
    const sessions = await renderSettings('/settings/sessions');
    const permissions = await renderSettings('/settings/permissions');
    const tasks = await renderSettings('/settings/tasks');
    const developer = await renderSettings('/settings/developer');
    const labs = await renderSettings('/settings/labs');
    const defaults = await renderSettings('/settings/ai?tab=defaults');
    const searchAdvanced = await renderSettings('/settings/search?tab=advanced');
    const ssh = await renderSettings('/settings/ssh');
    const plugins = await renderSettings('/settings/plugins');
    const spaces = await renderSettings('/settings/spaces');
    const connectionServices = await renderSettings('/settings/connection-services?tab=web');
    const accessKiki = await renderSettings('/settings/connection-services?tab=kiki');
    const accessClients = await renderSettings('/settings/connection-services?tab=clients');
    expect(general.querySelector('#st-card-session-title')).toBeNull();
    expect(defaults.querySelector('#st-card-permission-defaults')).toBeNull();
    expect(permissions.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(sessions.querySelector('#st-card-archived')).not.toBeNull();
    expect(labs.querySelector('#st-card-labs')).not.toBeNull();
    const dir = dirname(fileURLToPath(import.meta.url));
    const rendered = new Set(
      readdirSync(dir, { recursive: true })
        .map((name) => String(name).replaceAll('\\', '/'))
        .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
        .flatMap((name) => [
          ...readFileSync(resolve(dir, name), 'utf8')
            .matchAll(/id="(st-card-[a-z0-9-]+)"/g),
        ])
        .map((match) => match[1]!),
    );
    for (const page of [general, agents, subagents, mcp, sessions, permissions, tasks, developer, labs, defaults, searchAdvanced, ssh, plugins, spaces, connectionServices, accessKiki, accessClients]) {
      for (const card of page.querySelectorAll('[id^="st-card-"]')) rendered.add(card.id);
    }
    expect(rendered.size).toBeGreaterThan(10);
    const indexed = new Set(SETTINGS_SEARCH_SPEC.map((entry) => entry.cardId));
    // The bucket card stays available for legacy editor tests, not Settings navigation.
    rendered.delete('st-card-subagent-profiles');
    // The board card stays on disk for the direct AgentTaskSettings test. Settings does not mount it.
    rendered.delete('st-card-agent-board');
    // An open plugin's own page renders its cards only for a chosen plugin;
    // the search index does not index per-plugin cards.
    rendered.delete('st-card-plugin-settings');
    rendered.delete('st-card-plugin-manage');
    // The flag rows' card mounts only while the server reports a browser-page
    // flag; this sweep's meta reports none.
    indexed.delete('st-card-exp-browser-control');
    expect([...rendered].filter((id) => !indexed.has(id))).toEqual([]);
    expect([...indexed].filter((id) => !rendered.has(id))).toEqual([]);
    } finally {
      client.klient.rest = undefined;
      if (originalMeta !== undefined) client.meta.mockImplementation(originalMeta);
    }
  });
});

describe('SettingsPage search locating', () => {
  it.each([
    // The default-target card sits on the Agents page's Dispatch & subagents tab,
    // so the hit opens that leaf and switches to the dispatch tab.
    ['en', 'default profile', 'Agents', 'Default subagent'],
    ['zh', '默认 profile', '智能体', '默认子智能体'],
  ] as const)('clicks the %s default-target search hit into the mounted subagent card', async (locale, query, pageTitle, cardTitle) => {
    localStorage.setItem('kiki.locale', locale);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      const container = await renderSettings('/settings/general');
      const search = container.querySelector<HTMLInputElement>('[data-settings-search]')!;
      await setInput(search, query);
      const option = search.parentElement?.querySelector<HTMLButtonElement>('[role="option"]');
      expect(option?.textContent).toContain(cardTitle);

      await click(option!);
      for (let attempt = 0; attempt < 5; attempt++) await flush();

      expect(container.querySelector('[data-settings-page-title]')?.textContent).toBe(pageTitle);
      const card = container.querySelector<HTMLElement>('#st-card-subagent-default-target');
      expect(card).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(card?.className).toContain('settings-card-flash');
      expect(card?.querySelector('[data-subagent-default-target]')).not.toBeNull();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('locates the already-mounted card on every same-page search click', async () => {
    localStorage.setItem('kiki.locale', 'en');
    // The default-target card lives on the Agents dispatch tab, so that is the page
    // a same-page hit must be started from: the hit locates the mounted card
    // instead of navigating.
    const container = await renderSettings('/settings/agents?tab=dispatch', { guarded: true });
    const visitKey = container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key');
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      for (let hit = 1; hit <= 2; hit++) {
        const search = container.querySelector<HTMLInputElement>('[data-settings-search]')!;
        await setInput(search, 'default profile');
        await click(search.parentElement!.querySelector('[role="option"]')!);
        await flush();
        expect(scrollIntoView).toHaveBeenCalledTimes(hit);
        expect(container.querySelector('#st-card-subagent-default-target')?.className).toContain('settings-card-flash');
        expect(container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key')).toBe(visitKey);
      }
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('commits a tabbed search destination before locating and repeats without a new visit', async () => {
    localStorage.setItem('kiki.locale', 'en');
    const container = await renderSettings('/settings/ai?tab=defaults', { guarded: true });
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      expect(container.querySelector('#st-card-catalog-refresh')).toBeNull();
      for (let hit = 1; hit <= 2; hit++) {
        const visitKey = container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key');
        const search = container.querySelector<HTMLInputElement>('[data-settings-search]')!;
        await setInput(search, 'catalog refresh');
        await click(search.parentElement!.querySelector('[role="option"]')!);
        await flush();
        expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/ai?tab=providers#st-card-catalog-refresh');
        expect(container.querySelector('[data-ai-tab="providers"]')?.getAttribute('aria-selected')).toBe('true');
        const card = container.querySelector('#st-card-catalog-refresh');
        expect(card?.className).toContain('settings-card-flash');
        expect(scrollIntoView).toHaveBeenCalledTimes(hit);
        expect(scrollIntoView.mock.instances[hit - 1]).toBe(card);
        if (hit === 2) expect(container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key')).toBe(visitKey);
      }
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('locates a guarded search hit only after the reader confirms navigation', async () => {
    localStorage.setItem('kiki.locale', 'en');
    const container = await renderSettings('/settings/ai?tab=defaults', { guarded: true });
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      await click(container.querySelector('[data-test-dirty]')!);
      const search = container.querySelector<HTMLInputElement>('[data-settings-search]')!;
      await setInput(search, 'catalog refresh');
      await click(search.parentElement!.querySelector('[role="option"]')!);
      expect(container.querySelector('[data-test-confirm]')).not.toBeNull();
      expect(container.querySelector('#st-card-catalog-refresh')).toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();
      await click(container.querySelector('[data-test-confirm]')!);
      await flush();
      const card = container.querySelector('#st-card-catalog-refresh');
      expect(card?.className).toContain('settings-card-flash');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.instances[0]).toBe(card);
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('does not keep a canceled guarded search target for a later ordinary tab visit', async () => {
    localStorage.setItem('kiki.locale', 'en');
    const container = await renderSettings('/settings/ai?tab=defaults', { guarded: true });
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      await click(container.querySelector('[data-test-dirty]')!);
      const search = container.querySelector<HTMLInputElement>('[data-settings-search]')!;
      await setInput(search, 'catalog refresh');
      await click(search.parentElement!.querySelector('[role="option"]')!);
      expect(container.querySelector('[data-test-cancel]')).not.toBeNull();
      expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/ai?tab=defaults');
      expect(scrollIntoView).not.toHaveBeenCalled();
      await click(container.querySelector('[data-test-cancel]')!);

      // This is a new, ordinary navigation, not confirmation of the search hit.
      await click(container.querySelector('[data-ai-tab="providers"]')!);
      await click(container.querySelector('[data-test-confirm]')!);
      await flush();
      expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/ai?tab=providers');
      // An ordinary visit leaves maintenance folded and flashes nothing.
      expect(container.querySelector('[data-models-maintenance]')?.hasAttribute('open')).toBe(false);
      expect(container.querySelector('.settings-card-flash')).toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  /**
   * Locating a card is a handshake with the card, not a deadline: these cover a
   * card whose own read finishes long after the page painted, a reader who has
   * scrolled in the meantime, and the announcement the two ends rely on.
   */
  it('locates a card whose own read outlasts the old two-second wait', async () => {
    const gate = deferred<{ experimental_flags?: Record<string, boolean> }>();
    client.meta.mockReturnValueOnce(gate.promise);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const container = await renderSettings('/settings/developer#st-card-exp-developer');

    // The Experimental rows are still waiting on their own read, so the card is
    // not there — and the page does not give up on it while it waits.
    expect(container.querySelector('#st-card-exp-developer')).toBeNull();
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 2100); }); });
    expect(scrollIntoView).not.toHaveBeenCalled();

    gate.resolve({ experimental_flags: { persistence_minidb_readmodel: true } });
    await flush();
    await flush();

    const card = container.querySelector('#st-card-exp-developer');
    expect(card).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(card?.className).toContain('settings-card-flash');
    scrollIntoView.mockRestore();
  });

  it('does not pull the view once the reader has scrolled themselves', async () => {
    const gate = deferred<{ experimental_flags?: Record<string, boolean> }>();
    client.meta.mockReturnValueOnce(gate.promise);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const container = await renderSettings('/settings/developer#st-card-exp-developer');

    await act(async () => { window.dispatchEvent(new Event('wheel')); });
    gate.resolve({ experimental_flags: { persistence_minidb_readmodel: true } });
    await flush();
    await flush();

    expect(container.querySelector('#st-card-exp-developer')).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  it('drops the old hash target on a new visit to the same section', async () => {
    const gate = deferred<{ experimental_flags?: Record<string, boolean> }>();
    client.meta.mockReturnValueOnce(gate.promise);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      const container = await renderSettings('/settings/agents#st-card-exp-agents', { guarded: true });
      expect(container.querySelector('#st-card-exp-agents')).toBeNull();
      const visitKey = container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key');
      await click(container.querySelector('[data-settings-nav-leaf="agents"]')!);
      expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/agents');
      expect(container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key')).not.toBe(visitKey);
      gate.resolve({ experimental_flags: { 'agent-profile-routes': false } });
      await flush();
      await flush();
      expect(container.querySelector('#st-card-exp-agents')).not.toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('drops an unmounted target when the reader leaves for another section', async () => {
    const gate = deferred<{ experimental_flags?: Record<string, boolean> }>();
    client.meta.mockReturnValueOnce(gate.promise);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      const container = await renderSettings('/settings/agents#st-card-exp-agents');
      expect(container.querySelector('#st-card-exp-agents')).toBeNull();
      await click(container.querySelector('[data-settings-nav-leaf="general"]')!);
      gate.resolve({ experimental_flags: { 'agent-profile-routes': false } });
      await flush();
      await click(container.querySelector('[data-settings-nav-leaf="agents"]')!);
      await flush();
      expect(container.querySelector('#st-card-exp-agents')).not.toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  /**
   * The visit store keeps the reader's own position for a visit they return to.
   * A hash left over from an earlier deep link is older than that position, so a
   * card that mounts late on the return trip must not pull the pane.
   */
  it('leaves a return visit where the reader left it, not at the hash it carries', async () => {
    const visit = recordNavigation({
      location: { pathname: '/settings/developer', search: '', hash: '#st-card-exp-developer', key: 'return-visit' },
      scope: { homeId: 'main', scopeId: 'local' },
    });
    saveUiSnapshot(visit.visitId, { scrollTop: 320 });
    const gate = deferred<{ experimental_flags?: Record<string, boolean> }>();
    client.meta.mockReturnValueOnce(gate.promise);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const container = await renderSettings('/settings/developer#st-card-exp-developer');

    gate.resolve({ experimental_flags: { persistence_minidb_readmodel: true } });
    await flush();
    await flush();

    expect(container.querySelector('#st-card-exp-developer')).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockRestore();
    clearNavHistory();
  });

  /**
   * The pair to the test above: a visit the reader has not scrolled yet owns no
   * position to protect, so the hash it was opened with still locates its card.
   * The two tests differ only in that saved position.
   */
  it('still locates the hash on a visit that has no position of its own', async () => {
    const visit = recordNavigation({
      location: { pathname: '/settings/developer', search: '', hash: '#st-card-exp-developer', key: 'fresh-visit' },
      scope: { homeId: 'main', scopeId: 'local' },
    });
    expect(visit.visitId).not.toBe('');
    expect(getUiSnapshot(visit.visitId)).toBeUndefined();
    const gate = deferred<{ experimental_flags?: Record<string, boolean> }>();
    client.meta.mockReturnValueOnce(gate.promise);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const container = await renderSettings('/settings/developer#st-card-exp-developer');

    gate.resolve({ experimental_flags: { persistence_minidb_readmodel: true } });
    await flush();
    await flush();

    expect(container.querySelector('#st-card-exp-developer')).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockRestore();
    clearNavHistory();
  });

  it('announces a card on mount, and again when the page asks for one', async () => {
    const seen: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const tree = (notify: (id: string) => void) => (
      <I18nProvider>
        <SettingsCardMountContext.Provider value={notify}>
          <SectionCard id="st-card-fixture" title="Fixture" />
        </SettingsCardMountContext.Provider>
      </I18nProvider>
    );

    await act(async () => { root.render(tree((id) => { seen.push(id); })); });
    expect(seen).toEqual(['st-card-fixture']);

    // Every request carries a new asker identity, so a card that is already on
    // screen is asked again instead of being missed.
    await act(async () => { root.render(tree((id) => { seen.push(`${id}:again`); })); });
    expect(seen).toEqual(['st-card-fixture', 'st-card-fixture:again']);
  });

  it('contains a pane render error inside SettingsPaneBoundary and recovers on retry or resetKey navigation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let shouldThrow = true;
      function FragilePane() {
        if (shouldThrow) throw new Error('boom in settings pane');
        return <div data-healthy-pane>Recovered section</div>;
      }
      const container = document.createElement('div');
      document.body.append(container);
      containers.push(container);
      const root = createRoot(container);
      roots.push(root);
      const renderBoundary = (resetKey: string) => (
        <I18nProvider>
          <div data-nav-shell>Nav stays mounted</div>
          <SettingsPaneBoundary resetKey={resetKey}>
            <FragilePane />
          </SettingsPaneBoundary>
        </I18nProvider>
      );

      await act(async () => { root.render(renderBoundary('ai')); });
      expect(container.querySelector('[data-nav-shell]')).not.toBeNull();
      const alert = container.querySelector('[data-settings-pane-error]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain('boom in settings pane');
      const copy = container.querySelector<HTMLButtonElement>('[data-settings-pane-copy]')!;
      expect(copy).not.toBeNull();
      const copySpy = vi.spyOn(clipboard, 'copyTextToClipboard')
        .mockRejectedValueOnce(new Error('clipboard denied'))
        .mockResolvedValue(undefined);
      try {
        await click(copy);
        expect(copySpy).toHaveBeenCalledWith('boom in settings pane');
        expect(copy.getAttribute('data-copied')).toBeNull();
        expect(container.querySelector('[data-settings-pane-copy-error]')?.textContent).toContain('clipboard denied');
        await click(copy);
        expect(copy.getAttribute('data-copied')).toBe('true');
        expect(container.querySelector('[data-settings-pane-copy-error]')).toBeNull();
      } finally { copySpy.mockRestore(); }

      shouldThrow = false;
      await click(container.querySelector('[data-settings-pane-retry]')!);
      expect(container.querySelector('[data-settings-pane-error]')).toBeNull();
      expect(container.querySelector('[data-healthy-pane]')?.textContent).toBe('Recovered section');

      shouldThrow = true;
      await act(async () => { root.render(renderBoundary('ai')); });
      expect(container.querySelector('[data-settings-pane-error]')).not.toBeNull();

      shouldThrow = false;
      await act(async () => { root.render(renderBoundary('general')); });
      expect(container.querySelector('[data-settings-pane-error]')).toBeNull();
      expect(container.querySelector('[data-healthy-pane]')?.textContent).toBe('Recovered section');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('SettingsPage mobile drawer', () => {
  it('owns Escape while open: the drawer closes, the event is consumed before the app-level settings Escape, and focus returns to the trigger', async () => {
    const container = await renderSettings('/settings/general');
    const trigger = container.querySelector<HTMLElement>('[data-settings-nav-trigger]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    trigger.focus();

    await click(trigger);
    const drawer = document.querySelector<HTMLElement>('[data-settings-nav-drawer]');
    expect(drawer).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('settings-nav-drawer');
    // Focus moved into the drawer, onto the leaf that names the open page.
    expect(drawer!.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement | null)?.getAttribute('data-settings-nav-leaf')).toBe('general');
    expect(drawer!.querySelector('[data-settings-nav-leaf="permissions"]')).not.toBeNull();

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(escape); });
    // The app-level "Escape leaves settings" handler (App.tsx) skips exactly
    // when defaultPrevented is set — assert the contract, not App's absence.
    expect(escape.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-settings-nav-drawer]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    // Still on the same settings page: nothing navigated away.
    expect(container.querySelector('[data-settings-page-title]')).not.toBeNull();
  });

  it('returns focus to the trigger when the drawer closes through its close control', async () => {
    const container = await renderSettings('/settings/general');
    const trigger = container.querySelector<HTMLElement>('[data-settings-nav-trigger]')!;
    trigger.focus();
    await click(trigger);
    const close = document.querySelector<HTMLElement>('[data-settings-nav-drawer] button[aria-label]')!;
    await click(close);
    expect(document.querySelector('[data-settings-nav-drawer]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('SettingsPage object links survive an address hash', () => {
  it('opens the plugin a link names even when the address still carries a stale hash', async () => {
    const container = await renderSettings('/settings/plugins?plugin=kiki-notes#x');
    await flush();
    expect(container.querySelector('[data-plugin-settings-missing="kiki-notes"]')).not.toBeNull();
    expect(container.querySelector('#st-card-plugins')).toBeNull();
  });

  it('opens the plugin a link names when the hash is one of that page\'s own cards', async () => {
    const container = await renderSettings('/settings/extensions?tab=plugins&plugin=kiki-notes#st-card-plugin-notes');
    await flush();
    expect(container.querySelector('[data-plugin-settings-missing="kiki-notes"]')).not.toBeNull();
    expect(container.querySelector('#st-card-plugins')).toBeNull();
  });

  it('keeps the installed list for its own card hash, even when the query names a plugin', async () => {
    const container = await renderSettings('/settings/plugins?plugin=kiki-notes#st-card-plugins');
    await flush();
    expect(container.querySelector('#st-card-plugins')).not.toBeNull();
    expect(container.querySelector('[data-plugin-settings-missing="kiki-notes"]')).toBeNull();
  });

  it('opens the workspace a link names when the hash is one of its own cards', async () => {
    const container = await renderSettings('/settings/workspaces?workspace=ws-alpha#st-card-workspace-trust');
    await flush();
    expect(container.querySelector('[data-workspace-detail-name]')?.textContent).toBe('Alpha');
    expect(container.querySelector('#st-card-workspaces')).toBeNull();
  });

  it('keeps the catalog for the catalog card hash, even when the query names a workspace', async () => {
    const container = await renderSettings('/settings/workspaces?workspace=ws-alpha#st-card-workspaces');
    await flush();
    expect(container.querySelector('#st-card-workspaces')).not.toBeNull();
    expect(container.querySelector('[data-workspace-detail-name]')).toBeNull();
  });
});

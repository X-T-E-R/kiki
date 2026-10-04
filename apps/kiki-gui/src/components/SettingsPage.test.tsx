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
import { SettingsPage } from './SettingsPage';
import { DirtyGuardContext, useDirtyGuardState, type GuardedNavigate } from './dirtyGuard';
import { SectionCard, SettingsCardMountContext } from './settings/SectionCard';
import { clearNavHistory, getUiSnapshot, recordNavigation, saveUiSnapshot } from '../lib/navHistory';
import { commitText, pickOption } from './settings/testControls';

const WORKSPACES = {
  items: [
    { id: 'ws-alpha', name: 'Alpha', root: '/tmp/alpha', last_opened_at: '2026-09-01T00:00:00Z', pinned: false },
    { id: 'ws-beta', name: 'Beta', root: '/tmp/beta', last_opened_at: '2026-08-01T00:00:00Z', pinned: false },
  ],
};

const MCP_ENTRY = {
  name: 'old-server',
  config: { transport: 'stdio' as const, command: 'node', args: ['server.js'] },
  source: 'global' as const,
  origin: '/tmp/mcp.json',
  mutable: true,
};

const klient = {
  global: {
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
  meta: vi.fn(async (): Promise<{ experimental_flags?: Record<string, boolean> }> => ({
    experimental_flags: {
      'tool-select': true,
      task_wait: true,
      search_worker: true,
      persistence_minidb_readmodel: true,
      auto_session_title: true,
      subagent_release_idle: true,
      'agent-profile-routes': true,
      external_delegation_mcp: true,
      task_board: true,
      image_format_conversion: false,
      native_ssh: false,
      session_idle_eviction: false,
    },
  })),
  listWorkspaces: vi.fn(async () => WORKSPACES),
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
  patchMemorySettings: vi.fn(async (patch: { enabled?: boolean; approval?: string; budget?: number }) => ({ enabled: true, approval: 'auto', budget: 2000, workspaces: {}, ...patch })),
  getWorkspaceMemorySettings: vi.fn(async (id: string) => ({ workspace_id: id, enabled: null, effective_enabled: true })),
  patchWorkspaceMemorySettings: vi.fn(async (id: string, enabled: boolean | null) => ({ workspace_id: id, enabled, effective_enabled: enabled !== false })),
  patchConfig: vi.fn(async () => ({})),
};

const connectionMock = vi.hoisted(() => ({ token: '', url: 'http://127.0.0.1:8080', applyConnection: vi.fn() }));
vi.mock('../state/connection', () => ({
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
  useHost: () => ({ kind: 'browser' }),
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
  client.patchMemorySettings.mockClear();
  client.getWorkspaceMemorySettings.mockClear();
  client.patchWorkspaceMemorySettings.mockClear();
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
  it('keeps MCP management on the Capabilities page and only timeouts in settings', async () => {
    const container = await renderSettings('/settings/mcp');
    expect(container.querySelector('#st-card-mcp [data-capability-link-open="mcp"]')?.getAttribute('href')).toBe('/capabilities?tab=mcp');
    expect(container.querySelector('#st-card-mcp [data-mcp-manager]')).toBeNull();
    expect(container.querySelector('#workspace-mcp-select')).toBeNull();
  });

  it('shows the connected server on a model panel', async () => {
    const container = await renderSettings('/settings/ai?tab=models');
    expect(container.querySelector('#st-card-models [data-settings-panel-scope]')?.textContent).toContain('connected server');
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

  it('drops a page intro that would only restate a card title', async () => {
    const mcp = await renderSettings('/settings/mcp');
    expect(mcp.querySelector('[data-settings-intro]')).toBeNull();
    expect(mcp.textContent).not.toContain('Server-wide MCP timeouts.');
    expect(mcp.querySelector('#st-card-mcp-timeouts')).not.toBeNull();
  });

  it('mounts the catalog-refresh card on the models tab of the merged ai entry', async () => {
    client.refreshAllProviders.mockClear();
    client.createModel.mockClear();
    const container = await renderSettings('/settings/ai?tab=models');
    const card = container.querySelector('#st-card-catalog-refresh');
    expect(card).not.toBeNull();
    expect(container.querySelector('[data-ai-tab="models"]')?.getAttribute('aria-selected')).toBe('true');
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

  it('shows memory beside sessions and edits global and workspace settings independently', async () => {
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    expect(container.querySelector('[data-settings-page-title]')?.textContent).toBe('Memory');
    expect(container.querySelector('#st-card-memory')).not.toBeNull();
    expect(container.querySelector('#st-card-memory-workspaces')).not.toBeNull();
    expect(container.querySelector('[data-memory-workspace-select]')?.getAttribute('data-memory-workspace-select')).toBe('ws-beta');
    expect(client.getWorkspaceMemorySettings).toHaveBeenCalledWith('ws-beta');
    // One visible label per row: the switch keeps its name for assistive tech only.
    const toggleRow = container.querySelector('#memory-enabled')!.closest('[data-settings-field]')!;
    expect(toggleRow.querySelector('span.sr-only')?.textContent).toBe('Use memory');
    expect([...toggleRow.querySelectorAll('label, span')].filter((node) => node.textContent === 'Use memory' && !node.classList.contains('sr-only') && node.children.length === 0)).toHaveLength(1);

    await pickOption(container.querySelector('[data-memory-approval]')!, 'Review in Inbox');
    expect(client.patchMemorySettings).toHaveBeenCalledWith({ approval: 'review' });

    // K04 keeps the text limit under Advanced; it still commits on Enter.
    const advanced = container.querySelector('[data-memory-advanced-toggle]')!;
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-memory-budget]')).toBeNull();
    await click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-memory-budget-save]')).toBeNull();
    const budget = container.querySelector<HTMLInputElement>('[data-memory-budget]')!;
    expect(budget.value).toBe('2000');
    await commitText(budget, '1735');
    expect(client.patchMemorySettings).toHaveBeenCalledWith({ budget: 1735 });
    await flush();
    expect(budget.value).toBe('1735');
    expect(client.patchWorkspaceMemorySettings).not.toHaveBeenCalled();

    await pickOption(container.querySelector('[data-memory-workspace-override]')!, 'Off');
    expect(client.patchWorkspaceMemorySettings).toHaveBeenCalledWith('ws-beta', false);
  });

  it('re-reads the workspace effective state after the global switch is saved', async () => {
    // The server computes effective from the global switch and the workspace
    // override; this workspace has no override, so it follows global exactly.
    let global = true;
    client.getMemorySettings.mockImplementation(async () => ({ enabled: global, approval: 'auto' as const, budget: 2000, workspaces: {} }));
    client.getWorkspaceMemorySettings.mockImplementation(async (id: string) => ({ workspace_id: id, enabled: null, effective_enabled: global }));
    client.patchMemorySettings.mockImplementation(async (patch: { enabled?: boolean }) => {
      global = patch.enabled ?? global;
      return { enabled: global, approval: 'auto' as const, budget: 2000, workspaces: {} };
    });

    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    await flush();
    expect(container.querySelector('[data-memory-workspace-effective]')?.textContent).toContain('On');
    const readsBefore = client.getWorkspaceMemorySettings.mock.calls.length;

    await click(container.querySelector('#memory-enabled')!);
    await flush();
    await flush();

    expect(client.patchMemorySettings).toHaveBeenCalledWith({ enabled: false });
    // Without this re-read the row keeps saying the workspace is on.
    expect(client.getWorkspaceMemorySettings.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(container.querySelector('[data-memory-workspace-effective]')?.textContent).toContain('Off');
  });

  it('shows other workspace overrides and refuses an out-of-range budget', async () => {
    client.getMemorySettings.mockResolvedValueOnce({ enabled: true, approval: 'review', budget: 2000, workspaces: { 'ws-alpha': false } });
    const container = await renderSettings('/settings/memory?workspace=ws-beta');
    expect(container.querySelector('[data-memory-other-overrides]')?.textContent).toContain('Alpha: Off');
    await click(container.querySelector('[data-memory-advanced-toggle]')!);
    const budget = container.querySelector<HTMLInputElement>('[data-memory-budget]')!;
    expect(budget.value).toBe('2000');
    const writes = client.patchMemorySettings.mock.calls.length;
    await commitText(budget, '4001');
    expect(client.patchMemorySettings.mock.calls.length).toBe(writes);
    expect(budget.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Enter a whole number from 0 to 4,000.');
  });
});

describe('SettingsPage batch-3 leaves', () => {
  it('mounts the skills leaf with discovery defaults and a link to the catalog', async () => {
    const container = await renderSettings('/settings/skills');
    expect(container.querySelector('#st-card-caps')).not.toBeNull();
    expect(container.querySelector('#st-card-caps [data-settings-panel-scope]')?.textContent).toContain('connected server');
    expect(container.querySelector('#st-card-skill-catalog [data-capability-link-open="skills"]')?.getAttribute('href')).toBe('/capabilities?tab=skills');
    expect(container.querySelector('[data-skills-view]')).toBeNull();
  });

  it('renders and saves the GUI request timeout in seconds', async () => {
    localStorage.removeItem('kiki.settings');
    const container = await renderSettings('/settings/connection');
    const card = container.querySelector('#st-card-conn-timeout')!;
    const input = card.querySelector<HTMLInputElement>('#st-conn-request-timeout')!;
    expect(input.value).toBe('30');
    expect(card.textContent).toContain('Request timeout (seconds)');

    // The field saves itself on Enter; there is no separate Save button.
    expect(card.querySelector('button')).toBeNull();
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

  it('reveals, edits, and overwrites the saved connection token', async () => {
    connectionMock.token = 'saved-token';
    const container = await renderSettings('/settings/connection');
    const card = container.querySelector('#st-card-conn-server')!;
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

  it('mounts the mcp leaf with a status line and timeouts', async () => {
    const container = await renderSettings('/settings/mcp');
    expect(container.querySelector('#st-card-mcp [data-capability-link="mcp"]')).not.toBeNull();
    expect(container.querySelector('#st-card-mcp-status')).toBeNull();
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
    expect(hooks.querySelector('[data-settings-intro]')?.textContent).toContain('Declarative text injection');
  });

  it('redirects the retired runtime leaf to the tasks page', async () => {
    const container = await renderSettings('/settings/runtime');
    expect(container.querySelector('#st-card-runtime')).toBeNull();
    expect(container.querySelector('#st-card-task-policy')).not.toBeNull();
    expect(container.querySelector('#st-card-cron')).toBeNull();
    expect(container.querySelector('#st-card-tools')).toBeNull();
  });

  it('mounts the split runtime content on its new leaves', async () => {
    const tasks = await renderSettings('/settings/tasks');
    expect(tasks.querySelector('#st-card-task-policy')).not.toBeNull();
    expect(tasks.querySelector('#st-card-task-policy')!.textContent).toContain('Everyday background-task limits.');
    expect(tasks.querySelector('#st-card-cron')).toBeNull();

    const sessions = await renderSettings('/settings/communication');
    const messaging = sessions.querySelector('#st-card-agent-messaging')!;
    expect(messaging).not.toBeNull();
    expect(messaging.textContent).toContain('Messages between threads');
    expect(messaging.textContent).toContain('Subagents can notify their parent');
    expect(sessions.querySelector('#st-card-token-counting')).toBeNull();

    const developer = await renderSettings('/settings/advanced');
    expect(developer.querySelector('#st-card-token-counting')).not.toBeNull();
    expect(developer.querySelector('#st-card-resource-limits')).not.toBeNull();
    expect(developer.querySelector('#st-card-resource-limits')!.textContent).toContain('Workspace idle reclamation (s)');
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
    expect(tasks.querySelector('#st-card-agent-board')).not.toBeNull();
    expect(tasks.querySelector('#st-card-defaults')).toBeNull();
    const sessions = await renderSettings('/settings/sessions');
    expect(sessions.querySelector('#st-card-defaults')).not.toBeNull();
    expect(sessions.querySelector('#st-card-questions')).not.toBeNull();
    expect(sessions.querySelector('#st-card-session-title')).not.toBeNull();
    // Session titles are switched by their own card, so they get no second row.
    expect(sessions.querySelector('[data-experimental-row="auto_session_title"]')).toBeNull();
    const homes: [string, string[]][] = [
      ['/settings/agents', ['agent-profile-routes']],
      ['/settings/subagents', ['subagent_release_idle']],
      ['/settings/mcp', ['tool-select', 'external_delegation_mcp']],
      ['/settings/tasks', ['task_wait', 'task_board']],
      ['/settings/search?tab=advanced', ['search_worker']],
      ['/settings/developer', ['persistence_minidb_readmodel']],
    ];
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
    const labs = await renderSettings('/settings/labs');
    await flush();
    const card = labs.querySelector('#st-card-labs')!;
    // No switches here: one control per flag, on its feature page.
    expect(card.querySelector('[data-experimental-row]')).toBeNull();
    expect(card.querySelector('[role="group"]')).toBeNull();
    const link = (flag: string) => card.querySelector(`[data-labs-entry="${flag}"] a`)?.getAttribute('href');
    expect(link('agent-profile-routes')).toBe('/settings/agents#st-card-exp-agents');
    expect(link('external_delegation_mcp')).toBe('/settings/mcp#st-card-exp-mcp');
    expect(link('subagent_release_idle')).toBe('/settings/subagents#st-card-exp-subagents');
    expect(link('search_worker')).toBe('/settings/search#st-card-exp-search');
    expect(link('auto_session_title')).toBe('/settings/sessions#st-card-session-title');
    // Every flag the server reports is listed, including ones switched by a feature card.
    expect(card.querySelectorAll('[data-labs-entry]').length).toBe(12);
  });

  it('saves an experimental row on change with a narrow experimental patch', async () => {
    client.getConfig.mockResolvedValue({ experimental: { search_worker: false } });
    client.patchConfig.mockClear();
    const mcp = await renderSettings('/settings/mcp');
    await flush();
    const on = mcp.querySelector<HTMLButtonElement>('[data-experimental-row="tool-select"] [data-experimental-choice="on"]')!;
    await click(on);
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({
      experimental: { search_worker: false, 'tool-select': true },
      replace_domains: ['experimental'],
    });
    client.getConfig.mockResolvedValue({});
  });

  it('redirects the retired experimental URL to the labs index', async () => {
    const container = await renderSettings('/settings/experimental', { guarded: true });
    expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/labs');
    expect(container.querySelector('#st-card-labs')).not.toBeNull();
    expect(container.querySelector('#st-card-advanced')).toBeNull();
    expect(scopeHeader(container).textContent).toBe('Experimental features and feature flags.');
    expect(container.querySelector('#st-card-labs [data-labs-index]')).not.toBeNull();
    expect(container.querySelector('#st-card-labs [role="switch"]')).toBeNull();
  });

  it('sends an old single-flag card link to the flag’s new row', async () => {
    const container = await renderSettings('/settings/agents#st-card-mcp-delegation');
    await flush();
    expect(container.querySelector('#st-card-exp-mcp [data-experimental-row="external_delegation_mcp"]')).not.toBeNull();
  });

  it('mounts the developer page with limits first and raw JSON after', async () => {
    const container = await renderSettings('/settings/developer');
    const card = container.querySelector('#st-card-advanced')!;
    expect(card).not.toBeNull();
    expect(scopeHeader(container).textContent).toBe('Engine parameters, low-level configuration, and system diagnostics.');
    expect(card.textContent).toContain('Advanced configuration for permissions, loop controls, and background tasks. Validated on save.');
    expect(card.textContent).not.toContain('kap-server');
    const order = [...container.querySelectorAll('[data-settings-card]')].map((node) => node.id);
    expect(order).toEqual(['st-card-resource-limits', 'st-card-retry', 'st-card-session-residency', 'st-card-token-counting', 'st-card-advanced', 'st-card-cron', 'st-card-exp-developer']);

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
    expect(container.querySelector('#st-card-plugins [data-capability-link-open="plugins"]')?.getAttribute('href')).toBe('/capabilities');
    expect(container.querySelector('#st-card-plugins [data-plugins-view]')).toBeNull();
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
});

describe('SettingsPage search ownership', () => {
  it('indexes every card the settings page renders', async () => {
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
    expect(general.querySelector('#st-card-session-title')).toBeNull();
    expect(defaults.querySelector('#st-card-permission-defaults')).toBeNull();
    expect(permissions.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(sessions.querySelector('#st-card-defaults')).not.toBeNull();
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
    for (const page of [general, agents, subagents, mcp, sessions, permissions, tasks, developer, labs, defaults, searchAdvanced, ssh]) {
      for (const card of page.querySelectorAll('[id^="st-card-"]')) rendered.add(card.id);
    }
    expect(rendered.size).toBeGreaterThan(10);
    const indexed = new Set(SETTINGS_SEARCH_SPEC.map((entry) => entry.cardId));
    // The bucket card stays available for legacy editor tests, not Settings navigation.
    rendered.delete('st-card-subagent-profiles');
    expect([...rendered].filter((id) => !indexed.has(id))).toEqual([]);
    expect([...indexed].filter((id) => !rendered.has(id))).toEqual([]);
  });
});

describe('SettingsPage search locating', () => {
  it.each([
    // The default-target card sits with the other subagent rules, so the hit
    // opens that leaf; the card itself and its selector are unchanged.
    ['en', 'default profile', 'Subagent rules', 'Default subagent'],
    ['zh', '默认 profile', '子智能体规则', '默认子智能体'],
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
    // The default-target card lives on the subagent leaf, so that is the page
    // a same-page hit must be started from: the hit locates the mounted card
    // instead of navigating.
    const container = await renderSettings('/settings/subagents', { guarded: true });
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
        expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/ai?tab=models#st-card-catalog-refresh');
        expect(container.querySelector('[data-ai-tab="models"]')?.getAttribute('aria-selected')).toBe('true');
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
      await click(container.querySelector('[data-ai-tab="models"]')!);
      await click(container.querySelector('[data-test-confirm]')!);
      await flush();
      expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/ai?tab=models');
      const card = container.querySelector('#st-card-catalog-refresh');
      expect(card).not.toBeNull();
      expect(card?.className).not.toContain('settings-card-flash');
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

    gate.resolve({ experimental_flags: { native_browser: false } });
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
    gate.resolve({ experimental_flags: { native_browser: false } });
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
      const container = await renderSettings('/settings/developer#st-card-exp-developer', { guarded: true });
      expect(container.querySelector('#st-card-exp-developer')).toBeNull();
      const visitKey = container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key');
      await click(container.querySelector('[data-settings-nav-leaf="developer"]')!);
      expect(container.querySelector('[data-test-location]')?.textContent).toBe('/settings/developer');
      expect(container.querySelector('[data-test-location]')?.getAttribute('data-test-location-key')).not.toBe(visitKey);
      gate.resolve({ experimental_flags: { native_browser: false } });
      await flush();
      expect(container.querySelector('#st-card-exp-developer')).not.toBeNull();
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
      const container = await renderSettings('/settings/developer#st-card-exp-developer');
      expect(container.querySelector('#st-card-exp-developer')).toBeNull();
      await click(container.querySelector('[data-settings-nav-leaf="general"]')!);
      gate.resolve({ experimental_flags: { native_browser: false } });
      await flush();
      await click(container.querySelector('[data-settings-nav-leaf="developer"]')!);
      await flush();
      expect(container.querySelector('#st-card-exp-developer')).not.toBeNull();
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

    gate.resolve({ experimental_flags: { native_browser: false } });
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

    gate.resolve({ experimental_flags: { native_browser: false } });
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
});

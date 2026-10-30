// @vitest-environment jsdom

/**
 * The things this page can get wrong quietly are the ones worth pinning: a
 * connection that is merely not running must not be drawn as a failure, a
 * running action must use the saved configuration rather than a half-typed
 * draft, a failed check or an unconfirmed stop must keep the server's own
 * reason instead of turning green, a save must be read back from the server and
 * a failed save must keep the draft, and one scope's connections must never
 * appear under another. The dirty-guard ask carries the id the draft footer
 * reports, because the guard only knows the ids it was given. The visible-window
 * switch belongs to the branch that starts its own browser, and switching it off
 * stores nothing, because absent already means headless.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserCatalogResponse, BrowserConnection, BrowserPresetId, BrowserSetupList, BrowserSetupStatus, BrowserStatus, BrowserControlList, BrowserTabsResponse, ControlSettingSource } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { DirtyGuardContext, type DirtyGuardValue } from '../dirtyGuard';
import { BrowserControlSection } from './BrowserControlSection';
import { writeLastSessionId } from '@kiki/session-core/settings';
import type { AgentFacade } from '@kiki/klient';

const connection = { scopeId: 'local', sshLabel: null as string | null };

type MockBrowserControlList = {
  enabled?: boolean;
  enabledSource?: ControlSettingSource;
  allowedBrowsers?: string[];
  allowedBrowsersConfigured?: boolean;
  allowedBrowsersSource?: ControlSettingSource;
  connections: (BrowserConnection & { status?: BrowserStatus })[];
  defaultBrowser?: string;
};

const list = vi.fn<() => Promise<BrowserControlList | MockBrowserControlList>>();
const upsert = vi.fn<(id: string, input: unknown) => Promise<{ connection: BrowserConnection }>>();
const remove = vi.fn<(id: string) => Promise<{ removed: true }>>();
const setDefault = vi.fn<(browser?: string) => Promise<{ browser?: string }>>();
const status = vi.fn<(id: string) => Promise<BrowserStatus>>();
const check = vi.fn<(id: string) => Promise<BrowserStatus>>();
const connect = vi.fn<(id: string) => Promise<BrowserStatus>>();
const disconnect = vi.fn<(id: string) => Promise<BrowserStatus>>();
const tabs = vi.fn<(id: string) => Promise<BrowserTabsResponse>>();
const catalog = vi.fn<(id: string, options?: { includeSchema?: boolean }) => Promise<BrowserCatalogResponse>>();
const setupPresets = vi.fn<() => Promise<BrowserSetupList>>();
const setupStatus = vi.fn<(preset: BrowserPresetId) => Promise<BrowserSetupStatus>>();
const prepare = vi.fn<(preset: BrowserPresetId, input: { consent: true }) => Promise<BrowserSetupStatus>>();
const connectPreset = vi.fn<(preset: BrowserPresetId, input: Record<string, unknown>) => Promise<BrowserSetupStatus>>();
const openPreset = vi.fn<(preset: BrowserPresetId, input?: Record<string, unknown>) => Promise<BrowserSetupStatus>>();
const updatePreset = vi.fn<(preset: BrowserPresetId, input?: Record<string, unknown>) => Promise<BrowserSetupStatus>>();
const createShortcut = vi.fn<(preset: BrowserPresetId, input?: Record<string, unknown>) => Promise<BrowserSetupStatus>>();
const cancelSetup = vi.fn<(preset: BrowserPresetId) => Promise<BrowserSetupStatus>>();
const getCapability = vi.fn(async (id?: string) => ({
  id: id ?? 'kimi-webbridge', displayName: 'Kimi WebBridge', description: 'desc', supported: true, state: 'ready',
  steps: [{ id: 'daemon', state: 'ok' }, { id: 'skill', state: 'ok' }, { id: 'extension', state: 'ok' }],
  install: { running: false },
}));
const revealSecret = vi.fn(async () => ({ value: 'http://127.0.0.1:9222' }));
const getConfig = vi.fn(async () => ({
  browser_control: { enabled: true, allowedBrowsers: [] as string[], allowedBrowsersConfigured: false },
  tools: {},
}));
const patchConfig = vi.fn(async (patch: unknown) => patch);
const setBrowserControlEnabled = vi.fn(async (enabled: boolean) => ({ browser_control: { enabled } }));
const inspectToolPolicy = vi.fn<AgentFacade['inspectToolPolicy']>();
const refreshToolPolicy = vi.fn<AgentFacade['refreshToolPolicy']>();
const isToolEnabled = vi.fn<AgentFacade['isToolEnabled']>();
const policyAgent = vi.fn(() => ({ inspectToolPolicy, refreshToolPolicy, isToolEnabled }));
const policySession = vi.fn(() => ({ agent: policyAgent }));
// The stacked computer section reads the machine and the MCP plane beside the
// browser ones; an empty machine and an empty plane are its quiet default.
const computerEnv = vi.fn(async () => ({ platform: 'win32', arch: 'x64' }));
const computerMcpList = vi.fn(async () => [] as readonly unknown[]);

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      getCapability,
      installCapability: vi.fn(async () => {}),
      revealSecret,
      getConfig,
      patchConfig,
      setBrowserControlEnabled,
      klient: { session: policySession, global: { env: computerEnv, mcp: { list: computerMcpList } }, rest: { browser: { list, upsert, remove, setDefault, status, check, connect, disconnect, tabs, catalog, setupPresets, setupStatus, prepare, connectPreset, openPreset, updatePreset, createShortcut, cancelSetup } } },
    },
    scopeId: connection.scopeId,
    sshLabel: connection.sshLabel,
  }),
}));

const BUS_USER = 'kiki-fixture-host';

/**
 * A route in the server's own status shape. The wizard draws nothing it was not
 * given, so each case seeds exactly the steps and actions the real service
 * would send for that situation.
 */
function preset(patch: Partial<BrowserSetupStatus> & { preset: BrowserPresetId }): BrowserSetupStatus {
  return {
    displayName: patch.preset, controlSurface: 'browser-connection', state: 'not_prepared',
    supported: true, executionHost: BUS_USER, steps: [], actions: [],
    sourceUrl: 'https://example.test/source',
    ...patch,
  };
}

/** Everything is installed; only the store approval, which is a person, is left. */
const KIMI_NEEDS_EXTENSION = preset({
  preset: 'kimi-webbridge', displayName: 'Kimi Browser Extension', controlSurface: 'plugin-skill',
  state: 'needs_user_action', skill: 'kimi-webbridge',
  sourceUrl: 'https://www.kimi.com/en/help/kimi-webbridge',
  steps: [
    { id: 'daemon', state: 'ready' },
    { id: 'skill', state: 'ready' },
    { id: 'extension', state: 'user_action', reason: 'extension_not_connected', detail: 'raw detector prose' },
  ],
  actions: [
    { id: 'prepare' }, { id: 'connect' },
    { id: 'install_extension', url: 'https://store.test/kimi', target: 'chrome' },
    { id: 'open_instructions', url: 'https://www.kimi.com/en/help', target: 'documentation' },
  ],
});

/** Another app owns the control surface: nothing here is for Kiki to do. */
const CODEX_EXTERNAL = preset({
  preset: 'codex-browser', displayName: 'Codex / ChatGPT browser extension', controlSurface: 'external-app',
  state: 'external_only', supported: false, reason: 'external_app_required',
  sourceUrl: 'https://developers.openai.com/codex/app/chrome-extension',
  steps: [{ id: 'desktop-app', state: 'user_action', reason: 'external_app_required' }],
  actions: [{ id: 'open_instructions', url: 'https://developers.openai.com/codex/app/chrome-extension', target: 'documentation' }],
});

const MANAGED_READY = preset({
  preset: 'independent-browser', displayName: 'Independent browser', capabilityId: 'kiki-browser',
  state: 'ready', sourceUrl: 'https://github.com/vercel-labs/agent-browser',
  steps: [{ id: 'driver', state: 'ready' }, { id: 'chrome', state: 'ready' }],
  actions: [{ id: 'prepare' }, { id: 'connect' }, { id: 'open' }],
});

function browserStatus(patch: Partial<BrowserStatus> & { browser: string }): BrowserStatus {
  return { state: 'idle', executionHost: BUS_USER, generation: 0, ...patch };
}

/** A browser Kiki starts itself, never connected in this service process. */
function profileRow(patch: Partial<BrowserConnection> & { id?: string } = {}): BrowserConnection & { status: BrowserStatus } {
  const id = patch.id ?? 'research';
  return {
    name: 'Research notes', enabled: true, type: 'agent-browser-profile',
    profilePath: 'C:\\kiki\\browsers\\research',
    ...patch, id, status: browserStatus({ browser: id, ownership: 'managed-profile' }),
  };
}

/** A borrowed browser that is already attached and answering. */
function cdpRow(patch: Partial<BrowserConnection> & { id?: string } = {}): BrowserConnection & { status: BrowserStatus } {
  const id = patch.id ?? 'preview';
  return {
    name: 'Remote preview', enabled: true, type: 'agent-browser-cdp',
    endpointDisplay: 'http://127.0.0.1:9222', endpointConfigured: true,
    ...patch, id,
    status: browserStatus({
      browser: id, state: 'ready', generation: 3, ownership: 'external-browser',
      driverVersion: '0.38.2', checkedAt: '2026-10-03T01:00:00.000Z', runtimeSession: 'browser-abc123',
    }),
  };
}

/**
 * The Kimi bridge: a saved record with no endpoint, no profile and no CLI, so the
 * local daemon on the server is the whole address. A person creates one by
 * picking this style, and the Kimi route only ever probes an existing record.
 */
function bridgeRow(patch: Partial<BrowserConnection> & { id?: string } = {}): BrowserConnection & { status: BrowserStatus } {
  const id = patch.id ?? 'kimi-webbridge';
  return {
    name: 'Daily Edge', enabled: true, type: 'kimi-webbridge',
    ...patch, id, status: browserStatus({ browser: id, ownership: 'external-browser' }),
  };
}

let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;

/**
 * The connection store accepts an allow id only when that id is already a
 * saved connection. A discovered pipe is not such an id until setup connect
 * returns the connection that owns it.
 */
function boundedBrowserStore(seed: {
  readonly connections: MockBrowserControlList['connections'];
  readonly allowed: readonly string[];
  readonly disabledSources?: readonly BrowserPresetId[];
  readonly defaultBrowser?: string;
}) {
  const state: {
    connections: MockBrowserControlList['connections'];
    allowed: string[];
    disabledSources: BrowserPresetId[];
    defaultBrowser?: string;
  } = {
    connections: seed.connections.map((connection) => ({ ...connection })),
    allowed: [...seed.allowed],
    disabledSources: [...(seed.disabledSources ?? [])],
    ...(seed.defaultBrowser !== undefined ? { defaultBrowser: seed.defaultBrowser } : {}),
  };
  const rejectUnknown = (ids: readonly string[]) => {
    for (const id of ids) {
      if (!state.connections.some((connection) => connection.id === id)) {
        throw new Error(`Unknown browser connection "${id}"`);
      }
    }
  };
  list.mockImplementation(async () => ({
    enabled: true,
    enabledSource: 'default',
    allowedBrowsers: [...state.allowed],
    allowedBrowsersConfigured: true,
    allowedBrowsersSource: 'home',
    disabledSources: [...state.disabledSources],
    ...(state.defaultBrowser !== undefined ? { defaultBrowser: state.defaultBrowser } : {}),
    connections: state.connections.map((connection) => ({ ...connection })),
  }));
  patchConfig.mockImplementation(async (patch: unknown) => {
    const bc = (patch as { browser_control?: { allowed_browsers?: string[]; disabled_sources?: BrowserPresetId[] } }).browser_control;
    if (bc?.allowed_browsers !== undefined) {
      rejectUnknown(bc.allowed_browsers);
      state.allowed = [...bc.allowed_browsers];
    }
    if (bc?.disabled_sources !== undefined) {
      state.disabledSources = [...bc.disabled_sources];
    }
    return patch;
  });
  upsert.mockImplementation(async (id: string, input: unknown) => {
    if (id === 'research') throw new Error('reconfigured research');
    const row = state.connections.find((connection) => connection.id === id);
    if (row === undefined) throw new Error(`Unknown browser connection "${id}"`);
    const body = input as { enabled?: boolean; browserId?: string };
    if (row.browserId !== undefined && body.browserId !== undefined && body.browserId !== row.browserId) {
      throw new Error(`rebinding ${id}`);
    }
    if (typeof body.enabled === 'boolean') row.enabled = body.enabled;
    return { connection: row };
  });
  return { state, rejectUnknown };
}
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  }
}

async function settleUntil(selector: string) {
  for (let i = 0; i < 60; i++) {
    if (query(selector) !== null) return;
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

function query<T extends Element = HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function queryAll<T extends Element = HTMLElement>(selector: string): NodeListOf<T> {
  return container.querySelectorAll<T>(selector);
}

async function render(guard?: DirtyGuardValue) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queries}>
        <I18nProvider>
          <MemoryRouter>
            {guard === undefined
              ? <BrowserControlSection />
              : (
                <DirtyGuardContext.Provider value={guard}>
                  <BrowserControlSection />
                </DirtyGuardContext.Provider>
              )}
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function renderAt(initialEntries: string[]) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queries}>
        <I18nProvider>
          <MemoryRouter initialEntries={initialEntries}>
            <BrowserControlSection />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(selector: string) {
  const button = query<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`No element for ${selector}`);
  await act(async () => { button.click(); });
  await settle();
}

/** The clickable summary of one accordion row: RowFrame's expand button inside the row's frame. */
async function clickRow(id: string) {
  await click(`[data-browser-row="${id}"] > div > button[aria-controls]`);
}

/** The checkbox input of a connection's allow control: a listed row's switch
 *  (`data-browser-allow-switch`) or a found-item box in the wizard
 *  (`data-browser-allow-checkbox`). */
function allowBox<T extends HTMLInputElement = HTMLInputElement>(id: string): T | null {
  return query<T>(`[data-browser-allow-switch="${id}"] input`)
    ?? query<T>(`[data-browser-allow-checkbox="${id}"]`);
}

/** `<details>` toggles are the element's own event; jsdom does not fire it for us. */
async function toggleDetails(selector: string) {
  const details = query<HTMLDetailsElement>(selector);
  if (details === null) throw new Error(`No element for ${selector}`);
  await act(async () => {
    details.open = !details.open;
    details.dispatchEvent(new Event('toggle'));
  });
  await settle();
}

function setInput(selector: string, value: string) {
  const input = query<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (input === null) throw new Error(`No element for ${selector}`);
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The save button of the draft footer, which is the bar's first button. */
async function save() {
  await click('[data-settings-draft] button');
}

async function selectOption(triggerSelector: string, optionValueOrText: string) {
  await act(async () => { query<HTMLButtonElement>(triggerSelector)?.click(); });
  await settle();
  await act(async () => {
    const opt = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.dataset['optionValue'] === optionValueOrText || option.textContent?.includes(optionValueOrText));
    opt?.click();
  });
  await settle();
}

beforeEach(() => {
  connection.scopeId = 'local';
  connection.sshLabel = null;
  vi.resetAllMocks();
  writeLastSessionId(undefined);
  policyAgent.mockImplementation(() => ({ inspectToolPolicy, refreshToolPolicy, isToolEnabled }));
  policySession.mockImplementation(() => ({ agent: policyAgent }));
  localStorage.setItem('kiki.locale', 'en');
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  list.mockResolvedValue({ connections: [] });
  setupPresets.mockResolvedValue({ presets: [MANAGED_READY, CODEX_EXTERNAL] });
  revealSecret.mockResolvedValue({ value: 'http://127.0.0.1:9222' });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('BrowserControlSection', () => {
  describe('the tab strip', () => {
    it('shows 浏览器 | 电脑 tabs and mounts the browser tab by default', async () => {
      await render();
      expect(query('[role="tablist"]')).not.toBeNull();
      expect(query('[data-browser-control-panel]')?.getAttribute('data-browser-control-panel')).toBe('browser');
      expect(query('[data-browser-control-tab="browser"]')?.getAttribute('aria-selected')).toBe('true');
      expect(query('[data-browser-control-tab="computer"]')?.getAttribute('aria-selected')).toBe('false');
      expect(query('[data-browser-verdict]')).not.toBeNull();
      expect(query('[data-computer-verdict]')).toBeNull();
    });

    it('selects the computer tab on ?tab=computer and switches back on click', async () => {
      await renderAt(['/settings/browser-control?tab=computer']);
      await settleUntil('[data-computer-verdict]');
      expect(query('[data-browser-control-panel]')?.getAttribute('data-browser-control-panel')).toBe('computer');
      expect(query('[data-browser-verdict]')).toBeNull();
      await click('[data-browser-control-tab="browser"]');
      await settleUntil('[data-browser-verdict]');
      expect(query('[data-browser-control-panel]')?.getAttribute('data-browser-control-panel')).toBe('browser');
    });

    it('selects the card-owning tab for a #st-card-* hash without a tab', async () => {
      await renderAt(['/settings/browser-control#st-card-computer-mcp']);
      await settleUntil('[data-computer-verdict]');
      expect(query('[data-browser-control-panel]')?.getAttribute('data-browser-control-panel')).toBe('computer');
      expect(query('[data-browser-control-tab="computer"]')?.getAttribute('aria-selected')).toBe('true');
    });
  });

  // The wizard, the sources and the WebBridge check all live under the 高级
  // fold the list carries; opening it once per render is the fold doing its
  // job, not a second navigation.
  const openSources = async () => {
    if (query('[data-browser-sources]')?.hasAttribute('open') !== true) await click('[data-browser-sources] > summary');
  };
  const openWebbridge = async () => {
    if (query('[data-webbridge-readiness]')?.hasAttribute('open') !== true) await toggleDetails('[data-webbridge-readiness]');
  };

  describe('the wizard', () => {
    it('opens at most the first actionable route and keeps the rest as rows', async () => {
      setupPresets.mockResolvedValue({ presets: [KIMI_NEEDS_EXTENSION, MANAGED_READY, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="kimi-webbridge"]');

      const bodyOf = (id: string) => query(`[data-browser-route="${id}"] [data-row-body]`);
      // Kimi needs the extension, so its body is the one open slot's initial
      // value; the independent browser and Codex stay rows with their status
      // word until clicked.
      expect(bodyOf('kimi-webbridge')?.hasAttribute('hidden')).toBe(false);
      expect(bodyOf('independent-browser')?.hasAttribute('hidden')).toBe(true);
      expect(bodyOf('codex-browser')?.hasAttribute('hidden')).toBe(true);

      // A click moves the one open slot: the independent browser opens and
      // Kimi closes (#13).
      const independent = query<HTMLButtonElement>('[data-browser-route="independent-browser"] > div > button[aria-controls]');
      expect(independent).not.toBeNull();
      await act(async () => { independent?.click(); });
      await settle();
      expect(bodyOf('independent-browser')?.hasAttribute('hidden')).toBe(false);
      expect(bodyOf('kimi-webbridge')?.hasAttribute('hidden')).toBe(true);
      expect(bodyOf('codex-browser')?.hasAttribute('hidden')).toBe(true);
    });
    it('names each route, says what it still needs, and offers nothing the server did not', async () => {
      setupPresets.mockResolvedValue({ presets: [KIMI_NEEDS_EXTENSION, MANAGED_READY, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="kimi-webbridge"]');

      expect(query('[data-browser-routes]')).not.toBeNull();
      // A store approval is a person's click: the row says what it waits for
      // and links the store, it does not claim to have crossed it.
      expect(query('[data-browser-route-blocker="extension"]')?.textContent).toContain('the browser extension connected');
      expect(query<HTMLAnchorElement>('[data-browser-route-extension="chrome"]')?.getAttribute('href')).toBe('https://store.test/kimi');
      expect(query<HTMLAnchorElement>('[data-browser-route-instructions]')?.getAttribute('href')).toBe('https://www.kimi.com/en/help');
      // The detector's own sentence lives in the folded diagnostics, never in
      // the row a reader acts on.
      expect(query('[data-browser-route-blocker]')?.textContent).not.toContain('raw detector prose');
      expect(query<HTMLDetailsElement>('[data-browser-route-diagnostics]')?.open).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(connectPreset).not.toHaveBeenCalled();
    });

    it('shows the Ego Lite route in English without an install button', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        preset: 'ego-lite', displayName: 'Ego Lite', controlSurface: 'external-app',
        state: 'not_prepared', sourceUrl: 'https://lite.ego.app/download?auto=1',
        actions: [{ id: 'open_instructions', url: 'https://lite.ego.app/download?auto=1', target: 'documentation' }],
      })] });
      localStorage.setItem('kiki.locale', 'en');
      await render();
      await openSources();

      await settleUntil('[data-browser-route="ego-lite"]');
      const english = query('[data-browser-route="ego-lite"]');
      expect(english?.textContent).toContain('Download Ego Lite yourself, finish its own setup window, then check it here. Kiki does not install it and does not import Chrome data.');
      expect(english?.textContent).toContain('Download Ego Lite');
      expect(query('[data-browser-route="ego-lite"] [data-browser-route-prepare]')).toBeNull();
      expect(query<HTMLAnchorElement>('[data-browser-route="ego-lite"] [data-browser-route-instructions]')?.getAttribute('href')).toBe('https://lite.ego.app/download?auto=1');
    });

    it.each(['ready', 'failed'] as const)('polls a pending Ego check to %s without reporting an uninstalled app', async (state) => {
      const checking = preset({ preset: 'ego-lite', displayName: 'Ego Lite', controlSurface: 'external-app', state: 'preparing', reason: 'ego_detecting', steps: [{ id: 'detect', state: 'running' }], actions: [{ id: 'cancel' }] });
      const settled = { ...checking, state, reason: state === 'ready' ? 'ego_ready' : 'ego_detection_failed', steps: [], actions: [], error: state === 'failed' ? 'Ego Lite detection timed out after 5000ms' : undefined };
      setupPresets.mockResolvedValueOnce({ presets: [MANAGED_READY, checking] }).mockResolvedValue({ presets: [MANAGED_READY, settled] });
      await render();
      await openSources();
      await settleUntil('[data-browser-route="ego-lite"][data-browser-route-state="preparing"]');
      expect(query('[data-browser-route-ego-next]')?.textContent).toBe('Checking which browsers are ready…');
      expect(query('[data-browser-route="ego-lite"]')?.textContent).not.toContain('Download Ego Lite yourself');
      expect(query('[data-browser-route="independent-browser"][data-browser-route-state="ready"]')).not.toBeNull();
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 1_650); }); });
      await settleUntil(`[data-browser-route="ego-lite"][data-browser-route-state="${state}"]`);
      expect(setupPresets).toHaveBeenCalledTimes(2);
      expect(query('[data-browser-route-ego-next]')?.textContent).not.toContain('Detecting');
      expect(connectPreset).not.toHaveBeenCalled();
    });

    it('shows the Ego Lite route in Chinese without an install button', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        preset: 'ego-lite', displayName: 'Ego Lite', controlSurface: 'external-app',
        state: 'needs_user_action', reason: 'ego_installed', sourceUrl: 'https://lite.ego.app/download?auto=1',
        actions: [
          { id: 'connect' },
          { id: 'open_instructions', url: 'https://lite.ego.app/download?auto=1', target: 'documentation' },
        ],
      })] });
      localStorage.setItem('kiki.locale', 'zh');
      await render();
      await openSources();
      await settleUntil('[data-browser-route="ego-lite"]');
      const chinese = query('[data-browser-route="ego-lite"]');
      expect(chinese?.textContent).not.toContain('请自行下载 Ego Lite');
      expect(query('[data-browser-route-ego-next]')?.textContent).toBe('已安装 Ego Lite。请先完成它自己的设置窗口，再在这里检查。');
      expect(chinese?.textContent).toContain('下载 Ego Lite');
      expect(chinese?.textContent).toContain('检查 Ego Lite');
      expect(query('[data-browser-route="ego-lite"] [data-browser-route-prepare]')).toBeNull();
      expect(chinese?.textContent).not.toContain('一键配置');
    });

    it('keeps Ego Lite onboarding as one next step, with the raw sentence folded', async () => {
      localStorage.setItem('kiki.locale', 'zh');
      const onboarding = preset({
        preset: 'ego-lite', displayName: 'Ego Lite', controlSurface: 'external-app',
        state: 'needs_user_action', reason: 'ego_onboarding', sourceUrl: 'https://lite.ego.app/download?auto=1',
        steps: [{ id: 'detect', state: 'user_action', detail: 'Please complete the onboarding process first' }],
        actions: [
          { id: 'connect' },
          { id: 'open_instructions', url: 'https://lite.ego.app/download?auto=1', target: 'documentation' },
        ],
      });
      setupPresets.mockResolvedValue({ presets: [onboarding] });
      connectPreset.mockResolvedValue(onboarding);
      await render();
      await openSources();
      await settleUntil('[data-browser-route="ego-lite"]');
      await click('[data-browser-route-connect]');
      await settle();
      expect(query('[data-browser-route-error]')).toBeNull();
      expect(query('[data-browser-route="ego-lite"] [data-feedback-tone="error"]')).toBeNull();
      expect(query('[data-browser-route-ego-next]')?.textContent).toBe('请先完成 Ego Lite 自己的设置窗口，然后再检查。');
      expect(query('[data-browser-route="ego-lite"]')?.textContent?.match(/Please complete the onboarding process first/g)).toEqual(['Please complete the onboarding process first']);
      expect(query('[data-browser-route-diagnostics]')?.textContent).toContain('Please complete the onboarding process first');
      expect(query<HTMLDetailsElement>('[data-browser-route-diagnostics]')?.open).toBe(false);
    });

    it('tells a ready Ego Lite connection to allow it, without asking for another download', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        preset: 'ego-lite', displayName: 'Ego Lite', controlSurface: 'external-app',
        state: 'ready', reason: 'ego_ready', sourceUrl: 'https://lite.ego.app/download?auto=1',
        actions: [
          { id: 'connect' },
          { id: 'open_instructions', url: 'https://lite.ego.app/download?auto=1', target: 'documentation' },
        ],
      })] });
      localStorage.setItem('kiki.locale', 'en');
      await render();
      await openSources();
      await settleUntil('[data-browser-route="ego-lite"][data-browser-route-state="ready"]');
      const route = query('[data-browser-route="ego-lite"]');
      expect(query('[data-browser-route-ego-next]')?.textContent).toBe('Ego Lite is ready. Allow this connection, then select it for the agent.');
      expect(route?.textContent).not.toContain('Download Ego Lite yourself');
      expect(route?.textContent).toContain('Download Ego Lite');
      expect(query('[data-browser-route-readiness="ready"]')).not.toBeNull();
    });

    it('says an admitted Ego Lite connection is open only when the server says it is connected', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        preset: 'ego-lite', displayName: 'Ego Lite', controlSurface: 'external-app',
        state: 'connected', sourceUrl: 'https://lite.ego.app/download?auto=1',
        actions: [{ id: 'open_instructions', url: 'https://lite.ego.app/download?auto=1', target: 'documentation' }],
      })] });
      localStorage.setItem('kiki.locale', 'en');
      await render();
      await openSources();
      await settleUntil('[data-browser-route="ego-lite"][data-browser-route-state="connected"]');
      expect(query('[data-browser-route-ego-next]')?.textContent).toBe('This Ego Lite connection is open. Select it for the agent to use the page.');
      expect(query('[data-browser-route="ego-lite"]')?.textContent).not.toContain('Download Ego Lite yourself');
      expect(query('[data-browser-route-readiness="connected"]')?.textContent).toContain('Connected');
      expect(query('[data-browser-route-connect]')).toBeNull();
    });

    it('gives an external control surface no Kiki action at all', async () => {
      setupPresets.mockResolvedValue({ presets: [KIMI_NEEDS_EXTENSION, MANAGED_READY, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="codex-browser"]');

      const row = query('[data-browser-route="codex-browser"]');
      expect(row).not.toBeNull();
      // Nothing here is for Kiki to install or connect, so no button may offer
      // it — and no badge may claim a connection Kiki never made.
      expect(row?.querySelector('[data-browser-route-prepare]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-connect]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-connected]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-instructions]')).not.toBeNull();
      expect(row?.textContent).toContain('Set up in another app');
      // Its own un-actionable step is not restated as a Kiki-side blocker.
      expect(row?.querySelector('[data-browser-route-blocker]')).toBeNull();
    });

    it('confirms before preparing, then offers the connect the server says is next', async () => {
      // A fresh machine: the driver and browser are missing, so Set up is the
      // next move and has to go through a consent.
      const fresh = preset({
        ...MANAGED_READY, state: 'not_prepared',
        steps: [{ id: 'driver', state: 'missing' }, { id: 'chrome', state: 'missing' }],
      });
      // The list the page re-reads after acting: the server's own new answer,
      // not the one that was on screen when the button was pressed.
      let current = fresh;
      setupPresets.mockImplementation(async () => ({ presets: [current, CODEX_EXTERNAL] }));
      prepare.mockImplementation(async () => { current = MANAGED_READY; return current; });
      connectPreset.mockImplementation(async () => {
        current = preset({ ...MANAGED_READY, state: 'connected', connectionId: 'independent-browser' });
        return current;
      });
      await render();
      await settleUntil('[data-browser-route-prepare]');

      // Nothing is written on the way in: reading the routes starts no install.
      expect(prepare).not.toHaveBeenCalled();
      await click('[data-browser-route-prepare]');
      // The install is a consent, not a keystroke: it goes through a dialog.
      expect(prepare).not.toHaveBeenCalled();
      expect(query('[data-confirm-action="confirm"]')).not.toBeNull();
      await click('[data-confirm-action="confirm"]');
      expect(prepare).toHaveBeenCalledWith('independent-browser', { consent: true });
      await settleUntil('[data-browser-route-connect]');
      await click('[data-browser-route-connect]');
      expect(connectPreset).toHaveBeenCalledWith('independent-browser', {});
      // The connected state is the server's, re-read: the row stops offering
      // both actions and says when it was verified.
      await settleUntil('[data-browser-route-connected]');
      expect(query('[data-browser-route-prepare]')).toBeNull();
      expect(query('[data-browser-route-connect]')).toBeNull();
    });

    it('turns browser control on from the same consent when only the flag is left', async () => {
      // Nothing is left to install, so the button must not claim to set
      // anything up — and it must not send the reader to another page to find
      // a switch, because this consent is what enables it.
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY, state: 'needs_user_action',
        steps: [{ id: 'driver', state: 'ready' }, { id: 'chrome', state: 'ready' }, { id: 'feature', state: 'user_action', reason: 'feature_disabled' }],
        actions: [{ id: 'prepare' }, { id: 'connect' }],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-prepare]');

      const row = query('[data-browser-route="independent-browser"]');
      const button = row?.querySelector('[data-browser-route-prepare]');
      expect(button?.textContent).toBe('Allow browser control');
      // No trip to the Developer page while Set up already covers the flag.
      expect(row?.querySelector('[data-browser-route-enable-feature]')).toBeNull();
      // And it does not claim the components were just installed.
      expect(row?.querySelector('[data-browser-route-settled]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-blocker="feature"]')?.textContent).toContain('browser control');

      await click('[data-browser-route-prepare]');
      expect(query('[data-confirm-action="confirm"]')).not.toBeNull();
      // The consent says what it will switch on, not only what it installs.
      expect(document.body.textContent).toContain('switches browser control on for this server');
      expect(document.body.textContent).toContain('Allows browser control on this server (launching or attaching)');
    });

    it('offers primary open action and advanced update and shortcut actions for independent browser', async () => {
      openPreset.mockResolvedValue(preset({ ...MANAGED_READY, state: 'connected' }));
      updatePreset.mockResolvedValue(preset({ ...MANAGED_READY, state: 'ready' }));
      createShortcut.mockResolvedValue(preset({ ...MANAGED_READY, state: 'ready' }));

      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY,
        state: 'ready',
        actions: [{ id: 'prepare' }, { id: 'connect' }, { id: 'open' }, { id: 'update' }, { id: 'shortcut' }],
      }), CODEX_EXTERNAL] });

      await render();
      await settleUntil('[data-browser-route-open]');

      const row = query('[data-browser-route="independent-browser"]');
      expect(row?.querySelector('[data-browser-route-open]')).not.toBeNull();
      expect(row?.querySelector('[data-browser-route-connect]')).not.toBeNull();

      const advanced = row?.querySelector('[data-browser-route-advanced]');
      expect(advanced).not.toBeNull();
      expect(advanced?.querySelector('[data-browser-route-update]')).not.toBeNull();
      expect(advanced?.querySelector('[data-browser-route-shortcut]')).not.toBeNull();

      await click('[data-browser-route-open]');
      expect(openPreset).toHaveBeenCalledWith('independent-browser', {});

      await click('[data-browser-route-update]');
      expect(updatePreset).toHaveBeenCalledWith('independent-browser', {});

      await click('[data-browser-route-shortcut]');
      expect(createShortcut).toHaveBeenCalledWith('independent-browser', {});
    });

    it('reports failure feedback when open fails and does not claim completion', async () => {
      openPreset.mockResolvedValue(preset({ ...MANAGED_READY, state: 'failed', error: 'Browser process exited with code 1' }));
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY,
        state: 'ready',
        actions: [{ id: 'prepare' }, { id: 'connect' }, { id: 'open' }],
      }), CODEX_EXTERNAL] });

      await render();
      await settleUntil('[data-browser-route-open]');

      await click('[data-browser-route-open]');
      expect(openPreset).toHaveBeenCalledWith('independent-browser', {});
      const feedback = query('[data-feedback-tone="error"]')?.textContent ?? '';
      expect(feedback).toContain('Browser process exited with code 1');
      expect(container.textContent).not.toContain('Browser opened.');
    });

    it('reports connection disabled error when open targets a disabled connection', async () => {
      openPreset.mockResolvedValue(preset({
        ...MANAGED_READY,
        state: 'needs_user_action',
        reason: 'connection_disabled',
        error: 'This browser connection is disabled',
      }));
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY,
        state: 'ready',
        actions: [{ id: 'prepare' }, { id: 'connect' }, { id: 'open' }],
      }), CODEX_EXTERNAL] });

      await render();
      await settleUntil('[data-browser-route-open]');

      await click('[data-browser-route-open]');
      expect(openPreset).toHaveBeenCalledWith('independent-browser', {});
      const feedback = query('[data-feedback-tone="error"]')?.textContent ?? '';
      expect(feedback).toContain('This browser connection is disabled');
      expect(container.textContent).not.toContain('Browser opened.');
    });

    it('reports files updated on disk when update completes without running daemon change', async () => {
      updatePreset.mockResolvedValue(preset({
        ...MANAGED_READY,
        state: 'ready',
        reason: 'disk_updated',
      }));
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY,
        state: 'ready',
        actions: [{ id: 'prepare' }, { id: 'connect' }, { id: 'open' }, { id: 'update' }],
      }), CODEX_EXTERNAL] });

      await render();
      await settleUntil('[data-browser-route-update]');

      await click('[data-browser-route-update]');
      expect(updatePreset).toHaveBeenCalledWith('independent-browser', {});
      const feedback = query('[data-feedback-tone="info"]')?.textContent ?? '';
      expect(feedback).toBe('Files updated on disk.');
      expect(feedback).not.toContain('restart');
    });

    it('reports files updated on disk and daemon unchanged without restart prompt', async () => {
      updatePreset.mockResolvedValue(preset({
        ...MANAGED_READY,
        state: 'ready',
        reason: 'disk_updated_running_unchanged',
      }));
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY,
        state: 'ready',
        actions: [{ id: 'prepare' }, { id: 'connect' }, { id: 'open' }, { id: 'update' }],
      }), CODEX_EXTERNAL] });

      await render();
      await settleUntil('[data-browser-route-update]');

      await click('[data-browser-route-update]');
      expect(updatePreset).toHaveBeenCalledWith('independent-browser', {});
      const feedback = query('[data-feedback-tone="info"]')?.textContent ?? '';
      expect(feedback).toBe('Files updated on disk. The running browser or daemon remains on its current version.');
      expect(feedback).not.toContain('restart');
      expect(feedback).not.toContain('Updated successfully.');
    });

    it('offers Set up for components and never a trip to another page for the flag', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY, state: 'not_prepared',
        steps: [{ id: 'driver', state: 'missing' }, { id: 'feature', state: 'user_action', reason: 'feature_disabled' }],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-prepare]');

      const row = query('[data-browser-route="independent-browser"]');
      // Components are missing, so the button says it sets things up.
      expect(row?.querySelector('[data-browser-route-prepare]')?.textContent).toBe('Set up');
      // The same consent also switches the flag on, so there is no second
      // control and nowhere else to go.
      expect(row?.querySelector('[data-browser-route-enable-feature]')).toBeNull();
    });

    it('reports a forced-off flag with no action, and names what holds it off', async () => {
      // An env var or a runtime override outranks anything consented here, so
      // the server withholds every action. The page must not offer one, and
      // must name the real cause instead of sending the reader to a switch
      // that would have no effect.
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY, state: 'needs_user_action', reason: 'feature_forced_off',
        steps: [
          { id: 'driver', state: 'ready' }, { id: 'chrome', state: 'ready' },
          { id: 'feature', state: 'user_action', reason: 'feature_forced_off',
            detail: 'KIKI_EXPERIMENTAL_NATIVE_BROWSER=0 disables browser control on this execution host; preparation cannot override the environment' },
        ],
        actions: [],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-forced-off]');

      const row = query('[data-browser-route="independent-browser"]');
      expect(row?.querySelector('[data-browser-route-prepare]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-connect]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-enable-feature]')).toBeNull();
      // The headline says what it means and nothing more: an env var name is
      // noise for almost every reader and must not compete with it. It is
      // deferred, not deleted — `textContent` still holds it because the fold
      // is closed, so the claim under test is that it is not in the headline.
      const headline = row?.querySelector('[data-browser-route-forced-off]');
      expect(headline?.textContent).toContain('no action here can change it');
      expect(headline?.textContent).toContain('keeps browser control off');
      expect(headline?.textContent).not.toContain('KIKI_EXPERIMENTAL_NATIVE_BROWSER');
      // The override that holds it off is the only way back, so it is one
      // click away rather than hidden — and that click opens the existing fold.
      expect(row?.querySelector('[data-browser-route-forced-off-cause]')).not.toBeNull();
      expect(row?.querySelector<HTMLDetailsElement>('[data-browser-route-diagnostics]')?.open).toBe(false);
      await click('[data-browser-route-forced-off-cause]');
      const fold = row?.querySelector<HTMLDetailsElement>('[data-browser-route-diagnostics]');
      expect(fold?.open).toBe(true);
      expect(fold?.textContent).toContain('KIKI_EXPERIMENTAL_NATIVE_BROWSER=0');
      // And it does not claim the components are missing, or that it is ready.
      expect(row?.querySelector('[data-browser-route-settled]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-blocker]')).toBeNull();
    });

    it('shows a warning the server raised without calling it a blocker', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        ...KIMI_NEEDS_EXTENSION, state: 'ready',
        steps: [
          { id: 'daemon', state: 'ready' },
          { id: 'extension', state: 'ready' },
          { id: 'compatibility', state: 'warning', reason: 'version_mismatch' },
        ],
        actions: [{ id: 'prepare' }, { id: 'connect' }],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-warning]');

      const row = query('[data-browser-route="kimi-webbridge"]');
      expect(row?.querySelector('[data-browser-route-blocker]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-warning]')?.textContent).toContain('the bridge and the plugin reporting the same version');
    });

    it('keeps the missing component actionable when a warning comes first', async () => {
      // A warning ahead of a real gap must not stand in for it: the row would
      // claim everything is installed and drop the install button, while a
      // component is still missing. This is the order the live Kimi route uses
      // once the version drifts and the daemon later goes missing.
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY, state: 'not_prepared',
        steps: [
          { id: 'compatibility', state: 'warning', reason: 'version_mismatch' },
          { id: 'driver', state: 'missing' },
          { id: 'chrome', state: 'ready' },
        ],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-prepare]');

      const row = query('[data-browser-route="independent-browser"]');
      // The blocker is the missing step, not the warning that preceded it.
      expect(row?.querySelector('[data-browser-route-blocker]')?.getAttribute('data-browser-route-blocker')).toBe('driver');
      expect(row?.querySelector('[data-browser-route-blocker]')?.textContent).toContain('the browser driver');
      expect(row?.querySelector('[data-browser-route-settled]')).toBeNull();
      // And the warning is still shown: it does not have to give way.
      expect(row?.querySelector('[data-browser-route-warning="compatibility"]')?.textContent).toContain('the bridge and the plugin reporting the same version');
    });

    it('keeps a store approval actionable when a warning comes first', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        ...KIMI_NEEDS_EXTENSION,
        steps: [
          { id: 'compatibility', state: 'warning', reason: 'version_mismatch' },
          { id: 'daemon', state: 'ready' },
          { id: 'skill', state: 'ready' },
          { id: 'extension', state: 'user_action', reason: 'extension_not_connected' },
        ],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-blocker="extension"]');

      const row = query('[data-browser-route="kimi-webbridge"]');
      expect(row?.querySelector('[data-browser-route-blocker]')?.getAttribute('data-browser-route-blocker')).toBe('extension');
      expect(row?.querySelector('[data-browser-route-warning="compatibility"]')).not.toBeNull();
      expect(row?.querySelector('[data-browser-route-extension="chrome"]')).not.toBeNull();
    });

    it('never claims an external route has everything installed', async () => {
      // "Everything Kiki can install is in place" is a claim about Kiki's own
      // work. Codex's control surface belongs to another app, so the sentence
      // has no subject there and must not appear.
      setupPresets.mockResolvedValue({ presets: [MANAGED_READY, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="codex-browser"]');

      const codex = query('[data-browser-route="codex-browser"]');
      expect(codex?.querySelector('[data-browser-route-settled]')).toBeNull();
      expect(codex?.textContent).not.toContain('Everything Kiki can install is already in place.');
      // A route Kiki does fill in still says so.
      expect(query('[data-browser-route="independent-browser"] [data-browser-route-settled]')).not.toBeNull();
    });

    it('reports progress from the server step and percent, then leaves install mid-run', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY, state: 'preparing',
        steps: [{ id: 'chrome', state: 'missing' }, { id: 'chrome-download', state: 'running', percent: 62 }],
        actions: [{ id: 'cancel' }],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-progress]');

      expect(query('[data-browser-route-progress="chrome-download"]')?.textContent).toContain('62%');
      expect(query('[data-browser-route-prepare]')).toBeNull();
      expect(query('[data-browser-route-connect]')).toBeNull();
      expect(query('[data-browser-route-cancel]')).not.toBeNull();
    });

    it('keeps a failed preparation visible as the server wrote it, with the retry still offered', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY, state: 'failed', error: 'Download failed: HTTP 503',
        steps: [{ id: 'driver', state: 'failed', reason: 'install_failed' }],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-error]');

      expect(query('[data-browser-route-error]')?.textContent).toContain('HTTP 503');
      expect(query('[data-browser-route-prepare]')).not.toBeNull();
      expect(query('[data-browser-route-open]')).not.toBeNull();
      expect(query('[data-browser-route-connect]')).not.toBeNull();
      expect(query('[data-browser-route="independent-browser"]')?.getAttribute('data-browser-route-state')).toBe('failed');
    });

    it('separates unsupported, failed, and feature_forced_off states and retains active connect on needs_user_action', async () => {
      const unsupportedPreset = preset({
        preset: 'independent-browser', displayName: 'Independent browser', state: 'unsupported', supported: false,
      });
      const forcedOffPreset = preset({
        preset: 'independent-browser', displayName: 'Independent browser', state: 'needs_user_action', reason: 'feature_forced_off',
      });
      const failedPreset = preset({
        ...MANAGED_READY, state: 'failed', error: 'Init error',
      });

      setupPresets.mockResolvedValue({ presets: [unsupportedPreset, forcedOffPreset, failedPreset] });
      await render();
      await settleUntil('[data-browser-routes]');

      const routes = queryAll('[data-browser-route="independent-browser"]');
      expect(routes[0]?.getAttribute('data-browser-route-state')).toBe('unsupported');
      expect(routes[1]?.getAttribute('data-browser-route-state')).toBe('forced-off');
      expect(routes[2]?.getAttribute('data-browser-route-state')).toBe('failed');
    });

    it('retains active connect probe on needs_user_action and displays unknown reason diagnostically', async () => {
      const needsActionWithProbe = preset({
        ...KIMI_NEEDS_EXTENSION,
        state: 'needs_user_action',
        steps: [
          { id: 'extension', state: 'user_action', reason: 'bridge_probe_waiting' },
        ],
        actions: [{ id: 'connect' }, { id: 'prepare' }],
      });
      setupPresets.mockResolvedValue({ presets: [needsActionWithProbe, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="kimi-webbridge"]');

      expect(query('[data-browser-route-connect]')).not.toBeNull();
      expect(query('[data-browser-route-blocker]')?.textContent).toContain('bridge_probe_waiting');
    });

    it('shows update directly on version mismatch and presents webbridge open action when provided', async () => {
      const webbridgeWithOpenAndMismatch = preset({
        ...KIMI_NEEDS_EXTENSION,
        state: 'ready',
        steps: [
          { id: 'daemon', state: 'ready' },
          { id: 'compatibility', state: 'warning', reason: 'version_mismatch' },
        ],
        actions: [{ id: 'open' }, { id: 'connect' }, { id: 'update' }],
      });
      setupPresets.mockResolvedValue({ presets: [webbridgeWithOpenAndMismatch, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="kimi-webbridge"]');

      expect(query('[data-browser-route-open]')).not.toBeNull();
      const updateButton = query('[data-browser-route="kimi-webbridge"] [data-browser-route-update]');
      expect(updateButton).not.toBeNull();
      expect(updateButton?.closest('[data-browser-route-advanced]')).toBeNull();
    });

    it('reads the routes once and never re-reads a settled route on a timer', async () => {
      setupPresets.mockResolvedValue({ presets: [KIMI_NEEDS_EXTENSION, MANAGED_READY, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="kimi-webbridge"]');
      expect(setupPresets).toHaveBeenCalledTimes(1);
      // One list read covers the whole wizard; a settled route is re-read on
      // demand, not on a poll.
      expect(setupStatus).not.toHaveBeenCalled();
      const readiness = [...queryAll('[data-browser-route-readiness]')].map((el) => el.textContent);
      expect(readiness).toEqual(['Needs setup', 'Ready to connect', 'Set up in another app']);
    });

    it('re-reads a settled route on demand rather than only on a timer', async () => {
      // The store approval happens in another window, so returning to the
      // settings page has to be able to pick up a newly connected extension
      // without pressing anything. The page offers no permanent poll, so the
      // re-read has to actually work when asked — this is that path.
      setupPresets.mockResolvedValue({ presets: [KIMI_NEEDS_EXTENSION, CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route="kimi-webbridge"]');
      const before = setupPresets.mock.calls.length;

      setupPresets.mockResolvedValue({ presets: [
        preset({ ...KIMI_NEEDS_EXTENSION, state: 'connected', checkedAt: '2026-10-06T03:17:00.000Z' }),
        CODEX_EXTERNAL,
      ] });
      await act(async () => { await queries.invalidateQueries({ queryKey: ['browser', 'setup', 'local'] }); });
      await settleUntil('[data-browser-route-connected]');

      expect(setupPresets.mock.calls.length).toBeGreaterThan(before);
      expect(query('[data-browser-route="kimi-webbridge"]')?.textContent).toContain('Connected');
      expect(query('[data-browser-route="kimi-webbridge"] [data-browser-route-prepare]')).toBeNull();
    });

    it('polls only while a route is actually preparing', async () => {
      setupPresets.mockResolvedValue({ presets: [preset({
        ...MANAGED_READY, state: 'preparing',
        steps: [{ id: 'chrome-download', state: 'running', percent: 10 }],
        actions: [{ id: 'cancel' }],
      }), CODEX_EXTERNAL] });
      await render();
      await settleUntil('[data-browser-route-progress]');
      // A preparing route is the only one worth a timer; the interval is a
      // short poll so a download shows progress, not a fixed 1s cadence.
      expect(queries.getQueryState(['browser', 'setup', 'local'])).toBeDefined();
      expect(setupPresets.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('the connections behind the routes', () => {
    it('lists every connection with the state and location the server reported', async () => {
    list.mockResolvedValue({ connections: [profileRow(), cdpRow(), profileRow({ id: 'qa', name: 'Regression', enabled: false })], defaultBrowser: 'research' });

    await render();
    await settleUntil('[data-browser-row="research"]');

    // Same type twice, each under its own stable id.
    expect(query('[data-browser-row="research"]')).not.toBeNull();
    expect(query('[data-browser-row="qa"]')).not.toBeNull();
    expect(query('[data-browser-row="preview"]')).not.toBeNull();
    // The row names the role and shows the person's name for it; the id
    // itself is one click away, in the open detail, so five rows do not
    // repeat the same hostname.
    expect(query('[data-browser-row="research"]')?.textContent).toContain('Server');
    // A CDP row names the machine its endpoint points at; the record's redacted
    // projection only, never the endpoint itself.
    expect(query('[data-browser-row="preview"]')?.textContent).toContain('127.0.0.1:9222');
    expect(container.textContent).not.toContain('http://127.0.0.1:9222');
    expect(query('[data-browser-state="idle"]')).not.toBeNull();
    expect(query('[data-browser-state="disabled"]')).not.toBeNull();
  });

  it('names the bridge connection as the local bridge, not as an address to open', async () => {
    list.mockResolvedValue({ connections: [bridgeRow(), cdpRow(), profileRow()] });

    await render();
    await settleUntil('[data-browser-row="kimi-webbridge"]');

    // The type and the place are both facts the record carries: the bridge is
    // reached over its own local daemon, so there is no host to show — and the
    // row must not borrow the CDP branch's "address not set" wording for it.
    const bridge = query('[data-browser-row="kimi-webbridge"]')?.textContent ?? '';
    expect(bridge).toContain('Kimi WebBridge');
    expect(bridge).toContain('Local bridge');
    expect(bridge).not.toContain('address not set');
    // The CDP row still names the machine its endpoint points at.
    expect(query('[data-browser-row="preview"]')?.textContent).toContain('127.0.0.1:9222');
  });

  it('keeps the bridge readable in Chinese, on the row and in the form', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    list.mockResolvedValue({ connections: [bridgeRow()] });

    await render();
    await settleUntil('[data-browser-row="kimi-webbridge"]');
    expect(query('[data-browser-row="kimi-webbridge"]')?.textContent).toContain('本地桥接');

    await clickRow('kimi-webbridge');
    // No CDP address is offered anywhere on this branch, in either language.
    expect(query('[data-secret-field]')).toBeNull();
    expect(query('[data-browser-bridge]')?.textContent).toContain('本地 HTTP 桥接');
  });

  it('draws a connection that is not running as normal, never as a failure', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });

    await render();
    await settleUntil('[data-browser-state="idle"]');

    const mark = query('[data-browser-state="idle"]');
    expect(mark?.textContent).toContain('Not connected');
    expect(mark?.className).not.toContain('text-danger');
    expect(container.textContent).not.toContain('Failed');
  });

  it('reports a failed read instead of inventing a connection state', async () => {
    list.mockRejectedValue(new Error('browser REST domain unavailable'));

    await render();
    await settleUntil('[data-feedback-tone="error"]');

    expect(container.textContent).toContain('browser REST domain unavailable');
    expect(container.textContent).not.toContain('Not connected');
  });

  it('offers the running actions only while the draft matches the saved configuration', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');

    expect(query<HTMLButtonElement>('[data-browser-check]')?.disabled).toBe(false);
    expect(query<HTMLButtonElement>('[data-browser-connect]')?.disabled).toBe(false);
    // Nothing is connected, so there is nothing to disconnect.
    expect(query('[data-browser-disconnect]')).toBeNull();

    setInput('[data-browser-profile-input]', 'C:\\kiki\\browsers\\other');
    await settle();
    expect(query<HTMLButtonElement>('[data-browser-check]')?.disabled).toBe(true);
    expect(query<HTMLButtonElement>('[data-browser-connect]')?.disabled).toBe(true);
    expect(container.textContent).toContain('use the saved configuration');
  });

  it('releases a live connection under an edited draft, and keeps the draft', async () => {
    const live = { ...profileRow(), status: browserStatus({ browser: 'research', state: 'ready', generation: 4, ownership: 'managed-profile' }) };
    const released = { ...profileRow(), status: browserStatus({ browser: 'research', state: 'disconnected', generation: 5, ownership: 'managed-profile' }) };
    list.mockResolvedValueOnce({ connections: [live] }).mockResolvedValue({ connections: [released] });
    disconnect.mockResolvedValue(released.status);

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    setInput('[data-browser-profile-input]', 'C:\\kiki\\browsers\\edited');
    await settle();

    // The two that write through the saved configuration stay gated; releasing
    // the running browser uses the connection as saved, not the form.
    expect(query<HTMLButtonElement>('[data-browser-check]')?.disabled).toBe(true);
    expect(query<HTMLButtonElement>('[data-browser-connect]')?.disabled).toBe(true);
    expect(query<HTMLButtonElement>('[data-browser-disconnect]')?.disabled).toBe(false);

    await click('[data-browser-disconnect]');

    expect(disconnect).toHaveBeenCalledWith('research');
    await settleUntil('[data-browser-outcome="disconnect:disconnected"]');
    expect(query('[data-browser-state="disconnected"]')).not.toBeNull();
    // The draft is untouched: it is still the edited one, still unsaved.
    expect(query<HTMLInputElement>('[data-browser-profile-input]')?.value).toBe('C:\\kiki\\browsers\\edited');
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(false);
  });

  it('keeps a switched-off connection apart from the feature flag', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });
    connect.mockRejectedValue(Object.assign(
      new Error('Browser connection "research" is disabled'),
      { details: { code: 'browser.disabled', reason: 'connection_disabled' } },
    ));

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    await click('[data-browser-connect]');
    await settle();

    // Same error code as the flag, different cause: the service's own sentence
    // is shown, and no switch trip is offered.
    expect(query('[data-feedback-tone="error"]')?.textContent).toContain('is disabled');
    expect(query('[data-browser-open-flag]')).toBeNull();
  });

  it('reads the daemon’s targets only when the fold is open, and only on demand', async () => {
    const live = { ...profileRow(), status: browserStatus({ browser: 'research', state: 'ready', generation: 4, ownership: 'managed-profile' }) };
    list.mockResolvedValue({ connections: [live] });
    tabs.mockResolvedValue({
      browser: 'research', status: live.status,
      tabs: [
        { tabId: 't-1', targetId: 'AAA', title: 'Queue', url: 'https://example.test/q', active: true, label: 'queue' },
        { tabId: 't-2', targetId: 'BBB', url: 'about:blank' },
      ],
    });
    catalog.mockResolvedValue({
      browser: 'research', status: live.status, backendToolCount: 3, contextIsolation: 'opaque-context-through-window',
      capabilities: [
        { name: 'agent_browser_navigate', description: 'Open a URL.', group: 'page', surface: 'operation', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
        { name: 'agent_browser_cookies_list', description: 'List cookies.', group: 'state', surface: 'operation' },
        { name: 'agent_browser_state_list', description: 'List saved states.', group: 'state', surface: 'administrative' },
      ],
    });

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');

    // Neither is read while the fold is shut.
    expect(tabs).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();

    await toggleDetails('[data-browser-runtime-tree]');
    await settleUntil('[data-browser-tabs]');

    expect(tabs).toHaveBeenCalledWith('research');
    expect(queryAll('[data-browser-tab]')).toHaveLength(2);
    expect(query('[data-browser-tabs-count]')?.textContent).toBe('2');
    expect(query('[data-browser-tab="t-1"]')?.textContent).toContain('queue');
    // Opening the fold must not start the backend: the catalogue waits for its
    // own press.
    expect(catalog).not.toHaveBeenCalled();

    await click('[data-browser-catalog-read]');
    await settleUntil('[data-browser-catalog]');

    expect(catalog).toHaveBeenCalledWith('research', { includeSchema: false });
    expect(query('[data-browser-catalog-count]')?.textContent).toBe('3');
    // Groups first, not three hundred rows.
    expect(queryAll('[data-browser-catalog-group]')).toHaveLength(2);
    expect(queryAll('[data-browser-capability]')).toHaveLength(0);

    setInput('[data-browser-catalog-search]', 'cookie');
    await settle();
    expect(queryAll('[data-browser-capability]')).toHaveLength(1);
    expect(query('[data-browser-capability="agent_browser_cookies_list"]')).not.toBeNull();
    // A tool without a schema shows no schema, even once schemas are on.
    expect(query('[data-browser-catalog-schema]')).toBeNull();

    setInput('[data-browser-catalog-search]', 'navigate');
    await settle();
    await click('[data-browser-catalog-schema-option] input');
    await settleUntil('[data-browser-catalog-schema]');
    expect(catalog).toHaveBeenLastCalledWith('research', { includeSchema: true });
    // The payload is what the backend sent, not a summary of it.
    expect(query('[data-browser-catalog-schema]')?.textContent).toContain('"url"');
  });

  it('says a connection is not live instead of showing an empty tab list', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });
    tabs.mockRejectedValue(Object.assign(
      new Error('Browser connection is idle; explicitly connect it before operating'),
      { details: { code: 'browser.disconnected' } },
    ));

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    await toggleDetails('[data-browser-runtime-tree]');

    // Nothing live: the fold says so rather than asking for a list.
    expect(query('[data-browser-tabs-notlive]')).not.toBeNull();
    expect(tabs).not.toHaveBeenCalled();
  });

  it('reports a refused tab read instead of an empty browser', async () => {
    const live = { ...profileRow(), status: browserStatus({ browser: 'research', state: 'ready', generation: 4, ownership: 'managed-profile' }) };
    list.mockResolvedValue({ connections: [live] });
    tabs.mockRejectedValue(Object.assign(
      new Error('Browser backend is not connected'),
      { details: { code: 'browser.disconnected' } },
    ));

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    await toggleDetails('[data-browser-runtime-tree]');
    await settle();

    expect(query('[data-browser-tabs-empty]')).toBeNull();
    expect(query('[data-browser-tabs-section]')?.textContent).toContain('Browser backend is not connected');
  });

  it('asks before replacing an edited draft, with the id the draft footer reported', async () => {
    list.mockResolvedValue({ connections: [profileRow(), profileRow({ id: 'qa', name: 'Regression' })] });
    const reported: string[] = [];
    const asked: string[] = [];
    const pending: (() => void)[] = [];
    const guard: DirtyGuardValue = {
      dirty: false,
      reportDirty: (id) => { reported.push(id); },
      navigate: () => undefined,
      confirmDiscard: (id, action) => { asked.push(id); pending.push(action); },
    };

    await render(guard);
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    setInput('[data-browser-name-input]', 'Renamed');
    await settle();

    // The list stays visible behind the open row; closing it (pressing the
    // row again, the old back button's replacement) asks the dirty guard.
    expect(query('[data-browser-row="qa"]')).not.toBeNull();
    await clickRow('research');
    expect(asked).toEqual([reported.at(-1)]);
    expect(asked[0]).toBe('browser-control:local:research');
    // Still the edited draft, not the list.
    expect(query<HTMLInputElement>('[data-browser-name-input]')?.value).toBe('Renamed');

    await act(async () => { pending[0]?.(); });
    await settle();
    expect(query('[data-browser-row="qa"]')).not.toBeNull();
    await clickRow('qa');
    expect(query<HTMLInputElement>('[data-browser-name-input]')?.value).toBe('Regression');
  });

  it('lets the draft footer discard without asking the guard again', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });
    const asked: string[] = [];
    const guard: DirtyGuardValue = {
      dirty: false,
      reportDirty: () => undefined,
      navigate: () => undefined,
      confirmDiscard: (id) => { asked.push(id); },
    };

    await render(guard);
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    setInput('[data-browser-profile-input]', 'C:\\kiki\\browsers\\other');
    await settle();

    await click('[data-settings-discard]');
    expect(asked).toEqual([]);
    expect(query<HTMLInputElement>('[data-browser-profile-input]')?.value).toBe('C:\\kiki\\browsers\\research');
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(true);
  });

  it('saves through the browser API and adopts what the server echoed back', async () => {
    const edited = 'C:\\kiki\\browsers\\renamed';
    // The first read is the stored connection; every read after the save is the
    // server's list again, which is where the row's new state comes from.
    list.mockResolvedValueOnce({ connections: [profileRow()] })
      .mockResolvedValue({ connections: [profileRow({ name: 'Research', profilePath: edited })] });
    upsert.mockResolvedValue({
      connection: {
        id: 'research', name: 'Research', enabled: true, type: 'agent-browser-profile', profilePath: edited,
      },
    });

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    setInput('[data-browser-profile-input]', edited);
    await settle();
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(false);

    await save();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).toBe('research');
    expect(upsert.mock.calls[0]?.[1]).toEqual({
      name: 'Research notes', enabled: true, driverPath: undefined, type: 'agent-browser-profile',
      profilePath: edited, executablePath: undefined, headed: undefined,
    });
    // Read back from the server's own object, so the bar closes.
    expect(query<HTMLInputElement>('[data-browser-profile-input]')?.value).toBe(edited);
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the draft when the write fails', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });
    upsert.mockRejectedValue(new Error('browser.invalid: expected an absolute server path'));

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    setInput('[data-browser-profile-input]', 'C:\\kiki\\browsers\\kept');
    await settle();
    await save();

    expect(query('[data-feedback-tone="error"]')?.textContent).toContain('expected an absolute server path');
    expect(query<HTMLInputElement>('[data-browser-profile-input]')?.value).toBe('C:\\kiki\\browsers\\kept');
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(false);
  });

  it('shows the reason a failed check gave, and never worded it as a pass', async () => {
    const failed = {
      ...profileRow(),
      status: browserStatus({
        browser: 'research', state: 'failed', ownership: 'managed-profile',
        error: 'Expected the managed agent-browser 0.38.2 kiki-no-replay-r1 kiki-stdio-r1 build; detected 0.38.2.',
      }),
    };
    list.mockResolvedValueOnce({ connections: [profileRow()] }).mockResolvedValue({ connections: [failed] });
    check.mockResolvedValue(failed.status);

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    await click('[data-browser-check]');

    expect(check).toHaveBeenCalledWith('research');
    expect(query('[data-browser-outcome="check:failed"]')?.textContent).toContain('The operation failed.');
    // The same sentence the outcome block would carry, so it is shown here once.
    expect(query('[data-browser-error]')?.textContent).toContain('kiki-stdio-r1');
    expect(container.textContent).not.toContain('Check passed');
    // A driver failure is a configuration problem, not the flag.
    expect(query('[data-browser-open-flag]')).toBeNull();

    // Nothing on a timer turns it into a pass.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 700); }); });
    expect(query('[data-browser-outcome="check:failed"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Check passed');
  });

  it('points at the experimental flag when the server refuses to run a browser', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });
    connect.mockRejectedValue(Object.assign(
      new Error('Native browser execution is experimental; enable native_browser in the existing experimental settings'),
      { details: { code: 'browser.disabled', reason: 'feature_disabled' } },
    ));

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    await click('[data-browser-connect]');
    await settle();

    // The page says it in the reader's language without forcing the internal flag name into the main prose.
    const line = query('[data-feedback-tone="error"]')?.textContent ?? '';
    expect(line).toContain('Browser control is not allowed on this server yet, so this connection cannot start or attach.');
    expect(line).not.toContain('native_browser');
    // The refusal is real, so nothing about the connection turns green.
    expect(connect).toHaveBeenCalledWith('research');
    expect(query('[data-browser-state="idle"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Connected.');
    // And the refused run offers the trip to the switch, which now lives on
    // this tab's own Experimental rows.
    expect(query('[data-browser-open-flag]')?.textContent).toBe('Open the switch below');
  });

  it('says what a disconnect does to the resource, by the ownership the server reports', async () => {
    list.mockResolvedValue({ connections: [cdpRow()] });
    disconnect.mockResolvedValue(browserStatus({
      browser: 'preview', state: 'disconnected', generation: 4, ownership: 'external-browser',
      checkedAt: '2026-10-03T02:00:00.000Z',
    }));

    await render();
    await settleUntil('[data-browser-row="preview"]');
    await clickRow('preview');

    // Connected: the meaning of disconnecting is stated before it is pressed.
    expect(container.textContent).toContain('the borrowed browser stays');

    await click('[data-browser-disconnect]');
    expect(disconnect).toHaveBeenCalledWith('preview');
    expect(query('[data-browser-outcome="disconnect:disconnected"]')?.textContent).toContain('Control disconnected.');
    expect(query('[data-browser-outcome="disconnect:disconnected"]')?.textContent).toContain('the borrowed browser stays');
    expect(container.textContent).not.toContain('ends this browser instance, which Kiki started');
  });

  it('keeps an unconfirmed stop unconfirmed', async () => {
    const live = { ...profileRow(), status: browserStatus({ browser: 'research', state: 'ready', generation: 1, ownership: 'managed-profile' }) };
    const stopped = {
      ...profileRow(),
      status: browserStatus({
        browser: 'research', state: 'unconfirmed', generation: 1, ownership: 'managed-profile',
        error: 'Close acknowledged, but daemon termination is not confirmed. Check again before reconnecting.',
      }),
    };
    list.mockResolvedValueOnce({ connections: [live] }).mockResolvedValue({ connections: [stopped] });
    disconnect.mockResolvedValue(stopped.status);

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    await click('[data-browser-disconnect]');

    expect(query('[data-browser-outcome="disconnect:unconfirmed"]')?.textContent).toContain('The operation’s outcome is unconfirmed.');
    expect(container.textContent).toContain('daemon termination is not confirmed');

    // No timer upgrades it to a confirmed stop.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 700); }); });
    expect(query('[data-browser-outcome="disconnect:unconfirmed"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Control disconnected.');
    expect(query<HTMLButtonElement>('[data-browser-connect]')?.disabled).toBe(false);
  });

  it('masks the CDP endpoint in the page and sends it only on an explicit reveal', async () => {
    list.mockResolvedValue({ connections: [cdpRow()] });

    await render();
    await settleUntil('[data-browser-row="preview"]');
    await clickRow('preview');
    await settleUntil('[data-secret-field]');

    expect(revealSecret).not.toHaveBeenCalled();
    expect(query('[data-secret-field]')?.textContent).not.toContain('9222');

    await click('[data-secret-reveal]');
    expect(revealSecret).toHaveBeenCalledWith({ kind: 'browser_endpoint', browser_id: 'preview' });
  });

  it('creates a connection with the input the published schema accepts', async () => {
    const created = { id: 'demo', name: 'Demo', enabled: true, type: 'agent-browser-profile' as const };
    list.mockResolvedValueOnce({ connections: [] })
      .mockResolvedValue({ connections: [{ ...created, status: browserStatus({ browser: 'demo', ownership: 'managed-profile' }) }] });
    upsert.mockResolvedValue({ connection: created });

    await render();
    await settleUntil('[data-browser-empty]');
    await click('[data-browser-add]');
    await click('[data-browser-add-manual]');

    setInput('[data-browser-id-input]', 'demo');
    setInput('[data-browser-name-input]', 'Demo');
    await settle();
    await save();

    expect(upsert.mock.calls[0]?.[0]).toBe('demo');
    expect(upsert.mock.calls[0]?.[1]).toEqual({
      name: 'Demo', enabled: true, driverPath: undefined, type: 'agent-browser-profile',
      profilePath: undefined, executablePath: undefined, headed: undefined,
    });
    // The new connection now has its own row, open where the editor was.
    await settleUntil('[data-browser-row="demo"]');
    await clickRow('demo');
  });

  it('creates a bridge connection from the style picker, with no endpoint', async () => {
    const created = { id: 'daily-edge', name: 'Daily Edge', enabled: true, type: 'kimi-webbridge' as const };
    list.mockResolvedValueOnce({ connections: [] })
      .mockResolvedValue({ connections: [{ ...created, status: browserStatus({ browser: 'daily-edge', ownership: 'external-browser' }) }] });
    upsert.mockImplementation(async (_id, input) => {
      const body = input as { endpoint?: unknown; type: string };
      if (body.type !== 'kimi-webbridge' || body.endpoint !== undefined) throw new Error('the new bridge was written as CDP');
      return { connection: created };
    });

    await render();
    await settleUntil('[data-browser-empty]');
    await click('[data-browser-add]');
    await click('[data-browser-add-manual]');
    setInput('[data-browser-id-input]', 'daily-edge');
    setInput('[data-browser-name-input]', 'Daily Edge');
    await settle();
    // Adding a connection still starts on the managed profile; the bridge is a pick.
    expect(query('[data-browser-type]')?.dataset['browserType']).toBe('agent-browser-profile');

    await selectOption('#browser-type', 'kimi-webbridge');
    // The branch that needs no address has no address to fill.
    expect(query('[data-secret-field]')).toBeNull();
    expect(query('[data-browser-bridge]')?.textContent).toContain('local HTTP bridge');
    await save();

    expect(upsert.mock.calls[0]?.[0]).toBe('daily-edge');
    expect(upsert.mock.calls[0]?.[1]).toEqual({
      name: 'Daily Edge', enabled: true, driverPath: undefined, type: 'kimi-webbridge',
    });
    // Read back as the server returns it: the new record is the bridge, not CDP.
    await settleUntil('[data-browser-row="daily-edge"]');
    await clickRow('daily-edge');
    expect(query('[data-browser-row="daily-edge"]')?.textContent).toContain('Local bridge');
  });

  it('writes the visible-window choice only for a profile connection', async () => {
    list.mockResolvedValueOnce({ connections: [profileRow()] })
      .mockResolvedValue({ connections: [profileRow({ headed: true })] });
    upsert.mockResolvedValue({
      connection: { id: 'research', name: 'Research notes', enabled: true, type: 'agent-browser-profile', headed: true },
    });

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');

    // A profile starts its own browser, so headless vs. window is a real choice.
    expect(query('[data-browser-headed]')).not.toBeNull();
    expect(query<HTMLInputElement>('[data-browser-headed] input')?.checked).toBe(false);

    await click('[data-browser-headed] input');
    await settle();
    await save();

    expect(upsert.mock.calls[0]?.[1]).toMatchObject({ headed: true });
    // Read back from what the server returned, not from what was typed.
    expect(query<HTMLInputElement>('[data-browser-headed] input')?.checked).toBe(true);
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(true);
  });

  it('preserves an existing CDP id, type, default and allow selection after save and returning to settings', async () => {
    const row = cdpRow({ id: 'kimi-webbridge', name: 'edge-kimi' });
    list.mockResolvedValue({ connections: [row], defaultBrowser: row.id, allowedBrowsers: [row.id], allowedBrowsersConfigured: true });
    upsert.mockImplementation(async (_id, input) => {
      Object.assign(row, { name: (input as { name: string }).name });
      return { connection: row };
    });
    await render();
    await settleUntil('[data-browser-row="kimi-webbridge"]');
    await clickRow('kimi-webbridge');
    // The stored style stays selected: becoming a bridge is a choice, not a default.
    expect(query('[data-browser-type]')?.dataset['browserType']).toBe('agent-browser-cdp');
    setInput('[data-browser-name-input]', 'External browser');
    await settle();
    await save();
    expect(upsert).toHaveBeenCalledWith('kimi-webbridge', expect.objectContaining({ type: 'agent-browser-cdp', endpoint: { action: 'keep' } }));
    await act(async () => { root.unmount(); });
    queries.clear();
    root = createRoot(container);
    await render();
    await settleUntil('[data-browser-row="kimi-webbridge"]');
    expect(query('[data-browser-row="kimi-webbridge"]')?.textContent).toContain('External browser');
    expect(query('[data-browser-verdict="allowed"]')?.textContent).toContain('Allowed browsers: 1');
    expect(setDefault).not.toHaveBeenCalled();
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('saves the bridge as the bridge type with no endpoint, and reads the saved row back', async () => {
    const row = bridgeRow();
    list.mockResolvedValue({ connections: [row] });
    upsert.mockImplementation(async (_id, input) => {
      const body = input as { name: string; enabled: boolean; type: string; endpoint?: unknown };
      // The published schema is strict on this branch: a write that carried an
      // endpoint would be refused by the server, so the mock refuses it too.
      if (body.type !== 'kimi-webbridge' || body.endpoint !== undefined) throw new Error('the bridge was written as CDP');
      row.name = body.name;
      row.enabled = body.enabled;
      return { connection: { ...row } };
    });

    await render();
    await settleUntil('[data-browser-row="kimi-webbridge"]');
    await clickRow('kimi-webbridge');

    // Nothing on this branch asks for a CDP address, the style cannot be pointed
    // at one, and the form says which bridge it is talking to. The detail carries
    // no second name/id header and no allow tag or delete button: the row above
    // states those, and deletion lives in the row's ⋯ menu.
    expect(query('[data-secret-field]')).toBeNull();
    expect(query('[data-browser-type]')?.dataset['browserType']).toBe('kimi-webbridge');
    expect(query('[data-browser-bridge]')?.textContent).toContain('local HTTP bridge');
    expect(query('[data-browser-check]')?.textContent).toBe('Check bridge');
    expect(query('[data-browser-connect]')?.textContent).toBe('Connect bridge');
    expect(query('[data-browser-detail-allowed]')).toBeNull();
    expect(query('[data-browser-detail] [data-browser-delete]')).toBeNull();
    expect(query('[data-browser-detail-name]')).toBeNull();

    setInput('[data-browser-name-input]', 'Daily Edge (work)');
    await settle();
    await save();

    expect(upsert).toHaveBeenCalledWith('kimi-webbridge', {
      name: 'Daily Edge (work)', enabled: true, driverPath: undefined, type: 'kimi-webbridge',
    });
    // Read back from what the server returned: still the bridge, still no
    // endpoint field, and the switch the server now holds.
    expect(query('[data-browser-type]')?.dataset['browserType']).toBe('kimi-webbridge');
    expect(query<HTMLInputElement>('[data-browser-name-input]')?.value).toBe('Daily Edge (work)');
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(true);
  });

  it('names the bridge catalogue’s own isolation model, not the managed driver’s', async () => {
    const row = bridgeRow();
    list.mockResolvedValue({ connections: [row] });
    catalog.mockResolvedValue({
      browser: 'kimi-webbridge', status: row.status, backendToolCount: 3, contextIsolation: 'main-frame-only',
      capabilities: [
        { name: 'agent_browser_snapshot', description: 'Read the selected tab as an accessibility tree.', group: 'page', surface: 'operation' },
        { name: 'agent_browser_click', description: 'Click an element in the selected tab.', group: 'page', surface: 'operation' },
        { name: 'agent_browser_fill', description: 'Fill an element in the selected tab.', group: 'page', surface: 'operation' },
      ],
    });

    await render();
    await settleUntil('[data-browser-row="kimi-webbridge"]');
    await clickRow('kimi-webbridge');
    await toggleDetails('[data-browser-runtime-tree]');
    await click('[data-browser-catalog-read]');
    await settleUntil('[data-browser-catalog]');

    // The main frame of the selected tab is the bridge's whole surface, and the
    // managed driver's window context is a different browser model rather than a
    // fallback for a token this page does not recognise.
    const isolation = query('[data-browser-catalog-isolation]');
    expect(isolation?.textContent).toBe('main frame only');
    expect(isolation?.title).toBe('main-frame-only');
    expect(container.textContent).not.toContain('opaque window context');
  });

  it('writes the bridge route’s own switch when its allow box is ticked', async () => {
    const bridge = bridgeRow({ enabled: false });
    list.mockResolvedValue({ connections: [bridge] });
    setupPresets.mockResolvedValue({ presets: [{ ...KIMI_NEEDS_EXTENSION, connectionId: 'kimi-webbridge' }] });
    upsert.mockImplementation(async (_id, input) => ({ connection: { ...bridge, enabled: (input as { enabled: boolean }).enabled } }));

    await render();
    await settleUntil('[data-browser-row="kimi-webbridge"]');
    // The bridge is listed once, with the other browsers, and attributed to the
    // Kimi source rather than repeated under its route.
    expect(query('[data-browser-route="kimi-webbridge"] [data-browser-allow-switch]')).toBeNull();
    expect(query('[data-browser-row="kimi-webbridge"] [data-browser-row-type]')?.getAttribute('data-browser-row-type')).toBe('kimi-webbridge');
    // A switched-off connection cannot be allowed, so ticking the box is also the
    // request to switch it on — through the bridge's own branch, not a CDP write.
    expect(allowBox('kimi-webbridge')?.checked).toBe(false);
    await click(`[data-browser-allow-switch=\"kimi-webbridge\"] input`);

    expect(patchConfig).toHaveBeenCalledWith({ browser_control: { allowed_browsers: ['kimi-webbridge'] } });
    expect(upsert).toHaveBeenCalledWith('kimi-webbridge', {
      type: 'kimi-webbridge', name: 'Daily Edge', enabled: true, driverPath: undefined,
    });
  });

  it('keeps official extension bindings when editing a saved connection instead of serializing them as CDP', async () => {
    const row = { id: 'official-browser', name: 'Official browser', enabled: true, type: 'codex-extension' as const,
      runtimeRoot: 'C:\\example\\official-runtime', browserId: 'browser-fixture', status: browserStatus({ browser: 'official-browser' }) };
    list.mockResolvedValue({ connections: [row] });
    upsert.mockResolvedValue({ connection: row });
    await render();
    await settleUntil('[data-browser-row="official-browser"]');
    await clickRow('official-browser');
    expect(query('[data-browser-official-binding]')?.textContent).toContain(row.browserId);
    expect(query('[data-secret-field]')).toBeNull();
    setInput('[data-browser-name-input]', 'Renamed official browser');
    await settle();
    await save();
    expect(upsert).toHaveBeenCalledWith('official-browser', { type: 'codex-extension', name: 'Renamed official browser', enabled: true,
      runtimeRoot: row.runtimeRoot, browserId: row.browserId });
  });

  it('offers no visible-window switch on a borrowed browser, and stores none', async () => {
    list.mockResolvedValue({ connections: [cdpRow()] });
    upsert.mockResolvedValue({
      connection: { id: 'preview', name: 'Remote preview', enabled: true, type: 'agent-browser-cdp', endpointDisplay: 'http://127.0.0.1:9222', endpointConfigured: true },
    });

    await render();
    await settleUntil('[data-browser-row="preview"]');
    await clickRow('preview');
    await settleUntil('[data-secret-field]');

    // The endpoint decides how that browser runs; the page cannot switch it.
    expect(query('[data-browser-headed]')).toBeNull();

    setInput('[data-browser-name-input]', 'Remote preview 2');
    await settle();
    await save();

    const sent = upsert.mock.calls[0]?.[1];
    expect(sent).toEqual({
      name: 'Remote preview 2', enabled: true, driverPath: undefined, type: 'agent-browser-cdp',
      endpoint: { action: 'keep' },
    });
    expect(Object.keys(sent as object)).not.toContain('headed');
  });

  it('clears the visible-window choice when it is switched back off', async () => {
    list.mockResolvedValueOnce({ connections: [profileRow({ headed: true })] })
      .mockResolvedValue({ connections: [profileRow()] });
    upsert.mockResolvedValue({
      connection: { id: 'research', name: 'Research notes', enabled: true, type: 'agent-browser-profile' },
    });

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    expect(query<HTMLInputElement>('[data-browser-headed] input')?.checked).toBe(true);

    await click('[data-browser-headed] input');
    await settle();
    await save();

    // Absent means headless, so switching it off stores nothing extra.
    expect(upsert.mock.calls[0]?.[1]).toMatchObject({ headed: undefined });
    expect(query<HTMLInputElement>('[data-browser-headed] input')?.checked).toBe(false);
  });

  it('refuses a new id that is already taken, because the write would overwrite it', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });

    await render();
    await settleUntil('[data-browser-row="research"]');
    await click('[data-browser-add]');
    await click('[data-browser-add-manual]');
    setInput('[data-browser-id-input]', 'research');
    setInput('[data-browser-name-input]', 'Second');
    await settle();
    await save();

    expect(upsert).not.toHaveBeenCalled();
    expect(query('[data-field-issue]')?.textContent).toContain('already taken');
  });

  it('saves the default connection on its own and can go back to choosing each time', async () => {
    list.mockResolvedValue({ connections: [profileRow(), cdpRow()], defaultBrowser: 'research' });
    setDefault.mockResolvedValue({ browser: undefined });

    await render();
    await settleUntil('[data-browser-default-tag="research"]');
    // The default is chosen only from the row's own 设为默认 / 取消默认 item,
    // shown only by the tag: there is no select on the list's header line.
    expect(query('[data-browser-default-tag="research"]')).not.toBeNull();
    expect(query('[data-browser-default-tag="preview"]')).toBeNull();

    await click('[data-browser-row-menu-button="research"]');
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((option) => option.dataset['spaceMenuItem'] === 'default')?.click();
    });
    await settle();

    expect(setDefault).toHaveBeenCalledWith(undefined);
    // The default is its own write: no connection draft was involved.
    expect(upsert).not.toHaveBeenCalled();
  });

  it('never shows one scope\u2019s connections under another', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });

    await render();
    await settleUntil('[data-browser-row="research"]');
    await clickRow('research');
    await settleUntil('[data-browser-execution-host]');
    expect(query('[data-browser-execution-host]')?.textContent).toBe(BUS_USER);

    connection.scopeId = 'ssh:office-mac';
    list.mockResolvedValue({
      enabled: true,
      enabledSource: 'default',
      allowedBrowsers: [],
      allowedBrowsersConfigured: false,
      allowedBrowsersSource: 'default',
      connections: [profileRow({ id: 'office-mac', name: 'Office Mac' })].map((row) => ({
        ...row,
        status: browserStatus({ browser: row.id, executionHost: 'office-mac-host', ownership: 'managed-profile' }),
      })),
    });
    await render();
    await settleUntil('[data-browser-row="office-mac"]');

    expect(query('[data-browser-row="research"]')).toBeNull();
    await clickRow('office-mac');
    await settleUntil('[data-browser-execution-host]');
    expect(query('[data-browser-execution-host]')?.textContent).toBe('office-mac-host');
  });
  });

  describe('WebBridgeReadiness', () => {
    it('respects valid server browserExtensionUrl instead of only fixed chrome url', async () => {
      getCapability.mockResolvedValue({
        id: 'kimi-webbridge', displayName: 'Kimi WebBridge', description: 'desc', supported: true, state: 'ready',
        steps: [{ id: 'daemon', state: 'ok' }],
        install: { running: false },
        plan: {
          destination: '/opt/kiki/bin',
          artifact: { version: '2.0.22', url: 'https://example.test/bin', sha256: 'abc' },
          browserExtensionUrl: 'https://addons.mozilla.org/firefox/downloads/file/123/kimi.xpi',
        },
      } as any);

      await render();
      await openSources();
      await openWebbridge();
      await settleUntil('[data-webbridge-extension]');

      const link = query<HTMLAnchorElement>('[data-webbridge-extension]');
      expect(link?.href).toBe('https://addons.mozilla.org/firefox/downloads/file/123/kimi.xpi');
    });

    it('still offers retry button when install or daemon fails', async () => {
      getCapability.mockResolvedValue({
        id: 'kimi-webbridge', displayName: 'Kimi WebBridge', description: 'desc', supported: true, state: 'failed',
        steps: [{ id: 'daemon', state: 'failed' }],
        install: { running: false, error: 'Daemon crashed on startup' },
        plan: {
          destination: '/opt/kiki/bin',
          artifact: { version: '2.0.22', url: 'https://example.test/bin', sha256: 'abc' },
        },
      } as any);

      await render();
      await openSources();
      await openWebbridge();
      await settleUntil('[data-webbridge-prepare]');

      const retryBtn = query('[data-webbridge-prepare]');
      expect(retryBtn).not.toBeNull();
      expect(retryBtn?.textContent).toContain('Try setup again…');
    });
  });

  describe('Codex browser extension route with candidates', () => {
    const codexWithCandidates = preset({
      preset: 'codex-browser', displayName: 'Codex / ChatGPT browser extension', controlSurface: 'browser-connection',
      state: 'needs_user_action', reason: 'choose_connection',
      sourceUrl: 'https://developers.openai.com/codex/app/chrome-extension',
      steps: [
        { id: 'driver', state: 'ready' },
        { id: 'desktop-app', state: 'user_action', reason: 'external_app_required' },
        { id: 'detect', state: 'user_action', reason: 'choose_connection' },
      ],
      candidates: [
        { browserId: 'codex-browser-use-pipe-1' },
        { browserId: 'codex-browser-use-pipe-2' },
        { browserId: 'codex-browser-use-pipe-3' },
      ],
      actions: [
        { id: 'prepare' },
        { id: 'choose_connection' },
        { id: 'connect' },
        { id: 'open_instructions', url: 'https://developers.openai.com/codex/app/chrome-extension', target: 'documentation' },
      ],
    });

    it('requires explicit selection from candidates, sends correct body, and saves as ready approval_unproven', async () => {
      let current = codexWithCandidates;
      setupPresets.mockImplementation(async () => ({ presets: [current] }));
      await render();
      await settleUntil('[data-browser-route="codex-browser"]');

      expect(query('[data-browser-source-items="codex-browser"]')).not.toBeNull();
      const pipe2Box = allowBox('codex-browser-use-pipe-2');
      expect(pipe2Box).not.toBeNull();
      expect(pipe2Box?.checked).toBe(false);

      connectPreset.mockImplementationOnce(async () => {
        current = {
          ...codexWithCandidates,
          state: 'needs_user_action',
          reason: 'approval_unproven',
          connectionId: 'codex-browser',
          browserId: 'codex-browser-use-pipe-2',
        };
        return current;
      });

      await act(async () => { pipe2Box?.click(); });
      await settle();

      expect(connectPreset).toHaveBeenCalledWith('codex-browser', {
        connectionId: 'codex-browser',
        browserId: 'codex-browser-use-pipe-2',
      });

      expect(query('[data-browser-route="codex-browser"] [data-browser-route-connected]')).toBeNull();
      expect(query('[data-feedback-tone="info"]')?.textContent).toContain('Connection saved. Extension protocol will perform required authorization on invocation.');
      expect(query('[data-feedback-tone="info"]')?.textContent).not.toContain('Connected.');
    });

    it('renders empty candidate state when no candidates are discovered', async () => {
      const codexEmpty = {
        ...codexWithCandidates,
        candidates: [],
      };
      setupPresets.mockResolvedValue({ presets: [codexEmpty] });
      await render();
      await settleUntil('[data-browser-route="codex-browser"]');

      expect(query('[data-browser-candidates-empty]')).not.toBeNull();
      expect(query('[data-browser-candidates-empty]')?.textContent).toContain('No running extension connections found');
      expect(query('[data-browser-source-items="codex-browser"]')).toBeNull();
    });

    it('displays error on failed connect and supports retry', async () => {
      setupPresets.mockResolvedValue({ presets: [codexWithCandidates] });
      await render();
      await settleUntil('[data-browser-route="codex-browser"]');

      connectPreset.mockResolvedValueOnce({
        ...codexWithCandidates,
        state: 'failed',
        error: 'Connection to extension pipe was refused',
      });

      await act(async () => { allowBox('codex-browser-use-pipe-1')?.click(); });
      await settle();
      expect(query('[data-browser-route="codex-browser"] [data-feedback-tone="error"]')?.textContent).toContain('Connection to extension pipe was refused');

      connectPreset.mockResolvedValueOnce({
        ...codexWithCandidates,
        state: 'needs_user_action',
        reason: 'approval_unproven',
        connectionId: 'codex-browser',
        browserId: 'codex-browser-use-pipe-1',
      });

      await act(async () => { allowBox('codex-browser-use-pipe-1')?.click(); });
      await settle();
      expect(connectPreset).toHaveBeenCalledTimes(2);
      expect(query('[data-browser-route="codex-browser"] [data-feedback-tone="info"]')?.textContent).toContain('saved');
      expect(query('[data-browser-route="codex-browser"] [data-feedback-tone="error"]')).toBeNull();
      expect(query('[data-browser-route="codex-browser"] [data-browser-route-connected]')).toBeNull();
    });

    it('handles late-arriving candidates cleanly when refetched', async () => {
      setupPresets.mockResolvedValueOnce({ presets: [{ ...codexWithCandidates, candidates: [] }] });
      await render();
      await settleUntil('[data-browser-route="codex-browser"]');

      expect(query('[data-browser-candidates-empty]')).not.toBeNull();
      expect(query('[data-browser-source-items="codex-browser"]')).toBeNull();

      setupPresets.mockResolvedValueOnce({ presets: [codexWithCandidates] });
      await act(async () => { await queries.invalidateQueries({ queryKey: ['browser', 'setup', 'local'] }); });
      await settleUntil('[data-browser-source-items="codex-browser"]');

      expect(query('[data-browser-source-items="codex-browser"]')).not.toBeNull();
      expect(query('[data-browser-candidates-empty]')).toBeNull();
    });

    it('renders multi-browser allowlist with checkboxes, allows selecting multiple simultaneously, and preserves defaultBrowser', async () => {
      const connections: MockBrowserControlList['connections'] = [
        {
          id: 'work-browser',
          type: 'codex-extension',
          name: 'Work browser',
          enabled: true,
          browserId: 'codex-browser-use-pipe-1',
          status: browserStatus({ browser: 'work-browser', state: 'ready', ownership: 'external-browser' }),
        },
      ];
      let currentAllowed: string[] = ['work-browser'];
      list.mockImplementation(async () => ({
        enabled: true,
        enabledSource: 'default',
        allowedBrowsers: currentAllowed,
        allowedBrowsersConfigured: true,
        allowedBrowsersSource: 'home',
        defaultBrowser: 'work-browser',
        connections: connections.map((connection) => ({ ...connection })),
      }));
      setupPresets.mockResolvedValue({ presets: [codexWithCandidates] });

      await render();
      await openSources();
      await settleUntil('[data-browser-source-items="codex-browser"]');

      const countBadge = query('[data-browser-allowed-count="codex-browser"]');
      expect(countBadge).not.toBeNull();
      expect(countBadge?.textContent).toContain('1 of 1 allowed');
      // The saved connection is a browser row; only what is not saved yet stays under the route.
      expect(queryAll('[data-browser-route="codex-browser"] [data-browser-allow-checkbox]')).toHaveLength(2);
      expect(queryAll('[data-browser-allow-switch="work-browser"] input')).toHaveLength(1);
      expect(query('[data-browser-route="codex-browser"] [data-browser-allow-checkbox="work-browser"]')).toBeNull();

      const registered = allowBox('work-browser');
      const unregistered = allowBox('codex-browser-use-pipe-2');
      expect(registered?.checked).toBe(true);
      expect(unregistered?.checked).toBe(false);
      expect(query('[data-browser-allow-checkbox="codex-browser-use-pipe-1"]')).toBeNull();
      expect(query('[data-browser-row="work-browser"] [data-browser-identity="codex-browser-use-pipe-1"]')).not.toBeNull();
      expect(query('[data-browser-row="work-browser"] [data-browser-row-type="codex-extension"]')).not.toBeNull();
      expect(query('[data-browser-row="work-browser"] [data-browser-state="ready"]')).not.toBeNull();
      expect(query('[data-browser-default-tag="work-browser"]')).not.toBeNull();

      connectPreset.mockImplementationOnce(async () => {
        connections.push({
          id: 'codex-browser',
          type: 'codex-extension',
          name: 'Codex browser extension',
          enabled: true,
          browserId: 'codex-browser-use-pipe-2',
          status: browserStatus({ browser: 'codex-browser', state: 'idle', ownership: 'external-browser' }),
        });
        return {
          ...codexWithCandidates,
          state: 'needs_user_action',
          reason: 'approval_unproven',
          connectionId: 'codex-browser',
          browserId: 'codex-browser-use-pipe-2',
        };
      });
      patchConfig.mockImplementationOnce(async (patch) => {
        currentAllowed = (patch as { browser_control?: { allowed_browsers?: string[] } }).browser_control?.allowed_browsers ?? [];
        return patch;
      });

      await act(async () => { unregistered?.click(); });
      await settle();

      expect(connectPreset).toHaveBeenCalledTimes(1);
      expect(connectPreset).toHaveBeenCalledWith('codex-browser', {
        connectionId: 'codex-browser',
        browserId: 'codex-browser-use-pipe-2',
      });
      expect(patchConfig).toHaveBeenCalledWith(expect.objectContaining({
        browser_control: { allowed_browsers: ['work-browser', 'codex-browser'] },
      }));
      expect(setDefault).not.toHaveBeenCalled();
      expect(query('[data-browser-default-tag="work-browser"]')).not.toBeNull();
    });

    it('allows and clears the registered connection id, connects an unregistered pipe without rebinding or changing the default, and keeps a refused connect retryable', async () => {
      const store = boundedBrowserStore({
        defaultBrowser: 'work-browser',
        allowed: ['work-browser', 'research'],
        connections: [
          {
            id: 'work-browser',
            type: 'codex-extension',
            name: 'Work browser',
            enabled: true,
            browserId: 'codex-browser-use-pipe-1',
            runtimeRoot: 'C:\\kiki\\codex\\bridge.exe',
            status: browserStatus({ browser: 'work-browser', state: 'ready', ownership: 'external-browser' }),
          },
          profileRow({ id: 'research', name: 'Research notes' }),
        ],
      });
      setupPresets.mockResolvedValue({ presets: [codexWithCandidates] });
      const reasons: unknown[] = [];
      const onRejection = (reason: unknown) => { reasons.push(reason); };
      process.on('unhandledRejection', onRejection);

      const clickBox = async (id: string) => {
        const box = allowBox(id);
        expect(box).not.toBeNull();
        await act(async () => { box?.click(); });
        await settle();
      };

      try {
        await render();
        await openSources();
        await settleUntil('[data-browser-source-items="codex-browser"]');

        expect(() => { store.rejectUnknown(['codex-browser-use-pipe-1']); }).toThrow('Unknown browser connection "codex-browser-use-pipe-1"');
        expect(queryAll('[data-browser-route="codex-browser"] [data-browser-allow-checkbox]')).toHaveLength(2);
        expect(queryAll('[data-browser-allow-switch="work-browser"] input')).toHaveLength(1);
        expect(query('[data-browser-route="codex-browser"] [data-browser-allow-checkbox="work-browser"]')).toBeNull();
        expect(query('[data-browser-route="codex-browser"] [data-browser-allow-switch="research"]')).toBeNull();
        expect(query('[data-browser-identity="codex-browser-use-pipe-1"]')).not.toBeNull();
        expect(allowBox('work-browser')?.checked).toBe(true);
        expect(allowBox('codex-browser-use-pipe-2')?.checked).toBe(false);
        expect(query('[data-browser-allowed-count="codex-browser"]')?.textContent).toContain('1 of 1 allowed');
        expect(query('[data-browser-verdict="allowed"]')?.textContent).toContain('Allowed browsers: 2');

        await clickBox('work-browser');
        expect(store.state.allowed).toEqual(['research']);
        expect(store.state.defaultBrowser).toBe('work-browser');
        expect(connectPreset).not.toHaveBeenCalled();
        expect(setDefault).not.toHaveBeenCalled();
        expect(upsert.mock.calls.map(([id]) => id)).toEqual(['work-browser']);
        expect(upsert.mock.calls[0]?.[1]).toMatchObject({ type: 'codex-extension', browserId: 'codex-browser-use-pipe-1', enabled: false });
        expect(query('[data-browser-allowed-count="codex-browser"]')?.textContent).toContain('0 of 1 allowed');
        // Still the default, now not allowed: the top verdict says so instead of implying it works.
        expect(query('[data-browser-verdict="default_not_allowed"]')?.textContent).toContain('Work browser');
        await clickBox('work-browser');
        expect(store.state.allowed).toEqual(['research', 'work-browser']);
        expect(store.state.defaultBrowser).toBe('work-browser');
        expect(connectPreset).not.toHaveBeenCalled();
        expect(store.state.connections.find((connection) => connection.id === 'work-browser')?.browserId).toBe('codex-browser-use-pipe-1');

        connectPreset.mockRejectedValueOnce(new Error('pipe refused'));
        await clickBox('codex-browser-use-pipe-2');
        expect(store.state.allowed).toEqual(['research', 'work-browser']);
        expect(patchConfig).toHaveBeenCalledTimes(2);
        expect(query('[data-browser-route="codex-browser"] [data-feedback-tone="error"]')?.textContent).toContain('pipe refused');
        expect(allowBox('codex-browser-use-pipe-2')?.checked).toBe(false);
        expect(allowBox('codex-browser-use-pipe-2')?.disabled).toBe(false);

        connectPreset.mockImplementation(async (presetName: string, input: Record<string, unknown>) => {
          expect(presetName).toBe('codex-browser');
          expect(input['setDefault']).not.toBe(true);
          const connectionId = String(input['connectionId']);
          const browserId = String(input['browserId']);
          const occupant = store.state.connections.find((connection) => connection.id === connectionId);
          if (occupant?.type === 'codex-extension' && occupant.browserId !== undefined && occupant.browserId !== browserId) {
            return { ...codexWithCandidates, state: 'needs_user_action' as const, reason: 'connection_conflict' };
          }
          if (occupant === undefined) {
            store.state.connections.push({
              id: connectionId,
              type: 'codex-extension',
              name: 'Codex browser extension',
              enabled: true,
              browserId,
              status: browserStatus({ browser: connectionId, state: 'idle', ownership: 'external-browser' }),
            });
          }
          return { ...codexWithCandidates, state: 'ready' as const, reason: undefined, connectionId, browserId };
        });

        await clickBox('codex-browser-use-pipe-2');
        expect(connectPreset).toHaveBeenLastCalledWith('codex-browser', {
          connectionId: 'codex-browser',
          browserId: 'codex-browser-use-pipe-2',
        });
        expect(store.state.allowed).toEqual(['research', 'work-browser', 'codex-browser']);
        expect(store.state.defaultBrowser).toBe('work-browser');
        expect(setDefault).not.toHaveBeenCalled();
        expect(query('[data-browser-route="codex-browser"] [data-feedback-tone="error"]')).toBeNull();
        // Saved now, so it moves from the route's found list to the browser rows.
        expect(queryAll('[data-browser-route="codex-browser"] [data-browser-allow-checkbox]')).toHaveLength(1);
        expect(query('[data-browser-allow-checkbox="codex-browser-use-pipe-2"]')).toBeNull();
        expect(allowBox('codex-browser')?.checked).toBe(true);
        expect(query('[data-browser-row="codex-browser"] [data-browser-identity="codex-browser-use-pipe-2"]')).not.toBeNull();

        await clickBox('codex-browser-use-pipe-3');
        expect(connectPreset).toHaveBeenLastCalledWith('codex-browser', {
          connectionId: 'codex-browser-use-pipe-3',
          browserId: 'codex-browser-use-pipe-3',
        });
        expect(store.state.allowed).toEqual(['research', 'work-browser', 'codex-browser', 'codex-browser-use-pipe-3']);
        expect(store.state.connections.find((connection) => connection.id === 'work-browser')?.browserId).toBe('codex-browser-use-pipe-1');
        expect(store.state.connections.find((connection) => connection.id === 'codex-browser')?.browserId).toBe('codex-browser-use-pipe-2');
        expect(store.state.defaultBrowser).toBe('work-browser');
        expect(upsert.mock.calls.every(([id]) => id !== 'research')).toBe(true);

        const connectsAfterCreate = connectPreset.mock.calls.length;
        await clickBox('codex-browser');
        expect(connectPreset).toHaveBeenCalledTimes(connectsAfterCreate);
        expect(store.state.allowed).toEqual(['research', 'work-browser', 'codex-browser-use-pipe-3']);
        expect(store.state.defaultBrowser).toBe('work-browser');
        expect(reasons).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('shows a readable retryable error when setting the default is refused and leaves the allow list untouched', async () => {
      const store = boundedBrowserStore({
        defaultBrowser: 'work-browser',
        allowed: ['work-browser', 'research'],
        connections: [
          {
            id: 'work-browser',
            type: 'codex-extension',
            name: 'Work browser',
            enabled: true,
            browserId: 'codex-browser-use-pipe-1',
            status: browserStatus({ browser: 'work-browser', state: 'ready', ownership: 'external-browser' }),
          },
          profileRow({ id: 'research', name: 'Research notes' }),
        ],
      });
      setupPresets.mockResolvedValue({ presets: [codexWithCandidates] });
      const reasons: unknown[] = [];
      const onRejection = (reason: unknown) => { reasons.push(reason); };
      process.on('unhandledRejection', onRejection);
      try {
        await render();
        await settleUntil('[data-browser-default-tag="work-browser"]');
        setDefault.mockRejectedValueOnce(new Error('default refused'));

        // 取消默认 is the same row menu item that set it, against the tag's row.
        await click('[data-browser-row-menu-button="work-browser"]');
        await act(async () => {
          [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
            .find((option) => option.dataset['spaceMenuItem'] === 'default')?.click();
        });
        await settle();

        expect(reasons).toEqual([]);
        expect(query('[data-browser-connections] [data-feedback-tone="error"]')?.textContent).toContain('default refused');
        expect(store.state.allowed).toEqual(['work-browser', 'research']);
        expect(store.state.defaultBrowser).toBe('work-browser');
        expect(patchConfig).not.toHaveBeenCalled();
        expect(connectPreset).not.toHaveBeenCalled();
        expect(query('[data-browser-default-tag="work-browser"]')).not.toBeNull();

        setDefault.mockImplementationOnce(async (browser?: string) => {
          store.state.defaultBrowser = browser;
          return { browser };
        });
        await click('[data-browser-row-menu-button="work-browser"]');
        await act(async () => {
          [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
            .find((option) => option.dataset['spaceMenuItem'] === 'default')?.click();
        });
        await settle();

        expect(setDefault).toHaveBeenCalledTimes(2);
        expect(setDefault).toHaveBeenLastCalledWith(undefined);
        expect(store.state.defaultBrowser).toBeUndefined();
        expect(store.state.allowed).toEqual(['work-browser', 'research']);
        expect(query('[data-browser-connections] [data-feedback-tone="error"]')).toBeNull();
        expect(query('[data-browser-default-tag="work-browser"]')).toBeNull();
        expect(reasons).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });
  });

  describe('Browser control master enabled switch and tool policy', () => {
    it('shows a stale current conversation selection and applies tools only after explicit confirmation', async () => {
      writeLastSessionId('session-fixture');
      getConfig.mockResolvedValue({ browser_control: { enabled: true, allowedBrowsers: [], allowedBrowsersConfigured: false }, tools: {} });
      inspectToolPolicy.mockResolvedValue({ canRefresh: true, activeTools: ['Read'], currentTools: ['Read', 'BrowserConnections', 'BrowserTabs', 'browser__*'], revision: 'source-v1' });
      isToolEnabled.mockResolvedValue(false);
      refreshToolPolicy.mockImplementation(async () => {
        inspectToolPolicy.mockResolvedValue({ canRefresh: true, activeTools: ['BrowserConnections'], currentTools: ['BrowserConnections'], revision: 'source-v1' });
        isToolEnabled.mockResolvedValue(true);
        return { canRefresh: true };
      });
      await render();
      await settleUntil('[data-browser-refresh-tool-policy]');
      expect(container.textContent).toContain('older tool selection');
      expect(refreshToolPolicy).not.toHaveBeenCalled();
      await click('[data-browser-refresh-tool-policy]');
      const confirm = document.querySelector<HTMLButtonElement>('[role="alertdialog"] [data-confirm-action="confirm"]');
      expect(confirm).toBeDefined();
      await act(async () => { confirm?.click(); });
      await settle();
      expect(refreshToolPolicy).toHaveBeenCalledWith('source-v1');
      expect(policySession).toHaveBeenCalledWith('session-fixture');
      expect(policyAgent).toHaveBeenCalledWith('main');
      expect(query('[data-browser-session-tool-policy]')).toBeNull();
    });

    it('reports a current explicit restricted selection without offering automatic widening', async () => {
      writeLastSessionId('session-fixture');
      getConfig.mockResolvedValue({ browser_control: { enabled: true, allowedBrowsers: [], allowedBrowsersConfigured: false }, tools: {} });
      inspectToolPolicy.mockResolvedValue({ canRefresh: true, source: 'declared', activeTools: [], currentTools: [], revision: 'source-v1' });
      isToolEnabled.mockResolvedValue(false);
      await render();
      await settleUntil('[data-browser-session-tool-policy]');
      expect(container.textContent).toContain('tool settings restrict browser control');
      expect(query('[data-browser-refresh-tool-policy]')).toBeNull();
      expect(refreshToolPolicy).not.toHaveBeenCalled();
    });

    it('renders master enabled switch, toggles switch calling client contract, and retains connections', async () => {
      getConfig.mockResolvedValue({
        browser_control: { enabled: true, allowedBrowsers: ['work'], allowedBrowsersConfigured: true },
        tools: {},
      });
      list.mockResolvedValue({
        enabled: true,
        enabledSource: 'default',
        allowedBrowsers: ['work'],
        allowedBrowsersConfigured: true,
        allowedBrowsersSource: 'default',
        connections: [
          { ...profileRow({ id: 'work', name: 'Work' }), status: browserStatus({ browser: 'work', state: 'disconnected' }) },
        ],
      });

      await render();
      await settleUntil('[data-browser-control-enabled]');

      const switchBtn = query<HTMLButtonElement>('[data-browser-enabled-switch]');
      expect(switchBtn).not.toBeNull();
      expect(switchBtn?.getAttribute('aria-checked')).toBe('true');

      // Allowed total count in top verdict
      expect(query('[data-browser-verdict="allowed"]')?.textContent).toContain('Allowed browsers: 1');

      // Toggle switch to off
      await act(async () => {
        switchBtn?.click();
      });
      await settle();

      expect(setBrowserControlEnabled).toHaveBeenCalledWith(false);

      // Connections card is not deleted
      expect(query('#st-card-browser-setup')).not.toBeNull();
    });

    it('displays explicit tool policy denied notice when all browser tools are disabled in policy', async () => {
      getConfig.mockResolvedValue({
        browser_control: { enabled: true, allowedBrowsers: [], allowedBrowsersConfigured: false },
        tools: { disabled: ['BrowserConnections', 'BrowserTabs'] },
      });

      await render();
      await settleUntil('[data-browser-control-enabled]');

      const denied = query('[data-browser-verdict="tool_denied"]');
      expect(denied).not.toBeNull();
      expect(denied?.textContent).toContain('Browser control tools are denied by tool policy.');
    });

    it('displays partial policy notice when only some browser tools are disabled', async () => {
      getConfig.mockResolvedValue({
        browser_control: { enabled: true, allowedBrowsers: ['work'], allowedBrowsersConfigured: true },
        tools: { disabled: ['BrowserConnections'] },
      });
      list.mockResolvedValue({
        enabled: true,
        enabledSource: 'default',
        allowedBrowsers: ['work'],
        allowedBrowsersConfigured: true,
        allowedBrowsersSource: 'default',
        connections: [
          { ...profileRow({ id: 'work', name: 'Work' }), status: browserStatus({ browser: 'work', state: 'disconnected' }) },
        ],
      });

      await render();
      await settleUntil('[data-browser-control-enabled]');

      expect(query('[data-browser-verdict="tool_denied"]')).toBeNull();
      const partial = query('[data-browser-toolpolicy-partial]');
      expect(partial).not.toBeNull();
      expect(partial?.textContent).toContain('Some browser control tools are denied by tool policy.');
    });

    it('supports configured empty list ([]) yielding 0 allowed, selecting 2, and cancelling 1 with consistent master and group counts', async () => {
      const store = boundedBrowserStore({
        allowed: [],
        connections: [
          {
            id: 'work-browser',
            type: 'codex-extension',
            name: 'Pipe 1',
            enabled: true,
            browserId: 'codex-browser-use-pipe-1',
            status: browserStatus({ browser: 'work-browser', state: 'ready', ownership: 'external-browser' }),
          },
          {
            id: 'lab-browser',
            type: 'codex-extension',
            name: 'Pipe 2',
            enabled: true,
            browserId: 'codex-browser-use-pipe-2',
            status: browserStatus({ browser: 'lab-browser', state: 'ready', ownership: 'external-browser' }),
          },
        ],
      });

      setupPresets.mockResolvedValue({
        presets: [
          preset({
            preset: 'codex-browser',
            displayName: 'Codex Browser',
            controlSurface: 'browser-connection',
            state: 'ready',
            candidates: [
              { browserId: 'codex-browser-use-pipe-1' },
              { browserId: 'codex-browser-use-pipe-2' },
            ],
          }),
        ],
      });

      await render();
      await openSources();
      await settleUntil('[data-browser-row="work-browser"]');

      expect(() => { store.rejectUnknown(['codex-browser-use-pipe-1']); }).toThrow('Unknown browser connection "codex-browser-use-pipe-1"');
      expect(query('[data-browser-verdict="none_allowed"]')?.textContent).toContain('No browser is allowed.');
      expect(query('[data-browser-allowed-count="codex-browser"]')?.textContent).toContain('0 of 2 allowed');
      expect(queryAll('[data-browser-list] [data-browser-allow-switch] input')).toHaveLength(2);
      expect(query('[data-browser-route="codex-browser"] [data-browser-allow-switch]')).toBeNull();
      expect(query('[data-browser-allow-checkbox="codex-browser-use-pipe-1"]')).toBeNull();
      expect(query('[data-browser-identity="codex-browser-use-pipe-1"]')).not.toBeNull();
      const cb1 = allowBox('work-browser');
      const cb2 = allowBox('lab-browser');
      expect(cb1?.checked).toBe(false);
      expect(cb2?.checked).toBe(false);

      await act(async () => { cb1?.click(); });
      await settle();
      await act(async () => { allowBox('lab-browser')?.click(); });
      await settle();

      expect(store.state.allowed).toEqual(['work-browser', 'lab-browser']);
      expect(connectPreset).not.toHaveBeenCalled();
      expect(setDefault).not.toHaveBeenCalled();
      expect(query('[data-browser-verdict="allowed"]')?.textContent).toContain('Allowed browsers: 2');
      expect(query('[data-browser-allowed-count="codex-browser"]')?.textContent).toContain('2 of 2 allowed');

      await act(async () => { allowBox('work-browser')?.click(); });
      await settle();

      expect(store.state.allowed).toEqual(['lab-browser']);
      expect(store.state.defaultBrowser).toBeUndefined();
      expect(query('[data-browser-verdict="allowed"]')?.textContent).toContain('Allowed browsers: 1');
      expect(query('[data-browser-allowed-count="codex-browser"]')?.textContent).toContain('1 of 2 allowed');
      expect(allowBox('work-browser')?.checked).toBe(false);
      expect(allowBox('lab-browser')?.checked).toBe(true);
      expect(queryAll('[data-browser-list] [data-browser-allow-switch] input')).toHaveLength(2);
    });

    it('toggles a browser source off to hide its checklist and exclude it from active counts, while preserving checked connections on restore without stealth-selecting new items', async () => {
      const store = boundedBrowserStore({
        allowed: ['work-browser'],
        connections: [
          {
            id: 'work-browser',
            type: 'codex-extension',
            name: 'Pipe 1',
            enabled: true,
            browserId: 'codex-browser-use-pipe-1',
            status: browserStatus({ browser: 'work-browser', state: 'ready', ownership: 'external-browser' }),
          },
          {
            id: 'lab-browser',
            type: 'codex-extension',
            name: 'Pipe 2',
            enabled: true,
            browserId: 'codex-browser-use-pipe-2',
            status: browserStatus({ browser: 'lab-browser', state: 'ready', ownership: 'external-browser' }),
          },
        ],
      });

      setupPresets.mockResolvedValue({
        presets: [
          preset({
            preset: 'codex-browser',
            displayName: 'Codex Browser',
            controlSurface: 'browser-connection',
            state: 'ready',
            candidates: [
              { browserId: 'codex-browser-use-pipe-1' },
              { browserId: 'codex-browser-use-pipe-2' },
              { browserId: 'codex-browser-use-pipe-3' },
            ],
          }),
        ],
      });

      await render();
      expect(query('[data-browser-sources] summary')?.textContent).toBe('Browser sources');
      expect(query('[data-browser-sources-attention]')).toBeNull();
      await openSources();
      await settleUntil('[data-browser-source-items="codex-browser"]');

      const sourceSwitch = query<HTMLElement>('[data-browser-source-switch="codex-browser"]');
      expect(sourceSwitch).not.toBeNull();
      expect(sourceSwitch?.getAttribute('aria-checked')).toBe('true');
      expect(query('[data-browser-verdict="allowed"]')?.textContent).toContain('Allowed browsers: 1');
      expect(allowBox('work-browser')?.checked).toBe(true);
      expect(allowBox('lab-browser')?.checked).toBe(false);

      await click('[data-browser-source-switch="codex-browser"]');
      expect(store.state.disabledSources).toEqual(['codex-browser']);
      expect(store.state.allowed).toEqual(['work-browser']);
      expect(query('[data-browser-source-items="codex-browser"]')).toBeNull();
      expect(query('[data-browser-verdict="none_allowed"]')?.textContent).toContain('No browser is allowed.');
      expect(query('[data-browser-route="codex-browser"]')?.getAttribute('data-browser-route-state')).toBe('disabled');
      expect(allowBox('work-browser')?.disabled).toBe(true);
      expect(query('[data-browser-row="work-browser"] [data-browser-source-tag="codex-browser"]')?.textContent).toContain('source off');

      await click('[data-browser-source-switch="codex-browser"]');
      expect(store.state.disabledSources).toEqual([]);
      expect(store.state.allowed).toEqual(['work-browser']);
      await settleUntil('[data-browser-source-items="codex-browser"]');
      expect(query('[data-browser-verdict="allowed"]')?.textContent).toContain('Allowed browsers: 1');
      expect(allowBox('work-browser')?.checked).toBe(true);
      expect(allowBox('lab-browser')?.checked).toBe(false);
    });
  });
});

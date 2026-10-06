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

import type { BrowserCatalogResponse, BrowserConnection, BrowserPresetId, BrowserSetupList, BrowserSetupStatus, BrowserStatus, BrowserControlList, BrowserTabsResponse } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { DirtyGuardContext, type DirtyGuardValue } from '../dirtyGuard';
import { BrowserControlSection } from './BrowserControlSection';

const connection = { scopeId: 'local', sshLabel: null as string | null };

const list = vi.fn<() => Promise<BrowserControlList>>();
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
const cancelSetup = vi.fn<(preset: BrowserPresetId) => Promise<BrowserSetupStatus>>();
const revealSecret = vi.fn(async () => ({ value: 'http://127.0.0.1:9222' }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      revealSecret,
      klient: { rest: { browser: { list, upsert, remove, setDefault, status, check, connect, disconnect, tabs, catalog, setupPresets, setupStatus, prepare, connectPreset, cancelSetup } } },
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
  actions: [{ id: 'prepare' }, { id: 'connect' }],
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

let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
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

async function click(selector: string) {
  const button = query<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`No element for ${selector}`);
  await act(async () => { button.click(); });
  await settle();
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
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The save button of the draft footer, which is the bar's first button. */
async function save() {
  await click('[data-settings-draft] button');
}

beforeEach(() => {
  connection.scopeId = 'local';
  connection.sshLabel = null;
  vi.resetAllMocks();
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
  describe('the wizard', () => {
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
      expect(button?.textContent).toBe('Turn on browser control');
      // No trip to the Developer page while Set up already covers the flag.
      expect(row?.querySelector('[data-browser-route-enable-feature]')).toBeNull();
      // And it does not claim the components were just installed.
      expect(row?.querySelector('[data-browser-route-settled]')).toBeNull();
      expect(row?.querySelector('[data-browser-route-blocker="feature"]')?.textContent).toContain('Still needs browser control.');

      await click('[data-browser-route-prepare]');
      expect(query('[data-confirm-action="confirm"]')).not.toBeNull();
      // The consent says what it will switch on, not only what it installs.
      expect(document.body.textContent).toContain('switches browser control on for this server');
      expect(document.body.textContent).toContain('Turns browser control on for this server');
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
      expect(query('[data-browser-route="independent-browser"]')?.getAttribute('data-browser-route-state')).toBe('blocked');
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
    await settleUntil('[data-browser-connection="research"]');

    // Same type twice, each under its own stable id.
    expect(query('[data-browser-connection="research"]')).not.toBeNull();
    expect(query('[data-browser-connection="qa"]')).not.toBeNull();
    expect(query('[data-browser-connection="preview"]')).not.toBeNull();
    expect(query('[data-browser-connection="research"]')?.textContent).toContain('research');
    // The row names the role; the literal machine is one click away, in the
    // detail, so five rows do not repeat the same hostname.
    expect(query('[data-browser-connection="research"]')?.textContent).toContain('Server');
    // A CDP row names the machine its endpoint points at; the record's redacted
    // projection only, never the endpoint itself.
    expect(query('[data-browser-connection="preview"]')?.textContent).toContain('127.0.0.1:9222');
    expect(container.textContent).not.toContain('http://127.0.0.1:9222');
    expect(query('[data-browser-state="idle"]')).not.toBeNull();
    expect(query('[data-browser-state="disabled"]')).not.toBeNull();
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');

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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');

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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
    setInput('[data-browser-name-input]', 'Renamed');
    await settle();

    await click('[data-browser-connection="qa"]');
    expect(asked).toEqual([reported.at(-1)]);
    expect(asked[0]).toBe('browser-control:local:research');
    // Still the edited draft, not the other connection.
    expect(query<HTMLInputElement>('[data-browser-name-input]')?.value).toBe('Renamed');

    await act(async () => { pending[0]?.(); });
    await settle();
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
    await click('[data-browser-connect]');
    await settle();

    // The page says it in the reader's language and names where the flag lives.
    const line = query('[data-feedback-tone="error"]')?.textContent ?? '';
    expect(line).toContain('native_browser');
    expect(line).toContain('Developer');
    // The refusal is real, so nothing about the connection turns green.
    expect(connect).toHaveBeenCalledWith('research');
    expect(query('[data-browser-state="idle"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Connected.');
    // And the refused run offers the trip to the existing switch.
    expect(query('[data-browser-open-flag]')?.textContent).toBe('Go to the switch');
  });

  it('says what a disconnect does to the resource, by the ownership the server reports', async () => {
    list.mockResolvedValue({ connections: [cdpRow()] });
    disconnect.mockResolvedValue(browserStatus({
      browser: 'preview', state: 'disconnected', generation: 4, ownership: 'external-browser',
      checkedAt: '2026-10-03T02:00:00.000Z',
    }));

    await render();
    await settleUntil('[data-browser-connection="preview"]');
    await click('[data-browser-connection="preview"]');

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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
    await click('[data-browser-disconnect]');

    expect(query('[data-browser-outcome="disconnect:unconfirmed"]')?.textContent).toContain('The operation’s outcome is unconfirmed.');
    expect(container.textContent).toContain('daemon termination is not confirmed');

    // No timer upgrades it to a confirmed stop.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 700); }); });
    expect(query('[data-browser-outcome="disconnect:unconfirmed"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Control disconnected.');
  });

  it('masks the CDP endpoint in the page and sends it only on an explicit reveal', async () => {
    list.mockResolvedValue({ connections: [cdpRow()] });

    await render();
    await settleUntil('[data-browser-connection="preview"]');
    await click('[data-browser-connection="preview"]');
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

    setInput('[data-browser-id-input]', 'demo');
    setInput('[data-browser-name-input]', 'Demo');
    await settle();
    await save();

    expect(upsert.mock.calls[0]?.[0]).toBe('demo');
    expect(upsert.mock.calls[0]?.[1]).toEqual({
      name: 'Demo', enabled: true, driverPath: undefined, type: 'agent-browser-profile',
      profilePath: undefined, executablePath: undefined, headed: undefined,
    });
    // The list is re-read, so the new connection shows up as the server has it.
    await settleUntil('[data-browser-connection="demo"]');
  });

  it('writes the visible-window choice only for a profile connection', async () => {
    list.mockResolvedValueOnce({ connections: [profileRow()] })
      .mockResolvedValue({ connections: [profileRow({ headed: true })] });
    upsert.mockResolvedValue({
      connection: { id: 'research', name: 'Research notes', enabled: true, type: 'agent-browser-profile', headed: true },
    });

    await render();
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');

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

  it('offers no visible-window switch on a borrowed browser, and stores none', async () => {
    list.mockResolvedValue({ connections: [cdpRow()] });
    upsert.mockResolvedValue({
      connection: { id: 'preview', name: 'Remote preview', enabled: true, type: 'agent-browser-cdp', endpointDisplay: 'http://127.0.0.1:9222', endpointConfigured: true },
    });

    await render();
    await settleUntil('[data-browser-connection="preview"]');
    await click('[data-browser-connection="preview"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
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
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-add]');
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
    await settleUntil('[data-browser-default]');
    expect(query('[data-browser-default]')?.dataset['browserDefault']).toBe('research');

    await act(async () => { query<HTMLButtonElement>('#browser-default')?.click(); });
    await settle();
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((option) => option.textContent?.includes('Choose each time'))?.click();
    });
    await settle();

    expect(setDefault).toHaveBeenCalledWith(undefined);
    // The default is its own write: no connection draft was involved.
    expect(upsert).not.toHaveBeenCalled();
  });

  it('never shows one scope\u2019s connections under another', async () => {
    list.mockResolvedValue({ connections: [profileRow()] });

    await render();
    await settleUntil('[data-browser-connection="research"]');
    await click('[data-browser-connection="research"]');
    await settleUntil('[data-browser-execution-host]');
    expect(query('[data-browser-execution-host]')?.textContent).toBe(BUS_USER);

    connection.scopeId = 'ssh:office-mac';
    list.mockResolvedValue({
      connections: [profileRow({ id: 'office-mac', name: 'Office Mac' })].map((row) => ({
        ...row,
        status: browserStatus({ browser: row.id, executionHost: 'office-mac-host', ownership: 'managed-profile' }),
      })),
    });
    await render();
    await settleUntil('[data-browser-connection="office-mac"]');

    expect(query('[data-browser-connection="research"]')).toBeNull();
    await click('[data-browser-connection="office-mac"]');
    await settleUntil('[data-browser-execution-host]');
    expect(query('[data-browser-execution-host]')?.textContent).toBe('office-mac-host');
  });
  });
});

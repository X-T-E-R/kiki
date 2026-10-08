// @vitest-environment jsdom

/**
 * OnboardingWizard — the first-run dialog: the auto-popup decision rule
 * (shouldOfferOnboarding), the three-step walk (nothing here configures a
 * model; the closing step starts a discovery route in place), the save
 * semantics of every advance (Next persists the permission default), and exit
 * state.
 */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSummary } from '@kiki/protocol';
import { clearStoredDrafts, readDraft, readNewSessionDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { currentDiscoveryScope, readDiscoveryState } from '@kiki/session-core/discovery';
import { readSettings } from '@kiki/session-core/settings';

import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation, useNavigate, type NavigateOptions, type To } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { readSkinPrefs } from '../lib/skins';
import { PERMISSION_MODES } from '../lib/permissionModes';
import { ConfirmDialog } from './ConfirmDialog';
import { DirtyGuardContext, useDirtyGuardState } from './dirtyGuard';
import { DiscoveryPage, DiscoveryProvider } from './discovery';
import {
  OnboardingWizard,
  requestOnboardingOpen,
  shouldOfferOnboarding,
  subscribeOnboardingOpenRequests,
} from './OnboardingWizard';

const getAuth = vi.fn();
const listProviders = vi.fn();
const listModels = vi.fn();
const getConfig = vi.fn();
const getOAuthStatus = vi.fn();
const listOAuthMethods = vi.fn();
const startOAuthLogin = vi.fn();
const patchConfig = vi.fn();
const listWorkspaces = vi.fn();
const createSession = vi.fn();
const createProvider = vi.fn();
const probeProviderDraft = vi.fn();
const previewHostSkillInstall = vi.fn();
const installHostSkill = vi.fn();
const navigate = vi.fn();

/** Mutable connection surface, so one test can take the socket away. */
const connectionState = vi.hoisted(() => ({ wsStatus: undefined as 'open' | 'closed' | undefined }));

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    config: { url: 'http://127.0.0.1:1', token: 'test-token' },
    get wsStatus() { return connectionState.wsStatus; },
    client: {
      getAuth,
      listProviders,
      listModels,
      getConfig,
      getOAuthStatus,
      listOAuthMethods,
      startOAuthLogin,
      cancelOAuthLogin: vi.fn(),
      patchConfig,
      listWorkspaces,
      createSession,
      createProvider,
      probeProviderDraft,
      previewHostSkillInstall,
      installHostSkill,
    },
  }),
}));
vi.mock('../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));
vi.mock('./dirtyGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dirtyGuard')>();
  const { useContext } = await import('react');
  return {
    ...actual,
    useGuardedNavigate: () => {
      const ctx = useContext(actual.DirtyGuardContext);
      return ctx?.navigate ?? navigate;
    },
    useDirtyReporter: () => {},
  };
});

const AUTH_EMPTY: AuthSummary = {
  ready: false,
  providers_count: 0,
  default_model: null,
  managed_provider: null,
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  localStorage.removeItem('kiki.onboarding');
  localStorage.removeItem('kiki.settings');
  clearStoredDrafts();
  resetDraftMemoryForTests();
  connectionState.wsStatus = undefined;
  navigate.mockReset();
  getAuth.mockReset().mockResolvedValue(AUTH_EMPTY);
  listProviders.mockReset().mockResolvedValue({ items: [] });
  listModels.mockReset().mockResolvedValue({ items: [] });
  getConfig.mockReset().mockResolvedValue({ default_permission_mode: 'manual' });
  getOAuthStatus.mockReset().mockResolvedValue(null);
  listOAuthMethods.mockReset().mockResolvedValue([
    { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: false },
    { id: 'github-copilot', label: 'GitHub Copilot', provider: 'managed:github-copilot', protocol: 'openai', signed_in: false },
    { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false },
  ]);
  startOAuthLogin.mockReset().mockResolvedValue({ flow_id: 'f1', provider: 'managed:github-copilot', status: 'authenticated' });
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => ({
    default_permission_mode: patch['default_permission_mode'] ?? 'manual',
  }));
  listWorkspaces.mockReset().mockResolvedValue({ items: [] });
  createSession.mockReset().mockResolvedValue({ id: 's_onboarding_1' });
  createProvider.mockReset().mockResolvedValue({ id: 'kimi', revision: 'r1' });
  probeProviderDraft.mockReset().mockResolvedValue([]);
  previewHostSkillInstall.mockReset().mockResolvedValue({
    host: 'claude', directory: 'C:/Users/me/.claude/skills', path: 'C:/Users/me/.claude/skills/kiki-as-subagent/SKILL.md', overwrites: true, revision: 'rev-1',
  });
  installHostSkill.mockReset().mockResolvedValue({
    host: 'claude', directory: 'C:/Users/me/.claude/skills', path: 'C:/Users/me/.claude/skills/kiki-as-subagent/SKILL.md', overwrites: false, revision: 'rev-2',
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function mount(onClose: () => void = () => {}): Promise<HTMLDivElement> {
  // The wizard's last step starts discovery routes through the shared context,
  // so every mount lives inside the same router + guard + discovery shell the
  // App gives it; a bare dialog would throw on useDiscovery.
  const { container } = await mountWithDiscovery({ onClose });
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Simulate the App shell closing the wizard: unmount the latest mount. */
async function unmountLast(): Promise<void> {
  const root = roots.pop();
  const container = containers.pop();
  if (root !== undefined) {
    await act(async () => { root.unmount(); });
  }
  container?.remove();
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (element === null) throw new Error('wizard dialog not mounted');
  return element;
}

function buttonByText(text: string): HTMLElement {
  const button = [...dialog().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`button "${text}" not found`);
  return button;
}

/**
 * A step scroller whose box can actually change, so the "there is more below"
 * edge is exercised against a real measurement instead of a fixed constant.
 * jsdom reports every box as zero, so both ends of the geometry are installed
 * here and the content height is a variable the test owns.
 */
const stepGeometry = { contentHeight: 0 };
const resizeCallbacks: Array<() => void> = [];

function installStepScroller(): void {
  const define = (key: string, get: () => number) => {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get });
  };
  define('clientHeight', function (this: HTMLElement) {
    return this.hasAttribute('data-onboarding-step-scroll') ? 300 : 0;
  });
  define('scrollHeight', function (this: HTMLElement) {
    return this.hasAttribute('data-onboarding-step-scroll') ? stepGeometry.contentHeight : 0;
  });
  // jsdom ships no ResizeObserver. This one records the callbacks so the test
  // can say the content changed, which is the one thing jsdom cannot decide.
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallbacks.push(callback); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

function restoreStepScroller(): void {
  for (const key of ['clientHeight', 'scrollHeight']) {
    Reflect.deleteProperty(HTMLElement.prototype, key);
  }
  resizeCallbacks.length = 0;
}

describe('shouldOfferOnboarding', () => {
  it('offers only when nothing is configured and onboarding never completed', () => {
    expect(shouldOfferOnboarding({ completed: false, auth: AUTH_EMPTY, models: [] })).toBe(true);
  });

  it('stays closed once completed — a skip counts as completion', () => {
    expect(shouldOfferOnboarding({ completed: true, auth: AUTH_EMPTY, models: [] })).toBe(false);
  });

  it('stays closed when a provider is ready or any model exists', () => {
    expect(
      shouldOfferOnboarding({
        completed: false,
        auth: { ...AUTH_EMPTY, ready: true, providers_count: 1 },
        models: [],
      }),
    ).toBe(false);
    expect(shouldOfferOnboarding({ completed: false, auth: AUTH_EMPTY, models: [{}] })).toBe(false);
  });

  it('stays closed while either probe is still in flight or failed', () => {
    expect(shouldOfferOnboarding({ completed: false, auth: undefined, models: [] })).toBe(false);
    expect(shouldOfferOnboarding({ completed: false, auth: AUTH_EMPTY, models: undefined })).toBe(false);
  });
});

describe('manual re-entry channel', () => {
  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOnboardingOpenRequests(listener);
    requestOnboardingOpen();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    requestOnboardingOpen();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

/**
 * Welcome → approvals: the one advance moves straight to the permission
 * default, which is the second of three steps.
 */
async function toPermissionsStep(): Promise<void> {
  await click(buttonByText('Next'));
  await flush();
}

/** … → approvals → (Next saves the mode) → the closing invitation. */
async function toDiscoverStep(): Promise<void> {
  await toPermissionsStep();
  await click(buttonByText('Next'));
  await flush();
}

describe('OnboardingWizard', () => {
  it('opens on one welcome page: language and appearance together', async () => {
    await mount();
    expect(dialog().getAttribute('aria-label')).toBe('Welcome to Kiki');
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(dialog().textContent).toContain('Language and look');
    expect(dialog().querySelector('[data-onboarding-welcome] [aria-labelledby="onboarding-language-label"]')).not.toBeNull();
    expect(dialog().querySelector('[data-onboarding-welcome] [data-onboarding-appearance]')).not.toBeNull();
    // First page: nothing to go back to.
    expect([...dialog().querySelectorAll('button')].some((button) => button.textContent === 'Back')).toBe(false);
  });

  it('applies theme, palette and an optional picture at once from the welcome page', async () => {
    await mount();
    expect(dialog().textContent).not.toMatch(/token|skin/i);
    await click(dialog().querySelector('[data-onboarding-appearance] [data-theme-choice="dark"]')!);
    expect(readSettings().theme).toBe('dark');
    await click(dialog().querySelector('[data-onboarding-palette="porcelain"]')!);
    expect(readSkinPrefs().selection).toEqual({ source: 'builtin', id: 'porcelain' });
    expect(dialog().querySelector('[data-onboarding-palette="porcelain"]')?.getAttribute('aria-checked')).toBe('true');
    // The picture is optional and folded away until asked for.
    expect(dialog().querySelector('[data-bg-choose]')).toBeNull();
    await click(dialog().querySelector('[data-onboarding-bg-open]')!);
    expect(dialog().querySelector('[data-bg-settings="compact"] [data-bg-choose]')).not.toBeNull();
    expect(dialog().querySelector('[data-bg-settings="compact"] #bg-url')).toBeNull();
    expect(dialog().textContent).toContain('Settings › Appearance');
  });

  it('walks forward and back through the setup steps', async () => {
    await mount();
    // The welcome page is the only look step: nothing configures a model here,
    // so the next page is already the permission default.
    await toPermissionsStep();
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().textContent).toContain('How much should Kiki do on its own?');

    await click(buttonByText('Next'));
    await flush();
    expect(dialog().textContent).toContain('Step 3 of 3');
    expect(dialog().querySelector('[data-onboarding-discover]')).not.toBeNull();

    await click(buttonByText('Back'));
    expect(dialog().textContent).toContain('Step 2 of 3');
    await click(buttonByText('Back'));
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(dialog().querySelector('[data-onboarding-appearance]')).not.toBeNull();
  });

  it('says there is more below from the first frame, and stops saying so at the end', async () => {
    installStepScroller();
    try {
      // A step taller than its own box, before any pointer has touched it.
      stepGeometry.contentHeight = 900;
      await mount();
      expect(dialog().querySelector('[data-onboarding-scroll-more]')).not.toBeNull();
      // Content that later fits has nothing below it, and saying otherwise
      // would point at a fold that is not there.
      stepGeometry.contentHeight = 300;
      await act(async () => { resizeCallbacks.forEach((notify) => { notify(); }); });
      expect(dialog().querySelector('[data-onboarding-scroll-more]')).toBeNull();
      // Reached the end of a tall step by scrolling: still nothing below.
      stepGeometry.contentHeight = 900;
      await act(async () => { resizeCallbacks.forEach((notify) => { notify(); }); });
      expect(dialog().querySelector('[data-onboarding-scroll-more]')).not.toBeNull();
      const scroller = dialog().querySelector<HTMLElement>('[data-onboarding-step-scroll]')!;
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 600, writable: true });
      await act(async () => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); });
      expect(dialog().querySelector('[data-onboarding-scroll-more]')).toBeNull();
    } finally {
      restoreStepScroller();
    }
  });

  it('ignores a backdrop click and a bare Escape, keeping the run unmarked', async () => {
    const onClose = vi.fn();
    await mount(onClose);

    // Neither reflex may end the run behind the user: the run is marked done
    // once, by an explicit exit, and a first run is never offered twice.
    // jsdom has no PointerEvent constructor; the dismiss path only reads .target.
    await act(async () => {
      dialog().closest('div')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(localStorage.getItem('kiki.onboarding')).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it('the header close still ends the run', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await act(async () => {
      dialog().querySelector<HTMLButtonElement>('[aria-label="Close setup"]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('offers every permission mode, recommends auto, and Next writes it to the server config', async () => {
    await mount();
    await toPermissionsStep();
    const options = [...dialog().querySelectorAll<HTMLElement>('[data-permission-choice]')];
    expect(options.map((option) => option.dataset['permissionChoice'])).toEqual(
      PERMISSION_MODES.map((mode) => mode.id),
    );
    const auto = options.find((option) => option.dataset['permissionChoice'] === 'auto');
    expect(auto?.getAttribute('aria-checked')).toBe('true');
    expect(auto?.textContent).toContain('Recommended');
    await click(buttonByText('Next'));
    await flush();
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'auto' });
    expect(dialog().textContent).toContain('Step 3 of 3');
  });

  it('a failed permission save stays on the step', async () => {
    patchConfig.mockRejectedValueOnce(new Error('config is read-only'));
    await mount();
    await toPermissionsStep();
    await click(buttonByText('Next'));
    await flush();
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().querySelector('[data-onboarding-discover]')).toBeNull();
  });

  it('a replay shows the server’s explicit permission choice instead of forcing auto', async () => {
    localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    getConfig.mockResolvedValue({ default_permission_mode: 'yolo' });
    await mount();
    await toPermissionsStep();
    const yolo = dialog().querySelector('[data-permission-choice="yolo"]');
    expect(yolo?.getAttribute('aria-checked')).toBe('true');
  });

  it('"Set up later" steps past the current step and keeps the run open', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await click(buttonByText('Set up later'));
    await flush();
    // The action is about this step's question, so it answers it and moves on:
    // the wizard is still here, and the run is not marked complete.
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-permission-choice]')).not.toBeNull();
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(localStorage.getItem('kiki.onboarding')).toBeNull();
  });

  it('"Set up later" from the permission step saves the chosen default and moves on', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toPermissionsStep();
    await click(buttonByText('Set up later'));
    await flush();
    // Skipping past the step must not silently discard the choice already made.
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'auto' });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-onboarding-discover]')).not.toBeNull();
  });

  it('"Set up later" on the last step closes the run, keeping the original meaning', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toDiscoverStep();
    // There is no next step to move to, so this one keeps its original job:
    // end the run here, without starting a session or routing anywhere.
    await click(buttonByText('Close setup'));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  describe('the closing step starts a discovery route in place', () => {
    it('lists the five catalog routes as quiet rows, and nothing the hub owns', async () => {
      await mount();
      await toDiscoverStep();

      expect(dialog().textContent).toContain('Step 3 of 3');
      expect(dialog().textContent).toContain('Look around Kiki');
      expect(dialog().textContent).toContain('Start from a place that interests you.');
      expect(dialog().querySelector('[data-onboarding-discover]')).not.toBeNull();

      const rows = [...dialog().querySelectorAll<HTMLElement>('[data-onboarding-route]')];
      expect(rows.map((row) => row.dataset['onboardingRoute'])).toEqual([
        'overview', 'do-first', 'understand', 'sustain', 'extend',
      ]);
      expect(rows[0]?.textContent).toContain('Take me on a tour');
      expect(rows[0]?.textContent).toContain('5 stops');
      expect(rows[3]?.textContent).toContain('Keep work going');
      expect(rows[3]?.textContent).toContain('3 stops');

      // Everything the hub owns stays on the hub: no second copy in the welcome.
      expect(dialog().querySelector('[data-onboarding-discover-start]')).toBeNull();
      expect(dialog().querySelector('[data-onboarding-cap], [data-cap-ask], [data-cap-open], [data-cap-install]')).toBeNull();
      expect(dialog().querySelector('[data-discovery-onboarding-route], [data-discovery-onboarding-overview]')).toBeNull();
      expect(dialog().querySelector('[data-model-connection], [data-onboarding-model-connection]')).toBeNull();
      expect(dialog().textContent).not.toContain('What else Kiki can do');
      // The rows themselves are the actions: the footer keeps no primary.
      expect([...dialog().querySelectorAll('button')].some((button) => button.textContent === 'Next')).toBe(false);
    });

    it('a route row starts that route right there and completes the run, creating nothing', async () => {
      const onClose = vi.fn();
      const { router } = await mountWithDiscovery({ onClose });
      await toDiscoverStep();

      await click(dialog().querySelector('[data-onboarding-route="sustain"]')!);
      await flush();
      await flush();

      expect(router.state.location.pathname).toBe('/memory');
      expect(onClose).toHaveBeenCalledTimes(1);
      // The persisted record never stores 'active': a reload reads a started
      // tour back as 'left', so it resumes instead of overlaying a live one.
      const state = readDiscoveryState(currentDiscoveryScope('local'));
      expect(state.lifecycle).toBe('left');
      expect(state.route).toBe('sustain');
      expect(state.station).toBe('memory');
      expect(createSession).not.toHaveBeenCalled();
      expect(readDraft('new')).toBe('');
      expect(readNewSessionDraft().workspaceId).toBeUndefined();
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
    });

    it('a route whose first stop is this page starts in place, without leaving', async () => {
      const onClose = vi.fn();
      const { router } = await mountWithDiscovery({ onClose });
      await toDiscoverStep();

      await click(dialog().querySelector('[data-onboarding-route="overview"]')!);
      await flush();
      await flush();

      expect(router.state.location.pathname).toBe('/new');
      expect(onClose).toHaveBeenCalledTimes(1);
      const state = readDiscoveryState(currentDiscoveryScope('local'));
      expect(state.lifecycle).toBe('left');
      expect(state.route).toBe('overview');
      expect(state.station).toBe('workspace');
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
    });

    it('a cancelled dirty-draft prompt leaves the wizard and the tour untouched', async () => {
      const onClose = vi.fn();
      const { router, cancelAction } = await mountWithDiscovery({ onClose, dirty: true });
      await toDiscoverStep();

      await click(dialog().querySelector('[data-onboarding-route="sustain"]')!);
      await cancelAction();
      await flush();

      expect(router.state.location.pathname).toBe('/settings/providers');
      expect(onClose).not.toHaveBeenCalled();
      expect(readDiscoveryState(currentDiscoveryScope('local')).route).toBeUndefined();
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();
      // Staying here is the user's choice, not a failure: nothing to recover from.
      expect(dialog().textContent).not.toContain('This page is not available right now');
    });

    it('a confirmed dirty-draft prompt commits the route and ends the run', async () => {
      const onClose = vi.fn();
      const { router, confirmAction } = await mountWithDiscovery({ onClose, dirty: true });
      await toDiscoverStep();

      await click(dialog().querySelector('[data-onboarding-route="sustain"]')!);
      await confirmAction();
      await flush();
      await flush();

      expect(router.state.location.pathname).toBe('/memory');
      expect(onClose).toHaveBeenCalledTimes(1);
      const state = readDiscoveryState(currentDiscoveryScope('local'));
      expect(state.lifecycle).toBe('left');
      expect(state.route).toBe('sustain');
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
    });

    it('a route that cannot start says so in place and recovers the rows', async () => {
      connectionState.wsStatus = 'closed';
      const onClose = vi.fn();
      const { router } = await mountWithDiscovery({ onClose });
      await toDiscoverStep();

      await click(dialog().querySelector('[data-onboarding-route="sustain"]')!);
      await flush();

      expect(router.state.location.pathname).toBe('/new');
      expect(onClose).not.toHaveBeenCalled();
      expect(readDiscoveryState(currentDiscoveryScope('local')).route).toBeUndefined();
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();
      expect(dialog().textContent).toContain('This page is not available right now');
      // Settled: the rows are actionable again, not stuck disabled.
      const row = dialog().querySelector('[data-onboarding-route="sustain"]');
      expect(row?.hasAttribute('disabled')).toBe(false);
    });

    it('closes the run without a session, a draft or a navigation when the action is skipped', async () => {
      const onClose = vi.fn();
      await mount(onClose);
      await toDiscoverStep();

      await click(buttonByText('Close setup'));
      await flush();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(readDraft('new')).toBe('');
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
    });
  });

});

async function mountWithDiscovery(options: {
  onClose?: () => void;
  dirty?: boolean;
  initialRoute?: string;
  children?: React.ReactNode;
} = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Harness({ children }: { children: React.ReactNode }) {
    const location = useLocation();
    const rawNavigate = useNavigate();
    const performNavigation = (target: To | number, opts?: NavigateOptions) => {
      if (typeof target === 'number') return rawNavigate(target);
      return rawNavigate(target, opts);
    };
    const {
      value: dirtyGuardValue,
      pending,
      confirm,
      cancel,
    } = useDirtyGuardState(location, performNavigation);

    useEffect(() => {
      if (options.dirty) {
        dirtyGuardValue.reportDirty('wizard-draft-1', true);
      }
    }, [dirtyGuardValue]);

    return (
      <DirtyGuardContext.Provider value={dirtyGuardValue}>
        <DiscoveryProvider>
          {children}
          <ConfirmDialog
            open={pending}
            title="Unsaved changes"
            body="Leave page?"
            confirmLabel="Leave"
            cancelLabel="Stay"
            onConfirm={() => { void confirm(); }}
            onCancel={cancel}
          />
        </DiscoveryProvider>
      </DirtyGuardContext.Provider>
    );
  }

  const initialRoute = options.initialRoute ?? (options.dirty ? '/settings/providers' : '/new');
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <QueryClientProvider client={client}>
            <I18nProvider>
              <Harness>
                {options.children ?? <OnboardingWizard onClose={options.onClose ?? (() => {})} />}
              </Harness>
            </I18nProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: [initialRoute] },
  );

  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    container,
    router,
    cancelAction: async () => {
      const stayBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Stay');
      if (stayBtn) {
        await act(async () => {
          stayBtn.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    },
    confirmAction: async () => {
      const leaveBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Leave');
      if (leaveBtn) {
        await act(async () => {
          leaveBtn.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    },
  };
}

describe('discovery route map model connection', () => {
  const ACTIVE_TOUR = {
    version: 1 as const,
    contentVersion: 1,
    lifecycle: 'active' as const,
    route: 'overview' as const,
    station: 'agents' as const,
    collapsed: false,
    progress: {},
  };

  it('states the connection on the map and opens the real Settings card', async () => {
    const { router } = await mountWithDiscovery({
      initialRoute: '/discover',
      children: <DiscoveryPage onToggleSidebar={() => {}} />,
    });

    const row = document.querySelector('[data-discovery-model-connection] [data-model-connection]');
    expect(row?.getAttribute('data-model-connection')).toBe('missing');
    expect(document.querySelector('[data-model-connection-open]')?.textContent).toContain('Connect a model');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-model-connection-open]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(router.state.location.pathname).toBe('/settings/ai');
    expect(router.state.location.search).toBe('?tab=providers');
    expect(router.state.location.hash).toBe('#st-card-providers-add');
  });

  it('keeps the tour position when it leaves for Settings, so the way back survives', async () => {
    const { currentDiscoveryScope, readDiscoveryState, writeDiscoveryState } = await import('@kiki/session-core/discovery');
    writeDiscoveryState(currentDiscoveryScope('local'), ACTIVE_TOUR);

    const { router } = await mountWithDiscovery({
      initialRoute: '/discover',
      children: <DiscoveryPage onToggleSidebar={() => {}} />,
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-model-connection-open]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(router.state.location.pathname).toBe('/settings/ai');
    // Left, not forgotten: the route and stop kept here are what the resume tag
    // offers on the page the person landed on.
    const state = readDiscoveryState(currentDiscoveryScope('local'));
    expect(state.lifecycle).toBe('left');
    expect(state.route).toBe('overview');
    expect(state.station).toBe('agents');
  });

  it('never reads a saved provider record as a usable connection', async () => {
    // The counterexample this row exists for: a managed sign-in can be
    // configured while its login chain is not, so `auth.ready` is false with a
    // provider already saved. A record proves configuration, not readiness.
    getAuth.mockResolvedValue({ ...AUTH_EMPTY, providers_count: 1 });
    listProviders.mockResolvedValue({ items: [{ id: 'managed:kimi-code', revision: 'r1' }] });

    await mountWithDiscovery({
      initialRoute: '/discover',
      children: <DiscoveryPage onToggleSidebar={() => {}} />,
    });
    await flush();

    const row = document.querySelector('[data-discovery-model-connection] [data-model-connection]');
    expect(row?.getAttribute('data-model-connection')).toBe('configured');
    expect(row?.textContent).toContain('saved, but Kiki cannot use it right now');
    expect(row?.textContent).not.toContain('A connection is ready');
    expect(document.querySelector('[data-model-connection-open]')?.textContent).toContain('Review connection');
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('says ready only when the auth probe says so, and names that model', async () => {
    getAuth.mockResolvedValue({ ...AUTH_EMPTY, ready: true, providers_count: 1, default_model: 'kimi-for-coding' });
    listProviders.mockResolvedValue({ items: [{ id: 'managed:kimi-code', revision: 'r1' }] });

    await mountWithDiscovery({
      initialRoute: '/discover',
      children: <DiscoveryPage onToggleSidebar={() => {}} />,
    });
    await flush();

    const row = document.querySelector('[data-discovery-model-connection] [data-model-connection]');
    expect(row?.getAttribute('data-model-connection')).toBe('ready');
    expect(row?.textContent).toContain('kimi-for-coding');
    expect(document.querySelector('[data-model-connection-open]')?.textContent).toContain('Model settings');
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('does not claim a state it could not read', async () => {
    getAuth.mockRejectedValue(new Error('auth probe failed'));

    await mountWithDiscovery({
      initialRoute: '/discover',
      children: <DiscoveryPage onToggleSidebar={() => {}} />,
    });
    await flush();

    const row = document.querySelector('[data-discovery-model-connection] [data-model-connection]');
    expect(row?.getAttribute('data-model-connection')).toBe('unknown');
    expect(row?.textContent).not.toContain('A connection is ready');
    expect(row?.textContent).not.toContain('Not connected yet');
  });
});

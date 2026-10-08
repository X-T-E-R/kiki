// @vitest-environment jsdom

/**
 * OnboardingWizard — the first-run dialog: the auto-popup decision rule
 * (shouldOfferOnboarding), the three-step walk (nothing here configures a
 * model: the guide states the current connection and opens the real Settings
 * card that owns it), the save semantics of every advance (finish persists the
 * permission default), exit state, and the finish hand-off (/new hero with its
 * own target default, nothing prefilled or sent).
 */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSummary } from '@kiki/protocol';
import { clearStoredDrafts, readDraft, readNewSessionDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
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

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    config: { url: 'http://127.0.0.1:1', token: 'test-token' },
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
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <OnboardingWizard onClose={onClose} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

/** … → approvals → (Next saves the mode) → the guide. */
async function toCapabilitiesStep(): Promise<void> {
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
    expect(dialog().querySelector('[data-onboarding-discovery-section]')).not.toBeNull();

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
    expect(dialog().querySelector('[data-onboarding-capabilities]')).toBeNull();
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
    expect(dialog().querySelector('[data-onboarding-capabilities]')).not.toBeNull();
  });

  it('"Set up later" on the last step closes the run, keeping the original meaning', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    // There is no next step to move to, so this one keeps its original job:
    // end the run here, without starting a session or routing anywhere.
    await click(buttonByText('Close setup'));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('"Get started with Kiki" opens the guided first-run session with a short request waiting, and sends nothing', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    expect(dialog().querySelector('[data-workspace-choice]')).toBeNull();
    await click(buttonByText('Get started with Kiki'));
    await flush();
    // No workspace address: the server gives the session a new folder in Kiki Home.
    expect(createSession).toHaveBeenCalledWith({});
    expect(createSession).toHaveBeenCalledTimes(1);
    const draft = readDraft('s_onboarding_1');
    // The composer is what the user reads before sending, so it names the skill
    // and asks for one thing at a time; the rest lives in the skill, not here.
    expect(draft).toMatch(/^\/kiki-ops /);
    expect(draft).toMatch(/one question at a time/i);
    // The first run is about the user's task, not about Kiki's settings: the
    // request asks what they want done, and only says what the run may set up.
    expect(draft).toMatch(/what I most want to get done/i);
    expect(draft).toMatch(/set up whatever that step needs/i);
    expect(draft).toMatch(/leave what already works alone/i);
    // Explore's model and agent profiles are the skill's job, asked at the
    // moment the run needs them — never part of the opening request.
    expect(draft).not.toMatch(/explore/i);
    expect(draft).not.toMatch(/agent profile|first agent/i);
    expect(draft.length).toBeLessThan(260);
    expect(navigate).toHaveBeenCalledWith('/s/s_onboarding_1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('prefills the exact Chinese first-task welcome without submitting a prompt', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    await mount();
    await click(buttonByText('下一步'));
    await flush();
    await click(buttonByText('下一步'));
    await flush();
    await click(buttonByText('让 Kiki 带你上手'));
    await flush();
    expect(createSession).toHaveBeenCalledExactlyOnceWith({});
    expect(readDraft('s_onboarding_1')).toBe('/kiki-ops 用两三句话告诉我你能做什么，再问我现在最想完成哪件事，带我真做一次：这一步需要哪个能力就顺手配上，已经能用的设置保持原样。一次只问一个问题。');
    expect(navigate).toHaveBeenCalledWith('/s/s_onboarding_1');
  });

  it('never overwrites a draft the user already typed elsewhere', async () => {
    const { writeDraft } = await import('@kiki/session-core/composer');
    writeDraft('new', 'half-typed thought');
    writeDraft('s_other', 'another session in progress');
    await mount();
    await toCapabilitiesStep();
    await click(buttonByText('Get started with Kiki'));
    await flush();
    expect(readDraft('new')).toBe('half-typed thought');
    expect(readDraft('s_other')).toBe('another session in progress');
  });

  it('a rejected create leaves the wizard open, unmarked, and the same button retries', async () => {
    createSession.mockRejectedValueOnce(new Error('server offline'));
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(buttonByText('Get started with Kiki'));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // Not marked complete: the auto-popup must still be able to fire for a run
    // that never reached its own hand-off.
    expect(localStorage.getItem('kiki.onboarding')).toBeNull();
    expect(dialog().textContent).toContain('server offline');
    // The same button retries, and one success is one session.
    await click(buttonByText('Get started with Kiki'));
    await flush();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(readDraft('s_onboarding_1')).toMatch(/^\/kiki-ops /);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  // ── capabilities page ──────────────────────────────────────────────────

  it('lists grouped capabilities, each with a way to set it up, and walks back to approvals', async () => {
    await mount();
    await toCapabilitiesStep();
    expect(dialog().textContent).toContain('What else Kiki can do');
    const rows = [...dialog().querySelectorAll<HTMLElement>('[data-onboarding-cap]')];
    expect(rows.map((row) => row.dataset['onboardingCap'])).toEqual([
      'search', 'memory', 'ssh', 'engines', 'extensions', 'host-skill', 'cron', 'board', 'bots',
    ]);
    for (const row of rows) {
      expect(row.querySelectorAll('button').length, row.dataset['onboardingCap']).toBeGreaterThan(0);
    }
    expect(dialog().querySelectorAll('[data-onboarding-cap-group]')).toHaveLength(3);
    await click(buttonByText('Back'));
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().querySelector('[data-permission-choice]')).not.toBeNull();
  });

  it('a settings button leaves the wizard for that card', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(dialog().querySelector('[data-onboarding-cap="ssh"] [data-cap-open]')!);
    expect(navigate).toHaveBeenCalledWith('/settings/ssh#st-card-ssh-hosts');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('every settings target is a real card or route', async () => {
    const { resolveSettingsRoute } = await import('@kiki/session-core/settings');
    const { ONBOARDING_CAPABILITIES } = await import('./OnboardingCapabilitiesStep');
    const hrefs = ONBOARDING_CAPABILITIES.flatMap((group) => group.items)
      .flatMap((item) => item.actions)
      .flatMap((action) => (action.kind === 'open' ? [action.href] : []));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      if (!href.startsWith('/settings/')) {
        expect(['/board', '/cron', '/personas']).toContain(href);
        continue;
      }
      const [path, hash] = href.split('#');
      const section = path!.slice('/settings/'.length);
      const resolved = resolveSettingsRoute(section, `#${hash}`);
      expect(resolved.status, href).toBe('ok');
      expect(resolved.section, href).toBe(section);
      expect(resolved.cardId, href).toBe(hash);
    }
  });

  it('"Let Kiki set it up" creates a session with the request waiting in its composer', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(dialog().querySelector('[data-onboarding-cap="ssh"] [data-cap-ask]')!);
    await flush();
    // No workspace: the server gives the session a new folder in Kiki Home.
    expect(createSession).toHaveBeenCalledWith({});
    expect(readDraft('s_onboarding_1')).toMatch(/^\/kiki-ops .*SSH remote host/);
    expect(navigate).toHaveBeenCalledWith('/s/s_onboarding_1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('a failed "Let Kiki set it up" stays on the page with the reason', async () => {
    createSession.mockRejectedValueOnce(new Error('server offline'));
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(dialog().querySelector('[data-onboarding-cap="cron"] [data-cap-ask]')!);
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-onboarding-cap="cron"]')?.textContent).toContain('server offline');
    // The ask buttons are usable again for a retry.
    expect((dialog().querySelector('[data-cap-ask]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the skill install previews the target and writes only after confirming', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(dialog().querySelector('[data-cap-install="claude"]')!);
    await flush();
    expect(previewHostSkillInstall).toHaveBeenCalledWith('claude');
    expect(installHostSkill).not.toHaveBeenCalled();
    const installDialog = document.querySelector('[data-host-skill-dialog="ready"]')!;
    expect(installDialog.querySelector('[data-host-skill-path]')?.textContent).toContain('.claude/skills/kiki-as-subagent/SKILL.md');
    expect(installDialog.querySelector('[data-host-skill-overwrites="true"]')).not.toBeNull();
    await click(installDialog.querySelector('[data-host-skill-confirm]')!);
    await flush();
    expect(installHostSkill).toHaveBeenCalledWith('claude', 'rev-1');
    expect(document.querySelector('[data-host-skill-dialog]')).toBeNull();
    expect(dialog().querySelector('[data-onboarding-cap="host-skill"]')?.textContent).toContain('Installed for Claude Code.');
    // Installing is a side trip: the wizard stays open on its page.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancelling the skill preview writes nothing', async () => {
    await mount();
    await toCapabilitiesStep();
    await click(dialog().querySelector('[data-cap-install="codex"]')!);
    await flush();
    const cancel = [...document.querySelectorAll('[data-host-skill-dialog] button')].find((button) => button.textContent === 'Cancel')!;
    await click(cancel);
    expect(installHostSkill).not.toHaveBeenCalled();
    expect(document.querySelector('[data-host-skill-dialog]')).toBeNull();
  });

  it('the hand-off uses none of the optional rows on the capabilities page', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(buttonByText('Get started with Kiki'));
    await flush();
    expect(previewHostSkillInstall).not.toHaveBeenCalled();
    expect(installHostSkill).not.toHaveBeenCalled();
    // One session for the hand-off, not one per optional row.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closing the last step ends the run without a session, navigation or draft', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(buttonByText('Close setup'));
    await flush();
    expect(createSession).not.toHaveBeenCalled();
    // It dismisses; it does not route anywhere, so whatever the user was
    // looking at when the wizard opened is what they return to.
    expect(navigate).not.toHaveBeenCalled();
    expect(readDraft('new')).toBe('');
    // The /new draft is untouched and keeps its own default (recent workspace,
    // else a new folder in Kiki Home) for whenever they open a session there.
    expect(readNewSessionDraft().workspaceId).toBeUndefined();
    expect(readNewSessionDraft().cwd).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  describe('onboarding wizard discovery entry', () => {
    it('offers overview and four interest routes on the last capabilities step', async () => {
      await mount();
      await toCapabilitiesStep();
      expect(dialog().querySelector('[data-discovery-onboarding-overview]')).not.toBeNull();
      const routes = [...dialog().querySelectorAll('[data-discovery-onboarding-route]')].map((el) =>
        el.getAttribute('data-discovery-onboarding-route'),
      );
      expect(routes).toEqual(['do-first', 'understand', 'sustain', 'extend']);
    });

    it('starts the overview discovery route and completes onboarding when clicking take a tour', async () => {
      const { readDiscoveryState, currentDiscoveryScope } = await import('@kiki/session-core/discovery');
      const onClose = vi.fn();
      await mount(onClose);
      await toCapabilitiesStep();
      const overviewBtn = dialog().querySelector<HTMLButtonElement>('[data-discovery-onboarding-overview]')!;
      await act(async () => {
        overviewBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
      expect(navigate).toHaveBeenCalledWith('/new');
      const discState = readDiscoveryState(currentDiscoveryScope('local'));
      expect(discState.lifecycle).toBe('left');
      expect(discState.route).toBe('overview');
    });

    it('starts an interest discovery route when chosen from the capabilities step', async () => {
      const { readDiscoveryState, currentDiscoveryScope } = await import('@kiki/session-core/discovery');
      const onClose = vi.fn();
      await mount(onClose);
      await toCapabilitiesStep();
      const routeBtn = dialog().querySelector<HTMLButtonElement>('[data-discovery-onboarding-route="do-first"]')!;
      await act(async () => {
        routeBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush();
      expect(onClose).toHaveBeenCalledTimes(1);
      const discState = readDiscoveryState(currentDiscoveryScope('local'));
      expect(discState.lifecycle).toBe('left');
      expect(discState.route).toBe('do-first');
    });

    it('welcome discovery entry with mounted DiscoveryProvider commits and finishes onboarding', async () => {
      const { readDiscoveryState, currentDiscoveryScope } = await import('@kiki/session-core/discovery');
      const onClose = vi.fn();
      await mountWithDiscovery({ onClose, dirty: false });
      await toCapabilitiesStep();

      const overviewBtn = dialog().querySelector<HTMLButtonElement>('[data-discovery-onboarding-overview]')!;
      await act(async () => {
        overviewBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
      const discState = readDiscoveryState(currentDiscoveryScope('local'));
      expect(discState.lifecycle).toBe('left');
      expect(discState.route).toBe('overview');
      expect(discState.station).toBe('workspace');
    });

    it('welcome discovery entry preserves wizard and discovery state when dirty guard cancelled', async () => {
      const { readDiscoveryState, currentDiscoveryScope } = await import('@kiki/session-core/discovery');
      const onClose = vi.fn();
      const { cancelAction, router } = await mountWithDiscovery({ onClose, dirty: true });
      await toCapabilitiesStep();

      const overviewBtn = dialog().querySelector<HTMLButtonElement>('[data-discovery-onboarding-overview]')!;
      await act(async () => {
        overviewBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush();

      // Dirty guard prompt is waiting; user cancels it
      await cancelAction();
      await flush();

      // Wizard must stay open, onboarding must not be completed, discovery must not start, router must remain
      expect(router.state.location.pathname).toBe('/settings/providers');
      expect(onClose).not.toHaveBeenCalled();
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();
      const discState = readDiscoveryState(currentDiscoveryScope('local'));
      expect(discState.lifecycle).toBe('new');
    });

    it('welcome discovery entry commits when dirty guard confirmed', async () => {
      const { readDiscoveryState, currentDiscoveryScope } = await import('@kiki/session-core/discovery');
      const onClose = vi.fn();
      const { confirmAction, router } = await mountWithDiscovery({ onClose, dirty: true });
      await toCapabilitiesStep();

      const overviewBtn = dialog().querySelector<HTMLButtonElement>('[data-discovery-onboarding-overview]')!;
      await act(async () => {
        overviewBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush();

      // Prior to confirming: router has not committed and discovery has not persisted
      expect(router.state.location.pathname).toBe('/settings/providers');
      expect(readDiscoveryState(currentDiscoveryScope('local')).lifecycle).toBe('new');

      // User confirms dirty navigation
      await confirmAction();
      await flush();

      // After router commit: location is /new, wizard closed, completedAt recorded, discovery persisted
      expect(router.state.location.pathname).toBe('/new');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
      const discState = readDiscoveryState(currentDiscoveryScope('local'));
      expect(discState.lifecycle).toBe('left');
      expect(discState.route).toBe('overview');
    });
  });

  describe('the guide states the model connection', () => {
    it('reports nothing connected and opens the real Settings card', async () => {
      const onClose = vi.fn();
      await mount(onClose);
      await toCapabilitiesStep();

      const row = dialog().querySelector('[data-onboarding-model-connection] [data-model-connection]');
      expect(row?.getAttribute('data-model-connection')).toBe('missing');
      expect(dialog().textContent).toContain('Not connected yet');

      await click(dialog().querySelector('[data-model-connection-open]')!);
      // The wizard owns no provider form: the one real page that writes a
      // provider is the Connections card, and leaving for it ends the run.
      expect(navigate).toHaveBeenCalledWith('/settings/ai?tab=providers#st-card-providers-add');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
      expect(createProvider).not.toHaveBeenCalled();
    });

    it('names the model the server already reports, and writes nothing', async () => {
      getAuth.mockResolvedValue({ ...AUTH_EMPTY, ready: true, providers_count: 1, default_model: 'kimi-for-coding' });
      await mount();
      await toCapabilitiesStep();

      const row = dialog().querySelector('[data-onboarding-model-connection] [data-model-connection]');
      expect(row?.getAttribute('data-model-connection')).toBe('ready');
      expect(row?.textContent).toContain('kimi-for-coding');
      expect(dialog().querySelector('[data-model-connection-open]')?.textContent).toContain('Model settings');
      expect(createProvider).not.toHaveBeenCalled();
    });

    it('does not claim a state it could not read', async () => {
      getAuth.mockRejectedValue(new Error('auth probe failed'));
      await mount();
      await toCapabilitiesStep();

      const row = dialog().querySelector('[data-onboarding-model-connection] [data-model-connection]');
      expect(row?.getAttribute('data-model-connection')).toBe('unknown');
      expect(dialog().textContent).not.toContain('Not connected yet');
    });

    it('configures no model anywhere in the run', async () => {
      await mount();
      await toCapabilitiesStep();
      expect(dialog().querySelector('[data-connection-choice]')).toBeNull();
      expect(dialog().querySelector('[data-onboarding-model-id]')).toBeNull();
      expect(createProvider).not.toHaveBeenCalled();
      expect(probeProviderDraft).not.toHaveBeenCalled();
      expect(dialog().textContent).toContain('Step 3 of 3');
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
});

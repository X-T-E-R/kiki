// @vitest-environment jsdom

/**
 * OnboardingWizard — the first-run dialog: the auto-popup decision rule
 * (shouldOfferOnboarding), the three-step walk (welcome → agreement → depart;
 * nothing here configures a model, each exit is explicit), the save semantics
 * of every advance (Next on the agreement step persists the permission
 * default; notifications and reply prompt choices save on the spot), the
 * depart page's three ways out (a model hand-off, the kiki-ops install, and
 * the folded discovery routes), and exit state.
 */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSummary } from '@kiki/protocol';
import { clearStoredDrafts, readDraft, readNewSessionDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { currentDiscoveryScope, readDiscoveryState } from '@kiki/session-core/discovery';
import { readSettings } from '@kiki/session-core/settings';

import { createMemoryRouter, RouterProvider, useLocation, useNavigate, type NavigateOptions, type To } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { readSkinPrefs } from '../lib/skins';
import { ConfirmDialog } from './ConfirmDialog';
import { DirtyGuardContext, useDirtyGuardState } from './dirtyGuard';
import { DiscoveryPage, DiscoveryProvider } from './discovery';
import { HOST_SKILL_HOSTS } from './settings/HostSkillInstallCard';
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
const putMemory = vi.fn();
const getMemory = vi.fn();
const listMemory = vi.fn();
let serverConfig: Record<string, unknown>;
const navigate = vi.fn();

/** Mutable connection surface, so one test can take the socket away. */
const connectionState = vi.hoisted(() => ({ wsStatus: undefined as 'open' | 'closed' | undefined, scopeId: 'local', spaceKey: 'main' }));
const connectionClient = { getAuth, listProviders, listModels, getConfig, getOAuthStatus, listOAuthMethods, startOAuthLogin,
  cancelOAuthLogin: vi.fn(), patchConfig, listWorkspaces, createSession, createProvider, probeProviderDraft,
  previewHostSkillInstall, installHostSkill, putMemory, getMemory, listMemory };

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    config: { url: 'http://127.0.0.1:1', token: 'test-token' },
    get wsStatus() { return connectionState.wsStatus; },
    scopeId: connectionState.scopeId,
    spaceKey: connectionState.spaceKey,
    client: connectionClient,
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
  localStorage.removeItem('kiki.onboarding.step');
  localStorage.removeItem('kiki.settings');
  clearStoredDrafts();
  resetDraftMemoryForTests();
  connectionState.wsStatus = undefined;
  navigate.mockReset();
  getAuth.mockReset().mockResolvedValue(AUTH_EMPTY);
  listProviders.mockReset().mockResolvedValue({ items: [] });
  listModels.mockReset().mockResolvedValue({ items: [] });
  serverConfig = { default_permission_mode: 'manual' };
  connectionState.scopeId = 'local';
  connectionState.spaceKey = 'main';
  getConfig.mockReset().mockImplementation(async () => serverConfig);
  getOAuthStatus.mockReset().mockResolvedValue(null);
  listOAuthMethods.mockReset().mockResolvedValue([
    { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: false },
    { id: 'github-copilot', label: 'GitHub Copilot', provider: 'managed:github-copilot', protocol: 'openai', signed_in: false },
    { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false },
  ]);
  startOAuthLogin.mockReset().mockResolvedValue({ flow_id: 'f1', provider: 'managed:github-copilot', status: 'authenticated' });
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => {
    const { replace_domains: _replaceDomains, ...values } = patch;
    serverConfig = { ...serverConfig, ...values };
    return serverConfig;
  });
  listWorkspaces.mockReset().mockResolvedValue({ items: [] });
  createSession.mockReset().mockResolvedValue({ id: 's_onboarding_1' });
  createProvider.mockReset().mockResolvedValue({ id: 'kimi', revision: 'r1' });
  probeProviderDraft.mockReset().mockResolvedValue([]);
  previewHostSkillInstall.mockReset().mockResolvedValue({
    skill: 'kiki-ops', host: 'claude', directory: 'C:/Users/me/.claude/skills', path: 'C:/Users/me/.claude/skills/kiki-ops/SKILL.md', overwrites: true, revision: 'rev-1',
  });
  installHostSkill.mockReset().mockResolvedValue({
    skill: 'kiki-ops', host: 'claude', directory: 'C:/Users/me/.claude/skills', path: 'C:/Users/me/.claude/skills/kiki-ops/SKILL.md', overwrites: false, revision: 'rev-2',
  });
  listMemory.mockReset().mockRejectedValue(new Error('Onboarding must not read memory'));
  getMemory.mockReset().mockRejectedValue(new Error('Onboarding must not read memory'));
  putMemory.mockReset().mockRejectedValue(new Error('Onboarding must not write memory'));
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
  // The depart step starts discovery routes through the shared context and
  // hands off to Settings through the guarded navigator, so every mount lives
  // inside the same router + guard + discovery shell the App gives it; a bare
  // dialog would throw on useDiscovery.
  const { container } = await mountWithDiscovery({ onClose });
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

function queryDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function buttonByText(text: string): HTMLElement {
  const button = [...dialog().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`button "${text}" not found`);
  return button;
}

/** The in-panel step-back control (an icon button, so it is found by its label). */
function backButton(): HTMLElement {
  const button = dialog().querySelector<HTMLElement>('[aria-label="Back"]');
  if (button === null) throw new Error('panel back button not found');
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

/** Agreement: the first of three steps. */
async function toAgreementStep(): Promise<void> {
  // Step 1 is agreement; already on agreement
}

/** Agreement (Next saves mode) → appearance. */
async function toAppearanceStep(): Promise<void> {
  await click(buttonByText('Next'));
  await flush();
}

/** Agreement → appearance → depart page. */
async function toDepartStep(): Promise<void> {
  await toAppearanceStep();
  await click(buttonByText('Next'));
  await flush();
}

/** The depart page lists routes directly. */
async function openBrowse(): Promise<void> {
  const btn = dialog().querySelector('[data-onboarding-browse-open]');
  if (btn) {
    await click(btn);
    await flush();
  }
}

describe('OnboardingWizard', () => {
  it('opens on the agreement step with full header and language switch', async () => {
    await mount();
    expect(dialog().getAttribute('aria-label')).toBe('Welcome to Kiki');
    expect(dialog().parentElement?.getAttribute('data-onboarding-dialog')).toBe('');
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(dialog().textContent).toContain('How should Kiki work with you?');
    expect(dialog().querySelector('[data-onboarding-header="full"]')).not.toBeNull();
    // Language stays on the first screen as one small switch beside the title.
    expect(dialog().querySelector('[data-onboarding-language] [aria-labelledby="onboarding-language-label"]')).not.toBeNull();
    // Permission choices are visible on step 1.
    expect(dialog().querySelector('[data-permission-choice="auto"]')).not.toBeNull();
    // First page: nothing to go back to, but has Set up later.
    expect([...dialog().querySelectorAll('button')].some((button) => button.textContent === 'Back')).toBe(false);
    expect([...dialog().querySelectorAll('button')].some((button) => button.textContent === 'Set up later')).toBe(true);
  });

  it('shows the full masthead once, then a compact header on later steps', async () => {
    await mount();
    expect(dialog().querySelector('[data-onboarding-header="full"]')).not.toBeNull();
    await toAppearanceStep();
    expect(dialog().querySelector('[data-onboarding-header="compact"]')).not.toBeNull();
    expect(dialog().querySelector('[data-onboarding-header="full"]')).toBeNull();
    // The panel header owns the step title now; the close and the progress stay reachable.
    expect(dialog().querySelector('h2')?.textContent).toBe('Appearance & theme');
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().querySelector('[aria-label="Close setup"]')).not.toBeNull();
  });

  it('applies theme, palette and an optional picture from the appearance step', async () => {
    await mount();
    await toAppearanceStep();
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().querySelector('[data-onboarding-appearance]')).not.toBeNull();
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
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(dialog().textContent).toContain('How should Kiki work with you?');

    await toAppearanceStep();
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().querySelector('[data-onboarding-appearance]')).not.toBeNull();

    await click(buttonByText('Next'));
    await flush();
    expect(dialog().textContent).toContain('Step 3 of 3');
    expect(dialog().querySelector('[data-onboarding-depart]')).not.toBeNull();

    await click(backButton());
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().querySelector('[data-onboarding-appearance]')).not.toBeNull();

    await click(backButton());
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(dialog().textContent).toContain('How should Kiki work with you?');
  });

  it('scrolls the step itself and leaves the header and footer outside that scroller', async () => {
    await mount();
    const scroller = dialog().querySelector<HTMLElement>('[data-onboarding-step-scroll]')!;
    expect(scroller.className.split(/\s+/)).not.toContain('h-full');
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('min-h-0');
    expect(scroller.className).toContain('flex-1');
    expect(scroller.contains(buttonByText('Next'))).toBe(false);
    expect(scroller.contains(buttonByText('Set up later'))).toBe(false);
    expect(dialog().querySelector('[aria-label="Close setup"]')?.closest('[data-onboarding-step-scroll]')).toBeNull();
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

  it('offers manual/auto/yolo with auto recommended, hides review behind "more", and Next writes the mode', async () => {
    await mount();
    await toAgreementStep();

    // The first screen offers three modes; `review` is not wrong, only worth
    // choosing once a reviewer exists, so it waits behind the disclosure.
    const visible = [...dialog().querySelectorAll<HTMLElement>('[data-permission-choice]')];
    expect(visible.map((option) => option.dataset['permissionChoice'])).toEqual(['manual', 'auto', 'yolo']);
    expect(dialog().querySelector('[data-permission-choice="review"]')).toBeNull();

    const auto = visible.find((option) => option.dataset['permissionChoice'] === 'auto');
    expect(auto?.getAttribute('aria-checked')).toBe('true');
    expect(auto?.textContent).toContain('Recommended');

    await click(dialog().querySelector('[data-onboarding-permission-more]')!);
    const expanded = [...dialog().querySelectorAll<HTMLElement>('[data-permission-choice]')];
    expect(expanded.map((option) => option.dataset['permissionChoice'])).toEqual(['manual', 'auto', 'yolo', 'review']);

    await click(buttonByText('Next'));
    await flush();
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'auto' });
    expect(dialog().textContent).toContain('Step 2 of 3');
  });

  it('a failed permission save stays on the step', async () => {
    patchConfig.mockRejectedValueOnce(new Error('config is read-only'));
    await mount();
    await toAgreementStep();
    await click(buttonByText('Next'));
    await flush();
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(dialog().querySelector('[data-onboarding-depart]')).toBeNull();
  });

  it('a replay shows the server’s explicit permission choice instead of forcing auto', async () => {
    localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    getConfig.mockResolvedValue({ default_permission_mode: 'yolo' });
    await mount();
    await toAgreementStep();
    const yolo = dialog().querySelector('[data-permission-choice="yolo"]');
    expect(yolo?.getAttribute('aria-checked')).toBe('true');
  });

  it('a replay already on review opens the disclosure so the current choice is never hidden', async () => {
    localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    getConfig.mockResolvedValue({ default_permission_mode: 'review' });
    await mount();
    await toAgreementStep();
    await flush();
    const review = dialog().querySelector('[data-permission-choice="review"]');
    expect(review).not.toBeNull();
    expect(review?.getAttribute('aria-checked')).toBe('true');
  });

  it('the notify switch writes the completed away-notification kind on the spot', async () => {
    await mount();
    await toAgreementStep();
    const toggle = dialog().querySelector<HTMLInputElement>('#onboarding-notify-completed')!;
    expect(toggle.checked).toBe(true);
    await click(toggle);
    expect(readSettings().awayNotifications.completed).toBe(false);
    // The other kinds are untouched: only `completed` was on this page.
    expect(readSettings().awayNotifications.failed).toBe(true);
    expect(readSettings().awayNotifications.question).toBe(true);
    expect(readSettings().awayNotifications.approval).toBe(true);
    // No server write and no step change: this is a local device preference.
    expect(patchConfig).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Step 1 of 3');
  });

  it('stores the reply paragraph in the prompt domain and never touches memory', async () => {
    const { onboardingReplyParagraph } = await import('../lib/onboardingReplyStyle');
    const original = { variables: { example: 'kept' }, overrides: { files: ['shared.toml'], fields: { 'system.environment': 'ENV' }, main: { files: ['main.toml'], fields: { 'system.task_execution': 'MAIN' } }, independent: 'off' as const } };
    serverConfig['prompt'] = original;
    await mount();
    await toAgreementStep();
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(patchConfig).toHaveBeenCalledWith({ prompt: { ...original, overrides: { ...original.overrides,
      fields: { ...original.overrides.fields, 'system.reply_style': onboardingReplyParagraph('en', 'concise') } } }, replace_domains: ['prompt'] });
    expect(listMemory).not.toHaveBeenCalled();
    expect(getMemory).not.toHaveBeenCalled();
    expect(putMemory).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Saved the shared system prompt paragraph');
  });

  it('a second choice replaces only the same reply field', async () => {
    const { onboardingReplyParagraph } = await import('../lib/onboardingReplyStyle');
    await mount();
    await toAgreementStep();
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    await click(dialog().querySelector('[data-onboarding-voice="detailed"]')!);
    expect(patchConfig).toHaveBeenCalledTimes(2);
    expect(serverConfig['prompt']).toEqual({ overrides: { fields: { 'system.reply_style': onboardingReplyParagraph('en', 'detailed') } } });
    expect(putMemory).not.toHaveBeenCalled();
  });

  it('reads the server paragraph after changing steps and fully reopening setup', async () => {
    await mount();
    await toAgreementStep();
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    await click(buttonByText('Next'));
    await click(backButton());
    expect(dialog().querySelector('[data-onboarding-voice="concise"]')?.getAttribute('aria-checked')).toBe('true');
    await click(dialog().querySelector('[data-onboarding-voice="detailed"]')!);
    await act(async () => { roots.pop()!.unmount(); });
    containers.pop()!.remove();
    await mount();
    await toAgreementStep();
    expect(dialog().querySelector('[data-onboarding-voice="detailed"]')?.getAttribute('aria-checked')).toBe('true');
    expect(putMemory).not.toHaveBeenCalled();
  });

  it('keeps a saved paragraph after a lost acknowledgement without creating memory', async () => {
    const commit = patchConfig.getMockImplementation()!;
    patchConfig.mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('acknowledgement lost'); });
    await mount();
    await toAgreementStep();
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    expect(dialog().textContent).toContain('acknowledgement lost');
    await act(async () => { roots.pop()!.unmount(); });
    containers.pop()!.remove();
    await mount();
    await toAgreementStep();
    expect(dialog().querySelector('[data-onboarding-voice="concise"]')?.getAttribute('aria-checked')).toBe('true');
    await click(dialog().querySelector('[data-onboarding-voice="detailed"]')!);
    expect(patchConfig).toHaveBeenCalledTimes(2);
    expect(putMemory).not.toHaveBeenCalled();
  });

  it('preserves custom prompt text on browse and skip and exposes its editable paragraph', async () => {
    const custom = '${reply_style_guide}\n\nMy own reply instructions.';
    serverConfig['prompt'] = { overrides: { fields: { 'system.reply_style': custom } } };
    await mount();
    await toAgreementStep();
    expect(dialog().querySelector('[data-onboarding-voice="concise"]')?.getAttribute('aria-checked')).toBe('false');
    expect(dialog().textContent).toContain('Your custom paragraph is kept');
    await click(dialog().querySelector('[data-onboarding-paragraph-open]')!);
    expect(dialog().querySelector<HTMLTextAreaElement>('#onboarding-reply-paragraph')?.value).toBe(custom);
    await click(buttonByText('Set up later'));
    expect(serverConfig['prompt']).toEqual({ overrides: { fields: { 'system.reply_style': custom } } });
    expect(patchConfig.mock.calls.every(([patch]) => patch.prompt === undefined)).toBe(true);
  });

  it('does not patch from a failed baseline read and keeps the chosen draft for retry', async () => {
    await mount();
    await toAgreementStep();
    getConfig.mockRejectedValueOnce(new Error('config unavailable'));
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    expect(patchConfig).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-onboarding-voice="concise"]')?.getAttribute('aria-checked')).toBe('true');
    expect(dialog().textContent).toContain('config unavailable');
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    expect(patchConfig).toHaveBeenCalledTimes(1);
  });

  it('never writes an old pending choice after the active space or connection changes', async () => {
    await mount();
    await toAgreementStep();
    let resolve!: (value: Record<string, unknown>) => void;
    getConfig.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    connectionState.scopeId = 'remote-example';
    connectionState.spaceKey = 'another-space';
    await click(dialog().querySelector('[data-permission-choice="yolo"]')!);
    await act(async () => { resolve({ prompt: { overrides: { fields: { 'system.reply_style': 'OLD' } } } }); });
    expect(patchConfig).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-onboarding-voice="concise"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it.each(['yolo', 'review'] as const)('R040 pending config preserves %s when untouched Next or Set up later is used', async (mode) => {
    for (const action of ['Next', 'Set up later']) {
      localStorage.removeItem('kiki.onboarding.step');
      let resolve!: (value: { default_permission_mode: typeof mode }) => void;
      getConfig.mockImplementation(() => new Promise((done) => { resolve = done; }));
      await mount();
      await toAgreementStep();
      await click(buttonByText(action));
      expect(dialog().textContent).toContain('Step 2 of 3');
      expect(patchConfig).not.toHaveBeenCalled();
      await act(async () => { resolve({ default_permission_mode: mode }); });
      expect(patchConfig).not.toHaveBeenCalled();
      await act(async () => { roots.pop()!.unmount(); });
      containers.pop()!.remove();
    }
  });

  it('R040 pending config still saves an explicit permission choice without blocking setup', async () => {
    getConfig.mockImplementation(() => new Promise(() => {}));
    await mount();
    await toAgreementStep();
    await click(dialog().querySelector('[data-permission-choice="manual"]')!);
    await click(buttonByText('Next'));
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'manual' });
    expect(dialog().textContent).toContain('Step 2 of 3');
  });

  it('saves an editable paragraph and rejects removing the default reply guide before any request', async () => {
    const { saveOnboardingReplyParagraph } = await import('../lib/onboardingReplyStyle');
    await expect(saveOnboardingReplyParagraph(connectionClient, 'Missing guide', () => true)).rejects.toBeInstanceOf(Error);
    expect(getConfig).not.toHaveBeenCalled();
    expect(patchConfig).not.toHaveBeenCalled();
    const custom = '${reply_style_guide}\n\nCustom user instructions.';
    serverConfig['prompt'] = { overrides: { fields: { 'system.reply_style': custom } } };
    await mount();
    await toAgreementStep();
    await click(dialog().querySelector('[data-onboarding-paragraph-open]')!);
    expect(dialog().querySelector<HTMLTextAreaElement>('#onboarding-reply-paragraph')?.value).toBe(custom);
    await click(dialog().querySelector('[data-onboarding-paragraph-save]')!);
    expect(patchConfig).toHaveBeenCalledWith({ prompt: { overrides: { fields: { 'system.reply_style': custom } } }, replace_domains: ['prompt'] });
    expect(putMemory).not.toHaveBeenCalled();
  });

  it('a failed prompt save stays visible and never blocks the step', async () => {
    patchConfig.mockRejectedValueOnce(new Error('config write unavailable'));
    await mount();
    await toAgreementStep();
    await click(dialog().querySelector('[data-onboarding-voice="concise"]')!);
    expect(dialog().textContent).toContain('config write unavailable');
    await click(buttonByText('Next'));
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(putMemory).not.toHaveBeenCalled();
  });

  it('the first step advances to appearance and keeps the run open', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    expect(dialog().textContent).toContain('Step 1 of 3');
    await click(buttonByText('Next'));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-onboarding-appearance]')).not.toBeNull();
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(localStorage.getItem('kiki.onboarding')).toBeNull();
  });

  it('"Set up later" from the agreement step saves the chosen default and moves on', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toAgreementStep();
    await click(buttonByText('Set up later'));
    await flush();
    // Skipping past the step must not silently discard the choice already made.
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'auto' });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-onboarding-appearance]')).not.toBeNull();
    expect(localStorage.getItem('kiki.onboarding')).toBeNull();
  });

  it('"Not now" on the last step closes the run without starting anything', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toDepartStep();
    // There is no next step to move to, so this one ends the run here,
    // without starting a session or routing anywhere.
    await click(buttonByText('Close setup'));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  describe('the depart page hands off a model connection', () => {
    it('names the real paths, opens the Settings card, and does not mark the run done', async () => {
      const onClose = vi.fn();
      const { router } = await mountWithDiscovery({ onClose });
      await toDepartStep();

      expect(dialog().querySelector('[data-onboarding-depart-model]')).not.toBeNull();
      const open = dialog().querySelector<HTMLButtonElement>('[data-onboarding-model-settings]')!;
      expect(open.textContent).toBe('Configure model service in Settings →');
      // Auth "not ready" yet: the run is unmarked, so a user who comes back
      // without a model is offered the walk again.
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();

      await click(open);
      await flush();
      expect(router.state.location.pathname).toBe('/settings/providers');
      expect(router.state.location.search).toBe('?from=onboarding');
      expect(onClose).toHaveBeenCalledTimes(1);
      // The hand-off is not an exit: the run stays unmarked.
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();
    });
  });

  describe('the depart page installs kiki-ops into an agent the user already has', () => {
    it('lists the hosts neutrally and previews the named skill', async () => {
      await mount();
      await toDepartStep();

      const hosts = [...dialog().querySelectorAll<HTMLElement>('[data-onboarding-host]')];
      expect(hosts.map((host) => host.dataset['onboardingHost'])).toEqual(
        HOST_SKILL_HOSTS.map((host) => host.id),
      );
      expect(dialog().querySelector('[data-onboarding-depart-agent]')?.textContent).toContain('does not detect');

      await click(dialog().querySelector('[data-onboarding-host="codex"]')!);
      await flush();
      expect(previewHostSkillInstall).toHaveBeenCalledWith('codex', 'kiki-ops');
      expect(document.querySelector('[data-host-skill-path]')?.textContent).toContain('kiki-ops');
    });

    it('confirms with the pinned revision and then offers the one line to paste', async () => {
      await mount();
      await toDepartStep();

      await click(dialog().querySelector('[data-onboarding-host="claude"]')!);
      await flush();
      await click(document.querySelector('[data-host-skill-confirm]')!);
      await flush();

      expect(installHostSkill).toHaveBeenCalledWith('claude', 'kiki-ops', 'rev-1');
      const line = dialog().querySelector('[data-onboarding-agent-line]');
      expect(line).not.toBeNull();
      expect(line?.textContent).toContain('/kiki-ops set Kiki up for me');
    });

    it('a cancelled install leaves the page usable', async () => {
      await mount();
      await toDepartStep();
      await click(dialog().querySelector('[data-onboarding-host="grok"]')!);
      await flush();
      // Cancel on the install dialog.
      await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!);
      await flush();
      expect(dialog().querySelector('[data-onboarding-agent-line]')).toBeNull();
      expect(dialog().querySelector('[data-onboarding-depart]')).not.toBeNull();
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();
    });
  });

  describe('the depart page starts a discovery route in place', () => {
    it('lists the five catalog routes directly and lists nothing the hub owns', async () => {
      await mount();
      await toDepartStep();

      expect(dialog().textContent).toContain('Step 3 of 3');
      expect(dialog().querySelector('[data-onboarding-depart-browse]')).not.toBeNull();
      expect(dialog().querySelector('[data-onboarding-tour-start]')).not.toBeNull();

      const rows = [...dialog().querySelectorAll<HTMLElement>('[data-onboarding-route]')];
      expect(rows.map((row) => row.dataset['onboardingRoute'])).toEqual([
        'overview', 'do-first', 'understand', 'sustain', 'extend',
      ]);
      expect(rows[0]?.textContent).toContain('Take me on a tour');
      expect(rows[0]?.textContent).toContain('5 stops');
      expect(rows[3]?.textContent).toContain('Keep work going');
      expect(rows[3]?.textContent).toContain('2 stops');

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
      await toDepartStep();
      await openBrowse();

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
      await toDepartStep();
      await openBrowse();

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
      await toDepartStep();
      await openBrowse();

      await click(dialog().querySelector('[data-onboarding-route="sustain"]')!);
      await cancelAction();
      await flush();

      expect(router.state.location.pathname).toBe('/settings/providers');
      expect(onClose).not.toHaveBeenCalled();
      expect(readDiscoveryState(currentDiscoveryScope('local')).route).toBeUndefined();
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();
      // Staying here is the user's choice, not a failure: nothing to recover from.
      expect(dialog().textContent).not.toContain('This route can’t open right now');
    });

    it('a confirmed dirty-draft prompt commits the route and ends the run', async () => {
      const onClose = vi.fn();
      const { router, confirmAction } = await mountWithDiscovery({ onClose, dirty: true });
      await toDepartStep();
      await openBrowse();

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
      await toDepartStep();
      await openBrowse();

      await click(dialog().querySelector('[data-onboarding-route="sustain"]')!);
      await flush();

      expect(router.state.location.pathname).toBe('/new');
      expect(onClose).not.toHaveBeenCalled();
      expect(readDiscoveryState(currentDiscoveryScope('local')).route).toBeUndefined();
      expect(localStorage.getItem('kiki.onboarding')).toBeNull();
      expect(dialog().textContent).toContain('This route can’t open right now');
      expect(dialog().textContent).toContain('Discover Kiki');
      // Settled: the rows are actionable again, not stuck disabled.
      const row = dialog().querySelector('[data-onboarding-route="sustain"]');
      expect(row?.hasAttribute('disabled')).toBe(false);
    });

    it('closes the run without a session, a draft or a navigation when the action is skipped', async () => {
      const onClose = vi.fn();
      await mount(onClose);
      await toDepartStep();

      await click(buttonByText('Close setup'));
      await flush();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(readDraft('new')).toBe('');
      expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
    });

    it('shows ready badge and start chat button when model connection is ready', async () => {
      getAuth.mockResolvedValue({ ...AUTH_EMPTY, ready: true, default_model: 'kimi-k2' });
      const onClose = vi.fn();
      const { router } = await mountWithDiscovery({ onClose });
      await toDepartStep();

      expect(dialog().querySelector('[data-onboarding-model-ready]')).not.toBeNull();
      const startChat = dialog().querySelector<HTMLButtonElement>('[data-onboarding-start-chat]')!;
      expect(startChat).not.toBeNull();
      await click(startChat);
      await flush();
      expect(router.state.location.pathname).toBe('/new');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('the /discover hub lists the same routes with the same row component', async () => {
    await mountWithDiscovery({
      initialRoute: '/discover',
      children: <DiscoveryPage onToggleSidebar={() => {}} />,
    });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-discovery-route-row][data-discovery-route-card]')];
    expect(rows.map((row) => row.dataset['discoveryRouteCard'])).toEqual([
      'overview', 'do-first', 'understand', 'sustain', 'extend',
    ]);
    expect(rows[0]?.textContent).toContain('Take me on a tour');
    expect(rows[3]?.textContent).toContain('Keep work going');
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

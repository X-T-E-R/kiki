// @vitest-environment jsdom

/**
 * OnboardingWizard — the first-run dialog: the auto-popup decision rule
 * (shouldOfferOnboarding), the four-step walk, the save semantics of every
 * advance ("Save & continue" persists the provider form; finish persists the
 * permission default), exit-and-re-entry state, and the finish hand-off
 * (/new hero with its own target default, nothing prefilled or sent).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSummary } from '@kiki/protocol';
import { clearStoredDrafts, readDraft, readNewSessionDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { readSettings } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import { readSkinPrefs } from '../lib/skins';
import { PERMISSION_MODES } from '../lib/permissionModes';
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
vi.mock('./dirtyGuard', () => ({
  useGuardedNavigate: () => navigate,
  useDirtyReporter: () => {},
}));

const AUTH_EMPTY: AuthSummary = {
  ready: false,
  providers_count: 0,
  default_model: null,
  managed_provider: null,
};

/** The provider row the fixture "server" holds after a create. */
const SAVED_PROVIDER = {
  id: 'kimi',
  type: 'kimi',
  base_url: 'https://api.moonshot.ai/v1',
  status: 'connected',
  has_api_key: true,
  default_model: 'kimi-for-coding',
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

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
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

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = [...dialog().querySelectorAll('input')].find(
    (candidate) => candidate.placeholder === placeholder,
  );
  if (input === undefined) throw new Error(`input "${placeholder}" not found`);
  return input;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeIntoTextArea(input: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

/**
 * Choose a model id the way the form is used: open the combobox, and commit
 * either a listed row or, when the id is not listed, the custom row the search
 * itself offers.
 */
async function pickModelId(remoteId: string): Promise<void> {
  const trigger = dialog().querySelector<HTMLButtonElement>('#onboarding-provider-model')
    ?? dialog().querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
  if (trigger === null) throw new Error('model combobox trigger not found');
  await act(async () => { trigger.click(); });
  // The option panel is portalled to the body, so it is queried from the
  // document, exactly as SearchableSelect's own tests do.
  const panel = document.querySelector<HTMLElement>('[data-select-panel]');
  if (panel === null) throw new Error('model combobox panel not open');
  const filter = panel.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (filter === null) throw new Error('model combobox has no filter input');
  await typeInto(filter, remoteId);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  // A listed candidate is a data-option-value row; an id the provider never
  // listed is the custom row, which is identified by its title instead.
  const row = [...document.querySelectorAll('[data-option-value], [data-select-panel] [role="option"]')]
    .find((node) => node.getAttribute('data-option-value') === remoteId
      || node.getAttribute('title') === remoteId);
  if (row === undefined) throw new Error('model option not offered: ' + remoteId);
  await act(async () => { (row as HTMLElement).click(); });
}

/** Walk from the welcome page (language + appearance) onto the model step. */
async function toModelStep(): Promise<void> {
  await click(buttonByText('Next'));
  await flush();
}

/** Fill the template → key → model id path on the model step. */
async function fillProviderForm(): Promise<void> {
  await typeInto(inputByPlaceholder('Search DeepSeek, Kimi, Ollama…'), 'kimi');
  await click(dialog().querySelector('[data-provider-template="moonshot"]')!);
  await typeInto(inputByPlaceholder('Paste a new key'), 'sk-test-key');
  await pickModelId('kimi-for-coding');
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

/** Welcome → model → (skip) → approvals. */
async function toPermissionsStep(): Promise<void> {
  await toModelStep();
  await click(buttonByText('Skip for now'));
}

/** … → approvals → (Next saves the mode) → capabilities. */
async function toCapabilitiesStep(): Promise<void> {
  await toPermissionsStep();
  await click(buttonByText('Next'));
  await flush();
}

describe('OnboardingWizard', () => {
  it('opens on one welcome page: language and appearance together', async () => {
    await mount();
    expect(dialog().getAttribute('aria-label')).toBe('Welcome to Kiki');
    expect(dialog().textContent).toContain('Step 1 of 4');
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
    await toModelStep();
    expect(dialog().textContent).toContain('Step 2 of 4');
    // One entry: choose API key or account first, then protocol or method.
    expect(dialog().querySelectorAll('[data-connection-choice]')).toHaveLength(2);
    expect(dialog().querySelectorAll('[data-provider-protocol]')).toHaveLength(5);
    expect(dialog().querySelector('[data-provider-template="anthropic"]')).toBeNull();
    await click(dialog().querySelector('[data-connection-choice="account"]')!);
    await flush();
    expect(dialog().querySelectorAll('[data-oauth-method]')).toHaveLength(3);
    expect(dialog().querySelector('[data-provider-protocol]')).toBeNull();

    await click(buttonByText('Skip for now'));
    expect(dialog().textContent).toContain('Step 3 of 4');
    expect(dialog().textContent).toContain('How much should Kiki do on its own?');

    await click(buttonByText('Back'));
    expect(dialog().textContent).toContain('Step 2 of 4');
    await click(buttonByText('Back'));
    expect(dialog().textContent).toContain('Step 1 of 4');
    expect(dialog().querySelector('[data-onboarding-appearance]')).not.toBeNull();
  });

  it('uses the selected account method rather than implicitly signing in with Kimi', async () => {
    await mount();
    await toModelStep();
    await click(dialog().querySelector('[data-connection-choice="account"]')!);
    await flush();
    await click(dialog().querySelector('[data-oauth-method="github-copilot"] button')!);
    expect(startOAuthLogin).toHaveBeenCalledWith({ provider: 'github-copilot' });
  });

  it('labels the model step advance "Skip for now" until a provider connects', async () => {
    await mount();
    await toModelStep();
    await click(buttonByText('Skip for now'));
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Step 3 of 4');
  });

  it('keeps the advance as Next while adding another provider to an existing connection', async () => {
    listProviders.mockResolvedValue({ items: [SAVED_PROVIDER] });
    await mount();
    await toModelStep();
    expect(dialog().textContent).toContain('A model provider is connected');
    expect(dialog().querySelector('[data-preset-grid]')).toBeNull();
    expect(dialog().querySelector('[data-account-sign-in]')).toBeNull();
    await click(buttonByText('Change or add another connection'));
    expect(dialog().textContent).not.toContain('A model provider is connected');
    expect(dialog().querySelectorAll('[data-provider-protocol]')).toHaveLength(5);
    await click(dialog().querySelector('[data-connection-choice="account"]')!);
    expect(dialog().querySelector('[data-account-sign-in]')).not.toBeNull();
    await click(buttonByText('Next'));
    expect(dialog().textContent).toContain('Step 3 of 4');
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('saves a model id the provider never listed, and saves it without a picker', async () => {
    // The provider reported nothing (the probe failed, or the id is private):
    // the field is still a real text field, and the value is what gets written.
    probeProviderDraft.mockResolvedValue([]);
    await mount();
    await toModelStep();
    await typeInto(inputByPlaceholder('Search DeepSeek, Kimi, Ollama…'), 'kimi');
    await click(dialog().querySelector('[data-provider-template="moonshot"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-custom');
    expect(dialog().querySelector('#onboarding-model-picker')).toBeNull();
    await pickModelId('my-private-model');
    await click(buttonByText('Save & continue'));
    await flush();
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['default_model']).toBe('my-private-model');
    expect(body['models']).toEqual([expect.objectContaining({ remote_id: 'my-private-model' })]);
  });

  it('offers every reported model, however many the provider lists', async () => {
    // The provider can list far more models than fit on the first screen. The
    // list is filtered, not truncated, so a model past any page boundary is
    // still findable by typing part of its id.
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: '',
      remoteId: `kimi-model-${String(index).padStart(3, '0')}`,
      maxContextSize: 131072,
      displayName: '',
      capabilities: ['thinking'],
      supportEfforts: [],
      requestIdentityChoice: 'inherit' as const,
      requestIdentityOverridesJson: '',
      imageAcceptedTypes: null,
      imageConvertUnsupported: null,
    }));
    probeProviderDraft.mockResolvedValue(many);
    await mount();
    await toModelStep();
    await typeInto(inputByPlaceholder('Search DeepSeek, Kimi, Ollama…'), 'kimi');
    await click(dialog().querySelector('[data-provider-template="moonshot"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-many');
    await click(buttonByText('Test connection'));
    await flush();
    await act(async () => { dialog().querySelector<HTMLButtonElement>('#onboarding-provider-model')!.click(); });
    await flush();
    const filter = document.querySelector<HTMLInputElement>('[data-select-panel] input[role="combobox"]')!;
    // The last of 120 is reachable: nothing was cut before the search saw it.
    await typeInto(filter, 'kimi-model-119');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect([...document.querySelectorAll('[data-option-value]')].map((n) => n.getAttribute('data-option-value')))
      .toEqual(['kimi-model-119']);
    await act(async () => {
      (document.querySelector('[data-option-value="kimi-model-119"]') as HTMLElement).click();
    });
    expect(dialog().querySelector('#onboarding-provider-model')?.textContent).toContain('kimi-model-119');
  });

  it('saves the auto-compact threshold beside the window, and inherits when left empty', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    // Empty is a real state meaning "inherit", not a zero threshold.
    expect(threshold.value).toBe('');
    expect(threshold.placeholder).toBe('Inherit');
    await typeInto(threshold, '90000');
    await act(async () => { threshold.focus(); threshold.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await click(buttonByText('Save & continue'));
    await flush();
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['models']).toEqual([
      expect.objectContaining({ remote_id: 'kimi-for-coding', auto_compact: 90000 }),
    ]);
  });

  it('refuses to save an auto-compact value the field rejected, and does not step on', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    // The real order a person uses: focus, then type, then leave the field.
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '0');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // Zero is not a threshold, and a share of the window is not a token count.
    // The mistake stays on screen with its reason; it is not quietly turned into
    // an inherited value.
    expect(threshold.value).toBe('0');
    expect(threshold.getAttribute('aria-invalid')).toBe('true');
    expect(dialog().textContent).toContain('Use a whole number of tokens, 1 or more.');
    // Save is refused: nothing is created and the wizard stays on this step.
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Step 2 of 4');
    // The rejected text is still there to be corrected, not replaced.
    expect(threshold.value).toBe('0');
  });

  it('reports a bad auto-compact once, in its own field, and only refuses the save', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '75%');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    await click(buttonByText('Save & continue'));
    await flush();
    // The field owns this message, and the refused save adds no second copy
    // under the form: one mistake, one place saying it.
    const alerts = [...dialog().querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe('Use a whole number of tokens, 1 or more.');
    expect(alerts[0]!.hasAttribute('data-field-issue')).toBe(true);
    // The save is refused and the caret goes back to the mistake.
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Step 2 of 4');
    expect(document.activeElement).toBe(threshold);
    expect(threshold.value).toBe('75%');
    // Correcting it clears the message, and the very next save goes through
    // once: the refused one left nothing behind to clear or re-show.
    await typeInto(threshold, '90000');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(dialog().querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(threshold.getAttribute('aria-invalid')).toBe(null);
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider.mock.calls[0]![0]).toMatchObject({
      models: [expect.objectContaining({ auto_compact: 90000 })],
    });
  });

  it('reports a never-left auto-compact in its field too, without a form-level copy', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    // No blur ever runs, so the field's own commit never saw this text. The
    // message still belongs to the field, and still appears exactly once.
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '90k');
    await click(buttonByText('Save & continue'));
    await flush();
    const alerts = [...dialog().querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.hasAttribute('data-field-issue')).toBe(true);
    expect(createProvider).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(threshold);
  });

  it('keeps a real save failure visible, and does not let a field mistake hide it', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    // A failure the person must act on is not cleared by a later field edit.
    createProvider.mockRejectedValueOnce(new Error('server offline'));
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(dialog().textContent).toContain('server offline');
    // Typing into the threshold must not wipe that real reason.
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '75%');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(dialog().textContent).toContain('server offline');
    // Correcting the field and retrying reaches the create again.
    await typeInto(threshold, '90000');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(2);
  });

  it('refuses a bad auto-compact even when the field was never left', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    // Typed and left as-is: no blur ever runs, so nothing but the live text can
    // tell the save that this is not a number.
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '90k');
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Step 2 of 4');
  });

  it('saves a corrected auto-compact value, and an emptied one goes back to inheriting', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '75%');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(threshold.getAttribute('aria-invalid')).toBe('true');
    // Correcting it in place, the way a person fixes a mistake, then saving.
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '90000');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(threshold.getAttribute('aria-invalid')).toBe(null);
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['models']).toEqual([expect.objectContaining({ auto_compact: 90000 })]);
  });

  it('drops an emptied auto-compact back to inheriting, and that is what it saves', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    const threshold = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-auto-compact]')!;
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '90000');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(threshold.value).toBe('90000');
    // Clearing it is a deliberate act, and it returns to the inherited default.
    await act(async () => { threshold.focus(); });
    await typeInto(threshold, '');
    await act(async () => { threshold.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    const models = body['models'] as Array<Record<string, unknown>>;
    expect(models[0]!['auto_compact']).toBeUndefined();
  });

  it('draws the identity choice once, in the base form, and keeps Advanced to the override body', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    // The base form owns the only identity selector: the same one, drawn once.
    expect(dialog().querySelectorAll('[data-request-identity-choice]')).toHaveLength(1);
    const toggle = dialog().querySelector<HTMLButtonElement>('[data-onboarding-advanced-toggle]')!;
    await click(toggle);
    const body = dialog().querySelector<HTMLElement>('[data-onboarding-advanced-body]')!;
    // Advanced adds the hand-written override body and nothing that repeats the
    // selector the form above already shows.
    expect(body.querySelector('[data-request-identity-choice]')).toBeNull();
    expect(dialog().querySelectorAll('[data-request-identity-choice]')).toHaveLength(1);
  });

  it('lets the base identity selector show the states the override body can leave behind', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    // Advanced edits can leave the layer on a manual-override or no-identity
    // state. Both are reachable, so the base selector offers them instead of
    // rendering blank for a value it does not have.
    await click(dialog().querySelector<HTMLButtonElement>('[data-onboarding-advanced-toggle]')!);
    await act(async () => { dialog().querySelector<HTMLButtonElement>('[data-request-identity-choice] button')!.click(); });
    await flush();
    const offered = [...document.querySelectorAll('[data-option-value]')]
      .map((node) => node.getAttribute('data-option-value'));
    expect(offered).toContain('custom_overrides');
    expect(offered).toContain('none');
    expect(offered).toContain('opencode_compatible');
  });

  it('gives Advanced real work once an identity is set: the override body and a way back', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    // Choose an identity in the base form, so the layer is authored.
    await act(async () => { dialog().querySelector<HTMLButtonElement>('[data-request-identity-choice] button')!.click(); });
    await flush();
    await act(async () => {
      (document.querySelector('[data-option-value="codex_compatible"]') as HTMLElement).click();
    });
    await click(dialog().querySelector<HTMLButtonElement>('[data-onboarding-advanced-toggle]')!);
    // Now there is a body to edit and a control that clears it, rather than an
    // empty disclosure.
    const body = dialog().querySelector<HTMLElement>('[data-onboarding-advanced-body]')!;
    expect(body.querySelector('textarea')).not.toBeNull();
    expect(body.textContent).toContain('Clear layer');
  });

  it('opens Advanced onto a real override body even while the identity is inherited', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    // Nothing has chosen a preset, so the layer is still inherited. The
    // disclosure still has a body, because there is a body to write exactly
    // once and the person should not have to guess a preset first.
    await click(dialog().querySelector<HTMLButtonElement>('[data-onboarding-advanced-toggle]')!);
    const body = dialog().querySelector<HTMLElement>('[data-onboarding-advanced-body]')!;
    const area = body.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(area).not.toBeNull();
    // Still inherited: an untouched body has nothing to clear back.
    expect(body.textContent).not.toContain('Clear layer');
    await typeIntoTextArea(area, '{"client":{"user_agent":"host"}}');
    // Writing is what authors the layer, and it uses the state the contract
    // already has for a hand-written body, not a new one.
    const trigger = dialog().querySelector<HTMLElement>('[data-request-identity-choice] button')!;
    expect(trigger.textContent).toContain('Custom overrides only');
    await click(dialog().querySelector<HTMLButtonElement>('[data-onboarding-advanced-toggle]')!);
    await click(dialog().querySelector<HTMLButtonElement>('[data-onboarding-advanced-toggle]')!);
    expect(dialog().querySelector<HTMLElement>('[data-onboarding-advanced-body]')!.textContent)
      .toContain('Clear layer');
    // And the save carries that body rather than an empty layer.
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    const sent = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent['request_identity']).toMatchObject({ overrides: { client: { user_agent: 'host' } } });
  });

  it('keeps an override-only layer honest when the body is emptied, and clears it deliberately', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    await click(dialog().querySelector<HTMLButtonElement>('[data-onboarding-advanced-toggle]')!);
    const body = () => dialog().querySelector<HTMLElement>('[data-onboarding-advanced-body]')!;
    await typeIntoTextArea(body().querySelector<HTMLTextAreaElement>('textarea')!, '{"cache":{"source":"session"}}');
    // Deleting the text leaves the override-only state, which says it needs a
    // non-empty object, and the save is refused for that reason rather than
    // quietly dropping the layer the person was editing.
    await typeIntoTextArea(body().querySelector<HTMLTextAreaElement>('textarea')!, '');
    expect(dialog().querySelector<HTMLElement>('[data-request-identity-choice] button')!.textContent)
      .toContain('Custom overrides only');
    expect(body().textContent).toContain('non-empty object');
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).not.toHaveBeenCalled();
    // Clearing is the deliberate way back, and it lands on the inherited layer
    // that sends no identity at all.
    const clear = [...body().querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Clear layer');
    expect(clear).toBeDefined();
    await click(clear!);
    expect(dialog().querySelector<HTMLElement>('[data-request-identity-choice] button')!.textContent)
      .toContain('Inherit global default');
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect((createProvider.mock.calls[0]![0] as Record<string, unknown>)['request_identity']).toBeUndefined();
  });

  it('says there is more below from the first frame, and stops saying so at the end', async () => {
    installStepScroller();
    try {
      // A step taller than its own box, before any pointer has touched it.
      stepGeometry.contentHeight = 900;
      await mount();
      await toModelStep();
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

  it('offers the base model options and writes the chosen ones', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    // Context length, thinking levels and the model's own capabilities are
    // first-class choices here, not settings to discover later.
    const context = dialog().querySelector<HTMLInputElement>('[data-onboarding-model-context]')!;
    expect(context).not.toBeNull();
    await typeInto(context, '200000');
    // A thinking level and a capability are both real selections, not free text.
    const efforts = dialog().querySelector<HTMLElement>('[aria-label="Supported thinking levels"]')!;
    expect(efforts).not.toBeNull();
    await click(efforts.querySelector('button[aria-pressed]')!);
    const caps = dialog().querySelector<HTMLElement>('[aria-label="Model capabilities"]')!;
    expect(caps.textContent).toContain('thinking');
    expect(caps.textContent).toContain('image_in');
    // Add image input to whatever the preset already seeded.
    const vision = [...caps.querySelectorAll('button[aria-pressed]')]
      .find((node) => node.textContent?.trim() === 'image_in')!;
    expect(vision.getAttribute('aria-pressed')).toBe('false');
    await click(vision);
    await click(buttonByText('Save & continue'));
    await flush();
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['models']).toEqual([
      expect.objectContaining({
        remote_id: 'kimi-for-coding',
        max_context_size: 200000,
        support_efforts: ['low'],
        capabilities: expect.arrayContaining(['image_in']),
      }),
    ]);
  });

  it('lets the request identity be chosen while connecting, and writes it', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    // The identity is a base choice, visible without opening anything: which
    // client shape the requests take is part of connecting a provider.
    expect(dialog().querySelector('[data-request-identity-choice]')).not.toBeNull();
    // The manual override body stays under the disclosure, and is absent until
    // an identity is actually authored.
    expect(dialog().querySelector('[data-onboarding-advanced-toggle]')?.getAttribute('aria-expanded')).toBe('false');
    expect(dialog().querySelector('[data-onboarding-advanced-body]')).toBeNull();
    // Open the identity list and pick OpenCode: the same catalog the settings
    // editor uses, not a second list maintained for the wizard.
    await act(async () => { dialog().querySelector<HTMLButtonElement>('[data-request-identity-choice] button')!.click(); });
    await flush();
    await act(async () => {
      (document.querySelector('[data-option-value="opencode_compatible"]') as HTMLElement).click();
    });
    await click(buttonByText('Save & continue'));
    await flush();
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['request_identity']).toEqual({ preset: 'opencode_compatible' });
  });

  it('leaves the request identity out of the body when it is left inherited', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    await click(buttonByText('Save & continue'));
    await flush();
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    // "inherit" is the absence of a policy, not a policy asking for nothing.
    expect(body['request_identity']).toBeUndefined();
  });

  it('Save & continue persists the filled provider form before advancing', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['id']).toBe('moonshot');
    expect(body['type']).toBe('kimi');
    expect(body['api_key']).toBe('sk-test-key');
    expect(body['default_model']).toBe('kimi-for-coding');
    expect(body['models']).toEqual([
      expect.objectContaining({ remote_id: 'kimi-for-coding' }),
    ]);
    expect(dialog().textContent).toContain('Step 3 of 4');
  });

  it('Test connection probes the unsaved form values and fills suggestions', async () => {
    probeProviderDraft.mockResolvedValue([
      {
        id: '',
        remoteId: 'kimi-for-coding',
        maxContextSize: 131072,
        displayName: '',
        capabilities: ['thinking'],
        supportEfforts: [],
        requestIdentityChoice: 'inherit',
        requestIdentityOverridesJson: '',
        imageAcceptedTypes: null,
        imageConvertUnsupported: null,
      },
    ]);
    await mount();
    await toModelStep();
    await typeInto(inputByPlaceholder('Search DeepSeek, Kimi, Ollama…'), 'kimi');
    await click(dialog().querySelector('[data-provider-template="moonshot"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-probe-me');
    await click(buttonByText('Test connection'));
    await flush();
    expect(probeProviderDraft).toHaveBeenCalledWith({
      type: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-probe-me',
    });
    expect(createProvider).not.toHaveBeenCalled();
    // One control: the same combobox that accepted the hand-typed id now offers
    // what the provider reported, with no separate picker beside it.
    const combobox = dialog().querySelector<HTMLButtonElement>('#onboarding-provider-model')!;
    expect(combobox).not.toBeNull();
    expect(dialog().querySelector('#onboarding-model-picker')).toBeNull();
    await act(async () => { combobox.click(); });
    await flush();
    const listed = [...document.querySelectorAll('[data-option-value]')]
      .map((node) => node.getAttribute('data-option-value'));
    // Every reported model is reachable, and the count matches the probe, so
    // nothing is truncated away before the search sees it.
    expect(listed).toContain('kimi-for-coding');
    expect(listed).toEqual(['kimi-for-coding']);
    await act(async () => {
      (document.querySelector('[data-option-value="kimi-for-coding"]') as HTMLElement).click();
    });
    expect(dialog().querySelector('#onboarding-provider-model')?.textContent).toContain('kimi-for-coding');
  });

  it('a started but invalid form blocks the advance with an inline error', async () => {
    await mount();
    await toModelStep();
    await typeInto(inputByPlaceholder('Search DeepSeek, Kimi, Ollama…'), 'kimi');
    await click(dialog().querySelector('[data-provider-template="moonshot"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-test-key');
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Model IDs cannot be empty.');
    expect(dialog().textContent).toContain('Step 2 of 4');
  });

  it('a protocol card derives the connection name from the Base URL, and keeps it editable', async () => {
    await mount();
    await toModelStep();
    await click(dialog().querySelector('[data-provider-protocol="openai"]')!);
    const id = dialog().querySelector<HTMLInputElement>('#onboarding-provider-id')!;
    const baseUrl = dialog().querySelector<HTMLInputElement>('#onboarding-provider-base-url')!;
    expect(id.value).toBe('');
    await typeInto(baseUrl, 'https://api.deepseek.com/v1');
    expect(id.value).toBe('deepseek');
    await typeInto(id, 'work');
    await typeInto(baseUrl, 'https://api.mistral.ai/v1');
    expect(id.value).toBe('work');

    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-test-key');
    await pickModelId('mistral-large');
    await click(buttonByText('Save & continue'));
    await flush();
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['id']).toBe('work');
    expect(body['type']).toBe('openai');
    expect(body['base_url']).toBe('https://api.mistral.ai/v1');
  });

  it('a protocol card with no Base URL puts the error on the Base URL field', async () => {
    await mount();
    await toModelStep();
    await click(dialog().querySelector('[data-provider-protocol="openai"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-test-key');
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).not.toHaveBeenCalled();
    const baseUrl = dialog().querySelector<HTMLInputElement>('#onboarding-provider-base-url')!;
    expect(baseUrl.getAttribute('aria-invalid')).toBe('true');
    expect(dialog().querySelector('#onboarding-provider-base-url-issue')?.textContent).toBe('Fill in the Base URL first.');
    expect(dialog().querySelector('#onboarding-provider-id-issue')).toBeNull();
    // The old one-line id rule never fires for an empty form.
    expect(dialog().textContent).not.toContain('must start with a letter or digit');
    // Typing an address clears the field error and names the connection.
    await typeInto(baseUrl, 'https://api.deepseek.com/v1');
    expect(dialog().querySelector('#onboarding-provider-base-url-issue')).toBeNull();
    expect(dialog().querySelector<HTMLInputElement>('#onboarding-provider-id')!.value).toBe('deepseek');
  });

  it('an emptied connection name asks for one on the name field', async () => {
    await mount();
    await toModelStep();
    await click(dialog().querySelector('[data-provider-protocol="anthropic"]')!);
    await typeInto(dialog().querySelector<HTMLInputElement>('#onboarding-provider-base-url')!, 'https://llm.example.com/v1');
    await typeInto(dialog().querySelector<HTMLInputElement>('#onboarding-provider-id')!, '');
    await pickModelId('claude-x');
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().querySelector('#onboarding-provider-id-issue')?.textContent).toBe('Give this connection a name.');
    expect(dialog().querySelector('#onboarding-provider-base-url-issue')).toBeNull();
  });

  it('Escape closes an open protocol picker without closing the wizard', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toModelStep();
    await click(dialog().querySelector('[data-provider-protocol="openai"]')!);
    const trigger = dialog().querySelector<HTMLButtonElement>('#onboarding-provider-protocol')!;
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(dialog().querySelector('#onboarding-provider-base-url')).not.toBeNull();
  });

  it('keeps the unsubmitted form when going Back and returning', async () => {
    await mount();
    await toModelStep();
    await typeInto(inputByPlaceholder('Search DeepSeek, Kimi, Ollama…'), 'kimi');
    await click(dialog().querySelector('[data-provider-template="moonshot"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-kept');
    await click(buttonByText('Back'));
    await click(buttonByText('Next'));
    expect(inputByPlaceholder('Paste a new key').value).toBe('sk-kept');
  });

  it('a saved connection survives closing and reopening the wizard', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toModelStep();
    await fillProviderForm();
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);

    await click(buttonByText('Set up later'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmountLast();
    listProviders.mockResolvedValue({ items: [SAVED_PROVIDER] });
    getAuth.mockResolvedValue({ ...AUTH_EMPTY, ready: true, providers_count: 1 });

    // Re-entry: connected, so the advance reads "Next" and saves nothing.
    await mount();
    await toModelStep();
    await flush();
    expect(dialog().textContent).toContain('A model provider is connected');
    await click(buttonByText('Next'));
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(dialog().textContent).toContain('Step 3 of 4');
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
    expect(dialog().textContent).toContain('Step 4 of 4');
  });

  it('a failed permission save stays on the step', async () => {
    patchConfig.mockRejectedValueOnce(new Error('config is read-only'));
    await mount();
    await toPermissionsStep();
    await click(buttonByText('Next'));
    await flush();
    expect(dialog().textContent).toContain('Step 3 of 4');
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

  it('marks completion and closes on "Set up later"', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await click(buttonByText('Set up later'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('"Set up with Kiki" opens the guided setup session with a short request waiting, and sends nothing', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    expect(dialog().querySelector('[data-workspace-choice]')).toBeNull();
    await click(buttonByText('Set up with Kiki'));
    await flush();
    // No workspace address: the server gives the session a new folder in Kiki Home.
    expect(createSession).toHaveBeenCalledWith({});
    expect(createSession).toHaveBeenCalledTimes(1);
    const draft = readDraft('s_onboarding_1');
    // The composer is what the user reads before sending, so it names the skill
    // and the three asks; the details live in the skill, not in the draft.
    expect(draft).toMatch(/^\/kiki-ops /);
    expect(draft).toMatch(/one question at a time/i);
    expect(draft).toMatch(/keep things as they are or turn Explore off/i);
    expect(draft.length).toBeLessThan(260);
    expect(navigate).toHaveBeenCalledWith('/s/s_onboarding_1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('never overwrites a draft the user already typed elsewhere', async () => {
    const { writeDraft } = await import('@kiki/session-core/composer');
    writeDraft('new', 'half-typed thought');
    writeDraft('s_other', 'another session in progress');
    await mount();
    await toCapabilitiesStep();
    await click(buttonByText('Set up with Kiki'));
    await flush();
    expect(readDraft('new')).toBe('half-typed thought');
    expect(readDraft('s_other')).toBe('another session in progress');
  });

  it('a rejected create leaves the wizard open, unmarked, and the same button retries', async () => {
    createSession.mockRejectedValueOnce(new Error('server offline'));
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(buttonByText('Set up with Kiki'));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // Not marked complete: the auto-popup must still be able to fire for a run
    // that never reached its own hand-off.
    expect(localStorage.getItem('kiki.onboarding')).toBeNull();
    expect(dialog().textContent).toContain('server offline');
    // The same button retries, and one success is one session.
    await click(buttonByText('Set up with Kiki'));
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
    expect(dialog().textContent).toContain('Step 3 of 4');
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
    await click(buttonByText('Set up with Kiki'));
    await flush();
    expect(previewHostSkillInstall).not.toHaveBeenCalled();
    expect(installHostSkill).not.toHaveBeenCalled();
    // One session for the hand-off, not one per optional row.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Set up later" only closes the dialog — no session, no navigation, no draft', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(buttonByText('Set up later'));
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
});

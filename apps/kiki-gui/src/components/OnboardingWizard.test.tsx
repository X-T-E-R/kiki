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
  await typeInto(inputByPlaceholder('model-id'), 'kimi-for-coding');
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
    await click(dialog().querySelector('[data-model-suggestion="kimi-for-coding"]')!);
    expect(inputByPlaceholder('model-id').value).toBe('kimi-for-coding');
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
    await typeInto(inputByPlaceholder('model-id'), 'mistral-large');
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
    await typeInto(inputByPlaceholder('model-id'), 'claude-x');
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

  it('finishes on the /new hero without touching the /new target or draft', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    expect(dialog().querySelector('[data-workspace-choice]')).toBeNull();
    await click(buttonByText('Start'));
    await flush();
    expect(createSession).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/new');
    expect(readDraft('new')).toBe('');
    // No workspace step: /new keeps its own default (recent workspace, else Kiki Home).
    expect(readNewSessionDraft().workspaceId).toBeUndefined();
    expect(readNewSessionDraft().cwd).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('never overwrites a /new draft the user already typed', async () => {
    const { writeDraft } = await import('@kiki/session-core/composer');
    writeDraft('new', 'half-typed thought');
    await mount();
    await toCapabilitiesStep();
    await click(buttonByText('Start'));
    await flush();
    expect(readDraft('new')).toBe('half-typed thought');
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

  it('Start skips the capabilities page without using any of it', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toCapabilitiesStep();
    await click(buttonByText('Start'));
    await flush();
    expect(createSession).not.toHaveBeenCalled();
    expect(previewHostSkillInstall).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/new');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

/**
 * OnboardingWizard — the first-run dialog: the auto-popup decision rule
 * (shouldOfferOnboarding), the three-step walk, the save semantics of every
 * advance ("Save & continue" persists the provider form; finish persists the
 * permission default), exit-and-re-entry state, and the finish hand-off
 * (session + `/kiki-ops …` composer prefill).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSummary } from '@kiki/protocol';
import { clearStoredDrafts, readDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import {
  OnboardingWizard,
  requestOnboardingOpen,
  shouldOfferOnboarding,
  subscribeOnboardingOpenRequests,
} from './OnboardingWizard';

const WELCOME_DRAFT_EN =
  "/kiki-ops I'm new here. Help me finish setup, then briefly explain what a subagent profile is and ask what kind I'd like to create.";
const WELCOME_DRAFT_ZH =
  '/kiki-ops 我是新用户，帮我完成设置。请简要解释什么是 subagent profile，再问我想创建什么样的角色。';

const getAuth = vi.fn();
const listProviders = vi.fn();
const listModels = vi.fn();
const getConfig = vi.fn();
const getOAuthStatus = vi.fn();
const patchConfig = vi.fn();
const listWorkspaces = vi.fn();
const createSession = vi.fn();
const createProvider = vi.fn();
const probeProviderDraft = vi.fn();
const navigate = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: {
      getAuth,
      listProviders,
      listModels,
      getConfig,
      getOAuthStatus,
      startOAuthLogin: vi.fn(),
      cancelOAuthLogin: vi.fn(),
      patchConfig,
      listWorkspaces,
      createSession,
      createProvider,
      probeProviderDraft,
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
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => ({
    default_permission_mode: patch['default_permission_mode'] ?? 'manual',
  }));
  listWorkspaces.mockReset().mockResolvedValue({ items: [] });
  createSession.mockReset().mockResolvedValue({ id: 's_onboarding_1' });
  createProvider.mockReset().mockResolvedValue({ id: 'kimi', revision: 'r1' });
  probeProviderDraft.mockReset().mockResolvedValue([]);
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

/** Walk from the welcome step onto the model step. */
async function toModelStep(): Promise<void> {
  await click(buttonByText('Next'));
}

/** Fill the template → key → model id path on the model step. */
async function fillProviderForm(): Promise<void> {
  await click(dialog().querySelector('[data-provider-template="kimi"]')!);
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

describe('OnboardingWizard', () => {
  it('opens on the welcome step with language and theme picks', async () => {
    await mount();
    expect(dialog().getAttribute('aria-label')).toBe('Welcome to Kiki');
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(dialog().textContent).toContain('Language');
    expect(dialog().textContent).toContain('Theme');
  });

  it('walks forward and back through all three steps', async () => {
    await mount();
    await toModelStep();
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(buttonByText('Sign in with Kimi')).toBeDefined();
    expect(dialog().textContent).toContain('Or connect with an API key');

    await click(buttonByText('Next'));
    expect(dialog().textContent).toContain('Step 3 of 3');
    expect(dialog().textContent).toContain('Permissions');

    await click(buttonByText('Back'));
    expect(dialog().textContent).toContain('Step 2 of 3');
  });

  it('a pristine model step advances without saving anything', async () => {
    await mount();
    await toModelStep();
    await click(buttonByText('Next'));
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Step 3 of 3');
  });

  it('Save & continue persists the filled provider form before advancing', async () => {
    await mount();
    await toModelStep();
    await fillProviderForm();
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).toHaveBeenCalledTimes(1);
    const body = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['id']).toBe('kimi');
    expect(body['type']).toBe('kimi');
    expect(body['api_key']).toBe('sk-test-key');
    expect(body['default_model']).toBe('kimi-for-coding');
    expect(body['models']).toEqual([
      expect.objectContaining({ remote_id: 'kimi-for-coding' }),
    ]);
    expect(dialog().textContent).toContain('Step 3 of 3');
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
    await click(dialog().querySelector('[data-provider-template="kimi"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-probe-me');
    await click(buttonByText('Test connection'));
    await flush();
    expect(probeProviderDraft).toHaveBeenCalledWith({
      type: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-probe-me',
    });
    expect(createProvider).not.toHaveBeenCalled();
    // Tapping a suggestion chip fills the model field.
    await click(dialog().querySelector('[data-model-suggestion="kimi-for-coding"]')!);
    expect(inputByPlaceholder('model-id').value).toBe('kimi-for-coding');
  });

  it('a started but invalid form blocks the advance with an inline error', async () => {
    await mount();
    await toModelStep();
    // Template + key but no model id — the draft fails validation.
    await click(dialog().querySelector('[data-provider-template="kimi"]')!);
    await typeInto(inputByPlaceholder('Paste a new key'), 'sk-test-key');
    await click(buttonByText('Save & continue'));
    await flush();
    expect(createProvider).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Model IDs cannot be empty.');
    expect(dialog().textContent).toContain('Step 2 of 3');
  });

  it('keeps the unsubmitted form when going Back and returning', async () => {
    await mount();
    await toModelStep();
    await click(dialog().querySelector('[data-provider-template="kimi"]')!);
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

    // Leave the wizard; the "server" now holds the created provider.
    await click(buttonByText('Set up later'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmountLast();
    listProviders.mockResolvedValue({ items: [SAVED_PROVIDER] });
    getAuth.mockResolvedValue({ ...AUTH_EMPTY, ready: true, providers_count: 1 });

    // Re-entry: the model step reads the persisted connection, and advancing
    // saves nothing again.
    await mount();
    await toModelStep();
    await flush();
    expect(dialog().textContent).toContain('A model provider is connected');
    await click(buttonByText('Next'));
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(dialog().textContent).toContain('Step 3 of 3');
  });

  it('preselects auto on a fresh run and finish writes it to the server config', async () => {
    await mount();
    await toModelStep();
    await click(buttonByText('Next'));
    const autoOption = [...dialog().querySelectorAll('[role="radio"]')].find(
      (candidate) => candidate.textContent?.includes('auto'),
    );
    expect(autoOption?.getAttribute('aria-checked')).toBe('true');
    expect(dialog().textContent).toContain('Recommended');
    await click(buttonByText('Start chatting'));
    await flush();
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'auto' });
  });

  it('a replay shows the server’s explicit permission choice instead of forcing auto', async () => {
    localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    getConfig.mockResolvedValue({ default_permission_mode: 'yolo' });
    await mount();
    await toModelStep();
    await click(buttonByText('Next'));
    const yoloOption = [...dialog().querySelectorAll('[role="radio"]')].find(
      (candidate) => candidate.textContent?.includes('yolo'),
    );
    expect(yoloOption?.getAttribute('aria-checked')).toBe('true');
  });

  it('marks completion and closes on "Set up later"', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await click(buttonByText('Set up later'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('finishes into a fresh session with the kiki-ops setup prompt prefilled when a workspace exists', async () => {
    const onClose = vi.fn();
    listWorkspaces.mockResolvedValue({
      items: [
        {
          id: 'wd_a',
          root: 'C:/proj',
          name: 'proj',
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
          session_count: 0,
          pinned: false,
        },
      ],
    });
    await mount(onClose);
    await toModelStep();
    await click(buttonByText('Next'));
    await click(buttonByText('Start chatting'));
    await flush();
    expect(createSession).toHaveBeenCalledWith({ workspace_id: 'wd_a' });
    expect(readDraft('s_onboarding_1')).toBe(WELCOME_DRAFT_EN);
    expect(navigate).toHaveBeenCalledWith('/s/s_onboarding_1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('finishes onto the /new draft with the same prefill when no workspace exists', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await toModelStep();
    await click(buttonByText('Next'));
    await click(buttonByText('Start chatting'));
    await flush();
    expect(createSession).not.toHaveBeenCalled();
    expect(readDraft('new')).toBe(WELCOME_DRAFT_EN);
    expect(navigate).toHaveBeenCalledWith('/new');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('localizes the short profile invitation in the Chinese welcome draft', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    await mount();
    await click(buttonByText('下一步'));
    await click(buttonByText('下一步'));
    await click(buttonByText('开始对话'));
    await flush();
    expect(readDraft('new')).toBe(WELCOME_DRAFT_ZH);
  });

  it('never overwrites a /new draft the user already typed', async () => {
    const { writeDraft } = await import('@kiki/session-core/composer');
    writeDraft('new', 'half-typed thought');
    await mount();
    await toModelStep();
    await click(buttonByText('Next'));
    await click(buttonByText('Start chatting'));
    await flush();
    expect(readDraft('new')).toBe('half-typed thought');
  });
});

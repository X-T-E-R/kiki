// @vitest-environment jsdom

/**
 * OnboardingWizard — the first-run dialog: the auto-popup decision rule
 * (shouldOfferOnboarding), step navigation, the always-marks-completed exit
 * paths, and the finish hand-off (session + `/kiki-ops …` composer prefill).
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
  "/kiki-ops I'm new here — check my current setup and help me finish the remaining recommended configuration.";

const getAuth = vi.fn();
const listProviders = vi.fn();
const listModels = vi.fn();
const getConfig = vi.fn();
const getOAuthStatus = vi.fn();
const patchConfig = vi.fn();
const listWorkspaces = vi.fn();
const createSession = vi.fn();
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
  it('opens on the provider step with sign-in and the API-key wizard', async () => {
    await mount();
    expect(dialog().getAttribute('aria-label')).toBe('Welcome to Kiki');
    expect(dialog().textContent).toContain('Step 1 of 3');
    expect(buttonByText('Sign in with Kimi')).toBeDefined();
    expect(dialog().textContent).toContain('Or add an API key');
  });

  it('walks forward and back through all three steps', async () => {
    await mount();
    await click(buttonByText('Next'));
    expect(dialog().textContent).toContain('Step 2 of 3');
    expect(dialog().textContent).toContain('Language');
    expect(dialog().textContent).toContain('Theme');
    expect(dialog().textContent).toContain('Default permission mode');

    await click(buttonByText('Next'));
    expect(dialog().textContent).toContain('Step 3 of 3');
    expect(buttonByText('Set up search & retrieval')).toBeDefined();

    await click(buttonByText('Back'));
    expect(dialog().textContent).toContain('Step 2 of 3');
  });

  it('marks completion and closes on skip', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await click(buttonByText('Skip setup'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('writes the permission default through the server config', async () => {
    await mount();
    await click(buttonByText('Next'));
    await click(buttonByText('auto'));
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'auto' });
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
    await click(buttonByText('Next'));
    await click(buttonByText('Next'));
    await click(buttonByText('Start chatting'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createSession).toHaveBeenCalledWith({ workspace_id: 'wd_a' });
    const draft = readDraft('s_onboarding_1');
    expect(draft).toContain(WELCOME_DRAFT_EN);
    expect(draft).toContain('Ask whether I want implementer in <KIKI_HOME>/agents/implementer.md');
    expect(draft).toContain('then separately whether I want reviewer in <KIKI_HOME>/agents/reviewer.md');
    expect(draft).toContain('Only after I agree to each specific profile');
    expect(draft).toContain('built-in kiki-profile skill');
    expect(draft).toContain('model_alias: inherit unchanged');
    expect(draft).toContain('follows the model used by its parent at dispatch time');
    expect(draft).toContain('change it to a fixed model in Settings');
    expect(navigate).toHaveBeenCalledWith('/s/s_onboarding_1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('finishes onto the /new draft with the same prefill when no workspace exists', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await click(buttonByText('Next'));
    await click(buttonByText('Next'));
    await click(buttonByText('Start chatting'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(readDraft('new')).toContain(WELCOME_DRAFT_EN);
    expect(readDraft('new')).toContain('Only after I agree to each specific profile');
    expect(navigate).toHaveBeenCalledWith('/new');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('localizes the per-profile opt-in in the Chinese welcome draft', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    await mount();
    await click(buttonByText('下一步'));
    await click(buttonByText('下一步'));
    await click(buttonByText('开始对话'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const draft = readDraft('new');
    expect(draft).toContain('/kiki-ops 我是新用户');
    expect(draft).toContain('先问我要不要在 <KIKI_HOME>/agents/implementer.md 创建 implementer');
    expect(draft).toContain('再单独问我要不要在 <KIKI_HOME>/agents/reviewer.md 创建 reviewer');
    expect(draft).toContain('只有我对某个角色明确同意后');
    expect(draft).toContain('加载内置 kiki-profile skill');
    expect(draft).toContain('保留示例中的 model_alias: inherit');
    expect(draft).toContain('跟随父 Agent 派发时使用的模型');
    expect(draft).toContain('可在设置中改为固定模型');
  });

  it('never overwrites a /new draft the user already typed', async () => {
    const { writeDraft } = await import('@kiki/session-core/composer');
    writeDraft('new', 'half-typed thought');
    await mount();
    await click(buttonByText('Next'));
    await click(buttonByText('Next'));
    await click(buttonByText('Start chatting'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(readDraft('new')).toBe('half-typed thought');
  });
});

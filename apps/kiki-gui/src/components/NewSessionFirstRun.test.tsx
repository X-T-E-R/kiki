// @vitest-environment jsdom

/**
 * First-run surface of /new: the native folder picker in the workspace
 * popover, the empty-catalog explanation, and the provider-readiness rule
 * behind the hero guidance card. Also pins what the page itself carries: the
 * target row and the claim, and nothing that repeats the sidebar's session
 * list or the composer's agent picker.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSummary } from '@kiki/protocol';
import { resolveSettingsRoute, SETTINGS_SEARCH_SPEC } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import {
  AUTO_WORKSPACE_ID,
  WorkspacePickerFields,
  needsProviderSetup,
  type NewSessionDraftState,
} from './NewSessionDraft';
import { NewSessionPage } from './NewSessionPage';

const firstRun = vi.hoisted(() => ({
  needsProviderSetup: false,
  selectionReady: true,
  creationPending: false,
  seat: undefined as import('./ConversationShell').ConversationSeat | undefined,
  client: {
    startOAuthLogin: vi.fn(),
    cancelOAuthLogin: vi.fn(),
    createProvider: vi.fn(),
  },
}));

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: firstRun.client }),
}));

vi.mock('./Composer', () => ({ Composer: () => null }));

// The hero publishes its footer through the shell's slots; a detached node
// would swallow the portal, so the stub owns a real (body-attached) one.
vi.mock('./ConversationShell', () => {
  const heroFooter = document.createElement('div');
  heroFooter.id = 'first-run-hero-footer';
  document.body.append(heroFooter);
  // One stable slots object: a fresh identity per render would make the
  // shell's slot bookkeeping (and any consumer memo) churn every render.
  const slots = { header: null, dock: null, heroFooter, rail: null, footer: null, preview: null };
  return {
    useConversationShell: () => ({ slots }),
    useRegisterSeat: (seat: import('./ConversationShell').ConversationSeat) => { firstRun.seat = seat; },
  };
});

// Only the draft hook is stubbed: this file also exercises the real
// WorkspacePickerFields and needsProviderSetup helpers.
vi.mock('./NewSessionDraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./NewSessionDraft')>();
  return {
    ...actual,
    useNewSessionDraft: () => ({
      draft: '',
      attachments: [],
      busy: false,
      creationPending: firstRun.creationPending,
      creationNotice: null,
      createdSessionId: undefined,
      openCreatedSession: () => {},
      selectionReady: firstRun.selectionReady,
      targetReady: true,
      workspacesError: null,
      retryWorkspaces: () => {},
      cancelCreation: () => {},
      error: null,
      workspaceId: '',
      cwd: '',
      permissionMode: 'manual',
      planMode: false,
      goalObjective: '',
      modelOverride: undefined,
      agentProfile: '',
      workspaces: [],
      workspacesLoading: false,
      effectiveWorkspace: undefined,
      autoWorkspace: true,
      agentProfileCatalogMode: { mode: 'unscoped' },
      agentProfileCatalogPending: false,
      needsProviderSetup: firstRun.needsProviderSetup,
      canBrowseForWorkspace: false,
      browseForWorkspace: async () => {},
      serverDefaultModel: undefined,
      inheritedDefault: undefined,
      modelSource: undefined,
      supportedEfforts: [],
      effectiveEffort: undefined,
      updateDraft: () => {},
      setAttachments: () => {},
      selectWorkspace: () => {},
      setCwd: () => {},
      setPermissionMode: () => {},
      setPlanMode: () => {},
      setGoalObjective: () => {},
      setModelOverride: () => {},
      setAgentProfile: () => {},
      setEffortOverride: () => {},
      send: () => {},
      activateSkill: () => {},
    }),
  };
});

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  firstRun.needsProviderSetup = false;
  firstRun.selectionReady = true;
  firstRun.creationPending = false;
  firstRun.seat = undefined;
  localStorage.setItem('kiki.locale', 'en');
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function draftState(overrides: Partial<NewSessionDraftState> = {}): NewSessionDraftState {
  return {
    workspaces: [],
    workspacesLoading: false,
    workspacesError: null,
    retryWorkspaces: () => {},
    sshLabel: null,
    effectiveWorkspace: undefined,
    autoWorkspace: true,
    workspaceId: '',
    cwd: '',
    canBrowseForWorkspace: false,
    browseForWorkspace: async () => {},
    selectWorkspace: () => {},
    setCwd: () => {},
    ...overrides,
  } as unknown as NewSessionDraftState;
}

async function mount(state: NewSessionDraftState): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <WorkspacePickerFields state={state} />
      </I18nProvider>,
    );
  });
  return container;
}

describe('WorkspacePickerFields first-run affordances', () => {
  it('shows workspace failures with an explicit retry instead of first-run automatic creation', async () => {
    const retryWorkspaces = vi.fn();
    const container = await mount(draftState({ autoWorkspace: false, workspacesError: 'Read failed (code 50001)', retryWorkspaces }));
    expect(container.textContent).toContain('Read failed (code 50001)');
    expect(container.textContent).not.toContain('Choose a project folder, or send now');
    expect(container.querySelector('#new-workspace-select')?.textContent).toContain('Choose workspace');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry');
    await act(async () => { retry?.click(); });
    expect(retryWorkspaces).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input[type="text"]')).not.toBeNull();
  });

  it('offers the native folder picker on desktop and hides it in the browser', async () => {
    const desktop = await mount(draftState({ canBrowseForWorkspace: true }));
    expect(desktop.querySelector('[data-new-browse]')).not.toBeNull();

    const browser = await mount(draftState({ canBrowseForWorkspace: false }));
    expect(browser.querySelector('[data-new-browse]')).toBeNull();
    // The typed-path escape hatch stays in both builds.
    expect(browser.querySelector('input[type="text"]')).not.toBeNull();
  });

  it('routes the browse button to the native picker', async () => {
    const browseForWorkspace = vi.fn(async () => {});
    const container = await mount(
      draftState({ canBrowseForWorkspace: true, browseForWorkspace }),
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-new-browse]')?.click();
    });
    expect(browseForWorkspace).toHaveBeenCalledTimes(1);
  });

  it('explains the first-run automatic workspace only while the catalog is empty', async () => {
    const empty = await mount(draftState());
    expect(empty.textContent).toContain('Choose a project folder, or send now');
    expect(empty.textContent).toContain('create a new folder in Kiki Home');
    expect(empty.querySelector<HTMLButtonElement>('#new-workspace-select')?.disabled).toBe(false);

    const loading = await mount(draftState({ workspacesLoading: true }));
    expect(loading.textContent).not.toContain('Choose a project folder, or send now');

    const populated = await mount(
      draftState({
        autoWorkspace: false,
        workspaces: [
          {
            id: 'wd_a',
            root: 'C:/proj',
            name: 'proj',
            created_at: '2026-01-01T00:00:00.000Z',
            last_opened_at: '2026-01-01T00:00:00.000Z',
            session_count: 0,
            pinned: false,
            isGit: false,
          },
        ],
      }),
    );
    expect(populated.textContent).not.toContain('Choose a project folder, or send now');
  });

  it('offers explicit automatic allocation even when workspaces already exist', async () => {
    const selectWorkspace = vi.fn();
    const container = await mount(draftState({
      workspaceId: 'wd_a',
      autoWorkspace: false,
      effectiveWorkspace: {
        id: 'wd_a', root: 'C:/proj', name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
        session_count: 0, pinned: false, isGit: false,
      },
      workspaces: [{
        id: 'wd_a', root: 'C:/proj', name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
        session_count: 0, pinned: false, isGit: false,
      }],
      selectWorkspace,
    }));
    await act(async () => { container.querySelector<HTMLButtonElement>('#new-workspace-select')?.click(); });
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent?.includes('Automatically create a workspace'));
    expect(option?.textContent).toContain('create a new folder in Kiki Home');
    await act(async () => { option?.click(); });
    expect(selectWorkspace).toHaveBeenCalledWith(AUTO_WORKSPACE_ID);
  });
});

describe('needsProviderSetup', () => {
  const auth = (overrides: Partial<AuthSummary> = {}): AuthSummary => ({
    ready: false,
    providers_count: 0,
    default_model: null,
    managed_provider: null,
    ...overrides,
  });

  it('guides only when the server reports neither a provider nor a model', () => {
    expect(needsProviderSetup(auth(), [])).toBe(true);
  });

  it('stays silent once either probe reports something usable', () => {
    expect(needsProviderSetup(auth({ ready: true, providers_count: 1 }), [])).toBe(false);
    expect(needsProviderSetup(auth(), [{ model: 'kimi-k2' }])).toBe(false);
  });

  it('stays silent while a probe is in flight or failed', () => {
    expect(needsProviderSetup(undefined, [])).toBe(false);
    expect(needsProviderSetup(auth(), undefined)).toBe(false);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <span data-location>{`${location.pathname}${location.search}${location.hash}`}</span>;
}

async function mountNewSessionPage(): Promise<HTMLDivElement> {
  document.querySelector('#first-run-hero-footer')!.replaceChildren();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/new']}>
            <LocationProbe />
            <Routes>
              <Route path="/new" element={<NewSessionPage onToggleSidebar={() => {}} />} />
              <Route path="/settings/:section" element={<span data-settings-destination />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe('the /new page', () => {
  it.each([[false, false], [true, true]] as const)('publishes send gating for selectionReady=%s and creationPending=%s without locking typing', async (selectionReady, creationPending) => {
    firstRun.selectionReady = selectionReady;
    firstRun.creationPending = creationPending;
    await mountNewSessionPage();
    const provider = firstRun.seat?.composer as import('react').ReactElement<{ children: import('react').ReactElement<{ disabled: boolean; sendDisabled: boolean }> }>;
    expect(provider.props.children.props.sendDisabled).toBe(true);
    expect(provider.props.children.props.disabled).toBe(false);
  });

  it('shows automatic workspace creation without a workspace-required warning', async () => {
    const container = await mountNewSessionPage();
    expect(container.querySelector('[data-hero-target] [data-hero-workspace]')?.textContent).toContain('Automatically create a workspace');
    expect(container.textContent).not.toContain('Choose another workspace');
  });

  it('states what kiki is instead of asking an empty question', async () => {
    const container = await mountNewSessionPage();
    expect(container.querySelector('[data-hero-brand] [data-hero-headline]')?.textContent).toBe('Your agents, your call.');
  });

  it('keeps the temporary switch on the target row', async () => {
    const container = await mountNewSessionPage();
    expect(container.querySelector('[data-hero-target] [data-new-ephemeral-toggle]')).not.toBeNull();
  });

  it('carries no session list or agent roster of its own', async () => {
    const container = await mountNewSessionPage();
    const footer = document.querySelector('#first-run-hero-footer')!;
    // Starters stay: they only fill the draft.
    expect(footer.querySelectorAll('[data-hero-starter]').length).toBeGreaterThan(0);
    for (const scope of [container, footer]) {
      expect(scope.querySelector('[data-hero-recents], [data-hero-team], [data-hero-pulse], [data-agent-capabilities]')).toBeNull();
    }
  });

  it.each([
    ['en', 0, 'Sign in with an account', 'st-card-auth'],
    ['en', 1, 'Use an API key or local server', 'st-card-providers-add'],
    ['zh', 0, '使用账号登录', 'st-card-auth'],
    ['zh', 1, '填写 API 密钥或本地服务', 'st-card-providers-add'],
  ] as const)('routes the %s connection choice %i to its own settings lane without authentication side effects', async (locale, choice, label, cardId) => {
    firstRun.needsProviderSetup = true;
    localStorage.setItem('kiki.locale', locale);
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const container = await mountNewSessionPage();
      // At rest the prompt is one quiet line, not a card competing with the starters.
      expect(document.querySelector('#first-run-hero-footer [data-provider-setup="card"]')).toBeNull();
      const line = document.querySelector('#first-run-hero-footer [data-provider-setup="quiet"]')!;
      const buttons = line.querySelectorAll('button');
      expect(buttons).toHaveLength(2);
      expect(buttons[choice]?.textContent).toBe(label);
      expect(line.textContent).not.toContain('Kimi');
      await act(async () => { buttons[choice]!.click(); });
      expect(container.querySelector('[data-location]')?.textContent)
        .toBe(`/settings/ai?tab=providers#${cardId}`);
      expect(container.querySelector('[data-settings-destination]')).not.toBeNull();
      expect(SETTINGS_SEARCH_SPEC.find((entry) => entry.cardId === cardId))
        .toMatchObject({ section: 'ai', tab: 'providers' });
      expect(resolveSettingsRoute('ai', `#${cardId}`))
        .toMatchObject({ status: 'ok', section: 'ai', tab: 'providers', cardId });
      expect(firstRun.client.startOAuthLogin).not.toHaveBeenCalled();
      expect(firstRun.client.cancelOAuthLogin).not.toHaveBeenCalled();
      expect(firstRun.client.createProvider).not.toHaveBeenCalled();
      expect(openWindow).not.toHaveBeenCalled();
    } finally {
      openWindow.mockRestore();
    }
  });

  it('turns the quiet connection line into a card once the user tries to send', async () => {
    firstRun.needsProviderSetup = true;
    await mountNewSessionPage();
    const footer = document.querySelector('#first-run-hero-footer')!;
    expect(footer.querySelector('[data-provider-setup="quiet"]')).not.toBeNull();
    expect(footer.querySelector('[data-provider-setup="card"]')).toBeNull();
    const seat = firstRun.seat?.composer as import('react').ReactElement<{ children: import('react').ReactElement<{ onSend: () => unknown }> }>;
    await act(async () => { seat.props.children.props.onSend(); });
    const card = footer.querySelector('[data-provider-setup="card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Connect a model to send');
    const buttons = card!.querySelectorAll('button');
    expect(Array.from(buttons, (button) => button.textContent)).toEqual(['Sign in with an account', 'Use an API key or local server']);
    expect(footer.querySelector('[data-provider-setup="quiet"]')).toBeNull();
    expect(firstRun.client.startOAuthLogin).not.toHaveBeenCalled();
    expect(firstRun.client.createProvider).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

/**
 * First-run surface of /new: the native folder picker in the workspace
 * popover, the empty-catalog explanation, the provider-readiness rule, and the
 * connect card that takes the composer's place without a model (no dialog, no
 * check of this computer and no connection until the person presses; a typed
 * key counts only once a real request with it answers). Also
 * pins what the page itself carries: the target row and the claim, the tour
 * line only on a server with no conversations, and nothing that repeats the
 * sidebar's session list or the composer's agent picker.
 */

import { act, useCallback, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSummary, ExecutorCatalogItem, Workspace } from '@kiki/protocol';
import type { ExecutionChoice } from '@kiki/session-core/composer';

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
  creationNotice: null as string | null,
  createdSessionId: undefined as string | undefined,
  checkingCreation: false,
  retryCreation: vi.fn(async () => {}),
  openCreatedSession: vi.fn(async () => {}),
  startNewCreation: vi.fn(),
  dismissCreationIntent: vi.fn(),
  hasCreationIntent: false,
  seat: undefined as import('./ConversationShell').ConversationSeat | undefined,
  workspacesFailed: false,
  workspacesError: null as string | null,
  retryWorkspaces: (() => {}) as () => void,
  workspaceId: '',
  effectiveWorkspace: undefined as any,
  execution: { executor: 'native', profile: 'agent', overrides: undefined } as any,
  client: {
    startOAuthLogin: vi.fn(),
    cancelOAuthLogin: vi.fn(),
    createProvider: vi.fn(),
    listOAuthMethods: vi.fn(async (): Promise<unknown[]> => []),
    probeOriginalOAuth: vi.fn(async (_body: { provider: string }): Promise<unknown> => ({})),
    connectOriginalOAuth: vi.fn(async (_body: { provider: string; expected_account_id?: string }): Promise<unknown> => ({})),
    listSessions: vi.fn(async (): Promise<unknown> => ({ items: [{ id: 'session-example' }], has_more: false })),
    listModels: vi.fn(async (): Promise<{ items: { id: string }[] }> => ({ items: [] })),
    listExecutors: vi.fn(async (): Promise<{ items: ExecutorCatalogItem[] }> => ({ items: [] })),
    listCatalogProviders: vi.fn(async (): Promise<{ items: unknown[] }> => ({ items: [] })),
    listProviders: vi.fn(async (): Promise<{ items: { id: string }[] }> => ({ items: [] })),
    importCatalogProvider: vi.fn(async (body: { catalog_id: string; api_key?: string }): Promise<unknown> => ({ provider: { id: body.catalog_id }, models_imported: 1 })),
    testProviderConnection: vi.fn(async (_providerId: string): Promise<unknown> => ({})),
    deleteProviderEntity: vi.fn(async (_providerId: string): Promise<void> => {}),
    getConfig: vi.fn(async (): Promise<{ default_model?: string }> => ({})),
    setDefaultModel: vi.fn(async (_modelId: string): Promise<unknown> => ({})),
  },
  discovery: null as { state: { lifecycle: string }; startRoute: (route: string) => Promise<boolean> } | null,
}));

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: firstRun.client, scopeId: 'first-run', meta: undefined }),
}));

vi.mock('./discovery', async (importOriginal) => ({
  ...await importOriginal<typeof import('./discovery')>(),
  useOptionalDiscovery: () => firstRun.discovery,
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
    useNewSessionDraft: () => {
      const [execution, setExecutionState] = useState(firstRun.execution);
      const setExecution = useCallback((next: ExecutionChoice) => {
        firstRun.execution = next;
        setExecutionState(next);
      }, []);
      return {
        draft: '',
      attachments: [],
      busy: false,
      creationPending: firstRun.creationPending,
      creationNotice: firstRun.creationNotice,
      createdSessionId: firstRun.createdSessionId,
      openCreatedSession: firstRun.openCreatedSession,
      checkCreation: async () => {},
      checkingCreation: firstRun.checkingCreation,
      retryCreation: firstRun.retryCreation,
      startNewCreation: firstRun.startNewCreation,
      dismissCreationIntent: firstRun.dismissCreationIntent,
      hasCreationIntent: firstRun.hasCreationIntent,
      selectionReady: firstRun.selectionReady,
      targetReady: true,
      workspacesFailed: firstRun.workspacesFailed,
      workspacesError: firstRun.workspacesError,
      retryWorkspaces: firstRun.retryWorkspaces,
      cancelCreation: () => {},
      error: null,
      workspaceId: firstRun.workspaceId,
      cwd: '',
      permissionMode: 'manual',
      planMode: false,
      goalObjective: '',
      modelOverride: undefined,
      agentProfile: '',
      workspaces: [],
      workspacesLoading: false,
      effectiveWorkspace: firstRun.effectiveWorkspace,
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
      execution,
      setExecution,
      send: () => {},
      activateSkill: () => {},
    };
  },
  };
});

type SeatComposerProps = {
  readonly execution: ExecutionChoice;
  readonly onChangeExecution: (next: ExecutionChoice) => void;
};

function composerFromSeat(): ReactElement<SeatComposerProps> {
  const seat = firstRun.seat?.composer as ReactElement<{ readonly children?: ReactElement<SeatComposerProps> }> | undefined;
  const composer = seat?.props.children;
  if (composer?.props.execution === undefined || composer.props.onChangeExecution === undefined) {
    throw new Error('The /new seat did not publish Composer');
  }
  return composer;
}

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
  firstRun.creationNotice = null;
  firstRun.createdSessionId = undefined;
  firstRun.checkingCreation = false;
  firstRun.hasCreationIntent = false;
  firstRun.seat = undefined;
  firstRun.execution = { executor: 'native', profile: 'agent', overrides: undefined };
  firstRun.workspacesFailed = false;
  firstRun.workspacesError = null;
  firstRun.workspaceId = '';
  firstRun.effectiveWorkspace = undefined;
  firstRun.discovery = null;
  localStorage.setItem('kiki.locale', 'en');
  localStorage.removeItem('kiki.firstRun');
  localStorage.removeItem('kiki.onboarding');
  vi.clearAllMocks();
  firstRun.client.listSessions.mockResolvedValue({ items: [{ id: 'session-example' }], has_more: false });
  firstRun.client.listExecutors.mockReset().mockResolvedValue({ items: [] });
});

async function unmountAll() {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
}

afterEach(unmountAll);

/** Let query results and lazy modules land, render by render. */
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

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

  it('routes the browse button to the native picker with localized aria-label', async () => {
    const browseForWorkspace = vi.fn(async () => {});
    const container = await mount(
      draftState({ canBrowseForWorkspace: true, browseForWorkspace }),
    );

    const browseBtn = container.querySelector<HTMLButtonElement>('[data-new-browse]');
    expect(browseBtn).not.toBeNull();
    expect(browseBtn?.getAttribute('aria-label')).toBe('Browse folder…');
    expect(browseBtn?.getAttribute('title')).toBe('Browse folder…');

    await act(async () => {
      browseBtn?.click();
    });
    expect(browseForWorkspace).toHaveBeenCalledTimes(1);
  });

  it('explains the first-run automatic workspace only while the catalog is empty', async () => {
    const empty = await mount(draftState());
    expect(empty.textContent).toContain('Choose a project folder, or send now');
    expect(empty.textContent).toContain('create a workspace in Kiki Home');
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
            pinned: false,
          },
        ],
      }),
    );
    expect(populated.textContent).not.toContain('Choose a project folder, or send now');
  });

  it('states a failed workspace read instead of borrowing the empty-catalog story', async () => {
    const retryWorkspaces = vi.fn();
    const failed = await mount(draftState({
      workspacesFailed: true,
      workspacesError: 'session index is building',
      autoWorkspace: false,
      retryWorkspaces,
    }));
    expect(failed.querySelector('[data-new-workspace-failure]')?.textContent).toContain('session index is building');
    expect(failed.textContent).not.toContain('Choose a project folder, or send now');
    // Every option survives the failure, including automatic allocation.
    expect(failed.querySelector<HTMLButtonElement>('#new-workspace-select')?.disabled).toBe(false);
    await act(async () => {
      failed.querySelector<HTMLButtonElement>('[data-new-workspace-retry]')?.click();
    });
    expect(retryWorkspaces).toHaveBeenCalledTimes(1);

    const unnamed = await mount(draftState({ workspacesFailed: true, autoWorkspace: false }));
    expect(unnamed.querySelector('[data-new-workspace-failure]')?.textContent).toContain('could not list your workspaces');
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
        pinned: false,
      },
      workspaces: [{
        id: 'wd_a', root: 'C:/proj', name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
        pinned: false,
      }],
      selectWorkspace,
    }));
    await act(async () => { container.querySelector<HTMLButtonElement>('#new-workspace-select')?.click(); });
    const option = [...document.querySelectorAll<HTMLButtonElement>('#new-workspace-select-list [role="option"]')]
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

  it('does not require a native provider for a selected external execution', () => {
    expect(needsProviderSetup(auth(), [], { executor: 'claude-acp' })).toBe(false);
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

  it('exposes recovery, open, new-attempt, and dismiss actions for an unresolved creation', async () => {
    firstRun.hasCreationIntent = true;
    firstRun.creationNotice = 'Creation is not confirmed yet. Check the result to continue with the same session. Starting another conversation keeps this attempt for later.';
    firstRun.createdSessionId = 'session-example';
    const container = await mountNewSessionPage();
    const recovery = container.querySelector<HTMLElement>('[data-new-creation-recovery]');
    expect(recovery?.textContent).toContain('Creation is not confirmed yet');
    const buttons = Array.from(recovery?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Check and continue',
      'Open created session',
      'Start another conversation',
      'Dismiss',
    ]);
    await act(async () => { buttons[0]?.click(); });
    await act(async () => { buttons[1]?.click(); });
    await act(async () => { buttons[2]?.click(); });
    await act(async () => { buttons[3]?.click(); });
    expect(firstRun.retryCreation).toHaveBeenCalledTimes(1);
    expect(firstRun.openCreatedSession).toHaveBeenCalledTimes(1);
    expect(firstRun.startNewCreation).toHaveBeenCalledTimes(1);
    expect(firstRun.dismissCreationIntent).toHaveBeenCalledTimes(1);
  });

  it('shows automatic workspace creation without a workspace-required warning', async () => {
    const container = await mountNewSessionPage();
    expect(container.querySelector('[data-hero-target] [data-hero-workspace]')?.textContent).toContain('Automatically create a workspace');
    expect(container.textContent).not.toContain('Choose another workspace');
  });

  it('refreshes the memoized Composer after an override-only executor-instance change', async () => {
    firstRun.execution = {
      executor: 'claude-acp', profile: undefined, profile_file: undefined,
      overrides: { executor_instance: 'auto' },
    };
    await mountNewSessionPage();
    await settle();
    const before = composerFromSeat().props.execution;
    expect(before.overrides?.['executor_instance']).toBe('auto');
    const changed: ExecutionChoice = {
      ...before,
      overrides: { ...before.overrides, executor_instance: 'instance-work' },
    };
    await act(async () => { composerFromSeat().props.onChangeExecution(changed); });
    expect(composerFromSeat().props.execution).toEqual(changed);
  });

  it('keeps an external-only execution editable with no native model or installed alternative', async () => {
    firstRun.needsProviderSetup = true;
    firstRun.execution = { executor: 'claude-acp', profile: undefined, overrides: undefined };
    const container = await mountNewSessionPage();
    await settle();
    expect(composerFromSeat().props.execution.executor).toBe('claude-acp');
    expect(container.querySelector('[data-hero-target]')).not.toBeNull();
    expect(document.querySelector('#first-run-hero-footer [data-hero-starter]')).not.toBeNull();
  });

  it('keeps the native Composer reachable when an installed external executor still needs authentication', async () => {
    firstRun.needsProviderSetup = true;
    firstRun.client.listExecutors.mockResolvedValue({ items: [{
      id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready',
      model_binding: 'mapped', thinking_binding: 'mapped',
      connection: { command: 'claude', login_status: 'logged_out', default_args: [] },
    }] });
    const container = await mountNewSessionPage();
    await settle();
    expect(composerFromSeat().props.execution.executor).toBe('native');
    expect(container.querySelector('[data-hero-target]')).not.toBeNull();
    expect(document.querySelector('#first-run-hero-footer [data-hero-starter]')).not.toBeNull();
  });

  it('uses the connect card only when native setup is needed and no external engine is available', async () => {
    firstRun.needsProviderSetup = true;
    firstRun.client.listExecutors.mockResolvedValue({ items: [{
      id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'unavailable',
      model_binding: 'mapped', thinking_binding: 'mapped',
      connection: { command: 'claude', login_status: 'logged_out', default_args: [] },
    }] });
    const container = await mountNewSessionPage();
    await settle();
    const seat = firstRun.seat?.composer as ReactElement<{ readonly fallback: null }>;
    expect(seat.props.fallback).toBeNull();
    expect(container.querySelector('[data-hero-target]')).toBeNull();
    expect(document.querySelector('#first-run-hero-footer [data-hero-starter]')).toBeNull();
  });

  it('states a failed workspace read in the hero instead of asking for another target', async () => {
    const retryWorkspaces = vi.fn();
    firstRun.workspacesFailed = true;
    firstRun.workspacesError = 'workspace list unavailable';
    firstRun.retryWorkspaces = retryWorkspaces;
    try {
      const container = await mountNewSessionPage();
      expect(container.querySelector('[data-hero-workspace-failure]')?.textContent).toContain('workspace list unavailable');
      expect(container.textContent).not.toContain('Choose another workspace');
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-hero-workspace-retry]')?.click();
      });
      expect(retryWorkspaces).toHaveBeenCalledTimes(1);
    } finally {
      firstRun.workspacesFailed = false;
      firstRun.workspacesError = null;
      firstRun.retryWorkspaces = () => {};
    }
  });

  it('does not call a chosen workspace unavailable from a list that never loaded', async () => {
    firstRun.workspaceId = 'wd-chosen';
    firstRun.workspacesFailed = true;
    firstRun.workspacesError = 'workspace list unavailable';
    try {
      // A failed read cannot tell an unknown id from one it never got to check,
      // so the failure is stated once with its retry and the choice is kept.
      const container = await mountNewSessionPage();
      expect(container.querySelector('[data-hero-workspace-failure]')?.textContent).toContain('workspace list unavailable');
      expect(container.textContent).not.toContain('is unavailable. Choose a workspace');
    } finally {
      firstRun.workspaceId = '';
      firstRun.workspacesFailed = false;
      firstRun.workspacesError = null;
    }
  });

  it('still reports a chosen workspace the loaded list does not contain', async () => {
    firstRun.workspaceId = 'wd-chosen';
    try {
      const container = await mountNewSessionPage();
      expect(container.querySelector('[data-hero-workspace-failure]')).toBeNull();
      expect(container.textContent).toContain('Workspace “wd-chosen” is unavailable.');
    } finally {
      firstRun.workspaceId = '';
    }
  });

  it.each([
    ['en', 'Automatically create a workspace'],
    ['zh', '自动创建工作区'],
  ] as const)('names the automatic workspace in %s, not as an untitled one', async (locale, expected) => {
    localStorage.setItem('kiki.locale', locale);
    firstRun.effectiveWorkspace = {
      id: 'wd_auto',
      root: 'C:/Users/me/.kiki/workspaces/2026-10-07-a1b2c3d4',
      // Exactly what the server files an auto-allocated workspace under.
      name: 'Untitled workspace 2026-10-07 a1b2c3d4',
      created_at: '2026-10-07T00:00:00.000Z',
      last_opened_at: '2026-10-07T00:00:00.000Z',
      session_count: 1,
      pinned: false,
      isGit: false,
    };
    try {
      const container = await mountNewSessionPage();
      const chip = container.querySelector('[data-hero-target] [data-hero-workspace]');
      expect(chip?.textContent).toContain(expected);
      // The internal name must not surface anywhere the user reads.
      expect(container.textContent).not.toContain('Untitled workspace');
      expect(document.querySelector('#first-run-hero-footer')!.textContent).not.toContain('Untitled workspace');
    } finally {
      firstRun.effectiveWorkspace = undefined;
    }
  });

  it('keeps the name of a workspace the user chose', async () => {
    firstRun.effectiveWorkspace = {
      id: 'wd_named',
      root: 'C:/proj',
      name: 'proj',
      created_at: '2026-10-07T00:00:00.000Z',
      last_opened_at: '2026-10-07T00:00:00.000Z',
      session_count: 1,
      pinned: false,
      isGit: false,
    };
    try {
      const container = await mountNewSessionPage();
      expect(container.querySelector('[data-hero-target] [data-hero-workspace]')?.textContent).toContain('proj');
      expect(document.querySelector('#first-run-hero-footer')!.textContent).toContain('proj');
    } finally {
      firstRun.effectiveWorkspace = undefined;
    }
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

});

describe('first run without a model', () => {
  async function renderSeat(): Promise<HTMLDivElement> {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <I18nProvider>
            <MemoryRouter initialEntries={['/new']}>{firstRun.seat?.composer}</MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    // The card is downloaded on first need; let the lazy module land.
    await act(async () => { await import('./firstRun/ModelConnectCard'); });
    await settle();
    return container;
  }

  it('puts the connect card where the composer goes, opens no dialog, and keeps it out once a model exists', async () => {
    firstRun.needsProviderSetup = true;
    firstRun.client.listOAuthMethods.mockResolvedValue([{
      id: 'openai-codex', provider: 'managed:openai-codex', label: 'ChatGPT (Codex)', protocol: 'oauth',
      signed_in: false, account: { state: 'unknown' }, quota: { state: 'unknown' },
    }]);
    const page = await mountNewSessionPage();
    await settle();
    const seat = await renderSeat();
    expect(seat.querySelector('[data-first-run-card="lanes"]')).not.toBeNull();
    expect([...seat.querySelectorAll<HTMLElement>('[data-first-run-lane]')].map((lane) => lane.dataset['firstRunLane']))
      .toEqual(['account', 'key', 'local']);
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    // The wordmark alone above the card: no claim, no target row, no starters.
    expect(page.querySelector('[data-hero-masthead]')).not.toBeNull();
    expect(page.querySelector('[data-hero-headline]')).toBeNull();
    expect(page.querySelector('[data-hero-target]')).toBeNull();
    expect(document.querySelector('#first-run-hero-footer [data-hero-starter]')).toBeNull();

    await unmountAll();
    firstRun.needsProviderSetup = false;
    await mountNewSessionPage();
    await settle();
    const composerSeat = await renderSeat();
    expect(composerSeat.querySelector('[data-first-run-card]')).toBeNull();
  });

  it('offers the tour line only while the server has no conversations', async () => {
    firstRun.discovery = { state: { lifecycle: 'new' }, startRoute: vi.fn(async () => true) };
    firstRun.client.listSessions.mockResolvedValue({ items: [], has_more: false });
    await mountNewSessionPage();
    await settle();
    const footer = () => document.querySelector('#first-run-hero-footer')!;
    expect(footer().querySelector('[data-first-run-tour]')).not.toBeNull();

    await unmountAll();
    firstRun.client.listSessions.mockResolvedValue({ items: [{ id: 'session-example' }], has_more: false });
    await mountNewSessionPage();
    await settle();
    expect(firstRun.client.listSessions).toHaveBeenCalled();
    expect(footer().querySelector('[data-first-run-tour]')).toBeNull();
  });

  it('puts the tour line away for good on "No thanks" and for someone who finished the old wizard', async () => {
    firstRun.discovery = { state: { lifecycle: 'new' }, startRoute: vi.fn(async () => true) };
    firstRun.client.listSessions.mockResolvedValue({ items: [], has_more: false });
    await mountNewSessionPage();
    await settle();
    const footer = () => document.querySelector('#first-run-hero-footer')!;
    await act(async () => { footer().querySelector<HTMLButtonElement>('[data-first-run-tour-dismiss]')!.click(); });
    expect(footer().querySelector('[data-first-run-tour]')).toBeNull();
    await unmountAll();
    await mountNewSessionPage();
    await settle();
    expect(footer().querySelector('[data-first-run-tour]')).toBeNull();
    expect(firstRun.discovery.startRoute).not.toHaveBeenCalled();

    await unmountAll();
    localStorage.removeItem('kiki.firstRun');
    localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    await mountNewSessionPage();
    await settle();
    expect(footer().querySelector('[data-first-run-tour]')).toBeNull();
  });
});

async function mountCard(onConnected = vi.fn(), onHold = vi.fn()) {
  const { ModelConnectCard } = await import('./firstRun/ModelConnectCard');
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/new']}><ModelConnectCard onConnected={onConnected} onHold={onHold} /></MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return container;
}

describe('the connect card checks this computer only when asked', () => {
  const method = (id: string, provider: string, label: string) => ({
    id, provider, label, protocol: 'oauth', signed_in: false, account: { state: 'unknown' }, quota: { state: 'unknown' },
  });
  const probe = (provider: string, found: boolean) => ({
    provider,
    home_dir: `/home/example/.${provider}`,
    storage_backend: found ? 'file' : null,
    state: found ? 'ready' : 'signed_out',
    account: found ? { state: 'known', id: 'you@example.com' } : { state: 'unknown' },
    can_connect: found,
  });

  beforeEach(() => {
    firstRun.client.listOAuthMethods.mockResolvedValue([
      method('openai-codex', 'managed:openai-codex', 'ChatGPT (Codex)'),
      method('kimi-code', 'managed:kimi-code', 'Kimi Code'),
      method('github-copilot', 'managed:github-copilot', 'GitHub Copilot'),
    ]);
  });

  it('reads nothing on load, states what the press found, and connects only on a second press with that account', async () => {
    firstRun.client.probeOriginalOAuth.mockImplementation(async ({ provider }: { provider: string }) => probe(provider, provider === 'openai-codex'));
    firstRun.client.connectOriginalOAuth.mockImplementation(async ({ provider }: { provider: string }) => probe(provider, true));
    const onConnected = vi.fn();
    const card = await mountCard(onConnected);
    expect(card.querySelector('[data-first-run-card="lanes"]')).not.toBeNull();
    expect(firstRun.client.probeOriginalOAuth).not.toHaveBeenCalled();
    expect(firstRun.client.connectOriginalOAuth).not.toHaveBeenCalled();
    expect(firstRun.client.startOAuthLogin).not.toHaveBeenCalled();

    await act(async () => { card.querySelector<HTMLButtonElement>('[data-first-run-lane="local"]')!.click(); });
    await settle();
    // Only the sign-ins this server can reuse are asked about.
    expect(firstRun.client.probeOriginalOAuth.mock.calls.map(([body]) => body)).toEqual([
      { provider: 'openai-codex' },
      { provider: 'kimi-code' },
    ]);
    expect(card.querySelector('[data-first-run-local-found="openai-codex"]')?.textContent).toContain('Found a Codex sign-in: you@example.com');
    // Nothing on disk for Kimi Code is not a problem to report.
    expect(card.querySelector('[data-first-run-local-found="kimi-code"], [data-first-run-local-blocked]')).toBeNull();
    expect(firstRun.client.connectOriginalOAuth).not.toHaveBeenCalled();

    await act(async () => { card.querySelector<HTMLButtonElement>('[data-first-run-local-use="openai-codex"]')!.click(); });
    await settle();
    expect(firstRun.client.connectOriginalOAuth).toHaveBeenCalledTimes(1);
    expect(firstRun.client.connectOriginalOAuth).toHaveBeenCalledWith({ provider: 'openai-codex', expected_account_id: 'you@example.com' });
    expect(onConnected).toHaveBeenCalledWith('Codex');
  });

  it('says so when the computer has no sign-in to reuse', async () => {
    firstRun.client.probeOriginalOAuth.mockImplementation(async ({ provider }: { provider: string }) => probe(provider, false));
    const card = await mountCard();
    await act(async () => { card.querySelector<HTMLButtonElement>('[data-first-run-lane="local"]')!.click(); });
    await settle();
    expect(card.querySelector('[data-first-run-local-none]')?.textContent).toBe('No usable sign-in was found on the computer running Kiki.');
    expect(firstRun.client.connectOriginalOAuth).not.toHaveBeenCalled();
  });

  it('lists account sign-ins without the per-row "already on this computer" panel, which is a lane of its own', async () => {
    const card = await mountCard();
    await act(async () => { card.querySelector<HTMLButtonElement>('[data-first-run-lane="account"]')!.click(); });
    await settle();
    expect([...card.querySelectorAll<HTMLElement>('[data-account-sign-in] [data-oauth-method]')].map((row) => row.dataset['oauthMethod']))
      .toEqual(['openai-codex', 'kimi-code', 'github-copilot']);
    expect(card.querySelector('[data-original-source]')).toBeNull();
    expect(firstRun.client.probeOriginalOAuth).not.toHaveBeenCalled();
    expect(firstRun.client.startOAuthLogin).not.toHaveBeenCalled();
  });
});

describe('the key lane counts a key as connected only once it answers', () => {
  const service = { id: 'example-ai', name: 'Example AI', models: [{ id: 'example-chat' }], rejected: false, needs_base_url: false };

  beforeEach(() => {
    firstRun.client.listOAuthMethods.mockResolvedValue([]);
    firstRun.client.listCatalogProviders.mockResolvedValue({ items: [service] });
    firstRun.client.listProviders.mockResolvedValue({ items: [] });
    firstRun.client.deleteProviderEntity.mockResolvedValue(undefined);
    firstRun.client.getConfig.mockResolvedValue({ default_model: 'example-ai/example-chat' });
    firstRun.client.listModels.mockResolvedValue({ items: [{ id: 'example-ai/example-chat' }] });
  });

  const passes = { provider_id: 'example-ai', model_id: 'example-ai/example-chat', ok: true, checked_at: 1, duration_ms: 1 };
  const fails = { provider_id: 'example-ai', model_id: 'example-ai/example-chat', ok: false, checked_at: 1, duration_ms: 1, http_status: 401, error: 'invalid api key' };

  /** Pick the service, type the key, press Connect. */
  async function connectWithKey(card: HTMLElement, key: string) {
    if (card.querySelector('[data-first-run-key-form]') === null) {
      await act(async () => { card.querySelector<HTMLButtonElement>('[data-first-run-lane="key"]')!.click(); });
      await settle();
      await act(async () => { card.querySelector<HTMLButtonElement>('#first-run-key-service-select')!.click(); });
      await act(async () => { document.querySelector<HTMLElement>(`[role="option"][data-option-value="${service.id}"]`)!.click(); });
    }
    const input = card.querySelector<HTMLInputElement>('[data-first-run-key] [data-secret-field] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, key);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { card.querySelector<HTMLButtonElement>('[data-first-run-key-connect]')!.click(); });
    await settle();
  }

  it('checks the saved key with a real request before the composer comes back', async () => {
    firstRun.client.testProviderConnection.mockResolvedValue(passes);
    const onConnected = vi.fn();
    const onHold = vi.fn();
    const card = await mountCard(onConnected, onHold);
    await connectWithKey(card, 'YOUR_API_KEY');
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(firstRun.client.importCatalogProvider).toHaveBeenCalledWith({ catalog_id: 'example-ai', api_key: 'YOUR_API_KEY' });
    expect(firstRun.client.testProviderConnection).toHaveBeenCalledWith('example-ai');
    expect(onConnected).toHaveBeenCalledWith('Example AI');
    expect(firstRun.client.deleteProviderEntity).not.toHaveBeenCalled();
    expect(firstRun.client.setDefaultModel).not.toHaveBeenCalled();
  });

  it('stays open on a key that fails, takes back only what it added, and repairs a default left pointing at nothing', async () => {
    firstRun.client.testProviderConnection.mockResolvedValue(fails);
    const onConnected = vi.fn();
    const card = await mountCard(onConnected);
    await connectWithKey(card, 'YOUR_API_KEY');
    expect(card.querySelector('[data-first-run-key-failed]')?.textContent)
      .toBe("This key didn't pass the check: invalid api key. Make sure it was copied in full, or try another key.");
    expect(firstRun.client.deleteProviderEntity).toHaveBeenCalledWith('example-ai');
    expect(onConnected).not.toHaveBeenCalled();
    expect(card.querySelector('[data-first-run-key-form]')).not.toBeNull();

    // The import that failed had picked a default the removal left behind.
    firstRun.client.getConfig.mockResolvedValue({ default_model: 'example-ai/example-old' });
    firstRun.client.testProviderConnection.mockResolvedValue(passes);
    await connectWithKey(card, 'YOUR_OTHER_API_KEY');
    expect(firstRun.client.setDefaultModel).toHaveBeenCalledWith('example-ai/example-chat');
    expect(onConnected).toHaveBeenCalledWith('Example AI');
  });

  it('never removes a connection that was there before the press, and says when it could not take its own back', async () => {
    firstRun.client.testProviderConnection.mockResolvedValue(fails);
    firstRun.client.listProviders.mockResolvedValue({ items: [{ id: 'example-ai' }] });
    const card = await mountCard();
    await connectWithKey(card, 'YOUR_API_KEY');
    expect(firstRun.client.deleteProviderEntity).not.toHaveBeenCalled();
    expect(card.querySelector('[data-first-run-key-left-behind]')).toBeNull();

    firstRun.client.listProviders.mockResolvedValue({ items: [] });
    firstRun.client.deleteProviderEntity.mockRejectedValue(new Error('config is read-only'));
    await connectWithKey(card, 'YOUR_API_KEY');
    expect(card.querySelector('[data-first-run-key-left-behind]')?.textContent).toContain('config is read-only');

    // Still this card's own on the next try, though it is now listed.
    firstRun.client.listProviders.mockResolvedValue({ items: [{ id: 'example-ai' }] });
    firstRun.client.deleteProviderEntity.mockResolvedValue(undefined);
    await connectWithKey(card, 'YOUR_API_KEY');
    expect(firstRun.client.deleteProviderEntity).toHaveBeenLastCalledWith('example-ai');
    expect(card.querySelector('[data-first-run-key-left-behind]')).toBeNull();
  });
});

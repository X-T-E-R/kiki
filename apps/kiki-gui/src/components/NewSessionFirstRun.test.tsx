// @vitest-environment jsdom

/**
 * First-run surface of /new: the native folder picker in the workspace
 * popover, the empty-catalog explanation, and the provider-readiness rule
 * behind the hero guidance card. Also covers the hero footer's
 * "view all sessions" affordance, which must reveal the session list.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuthSummary } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import {
  AUTO_WORKSPACE_ID,
  WorkspacePickerFields,
  needsProviderSetup,
  type NewSessionDraftState,
} from './NewSessionDraft';
import { NewSessionPage } from './NewSessionPage';

const listSessions = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: { listSessions } }),
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
    useRegisterSeat: () => {},
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
      needsProviderSetup: false,
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
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
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
        session_count: 0, pinned: false,
      },
      workspaces: [{
        id: 'wd_a', root: 'C:/proj', name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
        session_count: 0, pinned: false,
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

let currentPath = '';

function LocationProbe() {
  currentPath = useLocation().pathname;
  return null;
}

async function mountNewSessionPage(
  onToggleSidebar: () => void,
  items: readonly Record<string, unknown>[] = [
    { id: 'session-one', title: 'Earlier session', busy: false, updated_at: new Date().toISOString() },
  ],
): Promise<HTMLDivElement> {
  listSessions.mockReset().mockResolvedValue({ items });
  document.querySelector('#first-run-hero-footer')!.replaceChildren();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/new']}>
            <LocationProbe />
            <NewSessionPage onToggleSidebar={onToggleSidebar} />
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

describe('the /new continuation band', () => {
  it('shows automatic workspace creation without a workspace-required warning', async () => {
    const container = await mountNewSessionPage(vi.fn());
    expect(container.querySelector('[data-hero-workspace]')?.textContent).toContain('Automatically create a workspace');
    expect(container.textContent).not.toContain('Choose another workspace');
  });

  it('states what kiki is instead of asking an empty question', async () => {
    const container = await mountNewSessionPage(vi.fn());
    expect(container.querySelector('[data-hero-headline]')?.textContent).toBe('Your agents, your call.');
  });

  it('ranks a session that needs you above one that is merely running', async () => {
    await mountNewSessionPage(vi.fn(), [
      { id: 'running', title: 'Running work', busy: true, updated_at: new Date().toISOString() },
      { id: 'waiting', title: 'Waiting work', busy: true, pending_interaction: 'approval', updated_at: new Date().toISOString() },
    ]);
    const rows = [...document.querySelectorAll<HTMLElement>('#first-run-hero-footer [data-hero-recent]')];
    expect(rows.map((row) => row.dataset['life'])).toEqual(['waiting', 'working']);
    expect(rows[0]?.textContent).toContain('Waiting work');
    expect(rows[0]?.textContent).toContain('Needs you');
  });

  it('says every row state in shape and word so the order reads; idle draws neither', async () => {
    await mountNewSessionPage(vi.fn(), [
      { id: 'running', title: 'Running work', busy: true, updated_at: new Date().toISOString() },
      { id: 'waiting', title: 'Waiting work', busy: true, pending_interaction: 'approval', updated_at: new Date().toISOString() },
      { id: 'done', title: 'Done work', busy: false, last_turn_reason: 'completed', updated_at: new Date().toISOString() },
      { id: 'idle', title: 'Idle work', busy: false, updated_at: new Date(Date.now() - 86_400_000).toISOString() },
    ]);
    const rows = [...document.querySelectorAll<HTMLElement>('#first-run-hero-footer [data-hero-recent]')];
    expect(rows.map((row) => row.dataset['life'])).toEqual(['waiting', 'working', 'done', 'idle']);
    const [waiting, running, done, idle] = rows;
    const word = (row: HTMLElement | undefined) => row?.querySelector('[data-hero-recent-state]')?.textContent;
    expect(waiting?.querySelector('.kiki-life[data-life="waiting"]')).not.toBeNull();
    expect(word(waiting)).toBe('Needs you');
    // Working: a still dot plus its word; rows never breathe.
    expect(running?.querySelector('.kiki-life[data-life="working"]')?.hasAttribute('data-life-still')).toBe(true);
    expect(word(running)).toBe('Working');
    // Done: a hollow ring, not the working dot.
    expect(done?.querySelector('.kiki-life[data-life="done"]')?.className).toContain('border-success');
    expect(word(done)).toBe('Just finished');
    expect(idle?.querySelector('.kiki-life')).toBeNull();
    expect(word(idle)).toBeUndefined();
  });

  it('explains the empty continuation band instead of hiding it', async () => {
    await mountNewSessionPage(vi.fn(), []);
    const footer = document.querySelector('#first-run-hero-footer')!;
    expect(footer.querySelectorAll('[data-hero-recent]')).toHaveLength(0);
    expect(footer.textContent).toContain('ready to pick back up');
  });

  it('opens the sidebar search, and the drawer too where the sidebar is hidden', async () => {
    const searches = vi.fn();
    window.addEventListener('kiki:session-search', searches);
    const matchMedia = (matches: boolean) => vi.fn(() => ({ matches }) as unknown as MediaQueryList);
    try {
      // Desktop: the sidebar is docked, so only its search opens.
      vi.stubGlobal('matchMedia', matchMedia(true));
      const onToggleSidebar = vi.fn();
      await mountNewSessionPage(onToggleSidebar);
      const more = document.querySelector<HTMLButtonElement>('#first-run-hero-footer [data-recent-more]')!;
      expect(more.textContent).toBe('All sessions');
      await act(async () => { more.click(); });
      expect(searches).toHaveBeenCalledTimes(1);
      expect(onToggleSidebar).not.toHaveBeenCalled();
      expect(currentPath).toBe('/new');

      // Phone: the sidebar is a drawer; open it as well.
      vi.stubGlobal('matchMedia', matchMedia(false));
      const onToggleDrawer = vi.fn();
      await mountNewSessionPage(onToggleDrawer);
      const drawerMore = document.querySelector<HTMLButtonElement>('#first-run-hero-footer [data-recent-more]')!;
      await act(async () => { drawerMore.click(); });
      expect(onToggleDrawer).toHaveBeenCalledTimes(1);
      expect(searches).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('kiki:session-search', searches);
      vi.stubGlobal('matchMedia', undefined);
    }
  });
});

// @vitest-environment jsdom

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MemoryRouter, useLocation, useNavigate, type NavigateOptions, type To } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import {
  currentDiscoveryScope,
  navigateDiscovery,
  readDiscoveryState,
  writeDiscoveryState,
  type DiscoveryContext as CoreDiscoveryContext,
  type DiscoveryNavigationPort,
  type DiscoveryState,
} from '@kiki/session-core/discovery';
import { ConfirmDialog } from './ConfirmDialog';
import { DirtyGuardContext, useDirtyGuardState, type DirtyGuardValue } from './dirtyGuard';
import { DiscoveryProvider, DiscoveryTourTag } from './discovery';
import { SessionActionsMenu, SessionTitle } from './SessionView';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../state/connection', () => ({
  useConnection: () => ({
    scopeId: 'local',
    wsStatus: 'open',
    client: {},
  }),
  // The title resolver takes the nullable variant, which is null outside a live
  // connection — exactly as it is here, with no provider above the render.
  useOptionalConnection: () => null,
}));

const mounted: { container: HTMLDivElement; root: Root }[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => { entry.root.unmount(); });
    entry.container.remove();
  }
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(<I18nProvider>{node}</I18nProvider>);
  });
  return container;
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(input: HTMLElement, name: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

function actionsMenu(overrides: Partial<React.ComponentProps<typeof SessionActionsMenu>> = {}) {
  const props: React.ComponentProps<typeof SessionActionsMenu> = {
    terminalAvailable: true,
    terminalOpen: false,
    onToggleTerminal: vi.fn(),
    onBeginRename: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
  return { props, container: mount(<SessionActionsMenu {...props} />) };
}

describe('session header overflow menu', () => {
  it('carries rename, terminal and the four session actions', () => {
    const { container } = actionsMenu();
    click(container.querySelector('button[aria-haspopup="menu"]'));
    const labels = [...container.querySelectorAll('[role^="menuitem"]')].map((item) =>
      (item.textContent ?? '').trim(),
    );
    expect(labels).toEqual([
      'Rename…',
      'TerminalCtrl+`',
      'Fork session',
      'Export archive…',
      'Compact context',
      'Undo last turn…',
    ]);
  });

  it('opens prompt details from the menu and closes the menu first', () => {
    const onPromptDetails = vi.fn();
    const { container } = actionsMenu({ onPromptDetails });
    click(container.querySelector('button[aria-haspopup="menu"]'));
    const item = container.querySelector('[data-prompt-details-open]');
    expect(item?.textContent).toBe('Effective prompts');
    click(item);
    expect(onPromptDetails).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('offers a side question above fork when the session can ask one', () => {
    const onSideQuestion = vi.fn();
    const { container } = actionsMenu({ onSideQuestion });
    click(container.querySelector('button[aria-haspopup="menu"]'));
    const item = container.querySelector('[data-side-question]');
    expect(item?.textContent).toBe('Side question/btw');
    expect(item?.nextElementSibling?.textContent).toBe('Fork session');
    click(item);
    expect(onSideQuestion).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('drops the terminal item when the server has no terminal capability', () => {
    const { container } = actionsMenu({ terminalAvailable: false });
    click(container.querySelector('button[aria-haspopup="menu"]'));
    expect(container.querySelector('[data-terminal-toggle]')).toBeNull();
    expect(container.querySelectorAll('[role^="menuitem"]')).toHaveLength(5);
  });

  it('reflects the panel state on the terminal item and toggles it', () => {
    const { props, container } = actionsMenu({ terminalOpen: true });
    click(container.querySelector('button[aria-haspopup="menu"]'));
    const item = container.querySelector('[data-terminal-toggle]');
    expect(item?.getAttribute('aria-checked')).toBe('true');
    click(item);
    expect(props.onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-terminal-toggle]')).toBeNull();
  });

  it('hands rename back to the header and closes', () => {
    const { props, container } = actionsMenu();
    click(container.querySelector('button[aria-haspopup="menu"]'));
    click(container.querySelector('[data-session-rename]'));
    expect(props.onBeginRename).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-session-rename]')).toBeNull();
  });

  it('keeps the trigger textless — it is an icon button', () => {
    const { container } = actionsMenu();
    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    expect(trigger?.textContent).toBe('');
    expect(trigger?.getAttribute('aria-label')).toBe('Session actions');
  });
});

describe('session title', () => {
  function title(overrides: Partial<React.ComponentProps<typeof SessionTitle>> = {}) {
    const onEditingChange = vi.fn();
    const onRename = vi.fn(async () => {});
    const onOpenRail = vi.fn();
    const props: React.ComponentProps<typeof SessionTitle> = {
      title: 'Release prep',
      cwd: 'C:/fixture/workshop',
      editing: false,
      onEditingChange,
      onRename,
      onOpenRail,
      ...overrides,
    };
    return { props, container: mount(<SessionTitle {...props} />) };
  }

  it('shows the shortened cwd and opens the rail when it is clicked', () => {
    const { props, container } = title();
    const cwd = container.querySelector('[data-session-cwd]');
    expect(cwd?.textContent).toBe('…/fixture/workshop');
    click(cwd);
    expect(props.onOpenRail).toHaveBeenCalledTimes(1);
  });

  it('draws no worktree mark for an ordinary session', () => {
    const { container } = title();
    expect(container.querySelector('[data-worktree-mark]')).toBeNull();
  });

  it('marks a worktree session with its branch and names the source in the tooltip', () => {
    const { container } = title({
      cwd: 'C:/Users/me/.kiki/worktrees/1a2b3c4d/a1b2c3',
      worktree: { worktree_id: 'wt_1', branch: 'kiki/refactor-a1b2c3', source_root: 'C:/fixture/workshop', base_ref: 'HEAD' },
    });
    const mark = container.querySelector('[data-worktree-mark]');
    expect(mark?.textContent).toContain('kiki/refactor-a1b2c3');
    expect(mark?.getAttribute('title')).toContain('C:/fixture/workshop');
    expect(mark?.getAttribute('title')).toContain('HEAD');
    expect(container.querySelector('[data-session-cwd]')?.textContent).toBe('…/fixture/workshop');
  });

  it('enters edit mode when the title is clicked', () => {
    const { props, container } = title();
    click(container.querySelector('[data-session-title]'));
    expect(props.onEditingChange).toHaveBeenCalledWith(true);
  });

  it('commits a new title on Enter', () => {
    const { props, container } = title({ editing: true });
    const input = container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, 'Ship the batch');
    key(input, 'Enter');
    expect(props.onRename).toHaveBeenCalledWith('Ship the batch');
    expect(props.onEditingChange).toHaveBeenCalledWith(false);
  });

  it('reverts on Escape without renaming', () => {
    const { props, container } = title({ editing: true });
    const input = container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, 'Discarded');
    key(input, 'Escape');
    expect(props.onRename).not.toHaveBeenCalled();
    expect(props.onEditingChange).toHaveBeenCalledWith(false);
  });

  it('commits on blur, and only once', () => {
    const { props, container } = title({ editing: true });
    const input = container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, 'Ship the batch');
    // React maps onBlur off the bubbling focusout event.
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(props.onRename).toHaveBeenCalledTimes(1);
  });

  it('sends no patch for an unchanged or empty title', () => {
    const first = title({ editing: true });
    key(first.container.querySelector('[data-session-rename-input]')!, 'Enter');
    expect(first.props.onRename).not.toHaveBeenCalled();

    const second = title({ editing: true });
    const input = second.container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, '   ');
    key(input, 'Enter');
    expect(second.props.onRename).not.toHaveBeenCalled();
  });

  it('hides the cwd while renaming so the input owns the row', () => {
    const { container } = title({ editing: true });
    expect(container.querySelector('[data-session-cwd]')).toBeNull();
  });
});

describe('session header discovery tour guide and dirty guard', () => {
  it('renders discovery tour tag with station info and try action', async () => {
    const activeState = {
      version: 1 as const,
      contentVersion: 1,
      lifecycle: 'active' as const,
      route: 'overview' as const,
      station: 'agents' as const,
      collapsed: false,
      progress: {},
    };
    const scope = currentDiscoveryScope('local');
    writeDiscoveryState(scope, activeState);

    const container = document.createElement('div');
    document.body.append(container);
    const agentAnchor = document.createElement('div');
    agentAnchor.setAttribute('data-anchor', 'agent-panel');
    document.body.append(agentAnchor);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/s/s1']}>
          <I18nProvider>
            <DiscoveryProvider activeSessionId="s1" sessionReachable initialState={activeState}>
              <DiscoveryTourTag />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('[data-discovery-tour-tag="expanded"]')).not.toBeNull();
    expect(container.textContent).toContain('2/5');
    expect(container.querySelector('[data-discovery-action="agent-panel"]')).not.toBeNull();

    await act(async () => { root.unmount(); });
    agentAnchor.remove();
    container.remove();
  });

  it('supports collapse and leave controls from session header tour tag', async () => {
    const activeState = {
      version: 1 as const,
      contentVersion: 1,
      lifecycle: 'active' as const,
      route: 'overview' as const,
      station: 'agents' as const,
      collapsed: false,
      progress: {},
    };
    const scope = currentDiscoveryScope('local');
    writeDiscoveryState(scope, activeState);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/s/s1']}>
          <I18nProvider>
            <DiscoveryProvider activeSessionId="s1" sessionReachable initialState={activeState}>
              <DiscoveryTourTag />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    const collapseBtn = container.querySelector<HTMLButtonElement>('[data-discovery-collapse]')!;
    expect(collapseBtn).not.toBeNull();
    await act(async () => { collapseBtn.click(); });
    expect(container.querySelector('[data-discovery-tour-tag="collapsed"]')).not.toBeNull();

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('gui dirty guard parent chain cancels tour tag advance without advancing station or leaving dangling promise, and commits on confirm', async () => {
    const activeState: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'overview',
      station: 'agents',
      collapsed: false,
      progress: {},
    };
    const scope = currentDiscoveryScope('local');
    writeDiscoveryState(scope, activeState);

    let reportedDirtySetter: ((dirty: boolean) => void) | undefined;
    let currentLocation: { pathname: string; search: string } = { pathname: '/s/s1', search: '' };

    function Harness({ children }: { children: React.ReactNode }) {
      const location = useLocation();
      const rawNavigate = useNavigate();
      currentLocation = { pathname: location.pathname, search: location.search };
      const performNavigation = (target: To | number, options?: NavigateOptions) => {
        if (typeof target === 'number') void rawNavigate(target);
        else void rawNavigate(target, options);
      };
      const {
        value: dirtyGuardValue,
        pending,
        confirm,
        cancel,
      } = useDirtyGuardState(location, performNavigation);

      const [isDirty, setIsDirty] = useState(false);
      reportedDirtySetter = setIsDirty;

      useEffect(() => {
        dirtyGuardValue.reportDirty('editor-test-1', isDirty);
      }, [isDirty, dirtyGuardValue]);

      return (
        <DirtyGuardContext.Provider value={dirtyGuardValue}>
          <DiscoveryProvider activeSessionId="s1" sessionReachable initialState={activeState}>
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

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/s/s1']}>
          <I18nProvider>
            <Harness>
              <DiscoveryTourTag />
            </Harness>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    const nextBtn = container.querySelector<HTMLButtonElement>('[data-discovery-nav="next"]')!;
    expect(nextBtn).not.toBeNull();

    // 1. Mark dirty using real dirty reporter
    await act(async () => {
      reportedDirtySetter?.(true);
    });

    // 2. Click next station while dirty: triggers real dirty guard and opens ConfirmDialog
    await act(async () => {
      nextBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Confirm dialog is open in DOM
    const stayBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Stay');
    expect(stayBtn).toBeDefined();

    // 3. Click real Cancel button ("Stay")
    await act(async () => {
      stayBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Verify station did not advance, state was not committed, location did not change
    expect(currentLocation.pathname).toBe('/s/s1');
    const stateAfterCancel = readDiscoveryState(scope);
    expect(stateAfterCancel.station).toBe('agents');
    expect(stateAfterCancel.lifecycle).toBe('left');
    expect(stateAfterCancel.progress['agents']?.tried).not.toBe(true);

    // 4. Click next station again while dirty
    await act(async () => {
      nextBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const leaveBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Leave');
    expect(leaveBtn).toBeDefined();

    // 5. Click real Confirm button ("Leave")
    await act(async () => {
      leaveBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Verify station advanced, state committed, and location changed to next station's page (/memory)
    const stateAfterConfirm = readDiscoveryState(scope);
    expect(stateAfterConfirm.station).toBe('memory');
    expect(stateAfterConfirm.lifecycle).toBe('left');
    expect(currentLocation.pathname).toBe('/memory');

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('reactive capabilities producer detects real mounted anchors, async data updates, and missing controls without test props', async () => {
    const { useDiscovery } = await import('./discovery');

    let discoveryRef: ReturnType<typeof useDiscovery> | null = null;
    function Consumer() {
      discoveryRef = useDiscovery();
      return <div data-consumer />;
    }

    const stateStationAgents: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'overview',
      station: 'agents',
      collapsed: false,
      progress: {},
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // Delta 1: Missing control on real producer (no anchors prop passed!)
    await act(async () => {
      root.render(
        <MemoryRouter key="s1-missing" initialEntries={['/s/s1']}>
          <I18nProvider>
            <DiscoveryProvider activeSessionId="s1" sessionReachable initialState={stateStationAgents}>
              <Consumer />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    expect(discoveryRef).not.toBeNull();
    let actionResult = false;
    await act(async () => {
      actionResult = await discoveryRef!.performAction('agent-panel');
    });
    // Missing control must fail and NOT record tried
    expect(actionResult).toBe(false);
    expect(discoveryRef!.state.progress['agents']?.tried).not.toBe(true);

    // Delta 2: Mount anchor under SAME href (/s/s1) after initial render.
    // Producer must reactively detect the newly mounted real DOM anchor!
    const anchorEl = document.createElement('div');
    anchorEl.setAttribute('data-anchor', 'agent-panel');
    anchorEl.tabIndex = 0;
    await act(async () => {
      document.body.append(anchorEl);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Producer must reactively pick up agent-panel without anchors prop!
    expect(discoveryRef!.view.actions.some((a) => a.kind === 'anchor' && a.id === 'agent-panel')).toBe(true);
    await act(async () => {
      actionResult = await discoveryRef!.performAction('agent-panel');
    });
    expect(actionResult).toBe(true);
    expect(discoveryRef!.state.progress['agents']?.tried).toBe(true);
    anchorEl.remove();

    // Delta 3: Workspace-picker anchor mounted after initial render on /new.
    const stateStationWorkspace: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'overview',
      station: 'workspace',
      collapsed: false,
      progress: {},
    };
    await act(async () => {
      root.render(
        <MemoryRouter key="workspace-test" initialEntries={['/new']}>
          <I18nProvider>
            <DiscoveryProvider initialState={stateStationWorkspace}>
              <Consumer />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const workspaceBtn = document.createElement('button');
    workspaceBtn.setAttribute('data-anchor', 'workspace-picker');
    await act(async () => {
      document.body.append(workspaceBtn);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Reactive producer must discover workspace-picker anchor on /new
    expect(discoveryRef!.view.actions.some((a) => a.kind === 'anchor' && a.id === 'workspace-picker')).toBe(true);
    workspaceBtn.remove();

    // Delta 4: Async data loading (empty -> data present) on /cron without data prop!
    const stateStationCron: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'overview',
      station: 'cron',
      collapsed: false,
      progress: {},
    };

    // Initially no cron card in DOM: producer detects empty data -> provides example action
    await act(async () => {
      root.render(
        <MemoryRouter key="cron-empty" initialEntries={['/cron']}>
          <I18nProvider>
            <DiscoveryProvider initialState={stateStationCron}>
              <Consumer />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(discoveryRef!.view.actions.some((a) => a.kind === 'example' && a.id === 'cron')).toBe(true);
    expect(discoveryRef!.view.actions.some((a) => a.kind === 'anchor')).toBe(false);

    // Async data arrives: DOM is populated with card and detail anchor
    const cronCard = document.createElement('div');
    cronCard.setAttribute('data-cron-card', 'true');
    const cronAnchor = document.createElement('div');
    cronAnchor.setAttribute('data-anchor', 'cron-detail');

    await act(async () => {
      document.body.append(cronCard);
      document.body.append(cronAnchor);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Producer must reactively update: example is replaced by real anchor action!
    expect(discoveryRef!.view.actions.some((a) => a.kind === 'anchor' && a.id === 'cron-detail')).toBe(true);

    await act(async () => { root.unmount(); });
    cronCard.remove();
    cronAnchor.remove();
    container.remove();
  });

  it('verified session不可达不跳不存在session', async () => {
    const { useDiscovery } = await import('./discovery');
    const { currentDiscoveryScope, writeDiscoveryState } = await import('@kiki/session-core/discovery');
    const scope = currentDiscoveryScope('local');

    let discoveryRef: ReturnType<typeof useDiscovery> | null = null;
    function Consumer() {
      discoveryRef = useDiscovery();
      return <div data-consumer />;
    }

    const stateStationOverview: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'overview',
      station: 'workspace',
      collapsed: false,
      progress: {},
    };

    let routerLoc = '';
    function RouteTracker() {
      const loc = useLocation();
      routerLoc = `${loc.pathname}${loc.search}`;
      return null;
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // Case 1: activeSessionId="ghost-session" but sessionReachable={false} (unverified/missing/loading/archived)
    writeDiscoveryState(scope, stateStationOverview);
    await act(async () => {
      root.render(
        <MemoryRouter key="unverified-case" initialEntries={['/']}>
          <I18nProvider>
            <DiscoveryProvider
              activeSessionId="ghost-session"
              sessionReachable={false}
              initialState={stateStationOverview}
            >
              <RouteTracker />
              <Consumer />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    expect(discoveryRef).not.toBeNull();
    // Advance to next station ('agents' on page 'session')
    await act(async () => {
      await discoveryRef!.nextStation();
    });

    // Destination must NOT be /s/ghost-session; it must fall back to /new
    expect(routerLoc).toBe('/new');

    // Case 2: activeSessionId="live-session" and sessionReachable={true}
    writeDiscoveryState(scope, stateStationOverview);
    await act(async () => {
      root.render(
        <MemoryRouter key="verified-case" initialEntries={['/']}>
          <I18nProvider>
            <DiscoveryProvider
              activeSessionId="live-session"
              sessionReachable={true}
              initialState={stateStationOverview}
            >
              <RouteTracker />
              <Consumer />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    await act(async () => {
      await discoveryRef!.nextStation();
    });

    // Verified session must navigate to /s/live-session
    expect(routerLoc).toBe('/s/live-session');

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('Provider旧draftEmpty=true后直接通过生产writeDraft写入用户草稿（不强制Provider rerender），try动作不覆盖', async () => {
    const { useDiscovery } = await import('./discovery');
    const { readDraft, writeDraft, resetDraftMemoryForTests } = await import('@kiki/session-core/composer');
    resetDraftMemoryForTests();

    let discoveryRef: ReturnType<typeof useDiscovery> | null = null;
    function Consumer() {
      discoveryRef = useDiscovery();
      return <div data-consumer />;
    }

    const stateStationWorkspace: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'overview',
      station: 'workspace',
      collapsed: false,
      progress: {},
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // Initial render with empty draft
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/new']}>
          <I18nProvider>
            <DiscoveryProvider initialState={stateStationWorkspace}>
              <Consumer />
            </DiscoveryProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    expect(discoveryRef).not.toBeNull();
    // User writes draft directly via production store without forcing DiscoveryProvider to rerender
    writeDraft('new', 'User active draft text');

    // Perform the draft try action
    let actionResult = false;
    await act(async () => {
      actionResult = await discoveryRef!.performAction('search-draft');
    });

    // Action must be cancelled, user's draft preserved, tried not recorded
    expect(actionResult).toBe(false);
    expect(readDraft('new')).toBe('User active draft text');
    expect(discoveryRef!.state.progress['workspace']?.tried).not.toBe(true);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('真实DataRouter pending导航卸载后await settled/无写入', async () => {
    const { useDiscovery } = await import('./discovery');
    const { createMemoryRouter, RouterProvider } = await import('react-router-dom');
    const { readDiscoveryState, currentDiscoveryScope, writeDiscoveryState } = await import('@kiki/session-core/discovery');

    const scope = currentDiscoveryScope('local');
    const startState: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'sustain',
      station: 'memory',
      collapsed: false,
      progress: {},
    };
    writeDiscoveryState(scope, startState);

    let discoveryRef: ReturnType<typeof useDiscovery> | null = null;
    function Harness() {
      discoveryRef = useDiscovery();
      return <div data-harness />;
    }

    const guardedNavigate = vi.fn(() => new Promise<void>(() => {})); // pending promise
    const fakeDirtyGuard: DirtyGuardValue = {
      dirty: true,
      reportDirty: vi.fn(),
      navigate: guardedNavigate,
    };

    const router = createMemoryRouter([
      {
        path: '*',
        element: (
          <I18nProvider>
            <DirtyGuardContext.Provider value={fakeDirtyGuard}>
              <DiscoveryProvider initialState={startState}>
                <Harness />
              </DiscoveryProvider>
            </DirtyGuardContext.Provider>
          </I18nProvider>
        ),
      },
    ], { initialEntries: ['/memory'] });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(discoveryRef).not.toBeNull();

    // In 'sustain', next station after 'memory' is 'board' (/board)
    let settled = false;
    let result = true;
    const navPromise = discoveryRef!.nextStation().then((res) => {
      settled = true;
      result = res;
      return res;
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(settled).toBe(false);

    // Unmount while navigation is in-flight pending
    await act(async () => {
      root.unmount();
    });

    // Pending await must settle!
    await act(async () => {
      await navPromise;
    });

    expect(settled).toBe(true);
    expect(result).toBe(false);

    // No write to discovery state
    const stateAfter = readDiscoveryState(scope);
    expect(stateAfter.station).toBe('memory');

    container.remove();
  });

  it('真实DataRouter错误目标不记成功', async () => {
    const { useDiscovery } = await import('./discovery');
    const { createMemoryRouter, RouterProvider } = await import('react-router-dom');
    const { readDiscoveryState, currentDiscoveryScope, writeDiscoveryState } = await import('@kiki/session-core/discovery');

    const scope = currentDiscoveryScope('local');
    const startState: DiscoveryState = {
      version: 1,
      contentVersion: 1,
      lifecycle: 'active',
      route: 'overview',
      station: 'workspace',
      collapsed: false,
      progress: {},
    };
    writeDiscoveryState(scope, startState);

    let discoveryRef: ReturnType<typeof useDiscovery> | null = null;
    function Harness() {
      discoveryRef = useDiscovery();
      return <div data-harness />;
    }

    const router = createMemoryRouter([
      {
        path: '/new',
        element: (
          <I18nProvider>
            <DiscoveryProvider initialState={startState}>
              <Harness />
            </DiscoveryProvider>
          </I18nProvider>
        ),
      },
      {
        path: '/memory',
        loader: () => {
          throw new Error('Memory route crashed');
        },
        errorElement: <div data-error-boundary>Error</div>,
      },
    ], { initialEntries: ['/new'] });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(discoveryRef).not.toBeNull();

    // Route 'sustain' starts at station 'memory' (/memory)
    let result = true;
    await act(async () => {
      result = await discoveryRef!.startRoute('sustain');
    });

    // Destination hit loader error -> must not commit, returns false
    expect(result).toBe(false);

    // State must not be updated to 'sustain'
    const stateAfter = readDiscoveryState(scope);
    expect(stateAfter.route).not.toBe('sustain');

    await act(async () => { root.unmount(); });
    container.remove();
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { MemoryRouter } from 'react-router-dom';
import {
  TaskBoardPage,
  canOpenGlobalTaskBoardSession,
  resolveGlobalTaskBoardScope,
} from './GlobalTaskBoard';

const board = {
  read: vi.fn(async (_input: { action: string; workspaceId?: string }) => ({
    ok: true as const,
    value: { workspaceId: _input.workspaceId, cards: [], issues: [], storage: { root: '/store', storageId: 'store-a', kind: 'embedded' as const } },
  })),
  write: vi.fn(),
  overview: vi.fn(async () => ({
    ok: true as const,
    value: ['workspace-a', 'workspace-b'].map((workspaceId) => ({
      workspaceId,
      result: {
        ok: true as const,
        value: {
          workspaceId,
          cards: [],
          issues: [],
          storage: { root: '/store', storageId: 'store-a', kind: 'embedded' as const },
        },
      },
    })),
  })),
};

vi.mock('../state/connection', () => ({
  useOptionalConnection: () => undefined,
  useConnection: () => ({ client: { sessions: {} }, klient: { global: { board }, session: () => ({ view: {} }) } }),
  useControllerRegistry: () => ({
    add: () => undefined,
    delete: () => undefined,
    subscribe: () => () => undefined,
    snapshot: () => 0,
    [Symbol.iterator]: function* () {},
  }),
}));

describe('global task board scope', () => {
  const workspaces = [
    { id: 'workspace-a', name: 'Alpha' },
    { id: 'workspace-b', name: 'Beta' },
  ];
  const sessions = [
    { id: 'session-a', title: 'Alpha session', workspace_id: 'workspace-a' },
    { id: 'session-b', title: 'Beta session', workspace_id: 'workspace-b' },
    { id: 'session-unregistered', title: 'Unregistered session', workspace_id: 'workspace-c' },
  ];

  it('reads every registered workspace while using the active session workspace as the create default', () => {
    expect(resolveGlobalTaskBoardScope({
      activeSessionId: 'session-b',
      sessions,
      workspaceOptions: workspaces,
    })).toEqual({
      workspaceIds: ['workspace-a', 'workspace-b'],
      currentWorkspaceId: 'workspace-b',
      currentSessionId: 'session-b',
      workspaces: [
        { id: 'workspace-a', title: 'Alpha' },
        { id: 'workspace-b', title: 'Beta' },
      ],
      sessions: [
        { id: 'session-a', title: 'Alpha session' },
        { id: 'session-b', title: 'Beta session' },
      ],
    });
  });

  it('keeps the global board available without an active session', () => {
    expect(resolveGlobalTaskBoardScope({
      activeSessionId: undefined,
      sessions,
      workspaceOptions: workspaces,
    })).toMatchObject({
      workspaceIds: ['workspace-a', 'workspace-b'],
      currentWorkspaceId: undefined,
      currentSessionId: undefined,
    });
  });
});

describe('global task board session navigation', () => {
  const sessions = [
    { id: 'session-a', workspace_id: 'workspace-a' },
    { id: 'session-b', workspace_id: 'workspace-b' },
  ];

  it('only allows registered sessions from the card workspace', () => {
    expect(canOpenGlobalTaskBoardSession({
      targetSessionId: 'session-a',
      sourceWorkspaceId: 'workspace-a',
      sessions,
      workspaceIds: ['workspace-a', 'workspace-b'],
    })).toBe(true);
    expect(canOpenGlobalTaskBoardSession({
      targetSessionId: 'session-b',
      sourceWorkspaceId: 'workspace-a',
      sessions,
      workspaceIds: ['workspace-a', 'workspace-b'],
    })).toBe(false);
    expect(canOpenGlobalTaskBoardSession({
      targetSessionId: 'session-a',
      sourceWorkspaceId: 'workspace-a',
      sessions,
      workspaceIds: ['workspace-b'],
    })).toBe(false);
    expect(canOpenGlobalTaskBoardSession({
      targetSessionId: 'missing',
      sessions,
      workspaceIds: ['workspace-a', 'workspace-b'],
    })).toBe(false);
  });
});

describe('task board page rendering', () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  const sessions = [
    { id: 'session-a', title: 'Alpha session', workspace_id: 'workspace-a' },
  ] as unknown as readonly Session[];
  const workspaceOptions = [
    { id: 'workspace-a', name: 'Alpha' },
    { id: 'workspace-b', name: 'Beta' },
  ] as unknown as readonly Workspace[];

  async function mount(entry: string): Promise<void> {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[entry]}>
          <I18nProvider>
            <TaskBoardPage
              originSessionId="session-a"
              sessions={sessions}
              workspaceOptions={workspaceOptions}
              onNavigate={() => undefined}
              onToggleSidebar={() => undefined}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });
  }

  it('renders the board as a page scoped to the workspace carried in the URL', async () => {
    await mount('/board?workspace=workspace-a');
    const page = container.querySelector('[data-task-board-page]');
    expect(page).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(page!.querySelector('[data-task-board-container]')).not.toBeNull();
    expect(page!.querySelectorAll('[data-board-column]')).toHaveLength(6);
    // A workspace-scoped entry reads only that workspace; the cross-workspace
    // overview stays cold until the user asks for it.
    expect(board.overview).not.toHaveBeenCalled();
    expect(board.read).toHaveBeenCalledTimes(1);
    expect(board.read.mock.calls[0]![0]).toMatchObject({ action: 'list', workspaceId: 'workspace-a' });
    expect(container.querySelector('[data-task-board-scope]')!.getAttribute('data-task-board-scope')).toBe('workspace-a');
    expect(container.querySelector('[data-scope-option="workspace-a"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('defaults to all workspaces when the URL carries no scope', async () => {
    await mount('/board');
    expect(container.querySelector('[data-task-board-scope]')!.getAttribute('data-task-board-scope')).toBe('all');
    expect(container.querySelector('[data-scope-option="all"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(board.overview).toHaveBeenCalledTimes(1);
  });

  it('switches to the all-workspaces overview only from the explicit scope switcher', async () => {
    await mount('/board?workspace=workspace-a');
    expect(container.querySelector('[data-task-board-scope]')!.getAttribute('data-task-board-scope')).toBe('workspace-a');

    const all = container.querySelector<HTMLButtonElement>('[data-scope-option="all"]')!;
    await act(async () => { all.click(); });

    expect(board.overview).toHaveBeenCalledTimes(1);
    expect(board.read).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-task-board-scope]')!.getAttribute('data-task-board-scope')).toBe('all');
  });
});

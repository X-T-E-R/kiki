// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import {
  GlobalTaskBoard,
  canOpenGlobalTaskBoardSession,
  resolveGlobalTaskBoardScope,
} from './GlobalTaskBoard';

const board = {
  read: vi.fn(async () => ({
    ok: true as const,
    value: { cards: [], issues: [], storage: { root: '/store', storageId: 'store-a', kind: 'embedded' as const } },
  })),
  write: vi.fn(),
};

vi.mock('../state/connection', () => ({
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

describe('global task board dialog rendering', () => {
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
  const workspaceOptions = [{ id: 'workspace-a', name: 'Alpha' }] as unknown as readonly Workspace[];

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider>
          <GlobalTaskBoard
            activeSessionId="session-a"
            sessions={sessions}
            workspaceOptions={workspaceOptions}
            onNavigate={() => undefined}
          />
        </I18nProvider>,
      );
    });
  }

  it('opens the board dialog from the launcher without throwing', async () => {
    await mount();
    const launcher = container.querySelector<HTMLButtonElement>('[data-session-task-board]');
    expect(launcher).not.toBeNull();

    await act(async () => { launcher!.click(); });

    const panel = document.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('[data-task-board-container]')).not.toBeNull();
    expect(panel!.querySelectorAll('[data-board-column]')).toHaveLength(6);
  });
});

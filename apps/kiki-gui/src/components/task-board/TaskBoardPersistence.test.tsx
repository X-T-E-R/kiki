// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard, BoardClient, BoardReadInput, BoardResult, BoardSummary } from '@kiki/klient/contract/board/types';
import { createViewState, type AgentForest, type AgentTreeNode, type SessionViewState } from '@kiki/session-core/session';
import { I18nProvider } from '../../i18n';
import { BoardAssociatedTodos, BoardAssociatedTodosProvider, createBoardAssociatedTodoManager, type BoardTodoController } from './BoardAssociatedTodos';
import { TaskBoardContainer } from './TaskBoardContainer';
import { boardCardKey, TaskBoardController } from './TaskBoardController';

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { sessions: {} }, klient: { session: () => ({ view: {} }) } }),
  useControllerRegistry: () => [],
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { localStorage.setItem('kiki.locale', 'en'); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const storage = { root: '/example-store', storageId: 'store-a', kind: 'embedded' } as const;
const card: BoardCard = {
  id: 'task-example', storage, workspaceId: 'workspace-a', title: 'An idea', description: 'Full details', priority: 'P2',
  status: 'active', revision: 3, createdAt: '2026-01-01', updatedAt: '2026-01-02', completedAt: null,
  archived: false, category: 'Feature', sessionIds: ['session-a'], executionIds: ['run-a'], prd: '',
};
const { description: _description, prd: _prd, ...summary } = card;
function change(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function changeSelect(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
function button(text: string): HTMLButtonElement {
  const value = [...document.body.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
}
function refreshButton(): HTMLButtonElement {
  const value = document.body.querySelector<HTMLButtonElement>('[data-task-board-refresh]');
  if (!value) throw new Error('Missing task board refresh button.');
  return value;
}
type ScopedListRead = Extract<BoardReadInput, { action: 'list' }> & { readonly workspaceId: string };
function isScopedListRead(input: BoardReadInput): input is ScopedListRead {
  return input.action === 'list' && input.workspaceId !== undefined;
}
function renderWithI18n(node: ReactNode): void {
  root.render(<I18nProvider>{node}</I18nProvider>);
}

interface FakeBoardController extends BoardTodoController {
  readonly emitMain: (next: SessionViewState) => void;
  readonly emitForest: (next: AgentForest) => void;
  readonly emitAgent: (agentId: string, next: SessionViewState) => void;
  readonly activeAgentSubscriptions: () => number;
  readonly openCount: () => number;
  readonly closeCount: () => number;
}

function makeFakeBoardController(sessionId: string): FakeBoardController {
  const childNode: AgentTreeNode = {
    agentId: 'child', parentAgentId: 'main', name: 'child', label: 'Child agent', status: 'completed',
    busy: false, toolCallCount: 0, childIds: [],
  };
  let main: SessionViewState = {
    ...createViewState(sessionId),
    loaded: true,
    todos: [{ title: 'Main todo', status: 'pending' }],
  };
  const agents: Record<string, SessionViewState> = {
    child: { ...createViewState(sessionId), loaded: true, todos: [{ title: 'Child todo', status: 'in_progress' }] },
  };
  let forest: AgentForest = { roots: [childNode], byId: { child: childNode } };
  const mainListeners = new Set<() => void>();
  const agentListeners = new Map<string, Set<() => void>>();
  let opened = 0;
  let closed = 0;
  const notify = (listeners: Set<() => void>) => { for (const listener of listeners) listener(); };
  return {
    sessionId,
    getForest: () => forest,
    getState: () => main,
    getAgentState: (agentId) => agents[agentId] ?? createViewState(sessionId),
    subscribe: (listener) => {
      mainListeners.add(listener);
      return () => mainListeners.delete(listener);
    },
    subscribeAgent: (agentId, listener) => {
      const listeners = agentListeners.get(agentId) ?? new Set<() => void>();
      listeners.add(listener);
      agentListeners.set(agentId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) agentListeners.delete(agentId);
      };
    },
    open: async () => { opened += 1; },
    close: () => { closed += 1; },
    emitMain: (next) => { main = next; notify(mainListeners); },
    emitForest: (next) => { forest = next; notify(mainListeners); },
    emitAgent: (agentId, next) => {
      agents[agentId] = next;
      notify(agentListeners.get(agentId) ?? new Set());
    },
    activeAgentSubscriptions: () => [...agentListeners.values()].reduce((count, listeners) => count + listeners.size, 0),
    openCount: () => opened,
    closeCount: () => closed,
  };
}

describe('board container and controlled forms (mock transport, no persistence claim)', () => {
  it('retains a failed create draft and target, deduplicates pending submit, then refreshes and edits the same card', async () => {
    let listed: readonly BoardSummary[] = [];
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action === 'preview') return { ok: true, value: { mode: 'auto', workspaceId: 'workspace-a', ...storage, tasksDirectory: '/example-store/tasks', existing: true, selectionOnly: true } };
      if (input.action === 'show') return { ok: true, value: card };
      return { ok: true, value: { workspaceId: 'workspace-a', storage, cards: listed, issues: [] } };
    });
    let rejectWrite!: (reason: Error) => void;
    const write = vi.fn<BoardClient['write']>().mockReturnValueOnce(new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const client: BoardClient = { read, write };
    await act(async () => renderWithI18n(<TaskBoardContainer client={client} workspaceIds={['workspace-a']} currentWorkspaceId="workspace-a" workspaces={[{ id: 'workspace-a', title: 'Example' }]} sessions={[{ id: 'session-a', title: 'First' }, { id: 'session-b', title: 'Second' }]} />));
    expect(read.mock.calls.filter(([input]) => input.action === 'show')).toHaveLength(0);
    await act(async () => button('+ New Requirement').click());
    const form = document.body.querySelector('[data-new-task-modal] form') as HTMLFormElement;
    const title = form.querySelector('input[type=text]') as HTMLInputElement;
    await act(async () => change(title, 'An idea'));
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(button('Create Task Card').disabled).toBe(true);
    await act(async () => rejectWrite(new Error('Storage temporarily unavailable')));
    expect(document.body.querySelector('[data-new-task-modal]')).not.toBeNull();
    expect(title.value).toBe('An idea');
    expect(document.querySelector('[data-new-task-modal]')?.textContent).toContain('Storage temporarily unavailable');
    const first = write.mock.calls[0]![0];
    write.mockResolvedValueOnce({ ok: true, value: card });
    await act(async () => button('Create Task Card').click());
    const second = write.mock.calls[1]![0];
    expect(second).toEqual(first);
    expect(document.body.querySelector('[data-new-task-modal]')).toBeNull();
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
    listed = [summary];
    await act(async () => refreshButton().click());
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
    expect(read.mock.calls.filter(([input]) => input.action === 'show')).toHaveLength(0);
    await act(async () => (document.body.querySelector('[data-board-task-card]') as HTMLElement).click());
    expect(read.mock.calls.filter(([input]) => input.action === 'show')).toHaveLength(1);
    await act(async () => button('Edit Task').click());
    const editTitle = document.body.querySelector('[data-task-detail-modal] input[type=text]') as HTMLInputElement;
    await act(async () => change(editTitle, 'Retained edit'));
    write.mockResolvedValueOnce({ ok: false, error: { code: 'TASK_REVISION_CONFLICT', message: 'Reload before reapplying.' } });
    await act(async () => button('Save Changes').click());
    expect(editTitle.value).toBe('Retained edit');
    expect(document.body.querySelector('[data-task-detail-modal] input[type=text]')).not.toBeNull();
    expect(container.textContent).toContain('TASK_REVISION_CONFLICT');
    expect(write.mock.calls[2]![0]).toMatchObject({ action: 'update', id: card.id, storage, expectedRevision: 3, patch: { title: 'Retained edit', sessionIds: ['session-a'] } });
  });

  it('loads the active session workspace by default inside a session view', async () => {
    const read = vi.fn<BoardClient['read']>().mockResolvedValue({ ok: true, value: { workspaceId: 'workspace-a', storage, cards: [summary], issues: [] } });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    await act(async () => renderWithI18n(<TaskBoardContainer client={{ read, write }} workspaceIds={['workspace-a']} currentWorkspaceId="workspace-a" currentSessionId="session-a" workspaces={[{ id: 'workspace-a', title: 'Example' }]} sessions={[{ id: 'session-a', title: 'First' }]} />));
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
    expect(read.mock.calls.find(([input]) => input.action === 'list')?.[0]).toMatchObject({ action: 'list', workspaceId: 'workspace-a', sessionId: undefined });
  });

  it('defaults to all registered workspaces when no session is active', async () => {
    const second = { ...summary, id: 'task-second', sessionIds: ['session-b'] };
    const third = {
      ...summary,
      id: 'task-third',
      workspaceId: 'workspace-b',
      storage: { ...storage, root: '/example-b', storageId: 'store-b' },
      sessionIds: [],
    };
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      const workspaceId = input.workspaceId;
      const isOtherWorkspace = workspaceId === 'workspace-b';
      return {
        ok: true,
        value: {
          workspaceId,
          storage: isOtherWorkspace ? third.storage : storage,
          cards: isOtherWorkspace ? [third] : [summary, second],
          issues: [],
        },
      };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a', 'workspace-b']}
        workspaces={[{ id: 'workspace-a', title: 'Alpha' }, { id: 'workspace-b', title: 'Beta' }]}
        sessions={[{ id: 'session-a', title: 'First' }, { id: 'session-b', title: 'Second' }]}
      />,
    ));
    const workspaceFilter = document.body.querySelector('select') as HTMLSelectElement;
    expect(workspaceFilter.value).toBe('all');
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(3);
    const sessionFilter = [...document.body.querySelectorAll('select')].find((entry) => entry.textContent?.includes('All associated sessions')) as HTMLSelectElement;
    expect(sessionFilter.value).toBe('all');
    sessionFilter.value = 'session-a';
    await act(async () => sessionFilter.dispatchEvent(new Event('change', { bubbles: true })));
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
  });

  it('keys same native IDs by workspace and storage and does not let an old refresh erase a successful mutation', async () => {
    let resolveList!: (result: BoardResult<{ workspaceId: string; cards: readonly BoardSummary[]; issues: [] }>) => void;
    const read = vi.fn<BoardClient['read']>().mockResolvedValueOnce({ ok: true, value: { workspaceId: 'workspace-a', storage, cards: [summary], issues: [] } });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: { ...card, title: 'Saved', revision: 4 } });
    const controller = new TaskBoardController({ read, write });
    await controller.refresh(['workspace-a']);
    read.mockReturnValueOnce(new Promise((resolve) => { resolveList = resolve; }));
    const refreshing = controller.refresh(['workspace-a']);
    const first = controller.update(boardCardKey(card), 3, { title: 'Saved' });
    const duplicate = controller.update(boardCardKey(card), 3, { title: 'Saved' });
    expect(first).toBe(duplicate);
    await first;
    resolveList({ ok: true, value: { workspaceId: 'workspace-a', cards: [summary], issues: [] } });
    await refreshing;
    expect(controller.getSnapshot().cards[0]).toMatchObject({ title: 'Saved', revision: 4 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(boardCardKey(card)).not.toBe(boardCardKey({ ...card, workspaceId: 'workspace-b' }));
    expect(boardCardKey(card)).not.toBe(boardCardKey({ ...card, storage: { ...storage, storageId: 'store-b' } }));
  });

  it('persists the formal in-progress status and exposes its column in the detail editor', async () => {
    const inProgressCard = { ...card, status: 'in_progress' as const };
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action === 'show') return { ok: true, value: inProgressCard };
      if (input.action === 'list') return { ok: true, value: { workspaceId: 'workspace-a', storage, cards: [inProgressCard], issues: [] } };
      throw new Error('This fixture only handles list and show reads.');
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: inProgressCard });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a']}
        currentWorkspaceId="workspace-a"
        workspaces={[{ id: 'workspace-a', title: 'Example' }]}
      />,
    ));
    expect(document.body.querySelector('[data-board-column="in_progress"]')).not.toBeNull();
    const boardCard = document.body.querySelector('[data-board-task-card]');
    expect(boardCard).not.toBeNull();
    await act(async () => (boardCard as HTMLElement).click());
    await act(async () => button('Edit Task').click());
    const statusSelect = [...document.body.querySelectorAll<HTMLSelectElement>('[data-task-detail-modal] select')]
      .find((select) => [...select.options].some((option) => option.value === 'in_progress'));
    expect(statusSelect).not.toBeUndefined();
    await act(async () => {
      changeSelect(statusSelect!, 'active');
      changeSelect(statusSelect!, 'in_progress');
    });
    await act(async () => button('Save Changes').click());
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update',
      patch: expect.objectContaining({ status: 'in_progress' }),
    }));
  });

  it('persists a terminal card reopened from the detail editor', async () => {
    const doneCard = { ...card, status: 'done' as const, completedAt: '2026-01-02' as const };
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action === 'show') return { ok: true, value: doneCard };
      if (input.action === 'list') return { ok: true, value: { workspaceId: 'workspace-a', storage, cards: [doneCard], issues: [] } };
      throw new Error('This fixture only handles list and show reads.');
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: { ...doneCard, status: 'active' as const, completedAt: null, revision: 4 } });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a']}
        currentWorkspaceId="workspace-a"
        workspaces={[{ id: 'workspace-a', title: 'Example' }]}
      />,
    ));
    const boardCard = document.body.querySelector('[data-board-task-card]');
    expect(boardCard).not.toBeNull();
    await act(async () => (boardCard as HTMLElement).click());
    await act(async () => button('Edit Task').click());
    const statusSelect = [...document.body.querySelectorAll<HTMLSelectElement>('[data-task-detail-modal] select')]
      .find((select) => [...select.options].some((option) => option.value === 'active'));
    expect(statusSelect).not.toBeUndefined();
    expect(statusSelect!.disabled).toBe(false);
    await act(async () => changeSelect(statusSelect!, 'active'));
    await act(async () => button('Save Changes').click());
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update',
      patch: expect.objectContaining({ status: 'active' }),
    }));
  });

  it('loads associated session Todos read-only by agent, shares one source, and releases local ownership', async () => {
    const source = makeFakeBoardController('session-a');
    const manager = createBoardAssociatedTodoManager({
      createController: () => source,
    });
    await act(async () => root.render(
      <I18nProvider>
        <BoardAssociatedTodosProvider manager={manager}>
          <BoardAssociatedTodos sessionIds={['session-a']} sessionLabels={{ 'session-a': 'First' }} />
          <BoardAssociatedTodos sessionIds={['session-a']} sessionLabels={{ 'session-a': 'First' }} />
        </BoardAssociatedTodosProvider>
      </I18nProvider>,
    ));
    const toggles = [...document.body.querySelectorAll<HTMLButtonElement>('[data-board-associated-todos] > button')];
    expect(toggles).toHaveLength(2);
    await act(async () => { toggles[0]!.click(); toggles[1]!.click(); });
    expect(container.textContent).toContain('Main todo');
    expect(container.textContent).toContain('Child todo');
    expect([...document.body.querySelectorAll<HTMLInputElement>('[data-board-associated-todos-content] input[type="checkbox"]')].every((input) => input.disabled)).toBe(true);
    expect(source.openCount()).toBe(1);
    expect(source.closeCount()).toBe(0);
    expect(source.activeAgentSubscriptions()).toBe(1);
    const workerNode: AgentTreeNode = {
      agentId: 'worker', parentAgentId: 'main', name: 'worker', label: 'Worker agent', status: 'running',
      busy: true, toolCallCount: 0, childIds: [],
    };
    const childNode: AgentTreeNode = {
      agentId: 'child', parentAgentId: 'main', name: 'child', label: 'Child agent', status: 'completed',
      busy: false, toolCallCount: 0, childIds: [],
    };
    await act(async () => source.emitForest({ roots: [childNode, workerNode], byId: { child: childNode, worker: workerNode } }));
    expect(source.activeAgentSubscriptions()).toBe(2);
    await act(async () => source.emitAgent('worker', { ...createViewState('session-a'), loaded: true, todos: [{ title: 'Worker todo', status: 'pending' }] }));
    expect(container.textContent).toContain('Worker todo');
    await act(async () => source.emitAgent('child', { ...source.getAgentState('child'), todos: [{ title: 'Child updated', status: 'done' }] }));
    expect(container.textContent).toContain('Child updated');
    expect(container.textContent).not.toContain('Child todo');
    await act(async () => root.unmount());
    expect(source.closeCount()).toBe(1);
    expect(source.activeAgentSubscriptions()).toBe(0);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  it('borrows an already mounted session controller without closing it', async () => {
    const source = makeFakeBoardController('session-a');
    const manager = createBoardAssociatedTodoManager({
      createController: () => { throw new Error('should borrow mounted source'); },
      registry: [source],
    });
    await act(async () => root.render(
      <I18nProvider>
        <BoardAssociatedTodosProvider manager={manager}>
          <BoardAssociatedTodos sessionIds={['session-a']} />
        </BoardAssociatedTodosProvider>
      </I18nProvider>,
    ));
    await act(async () => (document.body.querySelector('[data-board-associated-todos] > button') as HTMLButtonElement).click());
    expect(source.openCount()).toBe(0);
    expect(source.closeCount()).toBe(0);
    await act(async () => root.unmount());
    expect(source.closeCount()).toBe(0);
  });

  it('loads only the active workspace by default and rescopes through the header switcher', async () => {
    const secondCurrentWorkspaceCard = {
      ...summary,
      id: 'task-current-second',
      title: 'Alpha second task',
      sessionIds: ['session-b'],
    };
    const otherWorkspaceCard = {
      ...summary,
      id: 'task-other',
      title: 'Beta task',
      workspaceId: 'workspace-b',
      storage: { ...storage, root: '/example-b', storageId: 'store-b' },
      sessionIds: [],
    };
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      const workspaceId = input.workspaceId;
      const isOtherWorkspace = workspaceId === 'workspace-b';
      return {
        ok: true,
        value: {
          workspaceId,
          storage: isOtherWorkspace ? otherWorkspaceCard.storage : storage,
          cards: isOtherWorkspace
            ? [otherWorkspaceCard]
            : [summary, secondCurrentWorkspaceCard],
          issues: [],
        },
      };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a', 'workspace-b']}
        currentWorkspaceId="workspace-a"
        currentSessionId="session-a"
        workspaces={[{ id: 'workspace-a', title: 'Alpha' }, { id: 'workspace-b', title: 'Beta' }]}
        sessions={[{ id: 'session-a', title: 'First' }, { id: 'session-b', title: 'Second' }]}
      />,
    ));
    const scopeSelect = document.body.querySelector('[data-task-board-scope]') as HTMLSelectElement;
    expect(scopeSelect.value).toBe('workspace-a');
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(2);
    const scopedListWorkspaceIds = () => read.mock.calls.map(([input]) => input).filter(isScopedListRead).map(({ workspaceId }) => workspaceId);
    expect(scopedListWorkspaceIds()).toEqual(['workspace-a']);

    // Switching the scope reloads that workspace instead of filtering locally.
    scopeSelect.value = 'workspace-b';
    await act(async () => scopeSelect.dispatchEvent(new Event('change', { bubbles: true })));
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
    expect(container.textContent).toContain('Beta task');
    expect(scopedListWorkspaceIds()).toEqual(['workspace-a', 'workspace-b']);

    // The 'all' scope fans out to every registered workspace.
    scopeSelect.value = 'all';
    await act(async () => scopeSelect.dispatchEvent(new Event('change', { bubbles: true })));
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(3);
    expect(scopedListWorkspaceIds()).toEqual(['workspace-a', 'workspace-b', 'workspace-a', 'workspace-b']);
  });

  it('keeps healthy workspace cards and degrades gracefully when one workspace store is unavailable', async () => {
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      if (input.workspaceId === 'workspace-b') {
        return { ok: false, error: { code: 'BOARD_UNAVAILABLE', message: 'Workspace storage requires migration.' } };
      }
      return { ok: true, value: { workspaceId: input.workspaceId, storage, cards: [summary], issues: [] } };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a', 'workspace-b']}
        workspaces={[{ id: 'workspace-a', title: 'Alpha' }, { id: 'workspace-b', title: 'Beta' }]}
      />,
    ));
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
    const banner = document.body.querySelector('[data-task-board-issues]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('1 workspace could not load');
    expect(banner?.textContent).not.toContain('workspaces could not load');
    expect(banner?.textContent).toContain('Beta');
    expect(document.body.querySelector('[data-task-board-unavailable]')).toBeNull();
    expect(container.textContent).not.toContain('BOARD_UNAVAILABLE:');
  });

  it('counts workspace failures apart from per-card issues in the degradation banner', async () => {
    const cardIssues = [
      { code: 'CARD_PARSE_FAILED', message: 'Card one could not be parsed.' },
      { code: 'CARD_PARSE_FAILED', message: 'Card two could not be parsed.' },
      { code: 'CARD_PARSE_FAILED', message: 'Card three could not be parsed.' },
    ];
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      if (input.workspaceId === 'workspace-b') {
        return { ok: false, error: { code: 'BOARD_UNAVAILABLE', message: 'Workspace storage requires migration.' } };
      }
      return { ok: true, value: { workspaceId: input.workspaceId, storage, cards: [summary], issues: cardIssues } };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a', 'workspace-b']}
        workspaces={[{ id: 'workspace-a', title: 'Alpha' }, { id: 'workspace-b', title: 'Beta' }]}
      />,
    ));
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
    const banner = document.body.querySelector('[data-task-board-issues]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('1 workspace could not load');
    expect(banner?.textContent).toContain('3 cards could not load');
    expect(banner?.textContent).not.toContain('3 workspaces');
    expect(banner?.textContent).not.toContain('4 workspace');
    expect(banner?.textContent).toContain('Beta');
  });

  it('shows only the card segment when a healthy workspace reports per-card issues', async () => {
    const cardIssues = [
      { code: 'CARD_PARSE_FAILED', message: 'Card one could not be parsed.' },
      { code: 'CARD_PARSE_FAILED', message: 'Card two could not be parsed.' },
      { code: 'CARD_PARSE_FAILED', message: 'Card three could not be parsed.' },
    ];
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      return { ok: true, value: { workspaceId: input.workspaceId, storage, cards: [summary], issues: cardIssues } };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a']}
        workspaces={[{ id: 'workspace-a', title: 'Alpha' }]}
      />,
    ));
    const banner = document.body.querySelector('[data-task-board-issues]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('3 cards could not load');
    expect(banner?.textContent).not.toContain('workspace could not load');
    expect(document.body.querySelector('[data-task-board-unavailable]')).toBeNull();
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
  });

  it('shows an unavailable fallback with retry and workspace-settings actions when every workspace fails', async () => {
    const read = vi.fn<BoardClient['read']>().mockResolvedValue({
      ok: false,
      error: { code: 'BOARD_UNAVAILABLE', message: 'Workspace storage requires migration.' },
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    const openSettings = vi.fn();
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a', 'workspace-b']}
        workspaces={[{ id: 'workspace-a', title: 'Alpha' }, { id: 'workspace-b', title: 'Beta' }]}
        onOpenSettings={openSettings}
      />,
    ));
    const fallback = document.body.querySelector('[data-task-board-unavailable]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain('Alpha');
    expect(fallback?.textContent).toContain('Beta');
    expect(document.body.querySelector('[data-task-board-issues]')).toBeNull();
    expect(document.body.querySelector('[data-board-column]')).toBeNull();
    expect(container.textContent).not.toContain('BOARD_UNAVAILABLE:');
    const retry = fallback?.querySelector<HTMLButtonElement>('[data-task-board-unavailable-retry]');
    expect(retry).not.toBeNull();
    const settingsAction = [...fallback!.querySelectorAll('button')].find((entry) => entry !== retry);
    expect(settingsAction).not.toBeUndefined();
    await act(async () => settingsAction!.click());
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('recovers from the unavailable fallback when a retry succeeds', async () => {
    const read = vi.fn<BoardClient['read']>().mockResolvedValue({
      ok: false,
      error: { code: 'BOARD_REQUEST_FAILED', message: 'Connection reset.' },
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    await act(async () => renderWithI18n(
      <TaskBoardContainer
        client={{ read, write }}
        workspaceIds={['workspace-a']}
        workspaces={[{ id: 'workspace-a', title: 'Alpha' }]}
      />,
    ));
    expect(document.body.querySelector('[data-task-board-unavailable]')).not.toBeNull();
    read.mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      return { ok: true, value: { workspaceId: input.workspaceId, storage, cards: [summary], issues: [] } };
    });
    await act(async () => {
      (document.body.querySelector('[data-task-board-unavailable-retry]') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[data-task-board-unavailable]')).toBeNull();
    expect(document.body.querySelectorAll('[data-board-task-card]')).toHaveLength(1);
  });

  it('marks refreshFailed only when every workspace read fails and keeps per-workspace issues out of error', async () => {
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action === 'list' && input.workspaceId === 'workspace-b') {
        return { ok: false, error: { code: 'BOARD_UNAVAILABLE', message: 'Workspace storage requires migration.' } };
      }
      return {
        ok: true,
        value: {
          workspaceId: 'workspace-a',
          storage,
          cards: [summary],
          issues: [{ code: 'CARD_PARSE_FAILED', message: 'Card could not be parsed.' }],
        },
      };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    const controller = new TaskBoardController({ read, write });
    await controller.refresh(['workspace-a', 'workspace-b']);
    let snapshot = controller.getSnapshot();
    expect(snapshot.refreshFailed).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.issues).toEqual([
      { workspaceId: 'workspace-b', code: 'BOARD_UNAVAILABLE', message: 'BOARD_UNAVAILABLE: Workspace storage requires migration.' },
    ]);
    expect(snapshot.cardIssues).toEqual([
      { workspaceId: 'workspace-a', code: 'CARD_PARSE_FAILED', message: 'Card could not be parsed.' },
    ]);
    read.mockResolvedValue({
      ok: false,
      error: { code: 'BOARD_UNAVAILABLE', message: 'Workspace storage requires migration.' },
    });
    await controller.refresh(['workspace-a', 'workspace-b']);
    snapshot = controller.getSnapshot();
    expect(snapshot.refreshFailed).toBe(true);
    expect(snapshot.error).toBeNull();
    expect(snapshot.cards).toHaveLength(0);
    expect(snapshot.issues).toHaveLength(2);
    expect(snapshot.cardIssues).toHaveLength(0);
  });

  it('reads a single workspace directly even when the overview endpoint exists', async () => {
    // The overview endpoint reads every registered workspace server-side, so a
    // single-workspace refresh must stay on that workspace's own list read.
    const overview = vi.fn(async () => {
      throw new Error('The overview must not run for a single-workspace refresh.');
    });
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      return { ok: true, value: { workspaceId: input.workspaceId, storage, cards: [summary], issues: [] } };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    const controller = new TaskBoardController({ read, write, overview });

    await controller.refresh(['workspace-a']);

    expect(overview).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toMatchObject({ action: 'list', workspaceId: 'workspace-a' });
    expect(controller.getSnapshot().cards).toHaveLength(1);
    expect(controller.getSnapshot().refreshFailed).toBe(false);
  });

  it('uses one overview call and preserves healthy cards when another workspace fails', async () => {
    const overview = vi.fn(async () => ({
      ok: true as const,
      value: [
        {
          workspaceId: 'workspace-a',
          result: {
            ok: true as const,
            value: {
              workspaceId: 'workspace-a',
              storage,
              cards: [summary],
              issues: [{ code: 'CARD_PARSE_FAILED', message: 'One card could not be parsed.' }],
            },
          },
        },
        {
          workspaceId: 'workspace-b',
          result: {
            ok: false as const,
            error: { code: 'BOARD_UNAVAILABLE', message: 'Workspace storage requires migration.' },
          },
        },
      ],
    }));
    const read = vi.fn<BoardClient['read']>();
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    const controller = new TaskBoardController({ read, write, overview });

    await controller.refresh(['workspace-a', 'workspace-b']);

    expect(overview).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      cards: [summary],
      loading: false,
      refreshFailed: false,
      issues: [{ workspaceId: 'workspace-b', code: 'BOARD_UNAVAILABLE' }],
      cardIssues: [{ workspaceId: 'workspace-a', code: 'CARD_PARSE_FAILED' }],
    });
  });

  it.each([
    'unknown klient procedure: taskBoardService.overview',
    'method not found: taskBoardService.overview',
    'service not available in app scope: taskBoardService',
  ])('falls back once on an old server response: %s', async (unavailableMessage) => {
    const overview = vi.fn(async () => {
      throw Object.assign(new Error(unavailableMessage), { code: 40001 });
    });
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      return {
        ok: true,
        value: {
          workspaceId: input.workspaceId,
          storage,
          cards: [{ ...summary, id: `task-${input.workspaceId}`, workspaceId: input.workspaceId }],
          issues: [],
        },
      };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    const controller = new TaskBoardController({ read, write, overview });

    await controller.refresh(['workspace-a', 'workspace-b']);
    await controller.refresh(['workspace-a', 'workspace-b']);

    expect(overview).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.map(([input]) => input.action === 'list' ? input.workspaceId : undefined)).toEqual([
      'workspace-a',
      'workspace-b',
      'workspace-a',
      'workspace-b',
    ]);
    expect(controller.getSnapshot().cards.map((entry) => entry.workspaceId)).toEqual(['workspace-a', 'workspace-b']);
    expect(controller.getSnapshot().issues).toEqual([]);
  });

  it('does not treat another unavailable service as an overview compatibility error', async () => {
    const overview = vi.fn(async () => {
      throw Object.assign(new Error('service not available in app scope: agentPanelService'), { code: 40001 });
    });
    const read = vi.fn<BoardClient['read']>();
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    const controller = new TaskBoardController({ read, write, overview });

    await controller.refresh(['workspace-a', 'workspace-b']);

    expect(overview).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(controller.getSnapshot().refreshFailed).toBe(true);
    expect(controller.getSnapshot().issues).toHaveLength(2);
  });

  it('fans out workspace reads with bounded concurrency and merges snapshots in workspace order', async () => {
    const workspaceIds = Array.from({ length: 20 }, (_, index) => `workspace-${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers = new Map<string, () => void>();
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
      if (input.action !== 'list' || input.workspaceId === undefined) {
        throw new Error('This fixture only handles scoped list reads.');
      }
      const workspaceId = input.workspaceId;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => { resolvers.set(workspaceId, resolve); });
      inFlight -= 1;
      const cardInWorkspace = { ...summary, id: `task-${workspaceId}`, workspaceId, sessionIds: [] };
      return { ok: true, value: { workspaceId, storage, cards: [cardInWorkspace], issues: [] } };
    });
    const write = vi.fn<BoardClient['write']>().mockResolvedValue({ ok: true, value: card });
    const controller = new TaskBoardController({ read, write });
    const refreshPromise = controller.refresh(workspaceIds);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(resolvers.size).toBe(8);
    expect(maxInFlight).toBe(8);
    // Resolve LIFO so completion order deliberately disagrees with workspace order.
    while (resolvers.size > 0) {
      const key = [...resolvers.keys()].at(-1)!;
      resolvers.get(key)!();
      resolvers.delete(key);
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    await refreshPromise;
    const snapshot = controller.getSnapshot();
    expect(snapshot.loading).toBe(false);
    expect(snapshot.refreshFailed).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.cards.map((entry) => entry.workspaceId)).toEqual(workspaceIds);
    expect(maxInFlight).toBe(8);
  });

  it.each([100, 1000])('publishes only the first 100 of %i cards before idle continuation and deduplicates issues', async (count) => {
    vi.useFakeTimers();
    try {
      const cards = Array.from({ length: count }, (_, index) => ({ ...summary, id: `task-${String(index).padStart(4, '0')}` }));
      const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => {
        if (input.action !== 'list') throw new Error('Expected list');
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        return { ok: true, value: { workspaceId: 'workspace-a', storage, cards: cards.slice(start, start + 100), issues: [{ code: 'BAD_CARD', message: 'One invalid envelope' }], nextCursor: start + 100 < count ? String(start + 100) : undefined } };
      });
      const controller = new TaskBoardController({ read, write: vi.fn() });
      await controller.refresh(['workspace-a']);
      expect(read).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().cards).toHaveLength(Math.min(100, count));
      await vi.runAllTimersAsync();
      expect(controller.getSnapshot().cards).toHaveLength(count);
      expect(controller.getSnapshot().cardIssues).toHaveLength(1);
      expect(controller.getSnapshot().loading).toBe(false);
      expect(read).toHaveBeenCalledTimes(Math.ceil(count / 100));
    } finally { vi.useRealTimers(); }
  });

  it('accepts overview first-page cursors and keeps detail edits through idle pages', async () => {
    vi.useFakeTimers();
    try {
      const overview = vi.fn(async () => ({ ok: true as const, value: [
        { workspaceId: 'workspace-a', result: { ok: true as const, value: { workspaceId: 'workspace-a', storage, cards: [summary], issues: [], nextCursor: 'next' } } },
        { workspaceId: 'workspace-b', result: { ok: true as const, value: { workspaceId: 'workspace-b', cards: [], issues: [] } } },
      ] }));
      const read = vi.fn<BoardClient['read']>().mockImplementation(async (input) => input.action === 'show'
        ? { ok: true, value: card }
        : { ok: true, value: { workspaceId: 'workspace-a', storage, cards: [summary, { ...summary, id: 'later' }], issues: [] } });
      const controller = new TaskBoardController({ read, write: vi.fn(), overview });
      await controller.refresh(['workspace-a', 'workspace-b']);
      expect(read).not.toHaveBeenCalled();
      expect(controller.getSnapshot().cards).toEqual([summary]);
      await controller.open(boardCardKey(card));
      await vi.runAllTimersAsync();
      expect(controller.getSnapshot().cards).toHaveLength(2);
      expect(controller.getSnapshot().cards[0]).toEqual(card);
      expect(read.mock.calls[1]![0]).toMatchObject({ action: 'list', cursor: 'next' });
    } finally { vi.useRealTimers(); }
  });

  it('aborts old in-flight scope reads and never starts their queued workspaces or pages', async () => {
    const signals: AbortSignal[] = [];
    const read = vi.fn<BoardClient['read']>().mockImplementation(async (input, options) => {
      if (input.action !== 'list') throw new Error('Expected list');
      const signal = options!.signal!;
      signals.push(signal);
      if (input.workspaceId === 'workspace-new') return { ok: true, value: { workspaceId: input.workspaceId, cards: [], issues: [] } };
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      throw new Error('Never reached');
    });
    const controller = new TaskBoardController({ read, write: vi.fn() });
    const old = controller.refresh(Array.from({ length: 20 }, (_, index) => `workspace-${index}`));
    await controller.refresh(['workspace-new']);
    await old;
    expect(read).toHaveBeenCalledTimes(9);
    expect(signals.slice(0, 8).every((signal) => signal.aborted)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ cards: [], issues: [], loading: false });
    controller.cancelRefresh();
    expect(signals.at(-1)!.aborted).toBe(true);
  });

  it('cancels scheduled pagination on unmount and keeps first-page cards on a later-page failure', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn<BoardClient['read']>().mockResolvedValueOnce({ ok: true, value: { workspaceId: 'workspace-a', storage, cards: [summary], issues: [], nextCursor: 'next' } });
      const controller = new TaskBoardController({ read, write: vi.fn() });
      await controller.refresh(['workspace-a']);
      controller.cancelRefresh();
      await vi.runAllTimersAsync();
      expect(read).toHaveBeenCalledTimes(1);
      read.mockResolvedValueOnce({ ok: true, value: { workspaceId: 'workspace-a', storage, cards: [summary], issues: [], nextCursor: 'next' } });
      read.mockResolvedValueOnce({ ok: false, error: { code: 'BOARD_UNAVAILABLE', message: 'Later page failed' } });
      await controller.refresh(['workspace-a']);
      await vi.runAllTimersAsync();
      expect(controller.getSnapshot()).toMatchObject({ cards: [summary], loading: false, refreshFailed: false, issues: [{ code: 'BOARD_UNAVAILABLE' }] });
    } finally { vi.useRealTimers(); }
  });
});

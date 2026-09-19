// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';

import { buildAgentForest, createViewState } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { clearToasts, getToasts } from '../lib/toasts';
import { RightRail } from './RightRail';
import { SubagentDetailActions } from './agent-workspace';
import { TasksPage } from './TasksPage';

const listTasks = vi.fn();
const getTask = vi.fn();
const cancelTask = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: { listTasks, getTask, cancelTask } }),
  // No live session controller in these fixtures: the agent panel reports
  // "not reported" instead of borrowing another agent's data.
  useOptionalControllerRegistry: () => null,
}));

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearToasts();
  listTasks.mockReset();
  getTask.mockReset();
  cancelTask.mockReset();
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    session_id: 'sess-1',
    kind: 'bash',
    description: `task ${overrides.id}`,
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function renderPage(initialPath = '/s/sess-1/tasks') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="/s/:id/tasks" element={<TasksPage onToggleSidebar={() => {}} />} />
              <Route path="/s/:id" element={<div data-session-home />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  // Flush react-query promise resolution + re-render (a few microtask turns).
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe('TasksPage', () => {
  it('renders status filter chips with counts and filters rows by status', async () => {
    listTasks.mockResolvedValue({
      items: [
        makeTask({ id: 't1', status: 'running', description: 'dev server' }),
        makeTask({ id: 't2', status: 'failed', description: 'broken build' }),
        makeTask({ id: 't3', status: 'completed', description: 'lint pass' }),
      ],
    });
    const container = await renderPage();
    expect(listTasks).toHaveBeenCalledWith('sess-1');
    expect(container.querySelectorAll('[data-task-row]')).toHaveLength(3);
    expect(container.textContent).toContain('dev server');

    const failedChip = container.querySelector<HTMLButtonElement>('[data-status-filter="failed"]')!;
    expect(failedChip.textContent).toContain('1');
    await act(async () => {
      failedChip.click();
    });
    const rows = container.querySelectorAll('[data-task-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('broken build');
  });

  it('shows the empty state when the session has no tasks', async () => {
    listTasks.mockResolvedValue({ items: [] });
    const container = await renderPage();
    expect(container.textContent).toContain('No background tasks in this session yet.');
  });

  it('shows the error state with retry when the list fails', async () => {
    listTasks.mockRejectedValue(new Error('boom'));
    const container = await renderPage();
    expect(container.textContent).toContain('Could not load tasks');
    expect(container.textContent).toContain('boom');
    listTasks.mockResolvedValue({ items: [] });
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )!;
    await act(async () => {
      retry.click();
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain('No background tasks in this session yet.');
  });

  it('expands a row to lazily load and show the output preview', async () => {
    const task = makeTask({ id: 't1', command: 'pnpm test' });
    listTasks.mockResolvedValue({ items: [task] });
    getTask.mockResolvedValue({ ...task, output_preview: 'all green', output_bytes: 9 });
    const container = await renderPage();
    expect(getTask).not.toHaveBeenCalled();

    const expand = container.querySelector<HTMLButtonElement>('[aria-label="Show task details"]')!;
    await act(async () => {
      expand.click();
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getTask).toHaveBeenCalledWith('sess-1', 't1', { with_output: true });
    const output = container.querySelector('[data-task-output]');
    expect(output?.textContent).toContain('all green');
    expect(container.querySelector('[data-task-detail]')?.textContent).toContain('pnpm test');
  });

  it('cancels a running task through the shared cancel route and refetches', async () => {
    listTasks.mockResolvedValue({
      items: [makeTask({ id: 't1', status: 'running', description: 'dev server' })],
    });
    cancelTask.mockResolvedValue({ cancelled: true });
    const container = await renderPage();
    const stop = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop',
    )!;
    await act(async () => {
      stop.click();
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(cancelTask).toHaveBeenCalledWith('sess-1', 't1');
    // Invalidation refetches the list; the row reconciles with server truth.
    expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('raises a sticky error toast when cancellation fails', async () => {
    listTasks.mockResolvedValue({
      items: [makeTask({ id: 't1', status: 'running' })],
    });
    cancelTask.mockRejectedValue(new Error('nope'));
    const container = await renderPage();
    const stop = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop',
    )!;
    await act(async () => {
      stop.click();
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getToasts().some((toast) => toast.tone === 'error' && toast.text.includes('nope'))).toBe(
      true,
    );
  });

  it('navigates back to the session view', async () => {
    listTasks.mockResolvedValue({ items: [] });
    const container = await renderPage();
    const back = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Back to session',
    )!;
    await act(async () => {
      back.click();
    });
    expect(container.querySelector('[data-session-home]')).not.toBeNull();
  });
});

describe('RightRail tasks view-all entry', () => {
  it('links the tasks chapter to the session tasks page', async () => {
    const state = {
      ...createViewState('sess-1'),
      session: {
        id: 'sess-1',
        metadata: { cwd: 'C:/work/example' },
        message_count: 3,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      tasks: [makeTask({ id: 't1', status: 'running', description: 'dev server' })],
    };
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter initialEntries={['/s/sess-1']}>
              <Routes>
                <Route
                  path="/s/:id"
                  element={
                    <RightRail
                      state={state as never}
                      forest={{ byId: {}, roots: [] }}
                      onCancelTask={() => {}}
                      onOpenSubagent={() => {}}
                    />
                  }
                />
                <Route path="/s/:id/tasks" element={<div data-tasks-page-destination />} />
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    const viewAll = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('View all'),
    );
    expect(viewAll).toBeDefined();
    await act(async () => {
      viewAll!.click();
    });
    expect(container.querySelector('[data-tasks-page-destination]')).not.toBeNull();
  });
});

function railStateWith(tasks: Task[]) {
  return {
    ...createViewState('sess-1'),
    session: {
      id: 'sess-1',
      metadata: { cwd: 'C:/work/example' },
      message_count: 1,
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    tasks,
  };
}

async function renderRail(
  state: ReturnType<typeof railStateWith>,
  forest: ReturnType<typeof buildAgentForest>,
  extra: {
    taskOwnerAgentId?: string;
    onCancelTask?: (taskId: string, ownerAgentId?: string) => void;
    onStopAgentTask?: (ownerAgentId: string, taskId: string) => Promise<void>;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/s/sess-1']}>
            <RightRail
              state={state as never}
              forest={forest}
              onCancelTask={() => {}}
              onOpenSubagent={() => {}}
              {...extra}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

async function flushMicrotasks(turns = 5) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function closeDialog(dialog: Element) {
  const close = [...dialog.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Close',
  )!;
  await act(async () => {
    close.click();
  });
}

describe('RightRail task detail modal', () => {
  it('opens a terminal-style detail view from a task row and streams output into it', async () => {
    const task = makeTask({ id: 't1', status: 'running', description: 'dev server' });
    getTask.mockResolvedValue({ ...task, output_preview: 'line one\nline two' });
    const container = await renderRail(railStateWith([task]), { byId: {}, roots: [] });
    const opener = container.querySelector<HTMLButtonElement>('[data-task-open="t1"]')!;
    expect(opener.title).toBe('View task details');
    await act(async () => {
      opener.click();
    });
    await flushMicrotasks();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(getTask).toHaveBeenCalledWith('sess-1', 't1', {
      with_output: true,
      agent_id: undefined,
    });
    expect(dialog!.textContent).toContain('dev server');
    expect(dialog!.querySelector('[data-task-detail-output]')?.textContent).toContain('line one');
    expect(dialog!.querySelector('[data-task-detail-status]')?.textContent).toContain('running');

    // Auto-scroll pause toggle flips its pressed state and label.
    const toggle = dialog!.querySelector<HTMLButtonElement>('[data-task-detail-follow]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.textContent).toContain('Pause auto-scroll');
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('Resume auto-scroll');

    await closeDialog(dialog!);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the exit code and stop reason once the task settles', async () => {
    const task = makeTask({ id: 't2', status: 'running', description: 'build' });
    getTask.mockResolvedValue({
      ...task,
      status: 'failed',
      completed_at: '2026-01-01T00:01:00.000Z',
      exit_code: 1,
      stop_reason: 'process exited',
      output_preview: 'boom',
    });
    const container = await renderRail(railStateWith([task]), { byId: {}, roots: [] });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-task-open="t2"]')!.click();
    });
    await flushMicrotasks();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[data-task-detail-status]')?.textContent).toContain('failed');
    expect(dialog.querySelector('[data-task-detail-exit-code]')?.textContent).toContain('1');
    expect(dialog.querySelector('[data-task-detail-stop-reason]')?.textContent).toContain(
      'process exited',
    );
    await closeDialog(dialog);
  });

  it('stops a running task from the modal through the shared cancel handler', async () => {
    const task = makeTask({ id: 't3', status: 'running', description: 'watcher' });
    getTask.mockResolvedValue(task);
    const onCancel = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter initialEntries={['/s/sess-1']}>
              <RightRail
                state={railStateWith([task]) as never}
                forest={{ byId: {}, roots: [] }}
                onCancelTask={onCancel}
                onOpenSubagent={() => {}}
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-task-open="t3"]')!.click();
    });
    await flushMicrotasks();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const stop = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop',
    )!;
    await act(async () => {
      stop.click();
    });
    expect(onCancel).toHaveBeenCalledWith('t3', undefined);
    await closeDialog(dialog);
  });

  it('reads and stops a task from a subagent state through that agent scope', async () => {
    const task = makeTask({ id: 'agent-task-1', status: 'running', description: 'child build' });
    const agentState = railStateWith([task]);
    getTask.mockResolvedValue({ ...task, output_preview: 'child output' });
    const onCancelTask = vi.fn((taskId: string, ownerAgentId?: string) => {
      void cancelTask('sess-1', taskId, { agent_id: ownerAgentId });
    });
    const container = await renderRail(agentState, { byId: {}, roots: [] }, {
      taskOwnerAgentId: 'agent-a',
      onCancelTask,
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-task-open="agent-task-1"]')!.click();
    });
    await flushMicrotasks();

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(getTask).toHaveBeenCalledWith('sess-1', 'agent-task-1', {
      with_output: true,
      agent_id: 'agent-a',
    });
    expect(dialog.querySelector('[data-task-detail-output]')?.textContent).toContain(
      'child output',
    );

    const stop = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop',
    )!;
    await act(async () => {
      stop.click();
    });
    expect(onCancelTask).toHaveBeenCalledWith('agent-task-1', 'agent-a');
    expect(cancelTask).toHaveBeenCalledWith('sess-1', 'agent-task-1', {
      agent_id: 'agent-a',
    });
    await closeDialog(dialog);
  });
});

describe('nested subagent detail termination', () => {
  it('renders B terminate action and stops its task through parent A', async () => {
    const forest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        { agentId: 'agent-a', parentAgentId: 'main', name: 'A', status: 'running' },
        { agentId: 'agent-b', parentAgentId: 'agent-a', name: 'B', status: 'running' },
      ],
    );
    const nestedTask = makeTask({
      id: 'spawn-b',
      kind: 'subagent',
      status: 'running',
      description: 'B',
      agent_id: 'agent-b',
    });
    const parentState = railStateWith([nestedTask]);
    const ownerAgentId = forest.byId['agent-b']?.parentAgentId ?? 'main';
    const runningAgentTask = parentState.tasks.find(
      (task) =>
        task.kind === 'subagent' && task.status === 'running' && task.agent_id === 'agent-b',
    );
    expect(runningAgentTask).toBeDefined();
    const stopAgentTask = vi.fn(
      (_ownerAgentId: string, _taskId: string) => Promise.resolve(),
    );
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <SubagentDetailActions
            agentId="agent-b"
            name="B"
            live
            canTerminate={runningAgentTask !== undefined}
            models={[]}
            onSendMessage={() => Promise.resolve()}
            onTerminate={() => stopAgentTask(ownerAgentId, runningAgentTask!.id)}
            onChangeModel={() => Promise.resolve()}
          />
        </I18nProvider>,
      );
    });

    const terminate = container.querySelector<HTMLButtonElement>('[data-subagent-terminate]');
    expect(terminate).not.toBeNull();
    await act(async () => {
      terminate!.click();
    });
    const dialog = container.querySelector('[role="alertdialog"]')!;
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Terminate',
    )!;
    await act(async () => {
      confirm.click();
    });
    await flushMicrotasks();

    expect(stopAgentTask).toHaveBeenCalledWith('agent-a', 'spawn-b');
  });
});

describe('RightRail terminate-all subagents', () => {
  const forest = buildAgentForest(
    [],
    [
      { agentId: 'main', name: 'Main' },
      { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'running' },
    ],
  );
  const subTask = makeTask({
    id: 'sub-1',
    kind: 'subagent',
    status: 'running',
    description: 'Researcher',
    agent_id: 'agent-1',
  });

  it('hides the bulk stop button when no stopper is provided', async () => {
    const container = await renderRail(railStateWith([subTask]), forest);
    expect(container.querySelector('[data-terminate-all-subagents]')).toBeNull();
    expect(container.querySelector('[data-subagents-view-all]')).not.toBeNull();
  });

  it('confirms, then stops every running subagent through its owner scope', async () => {
    const stopAgentTask = vi.fn(() => Promise.resolve());
    const container = await renderRail(railStateWith([subTask]), forest, {
      onStopAgentTask: stopAgentTask,
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-terminate-all-subagents]')!;
    expect(trigger.textContent).toContain('Stop all');
    await act(async () => {
      trigger.click();
    });
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Stop the subagents running now?');
    expect(dialog.textContent).toContain('1 total');
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop current subagents',
    )!;
    await act(async () => {
      confirm.click();
    });
    await flushMicrotasks();
    expect(stopAgentTask).toHaveBeenCalledWith('main', 'sub-1');
    expect(
      getToasts().some(
        (toast) =>
          toast.tone === 'success' && toast.text.includes('confirmed group (1 total)'),
      ),
    ).toBe(true);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('surfaces a failure toast listing the first error when a stop fails', async () => {
    const stopAgentTask = vi.fn(() => Promise.reject(new Error('agent scope gone')));
    const container = await renderRail(railStateWith([subTask]), forest, {
      onStopAgentTask: stopAgentTask,
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-terminate-all-subagents]')!.click();
    });
    const confirm = [
      ...container.querySelector('[role="alertdialog"]')!.querySelectorAll('button'),
    ].find((button) => button.textContent === 'Stop current subagents')!;
    await act(async () => {
      confirm.click();
    });
    await flushMicrotasks();
    expect(
      getToasts().some(
        (toast) =>
          toast.tone === 'error' &&
          toast.text.includes('agent scope gone') &&
          toast.text.includes('1 remain running'),
      ),
    ).toBe(true);
  });

  it('reports a newly running subagent that was outside the confirmed snapshot', async () => {
    let resolveStop: (() => void) | undefined;
    const stopAgentTask = vi.fn(
      () => new Promise<void>((resolve) => { resolveStop = resolve; }),
    );
    const newTask = makeTask({
      id: 'sub-2',
      kind: 'subagent',
      status: 'running',
      description: 'Reviewer',
      agent_id: 'agent-2',
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const render = async (tasks: Task[]) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <I18nProvider>
              <MemoryRouter initialEntries={['/s/sess-1']}>
                <RightRail
                  state={railStateWith(tasks) as never}
                  forest={forest}
                  onCancelTask={() => {}}
                  onStopAgentTask={stopAgentTask}
                  onOpenSubagent={() => {}}
                />
              </MemoryRouter>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
    };

    await render([subTask]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-terminate-all-subagents]')!.click();
    });
    const confirm = [
      ...container.querySelector('[role="alertdialog"]')!.querySelectorAll('button'),
    ].find((button) => button.textContent === 'Stop current subagents')!;
    await act(async () => {
      confirm.click();
    });
    expect(stopAgentTask).toHaveBeenCalledTimes(1);

    await render([subTask, newTask]);
    await act(async () => {
      resolveStop?.();
    });
    await flushMicrotasks();

    expect(stopAgentTask).toHaveBeenCalledTimes(1);
    expect(
      getToasts().some(
        (toast) => toast.tone === 'info' && toast.text.includes('1 remain running'),
      ),
    ).toBe(true);
  });
});

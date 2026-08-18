// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@moonshot-ai/protocol';

import { I18nProvider } from '../i18n';
import { clearToasts, getToasts } from '../lib/toasts';
import { RightRail } from './RightRail';
import { sortTasks, TasksPage } from './TasksPage';
import { createViewState } from '../state/transcript';

const listTasks = vi.fn();
const getTask = vi.fn();
const cancelTask = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: { listTasks, getTask, cancelTask } }),
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

describe('sortTasks', () => {
  it('puts running tasks first, then newest-created first', () => {
    const sorted = sortTasks([
      makeTask({ id: 'old-done', created_at: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'running-old', status: 'running', created_at: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'new-done', created_at: '2026-01-03T00:00:00.000Z' }),
      makeTask({ id: 'running-new', status: 'running', created_at: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(sorted.map((task) => task.id)).toEqual([
      'running-new',
      'running-old',
      'new-done',
      'old-done',
    ]);
  });
});

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
    await act(async () => {
      root.render(
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
        </I18nProvider>,
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

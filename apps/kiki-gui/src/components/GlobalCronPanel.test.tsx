// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { ApiError, type CronTask } from '../lib/client';
import { clearToasts, getToasts } from '../lib/toasts';
import { GlobalCronPanel } from './GlobalCronPanel';

const listCronTasks = vi.fn();
const pauseCronTask = vi.fn();
const resumeCronTask = vi.fn();
const runCronTask = vi.fn();
const deleteCronTask = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: { listCronTasks, pauseCronTask, resumeCronTask, runCronTask, deleteCronTask },
  }),
}));

const sessions = [
  { id: 'sess-1', title: 'Alpha session', workspace_id: 'ws-a' },
] as unknown as readonly Session[];
const workspaceOptions = [
  { id: 'ws-a', name: 'Alpha' },
  { id: 'ws-b', name: 'Beta' },
] as unknown as readonly Workspace[];

function makeCronTask(overrides: Partial<CronTask> & { id: string }): CronTask {
  return {
    session_id: 'sess-1',
    workspace_id: 'ws-a',
    cron: '0 9 * * *',
    human_schedule: 'Every day at 09:00',
    prompt_preview: 'Summarize overnight logs',
    next_fire_at: '2099-01-01T09:00:00.000Z',
    recurring: true,
    paused: false,
    age_days: 2,
    stale: false,
    created_at: '2026-01-01T00:00:00.000Z',
    last_fired_at: null,
    ...overrides,
  };
}

// The panel refetches after every mutation, so the list mock mirrors the
// server: mutations mutate `currentTasks` and the next list read serves them.
let currentTasks: CronTask[] = [];

function seedTasks(tasks: CronTask[]): void {
  currentTasks = [...tasks];
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

let container: HTMLDivElement;
let rail: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearToasts();
  seedTasks([]);
  for (const mock of [listCronTasks, pauseCronTask, resumeCronTask, runCronTask, deleteCronTask]) {
    mock.mockReset();
  }
  listCronTasks.mockImplementation(() => Promise.resolve({ items: currentTasks }));
  pauseCronTask.mockImplementation((id: string) => {
    const found = currentTasks.find((task) => task.id === id);
    if (found === undefined) {
      return Promise.reject(new ApiError({ code: 40406, msg: `cron task ${id} does not exist`, data: null }));
    }
    const updated: CronTask = { ...found, paused: true, next_fire_at: null };
    currentTasks = currentTasks.map((task) => (task.id === id ? updated : task));
    return Promise.resolve({ task: updated });
  });
  resumeCronTask.mockImplementation((id: string) => {
    const found = currentTasks.find((task) => task.id === id);
    if (found === undefined) {
      return Promise.reject(new ApiError({ code: 40406, msg: `cron task ${id} does not exist`, data: null }));
    }
    const updated: CronTask = { ...found, paused: false, next_fire_at: '2099-01-01T09:00:00.000Z' };
    currentTasks = currentTasks.map((task) => (task.id === id ? updated : task));
    return Promise.resolve({ task: updated });
  });
  runCronTask.mockImplementation(() => Promise.resolve({ triggered: true as const }));
  deleteCronTask.mockImplementation((id: string) => {
    currentTasks = currentTasks.filter((task) => task.id !== id);
    return Promise.resolve({ deleted: true as const });
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  rail = document.createElement('div');
  rail.setAttribute('data-session-rail', '');
  document.body.append(rail);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  rail.remove();
  document.querySelectorAll('[role="dialog"], [role="alertdialog"]').forEach((node) => node.remove());
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <GlobalCronPanel sessions={sessions} workspaceOptions={workspaceOptions} onNavigate={() => undefined} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

async function openPanel(): Promise<HTMLElement> {
  const launcher = rail.querySelector<HTMLButtonElement>('[data-session-cron-panel]');
  expect(launcher).not.toBeNull();
  await act(async () => { launcher!.click(); });
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}

describe('GlobalCronPanel', () => {
  it('opens from the rail launcher and renders rows with status, schedule, prompt, and ownership', async () => {
    seedTasks([
      makeCronTask({ id: 'task-1' }),
      makeCronTask({
        id: 'task-2',
        session_id: null,
        workspace_id: 'ws-b',
        cron: '*/30 * * * *',
        human_schedule: 'Every 30 minutes',
        prompt_preview: 'Poll the inbox',
        next_fire_at: null,
        paused: true,
        stale: true,
        last_fired_at: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    await mount();
    const dialog = await openPanel();

    expect(listCronTasks).toHaveBeenCalledTimes(1);
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-cron-task]')];
    expect(rows).toHaveLength(2);

    expect(rows[0]!.querySelector('[data-cron-status="running"]')).not.toBeNull();
    expect(rows[0]!.textContent).toContain('Every day at 09:00');
    expect(rows[0]!.textContent).toContain('Summarize overnight logs');
    expect(rows[0]!.textContent).toContain('0 9 * * *');
    expect(rows[0]!.textContent).toContain('Recurring');
    expect(rows[0]!.querySelector('[data-cron-session="sess-1"]')?.textContent).toBe('Alpha session');
    expect(rows[0]!.textContent).toContain('Alpha');
    expect(rows[0]!.textContent).toContain('Next run');
    expect(rows[0]!.textContent).toContain('Never');

    expect(rows[1]!.querySelector('[data-cron-status="paused"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-cron-status="stale"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-cron-session]')).toBeNull();
    expect(rows[1]!.textContent).toContain('Beta');
  });

  it('shows the empty state when no tasks exist', async () => {
    await mount();
    const dialog = await openPanel();
    expect(dialog.querySelector('[data-cron-empty]')).not.toBeNull();
    expect(dialog.textContent).toContain('No scheduled tasks');
  });

  it('shows a retryable error state when the list fails to load', async () => {
    listCronTasks.mockRejectedValueOnce(new ApiError({ code: 50001, msg: 'server exploded', data: null }));
    await mount();
    const dialog = await openPanel();
    expect(dialog.querySelector('[data-cron-error]')).not.toBeNull();
    expect(dialog.textContent).toContain('Could not load scheduled tasks');
    expect(dialog.textContent).toContain('server exploded');

    seedTasks([makeCronTask({ id: 'task-1' })]);
    const retry = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await flush();
    expect(dialog.querySelector('[data-cron-task="task-1"]')).not.toBeNull();
  });

  it('pauses a task, passes the session id for disambiguation, and refreshes the row', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    await mount();
    const dialog = await openPanel();

    const pause = dialog.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="pause"]');
    expect(pause).not.toBeNull();
    await act(async () => { pause!.click(); });
    await flush();

    expect(pauseCronTask).toHaveBeenCalledWith('task-1', 'sess-1');
    expect(getToasts().some((toast) => toast.tone === 'success' && toast.text === 'Scheduled task paused')).toBe(true);
    expect(dialog.querySelector('[data-cron-task="task-1"] [data-cron-status="paused"]')).not.toBeNull();
    expect(dialog.querySelector('[data-cron-task="task-1"] [data-cron-action="resume"]')).not.toBeNull();
  });

  it('resumes a paused task', async () => {
    seedTasks([makeCronTask({ id: 'task-1', paused: true, next_fire_at: null })]);
    await mount();
    const dialog = await openPanel();

    const resume = dialog.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="resume"]');
    expect(resume).not.toBeNull();
    await act(async () => { resume!.click(); });
    await flush();

    expect(resumeCronTask).toHaveBeenCalledWith('task-1', 'sess-1');
    expect(getToasts().some((toast) => toast.text === 'Scheduled task resumed')).toBe(true);
    expect(dialog.querySelector('[data-cron-task="task-1"] [data-cron-status="running"]')).not.toBeNull();
  });

  it('triggers a task immediately without touching its schedule', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    await mount();
    const dialog = await openPanel();

    const run = dialog.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="run"]');
    await act(async () => { run!.click(); });
    await flush();

    expect(runCronTask).toHaveBeenCalledWith('task-1', 'sess-1');
    expect(getToasts().some((toast) => toast.text === 'Scheduled task triggered')).toBe(true);
    // The list is not re-sorted or refetched for a fire; the row stays as-is.
    expect(dialog.querySelector('[data-cron-task="task-1"]')).not.toBeNull();
  });

  it('requires confirmation before deleting and removes the row on confirm', async () => {
    seedTasks([makeCronTask({ id: 'task-1' }), makeCronTask({ id: 'task-2', session_id: null })]);
    await mount();
    const dialog = await openPanel();

    const del = dialog.querySelector<HTMLButtonElement>('[data-cron-task="task-2"] [data-cron-action="delete"]');
    await act(async () => { del!.click(); });

    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('Every day at 09:00');
    expect(deleteCronTask).not.toHaveBeenCalled();

    const confirmButton = [...confirm!.querySelectorAll('button')].find((button) => button.textContent === 'Delete');
    await act(async () => { confirmButton!.click(); });
    await flush();

    expect(deleteCronTask).toHaveBeenCalledWith('task-2', undefined);
    expect(getToasts().some((toast) => toast.text === 'Scheduled task deleted')).toBe(true);
    expect(dialog.querySelector('[data-cron-task="task-2"]')).toBeNull();
    expect(dialog.querySelector('[data-cron-task="task-1"]')).not.toBeNull();
  });

  it('keeps the task when the delete confirmation is cancelled', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    await mount();
    const dialog = await openPanel();

    const del = dialog.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="delete"]');
    await act(async () => { del!.click(); });
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]');
    const cancel = [...confirm!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
    await act(async () => { cancel!.click(); });

    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(deleteCronTask).not.toHaveBeenCalled();
    expect(dialog.querySelector('[data-cron-task="task-1"]')).not.toBeNull();
  });

  it('maps a 40406 action failure to the friendly not-found toast and refetches', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    await mount();
    const dialog = await openPanel();

    // The task vanished server-side after the list was rendered.
    seedTasks([]);
    const pause = dialog.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="pause"]');
    await act(async () => { pause!.click(); });
    await flush();

    const toast = getToasts().find((entry) => entry.tone === 'error');
    expect(toast?.text).toBe('This task no longer exists; the list was refreshed.');
    // Initial load + the invalidation refetch after the failed action.
    expect(listCronTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('navigates to the owning session from the row link and closes the panel', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    const onNavigate = vi.fn();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <GlobalCronPanel sessions={sessions} workspaceOptions={workspaceOptions} onNavigate={onNavigate} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await openPanel();

    const sessionLink = document.querySelector<HTMLButtonElement>('[data-cron-session="sess-1"]');
    await act(async () => { sessionLink!.click(); });

    expect(onNavigate).toHaveBeenCalledWith('/s/sess-1');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

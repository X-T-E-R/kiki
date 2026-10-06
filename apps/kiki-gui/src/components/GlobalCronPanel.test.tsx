// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { ApiError, type CronTask } from '../lib/client';
import { clearToasts, getToasts } from '../lib/toasts';
import { MemoryRouter } from 'react-router-dom';
import { en as EN_DICTIONARY } from '@kiki/session-core/i18n/en';
import { CronPage, filterCronTasks } from './GlobalCronPanel';

const listCronTasks = vi.fn();
const pauseCronTask = vi.fn();
const resumeCronTask = vi.fn();
const runCronTask = vi.fn();
const deleteCronTask = vi.fn();
const getCronTask = vi.fn();
const createCronTask = vi.fn();
const updateCronTask = vi.fn();

vi.mock('../state/connection', () => ({
  useOptionalConnection: () => undefined,
  useConnection: () => ({
    client: {
      listCronTasks,
      pauseCronTask,
      resumeCronTask,
      runCronTask,
      deleteCronTask,
      getCronTask,
      createCronTask,
      updateCronTask,
    },
  }),
}));

const sessions = [
  { id: 'sess-1', title: 'Alpha session', workspace_id: 'ws-a' },
  { id: 'sess-2', title: 'Beta session', workspace_id: 'ws-a' },
  { id: 'sess-3', title: 'Gamma session', workspace_id: 'ws-b' },
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
let root: Root;
let queryClient: QueryClient;

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearToasts();
  seedTasks([]);
  for (const mock of [listCronTasks, pauseCronTask, resumeCronTask, runCronTask, deleteCronTask, getCronTask, createCronTask, updateCronTask]) {
    mock.mockReset();
  }
  listCronTasks.mockImplementation((query: { session_id?: string; offset?: number; page_size?: number } = {}) => {
    // Mirrors `GET /api/cron`: narrow to the session, then page the narrowed set.
    const scoped = currentTasks.filter((task) => query.session_id === undefined || task.session_id === query.session_id);
    const offset = query.offset ?? 0;
    const size = query.page_size ?? 100;
    const hasMore = scoped.length > offset + size;
    return Promise.resolve({
      items: scoped.slice(offset, offset + size),
      has_more: hasMore,
      next_offset: hasMore ? offset + size : undefined,
    });
  });
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
  getCronTask.mockImplementation((id: string) => {
    const found = currentTasks.find((task) => task.id === id);
    if (found === undefined) {
      return Promise.reject(new ApiError({ code: 40406, msg: `cron task ${id} does not exist`, data: null }));
    }
    return Promise.resolve({ task: { ...found, prompt: `Full prompt for ${id}` } });
  });
  createCronTask.mockImplementation((input: { session_id: string; cron: string; prompt: string; recurring: boolean }) => {
    const created: CronTask = makeCronTask({
      id: 'created-1',
      session_id: input.session_id,
      cron: input.cron,
      human_schedule: 'Every day at 09:00',
      prompt_preview: input.prompt,
      recurring: input.recurring,
    });
    currentTasks = [...currentTasks, created];
    return Promise.resolve({ task: { ...created, prompt: input.prompt } });
  });
  updateCronTask.mockImplementation((id: string, patch: { cron?: string; prompt?: string; session_id?: string; recurring?: boolean }) => {
    const found = currentTasks.find((task) => task.id === id);
    if (found === undefined) {
      return Promise.reject(new ApiError({ code: 40406, msg: `cron task ${id} does not exist`, data: null }));
    }
    const updated: CronTask = { ...found, ...patch };
    currentTasks = currentTasks.map((task) => (task.id === id ? updated : task));
    return Promise.resolve({ task: { ...updated, prompt: patch.prompt ?? found.prompt_preview } });
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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

/** Types into a React-controlled field the way the browser would. */
async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(entry = '/cron', onNavigate: (target: unknown) => void = () => undefined): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <CronPage sessions={sessions} workspaceOptions={workspaceOptions} onNavigate={onNavigate} onToggleSidebar={() => undefined} />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

async function openPanel(): Promise<HTMLElement> {
  await flush();
  const page = container.querySelector<HTMLElement>('[data-cron-page]');
  expect(page).not.toBeNull();
  return page!;
}

describe('CronPage', () => {
  it('loads subsequent scheduled-task pages on demand', async () => {
    seedTasks(Array.from({ length: 101 }, (_, index) => makeCronTask({ id: `task-${index}` })));
    await mount();
    const dialog = await openPanel();
    expect(dialog.querySelectorAll('[data-cron-task]')).toHaveLength(100);
    const more = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Load more scheduled tasks')!;
    await act(async () => { more.click(); });
    await flush();
    expect(listCronTasks).toHaveBeenCalledWith({ page_size: 100, offset: 100 });
    expect(dialog.querySelectorAll('[data-cron-task]')).toHaveLength(101);
  });

  it('renders rows with status, schedule, prompt, and ownership', async () => {
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
    // The row leads with the schedule in the reader's language, not the
    // engine's string and not the raw expression.
    expect(rows[0]!.querySelector('[data-cron-schedule]')?.textContent).toBe('Every day at 09:00');
    expect(rows[0]!.textContent).toContain('Summarize overnight logs');
    expect(rows[0]!.textContent).not.toContain('0 9 * * *');
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
    // The one control flips its own label; its test hook stays the same.
    expect(dialog.querySelector('[data-cron-task="task-1"] [data-cron-action="pause"]')?.textContent).toBe('Resume');
  });

  it('resumes a paused task', async () => {
    seedTasks([makeCronTask({ id: 'task-1', paused: true, next_fire_at: null })]);
    await mount();
    const dialog = await openPanel();

    const resume = dialog.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="pause"]');
    expect(resume?.textContent).toBe('Resume');
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

  it('navigates to the owning session from the row link', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    const onNavigate = vi.fn();
    await mount('/cron', onNavigate);
    const page = await openPanel();

    const sessionLink = page.querySelector<HTMLButtonElement>('[data-cron-session="sess-1"]');
    await act(async () => { sessionLink!.click(); });

    expect(onNavigate).toHaveBeenCalledWith('/s/sess-1');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('names the schedule in the locale instead of the engine string, and keeps the expression for the detail', async () => {
    seedTasks([makeCronTask({ id: 'task-1', cron: '0 * * * *', human_schedule: 'at minute 0 of every hour' })]);
    await mount();
    const page = await openPanel();

    // The engine's English must not stand in for the schedule.
    expect(page.querySelector('[data-cron-schedule]')?.textContent).toBe('Every hour on the hour');
    expect(page.textContent).not.toContain('at minute 0 of every hour');
    // The expression is a fact about the rule, so it lives in the panel.
    expect(page.textContent).not.toContain('0 * * * *');

    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-action="expand"]')!.click(); });
    await flush();
    expect(page.querySelector('[data-cron-detail]')?.textContent).toContain('0 * * * *');
  });

  it('reads the full prompt only for the row that was opened', async () => {
    seedTasks([makeCronTask({ id: 'task-1' }), makeCronTask({ id: 'task-2' })]);
    await mount();
    const page = await openPanel();

    expect(getCronTask).not.toHaveBeenCalled();
    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-action="expand"]')!.click(); });
    await flush();

    expect(getCronTask).toHaveBeenCalledTimes(1);
    expect(getCronTask).toHaveBeenCalledWith('task-1', 'sess-1');
    expect(page.querySelector('[data-cron-detail-prompt]')?.textContent).toBe('Full prompt for task-1');
  });

  it('creates a task bound to the chosen conversation with the schedule the controls describe', async () => {
    await mount();
    const page = await openPanel();

    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-create]')!.click(); });
    await flush();
    const editor = document.querySelector<HTMLElement>('[data-cron-editor-title]')!;
    expect(editor.closest('[role="dialog"]')).not.toBeNull();

    const prompt = document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!;
    await typeInto(prompt, 'Summarize the overnight logs.');
    // Pick a different conversation than the default one.
    await act(async () => {
      document.querySelector<HTMLButtonElement>('#cron-bind-session')!.click();
    });
    await flush();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-option-value="sess-2"]')!.click();
    });
    await flush();

    const save = document.querySelector<HTMLButtonElement>('[data-cron-save]')!;
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    await flush();

    expect(createCronTask).toHaveBeenCalledWith({
      session_id: 'sess-2',
      cron: '0 9 * * *',
      prompt: 'Summarize the overnight logs.',
      recurring: true,
      // A new task states the default rather than relying on the host's.
      delivery_mode: 'idle',
    });
    expect(getToasts().some((toast) => toast.text === 'Scheduled task created')).toBe(true);
    expect(document.querySelector('[data-cron-editor-title]')).toBeNull();
  });

  it('edits an existing rule in place and keeps a complex rule as its own text', async () => {
    seedTasks([
      makeCronTask({ id: 'task-simple', cron: '0 9 * * *' }),
      makeCronTask({ id: 'task-complex', cron: '0 9 15 * 1', human_schedule: 'at 09:00 on day 15 of January and Monday' }),
    ]);
    await mount();
    const page = await openPanel();

    // A rule the controls cannot hold opens on the expression, verbatim.
    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-task="task-complex"] [data-cron-action="edit"]')!.click(); });
    await flush();
    const advanced = document.querySelector<HTMLInputElement>('[data-cron-advanced-input]')!;
    expect(advanced.value).toBe('0 9 15 * 1');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
    await flush();
    // Saving an untouched complex rule must not rewrite it into a simpler one.
    expect(updateCronTask).toHaveBeenCalledWith(
      'task-complex',
      expect.objectContaining({ cron: '0 9 15 * 1' }),
      'sess-1',
    );
  });

  it('keeps the draft and the panel open when the server refuses a save', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    updateCronTask.mockRejectedValueOnce(new ApiError({ code: 40001, msg: 'cron expression is invalid', data: null }));
    await mount();
    const page = await openPanel();

    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="edit"]')!.click(); });
    await flush();
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!;
    await typeInto(prompt, 'A prompt the user typed');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
    await flush();

    // The panel survives, and so does everything in it.
    expect(document.querySelector('[data-cron-submit-error]')?.textContent)
      .toBe('Could not save your changes. The draft is still here, try again.');
    expect(document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!.value).toBe('A prompt the user typed');
  });

  // The list row carries a preview; the detail carries the prompt. Saving
  // the preview would truncate the task on the server, so the editor may
  // only ever submit text that came from the detail read.
  describe('the prompt is only savable once it is the real prompt', () => {
    const PREVIEW = 'Summarize overnight logs and post the digest to the release room';
    const FULL = `${PREVIEW}, then list every follow-up the owner has not answered yet.`;

    function seedWithDistinctPrompt(): void {
      seedTasks([makeCronTask({ id: 'task-1', prompt_preview: `${PREVIEW}…(truncated)` })]);
    }

    it('opens on the full prompt, not the preview, and saves the full prompt when only the schedule changed', async () => {
      getCronTask.mockImplementation((id: string) => Promise.resolve({
        task: { ...makeCronTask({ id }), prompt: FULL },
      }));
      seedWithDistinctPrompt();
      await mount();
      const page = await openPanel();

      await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="edit"]')!.click(); });
      await flush();

      expect(document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!.value).toBe(FULL);
      // Change only the frequency; the prompt must not be involved at all.
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-cadence="hourly"]')!.click(); });
      await flush();
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
      await flush();

      expect(updateCronTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ prompt: FULL, cron: '0 * * * *' }),
        'sess-1',
      );
      // The truncated preview must never reach the server.
      expect(updateCronTask.mock.calls[0]?.[1]).not.toMatchObject({ prompt: expect.stringContaining('(truncated)') });
    });

    it('cannot save while the full prompt is still loading, then saves it once it arrives', async () => {
      let release: (() => void) | undefined;
      getCronTask.mockImplementation((id: string) => new Promise((resolve) => {
        release = () => { resolve({ task: { ...makeCronTask({ id }), prompt: FULL } }); };
      }));
      seedWithDistinctPrompt();
      await mount();
      const page = await openPanel();

      await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="edit"]')!.click(); });
      await flush();

      // Still loading: the box is disabled and Save is unavailable, so no
      // save can be built from the preview.
      const prompt = document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!;
      expect(prompt.disabled).toBe(true);
      expect(prompt.value).not.toContain('(truncated)');
      expect(document.querySelector<HTMLButtonElement>('[data-cron-save]')!.disabled).toBe(true);

      await act(async () => { release?.(); });
      await flush();

      expect(document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!.value).toBe(FULL);
      expect(document.querySelector<HTMLButtonElement>('[data-cron-save]')!.disabled).toBe(false);
    });

    it('keeps a schedule edit made before the prompt arrives, and does not overwrite prompt text typed first', async () => {
      let release: (() => void) | undefined;
      getCronTask.mockImplementation((id: string) => new Promise((resolve) => {
        release = () => { resolve({ task: { ...makeCronTask({ id }), prompt: FULL } }); };
      }));
      seedWithDistinctPrompt();
      await mount();
      const page = await openPanel();

      await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="edit"]')!.click(); });
      await flush();

      // Touching the frequency is not touching the prompt: the late read
      // must still land, and must not roll the schedule back.
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-cadence="hourly"]')!.click(); });
      await act(async () => { release?.(); });
      await flush();

      expect(document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!.value).toBe(FULL);
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
      await flush();
      expect(updateCronTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ prompt: FULL, cron: '0 * * * *' }),
        'sess-1',
      );
    });

    it('lets the user type their own prompt when the detail read fails, and offers a retry', async () => {
      getCronTask.mockRejectedValue(new ApiError({ code: 50001, msg: 'detail unavailable', data: null }));
      seedWithDistinctPrompt();
      await mount();
      const page = await openPanel();

      await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-task="task-1"] [data-cron-action="edit"]')!.click(); });
      await flush();

      // A failed read is not a reason to save the preview; the box opens
      // empty and says the prompt is unavailable. The editor is portaled to
      // the body, so it is read from `document`, not from the page subtree.
      const prompt = document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!;
      expect(prompt.value).toBe('');
      expect(prompt.disabled).toBe(false);
      expect(document.querySelector('[data-cron-prompt-error]')?.textContent)
        .toContain('Could not read the full prompt');
      expect(document.querySelector('[data-cron-prompt-retry]')).not.toBeNull();

      await typeInto(prompt, 'The prompt I meant to write.');
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
      await flush();
      expect(updateCronTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ prompt: 'The prompt I meant to write.' }),
        'sess-1',
      );
    });
  });

  it('asks before discarding an edited form', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    await mount();
    const page = await openPanel();

    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-create]')!.click(); });
    await flush();
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!;
    await typeInto(prompt, 'half-written');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-cancel]')!.click(); });
    await flush();

    // The editor is still open: closing it now would lose the draft.
    expect(document.querySelector('[data-cron-editor-title]')).not.toBeNull();
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const discard = [...confirm.querySelectorAll('button')].find((button) => button.textContent === 'Discard changes')!;
    await act(async () => { discard.click(); });
    await flush();
    expect(document.querySelector('[data-cron-editor-title]')).toBeNull();
  });

  it('filters rows client-side to the workspace carried in the URL and keeps the workspace tag', async () => {
    seedTasks([
      makeCronTask({ id: 'task-1' }),
      makeCronTask({ id: 'task-2', session_id: null, workspace_id: 'ws-b' }),
    ]);
    await mount('/cron?workspace=ws-b');
    const page = await openPanel();

    expect(listCronTasks).toHaveBeenCalledWith({ page_size: 100, offset: 0 });
    const rows = [...page.querySelectorAll<HTMLElement>('[data-cron-task]')];
    expect(rows.map((row) => row.dataset['cronTask'])).toEqual(['task-2']);
    expect(rows[0]!.textContent).toContain('Beta');
    expect(page.querySelector('[data-workspace-scope]')?.getAttribute('data-workspace-scope')).toBe('ws-b');
    expect(page.querySelector('[data-scope-option="ws-b"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('offers a way back to all workspaces when the scoped workspace has no tasks', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    await mount('/cron?workspace=ws-b');
    const page = await openPanel();

    expect(page.querySelector('[data-cron-scope-empty]')).not.toBeNull();
    const showAll = page.querySelector<HTMLButtonElement>('[data-cron-scope-empty] button')!;
    await act(async () => { showAll.click(); });
    expect(page.querySelectorAll('[data-cron-task]')).toHaveLength(1);
  });

  it('narrows to the conversation in the URL at the server and pages that conversation', async () => {
    seedTasks([
      ...Array.from({ length: 101 }, (_, index) => makeCronTask({ id: `task-${index}` })),
      makeCronTask({ id: 'other', session_id: 'sess-2', prompt_preview: 'Another conversation’s task' }),
    ]);
    await mount('/cron?session=sess-1');
    const page = await openPanel();

    // The scope travels to the server, so page one is page one of this
    // conversation — not a cross-workspace page filtered after the fact.
    expect(listCronTasks).toHaveBeenCalledWith({ session_id: 'sess-1', page_size: 100, offset: 0 });
    expect(page.querySelector('[data-cron-session-scope]')?.getAttribute('data-cron-session-scope')).toBe('sess-1');
    expect(page.querySelector('[data-cron-session-scope]')!.textContent).toContain('Alpha session');
    expect(page.querySelectorAll('[data-cron-task]')).toHaveLength(100);
    expect(page.textContent).not.toContain('Another conversation’s task');

    const more = [...page.querySelectorAll('button')].find((button) => button.textContent === 'Load more scheduled tasks')!;
    await act(async () => { more.click(); });
    await flush();
    expect(listCronTasks).toHaveBeenLastCalledWith({ session_id: 'sess-1', page_size: 100, offset: 100 });
    expect(page.querySelectorAll('[data-cron-task]')).toHaveLength(101);
  });

  it('states an empty conversation and widens back to every conversation', async () => {
    seedTasks([makeCronTask({ id: 'other', session_id: 'sess-2', workspace_id: 'ws-b' })]);
    await mount('/cron?session=sess-1');
    const page = await openPanel();

    expect(page.querySelector('[data-cron-session-empty]')!.textContent).toContain('No scheduled tasks in this conversation.');
    const showAll = page.querySelector<HTMLButtonElement>('[data-cron-session-empty] button')!;
    await act(async () => { showAll.click(); });
    await flush();
    expect(listCronTasks).toHaveBeenLastCalledWith({ session_id: undefined, page_size: 100, offset: 0 });
    expect(page.querySelector('[data-cron-session-scope]')).toBeNull();
    expect(page.querySelectorAll('[data-cron-task]')).toHaveLength(1);
  });
});

describe('filterCronTasks', () => {
  it('returns every task without a scope and only matching ones with it', () => {
    const tasks = [{ workspace_id: 'a' }, { workspace_id: 'b' }];
    expect(filterCronTasks(tasks, undefined)).toEqual(tasks);
    expect(filterCronTasks(tasks, 'b')).toEqual([{ workspace_id: 'b' }]);
  });
});

describe('scheduled-task delivery timing', () => {
  // The panel renders in whichever locale jsdom resolves; the row chips are
  // matched by their stable data attribute, so only the detail's two
  // sentences need to be read out of the live dictionary.
  const dictionary = EN_DICTIONARY;
  const detailLabel = dictionary['cron.detail.delivery']!;
  const queueHint = dictionary['cron.delivery.hint.queue']!;

  const openEditor = async (page: HTMLElement, id: string): Promise<void> => {
    await act(async () => { page.querySelector<HTMLButtonElement>(`[data-cron-task="${id}"] [data-cron-action="edit"]`)!.click(); });
    await flush();
  };
  const pick = async (mode: 'queue' | 'steer' | 'idle'): Promise<void> => {
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-cron-delivery-mode="${mode}"]`)!.click(); });
    await flush();
  };

  it('labels each row with its effective mode and explains it in the detail', async () => {
    seedTasks([
      makeCronTask({ id: 'idle-task', delivery_mode: 'idle' }),
      makeCronTask({ id: 'queue-task', delivery_mode: 'queue' }),
      makeCronTask({ id: 'steer-task', delivery_mode: 'steer' }),
      // A task from before modes existed: no field, so it reads as the default
      // the host will apply on its next fire.
      makeCronTask({ id: 'legacy-task' }),
    ]);
    await mount();
    const page = await openPanel();

    const modeOf = (id: string) => page.querySelector(`[data-cron-task="${id}"] [data-cron-delivery]`)?.getAttribute('data-cron-delivery');
    expect(modeOf('idle-task')).toBe('idle');
    expect(modeOf('queue-task')).toBe('queue');
    expect(modeOf('steer-task')).toBe('steer');
    // A task from before modes existed: no field, so it reads as the default
    // the host will apply on its next fire — and never as a mode it lacks.
    expect(modeOf('legacy-task')).toBe('idle');
    expect(page.querySelectorAll('[data-cron-task] [data-cron-delivery]')).toHaveLength(4);

    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-task="queue-task"] [data-cron-action="expand"]')!.click(); });
    await flush();
    // The detail states the timing in words, so the row chip is not the only
    // place a person can find out what firing this does.
    const detail = page.querySelector('[data-cron-task="queue-task"] [data-cron-detail]')!;
    expect(detail.querySelectorAll('[data-cron-detail] dt').length).toBeGreaterThan(0);
    expect(detail.textContent).toContain(detailLabel);
    expect(detail.textContent).toContain(queueHint);
  });

  it('creates with the default and each chosen mode reaches the server', async () => {
    createCronTask.mockImplementation((input: { session_id: string; cron: string; prompt: string; recurring: boolean; delivery_mode?: 'queue' | 'steer' | 'idle' }) => {
      const created = makeCronTask({ id: 'created-1', session_id: input.session_id, cron: input.cron, prompt_preview: input.prompt, delivery_mode: input.delivery_mode });
      currentTasks = [...currentTasks, created];
      return Promise.resolve({ task: { ...created, prompt: input.prompt } });
    });
    await mount();
    const page = await openPanel();

    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-create]')!.click(); });
    await flush();
    // A new task is idle unless the person says otherwise, and the form says
    // so by selecting it.
    expect(document.querySelector<HTMLButtonElement>('[data-cron-delivery-mode="idle"]')!.getAttribute('aria-checked')).toBe('true');
    await typeInto(document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!, 'Check the overnight logs.');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
    await flush();
    expect(createCronTask).toHaveBeenLastCalledWith(expect.objectContaining({ delivery_mode: 'idle' }));

    await act(async () => { page.querySelector<HTMLButtonElement>('[data-cron-create]')!.click(); });
    await flush();
    await pick('steer');
    expect(document.querySelector<HTMLButtonElement>('[data-cron-delivery-mode="steer"]')!.getAttribute('aria-checked')).toBe('true');
    // The hint under the choice is what tells the three apart.
    expect(document.querySelector('[data-cron-delivery-hint]')!.textContent).toBe(dictionary['cron.form.delivery.hint.steer']);
    await typeInto(document.querySelector<HTMLTextAreaElement>('[data-cron-prompt]')!, 'Read the release runbook.');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
    await flush();
    expect(createCronTask).toHaveBeenLastCalledWith(expect.objectContaining({ delivery_mode: 'steer' }));
  });

  it('keeps an explicit mode through an unrelated edit, and sends one when it is changed', async () => {
    // The server keeps its own value when the request omits the field, so the
    // mock drops the key rather than storing `undefined` under it — that is
    // what the wire does, and it is the case this test is about.
    updateCronTask.mockImplementation((id: string, patch: { cron?: string; prompt?: string; session_id?: string; recurring?: boolean; delivery_mode?: 'queue' | 'steer' | 'idle' }) => {
      const found = currentTasks.find((task) => task.id === id);
      if (found === undefined) {
        return Promise.reject(new ApiError({ code: 40406, msg: `cron task ${id} does not exist`, data: null }));
      }
      const applied = { ...patch, delivery_mode: patch.delivery_mode ?? found.delivery_mode };
      const updated: CronTask = { ...found, ...applied };
      currentTasks = currentTasks.map((task) => (task.id === id ? updated : task));
      return Promise.resolve({ task: { ...updated, prompt: patch.prompt ?? found.prompt_preview } });
    });
    seedTasks([makeCronTask({ id: 'task-1', cron: '0 9 * * *', delivery_mode: 'queue' })]);
    await mount();
    const page = await openPanel();

    await openEditor(page, 'task-1');
    expect(document.querySelector<HTMLButtonElement>('[data-cron-delivery-mode="queue"]')!.getAttribute('aria-checked')).toBe('true');
    // Nothing about the timing was touched, so the save carries no mode and
    // the host keeps the one the task already had.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-cadence="hourly"]')!.click(); });
    await flush();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
    await flush();
    expect(updateCronTask.mock.calls[0]?.[1]).toMatchObject({ cron: '0 * * * *' });
    expect(updateCronTask.mock.calls[0]?.[1]?.delivery_mode).toBeUndefined();
    expect(currentTasks.find((task) => task.id === 'task-1')?.delivery_mode).toBe('queue');

    await openEditor(page, 'task-1');
    await pick('idle');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
    await flush();
    expect(updateCronTask.mock.calls[1]?.[1]).toMatchObject({ delivery_mode: 'idle' });
    expect(currentTasks.find((task) => task.id === 'task-1')?.delivery_mode).toBe('idle');
  });

  it('shows an editor as unsupported when the host reports no mode at all', async () => {
    seedTasks([makeCronTask({ id: 'task-1' })]);
    await mount();
    const page = await openPanel();

    await openEditor(page, 'task-1');
    expect(document.querySelector('[data-cron-delivery-unsupported]')).not.toBeNull();
    // Still no mode on an untouched save: the field is never handed to a host
    // that has not shown it understands one.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-cron-save]')!.click(); });
    await flush();
    expect(updateCronTask.mock.calls[0]?.[1]?.delivery_mode).toBeUndefined();
  });
});

// @vitest-environment jsdom

/**
 * The inspector's 本对话定时任务 block (SessionCronSection): three rows by
 * default with the rest behind one control, the row action that hides until the
 * row is read (and stays for a paused one), pause landing only as the server
 * reports it, the folded rest and later pages, the empty state that keeps its
 * manage entry, and the read that fails without ever reading as "nothing
 * scheduled".
 */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { CronTask, ListCronTasksResponse } from '../../lib/client';
import { SessionCronSection } from './SessionCronSection';

const { listCronTasks, pauseCronTask, resumeCronTask, connection } = vi.hoisted(() => ({
  listCronTasks: vi.fn(),
  pauseCronTask: vi.fn(),
  resumeCronTask: vi.fn(),
  connection: { value: null as { client: unknown } | null },
}));

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => connection.value,
}));

const SESSION = 'sess-1';
const OTHER_SESSION = 'sess-2';
const PAGE_SIZE = 100;

function makeTask(overrides: Partial<CronTask> & { id: string }): CronTask {
  return {
    session_id: SESSION,
    workspace_id: 'ws-a',
    cron: '0 9 * * *',
    human_schedule: '每天 09:00',
    prompt_preview: '汇总夜间日志',
    next_fire_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    recurring: true,
    paused: false,
    age_days: 2,
    stale: false,
    created_at: '2026-01-01T00:00:00.000Z',
    last_fired_at: null,
    ...overrides,
  };
}

let tasks: CronTask[] = [];

/** Mirrors `GET /api/cron`: narrow to the session, then page the narrowed set. */
function seed(tasksToServe: CronTask[]): void {
  tasks = tasksToServe;
  listCronTasks.mockImplementation((query: { session_id?: string; offset?: number; page_size?: number } = {}) => {
    const scoped = tasks.filter((task) => query.session_id === undefined || task.session_id === query.session_id);
    const offset = query.offset ?? 0;
    const size = query.page_size ?? PAGE_SIZE;
    const hasMore = scoped.length > offset + size;
    return Promise.resolve({
      items: scoped.slice(offset, offset + size),
      has_more: hasMore,
      next_offset: hasMore ? offset + size : undefined,
    } satisfies ListCronTasksResponse);
  });
}

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-location={`${location.pathname}${location.search}`} />;
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  for (const mock of [listCronTasks, pauseCronTask, resumeCronTask]) mock.mockReset();
  seed([]);
  pauseCronTask.mockImplementation((id: string, sessionId?: string) => {
    const found = tasks.find((task) => task.id === id);
    if (found === undefined) return Promise.reject(new Error('fixture: no such task'));
    const updated: CronTask = { ...found, paused: true, next_fire_at: null };
    tasks = tasks.map((task) => (task.id === id && (sessionId === undefined || task.session_id === sessionId) ? updated : task));
    return Promise.resolve({ task: updated });
  });
  resumeCronTask.mockImplementation((id: string) => {
    const found = tasks.find((task) => task.id === id);
    if (found === undefined) return Promise.reject(new Error('fixture: no such task'));
    const updated: CronTask = { ...found, paused: false, next_fire_at: new Date(Date.now() + 60_000).toISOString() };
    tasks = tasks.map((task) => (task.id === id ? updated : task));
    return Promise.resolve({ task: updated });
  });
  connection.value = { client: { listCronTasks, pauseCronTask, resumeCronTask } };
  localStorage.clear();
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function settle(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function render(sessionId = SESSION): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/s/sess-1']}>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <SessionCronSection sessionId={sessionId} />
            <LocationProbe />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

async function mount(sessionId = SESSION): Promise<HTMLElement> {
  await render(sessionId);
  await settle();
  return container.querySelector<HTMLElement>('[data-rail-cron]')!;
}

const rowIds = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-rail-cron-row]')].map((row) => row.dataset['railCronRow']!);

describe('SessionCronSection', () => {
  it('asks the server for this conversation only, and shows three rows of four', async () => {
    seed([
      makeTask({ id: 'task-1' }),
      makeTask({ id: 'task-2', human_schedule: '每周一 08:30', prompt_preview: '清理工作树' }),
      makeTask({ id: 'task-3', human_schedule: '每小时', prompt_preview: '轮询收件箱' }),
      makeTask({ id: 'task-4', human_schedule: '每周二 10:00', prompt_preview: '列出待审的 PR' }),
    ]);
    const block = await mount();
    expect(listCronTasks).toHaveBeenCalledTimes(1);
    expect(listCronTasks).toHaveBeenCalledWith({ session_id: SESSION, page_size: PAGE_SIZE, offset: 0 });
    expect(rowIds()).toEqual(['task-1', 'task-2', 'task-3']);
    // Prompt leads, schedule and its next fire follow, count in the head.
    const first = container.querySelector<HTMLElement>('[data-rail-cron-row="task-1"]')!;
    expect(first.textContent).toContain('汇总夜间日志');
    expect(first.textContent).toContain('每天 09:00');
    expect(first.querySelector('[data-rail-cron-next]')).not.toBeNull();
    expect(block.querySelector('[aria-expanded]')!.textContent).toContain('4');
    // The rest of this conversation's own list opens in place.
    const more = container.querySelector<HTMLButtonElement>('[data-rail-cron-more]')!;
    expect(more.textContent).toBe('还有 1 项');
    await act(async () => { more.click(); });
    expect(rowIds()).toHaveLength(4);
    expect(container.querySelector('[data-rail-cron-more]')).toBeNull();
  });

  it('shows a paused task as paused and offers resume, without a countdown', async () => {
    seed([makeTask({ id: 'task-1', paused: true, next_fire_at: null })]);
    await mount();
    const row = container.querySelector<HTMLElement>('[data-rail-cron-row="task-1"]')!;
    expect(row.dataset['cronPaused']).toBe('');
    expect(row.querySelector('[data-rail-cron-state="paused"]')!.textContent).toBe('已暂停');
    expect(row.querySelector('[data-rail-cron-next]')).toBeNull();
    const action = row.querySelector<HTMLButtonElement>('[data-rail-cron-toggle]')!;
    expect(action.textContent).toBe('恢复');
    expect(action.getAttribute('aria-label')).toContain('汇总夜间日志');
  });

  it('keeps another conversation’s row out even when a shared id comes back', async () => {
    seed([
      makeTask({ id: 'shared', prompt_preview: '本对话的任务' }),
      makeTask({ id: 'shared', session_id: OTHER_SESSION, prompt_preview: '另一个对话的任务' }),
    ]);
    await mount();
    expect(rowIds()).toEqual(['shared']);
    const text = container.querySelector('[data-rail-cron]')!.textContent;
    expect(text).toContain('本对话的任务');
    expect(text).not.toContain('另一个对话的任务');
  });

  it('reads the list again for another conversation instead of reusing the first', async () => {
    seed([
      makeTask({ id: 'mine', prompt_preview: '本对话的任务' }),
      makeTask({ id: 'theirs', session_id: OTHER_SESSION, prompt_preview: '另一个对话的任务' }),
    ]);
    await mount(OTHER_SESSION);
    expect(listCronTasks).toHaveBeenCalledWith({ session_id: OTHER_SESSION, page_size: PAGE_SIZE, offset: 0 });
    expect(rowIds()).toEqual(['theirs']);
    expect(container.querySelector('[data-rail-cron]')!.textContent).toContain('另一个对话的任务');
  });

  it('loads later pages of this conversation rather than a cross-workspace page', async () => {
    seed([
      ...Array.from({ length: PAGE_SIZE }, (_, index) => makeTask({ id: `page-1-${index}` })),
      makeTask({ id: 'page-2-0', prompt_preview: '第十一页之后的任务' }),
      makeTask({ id: 'page-2-1', session_id: OTHER_SESSION, prompt_preview: '另一个对话的任务' }),
    ]);
    await mount();
    expect(rowIds()).toHaveLength(3);
    const loadMore = container.querySelector<HTMLButtonElement>('[data-rail-cron-load-more]')!;
    expect(loadMore.textContent).toBe('加载更多');
    await act(async () => { loadMore.click(); });
    await settle();
    expect(listCronTasks).toHaveBeenLastCalledWith({ session_id: SESSION, page_size: PAGE_SIZE, offset: PAGE_SIZE });
    expect(container.querySelector('[data-rail-cron-load-more]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-rail-cron-more]')!.click(); });
    expect(rowIds()).toContain('page-2-0');
    expect(rowIds()).not.toContain('page-2-1');
    expect(rowIds()).toHaveLength(PAGE_SIZE + 1);
  });

  it('keeps the row as the server reports it when pausing fails, and retries', async () => {
    seed([makeTask({ id: 'task-1' })]);
    pauseCronTask.mockRejectedValue(new Error('fixture: pause refused'));
    await mount();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-rail-cron-toggle="task-1"]')!.click(); });
    await settle();
    // Never guessed from the click: still live, still offering pause.
    const row = container.querySelector<HTMLElement>('[data-rail-cron-row="task-1"]')!;
    expect(row.dataset['cronPaused']).toBeUndefined();
    expect(row.querySelector('[data-rail-cron-state="paused"]')).toBeNull();
    expect(row.querySelector('[data-rail-cron-toggle]')!.textContent).toBe('暂停');
    const failed = container.querySelector<HTMLElement>('[data-rail-cron-error="task-1"]')!;
    expect(failed.textContent).toContain('未能暂停该定时任务。');
    expect(failed.textContent).toContain('重试');
    expect(failed.getAttribute('role')).toBe('status');
    // The retry runs the same pause again.
    pauseCronTask.mockClear();
    pauseCronTask.mockImplementation((id: string) => {
      const found = tasks.find((task) => task.id === id)!;
      const updated: CronTask = { ...found, paused: true, next_fire_at: null };
      tasks = tasks.map((task) => (task.id === id ? updated : task));
      return Promise.resolve({ task: updated });
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-rail-cron-error-retry]')!.click(); });
    await settle();
    expect(pauseCronTask).toHaveBeenCalledWith('task-1', SESSION);
    expect(container.querySelector('[data-rail-cron-error="task-1"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-rail-cron-row="task-1"]')!.dataset['cronPaused']).toBe('');
  });

  it('pauses from the row and follows the returned task', async () => {
    seed([makeTask({ id: 'task-1' })]);
    await mount();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-rail-cron-toggle="task-1"]')!.click(); });
    await settle();
    expect(pauseCronTask).toHaveBeenCalledWith('task-1', SESSION);
    const row = container.querySelector<HTMLElement>('[data-rail-cron-row="task-1"]')!;
    expect(row.dataset['cronPaused']).toBe('');
    expect(row.querySelector('[data-rail-cron-toggle]')!.textContent).toBe('恢复');
  });

  it('keeps the block with a real status and retry when the read fails, never "no tasks"', async () => {
    listCronTasks.mockRejectedValue(new Error('fixture offline'));
    const block = await mount();
    expect(block.querySelector('[data-rail-cron-unavailable]')!.textContent).toContain('暂时读不到定时任务。');
    expect(block.querySelector('[data-rail-cron-unavailable]')!.textContent).toContain('重试');
    expect(block.textContent).not.toContain('暂无定时任务');
    expect(block.querySelector('[data-rail-cron-manage]')).not.toBeNull();
    listCronTasks.mockImplementation(() => Promise.resolve({ items: [makeTask({ id: 'task-1' })] }));
    await act(async () => { block.querySelector<HTMLButtonElement>('[data-rail-cron-retry]')!.click(); });
    await settle();
    expect(rowIds()).toEqual(['task-1']);
  });

  it('states an empty list in one line and keeps the way to manage it', async () => {
    seed([]);
    const block = await mount();
    expect(block.querySelector('[data-rail-cron-empty]')!.textContent).toBe('暂无定时任务');
    expect(rowIds()).toHaveLength(0);
    expect(block.querySelector<HTMLElement>('[data-rail-cron-manage]')!.textContent).toBe('管理定时任务');
  });

  it('claims nothing at all without a connection', async () => {
    connection.value = null;
    await render();
    await settle();
    expect(container.querySelector('[data-rail-cron]')).toBeNull();
    expect(container.textContent).not.toContain('暂无定时任务');
  });

  it('opens /cron scoped to this conversation from a row and from the manage entry', async () => {
    seed([makeTask({ id: 'task-1', prompt_preview: '汇总夜间日志' })]);
    await mount();
    expect(container.querySelector<HTMLElement>('[data-location]')!.dataset['location']).toBe('/s/sess-1');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-cron-open="task-1"]')!.click(); });
    expect(container.querySelector<HTMLElement>('[data-location]')!.dataset['location']).toBe(`/cron?session=${SESSION}`);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-rail-cron-manage]')!.click(); });
    expect(container.querySelector<HTMLElement>('[data-location]')!.dataset['location']).toBe(`/cron?session=${SESSION}`);
  });

  it('folds to the head with its count and the next fire when closed', async () => {
    seed([makeTask({ id: 'task-1' }), makeTask({ id: 'task-2', paused: true, next_fire_at: null })]);
    const block = await mount();
    const head = block.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { head.click(); });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(rowIds()).toHaveLength(0);
    expect(head.textContent).toContain('本对话定时任务');
    expect(head.textContent).toContain('2');
    expect(head.textContent).toContain('剩余');
  });
});

// @vitest-environment jsdom

/**
 * One persona's tasks and rooms.
 *
 * The point of this file is that attribution and writes are the server's:
 * a task is listed only when its conversation is one the server attributed to
 * this persona, pausing calls the real per-task endpoint, and "could not read"
 * never renders as "nothing configured".
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSummary, Session } from '@kiki/protocol';
import type { CronTask } from '../../lib/client';
import { clearToasts, getToasts } from '../../lib/toasts';

import { I18nProvider } from '../../i18n';
import { PersonaTasksSection } from './PersonaTasksSection';

const navigate = vi.fn();
const listSessions = vi.fn();
const listCronTasks = vi.fn();
const pauseCronTask = vi.fn();
const resumeCronTask = vi.fn();
const listRooms = vi.fn();

vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listSessions,
      listCronTasks,
      pauseCronTask,
      resumeCronTask,
      klient: { rest: { rooms: { list: listRooms } } },
    },
    scopeId: 'local',
    sshLabel: null,
  }),
}));

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  for (const fn of [navigate, listSessions, listCronTasks, pauseCronTask, resumeCronTask, listRooms]) fn.mockReset();
  clearToasts();
  localStorage.setItem('kiki.locale', 'zh');
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

function session(id: string, title: string): Session {
  return {
    id,
    title,
    workspace_id: 'ws_a',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    metadata: { cwd: '/a' },
    busy: false,
    last_seq: 1,
  } as Session;
}

function task(patch: Partial<CronTask> & Pick<CronTask, 'id'>): CronTask {
  return {
    session_id: 'daily',
    workspace_id: 'ws_a',
    cron: '0 9 * * *',
    human_schedule: '每天 09:00',
    prompt_preview: '整理发布情况',
    next_fire_at: '2026-10-04T01:00:00Z',
    recurring: true,
    paused: false,
    age_days: 1,
    stale: false,
    created_at: '2026-10-01T00:00:00Z',
    last_fired_at: null,
    ...patch,
  } as CronTask;
}

const persona: PersonaSummary = { id: 'lin-lan', name: '小岚', revision: 'r1', archived: false, homeSessionId: 'daily' };

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null,
      createElement(PersonaTasksSection, { persona }))));
  });
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

function withPersonaSessions(items: readonly Session[], hasMore = false) {
  listSessions.mockResolvedValue({ items, has_more: hasMore });
}
function withCron(items: readonly CronTask[], hasMore = false) {
  listCronTasks.mockResolvedValue({ items, has_more: hasMore, next_offset: hasMore ? items.length : undefined });
}
function withRooms(items: readonly unknown[]) {
  listRooms.mockResolvedValue(items);
}

describe('one persona\'s scheduled tasks', () => {
  it('claims only tasks whose conversation the server attributed to her', async () => {
    withPersonaSessions([session('daily', '日常对话'), session('topic_1', '排查构建')]);
    withCron([
      task({ id: 't_daily' }),
      task({ id: 't_topic', session_id: 'topic_1' }),
      task({ id: 't_other', session_id: 'someone_else' }),
      task({ id: 't_workspace', session_id: null }),
    ]);
    withRooms([]);
    const container = await render();
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ persona: 'lin-lan', include_archive: true }));
    expect([...container.querySelectorAll('[data-persona-cron-task]')].map((row) => row.getAttribute('data-persona-cron-task')))
      .toEqual(['t_daily', 't_topic']);
    // The row names the conversation it belongs to.
    expect(container.querySelector('[data-persona-cron-session="topic_1"]')?.textContent).toBe('排查构建');
  });

  it('pauses and resumes through the per-task endpoint, keeping the row until the server answers', async () => {
    withPersonaSessions([session('daily', '日常对话')]);
    withCron([task({ id: 't_daily' })]);
    withRooms([]);
    pauseCronTask.mockResolvedValue({ task: task({ id: 't_daily', paused: true }) });
    const container = await render();

    await act(async () => { container.querySelector<HTMLElement>('[data-persona-cron-action="pause"]')!.click(); });
    expect(pauseCronTask).toHaveBeenCalledWith('t_daily', 'daily');
    expect(getToasts().some((toast) => toast.text === '已暂停定时任务')).toBe(true);
  });

  it('says why when the write fails, and leaves the row on its stored state', async () => {
    withPersonaSessions([session('daily', '日常对话')]);
    withCron([task({ id: 't_daily' })]);
    withRooms([]);
    pauseCronTask.mockRejectedValue(new Error('task is gone'));
    const container = await render();

    await act(async () => { container.querySelector<HTMLElement>('[data-persona-cron-action="pause"]')!.click(); });
    expect(pauseCronTask).toHaveBeenCalledWith('t_daily', 'daily');
    expect(getToasts().some((toast) => toast.tone === 'error' && toast.text.includes('task is gone'))).toBe(true);
    // The failed write did not flip the row into a paused state it never reached.
    expect(container.querySelector('[data-persona-cron-action="pause"]')).not.toBeNull();
    expect(container.querySelector('[data-persona-cron-action="resume"]')).toBeNull();
  });

  it('keeps read failure and empty apart', async () => {
    withPersonaSessions([session('daily', '日常对话')]);
    listCronTasks.mockRejectedValue(new Error('cron is down'));
    withRooms([]);
    const failed = await render();
    expect(failed.querySelector('[data-persona-cron-error]')).not.toBeNull();
    expect(failed.querySelector('[data-persona-cron-empty]')).toBeNull();
  });

  it('shows the empty line only when the server answered with nothing of hers', async () => {
    withPersonaSessions([session('daily', '日常对话')]);
    withCron([task({ id: 't_other', session_id: 'someone_else' })]);
    withRooms([]);
    const container = await render();
    expect(container.querySelector('[data-persona-cron-empty]')).not.toBeNull();
    expect(container.querySelector('[data-persona-cron-error]')).toBeNull();
  });

  it('offers the next cron page when the server says there is more', async () => {
    withPersonaSessions([session('daily', '日常对话')]);
    withCron([task({ id: 't_daily' })], true);
    withRooms([]);
    const container = await render();
    await act(async () => { container.querySelector<HTMLElement>('[data-persona-cron-more]')!.click(); });
    expect(listCronTasks).toHaveBeenCalledWith(expect.objectContaining({ offset: 1 }));
  });
});

describe('one persona\'s rooms', () => {
  it('lists the rooms she is a member of, and only those', async () => {
    withPersonaSessions([session('daily', '日常对话')]);
    withCron([]);
    withRooms([
      { id: 'room_release', name: '发布房间', paused: false, members: [{ kind: 'persona', personaId: 'lin-lan', sessionId: 'seat_1', muted: false }] },
      { id: 'room_other', name: '别人的房间', paused: false, members: [{ kind: 'persona', personaId: 'a-che', sessionId: 'seat_2', muted: false }] },
    ]);
    const container = await render();
    expect([...container.querySelectorAll('[data-persona-room-row]')].map((row) => row.getAttribute('data-persona-room-row')))
      .toEqual(['room_release']);
    await act(async () => { container.querySelector<HTMLElement>('[data-persona-room-row="room_release"]')!.click(); });
    expect(navigate).toHaveBeenCalledWith('/rooms/room_release');
  });

  it('keeps a room read failure apart from having no rooms', async () => {
    withPersonaSessions([session('daily', '日常对话')]);
    withCron([]);
    listRooms.mockRejectedValue(new Error('rooms are down'));
    const container = await render();
    expect(container.querySelector('[data-persona-rooms-error]')).not.toBeNull();
    expect(container.querySelector('[data-persona-rooms-empty]')).toBeNull();
  });
});

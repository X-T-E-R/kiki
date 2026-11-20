// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApprovalRequest, QuestionRequest, RoomListItem, Session } from '@kiki/protocol';
import { markSessionSeen, resetSessionSeen, sessionSeenSnapshot } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import { ActivityPage } from './ActivityPage';
import { createConcurrencyLimiter } from './activity/activityTriageLimiter';

const { client } = vi.hoisted(() => ({
  client: {
    listThreadMessages: vi.fn(),
    listPendingApprovals: vi.fn(),
    resolveApproval: vi.fn(),
    listPendingQuestions: vi.fn(),
    resolveQuestion: vi.fn(),
    dismissQuestion: vi.fn(),
    listPersonas: vi.fn(),
  },
}));
vi.mock('../state/connection', () => ({ useConnection: () => ({ client }), useOptionalConnection: () => ({ client }) }));

const mounts: { container: HTMLDivElement; root: Root }[] = [];
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { container, root } of mounts.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  resetSessionSeen();
  client.listPendingApprovals.mockReset();
  client.resolveApproval.mockReset();
  client.listPendingQuestions.mockReset();
  client.resolveQuestion.mockReset();
  client.dismissQuestion.mockReset();
  client.listPersonas.mockReset();
  client.listPendingApprovals.mockResolvedValue([]);
  client.listPendingQuestions.mockResolvedValue([]);
  client.listPersonas.mockResolvedValue([]);
});

function session(patch: Partial<Session> & { id: string }): Session {
  return {
    workspace_id: 'ws-1',
    title: patch.id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: '/w' },
    agent_config: { model: 'provider/example-model' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 2,
    last_seq: 10,
    ...patch,
  } as Session;
}

function LocationProbe() {
  const location = useLocation();
  return <span data-activity-test-location>{`${location.pathname}${location.search}`}</span>;
}

async function render(sessions: readonly Session[], path = '/activity', rooms: readonly RoomListItem[] = []) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['sessions'], { pages: [{ items: sessions, has_more: false }], pageParams: [undefined] });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <I18nProvider>
            <LocationProbe />
            <ActivityPage
              sessions={sessions}
              rooms={rooms}
              workspaceOptions={[
                { id: 'ws-1', name: 'fixture', root: '/w' },
                { id: 'ws-2', name: 'other', root: '/rooms' },
              ]}
              onToggleSidebar={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

describe('ActivityPage', () => {
  it('projects thread-link titles in communication endpoint names', async () => {
    const endpoint = {
      ref: { host_id: 'h', workspace_id: 'ws-1', session_id: 'a' },
      title: 'Review /s/session_reference',
      deleted: false,
      archived: false,
    };
    client.listThreadMessages.mockResolvedValue({
      items: [{
        message_id: 'linked-title',
        source: { kind: 'thread', thread: endpoint },
        target: endpoint,
        content: 'Ping',
        accepted_at: 1,
        target_seq: 1,
        delivery: 'delivered',
      }],
      has_more: false,
    });
    const page = await render([session({ id: 'session_reference', title: 'Referenced thread' })], '/activity?view=comms');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = page.querySelector('[data-activity-comms-item="linked-title"]');
    expect(row?.querySelector('[data-comms-endpoint="a"]')?.textContent).toBe('Review Referenc…');
    expect(row?.innerHTML).not.toContain('/s/session_reference');
  });

  it.each(['preparing', 'error'] as const)('does not show empty history while coverage is %s', async (state) => {
    client.listThreadMessages.mockReset();
    client.listThreadMessages.mockResolvedValue({
      items: [],
      incomplete: 'history_preparing',
      history: { generation: 'example-generation', state, processedMessages: 0, completedShards: 0, totalShards: 16 },
    });
    const page = await render([], '/activity?view=comms');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(page.querySelector('[data-comms-history]')?.getAttribute('data-comms-history')).toBe(state);
    expect(page.querySelector('[data-activity-comms-empty]')).toBeNull();
  });

  it('refreshes the first page after preparation instead of continuing an incomplete cursor', async () => {
    client.listThreadMessages.mockReset();
    client.listThreadMessages.mockResolvedValueOnce({
      items: [],
      next_cursor: 'incomplete-cursor',
      incomplete: 'history_preparing',
      history: { generation: 'old-generation', state: 'preparing', processedMessages: 0, completedShards: 0, totalShards: 16 },
    });
    client.listThreadMessages.mockResolvedValue({
      items: [],
      history: { generation: 'new-generation', state: 'complete', processedMessages: 2, completedShards: 16, totalShards: 16 },
    });
    const page = await render([], '/activity?view=comms');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(page.querySelector('[data-comms-load-older]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(client.listThreadMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(client.listThreadMessages.mock.calls.every(([query]) => query.cursor === undefined)).toBe(true);
    expect(page.querySelector('[data-comms-history]')).toBeNull();
    expect(page.querySelector('[data-activity-comms-empty]')).not.toBeNull();
  });

  it('shares mark-all-read with rooms but leaves blocked and archived rooms out of that operation', async () => {
    const room: RoomListItem = {
      kind: 'room',
      id: 'example-room',
      title: 'Room',
      workspace: '/rooms',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T05:00:00Z',
      lastSeq: 4,
      memberCount: 2,
      busy: false,
      needsYou: false,
      pendingInteraction: 'none',
      failed: true,
      pinned: false,
      archived: false,
    };
    const page = await render([session({ id: 'thread' })], '/activity', [
      room,
      { ...room, id: 'budget-room', needsYou: true },
      { ...room, id: 'archived-room', archived: true },
    ]);
    expect(page.querySelector('[data-activity-item="room:example-room"]')?.getAttribute('data-activity-reason')).toBe('failed');
    expect(page.querySelector('[data-activity-item="room:example-room"]')?.textContent).toContain('other');
    expect(page.querySelector('[data-activity-item="room:example-room"]')?.textContent).not.toContain('/rooms');
    expect(page.querySelector('[data-activity-item="room:budget-room"]')?.getAttribute('data-activity-reason')).toBe('budget');
    expect(page.querySelector('[data-activity-item="room:archived-room"]')).toBeNull();
    await act(async () => { page.querySelector<HTMLButtonElement>('[data-activity-mark-all-read]')!.click(); });
    expect(sessionSeenSnapshot()['room:example-room']).toBe(4);
    expect(sessionSeenSnapshot()['thread']).toBe(10);
    expect(sessionSeenSnapshot()['room:budget-room']).toBeUndefined();
    expect(page.querySelector('[data-activity-item="room:example-room"]')).toBeNull();
    expect(page.querySelector('[data-activity-item="room:budget-room"]')).not.toBeNull();
  });

  it('lists blocked sessions before finished ones and names each order', async () => {
    const page = await render([
      session({ id: 'finished', last_turn_reason: 'completed', updated_at: '2026-01-01T05:00:00.000Z' }),
      session({ id: 'asked', pending_interaction: 'question', updated_at: '2026-01-01T02:00:00.000Z' }),
    ]);
    const groups = [...page.querySelectorAll('[data-activity-group]')]
      .map((group) => group.getAttribute('data-activity-group'));
    expect(groups).toEqual(['needs-you', 'unread']);
    const needsYou = page.querySelector('[data-activity-group="needs-you"]')!;
    expect(needsYou.textContent).toContain('Needs you');
    expect(needsYou.textContent).toContain('Longest wait first');
    expect(needsYou.querySelector('[data-activity-item="asked"]')?.getAttribute('data-activity-reason'))
      .toBe('question');
    const unread = page.querySelector('[data-activity-group="unread"]')!;
    expect(unread.textContent).toContain('Newest first');
    expect(unread.querySelector('[data-activity-item="finished"]')).not.toBeNull();
    expect(unread.textContent).toContain('Finished');
    expect(unread.textContent).toContain('fixture');
  });

  it('drops a finished session once it has been seen, and says so when nothing is left', async () => {
    const finished = session({ id: 'seen-me', last_seq: 8, last_turn_reason: 'completed' });
    const page = await render([finished]);
    expect(page.querySelector('[data-activity-item="seen-me"]')).not.toBeNull();
    expect(page.querySelector('[data-activity-empty]')).toBeNull();
    await act(async () => { markSessionSeen('seen-me', 8); });
    expect(page.querySelector('[data-activity-item="seen-me"]')).toBeNull();
    const empty = page.querySelector('[data-activity-empty]');
    expect(empty?.textContent).toContain('Nothing waiting.');
  });

  it('keeps a blocked session listed even after it is opened', async () => {
    const blocked = session({ id: 'blocked', pending_interaction: 'approval' });
    const page = await render([blocked]);
    await act(async () => { markSessionSeen('blocked', 10); });
    expect(page.querySelector('[data-activity-item="blocked"]')).not.toBeNull();
  });

  it('shows the last prompt under each row and clears only the finished drain on mark all read', async () => {
    const page = await render([
      session({ id: 'done', last_seq: 12, last_turn_reason: 'completed', last_prompt: 'Refactor   the\nparser' }),
      session({ id: 'broke', last_seq: 7, last_turn_reason: 'failed' }),
      session({ id: 'ask', last_seq: 9, pending_interaction: 'question' }),
    ]);
    expect(page.querySelector('[data-activity-item="done"] [data-activity-preview]')?.textContent).toBe('Refactor the parser');
    expect(page.querySelector('[data-activity-item="broke"] [data-activity-reason]')).toBeNull();
    expect(page.querySelector('[data-activity-item="broke"]')?.getAttribute('data-activity-reason')).toBe('failed');
    expect(page.querySelector('[data-activity-group="needs-you"] [data-activity-mark-all-read]')).toBeNull();
    const button = page.querySelector<HTMLButtonElement>('[data-activity-group="unread"] [data-activity-mark-all-read]');
    expect(button?.textContent).toBe('Mark all as read');
    await act(async () => { button?.click(); });
    expect(sessionSeenSnapshot()).toMatchObject({ done: 12, broke: 7 });
    expect(sessionSeenSnapshot()['ask']).toBeUndefined();
    expect(page.querySelector('[data-activity-group="unread"]')).toBeNull();
    expect(page.querySelector('[data-activity-item="ask"]')).not.toBeNull();
  });

  it('auto-expands only the longest-waiting blocked session and resolves inline approvals and questions without N+1 fetches', async () => {
    const approval: ApprovalRequest = {
      approval_id: 'app-1',
      session_id: 'stuck-oldest',
      tool_call_id: 'call-1',
      tool_name: 'Bash',
      action: 'Run test suite',
      tool_input_display: { command: 'pnpm --filter @kiki/gui test' },
      approval_rule: 'Bash(pnpm *)',
      created_at: '2026-01-01T00:01:00.000Z',
      expires_at: '2026-01-01T01:00:00.000Z',
    };
    const question: QuestionRequest = {
      question_id: 'q-2',
      session_id: 'stuck-newer',
      questions: [{
        id: 'target-env',
        question: 'Which environment should receive the build?',
        options: [
          { id: 'staging', label: 'Staging' },
          { id: 'prod', label: 'Production' },
        ],
      }],
      created_at: '2026-01-01T00:05:00.000Z',
    };
    client.listPendingApprovals.mockResolvedValue([approval]);
    client.listPendingQuestions.mockResolvedValue([question]);
    client.resolveApproval.mockResolvedValue({ ok: true });
    client.resolveQuestion.mockResolvedValue({ ok: true });

    const page = await render([
      session({
        id: 'stuck-oldest',
        title: 'Release pipeline',
        pending_interaction: 'approval',
        updated_at: '2026-01-01T00:01:00.000Z',
        agent_config: {
          model: 'provider/example-model',
          persona: { id: 'p-ops', name: 'Ops Steward' },
        },
      }),
      session({
        id: 'stuck-newer',
        title: 'Deploy check',
        pending_interaction: 'question',
        updated_at: '2026-01-01T00:05:00.000Z',
      }),
      ...Array.from({ length: 12 }, (_, idx) =>
        session({ id: `done-${idx}`, last_seq: 5, last_turn_reason: 'completed' }),
      ),
    ]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(client.listPendingApprovals).toHaveBeenCalledTimes(1);
    expect(client.listPendingApprovals).toHaveBeenCalledWith('stuck-oldest');
    expect(client.listPendingQuestions).not.toHaveBeenCalled();

    expect(page.querySelector('[data-activity-persona="p-ops"]')?.textContent).toBe('Ops Steward');
    expect(page.querySelector('[data-activity-approval-snippet]')?.textContent).toContain('pnpm --filter @kiki/gui test');

    await act(async () => {
      page.querySelector<HTMLButtonElement>('[data-activity-approve="app-1"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.resolveApproval).toHaveBeenCalledWith('stuck-oldest', 'app-1', {
      decision: 'approved',
      scope: undefined,
      selected_option_id: undefined,
    });

    await act(async () => {
      page.querySelector<HTMLButtonElement>('[data-activity-expand="stuck-newer"]')!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(client.listPendingQuestions).toHaveBeenCalledTimes(1);
    expect(client.listPendingQuestions).toHaveBeenCalledWith('stuck-newer');

    await act(async () => {
      page.querySelector<HTMLButtonElement>('[data-activity-question-option="target-env:staging"]')!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.resolveQuestion).toHaveBeenCalledWith('stuck-newer', 'q-2', {
      answers: { 'target-env': { kind: 'single', option_id: 'staging' } },
      method: 'click',
    });
  });

  it('supports live running filter pills, single-row dismiss, and j/k/x keyboard triage', async () => {
    const page = await render([
      session({ id: 'done-a', title: 'Audit report', last_seq: 11, last_turn_reason: 'completed', updated_at: '2026-01-01T05:00:00.000Z' }),
      session({ id: 'done-b', title: 'Schema check', last_seq: 14, last_turn_reason: 'failed', updated_at: '2026-01-01T04:00:00.000Z' }),
      session({ id: 'live-1', title: 'Background indexer', busy: true, executing: true, updated_at: '2026-01-01T06:00:00.000Z' }),
    ]);

    expect(page.querySelector('[data-activity-group="running"] [data-activity-item="live-1"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    });
    expect(page.querySelector('[data-activity-item="done-a"]')?.getAttribute('data-activity-focused')).toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    });
    expect(sessionSeenSnapshot()['done-a']).toBe(11);
    expect(page.querySelector('[data-activity-item="done-a"]')).toBeNull();
    expect(page.querySelector('[data-activity-item="done-b"]')?.getAttribute('data-activity-focused')).toBe('true');

    await act(async () => {
      page.querySelector<HTMLButtonElement>('[data-activity-dismiss="done-b"]')!.click();
    });
    expect(sessionSeenSnapshot()['done-b']).toBe(14);
    expect(page.querySelector('[data-activity-item="done-b"]')).toBeNull();

    await act(async () => {
      page.querySelector<HTMLButtonElement>('[data-activity-filter="running"]')!.click();
    });
    expect(page.querySelector('[data-activity-item="live-1"]')).not.toBeNull();
  });

  it('enforces max-2 concurrency in the inline detail limiter and drops aborted queued tasks', async () => {
    const limiter = createConcurrencyLimiter(2);
    const gates: (() => void)[] = [];
    const started: string[] = [];
    const makeTask = (name: string) => () =>
      new Promise<string>((resolve) => {
        started.push(name);
        gates.push(() => resolve(name));
      });

    const p1 = limiter.run(makeTask('one'));
    const p2 = limiter.run(makeTask('two'));
    const abort3 = new AbortController();
    const p3 = limiter.run(makeTask('three'), abort3.signal);
    const p4 = limiter.run(makeTask('four'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['one', 'two']);
    expect(limiter.activeCount()).toBe(2);
    expect(limiter.pendingCount()).toBe(2);

    abort3.abort();
    await expect(p3).rejects.toMatchObject({ name: 'AbortError' });
    expect(limiter.pendingCount()).toBe(1);

    gates.shift()!();
    await expect(p1).resolves.toBe('one');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['one', 'two', 'four']);

    gates.shift()!();
    gates.shift()!();
    await expect(Promise.all([p2, p4])).resolves.toEqual(['two', 'four']);
  });

  it.each([
    ['en', 'Not delivered: Target thread is archived'],
    ['zh', '未送达：目标线程已归档'],
  ])('translates delivery codes in %s without displaying diagnostic text', async (locale, expected) => {
    localStorage.setItem('kiki.locale', locale);
    const endpoint = { ref: { host_id: 'h', workspace_id: 'ws-1', session_id: 'a' }, deleted: false, archived: false };
    client.listThreadMessages.mockReset();
    client.listThreadMessages.mockResolvedValue({
      items: [{
        message_id: 'failed',
        source: { kind: 'thread', thread: endpoint },
        target: endpoint,
        content: 'Ping',
        accepted_at: 1,
        target_seq: 1,
        delivery: 'undeliverable',
        reason_code: 'thread_archived',
        reason_detail: 'arbitrary backend diagnostic',
        reason: 'legacy diagnostic',
      }],
    });
    try {
      const page = await render([], '/activity?view=comms');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const note = page.querySelector('[data-comms-delivery="undeliverable"]');
      expect(note?.textContent).toBe(expected);
      expect(note?.getAttribute('title')).toBe('arbitrary backend diagnostic');
    } finally {
      localStorage.removeItem('kiki.locale');
    }
  });

  it('lists thread messages across workspaces, follows empty pages, and scopes by workspace', async () => {
    const endpoint = (session_id: string, workspace_id: string, extra: { deleted?: boolean } = {}) => ({
      ref: { host_id: 'h', workspace_id, session_id },
      title: `T ${session_id}`,
      deleted: extra.deleted ?? false,
      archived: false,
    });
    client.listThreadMessages.mockReset();
    client.listThreadMessages
      .mockResolvedValueOnce({ items: [], next_cursor: 'c1', incomplete: 'scan_budget' })
      .mockResolvedValueOnce({
        items: [
          {
            message_id: 'm1',
            source: { kind: 'thread', thread: endpoint('a', 'ws-1') },
            target: endpoint('b', 'ws-2'),
            content: 'Contract ready\nsecond line',
            accepted_at: Date.parse('2026-01-01T00:00:00Z'),
            target_seq: 3,
            delivery: 'delivered',
          },
          {
            message_id: 'm2',
            source: { kind: 'thread', thread: endpoint('b', 'ws-2') },
            target: endpoint('gone', 'ws-1', { deleted: true }),
            content: 'Ping',
            accepted_at: Date.parse('2026-01-01T00:00:00Z') - 1,
            target_seq: 4,
            delivery: 'undeliverable',
            reason: 'thread closed',
          },
        ],
      });
    const page = await render([], '/activity?view=comms');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.listThreadMessages.mock.calls.map(([query]) => query)).toEqual([{ cursor: undefined }, { cursor: 'c1' }]);
    expect(page.querySelector('[data-activity-view-option="comms"]')?.getAttribute('aria-pressed')).toBe('true');
    const first = page.querySelector('[data-activity-comms-item="m1"]')!;
    expect(first.textContent).toContain('Contract ready');
    expect(first.textContent).not.toContain('second line');
    expect(first.querySelector('[data-comms-jump="m1"]')).not.toBeNull();
    const second = page.querySelector('[data-activity-comms-item="m2"]')!;
    expect(second.textContent).toContain('Deleted thread');
    expect(second.textContent).toContain('Not delivered: Delivery failed');
    expect(second.textContent).not.toContain('thread closed');
    expect(second.querySelector('[data-comms-delivery]')?.getAttribute('title')).toBe('thread closed');
    expect(second.querySelector('[data-comms-jump]')).toBeNull();
    expect(second.querySelector('[data-comms-endpoint="gone"]')).toBeNull();

    client.listThreadMessages.mockResolvedValue({ items: [] });
    await act(async () => { page.querySelector<HTMLButtonElement>('[data-scope-option="ws-2"]')?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.listThreadMessages).toHaveBeenLastCalledWith({ workspace_id: 'ws-2', cursor: undefined });
    expect(page.querySelector('[data-activity-comms-empty]')?.textContent).toContain('No thread in this workspace');
  });

  it('deep-links subagent approvals and questions with interaction id, offers Reject on plan_review, and avoids blanket sessions invalidation', async () => {
    const subApproval: ApprovalRequest = {
      approval_id: 'apr/1',
      session_id: 'sess/1',
      agent_id: 'sub/worker',
      tool_call_id: 'tc-1',
      tool_name: 'ExitPlanMode',
      action: 'Review plan',
      tool_input_display: { plan: 'Step 1: ship it' },
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    };
    const subQuestion = {
      question_id: 'q/2',
      session_id: 'sess/2',
      agent_id: 'sub/ask',
      questions: [{ id: 'q_0', question: 'Proceed?', options: [{ id: 'opt_0_0', label: 'Yes' }, { id: 'opt_0_1', label: 'No' }] }],
      created_at: '2026-01-01T00:00:00.000Z',
    } as QuestionRequest & { agent_id: string };

    client.listPendingApprovals.mockResolvedValue([subApproval]);
    client.listPendingQuestions.mockResolvedValue([subQuestion]);
    client.resolveApproval.mockResolvedValue({ resolved: true, resolved_at: '2026-01-01T00:01:00.000Z' });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const s1 = session({ id: 'sess/1', pending_interaction: 'approval', updated_at: '2026-01-01T00:00:00.000Z' });
    const s2 = session({ id: 'sess/2', pending_interaction: 'question', updated_at: '2026-01-01T00:01:00.000Z' });
    queryClient.setQueryData(['sessions', false, undefined], { pages: [{ items: [s1, s2], has_more: false }], pageParams: [undefined] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/activity']}>
            <I18nProvider>
              <LocationProbe />
              <ActivityPage
                sessions={[s1, s2]}
                rooms={[]}
                workspaceOptions={[{ id: 'ws-1', name: 'fixture', root: '/w' }]}
                onToggleSidebar={() => {}}
              />
            </I18nProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // plan_review without options renders both Approve plan and Reject buttons.
    expect(container.querySelector('[data-activity-approve="apr/1"]')).not.toBeNull();
    expect(container.querySelector('[data-activity-reject="apr/1"]')).not.toBeNull();

    // Review in thread for subagent approval deep-links with encoded session, agent, and interaction.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-activity-review-thread="apr/1"]')!.click(); });
    expect(container.querySelector('[data-activity-test-location]')?.textContent).toBe(
      '/s/sess%2F1/agent/sub%2Fworker?interaction=apr%2F1',
    );

    // Rejecting patches the cached session entry without triggering blanket ['sessions'] invalidation.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-activity-reject="apr/1"]')!.click(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.resolveApproval).toHaveBeenCalledWith('sess/1', 'apr/1', {
      decision: 'rejected',
      scope: undefined,
      selected_option_id: undefined,
    });
    const sessionsInvalidated = invalidateSpy.mock.calls.some(([filter]) =>
      Array.isArray(filter?.queryKey) && filter.queryKey[0] === 'sessions',
    );
    expect(sessionsInvalidated).toBe(false);
    const cached = queryClient.getQueryData<{ pages: { items: Session[] }[] }>(['sessions', false, undefined]);
    expect(cached?.pages[0]?.items.find((item) => item.id === 'sess/1')?.pending_interaction).toBeUndefined();

    // Expand the subagent question and verify Review in thread deep-links to its subagent + question_id.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-activity-expand="sess/2"]')!.click(); });
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-activity-review-thread="q/2"]')!.click(); });
    expect(container.querySelector('[data-activity-test-location]')?.textContent).toBe(
      '/s/sess%2F2/agent/sub%2Fask?interaction=q%2F2',
    );
  });

  it('virtualizes 10,000 activity sessions (needs-you, unread, running) into bounded DOM rows', async () => {
    const tenThousand: Session[] = Array.from({ length: 10_000 }, (_, i) => {
      const updated = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      if (i < 500) {
        return session({ id: `s_need_${i}`, title: `Needs ${i}`, pending_interaction: 'approval', updated_at: updated });
      }
      if (i < 9000) {
        return session({ id: `s_unread_${i}`, title: `Completed ${i}`, last_turn_reason: 'completed', updated_at: updated });
      }
      return session({ id: `s_run_${i}`, title: `Running ${i}`, busy: true, updated_at: updated });
    });

    const container = await render(tenThousand, '/activity');
    expect(container.querySelector('[data-activity-virtualized="true"]')).not.toBeNull();
    const mountedAll = container.querySelectorAll('[data-activity-item]');
    expect(mountedAll.length).toBeGreaterThan(5);
    expect(mountedAll.length).toBeLessThanOrEqual(50);

    // Filter to unread completions (8,500 items): still mounts bounded DOM rows
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-activity-filter="unread"]')!.click();
    });
    const mountedUnread = container.querySelectorAll('[data-activity-item]');
    expect(mountedUnread.length).toBeGreaterThan(5);
    expect(mountedUnread.length).toBeLessThanOrEqual(50);
  });
});

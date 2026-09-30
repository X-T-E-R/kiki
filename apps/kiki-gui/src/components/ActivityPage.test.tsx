// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';
import { markSessionSeen, resetSessionSeen, sessionSeenSnapshot } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import { ActivityPage } from './ActivityPage';

const { client } = vi.hoisted(() => ({ client: { listThreadMessages: vi.fn() } }));
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
});

function session(patch: Partial<Session> & { id: string }): Session {
  return {
    workspace_id: 'ws-1',
    title: patch.id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: '/w' },
    agent_config: {},
    usage: {},
    permission_rules: [],
    message_count: 2,
    last_seq: 10,
    ...patch,
  } as Session;
}

async function render(sessions: readonly Session[], path = '/activity') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
          <ActivityPage
            sessions={sessions}
            workspaceOptions={[{ id: 'ws-1', name: 'fixture' }, { id: 'ws-2', name: 'other' }]}
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
  it.each(['preparing', 'error'] as const)('does not show empty history while coverage is %s', async (state) => {
    client.listThreadMessages.mockReset();
    client.listThreadMessages.mockResolvedValue({ items: [], incomplete: 'history_preparing',
      history: { generation: 'example-generation', state, processedMessages: 0, completedShards: 0, totalShards: 16 } });
    const page = await render([], '/activity?view=comms');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(page.querySelector('[data-comms-history]')?.getAttribute('data-comms-history')).toBe(state);
    expect(page.querySelector('[data-activity-comms-empty]')).toBeNull();
  });

  it('refreshes the first page after preparation instead of continuing an incomplete cursor', async () => {
    client.listThreadMessages.mockReset();
    client.listThreadMessages.mockResolvedValueOnce({ items: [], next_cursor: 'incomplete-cursor', incomplete: 'history_preparing',
      history: { generation: 'old-generation', state: 'preparing', processedMessages: 0, completedShards: 0, totalShards: 16 } });
    client.listThreadMessages.mockResolvedValue({ items: [],
      history: { generation: 'new-generation', state: 'complete', processedMessages: 2, completedShards: 16, totalShards: 16 } });
    const page = await render([], '/activity?view=comms');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(page.querySelector('[data-comms-load-older]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(client.listThreadMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(client.listThreadMessages.mock.calls.every(([query]) => query.cursor === undefined)).toBe(true);
    expect(page.querySelector('[data-comms-history]')).toBeNull();
    expect(page.querySelector('[data-activity-comms-empty]')).not.toBeNull();
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
    // Each row names why it is here and where it belongs.
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
    // Reading a session does not answer its approval.
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
    // Only the finished group offers it: an approval is not "read" by looking.
    expect(page.querySelector('[data-activity-group="needs-you"] [data-activity-mark-all-read]')).toBeNull();
    const button = page.querySelector<HTMLButtonElement>('[data-activity-group="unread"] [data-activity-mark-all-read]');
    expect(button?.textContent).toBe('Mark all as read');
    await act(async () => { button?.click(); });
    expect(sessionSeenSnapshot()).toMatchObject({ done: 12, broke: 7 });
    expect(sessionSeenSnapshot()['ask']).toBeUndefined();
    expect(page.querySelector('[data-activity-group="unread"]')).toBeNull();
    expect(page.querySelector('[data-activity-item="ask"]')).not.toBeNull();
  });

  it.each([
    ['en', 'Not delivered: Target thread is archived'],
    ['zh', '未送达：目标线程已归档'],
  ])('translates delivery codes in %s without displaying diagnostic text', async (locale, expected) => {
    localStorage.setItem('kiki.locale', locale);
    const endpoint = { ref: { host_id: 'h', workspace_id: 'ws-1', session_id: 'a' }, deleted: false, archived: false };
    client.listThreadMessages.mockReset();
    client.listThreadMessages.mockResolvedValue({ items: [{ message_id: 'failed', source: { kind: 'thread', thread: endpoint },
      target: endpoint, content: 'Ping', accepted_at: 1, target_seq: 1, delivery: 'undeliverable',
      reason_code: 'thread_archived', reason_detail: 'arbitrary backend diagnostic', reason: 'legacy diagnostic' }] });
    try {
      const page = await render([], '/activity?view=comms');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const note = page.querySelector('[data-comms-delivery="undeliverable"]');
      expect(note?.textContent).toBe(expected);
      expect(note?.getAttribute('title')).toBe('arbitrary backend diagnostic');
    } finally { localStorage.removeItem('kiki.locale'); }
  });

  it('lists thread messages across workspaces, follows empty pages, and scopes by workspace', async () => {
    const endpoint = (session_id: string, workspace_id: string, extra: { deleted?: boolean } = {}) => ({
      ref: { host_id: 'h', workspace_id, session_id }, title: `T ${session_id}`, deleted: extra.deleted ?? false, archived: false,
    });
    client.listThreadMessages.mockReset();
    client.listThreadMessages
      .mockResolvedValueOnce({ items: [], next_cursor: 'c1', incomplete: 'scan_budget' })
      .mockResolvedValueOnce({ items: [
        { message_id: 'm1', source: { kind: 'thread', thread: endpoint('a', 'ws-1') }, target: endpoint('b', 'ws-2'),
          content: 'Contract ready\nsecond line', accepted_at: Date.parse('2026-01-01T00:00:00Z'), target_seq: 3, delivery: 'delivered' },
        { message_id: 'm2', source: { kind: 'thread', thread: endpoint('b', 'ws-2') }, target: endpoint('gone', 'ws-1', { deleted: true }),
          content: 'Ping', accepted_at: Date.parse('2026-01-01T00:00:00Z') - 1, target_seq: 4, delivery: 'undeliverable', reason: 'thread closed' },
      ] });
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
});

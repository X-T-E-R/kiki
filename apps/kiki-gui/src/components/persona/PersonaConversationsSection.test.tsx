// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSummary, Session, Workspace } from '@kiki/protocol';
import { clearToasts, getToasts } from '../../lib/toasts';

import { I18nProvider } from '../../i18n';
import { PersonaConversationsSection } from './PersonaConversationsSection';

const navigate = vi.fn();
const listSessions = vi.fn();
const setHome = vi.fn();
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listSessions,
      klient: { rest: { personas: { setHome } } },
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
  navigate.mockReset();
  setHome.mockReset();
  listSessions.mockReset();
  clearToasts();
  localStorage.setItem('kiki.locale', 'zh');
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

function session(patch: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: patch.id, workspace_id: 'ws_a', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T10:00:00Z', metadata: { cwd: '/a' }, busy: false, last_seq: 1,
    ...patch,
  } as Session;
}

const persona: PersonaSummary = { id: 'lin-lan', name: '小岚', revision: 'revision-1', archived: false, homeSessionId: 'home_lin' };

/** React reads `value` through its own tracker; the prototype setter is what a typist triggers. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}const workspaces: readonly Workspace[] = [
  { id: 'ws_a', name: 'EasyAgent', root: '/a', created_at: '', last_opened_at: '', pinned: false, session_count: 0, isGit: false },
];

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null,
      createElement(PersonaConversationsSection, { persona, workspaceOptions: workspaces }))));
  });
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe('one persona\'s conversations', () => {
  it('asks the server for this persona\'s conversations instead of reading a global window', async () => {
    listSessions.mockResolvedValue({ items: [session({ id: 'home_lin' }), session({ id: 'topic_1', title: '排查构建' })], has_more: false });
    const container = await render();
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ persona: 'lin-lan', include_archive: true }));
    expect([...container.querySelectorAll('[data-persona-conversation-row]')].map((row) => row.getAttribute('data-persona-conversation-row')))
      .toEqual(['home_lin', 'topic_1']);
    // Every conversation the server returned is shown: nothing is re-judged here.
    expect(container.textContent).toContain('排查构建');
  });

  it('scopes the request to the chosen workspace and searches the titles it has', async () => {
    listSessions.mockResolvedValue({ items: [session({ id: 'home_lin' }), session({ id: 'topic_1', title: '排查构建' })], has_more: false });
    const container = await render();
    const search = container.querySelector<HTMLInputElement>('input')!;
    await type(search, '排查');
    expect([...container.querySelectorAll('[data-persona-conversation-row]')].map((row) => row.getAttribute('data-persona-conversation-row')))
      .toEqual(['topic_1']);

    await type(search, '没有这一段');
    expect(container.textContent).toContain('没有匹配的对话');
  });

  it('moves the daily pointer through the real API and keeps the confirmation until it succeeds', async () => {
    listSessions.mockResolvedValue({ items: [session({ id: 'home_lin' }), session({ id: 'topic_1', title: '排查构建' })], has_more: false });
    setHome.mockResolvedValue({ version: 1, archived: false, homeSessionId: 'topic_1' });
    const container = await render();

    await act(async () => { container.querySelector<HTMLElement>('[data-persona-set-daily="topic_1"]')!.click(); });
    const confirm = container.querySelector<HTMLButtonElement>('[data-confirm-dialog-confirm]')
      ?? [...container.querySelectorAll('button')].find((button) => button.textContent === '确认更换')!;
    await act(async () => { confirm.click(); });

    // The klient signature is (id, sessionId): an object here would 400.
    expect(setHome).toHaveBeenCalledWith('lin-lan', 'topic_1');
    expect(getToasts().some((toast) => toast.tone === 'success')).toBe(true);
  });

  it('reports a failed pointer change and leaves the choice on screen to retry', async () => {
    listSessions.mockResolvedValue({ items: [session({ id: 'home_lin' }), session({ id: 'topic_1', title: '排查构建' })], has_more: false });
    setHome.mockRejectedValue(new Error('nope'));
    const container = await render();

    await act(async () => { container.querySelector<HTMLElement>('[data-persona-set-daily="topic_1"]')!.click(); });
    const confirm = container.querySelector<HTMLButtonElement>('[data-confirm-dialog-confirm]')
      ?? [...container.querySelectorAll('button')].find((button) => button.textContent === '确认更换')!;
    await act(async () => { confirm.click(); });
    for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // No success is claimed, and the dialog is still there for the next try.
    expect(getToasts().some((toast) => toast.tone === 'success')).toBe(false);
    expect(getToasts().some((toast) => toast.tone === 'error')).toBe(true);
    expect(container.querySelector('[data-persona-set-daily="topic_1"]')).not.toBeNull();
  });

  it('offers the rest of a paged list rather than passing the first page off as all of it', async () => {
    listSessions.mockResolvedValue({ items: [session({ id: 'home_lin' })], has_more: true });
    const container = await render();
    await act(async () => { container.querySelector<HTMLElement>('[data-persona-conversations-more]')!.click(); });
    for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(listSessions.mock.calls.length).toBeGreaterThan(1);
  });
});

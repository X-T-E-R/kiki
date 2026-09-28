// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';
import { markSessionSeen, resetSessionSeen } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import { ActivityPage } from './ActivityPage';

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

async function render(sessions: readonly Session[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <I18nProvider>
          <ActivityPage
            sessions={sessions}
            workspaceOptions={[{ id: 'ws-1', name: 'fixture' }]}
            onToggleSidebar={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

describe('ActivityPage', () => {
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
});

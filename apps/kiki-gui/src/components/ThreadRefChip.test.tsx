// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { ThreadRefText } from './ThreadRefChip';

const ID = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function record(overrides: Partial<Session> = {}): Session {
  return {
    id: ID, workspace_id: 'wd_kiki', title: 'Fix the flaky upload test',
    created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T11:30:00.000Z',
    busy: false, pending_interaction: 'approval', metadata: { cwd: 'C:/src/kiki' },
    agent_config: { model: '' },
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
    permission_rules: [], message_count: 1, last_seq: 1, ...overrides,
  };
}

const workspace: Workspace = {
  id: 'wd_kiki', root: 'C:/src/kiki', name: 'kiki', created_at: '2026-01-01T00:00:00.000Z',
  last_opened_at: '2026-01-01T00:00:00.000Z', session_count: 1, pinned: false,
};

function Where() {
  return <span data-where>{useLocation().pathname}</span>;
}

async function render(text: string, sessions: Session[]) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient();
  client.setQueryData(['sessions', false, undefined], { pages: [{ items: sessions, has_more: false }], pageParams: [undefined] });
  client.setQueryData(['workspaces'], { items: [workspace] });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/s/session_here']}>
            <Routes>
              <Route path="*" element={<><ThreadRefText text={text} projectSegment={(segment) => segment} /><Where /></>} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

describe('ThreadRefText', () => {
  it('renders a resolved link as a chip with title, workspace and status, and opens the thread', async () => {
    const container = await render(`look at /s/${ID}.`, [record()]);
    const chip = container.querySelector<HTMLAnchorElement>(`[data-thread-ref-chip="${ID}"]`)!;
    expect(chip.textContent).toContain('Fix the flaky upload test');
    expect(chip.textContent).toContain('kiki');
    expect(chip.getAttribute('data-thread-ref-status')).toBe('awaiting_approval');
    expect(chip.getAttribute('aria-label')).toBe('Open Fix the flaky upload test · Awaiting approval');
    expect(container.textContent).toContain('look at');
    expect(container.textContent?.endsWith('.' + '/s/session_here')).toBe(true);
    await act(async () => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(container.querySelector('[data-where]')?.textContent).toBe(`/s/${ID}`);
  });

  it('labels an untitled or unknown thread with its short id', async () => {
    const container = await render(`kiki://s/${ID}`, []);
    const chip = container.querySelector(`[data-thread-ref-chip="${ID}"]`)!;
    expect(chip.textContent).toContain('Thread 0f8e2a4c');
    expect(chip.getAttribute('data-thread-ref-status')).toBe('unknown');
  });
});

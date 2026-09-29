// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, WorktreeInspection } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { EphemeralBar } from './EphemeralBar';

const { client, worktrees, navigate, toasts } = vi.hoisted(() => ({
  client: {
    saveEphemeralSession: vi.fn(),
    endEphemeralSession: vi.fn(),
  },
  worktrees: { inspect: vi.fn(), remove: vi.fn() },
  navigate: vi.fn(),
  toasts: [] as { tone: string; text: string }[],
}));

vi.mock('../state/connection', () => ({ useConnection: () => ({ client }) }));
vi.mock('../lib/worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/worktrees')>()),
  worktreeApi: () => worktrees,
}));
vi.mock('./dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));
vi.mock('../lib/toasts', () => ({ pushToast: (toast: { tone: string; text: string }) => { toasts.push(toast); return 1; } }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of [client.saveEphemeralSession, client.endEphemeralSession, worktrees.inspect, worktrees.remove, navigate]) fn.mockReset();
  toasts.length = 0;
});
afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function temp(worktree?: Session['worktree']): Session {
  return {
    id: 's-temp', workspace_id: 'ws', title: 'scratch', ephemeral: true,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', busy: false,
    metadata: { cwd: 'C:/repo' }, agent_config: { model: '' },
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
    permission_rules: [], message_count: 0, last_seq: 0,
    ...(worktree === undefined ? {} : { worktree }),
  } as Session;
}

const WORKTREE = { worktree_id: 'wt-1', branch: 'kiki/scratch', source_root: 'C:/repo' } as unknown as NonNullable<Session['worktree']>;
const DIRTY: WorktreeInspection = { failed: false, dirtyFiles: 2, untrackedFiles: 1, unpushedCommits: 0, ignoredNonDisposable: [] } as unknown as WorktreeInspection;

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(session: Session, busy = false, onSaved = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <EphemeralBar session={session} busy={busy} onSaved={onSaved} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return onSaved;
}

function click(selector: string): void {
  const node = document.querySelector<HTMLElement>(selector);
  expect(node, selector).not.toBeNull();
  act(() => { node!.click(); });
}

describe('EphemeralBar', () => {
  it('saves into the history and says so', async () => {
    client.saveEphemeralSession.mockResolvedValue(temp());
    const onSaved = await mount(temp());
    click('[data-ephemeral-save]');
    await flush();
    expect(client.saveEphemeralSession).toHaveBeenCalledWith('s-temp');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ tone: 'success', text: 'Saved. It now appears in your conversations.' }]);
  });

  it('waits for the running turn before it can save', async () => {
    await mount(temp(), true);
    const save = document.querySelector<HTMLButtonElement>('[data-ephemeral-save]');
    expect(save?.disabled).toBe(true);
    expect(save?.title).toBe('Saving is available once the current turn finishes.');
  });

  it('ends after a confirmation and leaves for /new', async () => {
    client.endEphemeralSession.mockResolvedValue({ ended: true });
    await mount(temp());
    click('[data-ephemeral-end]');
    expect(document.querySelector('[data-ephemeral-end-worktree]')).toBeNull();
    click('[data-ephemeral-end-confirm]');
    await flush();
    expect(client.endEphemeralSession).toHaveBeenCalledWith('s-temp', undefined);
    expect(navigate).toHaveBeenCalledWith('/new');
  });

  it('keeps a worktree with uncommitted work unless removal is chosen', async () => {
    worktrees.inspect.mockResolvedValue(DIRTY);
    client.endEphemeralSession.mockResolvedValue({ ended: true, worktree: { id: 'wt-1', outcome: 'kept' } });
    await mount(temp(WORKTREE));
    click('[data-ephemeral-end]');
    await flush();
    expect(document.querySelector('[data-ephemeral-end-worktree]')?.getAttribute('data-ephemeral-end-worktree')).toBe('loss');
    expect(document.querySelector<HTMLInputElement>('[data-ephemeral-end-worktree-choice="keep"]')?.checked).toBe(true);
    click('[data-ephemeral-end-confirm]');
    await flush();
    expect(client.endEphemeralSession).toHaveBeenCalledWith('s-temp', 'keep');
    expect(worktrees.remove).not.toHaveBeenCalled();
  });

  it('removes a worktree with work only by confirming the loss it showed', async () => {
    worktrees.inspect.mockResolvedValue(DIRTY);
    worktrees.remove.mockResolvedValue({ outcome: 'removed' });
    client.endEphemeralSession.mockResolvedValue({ ended: true, worktree: { id: 'wt-1', outcome: 'kept' } });
    await mount(temp(WORKTREE));
    click('[data-ephemeral-end]');
    await flush();
    click('[data-ephemeral-end-worktree-choice="remove"]');
    click('[data-ephemeral-end-confirm]');
    await flush();
    expect(client.endEphemeralSession).toHaveBeenCalledWith('s-temp', 'keep');
    expect(worktrees.remove).toHaveBeenCalledWith('wt-1', { confirmLoss: { dirty: true, ignored: false, unpushed: false } });
    expect(navigate).toHaveBeenCalledWith('/new');
  });

  it('stays open with the reason when ending fails', async () => {
    client.endEphemeralSession.mockRejectedValue(new Error('offline'));
    await mount(temp());
    click('[data-ephemeral-end]');
    click('[data-ephemeral-end-confirm]');
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not end the conversation');
    expect(navigate).not.toHaveBeenCalled();
  });
});

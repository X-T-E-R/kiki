// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotSummary, PersonaSummary, Session } from '@kiki/protocol';

import { sortAndFilterDirectory, usePersonaDirectory } from './usePersonaDirectory';

const { listPersonas, listBots } = vi.hoisted(() => ({ listPersonas: vi.fn(), listBots: vi.fn() }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client: { listPersonas } }) }));
vi.mock('../../lib/botRooms', () => ({ BOTS_QUERY_KEY: ['bots'], useBotRoomApi: () => ({ listBots }) }));

const persona = (id: string, state: Partial<PersonaSummary> = {}): PersonaSummary => ({ id, name: id, revision: 'revision-1', archived: false, ...state });
const bot = (id: string, homeSessionId: string): BotSummary => ({ personaId: id, name: id, homeSessionId, pinned: true, hidden: true });
const session = (id: string, personaId: string, state: Partial<Session> = {}): Session => ({
  id, workspace_id: 'project-a', title: id, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
  busy: false, agent_config: { model: '', persona: { id: personaId, name: personaId } }, metadata: { cwd: '/fixture/project-a' },
  permission_rules: [], message_count: 0, last_seq: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
  ...state,
});
const mounted: { root: Root; container: HTMLDivElement; queryClient: QueryClient }[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => { listPersonas.mockReset().mockResolvedValue([persona('a')]); listBots.mockReset().mockResolvedValue([]); });
afterEach(async () => {
  for (const { root, container, queryClient } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    queryClient.clear(); container.remove();
  }
});

async function renderDirectory(options: Parameters<typeof usePersonaDirectory>[0] = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container, queryClient });
  let latest!: ReturnType<typeof usePersonaDirectory>;
  function Probe() { latest = usePersonaDirectory(options); return null; }
  await act(async () => { root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe))); });
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { latest: () => latest, queryClient };
}

describe('unified persona directory', () => {
  it('does not let a failed legacy bots request block a successful persona directory', async () => {
    listPersonas.mockResolvedValue([persona('a', { homeSessionId: 'current-home', pinned: false, hidden: false }), persona('b')]);
    listBots.mockRejectedValue(new Error('legacy endpoint unavailable'));
    const probe = await renderDirectory();
    expect(probe.latest().isError).toBe(false);
    expect(probe.latest().error).toBeNull();
    expect(probe.latest().directory.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(probe.latest().directory[0]).toMatchObject({ homeSessionId: 'current-home', pinned: false, hidden: false });
  });

  it('does not wait for legacy bots to render the directory', async () => {
    listBots.mockReturnValue(new Promise(() => {}));
    const probe = await renderDirectory();
    expect(probe.latest().directory).toHaveLength(1);
    expect(probe.latest().isLoading).toBe(false);
  });

  it('prefers actual D1 fields including false and retains old Bot home as a fallback only', async () => {
    listPersonas.mockResolvedValue([persona('a', { homeSessionId: 'new-home', pinned: false, hidden: false }), persona('legacy'), persona('without-home')]);
    listBots.mockResolvedValue([bot('a', 'old-home'), bot('legacy', 'legacy-home'), bot('orphan-bot', 'orphan-home')]);
    const probe = await renderDirectory();
    expect(probe.latest().directory).toHaveLength(3);
    expect(probe.latest().directory[0]).toMatchObject({ homeSessionId: 'new-home', pinned: false, hidden: false });
    expect(probe.latest().directory[1]).toMatchObject({ homeSessionId: 'legacy-home', pinned: true, hidden: true });
    expect(probe.latest().directory[2]).toMatchObject({ homeSessionId: undefined, pinned: false, hidden: false });
    expect(sortAndFilterDirectory(probe.latest().directory).map((entry) => entry.id)).toEqual(['a', 'without-home']);
    expect(sortAndFilterDirectory(probe.latest().directory, { includeHidden: true })[0]?.id).toBe('legacy');
  });

  it('does not resurrect a stale Bot home when D1 state explicitly describes a persona without home', async () => {
    listPersonas.mockResolvedValue([persona('a', { pinned: false, hidden: false })]);
    listBots.mockResolvedValue([bot('a', 'stale-home')]);
    const probe = await renderDirectory();
    expect(probe.latest().directory[0]?.homeSessionId).toBeUndefined();
  });

  it('keeps list loading and list failures distinct from a confirmed empty directory', async () => {
    listPersonas.mockReturnValue(new Promise(() => {}));
    const loading = await renderDirectory();
    expect(loading.latest().isLoading).toBe(true);
    expect(loading.latest().isError).toBe(false);
    listPersonas.mockRejectedValue(new Error('directory unavailable'));
    const failed = await renderDirectory();
    expect(failed.latest().isLoading).toBe(false);
    expect(failed.latest().isError).toBe(true);
    expect(failed.latest().error?.message).toBe('directory unavailable');
  });

  it('aggregates the same persona in two projects and rooms without archived activity or another persona', async () => {
    listPersonas.mockResolvedValue([persona('a'), persona('b')]);
    const probe = await renderDirectory({ sessions: [
      session('a-home', 'a', { last_seq: 3 }),
      session('a-project-b', 'a', { workspace_id: 'project-b', busy: true }),
      session('a-room', 'a', { agent_config: { model: '' }, metadata: { cwd: '/fixture/room', room_persona_id: 'a', room_member_of: 'room-a' }, pending_interaction: 'approval' }),
      session('a-archived', 'a', { archived: true, last_seq: 99 }),
      session('b-project', 'b', { last_seq: 8 }),
    ] });
    expect(probe.latest().directory[0]).toMatchObject({ life: 'waiting', unreadCount: 1, urgentSessionId: 'a-room' });
    expect(probe.latest().directory[1]).toMatchObject({ life: 'done', unreadCount: 1, urgentSessionId: 'b-project' });
  });

  it('never reuses persona data from another connection QueryClient', async () => {
    listPersonas.mockResolvedValue([persona('a', { homeSessionId: 'local-home' })]);
    const local = await renderDirectory();
    listPersonas.mockResolvedValue([persona('a', { homeSessionId: 'remote-home' })]);
    const remote = await renderDirectory();
    expect(local.latest().directory[0]?.homeSessionId).toBe('local-home');
    expect(remote.latest().directory[0]?.homeSessionId).toBe('remote-home');
  });
});

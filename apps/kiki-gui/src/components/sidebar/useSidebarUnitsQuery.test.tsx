// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResolveSidebarUnitsResponse,
  SidebarGroupMembersResponse,
  SidebarRow,
  SidebarSessionsPage,
  SidebarUnit,
} from '@kiki/protocol';
import { typedUnitKey } from '@kiki/session-core/sessions';
import type { KikiClient } from '../../lib/client';
import { useSidebarUnitsQuery, type SidebarUnitsController } from './useSidebarUnitsQuery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeRow(id: string, overrides: Partial<SidebarRow> = {}): SidebarRow {
  const ts = overrides.own_updated_at ?? '2026-11-24T10:00:00.000Z';
  return {
    id,
    workspace_id: 'ws_1',
    title: `Session ${id}`,
    created_at: '2026-11-24T09:00:00.000Z',
    updated_at: ts,
    own_updated_at: ts,
    busy: false,
    last_seq: 1,
    ...overrides,
  };
}

function makeSessionUnit(id: string, sortAt: number, overrides: Partial<SidebarRow> = {}): SidebarUnit {
  const iso = new Date(sortAt).toISOString();
  return {
    kind: 'session',
    id,
    sort_at: sortAt,
    row: makeRow(id, { updated_at: iso, own_updated_at: iso, ...overrides }),
  };
}

function makeGroupUnit(
  id: string,
  sortAt: number,
  members: SidebarRow[],
  extra: Partial<Extract<SidebarUnit, { kind: 'group' }>> = {},
): SidebarUnit {
  return {
    kind: 'group',
    id,
    title: members[0]?.title ?? id,
    sort_at: sortAt,
    has_pinned: extra.has_pinned ?? members.some((m) => m.pinned === true),
    member_count: extra.member_count ?? members.length,
    members,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('useSidebarUnitsQuery', () => {
  it('promotes a page-2 group once while page 3 is in flight, loads >50 members, detaches a member, and rebases on 40922', async () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const p1: SidebarSessionsPage = {
      revision: 10,
      generation: 1,
      units: [makeSessionUnit('s_top', 5000), makeSessionUnit('s_mid', 4000)],
      has_more: true,
      next_cursor: 'cur_p1',
    };
    const p2: SidebarSessionsPage = {
      revision: 10,
      generation: 1,
      units: [
        makeGroupUnit('grp_p2', 3000, [
          makeRow('g_open', { group_id: 'grp_p2' }),
          makeRow('g_child', { group_id: 'grp_p2' }),
        ], { member_count: 52, members_next_cursor: 'mcur_50' }),
        makeSessionUnit('s_old', 2000),
      ],
      has_more: true,
      next_cursor: 'cur_p2',
    };

    let resolvePage3!: (page: SidebarSessionsPage) => void;
    const listMock = vi.fn(async (query?: { cursor?: string; pinned?: boolean }) => {
      if (query?.pinned === true) {
        return { revision: 10, generation: 1, units: [], has_more: false };
      }
      if (query?.cursor === undefined) return p1;
      if (query.cursor === 'cur_p1') return p2;
      if (query.cursor === 'cur_p2') {
        return new Promise<SidebarSessionsPage>((resolve) => { resolvePage3 = resolve; });
      }
      if (query.cursor === 'cur_stale') {
        const err = Object.assign(new Error('40922 PAGE_TOKEN_MISMATCH'), { code: 40922 });
        throw err;
      }
      return { revision: 10, generation: 1, units: [], has_more: false };
    });

    const resolveUnitsMock = vi.fn(async (): Promise<ResolveSidebarUnitsResponse> => ({
      revision: 15,
      generation: 1,
      units: [
        makeGroupUnit('grp_p2', 6000, [
          makeRow('g_child', { group_id: 'grp_p2', own_updated_at: new Date(6000).toISOString(), updated_at: new Date(6000).toISOString() }),
          makeRow('g_open', { group_id: 'grp_p2' }),
        ], { member_count: 52, members_next_cursor: 'mcur_50' }),
      ],
      missing_session_ids: [],
      missing_group_ids: [],
    }));

    const groupMembersMock = vi.fn(async (): Promise<SidebarGroupMembersResponse> => ({
      revision: 16,
      generation: 1,
      group_id: 'grp_p2',
      member_count: 52,
      members: [makeRow('g_member_51', { group_id: 'grp_p2' }), makeRow('g_member_52', { group_id: 'grp_p2' })],
      has_more: false,
    }));

    const detachGroupMock = vi.fn(async (sessionId: string) => ({
      detached: true,
      session_id: sessionId,
      previous_group_id: 'grp_p2',
    }));

    const fakeClient = {
      klient: {
        rest: {
          sidebar: {
            list: listMock,
            groupMembers: groupMembersMock,
            resolveUnits: resolveUnitsMock,
          },
          sessions: {
            detachGroup: detachGroupMock,
          },
        },
        events: {
          on: (eventName: string, cb: (event: unknown) => void) => {
            handlers.set(eventName, cb);
            return { dispose: () => { handlers.delete(eventName); } };
          },
        },
      },
    } as unknown as KikiClient;

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let controller!: SidebarUnitsController;
    function Harness() {
      const value = useSidebarUnitsQuery({
        enabled: true,
        client: fakeClient,
        wsStatus: 'open',
        showArchived: false,
        workspaceFilter: undefined,
        privateFilter: 'hide',
        sort: 'updated_desc',
        pinnedEnabled: true,
      });
      useEffect(() => { controller = value; });
      controller = value;
      return null;
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(controller.units.map(typedUnitKey)).toEqual(['s:s_top', 's:s_mid']);

    // Load page 2.
    await act(async () => { await controller.fetchNextPage(); });
    expect(controller.units.map(typedUnitKey)).toEqual(['s:s_top', 's:s_mid', 'g:grp_p2', 's:s_old']);

    // Start page 3 (remains in flight) while g_child promotes grp_p2 to head via metaUpdated.
    let page3Promise!: Promise<unknown>;
    act(() => { page3Promise = controller.fetchNextPage(); });
    await act(async () => {
      handlers.get('session.metaUpdated')?.({ sessionId: 'g_child' });
    });
    await vi.waitFor(() => {
      expect(resolveUnitsMock).toHaveBeenCalledTimes(1);
      expect(controller.units.map(typedUnitKey)).toEqual(['g:grp_p2', 's:s_top', 's:s_mid', 's:s_old']);
    }, { timeout: 2_000 });

    // Resolve stale page 3 containing an older duplicate of grp_p2 + s_older -> grp_p2 stays once at head!
    await act(async () => {
      resolvePage3({
        revision: 11,
        generation: 1,
        units: [
          makeGroupUnit('grp_p2', 3000, [makeRow('g_open', { group_id: 'grp_p2' })]),
          makeSessionUnit('s_older', 1000),
        ],
        has_more: true,
        next_cursor: 'cur_stale',
      });
      await page3Promise;
    });
    expect(controller.units.map(typedUnitKey)).toEqual(['g:grp_p2', 's:s_top', 's:s_mid', 's:s_old', 's:s_older']);

    // Load more members for >50-member group.
    await act(async () => { await controller.loadMoreGroupMembers('grp_p2', 'mcur_50'); });
    const grp = controller.units.find((u) => u.kind === 'group' && u.id === 'grp_p2') as Extract<SidebarUnit, { kind: 'group' }>;
    expect(grp.members.map((m) => m.id)).toEqual(['g_child', 'g_open', 'g_member_51', 'g_member_52']);
    expect(grp.members_next_cursor).toBeUndefined();

    // WorkChanged tick updates status in place without reordering.
    await act(async () => {
      handlers.get('session.workChanged')?.({
        sessionId: 's_mid',
        busy: true,
        executing: true,
        main_turn_active: true,
        pending_interaction: 'none',
      });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(controller.units.map(typedUnitKey)).toEqual(['g:grp_p2', 's:s_top', 's:s_mid', 's:s_old', 's:s_older']);
    const sMid = controller.units.find((u) => u.kind === 'session' && u.id === 's_mid');
    expect(sMid?.kind === 'session' && sMid.row.busy).toBe(true);

    // Detach member routes through detachGroup + resolveUnits.
    resolveUnitsMock.mockResolvedValueOnce({
      revision: 17,
      generation: 1,
      units: [
        makeSessionUnit('g_child', 6000, { group_detached: true }),
        makeGroupUnit('grp_p2', 5500, [makeRow('g_open', { group_id: 'grp_p2' }), makeRow('g_member_51', { group_id: 'grp_p2' })], { member_count: 51 }),
      ],
      missing_session_ids: [],
      missing_group_ids: [],
    });
    await act(async () => { await controller.detachGroupMember('g_child'); });
    expect(detachGroupMock).toHaveBeenCalledWith('g_child');
    await vi.waitFor(() => {
      expect(controller.units.map(typedUnitKey)).toContain('s:g_child');
    }, { timeout: 2_000 });

    // 40922 PAGE_TOKEN_MISMATCH rebases head cleanly.
    await act(async () => { await controller.fetchNextPage(); });
    expect(controller.units.map(typedUnitKey)).toEqual(['s:s_top', 's:s_mid']);
  });
});

// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteConnection, SidebarUnit } from '@kiki/protocol';
import { projectSidebarUnitGroups } from '@kiki/session-core/sessions';
import { HostProvider, browserHost } from '../host';
import { I18nProvider } from '../i18n';
import { ConnectionContext, type ConnectionValue } from '../state/connection';
import { PlaceClientPoolContext, type PlaceClientPoolValue } from '../state/placeClients';
import { useMultiSpaceSessions, type MultiSpaceSessionsResult } from './useMultiSpaceSessions';

const harness = {
  remoteConnections: [] as RemoteConnection[],
  remoteClients: new Map<string, unknown>(),
  connection: {
    scopeId: 'local',
    spaceKey: 'main',
    localSpaceKey: 'main',
    client: {
      baseUrl: 'http://local.example.test',
      meta: async () => ({ server_home_id: 'home_local', capabilities: { sidebar_groups: true } }),
      klient: {
        rest: {
          connections: {
            list: async () => harness.remoteConnections,
          },
          homes: {
            list: async () => ({ items: [] }),
          },
          sidebar: { list: vi.fn(), resolveUnits: vi.fn(), groupMembers: vi.fn() },
        },
      },
    },
    localClient: null,
    config: { url: 'http://local.example.test', token: '' },
    meta: { server_home_id: 'home_local', capabilities: { sidebar_groups: true } },
    wsStatus: 'open',
  },
  placePool: {
    getOrCreateEntry: () => null,
    getOrCreateClient: (id: string) => harness.remoteClients.get(id) ?? null,
    revoke: vi.fn(),
    retainOnly: vi.fn(),
    subscribeMutation: vi.fn(() => () => {}),
  },
};

function makeRow(id: string, title: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    workspace_id: 'ws_shared',
    cwd: '/work/shared',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt,
    own_updated_at: updatedAt,
    archived: false,
    private: false,
    pinned: false,
    busy: false,
    executing: false,
    pending_interaction: 'none' as const,
    last_seq: 1,
    cleanup_pending: false,
    ...extra,
  };
}

describe('useMultiSpaceSessions sidebar_groups & cross-host coalescing', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    harness.remoteConnections = [];
    harness.remoteClients.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('probes remote meta for sidebar_groups, runs cross-host resolveUnits, preserves origin prefixes, and marks legacy/offline partial coverage', async () => {
    const connPeer: RemoteConnection = {
      id: 'conn_peer',
      name: 'Peer GPU',
      url: 'http://peer.example.test',
      state: 'online',
      enabled: true,
      purposes: ['gui'],
      target: { homeId: 'home_peer', host: 'peer.example.test' },
    } as unknown as RemoteConnection;
    const connLegacy: RemoteConnection = {
      id: 'conn_legacy',
      name: 'Legacy Box',
      url: 'http://legacy.example.test',
      state: 'online',
      enabled: true,
      purposes: ['gui'],
      target: { homeId: 'home_legacy', host: 'legacy.example.test' },
    } as unknown as RemoteConnection;
    harness.remoteConnections = [connPeer, connLegacy];

    const peerSidebarList = vi.fn(async () => ({
      revision: 3,
      generation: 1,
      units: [{
        kind: 'session',
        id: 's_peer_only',
        sort_at: Date.parse('2026-06-01T00:00:00Z'),
        row: makeRow('s_peer_only', 'Peer standalone', '2026-06-01T00:00:00Z'),
      }] satisfies SidebarUnit[],
      has_more: false,
    }));
    const peerResolveUnits = vi.fn(async (req: { group_ids?: string[] }) => {
      if (req.group_ids?.includes('grp_shared')) {
        return {
          revision: 4,
          generation: 1,
          units: [{
            kind: 'group',
            id: 'grp_shared',
            opener_id: 's_local_open',
            title: 'Cross-host build',
            primary_workspace_id: 'ws_shared',
            sort_at: Date.parse('2026-06-02T00:00:00Z'),
            has_pinned: false,
            member_count: 1,
            members: [makeRow('s_peer_worker', 'Peer worker', '2026-06-02T00:00:00Z', {
              group_id: 'grp_shared',
              group_origin: { host_id: 'home_local', home_id: 'home_local' },
            })],
          }] satisfies SidebarUnit[],
          missing_session_ids: [],
          missing_group_ids: [],
        };
      }
      return { revision: 4, generation: 1, units: [], missing_session_ids: [], missing_group_ids: [] };
    });
    const peerGroupMembers = vi.fn(async () => ({
      revision: 4,
      group_id: 'grp_shared',
      member_count: 2,
      members: [makeRow('s_peer_tail', 'Peer tail', '2026-06-01T12:00:00Z', { group_id: 'grp_shared' })],
      has_more: false,
    }));
    const legacyListSessions = vi.fn(async () => ({
      items: [{
        id: 's_legacy',
        title: 'Legacy row',
        workspace_id: 'ws_legacy',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-06-01T01:00:00Z',
        busy: false,
        metadata: { cwd: '/legacy' },
      }],
      has_more: false,
    }));

    harness.remoteClients.set('conn_peer', {
      meta: async () => ({ server_home_id: 'home_peer', capabilities: { sidebar_groups: true } }),
      listWorkspaceCatalog: async () => ({ items: [] }),
      klient: {
        rest: {
          rooms: { listItems: async () => [] },
          sidebar: { list: peerSidebarList, resolveUnits: peerResolveUnits, groupMembers: peerGroupMembers },
        },
      },
    });
    harness.remoteClients.set('conn_legacy', {
      meta: async () => ({ server_home_id: 'home_legacy', capabilities: {} }),
      listSessions: legacyListSessions,
      listWorkspaceCatalog: async () => ({ items: [] }),
      klient: { rest: { rooms: { listItems: async () => [] } } },
    });

    const localUnits: SidebarUnit[] = [{
      kind: 'group',
      id: 'grp_shared',
      opener_id: 's_local_open',
      title: 'Cross-host build',
      primary_workspace_id: 'ws_shared',
      sort_at: Date.parse('2026-06-01T10:00:00Z'),
      has_pinned: false,
      member_count: 1,
      members: [makeRow('s_local_open', 'Local opener', '2026-06-01T10:00:00Z', {
        group_id: 'grp_shared',
        group_origin: { host_id: 'home_local', home_id: 'home_local' },
      })],
    }];

    const emptySessions: never[] = [];
    const emptyRooms: never[] = [];
    const emptyWorkspaces: never[] = [];
    const filter = { sort: 'updated_desc' as const };
    let latest!: MultiSpaceSessionsResult;
    function Harness() {
      const result = useMultiSpaceSessions({
        activeSessions: emptySessions,
        activeSidebarUnits: localUnits,
        activeRooms: emptyRooms,
        activeWorkspaces: emptyWorkspaces,
        enabled: true,
        sidebarFilter: filter,
      });
      useEffect(() => { latest = result; });
      return null;
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <HostProvider host={browserHost}>
              <ConnectionContext.Provider value={harness.connection as unknown as ConnectionValue}>
                <PlaceClientPoolContext.Provider value={harness.placePool as unknown as PlaceClientPoolValue}>
                  <Harness />
                </PlaceClientPoolContext.Provider>
              </ConnectionContext.Provider>
            </HostProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(peerSidebarList).toHaveBeenCalledTimes(1);
      expect(legacyListSessions).toHaveBeenCalledTimes(1);
      expect(peerResolveUnits).toHaveBeenCalledWith(
        expect.objectContaining({ group_ids: ['grp_shared'] }),
        expect.anything(),
      );
    }, { timeout: 2_000 });

    const buckets = projectSidebarUnitGroups(latest.unitSources, {
      groupBy: 'time',
      workspaces: [],
      filters: { status: [], workspaces: [], archived: 'hide' },
      nowMs: Date.parse('2026-06-02T12:00:00Z'),
      order: 'updated-desc',
      labels: { pinned: 'Pinned', today: 'Today', yesterday: 'Yesterday', week: 'Week', month: 'Month', older: 'Older' },
      ungroupedLabel: 'Ungrouped',
    });
    const allItems = buckets.flatMap((b) => b.items);
    const shared = allItems.find((item) => item.kind === 'session-group' && item.groupId === 'grp_shared');
    expect(shared?.kind).toBe('session-group');
    if (shared?.kind === 'session-group') {
      expect(shared.members.map((m) => m.key)).toEqual([
        'remote:conn_peer:session:s_peer_worker',
        'session:s_local_open',
      ]);
      expect(shared.partialCoverage).toBe(true);
    }

    await act(async () => {
      await latest.loadMoreSpaceGroupMembers('remote:conn_peer', 'grp_shared', 'cur_1');
    });
    expect(peerGroupMembers).toHaveBeenCalledWith('grp_shared', expect.objectContaining({ cursor: 'cur_1' }));
  });
});

/**
 * Multi-space conversation stream aggregator.
 *
 * Discovers the local control space and online paired GUI remote spaces, pools
 * one lightweight REST client per online remote connection generation, and
 * projects every space into `SpaceConversationSource[]` for `buildUnifiedInbox`
 * and the multi-space `Sessions` list.
 *
 * Polling uses bounded concurrency (3), pauses while the tab is hidden or the
 * sidebar is inert, retains the last-good snapshot on transient failures with
 * a quiet health record, and revokes pooled clients immediately on unpair or
 * disable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  MetaResponse,
  RemoteConnection,
  RoomListItem,
  Session,
  SidebarSessionsQuery,
  SidebarSessionsSort,
  SidebarUnit,
  WorkspaceCatalogEntry,
} from '@kiki/protocol';
import {
  appendSidebarGroupMembers,
  appendSidebarPage,
  applySidebarUnitReplacements,
  collectCrossHostGroupIds,
  dedupeSidebarUnits,
  flattenSidebarUnitsToSessions,
  hasFlatSidebarSessionsCapability,
  isPageTokenMismatchError,
  mergeSidebarFirstPage,
  type SidebarUnitPagesData,
  type SidebarUnitSpaceSource,
  type SpaceConversationSource,
} from '@kiki/session-core/sessions';

import { useHost } from '../host';
import { isDesktopHost } from '../host/host';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { useOptionalPlaceClientPool } from '../state/placeClients';
import { createRemoteSpaceClient, type KikiClient } from './client';
import { hasGuiPurpose, remoteSpaceKey, useRemoteConnections } from './remoteConnections';
import { MAIN_SPACE_ID, useSpaces, useSpaceStatuses } from './spaces';
import { activeSpace } from './spaceStorage';
import { startVisiblePoll } from './visiblePoll';

export const ALL_SPACE_SCOPE = 'all';
const MULTI_SPACE_POLL_MS = 20_000;
const REMOTE_FETCH_CONCURRENCY = 3;

/** Convert a concrete `spaceKey` (`main`, `h-1`, `remote:<id>`) into a `LayoutPreferences.spaceScope` token. */
export function spaceKeyToScope(spaceKey: string): string {
  if (spaceKey === '' || spaceKey === ALL_SPACE_SCOPE) return ALL_SPACE_SCOPE;
  if (spaceKey.startsWith('remote:') || spaceKey.startsWith('local:')) return spaceKey;
  return `local:${spaceKey}`;
}

/** Extract the concrete `spaceKey` from a `LayoutPreferences.spaceScope` token, or `undefined` for `all`. */
export function spaceScopeToKey(scope: string | undefined): string | undefined {
  if (scope === undefined || scope === '' || scope === ALL_SPACE_SCOPE) return undefined;
  if (scope.startsWith('local:')) return scope.slice('local:'.length);
  return scope;
}

/** True when `spaceKey` belongs to the active `spaceScope`. */
export function matchesSpaceScope(scope: string | undefined, spaceKey: string): boolean {
  const target = spaceScopeToKey(scope);
  return target === undefined || target === spaceKey;
}

export interface MultiSpaceHealth {
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly isRemote: boolean;
  readonly state: 'online' | 'stale' | 'offline';
  readonly lastSyncedAt?: number;
  readonly color?: string;
  readonly connectionId?: string;
}

interface CachedSpaceSnapshot {
  readonly sessions: readonly Session[];
  readonly unitPages?: SidebarUnitPagesData;
  readonly sidebarGroupsCapable?: boolean;
  readonly serverHomeId?: string;
  readonly filterSignature?: string;
  readonly hasMoreSessions: boolean;
  readonly nextSessionCursor?: string;
  readonly rooms: readonly RoomListItem[];
  readonly workspaces: readonly WorkspaceCatalogEntry[];
  readonly lastSyncedAt: number;
  readonly stale: boolean;
}

interface PooledRemoteEntry {
  readonly generationKey: string;
  readonly client: KikiClient;
}

export interface MultiSpaceSidebarFilterQuery {
  readonly showArchived?: boolean;
  readonly includePrivate?: boolean;
  readonly privateOnly?: boolean;
  readonly sort?: SidebarSessionsSort;
}

export interface UseMultiSpaceSessionsOptions {
  /** Currently active connection's live sessions (avoids duplicate fetch). */
  readonly activeSessions: readonly Session[];
  /** Currently active connection's live sidebar units when `sidebar_groups` is supported. */
  readonly activeSidebarUnits?: readonly SidebarUnit[];
  /** Currently active connection's live rooms. */
  readonly activeRooms: readonly RoomListItem[];
  /** Currently active connection's live workspace catalog. */
  readonly activeWorkspaces: readonly WorkspaceCatalogEntry[];
  /** Active filter & sort query forwarded per space so remote sources honor the view's filters. */
  readonly sidebarFilter?: MultiSpaceSidebarFilterQuery;
  /** Active space scope (`all` enables cross-host group fragment batch resolution). */
  readonly spaceScope?: string;
  /** Pauses background remote head polling when the sidebar is closed/inert. */
  readonly enabled?: boolean;
}

export interface MultiSpaceSessionsResult {
  readonly sources: readonly SpaceConversationSource[];
  readonly unitSources: readonly SidebarUnitSpaceSource[];
  readonly healthBySpace: ReadonlyMap<string, MultiSpaceHealth>;
  readonly hasMoreBySpace: ReadonlyMap<string, boolean>;
  readonly nextCursorBySpace: ReadonlyMap<string, string>;
  readonly loadingMoreSpaces: ReadonlySet<string>;
  readonly localSpaceKey: string;
  readonly localSpaceName: string;
  readonly remoteConnections: readonly RemoteConnection[];
  readonly remoteLoading: boolean;
  readonly hasMultipleSpaces: boolean;
  readonly refetchRemotes: () => Promise<void>;
  readonly refreshRemoteSpace: (connectionId: string) => Promise<void>;
  readonly loadMoreSpaceSessions: (spaceKey: string) => Promise<void>;
  readonly loadMoreSpaceGroupMembers: (spaceKey: string, groupId: string, cursor: string) => Promise<void>;
  readonly searchAcrossSpaces: (
    query: string,
    scope: string | undefined,
    signal: AbortSignal,
  ) => Promise<readonly SpaceConversationSource[]>;
}

interface SpaceHeadResult {
  readonly sessions: readonly Session[];
  readonly unitPage?: import('@kiki/protocol').SidebarSessionsPage;
  readonly sidebarGroupsCapable: boolean;
  readonly serverHomeId?: string;
  readonly filterSignature: string;
  readonly hasMoreSessions: boolean;
  readonly nextSessionCursor?: string;
  readonly rooms?: readonly RoomListItem[];
  readonly workspaces?: readonly WorkspaceCatalogEntry[];
  readonly partialFailure: boolean;
}

function buildRemoteSidebarQuery(filter: MultiSpaceSidebarFilterQuery | undefined): SidebarSessionsQuery {
  return {
    page_size: 50,
    ...(filter?.sort !== undefined ? { sort: filter.sort } : {}),
    ...(filter?.showArchived ? { include_archive: true } : {}),
    ...(filter?.includePrivate ? { include_private: true } : {}),
    ...(filter?.privateOnly ? { private_only: true } : {}),
  };
}

function filterSignatureOf(filter: MultiSpaceSidebarFilterQuery | undefined): string {
  return JSON.stringify({
    a: filter?.showArchived === true,
    ip: filter?.includePrivate === true,
    po: filter?.privateOnly === true,
    s: filter?.sort ?? 'updated_desc',
  });
}

async function fetchSpaceHead(
  targetClient: KikiClient,
  signal: AbortSignal,
  filter: MultiSpaceSidebarFilterQuery | undefined,
  metaCache: WeakMap<KikiClient, MetaResponse | null>,
): Promise<SpaceHeadResult> {
  const roomsPromise = targetClient.klient.rest?.rooms !== undefined
    ? targetClient.klient.rest.rooms.listItems()
    : undefined;
  let cachedMeta = metaCache.get(targetClient);
  if (cachedMeta === undefined) {
    try {
      cachedMeta = await targetClient.meta();
      metaCache.set(targetClient, cachedMeta);
    } catch {
      cachedMeta = null;
      metaCache.set(targetClient, null);
    }
  }
  const sidebarRest = targetClient.klient.rest?.sidebar;
  const capable = cachedMeta !== null && cachedMeta !== undefined && hasFlatSidebarSessionsCapability(cachedMeta) && sidebarRest !== undefined;
  const sig = filterSignatureOf(filter);
  const query = buildRemoteSidebarQuery(filter);

  if (capable) {
    const [unitPage, workspacesOutcome, roomsOutcome] = await Promise.all([
      sidebarRest.list(query, { signal }),
      Promise.allSettled([targetClient.listWorkspaceCatalog()]).then(([r]) => r),
      roomsPromise !== undefined
        ? Promise.allSettled([roomsPromise]).then(([r]) => r)
        : Promise.resolve({ status: 'fulfilled' as const, value: [] as RoomListItem[] }),
    ]);
    const sessions = flattenSidebarUnitsToSessions(unitPage.units);
    return {
      sessions,
      unitPage,
      sidebarGroupsCapable: true,
      serverHomeId: cachedMeta?.server_home_id,
      filterSignature: sig,
      hasMoreSessions: unitPage.has_more && unitPage.next_cursor !== undefined,
      nextSessionCursor: unitPage.has_more ? unitPage.next_cursor : undefined,
      rooms: roomsOutcome.status === 'fulfilled' ? (roomsOutcome.value ?? []) : undefined,
      workspaces: workspacesOutcome.status === 'fulfilled' ? workspacesOutcome.value.items : undefined,
      partialFailure: workspacesOutcome.status === 'rejected' || roomsOutcome.status === 'rejected',
    };
  }

  const [sessionsPage, workspacesOutcome, roomsOutcome] = await Promise.all([
    targetClient.listSessions({
      include_archive: filter?.showArchived || undefined,
      include_private: filter?.includePrivate || undefined,
      private_only: filter?.privateOnly || undefined,
    }, { signal }),
    Promise.allSettled([targetClient.listWorkspaceCatalog()]).then(([r]) => r),
    roomsPromise !== undefined
      ? Promise.allSettled([roomsPromise]).then(([r]) => r)
      : Promise.resolve({ status: 'fulfilled' as const, value: [] as RoomListItem[] }),
  ]);
  return {
    sessions: sessionsPage.items,
    sidebarGroupsCapable: false,
    serverHomeId: cachedMeta?.server_home_id,
    filterSignature: sig,
    hasMoreSessions: sessionsPage.has_more,
    nextSessionCursor: sessionsPage.has_more
      ? (sessionsPage.next_cursor ?? sessionsPage.items.at(-1)?.id)
      : undefined,
    rooms: roomsOutcome.status === 'fulfilled' ? (roomsOutcome.value ?? []) : undefined,
    workspaces: workspacesOutcome.status === 'fulfilled' ? workspacesOutcome.value.items : undefined,
    partialFailure: workspacesOutcome.status === 'rejected' || roomsOutcome.status === 'rejected',
  };
}

function mergeSpaceSnapshot(
  existing: CachedSpaceSnapshot | undefined,
  head: SpaceHeadResult,
  now: number,
  sort: SidebarSessionsSort = 'updated_desc',
): CachedSpaceSnapshot {
  const filterChanged = existing !== undefined && existing.filterSignature !== head.filterSignature;
  if (head.sidebarGroupsCapable && head.unitPage !== undefined) {
    const base = filterChanged ? undefined : existing?.unitPages;
    const mergedPages = mergeSidebarFirstPage(base, head.unitPage, sort) ?? {
      pages: [head.unitPage],
      pageParams: [undefined],
    };
    const lastPage = mergedPages.pages.at(-1);
    const dedupedUnits = dedupeSidebarUnits(mergedPages);
    return {
      sessions: flattenSidebarUnitsToSessions(dedupedUnits),
      unitPages: mergedPages,
      sidebarGroupsCapable: true,
      serverHomeId: head.serverHomeId ?? existing?.serverHomeId,
      filterSignature: head.filterSignature,
      hasMoreSessions: lastPage?.has_more === true && lastPage.next_cursor !== undefined,
      nextSessionCursor: lastPage?.has_more ? lastPage.next_cursor : undefined,
      rooms: head.rooms ?? existing?.rooms ?? [],
      workspaces: head.workspaces ?? existing?.workspaces ?? [],
      lastSyncedAt: head.partialFailure ? (existing?.lastSyncedAt ?? now) : now,
      stale: head.partialFailure,
    };
  }
  const headIds = new Set(head.sessions.map((session) => session.id));
  const olderLoaded = filterChanged ? [] : (existing?.sessions ?? []).filter((session) => !headIds.has(session.id));
  const keepOlderPagination = !filterChanged && olderLoaded.length > 0 && existing !== undefined;
  return {
    sessions: keepOlderPagination ? [...head.sessions, ...olderLoaded] : head.sessions,
    sidebarGroupsCapable: false,
    serverHomeId: head.serverHomeId ?? existing?.serverHomeId,
    filterSignature: head.filterSignature,
    hasMoreSessions: keepOlderPagination ? existing.hasMoreSessions : head.hasMoreSessions,
    nextSessionCursor: keepOlderPagination ? existing.nextSessionCursor : head.nextSessionCursor,
    rooms: head.rooms ?? existing?.rooms ?? [],
    workspaces: head.workspaces ?? existing?.workspaces ?? [],
    lastSyncedAt: head.partialFailure ? (existing?.lastSyncedAt ?? now) : now,
    stale: head.partialFailure,
  };
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const count = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        if (current !== undefined) await worker(current);
      }
    }),
  );
}

export function useMultiSpaceSessions({
  activeSessions,
  activeSidebarUnits,
  activeRooms,
  activeWorkspaces,
  sidebarFilter,
  spaceScope = ALL_SPACE_SCOPE,
  enabled = true,
}: UseMultiSpaceSessionsOptions): MultiSpaceSessionsResult {
  const host = useHost();
  const { t } = useI18n();
  const {
    client,
    localClient,
    config,
    meta,
    connectionId,
    connectionSource,
    spaceKey,
    localSpaceKey: connLocalSpaceKey,
    sshLabel,
  } = useConnection();
  const placePool = useOptionalPlaceClientPool();

  const inBrokeredScope =
    (typeof connectionId === 'string' && connectionId !== '') ||
    (typeof sshLabel === 'string' && sshLabel.length > 0) ||
    connectionSource === 'remote';
  const desktop = isDesktopHost(host);
  const controlClient = desktop ? localClient : (localClient ?? (inBrokeredScope ? null : client));
  const hasRemoteApi = controlClient?.klient?.rest?.connections !== undefined;

  const remoteQuery = useRemoteConnections(hasRemoteApi ? controlClient : null, {
    poll: enabled && hasRemoteApi,
  });
  const localSpacesQuery = useSpaces(desktop ? localClient : null);
  useSpaceStatuses(host);

  const localSpaceKey = connLocalSpaceKey ?? (inBrokeredScope ? 'main' : spaceKey);
  const here = activeSpace();
  const localSpaceEntry = (localSpacesQuery.data ?? []).find((item) => item.id === localSpaceKey);
  const localSpaceName =
    localSpaceKey === MAIN_SPACE_ID
      ? t('st.spaces.main')
      : (localSpaceEntry?.name ?? (here !== null && !here.homeId.startsWith('remote:') ? here.name : undefined) ?? localSpaceKey);

  // Self-loop guard: discard any paired remote connection whose target homeId
  // matches this local server's own server_home_id.
  const localServerHomeId = !inBrokeredScope ? meta?.server_home_id : undefined;
  const remoteRecords = useMemo(
    () => (remoteQuery.data ?? []).filter((record) =>
      hasGuiPurpose(record) &&
      (localServerHomeId === undefined || record.target.homeId !== localServerHomeId),
    ),
    [remoteQuery.data, localServerHomeId],
  );
  const onlineRemotes = useMemo(
    () => remoteRecords.filter((record) => record.enabled && record.state === 'online'),
    [remoteRecords],
  );
  const onlineRemoteSignature = useMemo(
    () => onlineRemotes.map((r) => `${r.id}:${r.target.homeId}`).toSorted().join(','),
    [onlineRemotes],
  );

  // Fallback local pool when rendered outside PlaceClientsProvider (e.g. unit tests).
  const poolRef = useRef(new Map<string, PooledRemoteEntry>());
  const metaCacheRef = useRef(new WeakMap<KikiClient, MetaResponse | null>());
  const resolvedCrossHostRef = useRef(new Map<string, string>());
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, CachedSpaceSnapshot>>(() => new Map());
  const [loadingMoreSpaces, setLoadingMoreSpaces] = useState<ReadonlySet<string>>(() => new Set());
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const loadingMoreRef = useRef(new Set<string>());
  const sidebarFilterRef = useRef(sidebarFilter);
  sidebarFilterRef.current = sidebarFilter;
  const sidebarFilterSig = filterSignatureOf(sidebarFilter);
  const sidebarFilterSigRef = useRef(sidebarFilterSig);
  sidebarFilterSigRef.current = sidebarFilterSig;

  const controlBaseUrl = controlClient?.baseUrl ?? config.url;
  const controlToken = config.token;

  useEffect(() => {
    const pool = poolRef.current;
    const desiredIds = new Set(onlineRemotes.map((r) => r.id));
    for (const [id, entry] of Array.from(pool.entries())) {
      const expectedGen = `${controlBaseUrl}|${controlToken}|${id}`;
      if (!desiredIds.has(id) || entry.generationKey !== expectedGen || !hasRemoteApi) {
        pool.delete(id);
        void entry.client.dispose?.().catch?.(() => undefined);
      }
    }
    if (placePool !== null) {
      const enabledIds = new Set(remoteRecords.filter((r) => r.enabled).map((r) => r.id));
      placePool.retainOnly(enabledIds);
    }
    // Also drop snapshots for removed/disabled remotes so revoked peers leave the stream cleanly.
    const validKeys = new Set<string>([
      localSpaceKey,
      ...remoteRecords.filter((r) => r.enabled).map((r) => remoteSpaceKey(r.id)),
    ]);
    setSnapshots((prev) => {
      let changed = false;
      for (const key of prev.keys()) {
        if (!validKeys.has(key)) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      const next = new Map(prev);
      for (const key of prev.keys()) {
        if (!validKeys.has(key)) next.delete(key);
      }
      return next;
    });
  }, [onlineRemotes, remoteRecords, controlBaseUrl, controlToken, hasRemoteApi, localSpaceKey, placePool]);

  useEffect(() => {
    const pool = poolRef.current;
    return () => {
      for (const entry of pool.values()) {
        void entry.client.dispose?.().catch?.(() => undefined);
      }
      pool.clear();
    };
  }, []);

  const getOrCreateRemoteClient = useCallback((recordId: string): KikiClient | null => {
    if (!hasRemoteApi || controlClient === null) return null;
    if (placePool !== null) {
      return placePool.getOrCreateClient(recordId);
    }
    const generationKey = `${controlBaseUrl}|${controlToken}|${recordId}`;
    const existing = poolRef.current.get(recordId);
    if (existing !== undefined && existing.generationKey === generationKey) {
      return existing.client;
    }
    if (existing !== undefined) {
      poolRef.current.delete(recordId);
      void existing.client.dispose?.().catch?.(() => undefined);
    }
    const created = createRemoteSpaceClient({
      endpoint: controlBaseUrl,
      token: controlToken,
      connectionId: recordId,
    });
    poolRef.current.set(recordId, { generationKey, client: created });
    return created;
  }, [hasRemoteApi, controlClient, controlBaseUrl, controlToken, placePool]);

  const isVerifiedActiveRemoteRecord = useCallback((record: RemoteConnection): boolean => {
    if (!inBrokeredScope || connectionId !== record.id) return false;
    return meta?.server_home_id !== undefined && meta.server_home_id === record.target.homeId;
  }, [inBrokeredScope, connectionId, meta?.server_home_id]);

  const refreshRemoteSpace = useCallback(async (recordId: string) => {
    const targetClient = getOrCreateRemoteClient(recordId);
    if (targetClient === null) return;
    const controller = new AbortController();
    const key = remoteSpaceKey(recordId);
    const filter = sidebarFilterRef.current;
    try {
      const head = await fetchSpaceHead(targetClient, controller.signal, filter, metaCacheRef.current);
      setSnapshots((prev) => {
        const next = new Map(prev);
        next.set(key, mergeSpaceSnapshot(prev.get(key), head, Date.now(), filter?.sort ?? 'updated_desc'));
        return next;
      });
    } catch {
      if (controller.signal.aborted) return;
      setSnapshots((prev) => {
        const existing = prev.get(key);
        if (existing === undefined || existing.stale) return prev;
        const next = new Map(prev);
        next.set(key, { ...existing, stale: true });
        return next;
      });
    }
  }, [getOrCreateRemoteClient]);

  // Immediately refresh a remote computer's sidebar snapshot when any mutation lands on it.
  useEffect(() => {
    if (placePool === null) return undefined;
    return placePool.subscribeMutation((mutatedConnId) => {
      void refreshRemoteSpace(mutatedConnId);
    });
  }, [placePool, refreshRemoteSpace]);

  const onlineRemotesRef = useRef(onlineRemotes);
  onlineRemotesRef.current = onlineRemotes;

  useEffect(() => {
    if (!enabled) return;
    const needRemotePoll = onlineRemotesRef.current.some((r) => !isVerifiedActiveRemoteRecord(r));
    const needLocalBackgroundPoll = inBrokeredScope && controlClient !== null;
    if (!needRemotePoll && !needLocalBackgroundPoll) return;

    const controller = new AbortController();
    let running = false;

    const pollOnce = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        const targets: Array<{ readonly key: string; readonly client: KikiClient }> = [];
        if (inBrokeredScope && controlClient !== null) {
          targets.push({ key: localSpaceKey, client: controlClient });
        }
        for (const record of onlineRemotesRef.current) {
          if (isVerifiedActiveRemoteRecord(record)) continue;
          const remoteClient = getOrCreateRemoteClient(record.id);
          if (remoteClient !== null) {
            targets.push({ key: remoteSpaceKey(record.id), client: remoteClient });
          }
        }
        await runWithConcurrency(targets, REMOTE_FETCH_CONCURRENCY, async (target) => {
          if (controller.signal.aborted) return;
          const filter = sidebarFilterRef.current;
          try {
            const head = await fetchSpaceHead(target.client, controller.signal, filter, metaCacheRef.current);
            if (controller.signal.aborted) return;
            setSnapshots((prev) => {
              const next = new Map(prev);
              next.set(target.key, mergeSpaceSnapshot(prev.get(target.key), head, Date.now(), filter?.sort ?? 'updated_desc'));
              return next;
            });
          } catch {
            if (controller.signal.aborted) return;
            setSnapshots((prev) => {
              const existing = prev.get(target.key);
              if (existing === undefined || existing.stale) return prev;
              const next = new Map(prev);
              next.set(target.key, { ...existing, stale: true });
              return next;
            });
          }
        });
      } finally {
        running = false;
      }
    };

    void pollOnce();
    const stop = startVisiblePoll({
      intervalMs: MULTI_SPACE_POLL_MS,
      task: pollOnce,
    });
    return () => {
      stop();
      controller.abort();
    };
  }, [
    enabled,
    onlineRemoteSignature,
    sidebarFilterSig,
    isVerifiedActiveRemoteRecord,
    inBrokeredScope,
    controlClient,
    localSpaceKey,
    getOrCreateRemoteClient,
  ]);

  const { sources, unitSources, healthBySpace, hasMoreBySpace, nextCursorBySpace } = useMemo(() => {
    const outSources: SpaceConversationSource[] = [];
    const outUnitSources: SidebarUnitSpaceSource[] = [];
    const outHealth = new Map<string, MultiSpaceHealth>();
    const outHasMore = new Map<string, boolean>();
    const outNextCursors = new Map<string, string>();

    const sessionsToFallbackUnits = (list: readonly Session[]): SidebarUnit[] =>
      list.map((session) => ({
        kind: 'session',
        id: session.id,
        sort_at: Date.parse(session.own_updated_at ?? session.updated_at) || 0,
        row: {
          id: session.id,
          workspace_id: session.workspace_id,
          cwd: session.metadata?.cwd,
          title: session.title,
          created_at: session.created_at,
          updated_at: session.updated_at,
          own_updated_at: session.own_updated_at ?? session.updated_at,
          archived: session.archived,
          archived_at: session.archived_at,
          private: session.private,
          pinned: session.metadata?.['kiki.pinned'] === true,
          busy: session.busy,
          executing: session.executing,
          cleanup_pending: session.cleanup_pending,
          main_turn_active: session.main_turn_active,
          pending_interaction: session.pending_interaction,
          last_turn_reason: session.last_turn_reason,
          execution_phase: session.execution_phase,
          delivery: session.delivery,
          executor_id: session.executor_id,
          persona_id: session.agent_config?.persona?.id,
          persona: session.agent_config?.persona,
          bot_persona_id: typeof session.metadata?.['bot_persona_id'] === 'string' ? session.metadata['bot_persona_id'] : undefined,
          room_persona_id: typeof session.metadata?.['room_persona_id'] === 'string' ? session.metadata['room_persona_id'] : undefined,
          room_member_of: typeof session.metadata?.['room_member_of'] === 'string' ? session.metadata['room_member_of'] : undefined,
          worktree: session.worktree,
          forked_from: session.forked_from,
          promoted_from: session.promoted_from,
          created_by_session_id: typeof session.metadata?.['created_by_session_id'] === 'string' ? session.metadata['created_by_session_id'] : undefined,
          last_seq: session.last_seq,
          attention_cursor: session.attention_cursor,
        },
      }));

    // 1. Local space (live from App when active, else cached from localClient).
    const localSnap = snapshots.get(localSpaceKey);
    const localSessions = !inBrokeredScope ? activeSessions : (localSnap?.sessions ?? []);
    const localRooms = !inBrokeredScope ? activeRooms : (localSnap?.rooms ?? []);
    const localWorkspaces = !inBrokeredScope ? activeWorkspaces : (localSnap?.workspaces ?? []);
    const localUnits = !inBrokeredScope
      ? (activeSidebarUnits ?? sessionsToFallbackUnits(activeSessions))
      : (localSnap?.unitPages !== undefined
          ? dedupeSidebarUnits(localSnap.unitPages)
          : sessionsToFallbackUnits(localSnap?.sessions ?? []));
    outSources.push({
      spaceKey: localSpaceKey,
      spaceName: localSpaceName,
      isRemote: false,
      sessions: localSessions,
      rooms: localRooms,
      workspaces: localWorkspaces,
    });
    outUnitSources.push({
      spaceKey: localSpaceKey,
      spaceName: localSpaceName,
      isRemote: false,
      serverHomeId: !inBrokeredScope ? meta?.server_home_id : localSnap?.serverHomeId,
      units: localUnits,
      rooms: localRooms,
      workspaces: localWorkspaces,
      partialCoverage: inBrokeredScope && (localSnap === undefined || localSnap.stale || localSnap.sidebarGroupsCapable === false),
    });
    if (inBrokeredScope && localSnap !== undefined) {
      outHasMore.set(localSpaceKey, localSnap.hasMoreSessions);
      if (localSnap.hasMoreSessions && localSnap.nextSessionCursor !== undefined) {
        outNextCursors.set(localSpaceKey, localSnap.nextSessionCursor);
      }
    }
    outHealth.set(localSpaceKey, {
      spaceKey: localSpaceKey,
      spaceName: localSpaceName,
      isRemote: false,
      state: !inBrokeredScope ? 'online' : localSnap?.stale ? 'stale' : 'online',
      lastSyncedAt: localSnap?.lastSyncedAt,
      color: localSpaceEntry?.color,
    });

    // 2. Paired GUI remote spaces — only reuse activeSessions on verified identity match.
    for (const record of remoteRecords) {
      if (!record.enabled) continue;
      const key = remoteSpaceKey(record.id);
      const isActiveRemote = isVerifiedActiveRemoteRecord(record);
      const snap = snapshots.get(key);
      const remoteSessions = isActiveRemote ? activeSessions : (snap?.sessions ?? []);
      const remoteRooms = isActiveRemote ? activeRooms : (snap?.rooms ?? []);
      const remoteWorkspaces = isActiveRemote ? activeWorkspaces : (snap?.workspaces ?? []);
      const remoteUnits = isActiveRemote
        ? (activeSidebarUnits ?? sessionsToFallbackUnits(activeSessions))
        : (snap?.unitPages !== undefined
            ? dedupeSidebarUnits(snap.unitPages)
            : sessionsToFallbackUnits(snap?.sessions ?? []));

      const healthState: MultiSpaceHealth['state'] =
        record.state !== 'online' && !isActiveRemote
          ? 'offline'
          : !isActiveRemote && snap?.stale === true
            ? 'stale'
            : 'online';

      if (isActiveRemote || record.state === 'online' || snap !== undefined) {
        outSources.push({
          spaceKey: key,
          spaceName: record.label,
          isRemote: true,
          sessions: remoteSessions,
          rooms: remoteRooms,
          workspaces: remoteWorkspaces,
        });
        outUnitSources.push({
          spaceKey: key,
          spaceName: record.label,
          isRemote: true,
          serverHomeId: isActiveRemote ? meta?.server_home_id : (snap?.serverHomeId ?? record.target.homeId),
          units: remoteUnits,
          rooms: remoteRooms,
          workspaces: remoteWorkspaces,
          partialCoverage: !isActiveRemote && (healthState !== 'online' || snap?.sidebarGroupsCapable === false),
        });
        if (!isActiveRemote && snap !== undefined) {
          outHasMore.set(key, snap.hasMoreSessions);
          if (snap.hasMoreSessions && snap.nextSessionCursor !== undefined) {
            outNextCursors.set(key, snap.nextSessionCursor);
          }
        }
      } else {
        // Offline paired space with no snapshot still marks All Spaces coverage partial.
        outUnitSources.push({
          spaceKey: key,
          spaceName: record.label,
          isRemote: true,
          serverHomeId: record.target.homeId,
          units: [],
          rooms: [],
          workspaces: [],
          partialCoverage: true,
        });
      }

      outHealth.set(key, {
        spaceKey: key,
        spaceName: record.label,
        isRemote: true,
        state: healthState,
        lastSyncedAt: snap?.lastSyncedAt ?? record.summary?.lastSeen,
        connectionId: record.id,
      });
    }

    return {
      sources: outSources,
      unitSources: outUnitSources,
      healthBySpace: outHealth,
      hasMoreBySpace: outHasMore,
      nextCursorBySpace: outNextCursors,
    };
  }, [
    snapshots,
    localSpaceKey,
    localSpaceName,
    localSpaceEntry?.color,
    inBrokeredScope,
    meta?.server_home_id,
    activeSessions,
    activeSidebarUnits,
    activeRooms,
    activeWorkspaces,
    remoteRecords,
    isVerifiedActiveRemoteRecord,
  ]);

  // All Spaces cross-host group resolution: batch-resolve displayed group IDs
  // on other authorized online capable sources so cross-host children beyond
  // page 1 coalesce into the displayed group without stripping origin prefixes.
  const capablePeersSig = useMemo(() => {
    const keys: string[] = [];
    for (const [key, snap] of snapshots.entries()) {
      if (snap.sidebarGroupsCapable === true) keys.push(key);
    }
    return keys.toSorted().join(',');
  }, [snapshots]);

  const crossHostGroupSig = useMemo(() => {
    if (!enabled || spaceScope !== ALL_SPACE_SCOPE || unitSources.length <= 1) return '';
    return collectCrossHostGroupIds(unitSources).slice(0, 100).toSorted().join(',');
  }, [enabled, spaceScope, unitSources]);

  useEffect(() => {
    if (!enabled || spaceScope !== ALL_SPACE_SCOPE || crossHostGroupSig === '' || capablePeersSig === '') return;
    const allGroupIds = crossHostGroupSig.split(',').filter(Boolean);
    if (allGroupIds.length === 0) return;

    const controller = new AbortController();
    const filter = sidebarFilterRef.current;
    const sort = filter?.sort ?? 'updated_desc';

    const targets: Array<{ readonly key: string; readonly client: KikiClient }> = [];
    if (inBrokeredScope && controlClient !== null) {
      const snap = snapshotsRef.current.get(localSpaceKey);
      if (snap?.sidebarGroupsCapable === true) {
        targets.push({ key: localSpaceKey, client: controlClient });
      }
    }
    for (const record of onlineRemotesRef.current) {
      if (isVerifiedActiveRemoteRecord(record)) continue;
      const key = remoteSpaceKey(record.id);
      const snap = snapshotsRef.current.get(key);
      if (snap?.sidebarGroupsCapable !== true) continue;
      const remoteClient = getOrCreateRemoteClient(record.id);
      if (remoteClient !== null) targets.push({ key, client: remoteClient });
    }

    if (targets.length === 0) return;

    void runWithConcurrency(targets, REMOTE_FETCH_CONCURRENCY, async (target) => {
      if (controller.signal.aborted) return;
      const sidebarRest = target.client.klient.rest?.sidebar;
      if (sidebarRest === undefined) return;
      const requestKey = `${target.key}|${sidebarFilterSig}|${crossHostGroupSig}`;
      if (resolvedCrossHostRef.current.get(target.key) === requestKey) return;
      resolvedCrossHostRef.current.set(target.key, requestKey);
      try {
        const resolved = await sidebarRest.resolveUnits(
          {
            group_ids: allGroupIds,
            ...(filter?.showArchived ? { include_archive: true } : {}),
            ...(filter?.includePrivate ? { include_private: true } : {}),
            ...(filter?.privateOnly ? { private_only: true } : {}),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || resolved.units.length === 0) return;
        setSnapshots((prev) => {
          const existing = prev.get(target.key);
          if (existing?.unitPages === undefined) return prev;
          const nextPages = applySidebarUnitReplacements(existing.unitPages, resolved, {
            sort,
            insertMissingAtHead: true,
          });
          if (nextPages === undefined || nextPages === existing.unitPages) return prev;
          const next = new Map(prev);
          next.set(target.key, {
            ...existing,
            unitPages: nextPages,
            sessions: flattenSidebarUnitsToSessions(dedupeSidebarUnits(nextPages)),
          });
          return next;
        });
      } catch {
        // Offline or transient failure leaves partial coverage intact.
      }
    });

    return () => { controller.abort(); };
  }, [
    enabled,
    spaceScope,
    crossHostGroupSig,
    capablePeersSig,
    sidebarFilterSig,
    inBrokeredScope,
    controlClient,
    localSpaceKey,
    isVerifiedActiveRemoteRecord,
    getOrCreateRemoteClient,
  ]);

  const loadMoreSpaceSessions = useCallback(async (targetSpaceKey: string) => {
    const currentSnap = snapshotsRef.current.get(targetSpaceKey);
    if (
      currentSnap === undefined ||
      !currentSnap.hasMoreSessions ||
      currentSnap.nextSessionCursor === undefined ||
      loadingMoreRef.current.has(targetSpaceKey)
    ) {
      return;
    }
    const targetClient = targetSpaceKey === localSpaceKey
      ? controlClient
      : targetSpaceKey.startsWith('remote:')
        ? getOrCreateRemoteClient(targetSpaceKey.slice('remote:'.length))
        : null;
    if (targetClient === null) return;

    loadingMoreRef.current.add(targetSpaceKey);
    setLoadingMoreSpaces(new Set(loadingMoreRef.current));
    const filter = sidebarFilterRef.current;
    const capturedFilterSig = sidebarFilterSigRef.current;
    const sort = filter?.sort ?? 'updated_desc';
    try {
      const sidebarRest = targetClient.klient.rest?.sidebar;
      if (currentSnap.sidebarGroupsCapable && sidebarRest !== undefined && currentSnap.unitPages !== undefined) {
        try {
          const page = await sidebarRest.list({
            ...buildRemoteSidebarQuery(filter),
            cursor: currentSnap.nextSessionCursor,
          });
          if (sidebarFilterSigRef.current !== capturedFilterSig) return;
          setSnapshots((prev) => {
            const existing = prev.get(targetSpaceKey);
            if (existing?.unitPages === undefined) return prev;
            const nextPages = appendSidebarPage(existing.unitPages, page, currentSnap.nextSessionCursor);
            const last = nextPages.pages.at(-1);
            const next = new Map(prev);
            next.set(targetSpaceKey, {
              ...existing,
              unitPages: nextPages,
              sessions: flattenSidebarUnitsToSessions(dedupeSidebarUnits(nextPages)),
              hasMoreSessions: last?.has_more === true && last.next_cursor !== undefined,
              nextSessionCursor: last?.has_more ? last.next_cursor : undefined,
            });
            return next;
          });
        } catch (cause: unknown) {
          if (sidebarFilterSigRef.current !== capturedFilterSig) return;
          if (isPageTokenMismatchError(cause)) {
            const head = await fetchSpaceHead(targetClient, new AbortController().signal, filter, metaCacheRef.current);
            if (sidebarFilterSigRef.current !== capturedFilterSig) return;
            setSnapshots((prev) => {
              const next = new Map(prev);
              next.set(targetSpaceKey, mergeSpaceSnapshot(undefined, head, Date.now(), sort));
              return next;
            });
            return;
          }
          throw cause;
        }
        return;
      }

      const page = await targetClient.listSessions({
        before_id: currentSnap.nextSessionCursor,
        include_archive: filter?.showArchived || undefined,
        include_private: filter?.includePrivate || undefined,
        private_only: filter?.privateOnly || undefined,
      });
      if (sidebarFilterSigRef.current !== capturedFilterSig) return;
      setSnapshots((prev) => {
        const existing = prev.get(targetSpaceKey);
        if (existing === undefined) return prev;
        const seenIds = new Set(existing.sessions.map((session) => session.id));
        const appended = page.items.filter((session) => !seenIds.has(session.id));
        const next = new Map(prev);
        next.set(targetSpaceKey, {
          ...existing,
          sessions: [...existing.sessions, ...appended],
          hasMoreSessions: page.has_more,
          nextSessionCursor: page.has_more
            ? (page.next_cursor ?? page.items.at(-1)?.id)
            : undefined,
        });
        return next;
      });
    } finally {
      loadingMoreRef.current.delete(targetSpaceKey);
      setLoadingMoreSpaces(new Set(loadingMoreRef.current));
    }
  }, [controlClient, getOrCreateRemoteClient, localSpaceKey]);

  const loadMoreSpaceGroupMembers = useCallback(async (targetSpaceKey: string, groupId: string, cursor: string) => {
    const targetClient = targetSpaceKey === localSpaceKey
      ? controlClient
      : targetSpaceKey.startsWith('remote:')
        ? getOrCreateRemoteClient(targetSpaceKey.slice('remote:'.length))
        : null;
    const sidebarRest = targetClient?.klient.rest?.sidebar;
    if (sidebarRest === undefined) return;
    const filter = sidebarFilterRef.current;
    const response = await sidebarRest.groupMembers(groupId, {
      cursor,
      page_size: 50,
      ...(filter?.showArchived ? { include_archive: true } : {}),
      ...(filter?.includePrivate ? { include_private: true } : {}),
      ...(filter?.privateOnly ? { private_only: true } : {}),
    });
    setSnapshots((prev) => {
      const existing = prev.get(targetSpaceKey);
      if (existing?.unitPages === undefined) return prev;
      const nextPages = appendSidebarGroupMembers(existing.unitPages, response);
      if (nextPages === undefined || nextPages === existing.unitPages) return prev;
      const next = new Map(prev);
      next.set(targetSpaceKey, {
        ...existing,
        unitPages: nextPages,
        sessions: flattenSidebarUnitsToSessions(dedupeSidebarUnits(nextPages)),
      });
      return next;
    });
  }, [controlClient, getOrCreateRemoteClient, localSpaceKey]);

  const searchAcrossSpaces = useCallback(async (
    rawQuery: string,
    scope: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly SpaceConversationSource[]> => {
    const q = rawQuery.trim();
    if (q === '') return [];

    interface SearchTarget {
      readonly spaceKey: string;
      readonly spaceName: string;
      readonly isRemote: boolean;
      readonly client: KikiClient;
      readonly workspaces: readonly WorkspaceCatalogEntry[];
    }

    const targets: SearchTarget[] = [];
    if (matchesSpaceScope(scope, localSpaceKey)) {
      const localTargetClient = !inBrokeredScope ? client : controlClient;
      if (localTargetClient !== null) {
        const localWorkspaces = !inBrokeredScope
          ? activeWorkspaces
          : (snapshotsRef.current.get(localSpaceKey)?.workspaces ?? []);
        targets.push({
          spaceKey: localSpaceKey,
          spaceName: localSpaceName,
          isRemote: false,
          client: localTargetClient,
          workspaces: localWorkspaces,
        });
      }
    }
    for (const record of remoteRecords) {
      if (!record.enabled) continue;
      const key = remoteSpaceKey(record.id);
      if (!matchesSpaceScope(scope, key)) continue;
      const isActiveRemote = isVerifiedActiveRemoteRecord(record);
      if (!isActiveRemote && record.state !== 'online') continue;
      const remoteTargetClient = isActiveRemote ? client : getOrCreateRemoteClient(record.id);
      if (remoteTargetClient === null) continue;
      const remoteWorkspaces = isActiveRemote
        ? activeWorkspaces
        : (snapshotsRef.current.get(key)?.workspaces ?? []);
      targets.push({
        spaceKey: key,
        spaceName: record.label,
        isRemote: true,
        client: remoteTargetClient,
        workspaces: remoteWorkspaces,
      });
    }

    const results: SpaceConversationSource[] = [];
    await runWithConcurrency(targets, REMOTE_FETCH_CONCURRENCY, async (target) => {
      if (signal.aborted) return;
      try {
        const sessions: Session[] = [];
        const seenIds = new Set<string>();
        let beforeId: string | undefined;
        while (!signal.aborted) {
          const page = await target.client.listSessions({ q, before_id: beforeId }, { signal });
          for (const item of page.items) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              sessions.push(item);
            }
          }
          if (!page.has_more) break;
          const nextCursor = page.next_cursor ?? page.items.at(-1)?.id;
          if (nextCursor === undefined || nextCursor === beforeId) break;
          beforeId = nextCursor;
        }
        if (signal.aborted) return;
        results.push({
          spaceKey: target.spaceKey,
          spaceName: target.spaceName,
          isRemote: target.isRemote,
          sessions,
          rooms: [],
          workspaces: target.workspaces,
        });
      } catch (error) {
        if (signal.aborted) return;
        if (targets.length === 1) throw error;
      }
    });
    return results;
  }, [
    activeWorkspaces,
    client,
    controlClient,
    getOrCreateRemoteClient,
    inBrokeredScope,
    isVerifiedActiveRemoteRecord,
    localSpaceKey,
    localSpaceName,
    remoteRecords,
  ]);

  const localSpaceCount = desktop ? Math.max(1, (localSpacesQuery.data ?? []).length) : 1;
  const hasMultipleSpaces = localSpaceCount > 1 || remoteRecords.length > 0;
  const remoteLoading = hasRemoteApi && remoteQuery.isPending && remoteQuery.data === undefined;

  const refetchRemotes = useCallback(async () => {
    if (!hasRemoteApi) return;
    await remoteQuery.refetch();
  }, [hasRemoteApi, remoteQuery]);

  return {
    sources,
    unitSources,
    healthBySpace,
    hasMoreBySpace,
    nextCursorBySpace,
    loadingMoreSpaces,
    localSpaceKey,
    localSpaceName,
    remoteConnections: remoteRecords,
    remoteLoading,
    hasMultipleSpaces,
    refetchRemotes,
    refreshRemoteSpace,
    loadMoreSpaceSessions,
    loadMoreSpaceGroupMembers,
    searchAcrossSpaces,
  };
}

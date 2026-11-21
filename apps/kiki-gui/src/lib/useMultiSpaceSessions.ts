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

import type { RemoteConnection, RoomListItem, Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import type { SpaceConversationSource } from '@kiki/session-core/sessions';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
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
  readonly rooms: readonly RoomListItem[];
  readonly workspaces: readonly WorkspaceCatalogEntry[];
  readonly lastSyncedAt: number;
  readonly stale: boolean;
}

interface PooledRemoteEntry {
  readonly generationKey: string;
  readonly client: KikiClient;
}

export interface UseMultiSpaceSessionsOptions {
  /** Currently active connection's live sessions (avoids duplicate fetch). */
  readonly activeSessions: readonly Session[];
  /** Currently active connection's live rooms. */
  readonly activeRooms: readonly RoomListItem[];
  /** Currently active connection's live workspace catalog. */
  readonly activeWorkspaces: readonly WorkspaceCatalogEntry[];
  /** Pauses background remote head polling when the sidebar is closed/inert. */
  readonly enabled?: boolean;
}

export interface MultiSpaceSessionsResult {
  readonly sources: readonly SpaceConversationSource[];
  readonly healthBySpace: ReadonlyMap<string, MultiSpaceHealth>;
  readonly localSpaceKey: string;
  readonly localSpaceName: string;
  readonly remoteConnections: readonly RemoteConnection[];
  readonly hasMultipleSpaces: boolean;
  readonly refetchRemotes: () => Promise<void>;
}

async function fetchSpaceHead(
  targetClient: KikiClient,
  signal: AbortSignal,
): Promise<{
  readonly sessions: readonly Session[];
  readonly rooms: readonly RoomListItem[];
  readonly workspaces: readonly WorkspaceCatalogEntry[];
}> {
  const [sessionsPage, workspacesRes, roomsRes] = await Promise.all([
    targetClient.listSessions({ page_size: 50 }, { signal }),
    targetClient.listWorkspaceCatalog().catch(() => ({ items: [] as WorkspaceCatalogEntry[] })),
    targetClient.klient.rest?.rooms.listItems().catch(() => [] as RoomListItem[]) ?? Promise.resolve([] as RoomListItem[]),
  ]);
  return {
    sessions: sessionsPage.items ?? [],
    rooms: roomsRes ?? [],
    workspaces: workspacesRes.items ?? [],
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
  activeRooms,
  activeWorkspaces,
  enabled = true,
}: UseMultiSpaceSessionsOptions): MultiSpaceSessionsResult {
  const host = useHost();
  const { t } = useI18n();
  const {
    client,
    localClient,
    config,
    connectionId,
    connectionSource,
    spaceKey,
    localSpaceKey: connLocalSpaceKey,
    sshLabel,
  } = useConnection();

  const inBrokeredScope =
    (typeof connectionId === 'string' && connectionId !== '') ||
    (typeof sshLabel === 'string' && sshLabel.length > 0) ||
    connectionSource === 'remote';
  const desktop = host.kind === 'tauri';
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

  const remoteRecords = useMemo(
    () => (remoteQuery.data ?? []).filter(hasGuiPurpose),
    [remoteQuery.data],
  );
  const onlineRemotes = useMemo(
    () => remoteRecords.filter((record) => record.enabled && record.state === 'online'),
    [remoteRecords],
  );
  const onlineRemoteSignature = useMemo(
    () => onlineRemotes.map((r) => `${r.id}:${r.target.homeId}`).toSorted().join(','),
    [onlineRemotes],
  );

  // Pool one lightweight remote client per online remote connection generation.
  const poolRef = useRef(new Map<string, PooledRemoteEntry>());
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, CachedSpaceSnapshot>>(() => new Map());

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
  }, [onlineRemotes, remoteRecords, controlBaseUrl, controlToken, hasRemoteApi, localSpaceKey]);

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
  }, [hasRemoteApi, controlClient, controlBaseUrl, controlToken]);

  const onlineRemotesRef = useRef(onlineRemotes);
  onlineRemotesRef.current = onlineRemotes;

  useEffect(() => {
    if (!enabled) return;
    const needRemotePoll = onlineRemotesRef.current.some((r) => r.id !== connectionId);
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
          if (record.id === connectionId) continue;
          const remoteClient = getOrCreateRemoteClient(record.id);
          if (remoteClient !== null) {
            targets.push({ key: remoteSpaceKey(record.id), client: remoteClient });
          }
        }
        await runWithConcurrency(targets, REMOTE_FETCH_CONCURRENCY, async (target) => {
          if (controller.signal.aborted) return;
          try {
            const head = await fetchSpaceHead(target.client, controller.signal);
            if (controller.signal.aborted) return;
            setSnapshots((prev) => {
              const next = new Map(prev);
              next.set(target.key, {
                sessions: head.sessions,
                rooms: head.rooms,
                workspaces: head.workspaces,
                lastSyncedAt: Date.now(),
                stale: false,
              });
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
    connectionId,
    inBrokeredScope,
    controlClient,
    localSpaceKey,
    getOrCreateRemoteClient,
  ]);

  const { sources, healthBySpace } = useMemo(() => {
    const outSources: SpaceConversationSource[] = [];
    const outHealth = new Map<string, MultiSpaceHealth>();

    // 1. Local space (live from App when active, else cached from localClient).
    const localSnap = snapshots.get(localSpaceKey);
    const localSessions = !inBrokeredScope ? activeSessions : (localSnap?.sessions ?? []);
    const localRooms = !inBrokeredScope ? activeRooms : (localSnap?.rooms ?? []);
    const localWorkspaces = !inBrokeredScope ? activeWorkspaces : (localSnap?.workspaces ?? []);
    outSources.push({
      spaceKey: localSpaceKey,
      spaceName: localSpaceName,
      isRemote: false,
      sessions: localSessions,
      rooms: localRooms,
      workspaces: localWorkspaces,
    });
    outHealth.set(localSpaceKey, {
      spaceKey: localSpaceKey,
      spaceName: localSpaceName,
      isRemote: false,
      state: !inBrokeredScope ? 'online' : localSnap?.stale ? 'stale' : 'online',
      lastSyncedAt: localSnap?.lastSyncedAt,
      color: localSpaceEntry?.color,
    });

    // 2. Paired GUI remote spaces.
    for (const record of remoteRecords) {
      if (!record.enabled) continue;
      const key = remoteSpaceKey(record.id);
      const isActiveRemote = connectionId === record.id;
      const snap = snapshots.get(key);
      const remoteSessions = isActiveRemote ? activeSessions : (snap?.sessions ?? []);
      const remoteRooms = isActiveRemote ? activeRooms : (snap?.rooms ?? []);
      const remoteWorkspaces = isActiveRemote ? activeWorkspaces : (snap?.workspaces ?? []);

      if (isActiveRemote || record.state === 'online' || snap !== undefined) {
        outSources.push({
          spaceKey: key,
          spaceName: record.label,
          isRemote: true,
          sessions: remoteSessions,
          rooms: remoteRooms,
          workspaces: remoteWorkspaces,
        });
      }

      const healthState: MultiSpaceHealth['state'] =
        record.state !== 'online' && !isActiveRemote
          ? 'offline'
          : !isActiveRemote && snap?.stale === true
            ? 'stale'
            : 'online';
      outHealth.set(key, {
        spaceKey: key,
        spaceName: record.label,
        isRemote: true,
        state: healthState,
        lastSyncedAt: snap?.lastSyncedAt ?? record.summary?.lastSeen,
        connectionId: record.id,
      });
    }

    return { sources: outSources, healthBySpace: outHealth };
  }, [
    snapshots,
    localSpaceKey,
    localSpaceName,
    localSpaceEntry?.color,
    inBrokeredScope,
    activeSessions,
    activeRooms,
    activeWorkspaces,
    remoteRecords,
    connectionId,
  ]);

  const localSpaceCount = desktop ? Math.max(1, (localSpacesQuery.data ?? []).length) : 1;
  const hasMultipleSpaces = localSpaceCount > 1 || remoteRecords.length > 0;

  const refetchRemotes = useCallback(async () => {
    if (!hasRemoteApi) return;
    await remoteQuery.refetch();
  }, [hasRemoteApi, remoteQuery]);

  return {
    sources,
    healthBySpace,
    localSpaceKey,
    localSpaceName,
    remoteConnections: remoteRecords,
    hasMultipleSpaces,
    refetchRemotes,
  };
}

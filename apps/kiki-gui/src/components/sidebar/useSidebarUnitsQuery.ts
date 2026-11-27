/**
 * Capability-gated Sidebar Unit Query & Live Cache Reconciler (`GET /api/sidebar/sessions`).
 *
 * Keeps server traversal cursors strictly separate from rendered positions,
 * patches `session.workChanged` in place with structural sharing, coalesces
 * `session.metaUpdated` / `session.created` hints into revisioned
 * `POST /api/sidebar/units:resolve` calls, rebases cleanly on `40922`
 * `PAGE_TOKEN_MISMATCH` or generation mismatch, and supports `groupMembers`
 * continuation + per-session `detachGroup`.
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SidebarSessionsPage,
  SidebarSessionsQuery,
  SidebarSessionsSort,
  SidebarUnit,
} from '@kiki/protocol';
import {
  appendSidebarGroupMembers,
  appendSidebarPage,
  applySidebarUnitReplacements,
  isPageTokenMismatchError,
  mergeSidebarFirstPage,
  patchSidebarUnitWorkChanged,
  withPinnedSidebarUnits,
  type SessionWorkChangedPatch,
  type SidebarUnitPagesData,
} from '@kiki/session-core/sessions';
import { interactiveInputRemainingMs } from '@kiki/session-core/session';
import type { SessionPrivateFilter } from '@kiki/session-core/settings';
import type { KikiClient } from '../../lib/client';
import { retryRootReadModelDelay, retryRootReadModelQuery } from '../../lib/readModelRetry';
import { startVisiblePoll } from '../../lib/visiblePoll';

const SIDEBAR_PAGE_SIZE = 50;
const SIDEBAR_PINNED_PAGE_SIZE = 100;
const SIDEBAR_PINNED_MAX_PAGES = 20;
const WORK_CHANGED_BURST_MS = 120;
const META_COALESCE_MS = 60;
const HEAD_SAFETY_POLL_MS = 120_000;
const HEAD_OFFLINE_POLL_MS = 15_000;

export function sidebarUnitsQueryKey(
  showArchived: boolean,
  workspaceFilter: string | undefined,
  privateFilter: SessionPrivateFilter,
  sort: SidebarSessionsSort,
) {
  return ['sessions', 'sidebar-units', showArchived, workspaceFilter ?? null, privateFilter, sort] as const;
}

export function sidebarPinnedUnitsQueryKey(
  showArchived: boolean,
  workspaceFilter: string | undefined,
  privateFilter: SessionPrivateFilter,
) {
  return ['sessions', 'sidebar-units-pinned', showArchived, workspaceFilter ?? null, privateFilter] as const;
}

export interface UseSidebarUnitsQueryOptions {
  readonly enabled: boolean;
  readonly client: KikiClient;
  readonly wsStatus: string;
  readonly showArchived: boolean;
  readonly workspaceFilter: string | undefined;
  readonly privateFilter: SessionPrivateFilter;
  readonly sort: SidebarSessionsSort;
  readonly pinnedEnabled: boolean;
}

export interface SidebarUnitsController {
  readonly units: readonly SidebarUnit[];
  readonly listData: SidebarUnitPagesData | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly hasNextPage: boolean;
  readonly nextCursor: string | undefined;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
  readonly loadMoreGroupMembers: (groupId: string, cursor: string) => Promise<void>;
  readonly loadingGroupIds: ReadonlySet<string>;
  readonly groupMemberErrors: ReadonlyMap<string, string>;
  readonly detachGroupMember: (sessionId: string) => Promise<{ readonly previousGroupId?: string }>;
  readonly rebaseHead: () => Promise<void>;
  readonly queryGenerationKey: string;
}

function buildFilterQuery(
  showArchived: boolean,
  workspaceFilter: string | undefined,
  privateFilter: SessionPrivateFilter,
): Omit<SidebarSessionsQuery, 'cursor' | 'page_size' | 'sort'> {
  const includePrivate = privateFilter === 'include' || privateFilter === 'only';
  const privateOnly = privateFilter === 'only';
  return {
    ...(showArchived ? { include_archive: true } : {}),
    ...(includePrivate ? { include_private: true } : {}),
    ...(privateOnly ? { private_only: true } : {}),
    ...(workspaceFilter !== undefined ? { workspace_id: workspaceFilter } : {}),
  };
}

export function useSidebarUnitsQuery({
  enabled,
  client,
  wsStatus,
  showArchived,
  workspaceFilter,
  privateFilter,
  sort,
  pinnedEnabled,
}: UseSidebarUnitsQueryOptions): SidebarUnitsController {
  const queryClient = useQueryClient();
  const listKey = useMemo(
    () => sidebarUnitsQueryKey(showArchived, workspaceFilter, privateFilter, sort),
    [showArchived, workspaceFilter, privateFilter, sort],
  );
  const pinnedKey = useMemo(
    () => sidebarPinnedUnitsQueryKey(showArchived, workspaceFilter, privateFilter),
    [showArchived, workspaceFilter, privateFilter],
  );
  const filterQuery = useMemo(
    () => buildFilterQuery(showArchived, workspaceFilter, privateFilter),
    [showArchived, workspaceFilter, privateFilter],
  );

  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);
  const [loadingGroupIds, setLoadingGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  const [groupMemberErrors, setGroupMemberErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [rebaseCounter, setRebaseCounter] = useState(0);

  const nextFlightRef = useRef<AbortController | null>(null);
  const groupFlightsRef = useRef(new Set<string>());
  const generationSeqRef = useRef(0);

  useEffect(() => {
    generationSeqRef.current += 1;
    nextFlightRef.current?.abort();
    nextFlightRef.current = null;
    setIsFetchingNextPage(false);
    setLoadingGroupIds(new Set());
    setGroupMemberErrors(new Map());
  }, [listKey]);

  const listQuery = useQuery<SidebarUnitPagesData>({
    queryKey: listKey,
    enabled,
    staleTime: 15_000,
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
    queryFn: async ({ signal }): Promise<SidebarUnitPagesData> => {
      const rest = client.klient?.rest?.sidebar;
      if (rest === undefined) {
        throw new Error('Sidebar units endpoint is unavailable on this transport');
      }
      const first = await rest.list(
        { page_size: SIDEBAR_PAGE_SIZE, sort, ...filterQuery },
        { signal },
      );
      const existing = queryClient.getQueryData<SidebarUnitPagesData>(listKey);
      if (existing !== undefined && existing.pages.length > 0) {
        return mergeSidebarFirstPage(existing, first, sort) ?? {
          pages: [first],
          pageParams: [undefined],
        };
      }
      return mergeSidebarFirstPage(undefined, first, sort)!;
    },
  });

  const pinnedQuery = useQuery<SidebarUnitPagesData>({
    queryKey: pinnedKey,
    enabled: enabled && pinnedEnabled,
    staleTime: 15_000,
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
    queryFn: async ({ signal }): Promise<SidebarUnitPagesData> => {
      const rest = client.klient?.rest?.sidebar;
      if (rest === undefined) {
        return { pages: [{ revision: 0, units: [], has_more: false }], pageParams: [undefined] };
      }
      const collected: SidebarUnit[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let revision = 0;
      let generation: number | undefined;
      for (let pageIndex = 0; pageIndex < SIDEBAR_PINNED_MAX_PAGES; pageIndex += 1) {
        signal.throwIfAborted();
        const page = await rest.list(
          { page_size: SIDEBAR_PINNED_PAGE_SIZE, pinned: true, cursor, ...filterQuery },
          { signal },
        );
        revision = Math.max(revision, page.revision);
        generation = page.generation ?? generation;
        collected.push(...page.units);
        if (!page.has_more || page.next_cursor === undefined || seenCursors.has(page.next_cursor)) break;
        seenCursors.add(page.next_cursor);
        cursor = page.next_cursor;
      }
      const combined: SidebarSessionsPage = {
        revision,
        ...(generation !== undefined ? { generation } : {}),
        units: collected,
        has_more: false,
      };
      return mergeSidebarFirstPage(undefined, combined, 'updated_desc')!;
    },
  });

  const rebaseHead = useCallback(async () => {
    const rest = client.klient?.rest?.sidebar;
    if (!enabled || rest === undefined) return;
    nextFlightRef.current?.abort();
    nextFlightRef.current = null;
    generationSeqRef.current += 1;
    setIsFetchingNextPage(false);
    const first = await rest.list({ page_size: SIDEBAR_PAGE_SIZE, sort, ...filterQuery });
    startTransition(() => {
      queryClient.setQueryData<SidebarUnitPagesData>(
        listKey,
        () => mergeSidebarFirstPage(undefined, first, sort)!,
      );
      setRebaseCounter((n) => n + 1);
    });
  }, [client, enabled, filterQuery, listKey, queryClient, sort]);

  const fetchNextPage = useCallback(async () => {
    const rest = client.klient?.rest?.sidebar;
    if (!enabled || rest === undefined) return;
    const current = queryClient.getQueryData<SidebarUnitPagesData>(listKey);
    const lastPage = current?.pages.at(-1);
    if (lastPage === undefined || !lastPage.has_more || lastPage.next_cursor === undefined) return;
    if (nextFlightRef.current !== null) return;

    const cursor = lastPage.next_cursor;
    const capturedGen = generationSeqRef.current;
    const controller = new AbortController();
    nextFlightRef.current = controller;
    setIsFetchingNextPage(true);
    try {
      const page = await rest.list(
        { page_size: SIDEBAR_PAGE_SIZE, sort, cursor, ...filterQuery },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || generationSeqRef.current !== capturedGen) return;
      const latest = queryClient.getQueryData<SidebarUnitPagesData>(listKey);
      const existingGen = latest?.pages[0]?.generation;
      if (page.generation !== undefined && existingGen !== undefined && page.generation !== existingGen) {
        await rebaseHead();
        return;
      }
      startTransition(() => {
        queryClient.setQueryData<SidebarUnitPagesData>(
          listKey,
          (old) => appendSidebarPage(old, page, cursor),
        );
      });
    } catch (error: unknown) {
      if (controller.signal.aborted || generationSeqRef.current !== capturedGen) return;
      if (isPageTokenMismatchError(error)) {
        await rebaseHead();
        return;
      }
      throw error;
    } finally {
      if (nextFlightRef.current === controller) {
        nextFlightRef.current = null;
      }
      if (generationSeqRef.current === capturedGen) {
        setIsFetchingNextPage(false);
      }
    }
  }, [client, enabled, filterQuery, listKey, queryClient, rebaseHead, sort]);

  const loadMoreGroupMembers = useCallback(async (groupId: string, cursor: string) => {
    const rest = client.klient?.rest?.sidebar;
    if (!enabled || rest === undefined) return;
    if (groupFlightsRef.current.has(groupId)) return;
    groupFlightsRef.current.add(groupId);
    setLoadingGroupIds(new Set(groupFlightsRef.current));
    setGroupMemberErrors((prev) => {
      if (!prev.has(groupId)) return prev;
      const next = new Map(prev);
      next.delete(groupId);
      return next;
    });
    const capturedGen = generationSeqRef.current;
    try {
      const response = await rest.groupMembers(groupId, { cursor, page_size: 50, ...filterQuery });
      if (generationSeqRef.current !== capturedGen) return;
      startTransition(() => {
        queryClient.setQueryData<SidebarUnitPagesData>(listKey, (old) => appendSidebarGroupMembers(old, response));
        queryClient.setQueryData<SidebarUnitPagesData>(pinnedKey, (old) => appendSidebarGroupMembers(old, response));
      });
    } catch (cause: unknown) {
      if (generationSeqRef.current !== capturedGen) return;
      if (isPageTokenMismatchError(cause)) {
        const resolved = await rest.resolveUnits({ group_ids: [groupId], ...filterQuery }).catch(() => undefined);
        if (resolved !== undefined && generationSeqRef.current === capturedGen) {
          startTransition(() => {
            queryClient.setQueryData<SidebarUnitPagesData>(
              listKey,
              (old) => applySidebarUnitReplacements(old, resolved, { sort }),
            );
            queryClient.setQueryData<SidebarUnitPagesData>(
              pinnedKey,
              (old) => applySidebarUnitReplacements(old, resolved, { sort: 'updated_desc', insertMissingAtHead: false }),
            );
          });
        }
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setGroupMemberErrors((prev) => new Map(prev).set(groupId, message));
    } finally {
      groupFlightsRef.current.delete(groupId);
      if (generationSeqRef.current === capturedGen) {
        setLoadingGroupIds(new Set(groupFlightsRef.current));
      }
    }
  }, [client, enabled, filterQuery, listKey, pinnedKey, queryClient, sort]);

  const detachGroupMember = useCallback(async (sessionId: string) => {
    const rest = client.klient?.rest;
    if (rest === undefined) {
      throw new Error('Session detach is unavailable on this transport');
    }
    const receipt = await rest.sessions.detachGroup(sessionId);
    const previousGroupId = receipt.previous_group_id;
    const resolved = await rest.sidebar.resolveUnits({
      session_ids: [sessionId],
      ...(previousGroupId !== undefined ? { group_ids: [previousGroupId] } : {}),
      ...filterQuery,
    });
    queryClient.setQueryData<SidebarUnitPagesData>(
      listKey,
      (old) => applySidebarUnitReplacements(old, resolved, { sort }),
    );
    queryClient.setQueryData<SidebarUnitPagesData>(
      pinnedKey,
      (old) => applySidebarUnitReplacements(old, resolved, { sort: 'updated_desc', insertMissingAtHead: false }),
    );
    return { previousGroupId };
  }, [client, filterQuery, listKey, pinnedKey, queryClient, sort]);

  // Live WS reconciliation: workChanged patches status in place without reorder;
  // metaUpdated / created coalesces into revisioned `resolveUnits` replacements.
  useEffect(() => {
    if (!enabled) return undefined;
    const rest = client.klient?.rest?.sidebar;
    const events = client.klient?.events;
    if (rest === undefined) return undefined;

    const controller = new AbortController();
    const pendingWork = new Map<string, SessionWorkChangedPatch>();
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    let lastWorkFlushAt = 0;

    const applyWorkBatch = (batch: readonly SessionWorkChangedPatch[]) => {
      if (controller.signal.aborted || batch.length === 0) return;
      lastWorkFlushAt = Date.now();
      startTransition(() => {
        queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units'] }, (old) => {
          let next = old;
          for (const change of batch) next = patchSidebarUnitWorkChanged(next, change);
          return next;
        });
        queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units-pinned'] }, (old) => {
          let next = old;
          for (const change of batch) next = patchSidebarUnitWorkChanged(next, change);
          return next;
        });
      });
    };

    const flushWork = () => {
      workTimer = undefined;
      if (controller.signal.aborted || pendingWork.size === 0) return;
      const typingDelay = interactiveInputRemainingMs();
      if (typingDelay > 0) {
        workTimer = setTimeout(flushWork, typingDelay);
        return;
      }
      const batch = [...pendingWork.values()];
      pendingWork.clear();
      applyWorkBatch(batch);
    };

    const dirtySessionIds = new Set<string>();
    let resolveTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveInFlight = false;

    const flushResolve = async () => {
      resolveTimer = undefined;
      if (controller.signal.aborted || resolveInFlight || dirtySessionIds.size === 0) return;
      const typingDelay = interactiveInputRemainingMs();
      if (typingDelay > 0) {
        resolveTimer = setTimeout(() => { void flushResolve(); }, typingDelay);
        return;
      }
      const ids = [...dirtySessionIds].slice(0, 100);
      for (const id of ids) dirtySessionIds.delete(id);
      resolveInFlight = true;
      try {
        const resolved = await rest.resolveUnits(
          { session_ids: ids, ...filterQuery },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const currentList = queryClient.getQueryData<SidebarUnitPagesData>(listKey);
        const existingGen = currentList?.pages[0]?.generation;
        if (resolved.generation !== undefined && existingGen !== undefined && resolved.generation > existingGen) {
          await rebaseHead();
          return;
        }
        startTransition(() => {
          queryClient.setQueryData<SidebarUnitPagesData>(
            listKey,
            (old) => applySidebarUnitReplacements(old, resolved, { sort }),
          );
          queryClient.setQueryData<SidebarUnitPagesData>(
            pinnedKey,
            (old) => {
              const pinnedUnits = resolved.units.filter((u) =>
                u.kind === 'session' ? u.row.pinned === true : u.has_pinned === true,
              );
              return applySidebarUnitReplacements(
                old,
                {
                  ...resolved,
                  units: pinnedUnits,
                  missing_session_ids: [
                    ...resolved.missing_session_ids,
                    ...resolved.units
                      .filter((u) => u.kind === 'session' && u.row.pinned !== true)
                      .map((u) => u.id),
                  ],
                  missing_group_ids: [
                    ...resolved.missing_group_ids,
                    ...resolved.units
                      .filter((u) => u.kind === 'group' && u.has_pinned !== true)
                      .map((u) => u.id),
                  ],
                },
                { sort: 'updated_desc', insertMissingAtHead: true },
              );
            },
          );
        });
      } catch {
        // Bounded safety head poll repairs transient resolve failures without dropping loaded pages.
      } finally {
        resolveInFlight = false;
        if (!controller.signal.aborted && dirtySessionIds.size > 0 && resolveTimer === undefined) {
          resolveTimer = setTimeout(() => { void flushResolve(); }, META_COALESCE_MS);
        }
      }
    };

    const scheduleResolve = (sessionId: string) => {
      if (sessionId === '' || controller.signal.aborted) return;
      dirtySessionIds.add(sessionId);
      if (resolveTimer === undefined && !resolveInFlight) {
        resolveTimer = setTimeout(() => { void flushResolve(); }, META_COALESCE_MS);
      }
    };

    const runHeadRefresh = async () => {
      if (controller.signal.aborted) return;
      try {
        const first = await rest.list(
          { page_size: SIDEBAR_PAGE_SIZE, sort, ...filterQuery },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        startTransition(() => {
          queryClient.setQueryData<SidebarUnitPagesData>(
            listKey,
            (old) => mergeSidebarFirstPage(old, first, sort),
          );
        });
      } catch {
        // Transient poll failures preserve existing pages.
      }
    };

    const subscriptions = events === undefined
      ? []
      : [
          events.on('session.workChanged', (change) => {
            const typingDelay = interactiveInputRemainingMs();
            const burstDelay = lastWorkFlushAt > 0
              ? Math.max(0, WORK_CHANGED_BURST_MS - (Date.now() - lastWorkFlushAt))
              : 0;
            const delay = Math.max(typingDelay, burstDelay);
            if (delay <= 0 && pendingWork.size === 0 && workTimer === undefined) {
              applyWorkBatch([change]);
            } else {
              pendingWork.set(change.sessionId, change);
              if (workTimer === undefined) workTimer = setTimeout(flushWork, delay);
            }
            // If an unloaded session starts working, resolve it once so it surfaces cleanly.
            const loaded = queryClient.getQueryData<SidebarUnitPagesData>(listKey);
            const known = loaded?.pages.some((page) =>
              page.units.some((unit) =>
                unit.kind === 'session'
                  ? unit.row.id === change.sessionId
                  : unit.members.some((m) => m.id === change.sessionId),
              ),
            ) ?? false;
            if (!known) scheduleResolve(change.sessionId);
          }),
          events.on('session.created', (event) => {
            scheduleResolve(event.sessionId);
            void queryClient.invalidateQueries({ queryKey: ['sessions', 'ephemeral'] });
          }),
          events.on('session.metaUpdated', (event) => {
            scheduleResolve(event.sessionId);
            if (queryClient.getQueryData(['session', event.sessionId]) !== undefined) {
              void queryClient.invalidateQueries({ queryKey: ['session', event.sessionId] });
            }
          }),
          events.on('personas.changed', () => {
            void runHeadRefresh();
          }),
        ];

    const stopPoll = startVisiblePoll({
      intervalMs: wsStatus === 'open' ? HEAD_SAFETY_POLL_MS : HEAD_OFFLINE_POLL_MS,
      task: runHeadRefresh,
    });

    return () => {
      stopPoll();
      controller.abort();
      if (workTimer !== undefined) clearTimeout(workTimer);
      if (resolveTimer !== undefined) clearTimeout(resolveTimer);
      for (const sub of subscriptions) sub.dispose();
    };
  }, [client, enabled, filterQuery, listKey, pinnedKey, queryClient, rebaseHead, sort, wsStatus]);

  // Rebase head on WS reconnect after a disconnect so missed events never leave stale gaps.
  const prevWsRef = useRef(wsStatus);
  useEffect(() => {
    const prev = prevWsRef.current;
    prevWsRef.current = wsStatus;
    if (enabled && wsStatus === 'open' && prev !== 'open' && listQuery.data !== undefined) {
      void rebaseHead().catch(() => undefined);
    }
  }, [enabled, wsStatus, listQuery.data, rebaseHead]);

  const units = useMemo(
    () => withPinnedSidebarUnits(listQuery.data, pinnedQuery.data),
    [listQuery.data, pinnedQuery.data],
  );
  const lastPage = listQuery.data?.pages.at(-1);
  const hasNextPage = lastPage?.has_more === true && lastPage.next_cursor !== undefined;
  const nextCursor = hasNextPage ? lastPage.next_cursor : undefined;
  const queryGenerationKey = `${JSON.stringify(listKey)}:${rebaseCounter}`;

  return {
    units,
    listData: listQuery.data,
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
    error: listQuery.error,
    hasNextPage,
    nextCursor,
    isFetchingNextPage,
    fetchNextPage,
    loadMoreGroupMembers,
    loadingGroupIds,
    groupMemberErrors,
    detachGroupMember,
    rebaseHead,
    queryGenerationKey,
  };
}

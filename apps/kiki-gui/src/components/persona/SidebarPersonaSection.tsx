/**
 * SidebarPersonaSection: the sidebar's persona group.
 *
 * One row per persona in a fixed, user-draggable order persisted in
 * `localStorage` (`kiki.sidebar.personaOrder`). Conversations are resolved per
 * persona from the server merged with live client sessions so cold threads
 * outside the global sidebar page remain visible, and expanding a persona's
 * conversations always unfolds inline right beneath its row without opening a
 * duplicate floating popover.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { PersonaSummary, RoomListItem, Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import { isPinnedSession, sessionRowState } from '@kiki/session-core/sessions';
import { setSidebarPersonaSectionCollapsed, type SessionSeenMap } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { BOTS_QUERY_KEY } from '../../lib/botRooms';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { invalidatePersonaSessionLists } from '../../lib/personaFreshness';
import { useConnection } from '../../state/connection';
import { useGuardedNavigate } from '../dirtyGuard';
import { DisclosureChevron, Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { CreateRoomDialog } from '../room/CreateRoomDialog';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';
import { personaNewConversationUrl } from './personaNavigation';
import {
  compactPersonaThreadTitle,
  mergePersonaConversations,
  sessionMatchesPrivateFilter,
  sessionPersonaId,
} from './personaSessionUtils';
import { usePersonaSessionHeads } from './usePersonaSwitcherConversations';
import { usePersonaDirectory, type PersonaDirectoryEntry } from './usePersonaDirectory';
import { invalidatePersonas } from './usePersonas';

/** Default preview cap when the persona section is expanded. */
export const SIDEBAR_PERSONA_PREVIEW_LIMIT = 8;
/** Inline non-home topic/room conversations surfaced by default before "+N more". */
export const SIDEBAR_PERSONA_INLINE_THREAD_LIMIT = 2;
/** Persisted user-chosen sidebar persona ordering. */
export const SIDEBAR_PERSONA_ORDER_KEY = 'kiki.sidebar.personaOrder';

interface InlinePersonaThread {
  readonly id: string;
  readonly kind: 'topic' | 'room';
  readonly shortTitle: string;
  readonly fullTitle: string;
  readonly life: 'idle' | 'working' | 'waiting' | 'done';
  readonly isCurrent: boolean;
  readonly needsYou: boolean;
  readonly pinned: boolean;
  readonly updatedAt?: string;
  readonly targetUrl: string;
}

function threadLifeOf(state: ReturnType<typeof sessionRowState>): InlinePersonaThread['life'] {
  return state === 'needs-me' ? 'waiting' : state === 'running' ? 'working' : state === 'unread' ? 'done' : 'idle';
}

function rawThreadTitle(session: Session, untitled: string): string {
  if (session.title !== undefined && session.title.trim() !== '') return session.title;
  if (session.last_prompt !== undefined && session.last_prompt.trim() !== '') return session.last_prompt;
  return untitled;
}

const GROUP_HEAD = 'flex h-7 items-center gap-0.5 pr-1 pl-1';
const HEAD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';
const HOVER_ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink';

function activeRoutePersonaId(pathname: string, search: string): string | undefined {
  const dailyMatch = /^\/p\/([^/]+)\/daily(?:\/|$)/.exec(pathname);
  if (dailyMatch?.[1] !== undefined) {
    try { return decodeURIComponent(dailyMatch[1]); } catch { return dailyMatch[1]; }
  }
  if (pathname === '/personas' || pathname === '/new') {
    const param = new URLSearchParams(search).get('persona')?.trim();
    if (param !== undefined && param !== '') return param;
  }
  return undefined;
}

export function readSavedPersonaOrder(): string[] {
  try {
    const raw = localStorage.getItem(SIDEBAR_PERSONA_ORDER_KEY);
    if (raw === null || raw === '') return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'string' && entry.trim() !== '' && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeSavedPersonaOrder(order: readonly string[]): void {
  try {
    localStorage.setItem(SIDEBAR_PERSONA_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Ignore storage quota or sandbox errors.
  }
}

/**
 * Order visible sidebar personas deterministically without jumping rows when
 * activity, unread count, pin state, or active selection changes. Respects the
 * user's persisted drag order and appends newly discovered personas at the end.
 */
export function orderSidebarPersonas(
  items: readonly PersonaDirectoryEntry[],
  savedOrder: readonly string[] = [],
): PersonaDirectoryEntry[] {
  const visible = items.filter((item) => !item.hidden);
  if (savedOrder.length === 0) return visible;
  const rank = new Map<string, number>();
  savedOrder.forEach((id, index) => { rank.set(id, index); });
  const prioritized: PersonaDirectoryEntry[] = [];
  const rest: PersonaDirectoryEntry[] = [];
  for (const item of visible) {
    if (rank.has(item.id)) prioritized.push(item);
    else rest.push(item);
  }
  prioritized.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...prioritized, ...rest];
}

export function reorderPersonaIds(
  currentIds: readonly string[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): string[] {
  if (draggedId === targetId) return [...currentIds];
  const fromIndex = currentIds.indexOf(draggedId);
  const toIndex = currentIds.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0) return [...currentIds];
  const next = currentIds.filter((id) => id !== draggedId);
  const anchorIndex = next.indexOf(targetId);
  if (anchorIndex < 0) return [...currentIds];
  const insertAt = position === 'before' ? anchorIndex : anchorIndex + 1;
  next.splice(insertAt, 0, draggedId);
  return next;
}

export interface SidebarPersonaSectionProps {
  readonly sessions: readonly Session[];
  readonly activeSessionId?: string;
  readonly seen: SessionSeenMap;
  readonly workspaceOptions?: readonly WorkspaceCatalogEntry[];
  /** Room names for member rows; the ids are what the row opens. */
  readonly rooms?: readonly RoomListItem[];
}

export function SidebarPersonaSection({
  sessions,
  activeSessionId,
  seen,
  rooms = [],
}: SidebarPersonaSectionProps) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { client } = useConnection();
  const layoutPrefs = useLayoutPreferences();
  const collapsed = layoutPrefs.sidebarPersonaSectionCollapsed === true;
  const privateFilter = layoutPrefs.filters.private ?? 'hide';

  const filteredSessions = useMemo(
    () => sessions.filter((item) => sessionMatchesPrivateFilter(item, privateFilter)),
    [privateFilter, sessions],
  );

  const { directory } = usePersonaDirectory({ sessions: filteredSessions, seen });
  const [savedOrder, setSavedOrder] = useState<readonly string[]>(readSavedPersonaOrder);
  const [showAllPersonas, setShowAllPersonas] = useState(false);
  const [expandedOverrides, setExpandedOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [showAllThreadsFor, setShowAllThreadsFor] = useState<Readonly<Record<string, boolean>>>({});
  const [rowMenu, setRowMenu] = useState<{ persona: PersonaDirectoryEntry; x: number; y: number } | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);

  const visiblePersonas = useMemo(
    () => orderSidebarPersonas(directory, savedOrder),
    [directory, savedOrder],
  );
  const hasOverflow = visiblePersonas.length > SIDEBAR_PERSONA_PREVIEW_LIMIT;
  const shownPersonas = useMemo(
    () => (!hasOverflow || showAllPersonas
      ? visiblePersonas
      : visiblePersonas.slice(0, SIDEBAR_PERSONA_PREVIEW_LIMIT)),
    [hasOverflow, showAllPersonas, visiblePersonas],
  );
  const hiddenMoreCount = Math.max(0, visiblePersonas.length - SIDEBAR_PERSONA_PREVIEW_LIMIT);

  const headsQuery = usePersonaSessionHeads({
    enabled: !collapsed && visiblePersonas.length > 0,
    perPersonaLimit: 10,
    privateFilter,
  });

  const serverSessionsByPersona = useMemo(() => {
    const map = new Map<string, readonly Session[] | undefined>();
    const heads = headsQuery.data;
    if (heads !== undefined) {
      for (const persona of visiblePersonas) {
        const head = heads[persona.id];
        if (head !== undefined) {
          map.set(
            persona.id,
            head.items.filter((item) => sessionMatchesPrivateFilter(item, privateFilter)),
          );
        }
      }
    }
    return map;
  }, [headsQuery.data, privateFilter, visiblePersonas]);

  const personaMembershipSig = useMemo(() => {
    if (sessions.length === 0) return null;
    const tokens: string[] = [];
    for (const item of sessions) {
      const pid = sessionPersonaId(item);
      if (pid !== undefined) {
        tokens.push(`${pid}:${item.id}:${item.archived === true ? 1 : 0}:${item.private === true ? 1 : 0}:${item.title ?? ''}`);
      }
    }
    tokens.sort();
    return tokens.join('|');
  }, [sessions]);

  const prevMembershipSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (personaMembershipSig === null) return;
    if (prevMembershipSigRef.current === null) {
      prevMembershipSigRef.current = personaMembershipSig;
      return;
    }
    if (prevMembershipSigRef.current !== personaMembershipSig) {
      prevMembershipSigRef.current = personaMembershipSig;
      invalidatePersonaSessionLists(queryClient);
    }
  }, [personaMembershipSig, queryClient]);

  const currentWorkspaceId = useMemo(
    () => sessions.find((item) => item.id === activeSessionId)?.workspace_id,
    [activeSessionId, sessions],
  );

  const activePersonaId = useMemo(() => {
    const fromRoute = activeRoutePersonaId(location.pathname, location.search);
    if (fromRoute !== undefined) return fromRoute;
    if (activeSessionId === undefined) return undefined;
    const byHome = directory.find((entry) => entry.homeSessionId === activeSessionId);
    if (byHome !== undefined) return byHome.id;
    const openSession = sessions.find((session) => session.id === activeSessionId);
    if (openSession !== undefined) return sessionPersonaId(openSession);
    for (const [personaId, serverItems] of serverSessionsByPersona) {
      if (serverItems?.some((item) => item.id === activeSessionId)) return personaId;
    }
    return undefined;
  }, [location.pathname, location.search, activeSessionId, directory, sessions, serverSessionsByPersona]);

  const roomNames = useMemo(() => new Map(rooms.map((room) => [room.id, room.title])), [rooms]);
  const globalSessionIds = useMemo(() => new Set(filteredSessions.map((item) => item.id)), [filteredSessions]);
  const rawSessionsById = useMemo(() => new Map(sessions.map((item) => [item.id, item])), [sessions]);

  const personaThreadStats = useMemo(() => {
    const map = new Map<string, {
      readonly extraThreads: readonly InlinePersonaThread[];
      readonly totalConversations: number;
      readonly totalNonHomeConversations: number;
      readonly unreadIds: readonly string[];
      readonly unreadCount: number;
      readonly life: PersonaDirectoryEntry['life'];
    }>();
    if (visiblePersonas.length === 0) return map;
    const untitled = t('sidebar.untitled');
    const heads = headsQuery.data;
    for (const persona of visiblePersonas) {
      const headBucket = heads?.[persona.id];
      const serverItems = serverSessionsByPersona.get(persona.id);
      const merged = mergePersonaConversations(serverItems, filteredSessions, persona.id).filter(
        (item) => !item.archived && sessionMatchesPrivateFilter(item, privateFilter),
      );
      const hasFilteredOutOwned = sessions.some(
        (item) => !item.archived
          && (sessionPersonaId(item) === persona.id || item.id === persona.homeSessionId)
          && !sessionMatchesPrivateFilter(item, privateFilter),
      ) || (headBucket?.items.some((item) => !sessionMatchesPrivateFilter(item, privateFilter)) ?? false);

      const allowedUnreadSeed = persona.unreadSessionIds.filter((id) => {
        const known = rawSessionsById.get(id) ?? headBucket?.items.find((item) => item.id === id);
        return known === undefined ? privateFilter !== 'only' : sessionMatchesPrivateFilter(known, privateFilter);
      });
      const baseUnreadCount = hasFilteredOutOwned ? allowedUnreadSeed.length : persona.unreadCount;
      const directoryUnreadIds = new Set(allowedUnreadSeed);
      const extraThreads: InlinePersonaThread[] = [];
      const computedUnreadIds: string[] = [...allowedUnreadSeed];
      const computedUnreadSet = new Set(computedUnreadIds);
      let hasWaiting = !hasFilteredOutOwned && persona.life === 'waiting';
      let hasWorking = !hasFilteredOutOwned && persona.life === 'working';

      for (const item of merged) {
        const rawState = sessionRowState(item, seen);
        const state = globalSessionIds.has(item.id)
          && rawState === 'unread'
          && !hasFilteredOutOwned
          && (baseUnreadCount === 0 || !directoryUnreadIds.has(item.id))
          ? 'read'
          : rawState;
        if (state === 'needs-me') hasWaiting = true;
        else if (state === 'running') hasWorking = true;
        else if (state === 'unread' && !computedUnreadSet.has(item.id)) {
          computedUnreadSet.add(item.id);
          computedUnreadIds.push(item.id);
        }
        if (item.id === persona.homeSessionId) continue;
        const roomId = typeof item.metadata?.['room_member_of'] === 'string'
          ? item.metadata['room_member_of']
          : undefined;
        const fullTitle = roomId === undefined
          ? rawThreadTitle(item, untitled)
          : roomNames.get(roomId) ?? rawThreadTitle(item, untitled);
        extraThreads.push({
          id: item.id,
          kind: roomId === undefined ? 'topic' : 'room',
          shortTitle: roomId === undefined ? compactPersonaThreadTitle(fullTitle, persona.name) : fullTitle,
          fullTitle,
          life: threadLifeOf(state),
          isCurrent: item.id === activeSessionId,
          needsYou: state === 'needs-me',
          pinned: isPinnedSession(item),
          updatedAt: item.updated_at,
          targetUrl: roomId === undefined ? `/s/${encodeURIComponent(item.id)}` : `/rooms/${encodeURIComponent(roomId)}`,
        });
      }

      extraThreads.sort((a, b) => {
        if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
        if ((a.life === 'working') !== (b.life === 'working')) return a.life === 'working' ? -1 : 1;
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
      });

      const unreadCount = Math.max(baseUnreadCount, computedUnreadIds.length);
      const life: PersonaDirectoryEntry['life'] = hasWaiting
        ? 'waiting'
        : hasWorking
          ? 'working'
          : unreadCount > 0 || (!hasFilteredOutOwned && persona.life === 'done')
            ? 'done'
            : 'idle';
      const knownHome = persona.homeSessionId === undefined
        ? undefined
        : rawSessionsById.get(persona.homeSessionId) ?? headBucket?.items.find((item) => item.id === persona.homeSessionId);
      const hasHomeSlot = persona.homeSessionId !== undefined
        && (knownHome !== undefined ? sessionMatchesPrivateFilter(knownHome, privateFilter) : privateFilter !== 'only')
        ? 1
        : 0;
      let serverTotal = 0;
      if (headBucket !== undefined) {
        const visibleHeadItems = headBucket.items.filter((item) => sessionMatchesPrivateFilter(item, privateFilter));
        const removedHeadPrivate = headBucket.items.length - visibleHeadItems.length;
        const headIds = new Set(visibleHeadItems.map((item) => item.id));
        const newestTailTime = visibleHeadItems.length > 0
          ? new Date(visibleHeadItems.at(-1)?.updated_at ?? 0).getTime()
          : 0;
        const addedLocal = filteredSessions.filter((item) =>
          !item.archived
          && sessionPersonaId(item) === persona.id
          && !headIds.has(item.id)
          && (visibleHeadItems.length < 10 || new Date(item.updated_at ?? 0).getTime() >= newestTailTime),
        ).length;
        const excludedFromHead = visibleHeadItems.filter((item) => {
          const local = rawSessionsById.get(item.id);
          return local !== undefined && (local.archived === true || !sessionMatchesPrivateFilter(local, privateFilter));
        }).length;
        const homeMissingFromIndex = hasHomeSlot === 1
          && persona.homeSessionId !== undefined
          && !headIds.has(persona.homeSessionId)
          && !merged.some((item) => item.id === persona.homeSessionId)
          ? 1
          : 0;
        const baseHeadTotal = Math.max(visibleHeadItems.length, headBucket.total - removedHeadPrivate);
        serverTotal = Math.max(0, baseHeadTotal + addedLocal - excludedFromHead) + homeMissingFromIndex;
      }
      const totalConversations = Math.max(extraThreads.length + hasHomeSlot, serverTotal);
      const totalNonHomeConversations = Math.max(extraThreads.length, totalConversations - hasHomeSlot);
      map.set(persona.id, {
        extraThreads,
        totalConversations,
        totalNonHomeConversations,
        unreadIds: computedUnreadIds,
        unreadCount,
        life,
      });
    }
    return map;
  }, [activeSessionId, filteredSessions, globalSessionIds, headsQuery.data, privateFilter, rawSessionsById, roomNames, seen, serverSessionsByPersona, sessions, t, visiblePersonas]);

  const commitPersonaOrder = useCallback((nextIds: readonly string[]) => {
    setSavedOrder(nextIds);
    writeSavedPersonaOrder(nextIds);
  }, []);

  const allVisibleIds = useMemo(() => visiblePersonas.map((item) => item.id), [visiblePersonas]);

  if (visiblePersonas.length === 0) return null;

  const collapsedLife: 'idle' | 'working' | 'waiting' | 'done' = visiblePersonas.some((item) => (personaThreadStats.get(item.id)?.life ?? item.life) === 'waiting')
    ? 'waiting'
    : visiblePersonas.some((item) => (personaThreadStats.get(item.id)?.life ?? item.life) === 'working')
      ? 'working'
      : visiblePersonas.some((item) => {
          const stats = personaThreadStats.get(item.id);
          return (stats?.unreadCount ?? item.unreadCount) > 0 || (stats?.life ?? item.life) === 'done';
        })
        ? 'done'
        : 'idle';
  const collapsedUnreadTotal = visiblePersonas.reduce(
    (sum, item) => sum + (personaThreadStats.get(item.id)?.unreadCount ?? item.unreadCount),
    0,
  );

  const toggleInlineExpand = (personaId: string, currentlyExpanded: boolean) => {
    setRowMenu(null);
    const next = !currentlyExpanded;
    setExpandedOverrides((prev) => ({ ...prev, [personaId]: next }));
    if (!next) {
      setShowAllThreadsFor((prev) => {
        if (!prev[personaId]) return prev;
        const copy = { ...prev };
        delete copy[personaId];
        return copy;
      });
    }
  };

  const openUnread = (event: React.MouseEvent, persona: PersonaDirectoryEntry, unreadIds: readonly string[], hasExtraThreads: boolean) => {
    event.stopPropagation();
    setRowMenu(null);
    if (unreadIds.length === 1) {
      void navigate(`/s/${encodeURIComponent(unreadIds[0]!)}`);
      return;
    }
    if (hasExtraThreads) {
      setExpandedOverrides((prev) => ({ ...prev, [persona.id]: true }));
      setShowAllThreadsFor((prev) => ({ ...prev, [persona.id]: true }));
      return;
    }
    if (unreadIds[0] !== undefined) {
      void navigate(`/s/${encodeURIComponent(unreadIds[0])}`);
    }
  };

  const patchPersonaState = async (persona: PersonaDirectoryEntry, patch: { pinned?: boolean; hidden?: boolean }) => {
    const restPersonas = client.klient?.rest?.personas;
    const updater = client.updatePersona !== undefined
      ? (id: string, body: { pinned?: boolean; hidden?: boolean }) => client.updatePersona(id, body)
      : restPersonas !== undefined
        ? (id: string, body: { pinned?: boolean; hidden?: boolean }) => restPersonas.updateState(id, body)
        : undefined;
    if (updater === undefined) throw new Error(t('persona.conversationsUnavailable'));
    const state = await updater(persona.id, patch);
    for (const includeArchived of [false, true]) {
      queryClient.setQueryData<readonly PersonaSummary[]>(['personas', { includeArchived }], (current) =>
        current?.map((item) => (item.id === persona.id ? { ...item, pinned: state.pinned, hidden: state.hidden } : item)));
    }
    await Promise.all([
      invalidatePersonas(queryClient, persona.id),
      queryClient.invalidateQueries({ queryKey: ['personas', 'directory'] }),
      queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY }),
    ]);
  };

  const rowMenuEntries: readonly MiniMenuEntry[] = rowMenu === null
    ? []
    : [
        {
          key: 'new-topic',
          label: t('persona.newTopic'),
          run: () => { void navigate(personaNewConversationUrl(rowMenu.persona.id, currentWorkspaceId)); },
        },
        { separator: true },
        {
          key: 'pin',
          label: rowMenu.persona.pinned ? t('persona.unpin') : t('persona.pin'),
          run: async () => {
            const nextPinned = !rowMenu.persona.pinned;
            if (nextPinned) {
              commitPersonaOrder([
                rowMenu.persona.id,
                ...allVisibleIds.filter((id) => id !== rowMenu.persona.id),
              ]);
            }
            await patchPersonaState(rowMenu.persona, { pinned: nextPinned });
          },
        },
        {
          key: 'hide',
          label: t('persona.hideFromList'),
          run: () => patchPersonaState(rowMenu.persona, { hidden: true }),
        },
        { separator: true },
        {
          key: 'settings',
          label: t('persona.menu.settings'),
          run: () => { void navigate(`/personas?persona=${encodeURIComponent(rowMenu.persona.id)}&view=settings`); },
        },
      ];

  return (
    <div data-sidebar-personas className="shrink-0 px-2 pb-1">
      <div role="group" aria-label={t('persona.groupTitle')} className={collapsed ? 'mb-0.5' : 'mb-2'}>
        <div className={GROUP_HEAD}>
          <button
            type="button"
            data-sidebar-personas-toggle
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('persona.expandSection') : t('persona.collapseSection')}
            onClick={() => { setSidebarPersonaSectionCollapsed(!collapsed); }}
            className="row-interactive flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-[12px] leading-4 font-medium text-section-ink transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink"
          >
            <DisclosureChevron open={!collapsed} size={12} className="shrink-0 text-ink-faint" />
            <span className="min-w-0 truncate">{t('persona.groupTitle')}</span>
            {collapsed && (collapsedLife !== 'idle' || collapsedUnreadTotal > 0) ? (
              <span data-sidebar-personas-attention className="ml-0.5 flex shrink-0 items-center gap-1">
                {collapsedLife === 'waiting' || collapsedLife === 'working' ? (
                  <LifeMark
                    markId="sidebar:personas-collapsed"
                    life={collapsedLife}
                    still
                    tone={collapsedLife === 'waiting' ? 'bg-attention' : undefined}
                  />
                ) : null}
                {collapsedUnreadTotal > 0 ? (
                  <span
                    data-sidebar-personas-collapsed-unread={collapsedUnreadTotal}
                    className="text-[11px] leading-4 font-medium text-accent-ink tabular-nums"
                  >
                    {collapsedUnreadTotal}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            data-room-create
            aria-label={t('room.new')}
            title={t('room.new')}
            onClick={() => { setCreatingRoom(true); }}
            className={HEAD_BUTTON}
          >
            <span aria-hidden className="font-mono text-[13px] leading-none">#</span>
          </button>
          <button
            type="button"
            data-persona-create
            aria-label={t('persona.new')}
            title={t('persona.new')}
            onClick={() => { void navigate('/personas?new=1'); }}
            className={HEAD_BUTTON}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>

        {!collapsed ? (
          <>
            <ul className="flex flex-col gap-px">
              {shownPersonas.map((persona) => {
                const stats = personaThreadStats.get(persona.id);
                const extraThreads = stats?.extraThreads ?? [];
                const totalNonHomeConversations = stats?.totalNonHomeConversations ?? extraThreads.length;
                const hasExtraThreads = totalNonHomeConversations > 0;
                const totalConversations = stats?.totalConversations ?? (persona.homeSessionId !== undefined ? 1 : 0);
                const unreadCount = stats?.unreadCount ?? persona.unreadCount;
                const unreadIds = stats?.unreadIds ?? persona.unreadSessionIds;
                const effectiveLife = stats?.life ?? persona.life;

                const inlineSubthreadActive = extraThreads.some((item) => item.isCurrent);
                const isSelectedPersona = activePersonaId === persona.id
                  || inlineSubthreadActive
                  || (persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId);
                const attentionThreads = extraThreads.filter(
                  (item) => item.needsYou || item.life === 'working' || item.life === 'done',
                );

                const overrideExpanded = expandedOverrides[persona.id];
                const defaultExpanded = hasExtraThreads && (isSelectedPersona || attentionThreads.length > 0);
                const isExpanded = hasExtraThreads && (overrideExpanded ?? defaultExpanded);
                const showAllThreads = showAllThreadsFor[persona.id] === true;

                const inlineThreads = (() => {
                  if (!isExpanded || !hasExtraThreads) return [];
                  if (showAllThreads) return extraThreads;
                  if (overrideExpanded === true || isSelectedPersona) {
                    const top = extraThreads.slice(0, SIDEBAR_PERSONA_INLINE_THREAD_LIMIT);
                    if (extraThreads.length > SIDEBAR_PERSONA_INLINE_THREAD_LIMIT) {
                      const current = extraThreads.find((item) => item.isCurrent);
                      if (current !== undefined && !top.includes(current)) {
                        top[SIDEBAR_PERSONA_INLINE_THREAD_LIMIT - 1] = current;
                      }
                    }
                    return top;
                  }
                  if (attentionThreads.length > 0) {
                    return attentionThreads.slice(0, SIDEBAR_PERSONA_INLINE_THREAD_LIMIT);
                  }
                  return extraThreads.slice(0, SIDEBAR_PERSONA_INLINE_THREAD_LIMIT);
                })();
                const overflowThreadCount = inlineThreads.length > 0
                  ? Math.max(0, totalNonHomeConversations - inlineThreads.length)
                  : 0;
                const atDaily = (persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId)
                  || (activePersonaId === persona.id && !inlineSubthreadActive);
                const emphasis = atDaily || inlineSubthreadActive || effectiveLife === 'waiting' || effectiveLife === 'done';
                const menuOpenForRow = rowMenu?.persona.id === persona.id;
                const isDragging = draggingId === persona.id;
                const dropEdge = dropTarget?.id === persona.id ? dropTarget.position : undefined;

                return (
                  <li
                    key={persona.id}
                    draggable
                    className={`group relative transition-opacity ${isDragging ? 'opacity-55' : ''}`}
                    data-sidebar-persona-row={persona.id}
                    data-persona-dragging={isDragging || undefined}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      try { event.dataTransfer.setData('text/plain', persona.id); } catch { /* ignore */ }
                      setDraggingId(persona.id);
                      setRowMenu(null);
                    }}
                    onDragOver={(event) => {
                      const sourceId = draggingId ?? (() => {
                        try { return event.dataTransfer.getData('text/plain') || null; } catch { return null; }
                      })();
                      if (sourceId === null || sourceId === persona.id || !allVisibleIds.includes(sourceId)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const rect = event.currentTarget.getBoundingClientRect();
                      const position: 'before' | 'after' = rect.height > 0
                        ? (event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
                        : (allVisibleIds.indexOf(sourceId) < allVisibleIds.indexOf(persona.id) ? 'after' : 'before');
                      if (dropTarget?.id !== persona.id || dropTarget.position !== position) {
                        setDropTarget({ id: persona.id, position });
                      }
                    }}
                    onDragLeave={(event) => {
                      if (dropTarget?.id === persona.id && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDropTarget(null);
                      }
                    }}
                    onDrop={(event) => {
                      const sourceId = draggingId ?? (() => {
                        try { return event.dataTransfer.getData('text/plain') || null; } catch { return null; }
                      })();
                      if (sourceId === null || !allVisibleIds.includes(sourceId)) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const fallbackPos: 'before' | 'after' = rect.height > 0
                        ? (event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
                        : (allVisibleIds.indexOf(sourceId) < allVisibleIds.indexOf(persona.id) ? 'after' : 'before');
                      const position = dropTarget?.id === persona.id ? dropTarget.position : fallbackPos;
                      const nextOrder = reorderPersonaIds(allVisibleIds, sourceId, persona.id, position);
                      commitPersonaOrder(nextOrder);
                      setDraggingId(null);
                      setDropTarget(null);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDropTarget(null);
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                      const idx = allVisibleIds.indexOf(persona.id);
                      if (idx < 0) return;
                      const neighborId = event.key === 'ArrowUp' ? allVisibleIds[idx - 1] : allVisibleIds[idx + 1];
                      if (neighborId === undefined) return;
                      event.preventDefault();
                      commitPersonaOrder(reorderPersonaIds(
                        allVisibleIds,
                        persona.id,
                        neighborId,
                        event.key === 'ArrowUp' ? 'before' : 'after',
                      ));
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setRowMenu({ persona, x: event.clientX, y: event.clientY });
                    }}
                  >
                    {dropEdge !== undefined ? (
                      <span
                        aria-hidden
                        data-persona-drop-indicator={dropEdge}
                        className={`pointer-events-none absolute right-2 left-2 z-20 h-[2px] rounded-full bg-accent ${
                          dropEdge === 'before' ? 'top-0' : 'bottom-0'
                        }`}
                      />
                    ) : null}

                    <div className="row-interactive flex h-8 items-center gap-1 pr-1 pl-2">
                      <button
                        type="button"
                        data-persona-primary={persona.id}
                        aria-current={atDaily ? 'page' : undefined}
                        aria-label={t('persona.openDaily', { name: persona.name })}
                        title={t('persona.openDaily', { name: persona.name })}
                        onClick={() => {
                          void navigate(`/p/${encodeURIComponent(persona.id)}/daily`);
                        }}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
                      >
                        <span className="flex h-[19px] w-[7px] shrink-0 items-center">
                          <LifeMark
                            markId={`persona:${persona.id}`}
                            life={effectiveLife}
                            still
                            tone={effectiveLife === 'waiting' ? 'bg-attention' : undefined}
                          />
                        </span>
                        <PersonaAvatar persona={personaAvatarOf(persona)} size={20} decorative />
                        <span className={`min-w-0 shrink truncate text-[13px] leading-[19px] ${
                          emphasis ? 'font-medium text-ink' : 'text-ink-soft'
                        }`}>
                          {persona.name}
                        </span>
                        {persona.title !== undefined && persona.title.trim() !== '' ? (
                          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-faint">{persona.title}</span>
                        ) : <span className="flex-1" />}
                        {persona.pinned ? (
                          <span aria-hidden className="shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span>
                        ) : null}
                      </button>

                      <div className="flex shrink-0 items-center gap-0.5">
                        {unreadCount > 0 ? (
                          <button
                            type="button"
                            data-persona-unread-count={unreadCount}
                            aria-label={t('persona.unreadCountTitle', { count: unreadCount })}
                            title={t('persona.unreadCountTitle', { count: unreadCount })}
                            onClick={(event) => { openUnread(event, persona, unreadIds, hasExtraThreads); }}
                            className="flex h-6 min-w-4 items-center justify-center rounded px-1 text-[12px] leading-4 font-medium text-accent-ink tabular-nums hover:bg-ink/[0.06]"
                          >
                            {unreadCount}
                          </button>
                        ) : null}

                        <span className={`flex items-center gap-0.5 transition-opacity duration-[var(--kiki-motion-quick)] ${
                          menuOpenForRow
                            ? 'w-auto overflow-visible opacity-100'
                            : 'w-0 overflow-hidden opacity-0 group-hover:w-auto group-hover:overflow-visible group-hover:opacity-100 group-focus-within:w-auto group-focus-within:overflow-visible group-focus-within:opacity-100 [@media(hover:none)]:w-auto [@media(hover:none)]:overflow-visible [@media(hover:none)]:opacity-100'
                        }`}>
                          <button
                            type="button"
                            data-persona-new-thread={persona.id}
                            aria-label={`${persona.name} · ${t('persona.newTopic')}`}
                            title={t('persona.newTopic')}
                            onClick={(event) => {
                              event.stopPropagation();
                              void navigate(personaNewConversationUrl(persona.id, currentWorkspaceId));
                            }}
                            className={HOVER_ICON_BUTTON}
                          >
                            <Icon name="plus" size={12} />
                          </button>
                          <button
                            type="button"
                            data-persona-menu-toggle={persona.id}
                            aria-haspopup="menu"
                            aria-expanded={menuOpenForRow}
                            aria-label={t('persona.rowActionsAria', { name: persona.name })}
                            title={t('persona.rowActionsAria', { name: persona.name })}
                            onClick={(event) => {
                              event.stopPropagation();
                              const rect = event.currentTarget.getBoundingClientRect();
                              setRowMenu((current) =>
                                current?.persona.id === persona.id ? null : { persona, x: rect.right + 4, y: rect.top });
                            }}
                            className={HOVER_ICON_BUTTON}
                          >
                            <Icon name="more" size={14} />
                          </button>
                        </span>

                        {hasExtraThreads ? (
                          <button
                            type="button"
                            data-persona-switcher-toggle={persona.id}
                            data-persona-thread-count={totalConversations}
                            aria-expanded={isExpanded}
                            aria-label={t('persona.openSwitcherAria', { name: persona.name })}
                            title={t('persona.openSwitcherAria', { name: persona.name })}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleInlineExpand(persona.id, isExpanded);
                            }}
                            className={`flex h-6 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-md px-1.5 text-[11px] leading-none font-medium tabular-nums transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-selected-ink ${
                              isExpanded
                                ? 'bg-ink/[0.08] text-ink'
                                : 'bg-ink/[0.045] text-ink-soft hover:bg-ink/[0.08] hover:text-ink'
                            }`}
                          >
                            <span>{totalConversations}</span>
                            <DisclosureChevron open={isExpanded} size={12} className="shrink-0 text-ink-faint" />
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {inlineThreads.length > 0 ? (
                      <ul
                        data-persona-subthreads={persona.id}
                        className="mt-0.5 mb-1 ml-[17px] flex flex-col gap-px border-l border-hairline pl-1.5"
                      >
                        {inlineThreads.map((thread) => (
                          <li key={thread.id}>
                            <button
                              type="button"
                              data-persona-subthread={thread.id}
                              aria-current={thread.isCurrent ? 'page' : undefined}
                              title={thread.fullTitle}
                              onClick={() => { void navigate(thread.targetUrl); }}
                              className="row-interactive flex h-7 w-full items-center gap-1.5 pr-2 pl-2 text-left text-[12px] leading-4"
                            >
                              <span className="flex h-4 w-[7px] shrink-0 items-center">
                                <LifeMark
                                  markId={`persona-thread:${thread.id}`}
                                  life={thread.life}
                                  still
                                  tone={thread.needsYou ? 'bg-attention' : undefined}
                                />
                              </span>
                              {thread.kind === 'room' ? (
                                <span aria-hidden className="shrink-0 font-mono text-[11px] text-ink-faint">#</span>
                              ) : null}
                              <span className={`min-w-0 flex-1 truncate ${
                                thread.isCurrent || thread.needsYou || thread.life === 'done'
                                  ? 'font-medium text-ink'
                                  : 'text-ink-soft hover:text-ink'
                              }`}>
                                {thread.shortTitle}
                              </span>
                            </button>
                          </li>
                        ))}
                        {overflowThreadCount > 0 ? (
                          <li>
                            <button
                              type="button"
                              data-persona-subthreads-more={persona.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (!showAllThreads && extraThreads.length > inlineThreads.length) {
                                  setExpandedOverrides((prev) => ({ ...prev, [persona.id]: true }));
                                  setShowAllThreadsFor((prev) => ({ ...prev, [persona.id]: true }));
                                  return;
                                }
                                void navigate(`/personas?persona=${encodeURIComponent(persona.id)}&view=conversations`);
                              }}
                              className="row-interactive flex h-6 w-full items-center pr-2 pl-[23px] text-left text-[11px] leading-4 text-ink-faint transition-colors hover:text-ink"
                            >
                              <span className="min-w-0 truncate">
                                +{overflowThreadCount} · {t('persona.allConversations')}
                              </span>
                            </button>
                          </li>
                        ) : showAllThreads && extraThreads.length > SIDEBAR_PERSONA_INLINE_THREAD_LIMIT ? (
                          <li>
                            <button
                              type="button"
                              data-persona-subthreads-less={persona.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                setShowAllThreadsFor((prev) => {
                                  const copy = { ...prev };
                                  delete copy[persona.id];
                                  return copy;
                                });
                              }}
                              className="row-interactive flex h-6 w-full items-center pr-2 pl-[23px] text-left text-[11px] leading-4 text-ink-faint transition-colors hover:text-ink"
                            >
                              <span className="min-w-0 truncate">{t('persona.showLess')}</span>
                            </button>
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {hasOverflow ? (
              <button
                type="button"
                data-sidebar-personas-more={showAllPersonas ? 'less' : 'more'}
                aria-expanded={showAllPersonas}
                onClick={() => { setShowAllPersonas((value) => !value); }}
                className="row-interactive mt-0.5 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink-faint transition-colors hover:text-ink"
              >
                <span className="w-[7px] shrink-0" aria-hidden />
                <span className="min-w-0 truncate">
                  {showAllPersonas ? t('persona.showLess') : t('persona.showMore', { count: hiddenMoreCount })}
                </span>
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {creatingRoom ? <CreateRoomDialog onClose={() => { setCreatingRoom(false); }} /> : null}

      {rowMenu !== null ? (
        <MiniContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          entries={rowMenuEntries}
          onClose={() => { setRowMenu(null); }}
          ariaLabel={t('persona.rowActionsAria', { name: rowMenu.persona.name })}
          overlayId="persona-sidebar-row-menu"
          dataAttribute="data-persona-row-menu"
        />
      ) : null}
    </div>
  );
}

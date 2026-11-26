/**
 * SidebarPersonaSection: the sidebar's persona group inside the unified
 * conversation scroll container.
 *
 * One compact row per persona. When no custom drag order has been saved, active,
 * pinned, and recently-used personas rise above cold ones; once dragged or
 * pinned, custom order is respected while ensuring active/attention personas
 * never hide behind the >5 fold.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { PersonaSummary, RoomListItem, Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import { isPinnedSession, sessionAttentionCursor, sessionRowState } from '@kiki/session-core/sessions';
import {
  markConversationSeen,
  markSessionSeen,
  setSidebarPersonaSectionCollapsed,
  setSidebarPersonasShowAll,
  type SessionSeenMap,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { BOTS_QUERY_KEY } from '../../lib/botRooms';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { invalidatePersonaSessionLists } from '../../lib/personaFreshness';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { useGuardedNavigate } from '../dirtyGuard';
import { DisclosureChevron, Icon } from '../icons';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { useSessionContextMenu } from '../sessionContextMenu';
import { SidebarRowDot, sidebarDotKindFromLife } from '../sidebar/SidebarRowSignal';
import { sanitizeDisplayTitle } from '../../lib/threadTitles';
import { CreateRoomDialog } from '../room/CreateRoomDialog';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';
import { PersonaConversationSwitcher } from './PersonaConversationSwitcher';
import { personaNewConversationUrl } from './personaNavigation';
import {
  compactPersonaThreadTitle,
  mergePersonaConversations,
  sessionMatchesPrivateFilter,
  sessionPersonaId,
} from './personaSessionUtils';
import { usePersonaSessionHeads, usePersonaSwitcherConversations } from './usePersonaSwitcherConversations';
import { usePersonaDirectory, type PersonaDirectoryEntry } from './usePersonaDirectory';
import { invalidatePersonas, PERSONAS_QUERY_KEY, personaQueryKey } from './usePersonas';

/** Default preview cap when the persona section is expanded. */
export const SIDEBAR_PERSONA_PREVIEW_LIMIT = 5;
/** Inline non-home topic/room conversations surfaced by default before "+N more". */
export const SIDEBAR_PERSONA_INLINE_THREAD_LIMIT = 3;
/** Persisted user-chosen sidebar persona ordering. */
export const SIDEBAR_PERSONA_ORDER_KEY = 'kiki.sidebar.personaOrder';

interface InlinePersonaThread {
  readonly id: string;
  readonly kind: 'daily' | 'topic' | 'room';
  readonly shortTitle: string;
  readonly fullTitle: string;
  readonly life: 'idle' | 'working' | 'waiting' | 'done';
  readonly isCurrent: boolean;
  readonly needsYou: boolean;
  readonly pinned: boolean;
  readonly updatedAt?: string;
  readonly targetUrl: string;
  readonly session?: Session;
}

function threadLifeOf(state: ReturnType<typeof sessionRowState>): InlinePersonaThread['life'] {
  return state === 'needs-me' ? 'waiting' : state === 'running' ? 'working' : state === 'unread' ? 'done' : 'idle';
}

function rawThreadTitle(session: Session, untitled: string): string {
  const title = sanitizeDisplayTitle(session.title);
  if (title !== undefined) return title;
  const prompt = sanitizeDisplayTitle(session.last_prompt);
  if (prompt !== undefined) return prompt;
  return untitled;
}

const GROUP_HEAD = 'flex h-7 items-center gap-0.5 pr-0.5 pl-1';
const HEAD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';
const HOVER_ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11';

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

function lifePriority(life: PersonaDirectoryEntry['life'], unreadCount: number): number {
  if (life === 'waiting') return 3;
  if (life === 'working') return 2;
  if (unreadCount > 0 || life === 'done') return 1;
  return 0;
}

export interface PersonaOrderSignals {
  readonly activePersonaId?: string;
  readonly statsById?: ReadonlyMap<string, {
    readonly life: PersonaDirectoryEntry['life'];
    readonly unreadCount: number;
    readonly latestActivityAt: number;
  }>;
}

/**
 * Order visible sidebar personas. When the user saved an explicit drag/pin
 * order, follow it and append newly discovered entries; otherwise sort active,
 * pinned, and recently active personas to the top with stable natural fallback.
 */
export function orderSidebarPersonas(
  items: readonly PersonaDirectoryEntry[],
  savedOrder: readonly string[] = [],
  signals?: PersonaOrderSignals,
): PersonaDirectoryEntry[] {
  const visible = items.filter((item) => !item.hidden);
  const indexMap = new Map<string, number>();
  visible.forEach((item, index) => { indexMap.set(item.id, index); });

  const smartCompare = (a: PersonaDirectoryEntry, b: PersonaDirectoryEntry): number => {
    const aActive = signals?.activePersonaId === a.id ? 1 : 0;
    const bActive = signals?.activePersonaId === b.id ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;

    const aStats = signals?.statsById?.get(a.id);
    const bStats = signals?.statsById?.get(b.id);
    const aUrgency = lifePriority(aStats?.life ?? a.life, aStats?.unreadCount ?? a.unreadCount);
    const bUrgency = lifePriority(bStats?.life ?? b.life, bStats?.unreadCount ?? b.unreadCount);
    if (aUrgency !== bUrgency) return bUrgency - aUrgency;

    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

    const aTime = aStats?.latestActivityAt ?? a.lastActivityAt ?? 0;
    const bTime = bStats?.latestActivityAt ?? b.lastActivityAt ?? 0;
    if (aTime !== bTime) return bTime - aTime;

    return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
  };

  if (savedOrder.length === 0) {
    return visible.toSorted(smartCompare);
  }
  const rank = new Map<string, number>();
  savedOrder.forEach((id, index) => { rank.set(id, index); });
  const prioritized: PersonaDirectoryEntry[] = [];
  const rest: PersonaDirectoryEntry[] = [];
  for (const item of visible) {
    if (rank.has(item.id)) prioritized.push(item);
    else rest.push(item);
  }
  prioritized.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  rest.sort(smartCompare);
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
  workspaceOptions,
  rooms = [],
}: SidebarPersonaSectionProps) {
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { client, spaceKey } = useConnection();
  const sessionMenu = useSessionContextMenu({ activeSessionId, portal: true });
  const layoutPrefs = useLayoutPreferences();
  const collapsed = layoutPrefs.sidebarPersonaSectionCollapsed === true;
  const showAllPersonas = layoutPrefs.sidebarPersonasShowAll === true;
  const privateFilter = layoutPrefs.filters.private ?? 'hide';

  const filteredSessions = useMemo(
    () => sessions.filter((item) => sessionMatchesPrivateFilter(item, privateFilter)),
    [privateFilter, sessions],
  );

  const { directory } = usePersonaDirectory({ sessions: filteredSessions, seen });
  const [savedOrder, setSavedOrder] = useState<readonly string[]>(readSavedPersonaOrder);
  const [switcherState, setSwitcherState] = useState<{ persona: PersonaDirectoryEntry; anchor: HTMLElement } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ persona: PersonaDirectoryEntry; x: number; y: number } | null>(null);
  const [roomDialog, setRoomDialog] = useState<{ readonly initialPersonaId?: string } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);

  const switcherQuery = usePersonaSwitcherConversations(
    switcherState?.persona.id,
    switcherState !== null,
    privateFilter,
  );

  const nonHiddenPersonas = useMemo(
    () => directory.filter((item) => !item.hidden),
    [directory],
  );

  const headsQuery = usePersonaSessionHeads({
    enabled: !collapsed && nonHiddenPersonas.length > 0,
    perPersonaLimit: 10,
    privateFilter,
  });

  const serverSessionsByPersona = useMemo(() => {
    const map = new Map<string, readonly Session[] | undefined>();
    const heads = headsQuery.data;
    if (heads !== undefined) {
      for (const persona of nonHiddenPersonas) {
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
  }, [headsQuery.data, nonHiddenPersonas, privateFilter]);

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
      readonly allThreads: readonly InlinePersonaThread[];
      readonly extraThreads: readonly InlinePersonaThread[];
      readonly totalConversations: number;
      readonly totalNonHomeConversations: number;
      readonly unreadIds: readonly string[];
      readonly eligibleUnreadSessions: readonly Session[];
      readonly unreadCount: number;
      readonly life: PersonaDirectoryEntry['life'];
      readonly latestActivityAt: number;
      readonly primaryTargetUrl: string;
    }>();
    if (nonHiddenPersonas.length === 0) return map;
    const untitled = t('sidebar.untitled');
    const dailyTitleLabel = t('persona.dailyTitle');
    const heads = headsQuery.data;
    for (const persona of nonHiddenPersonas) {
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
      const dailyUrl = `/p/${encodeURIComponent(persona.id)}/daily`;
      let dailyThread: InlinePersonaThread | undefined;
      const extraThreads: InlinePersonaThread[] = [];
      const computedUnreadIds: string[] = [...allowedUnreadSeed];
      const computedUnreadSet = new Set(computedUnreadIds);
      let hasWaiting = !hasFilteredOutOwned && persona.life === 'waiting';
      let hasWorking = !hasFilteredOutOwned && persona.life === 'working';
      let latestActivityAt = persona.lastActivityAt ?? 0;

      for (const item of merged) {
        const ts = Date.parse(item.updated_at ?? '');
        if (Number.isFinite(ts) && ts > latestActivityAt) {
          latestActivityAt = ts;
        }
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
        if (item.id === persona.homeSessionId) {
          const rawTitle = rawThreadTitle(item, untitled);
          const trimmed = rawTitle.trim();
          const hasDistinctTitle = trimmed !== '' && trimmed !== persona.name.trim() && trimmed !== untitled;
          const shortTitle = hasDistinctTitle ? compactPersonaThreadTitle(rawTitle, persona.name) : dailyTitleLabel;
          dailyThread = {
            id: item.id,
            kind: 'daily',
            shortTitle,
            fullTitle: hasDistinctTitle ? rawTitle : dailyTitleLabel,
            life: threadLifeOf(state),
            isCurrent: item.id === activeSessionId,
            needsYou: state === 'needs-me',
            pinned: true,
            updatedAt: item.updated_at,
            targetUrl: dailyUrl,
            session: item,
          };
          continue;
        }
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
          session: item,
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
      const homeAllowed = persona.homeSessionId !== undefined
        && (knownHome !== undefined ? !knownHome.archived && sessionMatchesPrivateFilter(knownHome, privateFilter) : privateFilter !== 'only');
      const hasHomeSlot = homeAllowed ? 1 : 0;

      if (dailyThread === undefined && homeAllowed && persona.homeSessionId !== undefined) {
        const homeRawState = knownHome !== undefined ? sessionRowState(knownHome, seen) : 'read';
        const homeRawTitle = knownHome !== undefined ? rawThreadTitle(knownHome, untitled) : dailyTitleLabel;
        const trimmed = homeRawTitle.trim();
        const hasDistinctTitle = trimmed !== '' && trimmed !== persona.name.trim() && trimmed !== untitled && trimmed !== dailyTitleLabel;
        dailyThread = {
          id: persona.homeSessionId,
          kind: 'daily',
          shortTitle: hasDistinctTitle ? compactPersonaThreadTitle(homeRawTitle, persona.name) : dailyTitleLabel,
          fullTitle: hasDistinctTitle ? homeRawTitle : dailyTitleLabel,
          life: knownHome !== undefined ? threadLifeOf(homeRawState) : (persona.unreadSessionIds.includes(persona.homeSessionId) ? 'done' : 'idle'),
          isCurrent: persona.homeSessionId === activeSessionId,
          needsYou: homeRawState === 'needs-me',
          pinned: true,
          updatedAt: knownHome?.updated_at,
          targetUrl: dailyUrl,
          session: knownHome,
        };
      }
      const allThreads: InlinePersonaThread[] = dailyThread !== undefined
        ? [dailyThread, ...extraThreads]
        : [...extraThreads];

      const primaryTargetUrl = (() => {
        const topExtra = extraThreads[0];
        if (topExtra === undefined) return dailyUrl;
        if (!homeAllowed) return topExtra.targetUrl;
        if (knownHome !== undefined) {
          const homeState = sessionRowState(knownHome, seen);
          if (homeState === 'needs-me' && !topExtra.needsYou) return dailyUrl;
          if (topExtra.needsYou || topExtra.life === 'working' || topExtra.isCurrent) return topExtra.targetUrl;
          if (knownHome.id === activeSessionId || homeState === 'running') return dailyUrl;
          const homeTs = Date.parse(knownHome.updated_at ?? '');
          const extraTs = Date.parse(topExtra.updatedAt ?? '');
          if (Number.isFinite(homeTs) && (!Number.isFinite(extraTs) || homeTs >= extraTs)) {
            return dailyUrl;
          }
          return topExtra.targetUrl;
        }
        if (persona.homeSessionId === activeSessionId) return dailyUrl;
        return topExtra.targetUrl;
      })();

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
      const totalConversations = Math.max(allThreads.length, extraThreads.length + hasHomeSlot, serverTotal);
      const totalNonHomeConversations = Math.max(extraThreads.length, totalConversations - hasHomeSlot);
      // Only known eligible unread sessions with no unresolved approval/question wait can be marked read.
      const eligibleUnreadSessions: Session[] = [];
      for (const thread of allThreads) {
        const candidate = thread.session;
        if (candidate === undefined) continue;
        if (thread.life !== 'done' || thread.needsYou || candidate.busy === true || candidate.archived === true) continue;
        if (candidate.pending_interaction !== undefined && candidate.pending_interaction !== 'none') continue;
        eligibleUnreadSessions.push(candidate);
      }
      map.set(persona.id, {
        allThreads,
        extraThreads,
        totalConversations,
        totalNonHomeConversations,
        unreadIds: computedUnreadIds,
        eligibleUnreadSessions,
        unreadCount,
        life,
        latestActivityAt,
        primaryTargetUrl,
      });
    }
    return map;
  }, [activeSessionId, filteredSessions, globalSessionIds, headsQuery.data, nonHiddenPersonas, privateFilter, rawSessionsById, roomNames, seen, serverSessionsByPersona, sessions, t]);

  const visiblePersonas = useMemo(
    () => orderSidebarPersonas(directory, savedOrder, { activePersonaId, statsById: personaThreadStats }),
    [activePersonaId, directory, personaThreadStats, savedOrder],
  );

  const hasOverflow = visiblePersonas.length > SIDEBAR_PERSONA_PREVIEW_LIMIT;
  const shownPersonas = useMemo(() => {
    if (!hasOverflow || showAllPersonas) return visiblePersonas;
    const top = visiblePersonas.slice(0, SIDEBAR_PERSONA_PREVIEW_LIMIT);
    const topIds = new Set(top.map((item) => item.id));
    const mustShow = visiblePersonas.slice(SIDEBAR_PERSONA_PREVIEW_LIMIT).filter((item) => {
      const stats = personaThreadStats.get(item.id);
      const life = stats?.life ?? item.life;
      const unread = stats?.unreadCount ?? item.unreadCount;
      return item.id === activePersonaId || life !== 'idle' || unread > 0;
    });
    if (mustShow.length === 0) return top;
    const combined = [...top];
    for (const urgent of mustShow) {
      if (topIds.has(urgent.id)) continue;
      let replaceIdx = -1;
      for (let i = combined.length - 1; i >= 0; i -= 1) {
        const candidate = combined[i]!;
        const cStats = personaThreadStats.get(candidate.id);
        const cLife = cStats?.life ?? candidate.life;
        const cUnread = cStats?.unreadCount ?? candidate.unreadCount;
        if (candidate.id !== activePersonaId && cLife === 'idle' && cUnread === 0) {
          replaceIdx = i;
          break;
        }
      }
      if (replaceIdx >= 0) {
        combined.splice(replaceIdx, 1, urgent);
      } else {
        combined.push(urgent);
      }
    }
    return combined;
  }, [activePersonaId, hasOverflow, personaThreadStats, showAllPersonas, visiblePersonas]);

  const hiddenMoreCount = Math.max(0, visiblePersonas.length - shownPersonas.length);

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

  const togglePersonaSwitcher = (persona: PersonaDirectoryEntry, anchor: HTMLElement) => {
    setRowMenu(null);
    setSwitcherState((current) => (current?.persona.id === persona.id ? null : { persona, anchor }));
  };

  const setPersonaDaily = async (persona: PersonaDirectoryEntry, sessionId: string) => {
    const rest = client.klient?.rest;
    if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
    await rest.personas.setHome(persona.id, sessionId);
    void queryClient.invalidateQueries({ queryKey: PERSONAS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: personaQueryKey(persona.id) });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    invalidatePersonaSessionLists(queryClient);
    void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY });
    pushToast({ tone: 'success', text: t('persona.dailyChangedToast', { name: persona.name }) });
  };

  const openSubthreadMenu = (
    persona: PersonaDirectoryEntry,
    thread: InlinePersonaThread,
    x: number,
    y: number,
  ) => {
    if (thread.session === undefined) return;
    setRowMenu(null);
    const session = thread.session;
    const canSetDaily = thread.kind === 'topic' && !session.archived && !session.busy && session.ephemeral !== true;
    const extraTopEntries: MiniMenuEntry[] = canSetDaily
      ? [{
          key: 'set-daily',
          label: t('persona.setAsDaily'),
          run: async () => {
            try {
              await setPersonaDaily(persona, session.id);
            } catch (error: unknown) {
              pushToast({ tone: 'error', text: t('persona.dailyChangeFailed', { detail: error instanceof Error ? error.message : String(error) }) });
            }
          },
        }]
      : [];
    sessionMenu.openSessionMenu(session, x, y, {
      title: thread.fullTitle,
      copyLinkHref: thread.kind === 'room' ? thread.targetUrl : `/s/${encodeURIComponent(session.id)}`,
      extraTopEntries,
    });
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

  const markSessionsRead = (targets: readonly Session[]) => {
    for (const target of targets) {
      if (target.pending_interaction !== undefined && target.pending_interaction !== 'none') continue;
      if (target.busy === true || target.archived === true) continue;
      const cursor = sessionAttentionCursor(target);
      if (spaceKey !== undefined && spaceKey !== '') {
        markConversationSeen({ spaceKey, kind: 'session', id: target.id }, cursor);
      }
      markSessionSeen(target.id, cursor.seq);
    }
  };

  const rowMenuStats = rowMenu === null ? undefined : personaThreadStats.get(rowMenu.persona.id);
  const rowMenuTotal = rowMenu === null
    ? 0
    : (rowMenuStats?.totalConversations ?? (rowMenu.persona.homeSessionId !== undefined ? 1 : 0));
  const rowMenuSoleThread = rowMenuTotal === 1 && rowMenuStats?.allThreads.length === 1
    ? rowMenuStats.allThreads[0]
    : undefined;
  const rowMenuEligibleUnread = rowMenuStats?.eligibleUnreadSessions ?? [];

  const rowMenuEntries: readonly MiniMenuEntry[] = rowMenu === null
    ? []
    : [
        {
          key: 'new-topic',
          label: t('persona.newTopic'),
          run: () => { void navigate(personaNewConversationUrl(rowMenu.persona.id, currentWorkspaceId)); },
        },
        ...(rowMenu.persona.homeSessionId !== undefined
          ? [{
              key: 'daily',
              label: t('sidebar.persona.dailyConversation'),
              run: () => { void navigate(`/p/${encodeURIComponent(rowMenu.persona.id)}/daily`); },
            }]
          : []),
        {
          key: 'all-conversations',
          label: rowMenuTotal > 0 ? `${t('persona.menu.conversations')} (${rowMenuTotal})` : t('persona.menu.conversations'),
          run: () => { void navigate(`/personas?persona=${encodeURIComponent(rowMenu.persona.id)}&view=conversations`); },
        },
        {
          key: 'memory',
          label: t('persona.menu.memory'),
          run: () => { void navigate(`/memory?persona=${encodeURIComponent(rowMenu.persona.id)}`); },
        },
        ...(!rowMenu.persona.archived && !rowMenu.persona.hidden
          ? [{
              key: 'create-room',
              label: t('persona.menu.createRoom'),
              run: () => { setRoomDialog({ initialPersonaId: rowMenu.persona.id }); },
            }]
          : []),
        ...(rowMenuEligibleUnread.length > 0
          ? [{
              key: 'mark-read',
              label: t('persona.menu.markRead'),
              run: () => { markSessionsRead(rowMenuEligibleUnread); },
            }]
          : []),
        ...(rowMenuSoleThread?.session !== undefined
          ? [
              { separator: true } as const,
              {
                key: 'session-actions',
                label: t('persona.menu.conversationActions'),
                run: () => { openSubthreadMenu(rowMenu.persona, rowMenuSoleThread, rowMenu.x, rowMenu.y); },
              },
            ]
          : []),
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
    <div data-sidebar-personas className="pt-1 pb-1">
      <div role="group" aria-label={t('persona.groupTitle')} className={collapsed ? 'mb-0.5' : 'mb-1.5'}>
        <div className={GROUP_HEAD}>
          <button
            type="button"
            data-sidebar-personas-toggle
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('persona.expandSection') : t('persona.collapseSection')}
            onClick={() => { setSidebarPersonaSectionCollapsed(!collapsed); }}
            className="row-interactive flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-[12px] leading-4 font-bold text-section-ink transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink"
          >
            <DisclosureChevron open={!collapsed} size={12} className="shrink-0 text-ink-faint" />
            <span className="min-w-0 truncate">{t('persona.groupTitle')}</span>
            {collapsed && (collapsedLife !== 'idle' || collapsedUnreadTotal > 0) ? (
              <span data-sidebar-personas-attention className="ml-0.5 flex shrink-0 items-center gap-1">
                <SidebarRowDot signal kind={sidebarDotKindFromLife(collapsedLife) ?? 'unread'} />
                {collapsedUnreadTotal > 0 ? (
                  <span
                    data-sidebar-personas-collapsed-unread={collapsedUnreadTotal}
                    className="sr-only"
                  >
                    {collapsedUnreadTotal}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
          {!collapsed && hasOverflow ? (
            <button
              type="button"
              data-sidebar-personas-expand-all={showAllPersonas ? 'collapse' : 'expand'}
              aria-label={showAllPersonas ? t('sidebar.persona.showLess') : t('sidebar.persona.showAll')}
              title={showAllPersonas ? t('sidebar.persona.showLess') : t('sidebar.persona.showAll')}
              onClick={() => { setSidebarPersonasShowAll(!showAllPersonas); }}
              className={HEAD_BUTTON}
            >
              <Icon name={showAllPersonas ? 'collapse' : 'expand'} size={14} />
            </button>
          ) : null}
          <button
            type="button"
            data-persona-manage
            aria-label={t('sidebar.persona.manage')}
            title={t('sidebar.persona.manage')}
            onClick={() => { void navigate('/personas'); }}
            className={HEAD_BUTTON}
          >
            <Icon name="settings" size={14} />
          </button>
          <button
            type="button"
            data-room-create
            aria-label={t('room.new')}
            title={t('room.new')}
            onClick={() => { setRoomDialog({}); }}
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
                const totalConversations = stats?.totalConversations ?? (persona.homeSessionId !== undefined ? 1 : 0);
                // 0 or 1 conversation opens directly with no switcher chevron; >=2 exposes a plain switcher chevron.
                const hasMultiThreads = totalConversations >= 2;
                const unreadCount = stats?.unreadCount ?? persona.unreadCount;
                const effectiveLife = stats?.life ?? persona.life;
                const primaryTargetUrl = stats?.primaryTargetUrl ?? `/p/${encodeURIComponent(persona.id)}/daily`;

                const activeSubthread = extraThreads.find((item) => item.isCurrent);
                const inlineSubthreadActive = activeSubthread !== undefined;
                const isSelectedPersona = activePersonaId === persona.id
                  || inlineSubthreadActive
                  || (persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId);
                const switcherOpenForPersona = switcherState?.persona.id === persona.id;
                const atDaily = !hasMultiThreads
                  ? isSelectedPersona
                  : ((persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId)
                    || (activePersonaId === persona.id && !inlineSubthreadActive));
                const hasSignal = effectiveLife === 'working'
                  || effectiveLife === 'waiting'
                  || effectiveLife === 'done'
                  || unreadCount > 0;
                const menuOpenForRow = rowMenu?.persona.id === persona.id;
                const isDragging = draggingId === persona.id;
                const dropEdge = dropTarget?.id === persona.id ? dropTarget.position : undefined;
                const rowTooltip = persona.title !== undefined && persona.title.trim() !== ''
                  ? `${persona.name} — ${persona.title.trim()}`
                  : t('persona.openDaily', { name: persona.name });
                const switcherAria = locale === 'zh'
                  ? `切换对话，${totalConversations} 个`
                  : `Switch conversation, ${totalConversations}`;

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

                    <div
                      className={`row-interactive flex min-h-8 items-center gap-1 pr-1 pl-2 pointer-coarse:min-h-11 ${
                        isSelectedPersona && !inlineSubthreadActive ? 'bg-ink/[0.04]' : ''
                      }`}
                    >
                      <button
                        type="button"
                        data-persona-primary={persona.id}
                        aria-current={atDaily ? 'page' : undefined}
                        aria-label={t('persona.openDaily', { name: persona.name })}
                        title={rowTooltip}
                        onClick={() => {
                          void navigate(primaryTargetUrl);
                        }}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
                      >
                        <SidebarRowDot signal={hasSignal} kind={sidebarDotKindFromLife(effectiveLife) ?? 'unread'} />
                        <PersonaAvatar persona={personaAvatarOf(persona)} size={20} decorative />
                        <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 font-normal ${
                          hasSignal ? 'text-ink' : 'text-ink-soft group-hover:text-ink'
                        }`}>
                          {persona.name}
                        </span>
                        {persona.pinned ? (
                          <span aria-hidden className="shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span>
                        ) : null}
                      </button>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <span className={`flex items-center gap-0.5 transition-opacity duration-[var(--kiki-motion-quick)] ${
                          menuOpenForRow
                            ? 'w-auto overflow-visible opacity-100'
                            : 'w-auto overflow-visible opacity-100 [@media(hover:hover)_and_(pointer:fine)]:w-0 [@media(hover:hover)_and_(pointer:fine)]:overflow-hidden [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:w-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover:overflow-visible [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:w-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:overflow-visible [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100'
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

                        {hasMultiThreads ? (
                          <button
                            type="button"
                            data-persona-switcher-toggle={persona.id}
                            data-persona-thread-count={totalConversations}
                            aria-haspopup="menu"
                            aria-expanded={switcherOpenForPersona}
                            aria-label={switcherAria}
                            title={switcherAria}
                            onClick={(event) => {
                              event.stopPropagation();
                              togglePersonaSwitcher(persona, event.currentTarget);
                            }}
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
                              switcherOpenForPersona ? 'bg-ink/[0.06] text-ink' : ''
                            }`}
                          >
                            <DisclosureChevron open={switcherOpenForPersona} size={12} className="shrink-0" />
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {activeSubthread !== undefined ? (
                      <ul
                        data-persona-subthreads={persona.id}
                        className="mt-0.5 mb-1 ml-[19px] flex flex-col gap-px border-l border-hairline pl-1.5"
                      >
                        {(() => {
                          const thread = activeSubthread;
                          const subMenuOpen = sessionMenu.menuSessionId === thread.id;
                          const canOpenSubMenu = thread.session !== undefined;
                          const subSignal = thread.needsYou || thread.life === 'working' || thread.life === 'done';
                          return (
                            <li
                              key={thread.id}
                              className="group/sub relative"
                              onContextMenu={(event) => {
                                if (!canOpenSubMenu) return;
                                event.preventDefault();
                                event.stopPropagation();
                                openSubthreadMenu(persona, thread, event.clientX, event.clientY);
                              }}
                            >
                              <div className="row-interactive flex min-h-8 w-full items-center gap-1 bg-ink/[0.04] pr-1 pl-2 pointer-coarse:min-h-11">
                                <button
                                  type="button"
                                  data-persona-subthread={thread.id}
                                  data-persona-subthread-kind={thread.kind}
                                  aria-current="page"
                                  title={thread.fullTitle}
                                  onClick={() => { void navigate(thread.targetUrl); }}
                                  className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-[13px] leading-5 font-normal focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
                                >
                                  <SidebarRowDot signal={subSignal} kind={sidebarDotKindFromLife(thread.life, { needsYou: thread.needsYou })} />
                                  {thread.kind === 'room' ? (
                                    <span aria-hidden className="shrink-0 font-mono text-[12px] text-ink-faint">#</span>
                                  ) : null}
                                  <span className={`min-w-0 flex-1 truncate ${subSignal ? 'text-ink' : 'text-ink-soft'}`}>
                                    {thread.shortTitle}
                                  </span>
                                </button>
                                {canOpenSubMenu ? (
                                  <button
                                    type="button"
                                    data-persona-subthread-menu={thread.id}
                                    aria-haspopup="menu"
                                    aria-expanded={subMenuOpen}
                                    aria-label={t('sidebar.sessionActionsFor', { title: thread.fullTitle })}
                                    title={t('sidebar.sessionActionsFor', { title: thread.fullTitle })}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (subMenuOpen) {
                                        sessionMenu.closeSessionMenu();
                                        return;
                                      }
                                      const rect = event.currentTarget.getBoundingClientRect();
                                      openSubthreadMenu(persona, thread, rect.right + 4, rect.top);
                                    }}
                                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-opacity duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.07] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11 ${
                                      subMenuOpen
                                        ? 'opacity-100'
                                        : 'opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/sub:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/sub:opacity-100'
                                    }`}
                                  >
                                    <Icon name="more" size={12} />
                                  </button>
                                ) : null}
                              </div>
                            </li>
                          );
                        })()}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {hasOverflow && (showAllPersonas || hiddenMoreCount > 0) ? (
              <button
                type="button"
                data-sidebar-personas-more={showAllPersonas ? 'less' : 'more'}
                aria-expanded={showAllPersonas}
                onClick={() => { setSidebarPersonasShowAll(!showAllPersonas); }}
                className="row-interactive mt-0.5 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink-faint tabular-nums transition-colors hover:text-ink"
              >
                <span className="w-[7px] shrink-0" aria-hidden />
                <span className="min-w-0 truncate">
                  {showAllPersonas
                    ? t('sidebar.persona.showLess')
                    : t('sidebar.persona.showMore', { count: hiddenMoreCount })}
                </span>
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {roomDialog !== null ? (
        <CreateRoomDialog
          initialPersonaId={roomDialog.initialPersonaId}
          onClose={() => { setRoomDialog(null); }}
        />
      ) : null}

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

      {switcherState !== null ? (
        <PersonaConversationSwitcher
          anchor={switcherState.anchor}
          align="end"
          persona={switcherState.persona}
          sessions={mergePersonaConversations(
            [
              ...(switcherQuery.data?.items ?? []).filter((item) => sessionMatchesPrivateFilter(item, privateFilter)),
              ...(serverSessionsByPersona.get(switcherState.persona.id) ?? []),
            ],
            filteredSessions,
            switcherState.persona.id,
          )}
          status={
            switcherQuery.isError
              ? { error: switcherQuery.error instanceof Error ? switcherQuery.error.message : String(switcherQuery.error) }
              : switcherQuery.isPending && (serverSessionsByPersona.get(switcherState.persona.id)?.length ?? 0) === 0
                ? { loading: true }
                : undefined
          }
          activeSessionId={activeSessionId}
          workspaceOptions={workspaceOptions}
          seen={seen}
          roomNames={roomNames}
          onClose={() => { setSwitcherState(null); }}
        />
      ) : null}

      {sessionMenu.menuPortal}
    </div>
  );
}

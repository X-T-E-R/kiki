/**
 * SidebarPersonaSection: the sidebar's persona group.
 *
 * One row per persona, at the same density as a conversation row: the 7px
 * status slot, a 20px face, the name, the unread count, and trailing controls
 * for quick actions and the conversation switcher. The row's own click is the
 * person ("go talk to them"), not a conversation, so it always lands on the
 * stable `/p/:id/daily` address and lets the daily pointer decide where that
 * is. The group header folds into `LayoutPreferences` without introducing an
 * inner scroll container, and caps the default preview slice to eight rows.
 */

import { useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { PersonaSummary, RoomListItem, Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { isPinnedSession, sessionRowState } from '@kiki/session-core/sessions';
import { setSidebarPersonaSectionCollapsed, type SessionSeenMap } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { BOTS_QUERY_KEY } from '../../lib/botRooms';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { useConnection } from '../../state/connection';
import { useGuardedNavigate } from '../dirtyGuard';
import { DisclosureChevron, Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { CreateRoomDialog } from '../room/CreateRoomDialog';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';
import { PersonaConversationSwitcher } from './PersonaConversationSwitcher';
import {
  compactPersonaThreadTitle,
  mergePersonaConversations,
  sessionBelongsToPersona,
  sessionPersonaId,
} from './personaSessionUtils';
import { usePersonaSwitcherConversations } from './usePersonaSwitcherConversations';
import { sortAndFilterDirectory, usePersonaDirectory, type PersonaDirectoryEntry } from './usePersonaDirectory';
import { invalidatePersonas } from './usePersonas';

/** Default preview cap when the persona section is expanded. */
export const SIDEBAR_PERSONA_PREVIEW_LIMIT = 8;
/** Inline non-home topic/room conversations surfaced beneath a multi-thread persona. */
export const SIDEBAR_PERSONA_INLINE_THREAD_LIMIT = 2;

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
const ROW_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint opacity-60 transition-opacity duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink';

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

function personaPreviewPriority(item: PersonaDirectoryEntry, activePersonaId: string | undefined): number {
  if (item.pinned) return 0;
  if (activePersonaId !== undefined && item.id === activePersonaId) return 1;
  if (item.life === 'waiting') return 2;
  if (item.life === 'working') return 3;
  if (item.life === 'done' || item.unreadCount > 0) return 4;
  return 5;
}

export function orderSidebarPersonas(
  items: readonly PersonaDirectoryEntry[],
  activePersonaId?: string,
): PersonaDirectoryEntry[] {
  return sortAndFilterDirectory(items).sort((a, b) => {
    const pa = personaPreviewPriority(a, activePersonaId);
    const pb = personaPreviewPriority(b, activePersonaId);
    if (pa !== pb) return pa - pb;
    if (a.lastActivityAt !== b.lastActivityAt) {
      return (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity);
    }
    return a.name.localeCompare(b.name);
  });
}

export interface SidebarPersonaSectionProps {
  readonly sessions: readonly Session[];
  readonly activeSessionId?: string;
  readonly seen: SessionSeenMap;
  readonly workspaceOptions?: readonly WorkspaceCatalogEntry[];
  /** Room names for the switcher's member rows; the ids are what the row opens. */
  readonly rooms?: readonly RoomListItem[];
}

export function SidebarPersonaSection({
  sessions,
  activeSessionId,
  seen,
  workspaceOptions = [],
  rooms = [],
}: SidebarPersonaSectionProps) {
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { client } = useConnection();
  const layoutPrefs = useLayoutPreferences();
  const collapsed = layoutPrefs.sidebarPersonaSectionCollapsed === true;

  const { directory } = usePersonaDirectory({ sessions, seen });
  const activePersonaId = useMemo(() => {
    const fromRoute = activeRoutePersonaId(location.pathname, location.search);
    if (fromRoute !== undefined) return fromRoute;
    if (activeSessionId === undefined) return undefined;
    const byHome = directory.find((entry) => entry.homeSessionId === activeSessionId);
    if (byHome !== undefined) return byHome.id;
    const openSession = sessions.find((session) => session.id === activeSessionId);
    return openSession === undefined ? undefined : sessionPersonaId(openSession);
  }, [location.pathname, location.search, activeSessionId, directory, sessions]);

  const visiblePersonas = useMemo(
    () => orderSidebarPersonas(directory, activePersonaId),
    [directory, activePersonaId],
  );
  const roomNames = useMemo(() => new Map(rooms.map((room) => [room.id, room.title])), [rooms]);

  const [showAllPersonas, setShowAllPersonas] = useState(false);
  const [switcher, setSwitcher] = useState<{ persona: PersonaDirectoryEntry; anchor: HTMLElement } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ persona: PersonaDirectoryEntry; x: number; y: number } | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const switcherToggleRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const conversationsQuery = usePersonaSwitcherConversations(switcher?.persona.id, switcher !== null);
  const personaConversations = useMemo(() => {
    if (switcher === null) return [];
    return mergePersonaConversations(conversationsQuery.data?.items, sessions, switcher.persona.id);
  }, [conversationsQuery.data?.items, sessions, switcher]);

  const extraThreadsByPersona = useMemo(() => {
    const map = new Map<string, readonly InlinePersonaThread[]>();
    if (visiblePersonas.length === 0 || sessions.length === 0) return map;
    const untitled = t('sidebar.untitled');
    for (const persona of visiblePersonas) {
      const unreadIds = new Set(persona.unreadSessionIds);
      const threads = sessions
        .filter((item) => !item.archived && item.id !== persona.homeSessionId && sessionBelongsToPersona(item, persona.id))
        .map((item): InlinePersonaThread => {
          const roomId = typeof item.metadata?.['room_member_of'] === 'string'
            ? item.metadata['room_member_of']
            : undefined;
          const fullTitle = roomId === undefined
            ? rawThreadTitle(item, untitled)
            : roomNames.get(roomId) ?? rawThreadTitle(item, untitled);
          const rawState = sessionRowState(item, seen);
          const state = rawState === 'unread' && (persona.unreadCount === 0 || (unreadIds.size > 0 && !unreadIds.has(item.id)))
            ? 'read'
            : rawState;
          return {
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
          };
        })
        .sort((a, b) => {
          if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
          if ((a.life === 'working') !== (b.life === 'working')) return a.life === 'working' ? -1 : 1;
          if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
        });
      if (threads.length > 0) map.set(persona.id, threads);
    }
    return map;
  }, [activeSessionId, roomNames, seen, sessions, t, visiblePersonas]);

  if (visiblePersonas.length === 0) return null;

  const hasOverflow = visiblePersonas.length > SIDEBAR_PERSONA_PREVIEW_LIMIT;
  const shownPersonas = !hasOverflow || showAllPersonas
    ? visiblePersonas
    : visiblePersonas.slice(0, SIDEBAR_PERSONA_PREVIEW_LIMIT);
  const hiddenMoreCount = Math.max(0, visiblePersonas.length - SIDEBAR_PERSONA_PREVIEW_LIMIT);

  const collapsedLife: 'idle' | 'working' | 'waiting' | 'done' = visiblePersonas.some((item) => item.life === 'waiting')
    ? 'waiting'
    : visiblePersonas.some((item) => item.life === 'working')
      ? 'working'
      : visiblePersonas.some((item) => item.unreadCount > 0 || item.life === 'done')
        ? 'done'
        : 'idle';
  const collapsedUnreadTotal = visiblePersonas.reduce((sum, item) => sum + item.unreadCount, 0);

  const openSwitcher = (persona: PersonaDirectoryEntry, anchor: HTMLElement) => {
    setRowMenu(null);
    setSwitcher((current) => (current?.persona.id === persona.id ? null : { persona, anchor }));
  };

  const openUnread = (event: React.MouseEvent, persona: PersonaDirectoryEntry, anchor: HTMLElement) => {
    event.stopPropagation();
    if (persona.unreadSessionIds.length === 1) {
      void navigate(`/s/${encodeURIComponent(persona.unreadSessionIds[0]!)}`);
      return;
    }
    setRowMenu(null);
    setSwitcher({ persona, anchor });
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
          key: 'pin',
          label: rowMenu.persona.pinned ? t('persona.unpin') : t('persona.pin'),
          run: () => patchPersonaState(rowMenu.persona, { pinned: !rowMenu.persona.pinned }),
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
                const extraThreads = extraThreadsByPersona.get(persona.id) ?? [];
                const hasExtraThreads = extraThreads.length > 0;
                const totalConversations = extraThreads.length + 1;
                const inlineSubthreadActive = extraThreads.some((item) => item.isCurrent);
                const isSelectedPersona = activePersonaId === persona.id
                  || inlineSubthreadActive
                  || (persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId);
                const attentionThreads = extraThreads.filter(
                  (item) => item.needsYou || item.life === 'working' || item.life === 'done',
                );
                const inlineThreads = (() => {
                  if (!hasExtraThreads) return [];
                  if (isSelectedPersona) {
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
                  return [];
                })();
                const overflowThreadCount = inlineThreads.length > 0
                  ? Math.max(0, extraThreads.length - inlineThreads.length)
                  : 0;
                const atDaily = (persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId)
                  || (activePersonaId === persona.id && !inlineSubthreadActive);
                const emphasis = atDaily || inlineSubthreadActive || persona.life === 'waiting' || persona.life === 'done';
                const menuOpenForRow = rowMenu?.persona.id === persona.id;
                const switcherOpenForRow = switcher?.persona.id === persona.id;
                return (
                  <li
                    key={persona.id}
                    className="group relative"
                    data-sidebar-persona-row={persona.id}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSwitcher(null);
                      setRowMenu({ persona, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <div className="relative">
                      <button
                        type="button"
                        aria-current={atDaily ? 'page' : undefined}
                        aria-label={t('persona.openDaily', { name: persona.name })}
                        title={t('persona.openDaily', { name: persona.name })}
                        onClick={() => { void navigate(`/p/${encodeURIComponent(persona.id)}/daily`); }}
                        className={`row-interactive flex h-8 w-full items-center gap-2 py-0 pl-2 text-left ${
                          persona.unreadCount > 0
                            ? (hasExtraThreads ? 'pr-[92px]' : 'pr-[78px]')
                            : (hasExtraThreads ? 'pr-[68px]' : 'pr-14')
                        }`}
                      >
                        <span className="flex h-[19px] w-[7px] shrink-0 items-center">
                          <LifeMark
                            markId={`persona:${persona.id}`}
                            life={persona.life}
                            still
                            tone={persona.life === 'waiting' ? 'bg-attention' : undefined}
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

                      {persona.unreadCount > 0 ? (
                        <button
                          type="button"
                          data-persona-unread-count={persona.unreadCount}
                          aria-label={t('persona.unreadCountTitle', { count: persona.unreadCount })}
                          title={t('persona.unreadCountTitle', { count: persona.unreadCount })}
                          onClick={(event) => { openUnread(event, persona, event.currentTarget); }}
                          className={`absolute top-0 flex h-8 min-w-4 items-center px-1 text-[12px] leading-4 font-medium text-accent-ink tabular-nums ${
                            hasExtraThreads ? 'right-[68px]' : 'right-[54px]'
                          }`}
                        >
                          {persona.unreadCount}
                        </button>
                      ) : null}

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
                          setSwitcher(null);
                          setRowMenu((current) =>
                            current?.persona.id === persona.id ? null : { persona, x: rect.right + 4, y: rect.top });
                        }}
                        className={`absolute top-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-opacity duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink ${
                          hasExtraThreads ? 'right-10' : 'right-7'
                        } ${
                          menuOpenForRow ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
                        }`}
                      >
                        <Icon name="more" size={14} />
                      </button>

                      <button
                        ref={(node) => {
                          if (node !== null) switcherToggleRefs.current.set(persona.id, node);
                          else switcherToggleRefs.current.delete(persona.id);
                        }}
                        type="button"
                        data-persona-switcher-toggle={persona.id}
                        data-persona-thread-count={hasExtraThreads ? totalConversations : undefined}
                        aria-haspopup="menu"
                        aria-expanded={switcherOpenForRow}
                        aria-label={t('persona.openSwitcherAria', { name: persona.name })}
                        title={t('persona.openSwitcherAria', { name: persona.name })}
                        onClick={(event) => {
                          event.stopPropagation();
                          openSwitcher(persona, event.currentTarget);
                        }}
                        className={hasExtraThreads
                          ? `absolute top-1 right-0.5 flex h-6 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-md px-1.5 text-[11px] leading-none font-medium tabular-nums transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-selected-ink ${
                              switcherOpenForRow
                                ? 'bg-ink/[0.09] text-ink'
                                : 'bg-ink/[0.045] text-ink-soft hover:bg-ink/[0.08] hover:text-ink'
                            }`
                          : `absolute top-0.5 right-0.5 ${ROW_BUTTON}`}
                      >
                        {hasExtraThreads ? (
                          <>
                            <span>{totalConversations}</span>
                            <DisclosureChevron open={switcherOpenForRow} size={12} className="shrink-0 text-ink-faint" />
                          </>
                        ) : (
                          <Icon name="chevron" size={12} />
                        )}
                      </button>
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
                                const anchor = switcherToggleRefs.current.get(persona.id) ?? event.currentTarget;
                                openSwitcher(persona, anchor);
                              }}
                              className="row-interactive flex h-6 w-full items-center pr-2 pl-[23px] text-left text-[11px] leading-4 text-ink-faint transition-colors hover:text-ink"
                            >
                              <span className="min-w-0 truncate">
                                +{overflowThreadCount} · {t('persona.allConversations')}
                              </span>
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

      {switcher !== null ? (
        <PersonaConversationSwitcher
          anchor={switcher.anchor}
          align="end"
          persona={switcher.persona}
          sessions={personaConversations}
          status={{
            loading: conversationsQuery.isPending,
            error: conversationsQuery.isError ? errorText(locale, conversationsQuery.error) : undefined,
          }}
          activeSessionId={activeSessionId}
          workspaceOptions={workspaceOptions}
          seen={seen}
          roomNames={roomNames}
          onClose={() => { setSwitcher(null); }}
        />
      ) : null}
    </div>
  );
}

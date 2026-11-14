/**
 * SidebarPersonaSection: the sidebar's persona group.
 *
 * One row per persona, at the same density as a conversation row: the 7px
 * status slot, a 20px face, the name, the unread count, and trailing controls
 * for quick actions and the conversation switcher. The row's own click is the
 * person ("go talk to them"), not a conversation, so it always lands on the
 * stable `/p/:id/daily` address and lets the daily pointer decide where that
 * is. The group header folds into `LayoutPreferences` without introducing an
 * inner scroll container, and caps the default preview slice to four rows.
 */

import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { PersonaSummary, RoomListItem, Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
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
import { sessionBelongsToPersona, sessionPersonaId } from './personaSessionUtils';
import { usePersonaSwitcherConversations } from './usePersonaSwitcherConversations';
import { sortAndFilterDirectory, usePersonaDirectory, type PersonaDirectoryEntry } from './usePersonaDirectory';
import { invalidatePersonas } from './usePersonas';

/** Default preview cap when the persona section is expanded. */
export const SIDEBAR_PERSONA_PREVIEW_LIMIT = 4;

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
  return 4;
}

export function orderSidebarPersonas(
  items: readonly PersonaDirectoryEntry[],
  activePersonaId?: string,
): PersonaDirectoryEntry[] {
  return sortAndFilterDirectory(items).sort((a, b) => {
    const pa = personaPreviewPriority(a, activePersonaId);
    const pb = personaPreviewPriority(b, activePersonaId);
    if (pa !== pb) return pa - pb;
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

  const conversationsQuery = usePersonaSwitcherConversations(switcher?.persona.id, switcher !== null);
  const loadedConversations = useMemo(() => {
    if (switcher === null) return [];
    return sessions.filter((session) => sessionBelongsToPersona(session, switcher.persona.id));
  }, [sessions, switcher]);
  const personaConversations = conversationsQuery.data?.items ?? loadedConversations;

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
                const atDaily = (persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId)
                  || activePersonaId === persona.id;
                const emphasis = atDaily || persona.life === 'waiting' || persona.life === 'done';
                const menuOpenForRow = rowMenu?.persona.id === persona.id;
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
                    <button
                      type="button"
                      aria-current={atDaily ? 'page' : undefined}
                      aria-label={t('persona.openDaily', { name: persona.name })}
                      title={t('persona.openDaily', { name: persona.name })}
                      onClick={() => { void navigate(`/p/${encodeURIComponent(persona.id)}/daily`); }}
                      className={`row-interactive flex h-8 w-full items-center gap-2 py-0 pl-2 text-left ${
                        persona.unreadCount > 0 ? 'pr-[78px]' : 'pr-14'
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
                        className="absolute top-0 right-[54px] flex h-8 min-w-4 items-center px-1 text-[12px] leading-4 font-medium text-accent-ink tabular-nums"
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
                      className={`absolute top-0.5 right-7 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-opacity duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink ${
                        menuOpenForRow ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
                      }`}
                    >
                      <Icon name="more" size={14} />
                    </button>

                    <button
                      type="button"
                      data-persona-switcher-toggle={persona.id}
                      aria-haspopup="menu"
                      aria-expanded={switcher?.persona.id === persona.id}
                      aria-label={t('persona.openSwitcherAria', { name: persona.name })}
                      title={t('persona.openSwitcherAria', { name: persona.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        openSwitcher(persona, event.currentTarget);
                      }}
                      className={`absolute top-0.5 right-0.5 ${ROW_BUTTON}`}
                    >
                      <Icon name="chevron" size={12} />
                    </button>
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

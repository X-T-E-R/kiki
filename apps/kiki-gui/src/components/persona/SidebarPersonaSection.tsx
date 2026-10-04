/**
 * SidebarPersonaSection: the sidebar's persona group.
 *
 * One row per persona, at the same density as a conversation row: the 7px
 * status slot, a 20px face, the name, the unread count, and a trailing
 * control that opens the conversation switcher. The row's own click is the
 * person ("go talk to them"), not a conversation, so it always lands on the
 * stable `/p/:id/daily` address and lets the daily pointer decide where that
 * is. The chevron is the other action: which conversation.
 *
 * Rooms are not repeated here — they already have conversation rows in the
 * sidebar's main list.
 */

import { useMemo, useState } from 'react';
import type { RoomListItem, Session, Workspace } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import type { SessionSeenMap } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { CreateRoomDialog } from '../room/CreateRoomDialog';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';
import { PersonaConversationSwitcher } from './PersonaConversationSwitcher';
import { sessionBelongsToPersona } from './personaSessionUtils';
import { usePersonaSwitcherConversations } from './usePersonaSwitcherConversations';
import { sortAndFilterDirectory, usePersonaDirectory, type PersonaDirectoryEntry } from './usePersonaDirectory';

const GROUP_HEAD = 'flex h-7 items-center gap-1 pr-1 pl-2';
const GROUP_LABEL = 'min-w-0 flex-1 truncate text-[12px] leading-4 font-medium text-section-ink';
const HEAD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';
const ROW_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint opacity-60 transition-opacity duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink';

export interface SidebarPersonaSectionProps {
  readonly sessions: readonly Session[];
  readonly activeSessionId?: string;
  readonly seen: SessionSeenMap;
  readonly workspaceOptions?: readonly Workspace[];
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
  const { directory } = usePersonaDirectory({ sessions, seen });
  const visiblePersonas = useMemo(() => sortAndFilterDirectory(directory), [directory]);
  const roomNames = useMemo(() => new Map(rooms.map((room) => [room.id, room.title])), [rooms]);

  const [switcher, setSwitcher] = useState<{ persona: PersonaDirectoryEntry; anchor: HTMLElement } | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  // The switcher asks the server who this persona's conversations are, the
  // same read the session header makes: the sidebar's own list is one page of
  // every session, and a persona's older conversations are usually not in it.
  // Nothing is prefetched; opening the panel is the trigger.
  const conversationsQuery = usePersonaSwitcherConversations(switcher?.persona.id, switcher !== null);
  const loadedConversations = useMemo(() => {
    if (switcher === null) return [];
    return sessions.filter((session) => sessionBelongsToPersona(session, switcher.persona.id));
  }, [sessions, switcher]);
  // Until the server answers, the loaded rows stay: they are the truth the
  // sidebar already had, and an empty panel for a beat reads as "none".
  const personaConversations = conversationsQuery.data?.items ?? loadedConversations;

  // No personas, nothing to say: the primary nav already owns the stable
  // entry, so an empty group would only be furniture.
  if (visiblePersonas.length === 0) return null;

  const openSwitcher = (persona: PersonaDirectoryEntry, anchor: HTMLElement) => {
    setSwitcher((current) => (current?.persona.id === persona.id ? null : { persona, anchor }));
  };

  const openUnread = (event: React.MouseEvent, persona: PersonaDirectoryEntry, anchor: HTMLElement) => {
    event.stopPropagation();
    // One unread conversation is an address; several are a question.
    if (persona.unreadSessionIds.length === 1) {
      navigate(`/s/${encodeURIComponent(persona.unreadSessionIds[0]!)}`);
      return;
    }
    setSwitcher({ persona, anchor });
  };

  return (
    <div data-sidebar-personas className="max-h-[38vh] shrink-0 overflow-y-auto px-2 pb-1">
      <div role="group" aria-label={t('persona.groupTitle')} className="mb-2">
        <div className={GROUP_HEAD}>
          <h2 className={GROUP_LABEL}>{t('persona.groupTitle')}</h2>
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
            onClick={() => { navigate('/personas?new=1'); }}
            className={HEAD_BUTTON}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>

        <ul className="flex flex-col gap-px">
          {visiblePersonas.map((persona) => {
            const atDaily = persona.homeSessionId !== undefined && persona.homeSessionId === activeSessionId;
            const emphasis = atDaily || persona.life === 'waiting' || persona.life === 'done';
            return (
              <li key={persona.id} className="group relative" data-sidebar-persona-row={persona.id}>
                <button
                  type="button"
                  aria-current={atDaily ? 'page' : undefined}
                  aria-label={t('persona.openDaily', { name: persona.name })}
                  title={t('persona.openDaily', { name: persona.name })}
                  onClick={() => { navigate(`/p/${encodeURIComponent(persona.id)}/daily`); }}
                  className={`row-interactive flex h-8 w-full items-center gap-2 py-0 pl-2 text-left ${
                    persona.unreadCount > 0 ? 'pr-[54px]' : 'pr-8'
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

                {/* The count is the bounded thing: it says how many of their
                  * conversations are waiting, not how many messages. */}
                {persona.unreadCount > 0 ? (
                  <button
                    type="button"
                    data-persona-unread-count={persona.unreadCount}
                    aria-label={t('persona.unreadCountTitle', { count: persona.unreadCount })}
                    title={t('persona.unreadCountTitle', { count: persona.unreadCount })}
                    onClick={(event) => { openUnread(event, persona, event.currentTarget); }}
                    className="absolute top-0 right-8 flex h-8 min-w-4 items-center px-1 text-[12px] leading-4 font-medium text-accent-ink tabular-nums"
                  >
                    {persona.unreadCount}
                  </button>
                ) : null}

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
      </div>

      {creatingRoom ? <CreateRoomDialog onClose={() => { setCreatingRoom(false); }} /> : null}

      {switcher !== null ? (
        <PersonaConversationSwitcher
          anchor={switcher.anchor}
          // The sidebar's own row-menu convention: the panel's right edge sits
          // on the row's and it opens leftwards over the rail's column.
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

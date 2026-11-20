/**
 * PersonaSessionIdentity: the header of a conversation that belongs to a
 * persona.
 *
 * Two lines, in the order a person reads them:
 *   [face] 小柚 ▾          who this conversation is with; ▾ opens the shared
 *                          conversation switcher, which unfolds from this
 *                          block's left edge into the content column;
 *   日常对话 · EasyAgent    which conversation, and which project it runs in.
 *
 * The block is the header's growing cell (`flex-1`), the role the plain title
 * plays in a session without a persona: that is what keeps the header's
 * actions — 消息|过程, ⋯, preview — as one group on the right instead of
 * crowding the face. The name stays readable at every width; only its length
 * gives.
 *
 * The second line names the daily conversation for a home session, the room
 * for a seat in one, and the (renameable) topic otherwise — the title element
 * is handed in by the session header so in-place renaming keeps working.
 * A session without a persona never renders this; nothing here changes it.
 */

import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@kiki/protocol';
import type { SessionListData } from '@kiki/session-core/sessions';
import { sessionSeenSnapshot, subscribeSessionSeen } from '@kiki/session-core/settings';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { useLayoutPreferences, useMediaQuery } from '../../lib/layoutHooks';
import { ROOM_ITEMS_QUERY_KEY } from '../../lib/useConversationList';
import { DisclosureChevron } from '../icons';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';
import { PersonaConversationSwitcher } from './PersonaConversationSwitcher';
import { buildPersonaDirectory } from './usePersonaDirectory';
import { usePersonaList } from './usePersonas';
import { usePersonaSwitcherConversations } from './usePersonaSwitcherConversations';
import { mergePersonaConversations, sessionMatchesPrivateFilter, sessionPersonaId } from './personaSessionUtils';

export interface PersonaSessionIdentityProps {
  readonly session: Session;
  /** The conversation's name: daily and room seats are fixed, topics rename. */
  readonly title: React.ReactNode;
}

export function PersonaSessionIdentity({ session, title }: PersonaSessionIdentityProps) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  // The block the switcher aligns to: the panel opens under the person, into
  // the content column, not under the chevron (which would put it on the
  // sidebar).
  const block = useRef<HTMLDivElement>(null);
  const bound = session.agent_config.persona;
  const personaId = sessionPersonaId(session);
  const seen = useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);

  // The directory entry the switcher needs (daily pointer, unread, life).
  const personasQuery = usePersonaList();
  const summary = personasQuery.data?.find((entry) => entry.id === personaId);

  // Only the workspace's display name is read here, so the metadata-only
  // catalog answers it without the full listing's counts and Git probe.
  const workspacesQuery = useQuery({
    queryKey: ['workspaces', 'catalog'],
    queryFn: () => client.listWorkspaceCatalog(),
    staleTime: 30_000,
  });
  const workspaceOptions = workspacesQuery.data?.items ?? [];
  const workspaceName = session.workspace_id === undefined
    ? undefined
    : workspaceOptions.find((workspace) => workspace.id === session.workspace_id)?.name ?? session.workspace_id;

  const roomQuery = useQuery({
    queryKey: ROOM_ITEMS_QUERY_KEY,
    queryFn: () => {
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
      return rest.rooms.listItems();
    },
    enabled: session.metadata['room_member_of'] !== undefined || open,
    staleTime: 15_000,
    retry: false,
  });
  const roomId = typeof session.metadata['room_member_of'] === 'string' ? session.metadata['room_member_of'] : undefined;
  const roomName = roomId === undefined ? undefined : roomQuery.data?.find((room) => room.id === roomId)?.title;
  const roomNames = useMemo(
    () => (roomQuery.data === undefined ? undefined : new Map(roomQuery.data.map((room) => [room.id, room.title]))),
    [roomQuery.data],
  );

  // The switcher's list is the server's answer for this persona (D5): read
  // when the switcher opens, not on every visit to the conversation. The
  // sidebar's switcher reads the same entry.
  const queryClient = useQueryClient();
  const layoutPrefs = useLayoutPreferences();
  const rawPrivateFilter = layoutPrefs.filters.private ?? 'hide';
  const effectivePrivateFilter = session.private === true && rawPrivateFilter === 'hide' ? 'include' : rawPrivateFilter;
  const conversationsQuery = usePersonaSwitcherConversations(personaId, open, effectivePrivateFilter);
  const loadedConversations = useMemo(() => {
    if (!open || personaId === undefined) return [session];
    const seenIds = new Set<string>([session.id]);
    const list: Session[] = [session];
    for (const [, cached] of queryClient.getQueriesData<SessionListData>({ queryKey: ['sessions'] })) {
      for (const page of cached?.pages ?? []) {
        for (const item of page.items) {
          if (!seenIds.has(item.id) && sessionMatchesPrivateFilter(item, effectivePrivateFilter)) {
            seenIds.add(item.id);
            list.push(item);
          }
        }
      }
    }
    return list;
  }, [effectivePrivateFilter, open, personaId, queryClient, session]);
  const conversations = useMemo(
    () => (personaId === undefined
      ? []
      : mergePersonaConversations(conversationsQuery.data?.items, loadedConversations, personaId)),
    [conversationsQuery.data?.items, loadedConversations, personaId],
  );
  const entry = useMemo(
    () => (summary === undefined ? undefined : buildPersonaDirectory([summary], [], conversations, seen)[0]),
    [conversations, seen, summary],
  );
  const narrow = useMediaQuery('(max-width: 639px)');

  if (bound === undefined) return null;
  const displayName = summary !== undefined && summary.name.trim() !== '' ? summary.name : bound.name;
  // The session carries its own face; the directory refines it with live name,
  // avatar, and shape changes once loaded.
  const face = summary === undefined
    ? bound
    : personaAvatarOf({
        id: bound.id,
        name: displayName,
        avatarMime: summary.avatarMime,
        avatarShape: summary.avatarShape ?? bound.avatarShape,
      });
  const isDaily = summary !== undefined && summary.homeSessionId === session.id;
  // One project cue per line: a topic's title element already carries the cwd
  // from `sm` up (that is the path the session runs in), so naming the
  // workspace again beside it would just repeat it. Below `sm` the workspace
  // lives in Session overview instead, so the title line gets the full width.
  const cwd = session.metadata.cwd;
  const titleNamesProject = !isDaily && roomId === undefined && !narrow
    && typeof cwd === 'string' && cwd !== '';

  return (
    <div
      ref={block}
      data-session-persona-identity={bound.id}
      // Single-row inline header inside h-12: [avatar · Persona ▾] / [title] [cwd].
      className="flex min-w-0 flex-1 items-center gap-1.5"
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <PersonaAvatar persona={face} size={20} decorative />
        <span data-session-persona-name className="max-w-[9rem] truncate font-sans text-[13.5px] leading-5 font-medium text-ink">{displayName}</span>
        <button
          type="button"
          ref={toggle}
          data-persona-header-toggle={bound.id}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('persona.openSwitcherAria', { name: displayName })}
          title={t('persona.openSwitcherAria', { name: displayName })}
          onClick={() => { setOpen((value) => !value); }}
          className="flex h-5 w-4 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <DisclosureChevron open={open} />
        </button>
      </div>
      <span aria-hidden className="shrink-0 text-[13px] text-ink-faint/70">/</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13.5px] leading-5 text-ink-soft">
        {isDaily ? (
          <span data-session-conversation-kind="daily" className="min-w-0 truncate font-sans text-[13.5px] font-medium text-ink">{t('persona.dailyTitle')}</span>
        ) : roomId !== undefined ? (
          <span className="flex min-w-0 items-center gap-1">
            <span aria-hidden className="shrink-0 font-mono text-ink-faint">#</span>
            <span data-session-conversation-kind="room" className="min-w-0 truncate font-sans text-[13.5px] font-medium text-ink">{roomName ?? t('persona.roomSeat')}</span>
          </span>
        ) : (
          <span data-session-identity-title className="flex min-w-0 flex-1 items-center">{title}</span>
        )}
        {narrow || workspaceName === undefined || titleNamesProject ? null : (
          <span className="flex min-w-0 shrink-[100] items-center gap-1.5 text-[12px] text-ink-faint">
            <span aria-hidden className="shrink-0">·</span>
            <span data-session-workspace className="min-w-0 truncate">{workspaceName}</span>
          </span>
        )}
      </div>

      {open && entry !== undefined ? (
        <PersonaConversationSwitcher
          anchor={toggle.current}
          align="start"
          alignTo={block.current}
          persona={entry}
          sessions={conversations}
          status={{
            loading: conversationsQuery.isPending,
            error: conversationsQuery.isError ? errorText(locale, conversationsQuery.error) : undefined,
          }}
          activeSessionId={session.id}
          workspaceOptions={workspaceOptions}
          seen={seen}
          roomNames={roomNames}
          onClose={() => { setOpen(false); }}
        />
      ) : null}
    </div>
  );
}

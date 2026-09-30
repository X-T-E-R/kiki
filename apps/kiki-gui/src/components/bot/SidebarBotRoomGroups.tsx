/**
 * The sidebar's Bots and Rooms groups. Bots sit above the session list, one
 * row per persona with a home session; rooms follow. The sessions behind
 * them (a Bot's home, a room member's own session) stay out of the plain
 * session list: each already has one address here.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';

import type { BotSummary, PersonaSummary, RoomDocument, Session } from '@kiki/protocol';
import { sessionRowState } from '@kiki/session-core/sessions';
import type { SessionSeenMap } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { BOTS_QUERY_KEY, ROOMS_QUERY_KEY, useBotRoomApi } from '../../lib/botRooms';
import { pushToast } from '../../lib/toasts';
import { registerOverlay } from '../../lib/uiBusy';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { PersonaAvatar, personaAvatarOf } from '../persona/PersonaAvatar';
import { usePersonaList } from '../persona/usePersonas';
import { CreateRoomDialog } from '../room/CreateRoomDialog';

/** Sessions that already have their own sidebar address (a Bot or a room). */
export function isBotOrRoomSession(session: Session): boolean {
  const metadata = session.metadata as Record<string, unknown>;
  return typeof metadata['bot_persona_id'] === 'string' || typeof metadata['room_member_of'] === 'string';
}

/** Pinned Bots first, then by name; hidden Bots stay off the sidebar. */
export function visibleBots(bots: readonly BotSummary[]): BotSummary[] {
  return bots
    .filter((bot) => !bot.hidden)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

const GROUP_HEAD = 'flex h-7 items-center gap-1 pr-1 pl-2';
const GROUP_LABEL = 'min-w-0 flex-1 truncate text-[12px] leading-4 font-medium text-section-ink';
const HEAD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

function useAvatarLookup(): ReadonlyMap<string, PersonaSummary> {
  const personas = usePersonaList();
  return useMemo(() => new Map((personas.data ?? []).map((item) => [item.id, item])), [personas.data]);
}

function botLife(session: Session | undefined, seen: SessionSeenMap) {
  if (session === undefined) return 'idle' as const;
  const state = sessionRowState(session, seen);
  return state === 'needs-me' ? 'waiting' as const : state === 'running' ? 'working' as const : state === 'unread' ? 'done' as const : 'idle' as const;
}

export function SidebarBotRoomGroups({
  sessions,
  activeSessionId,
  seen,
}: {
  readonly sessions: readonly Session[];
  readonly activeSessionId: string | undefined;
  readonly seen: SessionSeenMap;
}) {
  const { t } = useI18n();
  const api = useBotRoomApi();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const avatars = useAvatarLookup();
  const botsQuery = useQuery({ queryKey: BOTS_QUERY_KEY, queryFn: () => api.listBots(), staleTime: 15_000, retry: false });
  const roomsQuery = useQuery({ queryKey: ROOMS_QUERY_KEY, queryFn: () => api.listRooms(), staleTime: 15_000, retry: false });
  const [enableOpen, setEnableOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const enableButton = useRef<HTMLButtonElement>(null);

  const bots = visibleBots(botsQuery.data ?? []);
  const rooms = roomsQuery.data ?? [];
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const candidates = [...avatars.values()].filter((persona) =>
    !persona.archived && (botsQuery.data ?? []).every((bot) => bot.personaId !== persona.id));

  const openBot = useMutation({
    mutationFn: async (bot: BotSummary) => bot.homeSessionId ?? (await api.ensureBotHome(bot.personaId)).homeSessionId,
    onSuccess: (sessionId) => {
      if (sessionId !== undefined) navigate(`/s/${sessionId}`);
      void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY });
    },
    onError: (error) => { pushToast({ tone: 'error', text: t('room.actionFailed', { detail: errorText(error) }) }); },
  });
  const enable = useMutation({
    mutationFn: (persona: PersonaSummary) => api.enableBot(persona.id),
    onSuccess: (bot) => {
      setEnableOpen(false);
      pushToast({ tone: 'success', text: t('bot.enabledToast', { name: bot.name }) });
      void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (bot.homeSessionId !== undefined) navigate(`/s/${bot.homeSessionId}`);
    },
    onError: (error) => { pushToast({ tone: 'error', text: t('bot.enableFailed', { detail: errorText(error) }) }); },
  });

  const showBots = botsQuery.isSuccess && (bots.length > 0 || candidates.length > 0);
  // Rooms need Bot mode, which enabling any Bot turns on; without one the
  // group would only offer a create that the server refuses.
  const showRooms = roomsQuery.isSuccess && (rooms.length > 0 || (botsQuery.data ?? []).length > 0);
  if (!showBots && !showRooms) return null;
  return (
    <div data-sidebar-bot-rooms className="max-h-[38vh] shrink-0 overflow-y-auto px-2 pb-1">
      {showBots ? (
        <div role="group" aria-label={t('bot.group')} data-sidebar-bots className="mb-2">
          <div className={GROUP_HEAD}>
            <h2 className={GROUP_LABEL}>{t('bot.group')}</h2>
            {candidates.length > 0 ? (
              <button type="button" ref={enableButton} data-bot-enable-toggle
                aria-haspopup="menu" aria-expanded={enableOpen}
                aria-label={t('bot.enable')} title={t('bot.enable')}
                onClick={() => { setEnableOpen((open) => !open); }}
                className={HEAD_BUTTON}>
                <Icon name="plus" size={14} />
              </button>
            ) : null}
          </div>
          {enableOpen ? (
            <EnableBotMenu anchor={enableButton.current} personas={candidates}
              busyId={enable.isPending ? enable.variables?.id : undefined}
              onPick={(persona) => { enable.mutate(persona); }}
              onClose={() => { setEnableOpen(false); }} />
          ) : null}
          <ul className="flex flex-col gap-px">
            {bots.map((bot) => {
              const home = bot.homeSessionId === undefined ? undefined : sessionById.get(bot.homeSessionId);
              const life = botLife(home, seen);
              const summary = avatars.get(bot.personaId);
              const face = summary === undefined ? { id: bot.personaId, name: bot.name } : personaAvatarOf(summary);
              const active = bot.homeSessionId !== undefined && bot.homeSessionId === activeSessionId;
              return (
                <li key={bot.personaId}>
                  <button type="button" data-sidebar-bot={bot.personaId}
                    aria-current={active ? 'page' : undefined}
                    aria-label={t('bot.open', { name: bot.name })}
                    onClick={() => { openBot.mutate(bot); }}
                    className="row-interactive flex h-8 w-full items-center gap-2 pr-2 pl-2 text-left">
                    <span className="flex w-[7px] shrink-0 items-center">
                      <LifeMark markId={`bot:${bot.personaId}`} life={life} still
                        tone={life === 'waiting' ? 'bg-attention' : undefined} />
                    </span>
                    <PersonaAvatar persona={face} size={20} decorative />
                    <span className={`min-w-0 shrink truncate text-[13px] ${active || life === 'waiting' || life === 'done' ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                      {bot.name}
                    </span>
                    {bot.title !== undefined ? (
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{bot.title}</span>
                    ) : <span className="flex-1" />}
                    {bot.pinned ? <span aria-hidden className="shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {showRooms ? (
      <div role="group" aria-label={t('room.group')} data-sidebar-rooms>
        <div className={GROUP_HEAD}>
          <h2 className={GROUP_LABEL}>{t('room.group')}</h2>
          <button type="button" data-room-create aria-label={t('room.new')} title={t('room.new')}
            onClick={() => { setCreating(true); }} className={HEAD_BUTTON}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <ul className="flex flex-col gap-px">
          {rooms.map((room) => (
            <li key={room.id}>
              <RoomRow room={room} avatars={avatars} sessionById={sessionById}
                active={location.pathname === `/rooms/${room.id}`}
                onOpen={() => { navigate(`/rooms/${encodeURIComponent(room.id)}`); }} />
            </li>
          ))}
        </ul>
      </div>
      ) : null}
      {creating ? <CreateRoomDialog onClose={() => { setCreating(false); }} /> : null}
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Overlapping member faces; a ring in the sidebar colour separates them. */
export function AvatarStack({
  members,
  avatars,
  max = 3,
  size = 16,
}: {
  readonly members: readonly { readonly personaId: string }[];
  readonly avatars: ReadonlyMap<string, PersonaSummary>;
  readonly max?: number;
  readonly size?: number;
}) {
  const shown = members.slice(0, max);
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {shown.map((member, index) => {
        const summary = avatars.get(member.personaId);
        const face = summary === undefined ? { id: member.personaId, name: member.personaId } : personaAvatarOf(summary);
        return (
          <span key={member.personaId} className={`rounded-[5px] ring-2 ring-canvas ${index === 0 ? '' : '-ml-1'}`}>
            <PersonaAvatar persona={face} size={size} decorative />
          </span>
        );
      })}
      {members.length > max ? <span className="ml-1 text-[11px] text-ink-faint tabular-nums">+{members.length - max}</span> : null}
    </span>
  );
}

function RoomRow({
  room,
  avatars,
  sessionById,
  active,
  onOpen,
}: {
  readonly room: RoomDocument;
  readonly avatars: ReadonlyMap<string, PersonaSummary>;
  readonly sessionById: ReadonlyMap<string, Session>;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const working = room.members.some((member) => sessionById.get(member.sessionId)?.busy === true);
  const waiting = room.members.some((member) => sessionById.get(member.sessionId)?.pending_interaction !== undefined);
  const life = waiting ? 'waiting' as const : working ? 'working' as const : 'idle' as const;
  return (
    <button type="button" data-sidebar-room={room.id}
      aria-current={active ? 'page' : undefined}
      aria-label={t('room.open', { name: room.name })}
      onClick={onOpen}
      className="row-interactive flex h-8 w-full items-center gap-2 pr-2 pl-2 text-left">
      <span className="flex w-[7px] shrink-0 items-center">
        <LifeMark markId={`room:${room.id}`} life={life} still tone={life === 'waiting' ? 'bg-attention' : undefined} />
      </span>
      <span aria-hidden className="w-5 shrink-0 text-center font-mono text-[13px] text-ink-faint">#</span>
      <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? 'font-medium text-ink' : 'text-ink-soft'}`}>{room.name}</span>
      {room.paused ? <span aria-hidden className="shrink-0 text-ink-faint"><Icon name="hold" size={12} /></span> : null}
      <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{t('room.memberCountShort', { count: room.members.length })}</span>
    </button>
  );
}

const MENU_WIDTH = 240;

function EnableBotMenu({
  anchor,
  personas,
  busyId,
  onPick,
  onClose,
}: {
  readonly anchor: HTMLElement | null;
  readonly personas: readonly PersonaSummary[];
  readonly busyId: string | undefined;
  readonly onPick: (persona: PersonaSummary) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const unregister = registerOverlay('sidebar-enable-bot');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); anchor?.focus(); }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-enable-bot-menu], [data-bot-enable-toggle]') === null) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor, onClose]);
  const rect = anchor?.getBoundingClientRect();
  const left = Math.max(8, Math.min((rect?.right ?? MENU_WIDTH) - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
  return (
    <div ref={menuRef} data-enable-bot-menu role="menu" aria-label={t('bot.enable')}
      style={{ left, top: (rect?.bottom ?? 0) + 4, width: MENU_WIDTH }}
      className="anim-enter fixed z-50 max-h-[min(60vh,360px)] overflow-y-auto rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
      <p className="px-2.5 pt-2 pb-1 text-[12px] font-medium text-ink-faint">{t('bot.enable')}</p>
      {personas.map((persona) => (
        <button key={persona.id} type="button" role="menuitem" data-enable-bot={persona.id}
          disabled={busyId !== undefined}
          onClick={() => { onPick(persona); }}
          className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:opacity-60">
          <PersonaAvatar persona={personaAvatarOf(persona)} size={20} decorative />
          <span className="min-w-0 shrink truncate">{persona.name}</span>
          {persona.title !== undefined ? <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{persona.title}</span> : null}
          {busyId === persona.id ? <span className="status-dot-busy ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" /> : null}
        </button>
      ))}
    </div>
  );
}

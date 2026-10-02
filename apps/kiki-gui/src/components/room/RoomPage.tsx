/**
 * RoomPage — `/rooms/:id`. The room log is the room's truth: user lines keep
 * the right-aligned bubble, Bot lines read like the message view (face and
 * name once per run of a speaker), and system events sit centred in T4 with
 * their actions. The header carries the roster, the host, the budget, usage
 * and pause / continue; the members rail holds the room's settings.
 *
 * The log and usage are polled (no room push stream yet); a send or an
 * action refreshes both at once.
 *
 * Members are personas (a room-only session each) or threads that joined as
 * themselves; both resolve through `nameOf` / `faceOf` by member id. A busy
 * thread with "wait while busy" on is named under the log: it replies after
 * its current turn.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';

import type { QuestionAnswer, RoomDocument, RoomLogEntry, RoomMemberInput, RoomMessage, Session, UpdateRoomInput } from '@kiki/protocol';
import { formatTokens } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { ROOMS_QUERY_KEY, roomQueryKey, roomUsageQueryKey, useBotRoomApi } from '../../lib/botRooms';
import { pushToast } from '../../lib/toasts';
import { registerOverlay } from '../../lib/uiBusy';
import { useConnection } from '../../state/connection';
import { AvatarStack } from '../bot/SidebarBotRoomGroups';
import { ConfirmDialog } from '../ConfirmDialog';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { QuestionCard } from '../Interactions';
import { Markdown } from '../Markdown';
import { MESSAGE_FACE, SpeakerHead } from '../message/MessageRow';
import { PresenceLine } from '../message/MessageTimelineRows';
import { personaAvatarOf, type PersonaAvatarData } from '../persona/PersonaAvatar';
import { usePersonaList } from '../persona/usePersonas';
import { RelativeTime } from '../RelativeTime';
import { RoomComposer } from './RoomComposer';
import { RoomMembersPanel } from './RoomMembersPanel';
import { isStopFirstError, livePauseIndex, ROOM_LOG_WINDOW, ROOM_POLL_MS, roomTokenTotal, useRoomLog } from './roomLog';
import { roomMemberId, threadMemberFace, threadMemberName } from './threadRooms';

const HEADER_BUTTON =
  'flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-[12.5px] text-ink-soft transition-colors hover:bg-canvas hover:text-ink aria-expanded:bg-canvas aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:opacity-50 lg:h-8 lg:min-w-8';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RoomPage({
  sessions,
  onToggleSidebar,
}: {
  readonly sessions: readonly Session[];
  readonly onToggleSidebar: () => void;
}) {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const api = useBotRoomApi();
  const queryClient = useQueryClient();
  const roomQuery = useQuery({
    queryKey: roomQueryKey(id),
    queryFn: () => api.getRoom(id),
    refetchInterval: ROOM_POLL_MS,
    retry: false,
  });
  const room = roomQuery.data;

  if (roomQuery.isPending) {
    return <RoomShell onToggleSidebar={onToggleSidebar}><div className="p-8 text-[12.5px] text-ink-faint">{t('sidebar.loadingSessions')}</div></RoomShell>;
  }
  if (roomQuery.isError || room === undefined) {
    return (
      <RoomShell onToggleSidebar={onToggleSidebar} title={roomQuery.isError ? t('room.loadFailed') : undefined}>
        <div className="mx-auto max-w-md p-8 text-center">
          <p className="text-[13px] text-ink-soft">{roomQuery.isError ? errorText(roomQuery.error) : t('room.notFound')}</p>
          {roomQuery.isError ? (
            <button type="button" onClick={() => { void queryClient.invalidateQueries({ queryKey: roomQueryKey(id) }); }}
              className="mt-2 text-[12.5px] font-medium text-ink underline underline-offset-2">{t('common.retry')}</button>
          ) : null}
        </div>
      </RoomShell>
    );
  }
  return <RoomView key={room.id} room={room} sessions={sessions} onToggleSidebar={onToggleSidebar} />;
}

function RoomShell({ onToggleSidebar, title, children }: { readonly onToggleSidebar: () => void; readonly title?: string; readonly children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <header className="flex min-h-12 shrink-0 items-center gap-2 px-4">
        <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink md:hidden">
          <Icon name="menu" size={16} />
        </button>
        {title !== undefined ? <h1 className="truncate text-[15px] font-semibold text-ink">{title}</h1> : null}
      </header>
      {children}
    </div>
  );
}

function RoomView({
  room,
  sessions,
  onToggleSidebar,
}: {
  readonly room: RoomDocument;
  readonly sessions: readonly Session[];
  readonly onToggleSidebar: () => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const api = useBotRoomApi();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const log = useRoomLog(api, room.id);
  const usageQuery = useQuery({
    queryKey: roomUsageQueryKey(room.id),
    queryFn: () => api.roomUsage(room.id),
    refetchInterval: ROOM_POLL_MS,
    retry: false,
  });
  // Member sessions are polled on their own: the sidebar's session list is
  // paged and may not hold them.
  const memberIds = room.members.map((member) => member.sessionId);
  const memberSessionsQuery = useQuery({
    queryKey: ['rooms', room.id, 'member-sessions', memberIds.join(',')],
    queryFn: async () => (await Promise.all(memberIds.map((sessionId) => client.getSession(sessionId).catch(() => undefined))))
      .filter((session): session is Session => session !== undefined),
    refetchInterval: ROOM_POLL_MS,
  });
  const personasQuery = usePersonaList({ includeArchived: true });
  const personas = useMemo(
    () => new Map((personasQuery.data ?? []).map((item) => [item.id, item] as const)),
    [personasQuery.data],
  );
  const sessionById = useMemo(() => {
    const map = new Map(sessions.map((session) => [session.id, session] as const));
    for (const session of memberSessionsQuery.data ?? []) map.set(session.id, session);
    return map;
  }, [sessions, memberSessionsQuery.data]);

  const [membersOpen, setMembersOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1280);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [stopFirst, setStopFirst] = useState(false);

  // The sidebar's room menu deep-links the members rail (and the budget field
  // in it): /rooms/<id>?panel=members[&focus=budget].
  const [searchParams] = useSearchParams();
  const panelParam = searchParams.get('panel');
  const focusParam = searchParams.get('focus');
  useEffect(() => {
    if (panelParam !== 'members') return;
    setMembersOpen(true);
    if (focusParam !== 'budget') return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('[data-room-budget-input]')?.focus();
    });
    return () => { window.cancelAnimationFrame(frame); };
  }, [panelParam, focusParam]);

  const untitled = t('comms.untitled');
  // Thread members are keyed by session id; a thread that left keeps its
  // name in the log as long as the session is still known.
  const threadName = (sessionId: string): string | undefined => {
    const session = sessionById.get(sessionId);
    if (session === undefined && !room.members.some((member) => member.kind === 'thread' && member.sessionId === sessionId)) return undefined;
    return threadMemberName(session, sessionId, untitled);
  };
  const nameOf = (id: string) => personas.get(id)?.name ?? threadName(id) ?? id;
  const faceOf = (id: string): PersonaAvatarData => {
    const summary = personas.get(id);
    if (summary !== undefined) return personaAvatarOf(summary);
    const name = threadName(id);
    return name === undefined ? { id, name: id } : threadMemberFace(sessionById.get(id), id, name);
  };
  const hostName = nameOf(room.host);
  const hostIsThread = room.members.some((member) => member.kind === 'thread' && member.sessionId === room.host);
  const busyMembers = room.members.filter((member) => sessionById.get(member.sessionId)?.busy === true);
  const working = busyMembers.filter((member) => member.kind === 'persona' || !member.queueWhenBusy);
  const queuedBusy = busyMembers.filter((member) => member.kind === 'thread' && member.queueWhenBusy);
  const questions = usageQuery.data?.questions;
  const running = busyMembers.some((member) => member.kind === 'persona') || questions?.activeSessionId !== undefined;
  const tokens = roomTokenTotal(usageQuery.data);

  const refreshAll = () => {
    log.refresh();
    void queryClient.invalidateQueries({ queryKey: roomQueryKey(room.id) });
    void queryClient.invalidateQueries({ queryKey: roomUsageQueryKey(room.id) });
    void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
  };
  const applyRoom = (next: RoomDocument) => {
    queryClient.setQueryData(roomQueryKey(room.id), next);
    refreshAll();
  };

  const action = useMutation({
    mutationFn: (kind: 'pause' | 'continue' | 'stop') =>
      kind === 'pause' ? api.pauseRoom(room.id) : kind === 'continue' ? api.continueRoom(room.id) : api.stopRoom(room.id),
    onSuccess: (next, kind) => {
      if (kind === 'stop') setStopFirst(false);
      applyRoom(next);
    },
    onError: (error) => { pushToast({ tone: 'error', text: t('room.actionFailed', { detail: errorText(error) }) }); },
  });
  const update = useMutation({
    mutationFn: (input: UpdateRoomInput) => api.updateRoom(room.id, input),
    onMutate: () => { setStopFirst(false); },
    onSuccess: applyRoom,
    onError: (error) => {
      if (isStopFirstError(error)) {
        setStopFirst(true);
        setMembersOpen(true);
        return;
      }
      pushToast({ tone: 'error', text: t('room.actionFailed', { detail: errorText(error) }) });
    },
  });
  const membership = useMutation({
    mutationFn: (change: { readonly add: RoomMemberInput } | { readonly remove: string }) =>
      'add' in change ? api.addRoomMember(room.id, change.add) : api.removeRoomMember(room.id, change.remove),
    onSuccess: applyRoom,
    onError: (error) => { pushToast({ tone: 'error', text: t('room.actionFailed', { detail: errorText(error) }) }); },
  });
  const send = useMutation({
    mutationFn: (text: string) => api.postRoomMessage(room.id, { text, idempotencyKey: crypto.randomUUID() }),
    onSuccess: refreshAll,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRoom(room.id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: roomQueryKey(room.id) });
      void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      navigate('/');
    },
    onError: (error) => {
      setConfirmDelete(false);
      pushToast({ tone: 'error', text: t('room.actionFailed', { detail: errorText(error) }) });
    },
  });

  const personaMembers = room.members.filter((member) => member.kind === 'persona');
  const composerMembers = room.members.map((member) => {
    const id = roomMemberId(member);
    const summary = member.kind === 'persona' ? personas.get(member.personaId) : undefined;
    return { personaId: id, name: nameOf(id), hint: member.kind === 'thread' ? t('room.threadTag') : summary?.title ?? summary?.job, face: faceOf(id) };
  });
  const roster = room.members.map((member) => ({ personaId: roomMemberId(member) }));
  const faces = new Map(room.members.map((member) => [roomMemberId(member), faceOf(roomMemberId(member))] as const));

  return (
    <div className="flex h-full min-h-0 bg-paper" data-room-page={room.id} data-room-paused={room.paused || undefined}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1.5 px-3 lg:px-5" data-room-header>
          <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink md:hidden">
            <Icon name="menu" size={16} />
          </button>
          <h1 className="flex min-w-0 shrink items-baseline gap-1.5 truncate text-[15px] font-semibold text-ink">
            <span aria-hidden className="font-mono font-normal text-ink-faint">#</span>
            <span className="truncate">{room.name}</span>
          </h1>
          <button type="button" data-room-roster aria-expanded={membersOpen} aria-label={t('room.membersOpen')} title={t('room.membersOpen')}
            onClick={() => { setMembersOpen((open) => !open); }} className={`${HEADER_BUTTON} ml-1`}>
            <AvatarStack members={roster} avatars={personas} faces={faces} max={6} size={20} />
          </button>
          <span className="hidden min-w-0 truncate text-[12.5px] text-ink-faint lg:inline" data-room-host-line>
            {t('room.hostLine', { name: hostName })}
          </span>
          <span className="min-w-0 flex-1" />
          <span className="hidden shrink-0 text-[12px] text-ink-faint tabular-nums sm:inline" title={t('room.usageTitle')} data-room-usage>
            {t('room.budget', { count: room.budget.botMessagesPerUserMessage })}
            {tokens !== undefined ? ` · ${formatTokens(tokens)} tok` : ''}
          </span>
          {room.paused ? (
            <button type="button" data-room-continue disabled={action.isPending}
              onClick={() => { action.mutate('continue'); }} className={`${HEADER_BUTTON} font-medium text-ink`}>
              <Icon name="arrowRight" size={14} />
              <span className="max-sm:sr-only">{t('room.resume')}</span>
            </button>
          ) : (
            <button type="button" data-room-pause disabled={action.isPending}
              onClick={() => { action.mutate('pause'); }} className={HEADER_BUTTON} aria-label={t('room.pause')} title={t('room.pause')}>
              <Icon name="hold" size={14} />
            </button>
          )}
          <div className="relative" data-room-menu>
            <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('room.menu')} title={t('room.menu')}
              onClick={() => { setMenuOpen((open) => !open); }} className={HEADER_BUTTON}>
              <Icon name="more" size={16} />
            </button>
            {menuOpen ? (
              <RoomMenu
                onClose={() => { setMenuOpen(false); }}
                onStop={() => { setMenuOpen(false); action.mutate('stop'); }}
                onDelete={() => { setMenuOpen(false); setConfirmDelete(true); }}
              />
            ) : null}
          </div>
        </header>

        <RoomLogView
          room={room}
          entries={log.entries}
          loaded={log.loaded}
          truncated={log.truncated}
          error={log.error}
          nameOf={nameOf}
          faceOf={faceOf}
          working={working.map((member) => nameOf(roomMemberId(member)))}
          queued={queuedBusy.map((member) => nameOf(roomMemberId(member)))}
          hostIsThread={hostIsThread}
          questions={questions}
          questionSessionPersona={questions?.activeSessionId === undefined ? undefined
            : personaMembers.find((member) => member.sessionId === questions.activeSessionId)?.personaId}
          busy={action.isPending}
          onContinue={() => { action.mutate('continue'); }}
          onAdjustBudget={() => {
            setMembersOpen(true);
            window.requestAnimationFrame(() => { document.querySelector<HTMLInputElement>('[data-room-budget-input]')?.focus(); });
          }}
        />

        <div className="shrink-0 px-3 pt-1 pb-3 sm:px-6">
          <div className="mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)]">
            {send.isError ? (
              <p role="alert" className="mb-1.5 px-1 text-[12.5px] text-danger">{t('room.sendFailed', { detail: errorText(send.error) })}</p>
            ) : null}
            <RoomComposer
              roomName={room.name}
              hostName={hostName}
              hostIsThread={hostIsThread}
              members={composerMembers}
              sending={send.isPending}
              onSend={async (text) => {
                try {
                  await send.mutateAsync(text);
                  return true;
                } catch {
                  return false;
                }
              }}
            />
          </div>
        </div>
      </div>

      {membersOpen ? (
        <>
          <div aria-hidden className="fixed inset-0 z-30 bg-ink/20 lg:hidden" onClick={() => { setMembersOpen(false); }} />
          <div className="fixed inset-y-0 right-0 z-40 w-[min(360px,92vw)] border-l border-hairline shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)] lg:static lg:z-auto lg:w-80 lg:shrink-0 lg:shadow-none">
            <RoomMembersPanel
              key={room.budget.botMessagesPerUserMessage}
              room={room}
              personas={personas}
              sessionById={sessionById}
              running={running}
              stopFirst={stopFirst}
              busy={update.isPending || action.isPending || membership.isPending}
              onUpdate={(input) => { update.mutate(input); }}
              onAddMember={(member) => { membership.mutate({ add: member }); }}
              onRemoveMember={(memberId) => { membership.mutate({ remove: memberId }); }}
              onStop={() => { action.mutate('stop'); }}
              onClose={() => { setMembersOpen(false); }}
            />
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title={t('room.deleteTitle', { name: room.name })}
        body={t('room.deleteBody')}
        confirmLabel={t('room.deleteRoom')}
        busy={remove.isPending}
        overlayId="room-delete-confirm"
        onConfirm={() => { remove.mutate(); }}
        onCancel={() => { setConfirmDelete(false); }}
      />
    </div>
  );
}

function RoomMenu({ onClose, onStop, onDelete }: { readonly onClose: () => void; readonly onStop: () => void; readonly onDelete: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const unregister = registerOverlay('room-menu');
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-room-menu]') === null) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);
  const item = 'flex min-h-8 w-full flex-col items-start justify-center rounded-md px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none';
  return (
    <div ref={ref} role="menu" aria-label={t('room.menu')}
      className="anim-enter absolute top-full right-0 z-40 mt-1 w-64 rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
      <button type="button" role="menuitem" className={item} onClick={onStop} data-room-stop>
        <span>{t('room.stopAll')}</span>
        <span className="text-[11.5px] leading-4 text-ink-faint">{t('room.stopAllTitle')}</span>
      </button>
      <div className="my-1 h-px bg-hairline" />
      <button type="button" role="menuitem" className={`${item} hover:text-danger`} onClick={onDelete} data-room-delete>
        {t('room.deleteRoom')}
      </button>
    </div>
  );
}

function systemLine(entry: Extract<RoomLogEntry, { kind: 'system' }>, t: ReturnType<typeof useI18n>['t'], nameOf: (id: string) => string): string {
  const data = entry.data ?? {};
  switch (entry.event) {
    case 'budget_exhausted': return t('room.budgetExhausted', { count: typeof data['budget'] === 'number' ? data['budget'] : '' });
    case 'paused': return t('room.pausedManual');
    case 'continued': return t('room.system.continued');
    case 'stopped': return t('room.system.stopped');
    case 'roster_changed': return t('room.system.rosterChanged');
    case 'host_changed': return t('room.system.hostChanged', { name: typeof data['host'] === 'string' ? nameOf(data['host']) : '' });
    case 'room_renamed': return t('room.system.renamed', { name: typeof data['name'] === 'string' ? data['name'] : '' });
    case 'workspace_changed': return t('room.system.workspaceChanged');
    case 'member_joined': return t('room.threadJoined', { name: typeof data['memberId'] === 'string' ? nameOf(data['memberId']) : '' });
    case 'member_left': return t('room.threadLeft', { name: typeof data['memberId'] === 'string' ? nameOf(data['memberId']) : '' });
    case 'member_busy': return t('room.threadBusy', { name: typeof data['sessionId'] === 'string' ? nameOf(data['sessionId']) : '' });
    case 'wake_failed': {
      const memberId = typeof data['memberId'] === 'string' ? data['memberId'] : entry.text.match(/wake (\S+);/u)?.[1];
      const name = memberId === undefined ? '' : nameOf(memberId);
      const reason = typeof data['reason'] === 'string' ? data['reason'] : entry.text;
      const provider = typeof data['provider'] === 'string' ? data['provider'] : t('room.system.memberModel');
      const code = data['reason_code'];
      switch (code) {
        case 'auth.login_required':
        case 'auth.token_missing':
        case 'auth.token_unauthorized':
          return t('room.system.wakeLoginRequired', { name, provider });
        case 'provider.connection_error':
          return t('room.system.wakeConnectionFailed', { name, provider });
        case 'thread.not_found':
        case 'thread.archived':
        case 'session.closed':
        case 'session.init_failed':
          return t('room.system.wakeSessionUnavailable', { name });
        case 'workspace.not_found':
          return t('room.system.wakeWorkspaceUnavailable', { name });
        default:
          return t('room.system.wakeFailed', { name, reason });
      }
    }
    default: return entry.text;
  }
}

function RoomLogView({
  room,
  entries,
  loaded,
  truncated,
  error,
  nameOf,
  faceOf,
  working,
  queued,
  hostIsThread,
  questions,
  questionSessionPersona,
  busy,
  onContinue,
  onAdjustBudget,
}: {
  readonly room: RoomDocument;
  readonly entries: readonly RoomLogEntry[];
  readonly loaded: boolean;
  readonly truncated: boolean;
  readonly error: unknown;
  readonly nameOf: (id: string) => string;
  readonly faceOf: (id: string) => PersonaAvatarData;
  readonly working: readonly string[];
  /** Busy thread members whose room messages wait for their turn to end. */
  readonly queued: readonly string[];
  readonly hostIsThread: boolean;
  readonly questions: { readonly activeSessionId?: string; readonly queued: number } | undefined;
  readonly questionSessionPersona: string | undefined;
  readonly busy: boolean;
  readonly onContinue: () => void;
  readonly onAdjustBudget: () => void;
}) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry] as const)), [entries]);
  const pauseIndex = livePauseIndex(entries, room);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight;
  }, [entries.length, working.length, queued.length, questions?.activeSessionId]);

  return (
    <div ref={scroller} data-room-log role="log" aria-label={room.name}
      onScroll={(event) => {
        const node = event.currentTarget;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[var(--kiki-chat-content-width,760px)] flex-col pt-4 pb-6">
        {truncated ? <p className="mb-4 text-center text-[12px] text-ink-faint">{t('room.logTruncated', { count: ROOM_LOG_WINDOW })}</p> : null}
        {error !== null && !loaded ? (
          <p role="alert" className="py-8 text-center text-[12.5px] text-danger">{t('room.loadFailed')} · {errorText(error)}</p>
        ) : null}
        {loaded && entries.length === 0 ? (
          <p data-room-empty className="py-16 text-center text-[13px] text-ink-faint text-pretty">
            {hostIsThread ? t('room.emptyLogThreadHost') : t('room.emptyLog', { host: nameOf(room.host) })}
          </p>
        ) : null}
        {entries.map((entry, index) => {
          const previous = entries[index - 1];
          if (entry.kind === 'system') {
            return (
              <SystemRow key={entry.id} text={systemLine(entry, t, nameOf)} event={entry.event}
                live={index === pauseIndex} budget={room.budget.botMessagesPerUserMessage}
                busy={busy} onContinue={onContinue} onAdjustBudget={onAdjustBudget} />
            );
          }
          const continued = previous?.kind === 'message' && previous.from === entry.from && entry.from !== 'user'
            && Date.parse(entry.at) - Date.parse(previous.at) < 5 * 60_000;
          const reply = entry.replyTo === undefined ? undefined : byId.get(entry.replyTo);
          return entry.from === 'user' ? (
            <UserRoomRow key={entry.id} entry={entry} spaced={index > 0} />
          ) : (
            <BotRoomRow key={entry.id} entry={entry} face={faceOf(entry.from)} continued={continued}
              replyText={reply?.kind === 'message' ? reply.text : undefined} />
          );
        })}
        {questions?.activeSessionId !== undefined ? (
          <RoomQuestion sessionId={questions.activeSessionId} queued={questions.queued}
            face={questionSessionPersona === undefined ? undefined : faceOf(questionSessionPersona)} />
        ) : null}
        {working.length > 0 ? (
          <div className="mt-4"><PresenceLine text={t('room.working', { name: working.join(t('room.listSeparator')) })} /></div>
        ) : null}
        {queued.length > 0 ? (
          <p role="status" data-room-queued className={`${working.length > 0 ? 'mt-1' : 'mt-4'} flex min-h-6 items-center gap-2 text-[12.5px] text-ink-faint`}>
            <span className={`${MESSAGE_FACE} flex justify-center`}><Icon name="hold" size={12} /></span>
            <span className="min-w-0 truncate">{t('room.threadBusy', { name: queued.join(t('room.listSeparator')) })}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SystemRow({
  text,
  event,
  live,
  budget,
  busy,
  onContinue,
  onAdjustBudget,
}: {
  readonly text: string;
  readonly event: string;
  readonly live: boolean;
  readonly budget: number;
  readonly busy: boolean;
  readonly onContinue: () => void;
  readonly onAdjustBudget: () => void;
}) {
  const { t } = useI18n();
  const link = 'min-h-7 rounded-md px-1 font-medium text-ink-soft underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-60';
  return (
    <div data-room-system={event} data-room-system-live={live || undefined}
      className="my-4 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-center text-[12.5px] text-ink-faint">
      <span>{text}</span>
      {live ? (
        <>
          <span aria-hidden>·</span>
          <button type="button" className={link} disabled={busy} onClick={onContinue} data-room-system-continue>
            {event === 'budget_exhausted' ? t('room.continue', { count: budget }) : t('room.resume')}
          </button>
          {event === 'budget_exhausted' ? (
            <>
              <span aria-hidden>·</span>
              <button type="button" className={link} onClick={onAdjustBudget} data-room-system-adjust>{t('room.adjustBudget')}</button>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function UserRoomRow({ entry, spaced }: { readonly entry: RoomMessage; readonly spaced: boolean }) {
  return (
    <div data-room-message={entry.id} data-room-from="user" className={`anim-enter group/msg flex flex-col items-end ${spaced ? 'mt-5' : ''}`}>
      <div className="max-w-[80%] rounded-[14px] rounded-br-[6px] bg-bubble-user px-4 py-2 text-[14px] leading-[1.6] break-words whitespace-pre-wrap text-ink">
        {entry.text}
      </div>
      <span className="mt-1 text-[12px] text-ink-faint tabular-nums opacity-0 transition-opacity duration-[var(--kiki-motion-quick)] group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 [@media(hover:none)]:opacity-100">
        <RelativeTime at={entry.at} />
      </span>
    </div>
  );
}

function BotRoomRow({
  entry,
  face,
  continued,
  replyText,
}: {
  readonly entry: RoomMessage;
  readonly face: PersonaAvatarData;
  readonly continued: boolean;
  readonly replyText: string | undefined;
}) {
  const { t } = useI18n();
  const quote = replyText?.replace(/\s+/gu, ' ').trim();
  return (
    <div data-room-message={entry.id} data-room-from={entry.from}
      className={`anim-enter group/msg w-full max-w-[var(--kiki-agent-column,640px)] ${continued ? 'mt-2' : 'mt-5'}`}>
      {continued ? null : <SpeakerHead persona={face} at={entry.at} />}
      <div className="flex min-w-0 gap-2">
        <span className={MESSAGE_FACE} />
        <div className="min-w-0 flex-1">
          {quote !== undefined && quote !== '' ? (
            <p className="mb-1 truncate border-l-2 border-hairline-strong pl-2 text-[12.5px] text-ink-faint">{t('message.replyTo', { text: quote })}</p>
          ) : null}
          <div className="kiki-prose min-w-0"><Markdown text={entry.text} mode="static" /></div>
          {entry.attachments !== undefined && entry.attachments.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {entry.attachments.map((attachment) => (
                <li key={attachment.blobId} className="flex max-w-full items-center gap-2 rounded-lg bg-panel px-3 py-2 ring-1 ring-hairline sm:max-w-[360px]">
                  <span className="text-ink-faint"><Icon name="file" size={16} /></span>
                  <span className="min-w-0 truncate font-mono text-[12.5px] text-ink" title={attachment.path}>
                    {attachment.title ?? attachment.path.split(/[\\/]/u).pop()}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The room's one live question card (asked in a member session). */
function RoomQuestion({ sessionId, queued, face }: { readonly sessionId: string; readonly queued: number; readonly face: PersonaAvatarData | undefined }) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const key = ['rooms', 'question', sessionId] as const;
  const query = useQuery({ queryKey: key, queryFn: () => client.listPendingQuestions(sessionId), refetchInterval: ROOM_POLL_MS });
  const request = query.data?.[0];
  if (request === undefined) return null;
  const done = () => { void queryClient.invalidateQueries({ queryKey: key }); };
  return (
    <div data-room-question={request.question_id} className="mt-5 w-full max-w-[var(--kiki-agent-column,640px)]">
      {face !== undefined ? (
        <SpeakerHead persona={face}>
          <span className="text-[12px] text-ink-faint">{t('room.asking')}</span>
        </SpeakerHead>
      ) : null}
      <div className="flex min-w-0 gap-2">
        <span className={MESSAGE_FACE} />
        <div className="min-w-0 flex-1">
          <QuestionCard
            key={request.question_id}
            block={{ kind: 'question', id: request.question_id, request, outcome: undefined }}
            onAnswer={async (answers: Record<string, QuestionAnswer>) => {
              await client.resolveQuestion(sessionId, request.question_id, { answers, method: 'click' });
              done();
            }}
            onDismiss={async () => {
              await client.dismissQuestion(sessionId, request.question_id);
              done();
            }}
          />
          {queued > 0 ? <p data-room-questions-queued className="mt-2 text-[12.5px] text-ink-faint">{t('room.queuedQuestions', { count: queued })}</p> : null}
        </div>
      </div>
    </div>
  );
}

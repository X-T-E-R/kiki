/**
 * The two pull-into-room dialogs, shared by every entry (sidebar multi-select,
 * the session menu, the thread-chip menu):
 *
 *   - NewThreadRoomDialog: name the room, confirm the 2–6 threads; each joins
 *     as itself (no session is copied), "wait while busy" on.
 *   - JoinRoomDialog: pick an existing room for one thread.
 *
 * With thread communication off both dialogs say so and create nothing.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RoomDocument, Session } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { ROOMS_QUERY_KEY, roomQueryKey, useBotRoomApi } from '../../lib/botRooms';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { Dialog } from '../Dialog';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { PersonaAvatar } from '../persona/PersonaAvatar';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { AddThreadMember, CommsOffNotice } from './AddThreadMember';
import {
  ROOM_MAX_MEMBERS,
  ROOM_MIN_MEMBERS,
  threadMemberFace,
  threadMemberName,
  useThreadCommsEnabled,
} from './threadRooms';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultRoomName(threads: readonly Session[], untitled: string): string {
  const names = threads.slice(0, 2).map((session) => threadMemberName(session, session.id, untitled));
  return threads.length > 2 ? `${names.join(' · ')} +${threads.length - 2}` : names.join(' · ');
}

export function NewThreadRoomDialog({
  threads: initial,
  onClose,
}: {
  readonly threads: readonly Session[];
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useBotRoomApi();
  const { client } = useConnection();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const commsEnabled = useThreadCommsEnabled();
  const untitled = t('comms.untitled');
  const [threads, setThreads] = useState<readonly Session[]>(initial.slice(0, ROOM_MAX_MEMBERS));
  const [name, setName] = useState(() => defaultRoomName(initial, untitled));
  const count = threads.length;
  const countOk = count >= ROOM_MIN_MEMBERS && count <= ROOM_MAX_MEMBERS;
  const create = useMutation({
    mutationFn: () => api.createRoomFromThreads({
      name: name.trim(),
      sessionIds: threads.map((session) => session.id),
      workspace: threads[0]?.metadata.cwd ?? '',
    }),
    onSuccess: (room) => {
      void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
      onClose();
      navigate(`/rooms/${encodeURIComponent(room.id)}`);
    },
  });
  const addById = async (sessionId: string) => {
    const session = await client.getSession(sessionId).catch(() => undefined);
    if (session === undefined) return;
    setThreads((current) => current.some((item) => item.id === sessionId) || current.length >= ROOM_MAX_MEMBERS ? current : [...current, session]);
  };
  const blocked = commsEnabled === false;
  const ready = !blocked && countOk && name.trim() !== '' && !create.isPending;

  return (
    <Dialog onClose={() => { if (!create.isPending) onClose(); }} ariaLabel={t('room.newFromThreadsTitle')} overlayId="new-thread-room-dialog">
      <form data-new-thread-room onSubmit={(event) => { event.preventDefault(); if (ready) create.mutate(); }}>
        <h2 className="font-display text-[17px] font-semibold text-ink">{t('room.newFromThreadsTitle')}</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-soft text-pretty">{t('room.newFromThreadsHint')}</p>
        {blocked ? <div className="mt-3"><CommsOffNotice /></div> : null}

        <label className="mt-4 block">
          <span className="text-[12.5px] font-medium text-ink-soft">{t('room.name')}</span>
          <input data-autofocus value={name} maxLength={200} disabled={blocked}
            onChange={(event) => { setName(event.target.value); }}
            className={`${INPUT} mt-1.5 text-[13px]`} />
        </label>

        <div className="mt-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium text-ink-soft">{t('room.members')}</span>
            <span className="text-[12px] text-ink-faint tabular-nums">{count}/{ROOM_MAX_MEMBERS}</span>
          </div>
          <ul className="mt-2 max-h-56 space-y-px overflow-y-auto rounded-lg border border-hairline p-1">
            {threads.map((session) => {
              const label = threadMemberName(session, session.id, untitled);
              return (
                <li key={session.id} data-new-thread-room-member={session.id} className="flex min-h-10 items-center gap-2.5 rounded-md px-2">
                  <PersonaAvatar persona={threadMemberFace(session, session.id, label)} size={24} decorative />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{label}</span>
                    <span className="block truncate text-[12px] text-ink-faint" title={session.metadata.cwd}>{session.metadata.cwd}</span>
                  </span>
                  <button type="button" aria-label={t('room.leaveMember', { name: label })} title={t('room.leaveMember', { name: label })}
                    disabled={create.isPending}
                    onClick={() => { setThreads((current) => current.filter((item) => item.id !== session.id)); }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
                    <Icon name="close" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
          {!countOk ? <p className="mt-1 text-[12px] text-ink-soft">{t('room.threadsNeeded')}</p> : null}
          {count < ROOM_MAX_MEMBERS && !blocked ? (
            <div className="mt-3">
              <AddThreadMember exclude={new Set(threads.map((session) => session.id))} disabled={create.isPending}
                onAdd={(sessionId) => { void addById(sessionId); }} />
            </div>
          ) : null}
        </div>

        {create.isError ? (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12.5px] text-danger">
            <Icon name="warning" size={14} />
            <span>{t('room.createFailed', { detail: errorText(create.error) })}</span>
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2.5">
          <button type="button" className={SECONDARY_BUTTON} disabled={create.isPending} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" data-new-thread-room-submit className={PRIMARY_BUTTON} disabled={!ready}>{t('room.createFromThreads')}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function JoinRoomDialog({ session, onClose }: { readonly session: Session; readonly onClose: () => void }) {
  const { t } = useI18n();
  const api = useBotRoomApi();
  const queryClient = useQueryClient();
  const commsEnabled = useThreadCommsEnabled();
  const roomsQuery = useQuery({ queryKey: ROOMS_QUERY_KEY, queryFn: () => api.listRooms(), staleTime: 15_000, retry: false });
  const rooms = useMemo(() => [...(roomsQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [roomsQuery.data]);
  const label = threadMemberName(session, session.id, t('comms.untitled'));
  const join = useMutation({
    mutationFn: (room: RoomDocument) => api.addRoomMember(room.id, { kind: 'thread', sessionId: session.id }),
    onSuccess: (room) => {
      queryClient.setQueryData(roomQueryKey(room.id), room);
      void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
      pushToast({ tone: 'success', text: t('room.joined', { name: room.name }) });
      onClose();
    },
  });
  const blocked = commsEnabled === false;

  return (
    <Dialog onClose={() => { if (!join.isPending) onClose(); }} ariaLabel={t('room.joinRoomTitle', { name: label })} overlayId="join-room-dialog">
      <div data-join-room-dialog>
        <h2 className="font-display text-[17px] font-semibold text-ink">{t('room.joinRoomTitle', { name: label })}</h2>
        {blocked ? <div className="mt-3"><CommsOffNotice /></div> : null}
        {roomsQuery.isSuccess && rooms.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-ink-soft">{t('room.joinRoomNone')}</p>
        ) : (
          <ul role="list" className="mt-3 max-h-72 space-y-px overflow-y-auto rounded-lg border border-hairline p-1">
            {rooms.map((room) => {
              const member = room.members.some((item) => item.sessionId === session.id);
              const full = room.members.length >= ROOM_MAX_MEMBERS;
              const disabled = blocked || member || full || join.isPending;
              return (
                <li key={room.id}>
                  <button type="button" data-join-room={room.id} disabled={disabled}
                    onClick={() => { join.mutate(room); }}
                    className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:hover:bg-transparent">
                    <span aria-hidden className="w-5 shrink-0 text-center font-mono text-[13px] text-ink-faint">#</span>
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${disabled ? 'text-ink-faint' : 'text-ink'}`}>{room.name}</span>
                    <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">
                      {member ? t('room.joinRoomMember') : full ? t('room.joinRoomFull') : t('room.memberCountShort', { count: room.members.length })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {join.isError ? (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12.5px] text-danger">
            <Icon name="warning" size={14} />
            <span>{t('room.actionFailed', { detail: errorText(join.error) })}</span>
          </p>
        ) : null}
        <div className="mt-5 flex justify-end">
          <button type="button" className={SECONDARY_BUTTON} disabled={join.isPending} onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </Dialog>
  );
}

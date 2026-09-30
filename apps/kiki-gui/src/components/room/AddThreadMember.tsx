/**
 * Thread search for rooms (members rail › Add member › Threads, and the new
 * room dialog): the sessions that may join (server-side: top-level,
 * unarchived, thread communication on), minus those already picked. A
 * disabled server setting shows the reason instead of an empty list.
 */

import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { useBotRoomApi } from '../../lib/botRooms';
import { Icon } from '../icons';
import { PersonaAvatar } from '../persona/PersonaAvatar';
import { RelativeTime } from '../RelativeTime';
import { SMALL_INPUT } from '../ui';
import { useThreadCommsEnabled } from './threadRooms';

/** The notice every thread-room entry shows while communication is off. */
export function CommsOffNotice() {
  const { t } = useI18n();
  return (
    <p role="status" data-thread-room-comms-off className="rounded-lg bg-ink/[0.04] px-3 py-2 text-[12.5px] leading-5 text-ink-soft text-pretty">
      {t('room.commsOff')}
    </p>
  );
}

export function AddThreadMember({
  exclude,
  disabled,
  onAdd,
}: {
  /** Session ids already in the room (or already picked). */
  readonly exclude: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onAdd: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const api = useBotRoomApi();
  const commsEnabled = useThreadCommsEnabled();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const search = useQuery({
    queryKey: ['rooms', 'threads', deferred],
    queryFn: () => api.searchRoomThreads({ query: deferred === '' ? undefined : deferred, limit: 20 }),
    enabled: commsEnabled !== false,
    staleTime: 10_000,
    retry: false,
  });
  if (commsEnabled === false) return <CommsOffNotice />;
  const threads = (search.data?.threads ?? []).filter((thread) => !exclude.has(thread.ref.sessionId));
  const untitled = t('comms.untitled');

  return (
    <div data-room-add-threads className="space-y-1.5">
      <label className="relative block">
        <span className="sr-only">{t('room.searchThreads')}</span>
        <span aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint"><Icon name="search" size={12} /></span>
        <input type="search" value={query} data-room-thread-search
          placeholder={t('room.searchThreadsPlaceholder')}
          onChange={(event) => { setQuery(event.target.value); }}
          className={`${SMALL_INPUT} h-8 w-full pl-7 text-[12.5px]`} />
      </label>
      {search.isError ? (
        <p role="alert" className="text-[12.5px] text-danger">{t('room.actionFailed', { detail: search.error instanceof Error ? search.error.message : String(search.error) })}</p>
      ) : search.isPending ? (
        <p className="px-1 text-[12.5px] text-ink-faint">{t('comms.loading')}</p>
      ) : threads.length === 0 ? (
        <p className="px-1 text-[12.5px] text-ink-faint">{deferred === '' ? t('room.noThreadsYet') : t('room.noThreads')}</p>
      ) : (
        <ul className="max-h-60 space-y-px overflow-y-auto">
          {threads.map((thread) => {
            const title = thread.title?.trim() || untitled;
            return (
              <li key={thread.ref.sessionId}>
                <button type="button" data-room-add-thread={thread.ref.sessionId} disabled={disabled}
                  aria-label={t('room.addThread', { name: title })}
                  onClick={() => { onAdd(thread.ref.sessionId); }}
                  className="group flex min-h-10 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-60">
                  <PersonaAvatar persona={{ id: thread.ref.sessionId, name: title }} size={22} decorative />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{title}</span>
                    <span className="flex items-center gap-1 text-[11.5px] text-ink-faint">
                      {thread.state === 'running' ? <span className="text-ink-soft">{t('room.threadWorking')}</span> : null}
                      {thread.state === 'running' ? <span aria-hidden>·</span> : null}
                      <RelativeTime at={new Date(thread.updatedAt).toISOString()} />
                    </span>
                  </span>
                  <span aria-hidden className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Icon name="plus" size={14} /></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {search.data?.incomplete === 'scan_budget' ? <p className="px-1 text-[11.5px] text-ink-faint">{t('room.threadsIncomplete')}</p> : null}
    </div>
  );
}

import { useCallback, useMemo } from 'react';

import type { Session } from '@kiki/protocol';
import { findThreadRefs, shortThreadId } from '@kiki/session-core/composer';

import { useOptionalConnection } from '../state/connection';
import { useThreadRefDirectory } from './threadRefs';

const REF_TITLE_LENGTH = 8;

/** Project links without changing the stored title or following title-reference cycles. */
export function resolveThreadTitle(text: string, titleOf: (id: string) => string | undefined): string {
  const refs = findThreadRefs(text);
  let result = '';
  let cursor = 0;
  for (const ref of refs) {
    const title = titleOf(ref.sessionId)?.trim();
    const safeTitle = title === undefined || title === ''
      ? shortThreadId(ref.sessionId)
      : resolveThreadTitle(title, () => undefined);
    const chars = Array.from(safeTitle);
    const label = chars.length > REF_TITLE_LENGTH ? `${chars.slice(0, REF_TITLE_LENGTH).join('')}…` : safeTitle;
    result += text.slice(cursor, ref.start) + label;
    cursor = ref.end;
  }
  return refs.length === 0 ? text : result + text.slice(cursor);
}

const NO_SESSIONS: readonly Pick<Session, 'id' | 'title'>[] = [];

/** One shared directory subscription per title surface; unknown links fetch once. */
export function useThreadTitleResolver(texts: readonly string[], sessions: readonly Pick<Session, 'id' | 'title'>[] = NO_SESSIONS): (text: string) => string {
  const client = useOptionalConnection()?.client;
  const fetchSession = useMemo(() => client === undefined ? undefined : (id: string) => client.getSession(id), [client]);
  const supplied = useMemo(() => new Map(sessions.map((session) => [session.id, session.title])), [sessions]);
  const idsKey = JSON.stringify([...new Set(texts.flatMap((text) => findThreadRefs(text).map((ref) => ref.sessionId)))].filter((id) => !supplied.has(id)));
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
  const directory = useThreadRefDirectory(ids, fetchSession);
  return useCallback(
    (text: string) => resolveThreadTitle(text, (id) => supplied.get(id) ?? directory.lookup(id).session?.title),
    [directory, supplied],
  );
}

/** What the cached session lists, or one metadata read, say about a session's name. */
export interface SessionNameEntry {
  /** Display title with thread links resolved; undefined when the session has none. */
  readonly title: string | undefined;
  /** False until a cached list or the one-shot read carries the session. */
  readonly known: boolean;
}

/**
 * Names for a set of session ids, read from every cached session list with a
 * single metadata read per id no list carries — never once per poll. Callers
 * keep the real id as the action target and render their own fallback label.
 */
export function useSessionNames(ids: readonly string[]): (sessionId: string) => SessionNameEntry {
  const client = useOptionalConnection()?.client;
  const fetchSession = useMemo(() => client === undefined ? undefined : (id: string) => client.getSession(id), [client]);
  const key = ids.join('\n');
  const stableIds = useMemo(() => (key === '' ? [] : key.split('\n')), [key]);
  const directory = useThreadRefDirectory(stableIds, fetchSession);
  return useCallback((sessionId: string): SessionNameEntry => {
    const session = directory.lookup(sessionId).session;
    if (session === undefined) return { title: undefined, known: false };
    const raw = session.title.trim();
    return {
      title: raw === '' ? undefined : resolveThreadTitle(raw, (id) => directory.lookup(id).session?.title),
      known: true,
    };
  }, [directory]);
}

export function useThreadTitle(text: string): string {
  const resolve = useThreadTitleResolver([text]);
  return resolve(text);
}

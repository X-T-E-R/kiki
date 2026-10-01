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

export function useThreadTitle(text: string): string {
  const resolve = useThreadTitleResolver([text]);
  return resolve(text);
}

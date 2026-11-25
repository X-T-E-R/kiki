/** Persona assets own the directory; legacy Bot data supplies state only for old summary shapes. */

import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotSummary, PersonaSummary, Session } from '@kiki/protocol';
import { sessionRowState } from '@kiki/session-core/sessions';
import type { SessionSeenMap } from '@kiki/session-core/settings';

import { BOTS_QUERY_KEY, useBotRoomApi } from '../../lib/botRooms';
import { invalidatePersonaQueries } from '../../lib/personaFreshness';
import { sessionPersonaId } from './personaSessionUtils';
import { usePersonaList } from './usePersonas';

export interface PersonaDirectoryEntry extends PersonaSummary {
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly life: 'idle' | 'working' | 'waiting' | 'done';
  /** Number of unread conversations, not a server-provided message count. */
  readonly unreadCount: number;
  /** Badge navigation must use unread sources, independently of blocking approvals. */
  readonly unreadSessionIds: readonly string[];
  readonly urgentSessionId?: string;
  /** Latest non-archived session timestamp (ms since epoch) across this persona's conversations. */
  readonly lastActivityAt?: number;
}

function parseSessionTimestamp(session: Session): number | undefined {
  const updated = Date.parse(session.updated_at);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(session.created_at);
  return Number.isFinite(created) ? created : undefined;
}

export function personaDirectoryMismatchSignature(
  directory: readonly Pick<PersonaSummary, 'id' | 'homeSessionId'>[],
  sessions: readonly Session[] = [],
): string {
  if (sessions.length === 0) return '';
  const byId = new Map(directory.map((entry) => [entry.id, entry]));
  const tokens = new Set<string>();
  for (const session of sessions) {
    if (session.archived) continue;
    const personaId = sessionPersonaId(session);
    if (personaId === undefined) continue;
    const current = byId.get(personaId);
    if (current === undefined) {
      tokens.add(`missing:${personaId}`);
    } else if (session.metadata?.['persona_home_managed'] === true && current.homeSessionId !== session.id) {
      tokens.add(`home:${personaId}:${session.id}`);
    }
  }
  return tokens.size === 0 ? '' : [...tokens].sort().join('|');
}

export function buildPersonaDirectory(
  personas: readonly PersonaSummary[],
  bots: readonly BotSummary[] = [],
  sessions: readonly Session[] = [],
  seen: SessionSeenMap = {},
): PersonaDirectoryEntry[] {
  const botMap = new Map(bots.map((bot) => [bot.personaId, bot]));
  const sessionsById = new Map<string, Session>();
  const sessionsByPersona = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.archived) continue;
    sessionsById.set(session.id, session);
    const personaId = sessionPersonaId(session);
    if (personaId === undefined) continue;
    const owned = sessionsByPersona.get(personaId) ?? [];
    owned.push(session);
    sessionsByPersona.set(personaId, owned);
  }

  return personas.map((persona): PersonaDirectoryEntry => {
    const hasPersonaState = persona.homeSessionId !== undefined || persona.pinned !== undefined || persona.hidden !== undefined;
    const bot = hasPersonaState ? undefined : botMap.get(persona.id);
    const homeSessionId = persona.homeSessionId ?? bot?.homeSessionId;
    const ownedSessions = sessionsByPersona.get(persona.id) ?? [];
    const unreadSessionIds: string[] = [];
    let waitingSessionId: string | undefined;
    let hasWorking = false;
    let lastActivityAt: number | undefined;
    for (const session of ownedSessions) {
      const ts = parseSessionTimestamp(session);
      if (ts !== undefined && (lastActivityAt === undefined || ts > lastActivityAt)) {
        lastActivityAt = ts;
      }
      const state = sessionRowState(session, seen);
      if (state === 'needs-me') waitingSessionId ??= session.id;
      else if (state === 'running') hasWorking = true;
      else if (state === 'unread') unreadSessionIds.push(session.id);
    }
    if (homeSessionId !== undefined) {
      const homeSession = sessionsById.get(homeSessionId);
      const homeTs = homeSession === undefined ? undefined : parseSessionTimestamp(homeSession);
      if (homeTs !== undefined && (lastActivityAt === undefined || homeTs > lastActivityAt)) {
        lastActivityAt = homeTs;
      }
    }
    return {
      ...persona,
      homeSessionId,
      pinned: persona.pinned ?? bot?.pinned ?? false,
      hidden: persona.hidden ?? bot?.hidden ?? false,
      life: waitingSessionId !== undefined ? 'waiting' : hasWorking ? 'working' : unreadSessionIds.length > 0 ? 'done' : 'idle',
      unreadCount: unreadSessionIds.length,
      unreadSessionIds,
      urgentSessionId: waitingSessionId ?? unreadSessionIds[0],
      lastActivityAt,
    };
  });
}

export function usePersonaDirectory(options: {
  readonly includeArchived?: boolean;
  readonly sessions?: readonly Session[];
  readonly seen?: SessionSeenMap;
  readonly enabled?: boolean;
} = {}) {
  const enabled = options.enabled !== false;
  const queryClient = useQueryClient();
  const personasQuery = usePersonaList({ includeArchived: options.includeArchived, enabled });
  const botRoomApi = useBotRoomApi();
  const botsQuery = useQuery({
    queryKey: BOTS_QUERY_KEY,
    queryFn: () => botRoomApi.listBots(),
    staleTime: 15_000,
    enabled,
    retry: false,
  });
  const directory = useMemo(() => buildPersonaDirectory(
    personasQuery.data ?? [], botsQuery.data ?? [], options.sessions, options.seen,
  ), [personasQuery.data, botsQuery.data, options.sessions, options.seen]);

  const mismatchSignature = useMemo(
    () => (personasQuery.data === undefined ? '' : personaDirectoryMismatchSignature(directory, options.sessions)),
    [personasQuery.data, directory, options.sessions],
  );
  const lastRefetchedSignatureRef = useRef('');
  useEffect(() => {
    if (mismatchSignature === '') {
      lastRefetchedSignatureRef.current = '';
      return;
    }
    if (personasQuery.isFetching || mismatchSignature === lastRefetchedSignatureRef.current) return;
    lastRefetchedSignatureRef.current = mismatchSignature;
    void invalidatePersonaQueries(queryClient).catch(() => undefined);
  }, [mismatchSignature, personasQuery.isFetching, queryClient]);

  return {
    ...personasQuery,
    directory,
    legacyStateLoading: botsQuery.isLoading,
    legacyStateError: botsQuery.error,
  };
}

/** Hidden assets remain available to management/search when explicitly requested. */
export function sortAndFilterDirectory(
  items: readonly PersonaDirectoryEntry[],
  options: { readonly includeHidden?: boolean } = {},
): PersonaDirectoryEntry[] {
  return items
    .filter((item) => options.includeHidden || !item.hidden)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

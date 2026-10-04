/** Persona assets own the directory; legacy Bot data supplies state only for old summary shapes. */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BotSummary, PersonaSummary, Session } from '@kiki/protocol';
import { sessionRowState } from '@kiki/session-core/sessions';
import type { SessionSeenMap } from '@kiki/session-core/settings';

import { usePersonaList } from './usePersonas';
import { BOTS_QUERY_KEY, useBotRoomApi } from '../../lib/botRooms';
import { sessionPersonaId } from './personaSessionUtils';

export interface PersonaDirectoryEntry extends PersonaSummary {
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly life: 'idle' | 'working' | 'waiting' | 'done';
  /** Number of unread conversations, not a server-provided message count. */
  readonly unreadCount: number;
  /** Badge navigation must use unread sources, independently of blocking approvals. */
  readonly unreadSessionIds: readonly string[];
  readonly urgentSessionId?: string;
}

export function buildPersonaDirectory(
  personas: readonly PersonaSummary[],
  bots: readonly BotSummary[] = [],
  sessions: readonly Session[] = [],
  seen: SessionSeenMap = {},
): PersonaDirectoryEntry[] {
  const botMap = new Map(bots.map((bot) => [bot.personaId, bot]));
  const sessionsByPersona = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.archived) continue;
    const personaId = sessionPersonaId(session);
    if (personaId === undefined) continue;
    const owned = sessionsByPersona.get(personaId) ?? [];
    owned.push(session);
    sessionsByPersona.set(personaId, owned);
  }

  return personas.map((persona): PersonaDirectoryEntry => {
    const hasPersonaState = persona.homeSessionId !== undefined || persona.pinned !== undefined || persona.hidden !== undefined;
    const bot = hasPersonaState ? undefined : botMap.get(persona.id);
    const unreadSessionIds: string[] = [];
    let waitingSessionId: string | undefined;
    let hasWorking = false;
    for (const session of sessionsByPersona.get(persona.id) ?? []) {
      const state = sessionRowState(session, seen);
      if (state === 'needs-me') waitingSessionId ??= session.id;
      else if (state === 'running') hasWorking = true;
      else if (state === 'unread') unreadSessionIds.push(session.id);
    }
    return {
      ...persona,
      homeSessionId: persona.homeSessionId ?? bot?.homeSessionId,
      pinned: persona.pinned ?? bot?.pinned ?? false,
      hidden: persona.hidden ?? bot?.hidden ?? false,
      life: waitingSessionId !== undefined ? 'waiting' : hasWorking ? 'working' : unreadSessionIds.length > 0 ? 'done' : 'idle',
      unreadCount: unreadSessionIds.length,
      unreadSessionIds,
      urgentSessionId: waitingSessionId ?? unreadSessionIds[0],
    };
  });
}

export function usePersonaDirectory(options: {
  readonly includeArchived?: boolean;
  readonly sessions?: readonly Session[];
  readonly seen?: SessionSeenMap;
} = {}) {
  const personasQuery = usePersonaList({ includeArchived: options.includeArchived });
  const botRoomApi = useBotRoomApi();
  const botsQuery = useQuery({
    queryKey: BOTS_QUERY_KEY,
    queryFn: () => botRoomApi.listBots(),
    staleTime: 15_000,
    retry: false,
  });
  const directory = useMemo(() => buildPersonaDirectory(
    personasQuery.data ?? [], botsQuery.data ?? [], options.sessions, options.seen,
  ), [personasQuery.data, botsQuery.data, options.sessions, options.seen]);

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

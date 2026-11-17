import type { PersonaSummary, Session } from '@kiki/protocol';

/** The actual binding wins; metadata is the compatibility source for cold/legacy sessions. */
export function sessionPersonaId(session: Session): string | undefined {
  const bound = session.agent_config?.persona?.id;
  if (bound) return bound;
  const metadata = session.metadata;
  const bot = metadata?.['bot_persona_id'];
  if (typeof bot === 'string' && bot !== '') return bot;
  const room = metadata?.['room_persona_id'];
  return typeof room === 'string' && room !== '' ? room : undefined;
}

/** With a directory, only the current home is hidden; replaced legacy homes stay in history. */
export function isBotOrRoomSession(
  session: Session,
  directory?: readonly Pick<PersonaSummary, 'id' | 'homeSessionId'>[],
): boolean {
  if (typeof session.metadata?.['room_member_of'] === 'string') return true;
  if (directory !== undefined) {
    return directory.some((persona) => persona.homeSessionId === session.id && sessionBelongsToPersona(session, persona.id));
  }
  return typeof session.metadata?.['bot_persona_id'] === 'string';
}

/**
 * Single-address filter for the sidebar's plain `Sessions` list.
 *
 * While the persona directory is still loading (`directory === undefined`), only
 * room-member sessions are hidden so a newly created or cold persona thread is
 * never black-holed out of both sections. Once the raw directory resolves
 * (including `hidden: true` entries), only active persona homes and room members
 * are suppressed; replaced old homes and unmatched sessions remain in `Sessions`.
 */
export function shouldHideFromSessionGroups(
  session: Session,
  directory: readonly Pick<PersonaSummary, 'id' | 'homeSessionId'>[] | undefined,
): boolean {
  if (session.archived === true) return false;
  return isBotOrRoomSession(session, directory ?? []);
}

export function sessionBelongsToPersona(session: Session, personaId: string): boolean {
  return personaId !== '' && sessionPersonaId(session) === personaId;
}

/** D4 eligibility mirrors the server's persistent, idle, same-persona boundary. */
export function canSetPersonaHome(session: Session, personaId: string): boolean {
  return sessionBelongsToPersona(session, personaId)
    && !session.ephemeral && !session.archived && !session.busy
    && session.metadata?.['room_member_of'] === undefined;
}

/**
 * Merge server-queried persona conversations with already-loaded client sessions
 * so the switcher renders matching loaded conversations immediately while the
 * server query is pending, and keeps newly updated local sessions visible even
 * before a cached server response refreshes.
 */
export function mergePersonaConversations(
  serverItems: readonly Session[] | undefined,
  loadedSessions: readonly Session[],
  personaId: string,
): readonly Session[] {
  const matchingLoaded = loadedSessions.filter((item) => sessionBelongsToPersona(item, personaId));
  if (serverItems === undefined) return matchingLoaded;
  if (matchingLoaded.length === 0) return serverItems;
  const loadedById = new Map(matchingLoaded.map((item) => [item.id, item]));
  const seenIds = new Set<string>();
  const merged: Session[] = [];
  for (const serverItem of serverItems) {
    seenIds.add(serverItem.id);
    const localItem = loadedById.get(serverItem.id);
    if (localItem !== undefined) {
      const serverTime = new Date(serverItem.updated_at ?? 0).getTime();
      const localTime = new Date(localItem.updated_at ?? 0).getTime();
      merged.push(localTime >= serverTime ? localItem : serverItem);
    } else {
      merged.push(serverItem);
    }
  }
  for (const localItem of matchingLoaded) {
    if (!seenIds.has(localItem.id)) merged.push(localItem);
  }
  return merged;
}

/**
 * Strip a leading `{personaName}｜` / `{personaName} · ` prefix from a sub-thread
 * title when displayed directly beneath that persona's row in the sidebar.
 */
export function compactPersonaThreadTitle(rawTitle: string, personaName: string): string {
  const trimmed = rawTitle.trim();
  const name = personaName.trim();
  if (trimmed === '' || name === '' || !trimmed.startsWith(name)) return trimmed;
  const rest = trimmed.slice(name.length).replace(/^\s*(?:[｜|·—\-:：])\s*/, '').trim();
  return rest !== '' ? rest : trimmed;
}

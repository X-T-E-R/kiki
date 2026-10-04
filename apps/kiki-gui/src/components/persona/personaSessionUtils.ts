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

export function sessionBelongsToPersona(session: Session, personaId: string): boolean {
  return personaId !== '' && sessionPersonaId(session) === personaId;
}

/** D4 eligibility mirrors the server's persistent, idle, same-persona boundary. */
export function canSetPersonaHome(session: Session, personaId: string): boolean {
  return sessionBelongsToPersona(session, personaId)
    && !session.ephemeral && !session.archived && !session.busy
    && session.metadata?.['room_member_of'] === undefined;
}

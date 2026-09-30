/**
 * Thread members of a room: shared helpers for the room page, the members
 * rail and the pull-into-room entries (sidebar, session menu, thread chips).
 *
 * A thread joins a room as itself — no member session is created — so its
 * name is the session title and its face is the session's persona avatar
 * when it has one, otherwise the title's first character.
 */

import { useQuery } from '@tanstack/react-query';

import type { RoomDocument, Session } from '@kiki/protocol';
import { runtimeConfigDraftFromConfig } from '@kiki/session-core/settings';

import type { KikiClient } from '../../lib/client';
import { useOptionalConnection } from '../../state/connection';
import type { PersonaAvatarData } from '../persona/PersonaAvatar';

export const ROOM_MIN_MEMBERS = 2;
export const ROOM_MAX_MEMBERS = 6;

export type RoomMember = RoomDocument['members'][number];
export type ThreadRoomMember = Extract<RoomMember, { kind: 'thread' }>;

/** The id a member goes by in mentions, the host field and the log's `from`. */
export function roomMemberId(member: RoomMember): string {
  return member.kind === 'thread' ? member.sessionId : member.personaId;
}

/** A thread's display name: its title, or a short id while it has none. */
export function threadMemberName(session: Session | undefined, sessionId: string, untitled: string): string {
  const title = session?.title.trim();
  if (title !== undefined && title !== '') return title;
  return session === undefined ? `${untitled} · ${sessionId.slice(-6)}` : untitled;
}

/** A thread's face: its persona avatar, else the title's initial on an id tint. */
export function threadMemberFace(session: Session | undefined, sessionId: string, name: string): PersonaAvatarData {
  const persona = session?.agent_config.persona;
  return persona !== undefined ? { ...persona, id: sessionId } : { id: sessionId, name };
}

/** A session that is a subagent's child session (it has a parent owner). */
export function isSubagentSession(session: Session): boolean {
  const metadata = session.metadata as Record<string, unknown>;
  return metadata['child_session_kind'] === 'child' || typeof metadata['parent_session_id'] === 'string';
}

/**
 * `[thread_communication].enabled` as the server reports it. `undefined`
 * while loading (entries stay enabled rather than flash disabled).
 */
export function useThreadCommsEnabled(given?: Pick<KikiClient, 'getConfig'>): boolean | undefined {
  const optional = useOptionalConnection()?.client;
  const client = given ?? optional;
  const query = useQuery({
    queryKey: ['config'],
    queryFn: () => client!.getConfig(),
    enabled: typeof client?.getConfig === 'function',
    staleTime: 60_000,
  });
  return query.data === undefined ? undefined : runtimeConfigDraftFromConfig(query.data).threadCommunicationEnabled;
}

/** Threads a pull-into-room entry may take: top-level, not archived, not a Bot/room member. */
export function roomEligibleThreads(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => {
    if (session.archived === true || isSubagentSession(session)) return false;
    const metadata = session.metadata as Record<string, unknown>;
    return typeof metadata['room_member_of'] !== 'string' && typeof metadata['bot_persona_id'] !== 'string';
  });
}

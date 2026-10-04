import { describe, expect, it } from 'vitest';
import { emptySessionUsage, type Session } from '@kiki/protocol';
import { canSetPersonaHome, isBotOrRoomSession, sessionBelongsToPersona, sessionPersonaId } from './personaSessionUtils';

function session(input: Partial<Session> = {}): Session {
  return {
    id: 'session-a', workspace_id: 'project-a', title: 'Fixture topic', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    busy: false, metadata: { cwd: '/fixture/project-a' }, agent_config: { model: '' }, permission_rules: [], usage: emptySessionUsage(), message_count: 0, last_seq: 0,
    ...input,
  };
}

describe('persona session attribution', () => {
  it('reads actual binding, old Bot home and room ownership, never matching only a shared profile', () => {
    const bound = session({ agent_config: { model: '', profile: 'writer', persona: { id: 'a', name: 'A' } } });
    const oldBot = session({ metadata: { cwd: '/fixture/home', bot_persona_id: 'a' } });
    const room = session({ metadata: { cwd: '/fixture/room', room_persona_id: 'a', room_member_of: 'fixture-room' } });
    expect([bound, oldBot, room].map((item) => sessionPersonaId(item))).toEqual(['a', 'a', 'a']);
    expect([bound, oldBot, room].every((item) => sessionBelongsToPersona(item, 'a'))).toBe(true);
    expect(sessionBelongsToPersona(session({ agent_config: { model: '', profile: 'writer' } }), 'a')).toBe(false);
    expect(sessionBelongsToPersona(bound, 'b')).toBe(false);
  });

  it('uses one identity when old metadata disagrees with the actual binding', () => {
    const changed = session({ agent_config: { model: '', persona: { id: 'b', name: 'B' } }, metadata: { cwd: '/fixture/project', bot_persona_id: 'a' } });
    expect(sessionBelongsToPersona(changed, 'a')).toBe(false);
    expect(sessionBelongsToPersona(changed, 'b')).toBe(true);
    expect(sessionPersonaId(changed)).toBe('b');
  });

  it('preserves the same persona in two projects without equating their conversations or workspace', () => {
    const a = session({ agent_config: { model: '', persona: { id: 'a', name: 'A' } } });
    const b = session({ id: 'session-b', workspace_id: 'project-b', agent_config: a.agent_config });
    expect([a, b].filter((item) => sessionBelongsToPersona(item, 'a')).map((item) => [item.id, item.workspace_id]))
      .toEqual([['session-a', 'project-a'], ['session-b', 'project-b']]);
  });

  it('hides only the current home with a directory and returns a replaced old Bot home to history', () => {
    const old = session({ metadata: { cwd: '/fixture/home', bot_persona_id: 'a' } });
    const current = session({ id: 'new-home', agent_config: { model: '', persona: { id: 'a', name: 'A' } } });
    const directory = [{ id: 'a', homeSessionId: 'new-home' }];
    expect(isBotOrRoomSession(old)).toBe(true);
    expect(isBotOrRoomSession(old, directory)).toBe(false);
    expect(isBotOrRoomSession(current, directory)).toBe(true);
    expect(isBotOrRoomSession(session({ metadata: { cwd: '/fixture/room', room_member_of: 'fixture-room' } }), directory)).toBe(true);
  });

  it('does not hide someone else based solely on a mismatched home pointer', () => {
    const bound = session({ agent_config: { model: '', persona: { id: 'b', name: 'B' } } });
    expect(isBotOrRoomSession(bound, [{ id: 'a', homeSessionId: bound.id }])).toBe(false);
  });

  it('limits D4 targets to the same persona, persistent, non-room, non-archived and idle', () => {
    const valid = session({ agent_config: { model: '', persona: { id: 'a', name: 'A' } } });
    expect(canSetPersonaHome(valid, 'a')).toBe(true);
    expect(canSetPersonaHome(valid, 'b')).toBe(false);
    expect(canSetPersonaHome({ ...valid, busy: true }, 'a')).toBe(false);
    expect(canSetPersonaHome({ ...valid, ephemeral: true }, 'a')).toBe(false);
    expect(canSetPersonaHome({ ...valid, archived: true }, 'a')).toBe(false);
    expect(canSetPersonaHome({ ...valid, metadata: { ...valid.metadata, room_member_of: 'fixture-room' } }, 'a')).toBe(false);
  });
});

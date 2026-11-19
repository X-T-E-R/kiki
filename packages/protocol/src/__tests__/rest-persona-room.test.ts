import { describe, expect, it } from 'vitest';

import {
  PERSONA_AVATAR_MAX_BYTES,
  botSummarySchema,
  botUpdateInputSchema,
  createRoomInputSchema,
  createThreadRoomInputSchema,
  personaAvatarDataSchema,
  personaDefinitionSchema,
  personaExportQuerySchema,
  personaImportPreviewSchema,
  personaListQuerySchema,
  personaPutInputSchema,
  personaSnapshotSchema,
  postRoomMessageInputSchema,
  roomListItemSchema,
  roomLogResultSchema,
  roomMemberSchema,
  searchRoomThreadsInputSchema,
  sessionCreateSchema,
  sessionUpdateSchema,
  updateRoomInputSchema,
} from '../index';

const personaDefinition = {
  id: 'xiao-you',
  name: 'Yuzu',
  title: 'Release coordinator',
  job: 'Keeps releases moving',
  profile: 'agent',
  modelAlias: 'sonnet',
  thinkingEffort: 'medium',
  greeting: 'I am here.',
  greetings: ['What are we shipping?'],
  roomGreeting: 'Ready for the room.',
  delivery: 'reply' as const,
  memory: { shared: ['global', 'workspace'] as const },
  skills: ['release-notes'],
  tags: ['work'],
  notes: 'Visible only in the editor.',
  homeWorkspace: 'C:/work/kiki',
  description: 'You coordinate releases.',
};

describe('persona REST protocol', () => {
  it('round-trips the frozen camelCase definition, snapshot, and put payload', () => {
    expect(personaDefinitionSchema.parse(personaDefinition)).toEqual(personaDefinition);
    expect(personaSnapshotSchema.parse({ definition: personaDefinition, revision: 'rev-1', examples: 'Q: hi' }))
      .toMatchObject({ definition: personaDefinition, revision: 'rev-1' });
    expect(personaPutInputSchema.parse({ definition: personaDefinition, revision: 'rev-0' }).definition.id)
      .toBe('xiao-you');
  });

  it('coerces query booleans without treating false as true', () => {
    expect(personaListQuerySchema.parse({ includeArchived: 'true' })).toEqual({ includeArchived: true });
    expect(personaListQuerySchema.parse({ includeArchived: 'false' })).toEqual({ includeArchived: false });
    expect(personaExportQuerySchema.parse({})).toEqual({ format: 'json' });
  });

  it('keeps import preview complete and avatar fallback data minimal', () => {
    const preview = personaImportPreviewSchema.parse({
      format: 'json',
      definition: personaDefinition,
      examples: 'Q: hi',
      memoryEntries: [{ title: 'User', body: 'Likes concise updates.', pinned: true, type: 'reference' }],
      ignoredFields: ['post_history_instructions'],
      extensions: { vendor: { key: 'value' } },
    });
    expect(preview.definition.description).toBe('You coordinate releases.');
    expect(personaAvatarDataSchema.parse({ id: 'xiao-you', name: 'Yuzu' })).toEqual({ id: 'xiao-you', name: 'Yuzu' });
    expect(PERSONA_AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('bot and room REST protocol', () => {
  it('validates thread-like metadata and complete room list activity', () => {
    expect(updateRoomInputSchema.parse({ pinned: true, archived: false, name: ' Renamed ' }))
      .toEqual({ pinned: true, archived: false, name: 'Renamed' });
    for (const input of [{ pinned: 'true' }, { archived: 1 }, { name: '' }, { name: 'x'.repeat(201) }]) {
      expect(updateRoomInputSchema.safeParse(input).success).toBe(false);
    }
    const item = {
      kind: 'room',
      id: 'example',
      title: 'Room',
      workspace: 'workspace',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      lastSeq: 3,
      memberCount: 2,
      busy: false,
      needsYou: false,
      pendingInteraction: 'none',
      failed: true,
      pinned: true,
      archived: false,
    };
    expect(roomListItemSchema.parse(item)).toEqual(item);
    expect(roomListItemSchema.safeParse({ ...item, lastSeq: -1 }).success).toBe(false);
    expect(roomListItemSchema.safeParse({ ...item, kind: 'session' }).success).toBe(false);
  });

  it('exposes persistent home identity without requiring a home session for every card', () => {
    expect(botSummarySchema.parse({ personaId: 'example-bot', name: 'Example', pinned: false, hidden: false }).homeSessionId)
      .toBeUndefined();
    expect(botUpdateInputSchema.parse({ pinned: true })).toEqual({ pinned: true });
  });

  it('validates room membership, mixed/thread-only rooms, and independent edits', () => {
    const members = [{ personaId: 'example-a' }, { personaId: 'example-b' }];
    expect(createRoomInputSchema.parse({ name: 'Room', members, workspace: '/example' }).members).toHaveLength(2);
    expect(createRoomInputSchema.safeParse({ name: 'Room', members: members.slice(0, 1), workspace: '/example' }).success).toBe(false);
    expect(updateRoomInputSchema.parse({ budget: { botMessagesPerUserMessage: 12 } }).budget?.botMessagesPerUserMessage).toBe(12);
    expect(updateRoomInputSchema.parse({ members: members.map((m) => ({ ...m, muted: true })) }).members?.[0]?.muted).toBe(true);
    expect(updateRoomInputSchema.parse({ members: [] }).members).toEqual([]);

    const thread = { kind: 'thread', sessionId: 'session-example', queueWhenBusy: false };
    expect(createRoomInputSchema.parse({ name: 'Mixed', workspace: '/classification', members: [{ personaId: 'example-a' }, thread], host: thread.sessionId }).host)
      .toBe(thread.sessionId);
    expect(createThreadRoomInputSchema.parse({ name: 'Threads', workspace: '/classification', sessionIds: ['session-a', 'session-b'] }).sessionIds)
      .toHaveLength(2);
    expect(createThreadRoomInputSchema.safeParse({ name: 'Too small', workspace: '/classification', sessionIds: ['session-a'] }).success).toBe(false);
    expect(roomMemberSchema.parse({ kind: 'thread', sessionId: 'session-a', muted: false, joinedAt: '2026-01-01T00:00:00Z', queueWhenBusy: true }).kind)
      .toBe('thread');
    expect(roomMemberSchema.safeParse({ kind: 'thread', personaId: 'example-a', muted: false }).success).toBe(false);
    expect(searchRoomThreadsInputSchema.parse({ query: 'example', limit: '5' }).limit).toBe(5);
    expect(searchRoomThreadsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('preserves log cursors, rejects blank interruptions, and validates session delivery', () => {
    expect(roomLogResultSchema.parse({ entries: [], nextCursor: 'row-1' }).nextCursor).toBe('row-1');
    expect(postRoomMessageInputSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(sessionCreateSchema.parse({ persona: 'example-bot', delivery: 'message' }).delivery).toBe('message');
    expect(sessionUpdateSchema.parse({ delivery: 'reply' }).delivery).toBe('reply');
    expect(sessionUpdateSchema.safeParse({ delivery: 'silent' }).success).toBe(false);
  });
});

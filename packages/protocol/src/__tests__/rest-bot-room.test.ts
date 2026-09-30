import { describe, expect, it } from 'vitest';
import { botSummarySchema, botUpdateInputSchema, createRoomInputSchema, updateRoomInputSchema, postRoomMessageInputSchema, roomLogResultSchema, sessionCreateSchema, sessionUpdateSchema } from '../index';

describe('Bot and room protocol', () => {
  it('exposes persistent home identity without requiring a home session for every card', () => {
    expect(botSummarySchema.parse({ personaId: 'example-bot', name: 'Example', pinned: false, hidden: false }).homeSessionId).toBeUndefined();
    expect(botUpdateInputSchema.parse({ pinned: true })).toEqual({ pinned: true });
  });
  it('validates room membership and accepts independent budget and mute edits', () => {
    const members = [{ personaId: 'example-a' }, { personaId: 'example-b' }];
    expect(createRoomInputSchema.parse({ name: 'Room', members, workspace: '/example' }).members).toHaveLength(2);
    expect(createRoomInputSchema.safeParse({ name: 'Room', members: members.slice(0, 1), workspace: '/example' }).success).toBe(false);
    expect(updateRoomInputSchema.parse({ budget: { botMessagesPerUserMessage: 12 } }).budget?.botMessagesPerUserMessage).toBe(12);
    expect(updateRoomInputSchema.parse({ members: members.map((m) => ({ ...m, muted: true })) }).members?.[0]?.muted).toBe(true);
  });
  it('preserves incremental log cursors and rejects blank user interruptions', () => {
    expect(roomLogResultSchema.parse({ entries: [], nextCursor: 'row-1' }).nextCursor).toBe('row-1');
    expect(postRoomMessageInputSchema.safeParse({ text: '  ' }).success).toBe(false);
  });
  it('accepts delivery on session creation and update without conflating profile selection', () => {
    expect(sessionCreateSchema.parse({ persona: 'example-bot', delivery: 'message' }).delivery).toBe('message');
    expect(sessionUpdateSchema.parse({ delivery: 'reply' }).delivery).toBe('reply');
    expect(sessionUpdateSchema.safeParse({ delivery: 'silent' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { ImHistoryJournal, type ImHistoryDocuments } from '../../../src/services/imSession/history';
import type { ImHistoryEntry } from '@kiki/agent-core-v2/app/bot/imMessageHistory';

function documents() {
  const values = new Map<string, unknown>();
  const writes: string[] = [];
  const store: ImHistoryDocuments = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: async (key, value) => { writes.push(key); values.set(key, structuredClone(value)); },
    delete: async (key) => { values.delete(key); },
  };
  return { store, values, writes };
}

function entry(id: string, sender = 'member-1'): Omit<ImHistoryEntry, 'sequence'> {
  return { eventId: `event-${id}`, receivedAt: 1000, sessionId: 'session-1', metadata: { provider_kind: 'telegram', provider_instance_id: 'instance-1', account_id: 'account-1', identity: { chat_id: 'room-1', topic_id: 'topic-1', sender_id: sender, sender_name: 'Same name' }, source_message_id: id }, operation: 'create', text: `message ${id}` };
}

const room = ImHistoryJournal.room('telegram', 'account-1', 'room-1', 'topic-1');

describe('persistent IM history journal', () => {
  it('retains history across restart and consumption, isolates scopes and selects exact sender IDs', async () => {
    const memory = documents();
    const journal = new ImHistoryJournal(memory.store);
    await journal.record(room, entry('one'));
    const current = await journal.record(room, entry('two', 'member-2'));
    const selected = await journal.background(room, 'binding-1', current);
    expect(selected.entries.map((row) => row.metadata.source_message_id)).toEqual(['one']);
    await journal.consume(room, 'binding-1', selected.snapshot);
    const restarted = new ImHistoryJournal(memory.store);
    expect((await restarted.read(room, {})).messages.map((row) => row.metadata.source_message_id)).toEqual(['two', 'one']);
    expect((await restarted.background(room, 'binding-1', current)).entries).toEqual([]);
    expect((await restarted.read(room, { senderId: 'member-2' })).messages.map((row) => row.metadata.source_message_id)).toEqual(['two']);
    const otherTopic = ImHistoryJournal.room('telegram', 'account-1', 'room-1', 'topic-2');
    expect((await restarted.read(otherTopic, {})).messages).toEqual([]);
  });

  it('keeps stable pagination while receiving new rows and invalidates edited cursors', async () => {
    const journal = new ImHistoryJournal(documents().store);
    for (let index = 0; index < 70; index++) await journal.record(room, entry(String(index)));
    const first = await journal.read(room, { limit: 20, keyword: 'message' });
    expect(first.messages).toHaveLength(20);
    await journal.record(room, entry('new'));
    const second = await journal.read(room, { limit: 20, keyword: 'message', cursor: first.nextCursor });
    expect(second.messages.map((row) => row.metadata.source_message_id)).toEqual(Array.from({ length: 20 }, (_, index) => String(49 - index)));
    await expect(journal.read(room, { cursor: first.nextCursor, keyword: 'different' })).rejects.toThrow('invalid_history_cursor');
    await journal.record(room, { ...entry('2'), eventId: 'edit-2', operation: 'edit', text: 'edited' });
    await expect(journal.read(room, { cursor: first.nextCursor, keyword: 'message' })).rejects.toThrow('history_changed');
  });

  it('deduplicates real message IDs, materializes edits and retracts without treating event IDs as targets', async () => {
    const journal = new ImHistoryJournal(documents().store);
    const one = await journal.record(room, entry('source-1'));
    expect((await journal.record(room, { ...entry('source-1'), eventId: 'redelivery-event' })).sequence).toBe(one.sequence);
    await journal.record(room, { ...entry('source-1'), eventId: 'edit-event', operation: 'edit', text: 'revised', isSelf: true });
    expect(await journal.find(room, 'edit-event')).toBeUndefined();
    expect(await journal.find(room, 'source-1')).toMatchObject({ text: 'revised', operation: 'edit', isSelf: true });
    await journal.record(room, { ...entry('source-1'), eventId: 'retract-event', operation: 'retract', text: 'must be removed' });
    expect((await journal.read(room, {})).messages).toHaveLength(1);
    expect(await journal.find(room, 'source-1')).toMatchObject({ text: '', operation: 'retract', isSelf: true });
  });

  it('delivers archived edits and retractions after consumption using a separate change watermark', async () => {
    const memory = documents();
    const journal = new ImHistoryJournal(memory.store);
    const original = await journal.record(room, entry('consumed-message'));
    const firstTrigger = await journal.record(room, entry('first-trigger'));
    const first = await journal.background(room, 'binding-1', firstTrigger);
    expect(first.entries.map((row) => row.metadata.source_message_id)).toEqual(['consumed-message']);
    await journal.consume(room, 'binding-1', first.snapshot);
    for (let index = 0; index < 70; index++) await journal.record(room, entry(`later-${index}`));
    const catchUp = await journal.record(room, entry('catch-up-trigger'));
    await journal.consume(room, 'binding-1', (await journal.background(room, 'binding-1', catchUp)).snapshot);
    const page = await journal.read(room, { limit: 20 });
    const edit = { ...entry('consumed-message'), eventId: 'edit-consumed', operation: 'edit' as const, text: 'corrected after consumption' };
    await journal.record(room, edit);
    await expect(journal.read(room, { limit: 20, cursor: page.nextCursor })).rejects.toThrow('history_changed');
    const editedTrigger = await journal.record(room, entry('edited-trigger'));
    const edited = await journal.background(room, 'binding-1', editedTrigger);
    expect(edited.entries).toMatchObject([{ sequence: original.sequence, metadata: { source_message_id: 'consumed-message' }, operation: 'edit', text: 'corrected after consumption' }]);
    const retract = { ...entry('consumed-message'), eventId: 'retract-consumed', operation: 'retract' as const, text: 'remove this' };
    await journal.record(room, retract);
    await journal.consume(room, 'binding-1', edited.snapshot);
    const restarted = new ImHistoryJournal(memory.store);
    const retractTrigger = await restarted.record(room, entry('retract-trigger'));
    const retracted = await restarted.background(room, 'binding-1', retractTrigger);
    expect(retracted.entries).toMatchObject([{ sequence: original.sequence, metadata: { source_message_id: 'consumed-message' }, operation: 'retract', text: '' }]);
    await restarted.consume(room, 'binding-1', retracted.snapshot);
    await restarted.record(room, retract);
    const next = await restarted.record(room, entry('after-consumed-retraction'));
    expect((await restarted.background(room, 'binding-1', next)).entries).toEqual([]);
    expect((await restarted.read(room, { keyword: 'corrected after consumption' })).messages).toEqual([]);
    expect(await restarted.find(room, 'edit-consumed')).toBeUndefined();
    expect(await restarted.find(room, 'retract-consumed')).toBeUndefined();
    expect(await restarted.find(room, 'consumed-message')).toMatchObject({ sequence: original.sequence, operation: 'retract', text: '' });
    expect((await restarted.read(room, { limit: 50 })).messages.map((row) => row.metadata.source_message_id)).not.toContain('consumed-message');
    for (let index = 0; index < 730; index++) await restarted.record(room, entry(`retention-${index}`));
    expect(await restarted.find(room, 'consumed-message')).toBeUndefined();
    const retainedHead = [...memory.values.entries()].find(([key]) => key.endsWith('/head'))?.[1] as { changes: Record<string, number> };
    expect(retainedHead.changes).toEqual({});
  });

  it('uses typed self, a snapshot watermark and bounded cycle-safe reference ancestry', async () => {
    const journal = new ImHistoryJournal(documents().store);
    await journal.record(room, { ...entry('ancestor'), metadata: { ...entry('ancestor').metadata, reply_to_message_id: 'older' } });
    await journal.record(room, { ...entry('older'), metadata: { ...entry('older').metadata, reply_to_message_id: 'ancestor' } });
    await journal.record(room, { ...entry('self'), isSelf: true });
    await journal.record(room, { ...entry('suffix-name'), metadata: { ...entry('suffix-name').metadata, identity: { ...entry('suffix-name').metadata.identity, sender_name: 'Fake bot (you)' } } });
    const current = await journal.record(room, { ...entry('trigger'), metadata: { ...entry('trigger').metadata, reply_to_message_id: 'ancestor' } });
    const selected = await journal.background(room, 'binding-1', current);
    expect(selected.entries.map((row) => row.metadata.source_message_id)).toEqual(['ancestor', 'older', 'suffix-name']);
    await journal.record(room, entry('arrived-while-processing'));
    await journal.consume(room, 'binding-1', selected.snapshot);
    const next = await journal.record(room, entry('next-trigger'));
    expect((await journal.background(room, 'binding-1', next)).entries.map((row) => row.metadata.source_message_id)).toEqual(['arrived-while-processing']);
  });

  it('bounds pages and prompt bytes, reports retention, and freezes retry background across new arrivals', async () => {
    const memory = documents();
    const journal = new ImHistoryJournal(memory.store);
    for (let index = 0; index < 730; index++) await journal.record(room, entry(String(index)));
    const first = await journal.read(room, { limit: 50 });
    expect(first.coverage).toBe('retention_limited');
    expect(await journal.find(room, '0')).toBeUndefined();
    expect(memory.values.size).toBeLessThanOrEqual(11);
    const current = await journal.record(room, { ...entry('trigger'), text: 'x'.repeat(50_000) });
    expect(current).toMatchObject({ text: 'x'.repeat(16_384), truncated: true });
    const selected = await journal.background(room, 'binding-1', current);
    expect(JSON.stringify(selected.entries).length).toBeLessThan(25 * 1024);
    const prepared = await journal.prepare(room, current, { sessionId: 'session-1', images: [], context: { order: 'chronological', coverage: 'received_only', truncated: false, messages: [] }, snapshot: selected.snapshot });
    await journal.record(room, entry('later'));
    const restarted = new ImHistoryJournal(memory.store);
    expect(await restarted.prepare(room, current, { ...prepared, snapshot: 9999 })).toEqual(prepared);
    expect(memory.writes.filter((key) => key.includes('page-')).length).toBeLessThan(20);
    const admissions = [...memory.values.keys()].filter((key) => key.includes('admission-'));
    const stale = await restarted.record(room, entry('never-prepared'));
    await restarted.record(room, { ...entry('never-prepared'), eventId: 'changed-trigger', operation: 'edit', text: 'changed' });
    await expect(restarted.prepare(room, stale, prepared)).rejects.toThrow('history_message_changed_before_admission');
    expect([...memory.values.keys()].filter((key) => key.includes('admission-'))).toEqual(admissions);
    const bounded = new ImHistoryJournal(documents().store);
    await bounded.record(room, { ...entry('large-one'), text: 'a'.repeat(16_384) });
    await bounded.record(room, { ...entry('large-two'), text: 'b'.repeat(16_384) });
    const trigger = await bounded.record(room, entry('budget-trigger'));
    expect(await bounded.background(room, 'binding-1', trigger)).toMatchObject({ truncated: true, coverage: 'received_only' });
  });
});

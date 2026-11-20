import { describe, expect, it, vi } from 'vitest';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { readPendingAutonomousReceipts } from '#/session/subagent/autonomousReceiptRecovery';
import { AGENT_WIRE_RECORD_KEY, createWireMetadataRecord, type WireRecord } from '#/wire/record';

describe('readPendingAutonomousReceipts', () => {
  it('fast-skips normal parentReceiptManaged=true subagent wires in a single scan without triggering a full fold', async () => {
    const storage = new InMemoryStorageService();
    const logs = new AppendLogStore(storage);
    const docs = new JsonAtomicDocumentStore(storage);
    const scope = 'sessions/s1/agents/child-managed';
    const records: WireRecord[] = [
      createWireMetadataRecord(),
      new TurnPrompt({ turnId: 0, input: [], origin: { kind: 'user' }, parentReceiptManaged: true }, 10).serialize(),
      new ContextAppendMessage({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Managed parent-dispatched result.' }], toolCalls: [], source: { turnId: 0 } },
      }, 11).serialize(),
      new TurnEnded({ turnId: 0, reason: 'completed' }, 12).serialize(),
    ];
    for (const record of records) logs.append(scope, AGENT_WIRE_RECORD_KEY, record);
    const readSpy = vi.spyOn(logs, 'read');
    try {
      expect(await readPendingAutonomousReceipts(scope, logs, docs)).toEqual({});
      expect(readSpy).toHaveBeenCalledTimes(1);
      const checkpoint = await docs.get<{ through: number }>(scope, 'autonomous-receipts-v1');
      expect(checkpoint?.through).toBeGreaterThan(0);
    } finally {
      await logs.close();
    }
  });

  it('fast-skips legacy wires without parentReceiptManaged in a single scan', async () => {
    const storage = new InMemoryStorageService();
    const logs = new AppendLogStore(storage);
    const docs = new JsonAtomicDocumentStore(storage);
    const scope = 'sessions/s1/agents/child-legacy';
    const records: WireRecord[] = [
      createWireMetadataRecord(),
      new TurnPrompt({ turnId: 0, input: [], origin: { kind: 'user' } }, 10).serialize(),
      new ContextAppendMessage({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Legacy output.' }], toolCalls: [], source: { turnId: 0 } },
      }, 11).serialize(),
      new TurnEnded({ turnId: 0, reason: 'completed' }, 12).serialize(),
    ];
    for (const record of records) logs.append(scope, AGENT_WIRE_RECORD_KEY, record);
    const readSpy = vi.spyOn(logs, 'read');
    try {
      expect(await readPendingAutonomousReceipts(scope, logs, docs)).toEqual({});
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      await logs.close();
    }
  });

  it('recovers autonomous receipts when parentReceiptManaged is false in both compact and spaced JSON', async () => {
    const storage = new InMemoryStorageService();
    const logs = new AppendLogStore(storage);
    const docs = new JsonAtomicDocumentStore(storage);
    const encoder = new TextEncoder();
    try {
      const compactScope = 'sessions/s1/agents/child-autonomous-compact';
      const compactRecords: WireRecord[] = [
        createWireMetadataRecord(),
        new TurnPrompt({ turnId: 1, input: [], origin: { kind: 'user' }, parentReceiptManaged: false }, 20).serialize(),
        new ContextAppendMessage({
          message: { role: 'assistant', content: [{ type: 'text', text: 'Compact autonomous receipt.' }], toolCalls: [], source: { turnId: 1 } },
        }, 21).serialize(),
        new TurnEnded({ turnId: 1, reason: 'completed' }, 22).serialize(),
      ];
      for (const record of compactRecords) logs.append(compactScope, AGENT_WIRE_RECORD_KEY, record);
      const compactPending = await readPendingAutonomousReceipts(compactScope, logs, docs);
      expect(compactPending['1']?.summary).toBe('Compact autonomous receipt.');

      const spacedScope = 'sessions/s1/agents/child-autonomous-spaced';
      const spacedPrompt = new TurnPrompt({ turnId: 2, input: [], origin: { kind: 'user' }, parentReceiptManaged: false }, 30).serialize();
      logs.append(spacedScope, AGENT_WIRE_RECORD_KEY, createWireMetadataRecord());
      logs.append(spacedScope, AGENT_WIRE_RECORD_KEY, spacedPrompt, {
        encodedLine: encoder.encode(`${JSON.stringify(spacedPrompt).replace('"parentReceiptManaged":false', '"parentReceiptManaged": false')}\n`),
      });
      logs.append(spacedScope, AGENT_WIRE_RECORD_KEY, new ContextAppendMessage({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Spaced autonomous receipt.' }], toolCalls: [], source: { turnId: 2 } },
      }, 31).serialize());
      logs.append(spacedScope, AGENT_WIRE_RECORD_KEY, new TurnEnded({ turnId: 2, reason: 'completed' }, 32).serialize());
      const spacedPending = await readPendingAutonomousReceipts(spacedScope, logs, docs);
      expect(spacedPending['2']?.summary).toBe('Spaced autonomous receipt.');
    } finally {
      await logs.close();
    }
  });
});

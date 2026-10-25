import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '@kiki/agent-core-v2';
import { scanSessionWire } from '@kiki/agent-core-v2/app/sessionExport/wire-scan';
import { createTestAppendLogStore } from '../../agent-core-v2/test/persistence/interface/stubs';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';

import { historyNavigationProof } from '../src/services/history/historyNavigationProof';
import { streamLogicalWireRecords } from '../src/services/history/logicalWireRead';

const SCOPE = 'agents/main';
const KEY = AGENT_WIRE_RECORD_KEY;

function line(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

describe('cold segment history proof', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('keeps the history file proof after an opt-in seal and still finds the cold record', async () => {
    root = await mkdtemp(join(tmpdir(), 'cold-history-'));
    const storage = new FileStorageService(root);
    const log = createTestAppendLogStore(storage);
    const journal = Buffer.concat([
      line({ type: 'metadata', protocol_version: '1.6', created_at: 1_700_000_000_000 }),
      line({ type: 'turn_begin', time: 1_700_000_000_000, userInput: 'NEEDLE_COLD', id: 'cold' }),
      line({ type: 'note', id: 'pad', pad: 'x'.repeat(180) }),
      line({ type: 'turn_begin', time: 1_700_000_005_000, userInput: 'NEEDLE_HOT', id: 'hot' }),
    ]);
    const sealedCut = journal.byteLength - Buffer.byteLength(`${JSON.stringify({ type: 'turn_begin', time: 1_700_000_005_000, userInput: 'NEEDLE_HOT', id: 'hot' })}\n`);
    try {
      await storage.write(SCOPE, KEY, journal);
      const path = storage.pathFor(SCOPE, KEY)!;
      const before = await historyNavigationProof(path, (await stat(path)).size);
      await log.sealCold(SCOPE, KEY, sealedCut, { segmentBytes: 128 });
      const after = await historyNavigationProof(path, (await stat(path)).size);
      expect(after).toEqual(before);
      expect(await readFile(path)).toEqual(journal);
      const records: WireRecord[] = [];
      for await (const record of log.read<WireRecord>(SCOPE, KEY)) records.push(record);
      expect(records.filter((record) => record.type !== 'metadata').map((record) => record['userInput'] ?? record['id'])).toEqual(['NEEDLE_COLD', 'pad', 'NEEDLE_HOT']);
    } finally {
      await log.dispose();
      await storage.close();
    }
  });

  it('reads the sealed logical journal after the retained cold prefix changes', async () => {
    root = await mkdtemp(join(tmpdir(), 'cold-history-'));
    const storage = new FileStorageService(root);
    const log = createTestAppendLogStore(storage);
    const hot = line({ type: 'turn_begin', time: 1_700_000_005_000, userInput: 'NEEDLE_HOT', id: 'hot' });
    const journal = Buffer.concat([
      line({ type: 'metadata', protocol_version: '1.6', created_at: 1_700_000_000_000 }),
      line({ type: 'turn_begin', time: 1_700_000_000_000, userInput: 'NEEDLE_COLD', id: 'cold' }),
      line({ type: 'note', id: 'pad', pad: 'x'.repeat(180) }),
      hot,
    ]);
    const sealedCut = journal.byteLength - hot.byteLength;
    const proofBytes = 64 << 10;
    const headSize = Math.min(journal.byteLength, proofBytes);
    const tailStart = Math.max(0, journal.byteLength - proofBytes);
    const head = createHash('sha256').update(journal.subarray(0, headSize)).digest('hex');
    const tail = createHash('sha256').update(journal.subarray(tailStart, tailStart + headSize)).digest('hex');
    const visible = async (path: string, start?: number): Promise<unknown[]> => {
      const found: unknown[] = [];
      await streamLogicalWireRecords(path, {
        startByteOffset: start,
        onRecord: (record) => {
          if (record.type === 'metadata') return;
          found.push(record['userInput'] ?? record['id']);
        },
      });
      return found;
    };
    try {
      await storage.write(SCOPE, KEY, journal);
      const path = storage.pathFor(SCOPE, KEY)!;
      expect(await visible(path)).toEqual(['NEEDLE_COLD', 'pad', 'NEEDLE_HOT']);
      expect(await visible(path, sealedCut)).toEqual(['NEEDLE_HOT']);
      const before = await historyNavigationProof(path, journal.byteLength);
      await log.sealCold(SCOPE, KEY, sealedCut, { segmentBytes: 128 });
      expect(await historyNavigationProof(path, journal.byteLength)).toEqual(before);
      expect(await visible(path, sealedCut)).toEqual(['NEEDLE_HOT']);
      const needleAt = journal.indexOf('NEEDLE_COLD');
      expect(needleAt).toBeGreaterThanOrEqual(0);
      expect(needleAt).toBeLessThan(sealedCut);
      const flipped = Buffer.from(journal);
      flipped[needleAt] = flipped[needleAt]! ^ 0x01;
      await writeFile(path, flipped);
      const proof = await historyNavigationProof(path, journal.byteLength);
      expect(proof.head).toBe(head);
      expect(proof.tail).toBe(tail);
      expect(proof.size).toBe(journal.byteLength);
      expect(await visible(path)).toEqual(['NEEDLE_COLD', 'pad', 'NEEDLE_HOT']);
      expect((await scanSessionWire(root)).firstUserInput).toBe('NEEDLE_COLD');
      expect(await readFile(path)).toEqual(flipped);
      const records: WireRecord[] = [];
      for await (const record of log.read<WireRecord>(SCOPE, KEY)) records.push(record);
      expect(records.filter((record) => record.type !== 'metadata').map((record) => record['userInput'] ?? record['id'])).toEqual(['NEEDLE_COLD', 'pad', 'NEEDLE_HOT']);
    } finally {
      await log.dispose();
      await storage.close();
    }
  });
});

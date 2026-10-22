import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '@kiki/agent-core-v2';
import { AppendLogStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';

import { historyNavigationProof } from '../src/services/history/historyNavigationProof';

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
    const log = new AppendLogStore(storage);
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
});

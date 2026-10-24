import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { ISessionIndex, ISessionManager, type IHistoryArchive, type Scope } from '@kiki/agent-core-v2';
import { exportSessionDirectory } from '@kiki/agent-core-v2/app/sessionExport/sessionExportService';
import { discardRetainedSession, sealRetainedSession } from '@kiki/agent-core-v2/persistence/retainedJournal';
import { digestWireBytes } from '@kiki/agent-core-v2/wire/transcriptReceipt';
import { afterEach, describe, expect, it } from 'vitest';

import { HistoryNavigationDb } from '../src/services/history/historyNavigationDb';
import { HistoryLocatorStore } from '../src/services/history/historyLocatorStore';
import { historyArchiveSeed } from '../src/services/historyArchive';
import { TranscriptService } from '../src/services/transcript/transcriptService';

const SESSION_ID = 'session_2fd93c4b-8945-479b-b61a-cf106bcf2e9b';
const WORKSPACE_ID = 'wd_ws';

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

async function readZipEntry(path: string, target: string): Promise<Buffer> {
  const buf = await readFile(path);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip directory is missing');
  let cursor = buf.readUInt32LE(eocd + 16);
  while (cursor + 46 <= eocd) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === target) {
      const localName = buf.readUInt16LE(localOffset + 26);
      const localExtra = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localName + localExtra;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(compressed);
      if (method === 8) return Buffer.from(inflateRawSync(compressed));
      throw new Error(`zip method ${method} is not deflate`);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip entry ${target} is missing`);
}

describe('sealed journal consumers', () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('keeps search, read, detail, receipt, and export on the sealed bytes when the retained prefix changes', async () => {
    home = await mkdtemp(join(tmpdir(), 'cold-consumers-'));
    const sessionDir = join(home, 'sessions', WORKSPACE_ID, SESSION_ID);
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, 'wire.jsonl');
    const journal = Buffer.from([
      line({ type: 'turn.prompt', turnId: 1, promptId: 'prompt-1', input: [{ type: 'text', text: 'NEEDLE_COLD' }], origin: { kind: 'user' }, time: 1000 }),
      line({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 3000 }),
    ].join(''));
    const needleAt = journal.indexOf('NEEDLE_COLD');
    expect(needleAt).toBeGreaterThanOrEqual(0);
    const flipped = Buffer.from(journal);
    flipped[needleAt] = flipped[needleAt]! ^ 0x01;
    expect(flipped.byteLength).toBe(journal.byteLength);
    expect(flipped.includes(Buffer.from('NEEDLE_COLD'))).toBe(false);
    const digest = await digestWireBytes((async function* () { yield journal; })());
    await mkdir(agentDir, { recursive: true });
    await writeFile(wirePath, journal);
    await writeFile(join(agentDir, 'wire.transcript-receipt.json'), JSON.stringify({
      format: 1,
      epoch: 'cold-consumer',
      state: 'sealed',
      trusted: true,
      wire: { size: digest.size, sha256: digest.sha256 },
    }));
    const sealed = await sealRetainedSession(sessionDir);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.originalRetained).toBe(true);
    await writeFile(wirePath, flipped);

    const core = {
      accessor: {
        get: (token: unknown) => token === ISessionIndex
          ? { get: async (id: string) => id === SESSION_ID ? { workspaceId: WORKSPACE_ID } : undefined }
          : token === ISessionManager
            ? { get: () => undefined, list: () => [] }
            : undefined,
      },
    } as unknown as Scope;
    const service = new TranscriptService({ homeDir: home, core });
    const db = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const nav = new HistoryLocatorStore(db, service);
    service.setHistoryLocatorReader(() => nav);
    const archive = historyArchiveSeed(() => core, () => service, () => nav)[0]![1] as IHistoryArchive;
    const request = {
      query: 'NEEDLE_COLD',
      mode: 'auto' as const,
      sort: 'newest' as const,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentId: 'main',
      pageSize: 5,
    };
    try {
      const page = await archive.search(request);
      expect(page.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(page)).toContain('NEEDLE_COLD');
      expect(JSON.stringify(page)).not.toContain('OEDLE_COLD');
      const ref = page.items[0]?.ref;
      expect(ref).toBeDefined();
      if (archive.readRef === undefined || ref === undefined) throw new Error('history read is missing');
      const read = await archive.readRef(ref);
      expect(read).toMatchObject({ status: 'ok' });
      expect(JSON.stringify(read)).toContain('NEEDLE_COLD');
      const header = await nav.readCanonicalTurnHeader(SESSION_ID, 'main', 't1');
      expect(header.status).toBe('found');
      expect(JSON.stringify(header)).toContain('NEEDLE_COLD');
      const entity = await service.readCanonicalEntity(SESSION_ID, 'main', { kind: 'turn', id: 't1' });
      expect(JSON.stringify(entity)).toContain('NEEDLE_COLD');
      const snapshot = await service.readColdSnapshot(SESSION_ID, 'main');
      expect(snapshot?.toolCallCountKnown).toBe(true);
      expect(JSON.stringify(snapshot)).toContain('NEEDLE_COLD');
      const outputPath = join(home, 'export.zip');
      await exportSessionDirectory({
        request: { sessionId: SESSION_ID, outputPath, version: '0.0.0-test' },
        summary: { id: SESSION_ID, sessionDir },
      });
      expect(await readZipEntry(outputPath, 'agents/main/wire.jsonl')).toEqual(journal);
      expect(await readFile(wirePath)).toEqual(flipped);
      const proofHead = createHash('sha256').update(journal).digest('hex');
      expect(proofHead).not.toBe(createHash('sha256').update(flipped).digest('hex'));

      expect(await discardRetainedSession(sessionDir)).toBe(1);
      expect(await readFile(wirePath)).toEqual(flipped);
      const afterPath = join(home, 'after.zip');
      await exportSessionDirectory({
        request: { sessionId: SESSION_ID, outputPath: afterPath, version: '0.0.0-test' },
        summary: { id: SESSION_ID, sessionDir },
      });
      expect(await readZipEntry(afterPath, 'agents/main/wire.jsonl')).toEqual(flipped);
      const afterSnapshot = await service.readColdSnapshot(SESSION_ID, 'main');
      expect(afterSnapshot?.toolCallCountKnown).toBe(false);
      expect(JSON.stringify(afterSnapshot)).not.toContain('NEEDLE_COLD');
      await expect(nav.readCanonicalTurnHeader(SESSION_ID, 'main', 't1')).rejects.toThrow('history_source_changed');
      const afterPage = await archive.search(request);
      expect(JSON.stringify(afterPage)).not.toContain('NEEDLE_COLD');
    } finally {
      service.dispose();
      await db.close();
    }
  }, 30_000);
});

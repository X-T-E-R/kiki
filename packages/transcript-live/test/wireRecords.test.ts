import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readWireRecords, readWireRecordsWithCompleteness } from '../src';

describe('readWireRecords', () => {
  it.each([
    { raw: '{"type":"turn.started"}\n{"type":', records: [{ type: 'turn.started' }], complete: false },
    { raw: '{"type":', records: [], complete: false },
    { raw: '{"type":"turn.started"}', records: [{ type: 'turn.started' }], complete: true },
    { raw: '', records: [], complete: true },
  ])('[STAT-R3] reports completeness without discarding readable records: $raw', async ({ raw, records, complete }) => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-live-complete-'));
    try {
      const wirePath = join(home, 'wire.jsonl');
      await writeFile(wirePath, raw);
      await expect(readWireRecordsWithCompleteness(wirePath)).resolves.toEqual({ records, complete });
      await expect(readWireRecords(wirePath)).resolves.toEqual(records);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reads complete records and ignores a truncated final line', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-live-wire-'));
    const wirePath = join(home, 'wire.jsonl');
    try {
      await writeFile(wirePath, '{"type":"turn.started","turnId":1}\n{"type":"turn.ended"');
      await expect(readWireRecords(wirePath)).resolves.toEqual([
        { type: 'turn.started', turnId: 1 },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects a corrupted record before the final line', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-live-wire-'));
    const wirePath = join(home, 'wire.jsonl');
    try {
      await writeFile(wirePath, '{"type":"turn.started"}\nnot-json\n{"type":"turn.ended"}\n');
      await expect(readWireRecords(wirePath)).rejects.toThrow(
        `wire.jsonl: corrupted line 2 in ${wirePath}`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('accepts CRLF-delimited records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-live-wire-'));
    const wirePath = join(home, 'wire.jsonl');
    try {
      await writeFile(wirePath, '{"type":"turn.started"}\r\n{"type":"turn.ended"}\r\n');
      await expect(readWireRecords(wirePath)).resolves.toEqual([
        { type: 'turn.started' },
        { type: 'turn.ended' },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

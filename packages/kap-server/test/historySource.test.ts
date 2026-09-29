import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  decodeHistoryRef, encodeHistoryRef, hashHistoryRecord,
  historySourceIncarnation, verifyHistorySource,
} from '../src/services/history/historySource';

describe('history source refs', () => {
  it('verifies a selected record across append and restart, and rejects same-size replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-source-'));
    const wire = join(dir, 'wire.jsonl');
    const first = Buffer.from('{"type":"turn.prompt","text":"原文😀"}\n');
    try {
      await writeFile(wire, first);
      const incarnation = await historySourceIncarnation(wire);
      expect(incarnation).toBeDefined();
      const anchor = { v: 1 as const, workspace: 'ws', session: 's1', agent: 'main',
        kind: 'turn' as const, turn: 2, incarnation: incarnation!, start: 0, end: first.length,
        digest: hashHistoryRecord(first) };
      const ref = encodeHistoryRef(anchor);
      expect(decodeHistoryRef(ref)).toEqual(anchor);
      expect(await verifyHistorySource(wire, decodeHistoryRef(ref))).toEqual({ status: 'ok' });
      await appendFile(wire, '{"type":"context.append_loop_event"}\n');
      expect(await verifyHistorySource(wire, decodeHistoryRef(ref))).toEqual({ status: 'ok' });
      await writeFile(wire, Buffer.concat([Buffer.from(first.toString().replace('原文', '别文')), Buffer.from('{}\n')]));
      expect(await verifyHistorySource(wire, decodeHistoryRef(ref))).toEqual({ status: 'stale_ref' });
      await rm(wire);
      expect(await verifyHistorySource(wire, decodeHistoryRef(ref))).toEqual({ status: 'source_missing' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed and oversized anchors without exposing arbitrary paths', () => {
    expect(() => decodeHistoryRef('h1_!')).toThrow('invalid_ref');
    const bad = { v: 1, workspace: 'ws', session: 's1', agent: '../outside',
      kind: 'frame', turn: 0, incarnation: 'i', start: 0, end: 1, digest: '0'.repeat(64) };
    expect(() => decodeHistoryRef(`h1_${Buffer.from(JSON.stringify(bad)).toString('base64url')}`)).toThrow('invalid_ref');
    expect(() => decodeHistoryRef('h1_' + 'a'.repeat(2048))).toThrow('invalid_ref');
  });
});

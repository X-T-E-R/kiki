import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

function envelope(seq: number): EventEnvelope {
  return {
    type: 'turn.started',
    seq,
    timestamp: new Date().toISOString(),
    payload: { seq },
  };
}

describe('SessionEventJournal', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-journal-test-'));
    filePath = join(dir, 'sess_1.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('assigns monotonic seq and reads back in order', async () => {
    const j = await SessionEventJournal.open(filePath);
    expect(j.epoch).toMatch(/^ep_/);
    expect(j.seq).toBe(0);

    j.append(j.nextSeq(), envelope(1));
    j.append(j.nextSeq(), envelope(2));
    j.append(j.nextSeq(), envelope(3));
    expect(j.seq).toBe(3);

    const all = await j.readSince(0, 100);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    await j.close();
  });

  it('recovers seq and epoch across reopen', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    j1.append(j1.nextSeq(), envelope(2));
    await j1.close();

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toBe(epoch);
    expect(j2.seq).toBe(2);
    expect(j2.nextSeq()).toBe(3);
    await j2.close();
  });

  it('recovers a large monotonic journal using bounded edge reads', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_large', created_at: 1 });
    const first = JSON.stringify({ kind: 'event', seq: 1, envelope: envelope(1) });
    const last = JSON.stringify({ kind: 'event', seq: 2, envelope: envelope(2) });
    await writeFile(filePath, `${header}\n` + `${first}\n`.repeat(50_000) + `${last}\n`);
    const handle = await open(filePath, 'r');
    const read = vi.spyOn(Object.getPrototypeOf(handle), 'read');
    await handle.close();
    try {
      const journal = await SessionEventJournal.open(filePath);
      expect(journal.epoch).toBe('ep_large');
      expect(journal.seq).toBe(2);
      expect(read.mock.calls.reduce((bytes, args) => bytes + (Number(args[2]) || 0), 0))
        .toBeLessThanOrEqual(2 * 64 * 1024);
      await journal.close();
    } finally {
      read.mockRestore();
    }
  });

  it('falls back to a full scan for damaged tail and retains the maximum seq and epoch', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_damaged', created_at: 1 });
    const high = JSON.stringify({ kind: 'event', seq: 9, envelope: envelope(9) });
    const low = JSON.stringify({ kind: 'event', seq: 2, envelope: envelope(2) });
    await writeFile(filePath, `${header}\n${high}\n${low}\nnot-json\n`);
    const journal = await SessionEventJournal.open(filePath);
    expect(journal.epoch).toBe('ep_damaged');
    expect(journal.seq).toBe(9);
    await journal.close();
  });

  it('falls back when a valid but out-of-order tail hides the earlier maximum', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_order', created_at: 1 });
    const high = JSON.stringify({ kind: 'event', seq: 9, envelope: envelope(9) });
    const low = JSON.stringify({ kind: 'event', seq: 2, envelope: envelope(2) });
    await writeFile(filePath, `${header}\n${high}\n${low}\n`);
    const journal = await SessionEventJournal.open(filePath);
    expect(journal.epoch).toBe('ep_order');
    expect(journal.seq).toBe(9);
    await journal.close();
  });

  it('recovers the last complete event after a truncated final line', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_truncated', created_at: 1 });
    const event = JSON.stringify({ kind: 'event', seq: 3, envelope: envelope(3) });
    await writeFile(filePath, `${header}\n${event}\n{"kind":"event","seq":4`);
    const journal = await SessionEventJournal.open(filePath);
    expect(journal.epoch).toBe('ep_truncated');
    expect(journal.seq).toBe(3);
    await journal.close();
  });

  it('recovers a header after a damaged leading line via the full scan', async () => {
    await writeFile(filePath, 'bad\n' + JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_late', created_at: 1 }) + '\n');
    const journal = await SessionEventJournal.open(filePath);
    expect(journal.epoch).toBe('ep_late');
    await journal.close();
  });

  it('rotates to a fresh epoch when the header is corrupt', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    await j1.close();

    await writeFile(filePath, 'this is not json\n', 'utf8');

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toMatch(/^ep_/);
    expect(j2.epoch).not.toBe(epoch);
    expect(j2.seq).toBe(0);
    await j2.close();
  });

  it('readSince honors the exclusive lower bound and the limit', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 5; i++) j.append(j.nextSeq(), envelope(i));

    const page = await j.readSince(2, 2);
    expect(page.map((e) => e.seq)).toEqual([3, 4]);
    await j.close();
  });

  it('readSince on a missing file returns empty', async () => {
    const j = await SessionEventJournal.open(filePath);
    const out = await j.readSince(0, 100);
    expect(out).toEqual([]);
    await j.close();
  });

  it('flushes appends that arrive while a flush is in flight', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 12; i++) j.append(j.nextSeq(), envelope(i));
    const deadline = Date.now() + 2000;
    let lines = 0;
    while (Date.now() < deadline) {
      try {
        lines = (await readFile(filePath, 'utf8')).trim().split('\n').length;
      } catch {
        lines = 0;
      }
      if (lines >= 13) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lines).toBe(13);
    await j.close();
  });

  it('requeues lines and keeps the header when a flush write fails', async () => {
    const j = await SessionEventJournal.open(filePath);
    j.append(j.nextSeq(), envelope(1));

    const brokenPath = join(dir, 'sub');
    await mkdir(brokenPath, { recursive: true });
    const broken = await (SessionEventJournal as unknown as {
      open(path: string): Promise<SessionEventJournal>;
    }).open(brokenPath);
    broken.append(broken.nextSeq(), envelope(1));
    await broken.flush();
    await rm(brokenPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

    await j.flush();
    const text = await readFile(filePath, 'utf8');
    expect(text).toContain('journal_header');
    expect(text).toContain('"seq":1');
    await j.close();
  });

  it('rotates a damaged tail instead of appending onto it after a corrupt header', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    j1.append(j1.nextSeq(), envelope(1));
    await j1.close();

    await writeFile(filePath, 'GARBAGE\n', 'utf8');

    const j2 = await SessionEventJournal.open(filePath);
    j2.append(j2.nextSeq(), envelope(1));
    await j2.flush();

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'journal_header' });
    await j2.close();
  });
});

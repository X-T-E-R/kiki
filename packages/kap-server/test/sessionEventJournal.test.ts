import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

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

  it('bounds the default disk replay suffix and keeps its cursor across restart', async () => {
    const journal = await SessionEventJournal.open(filePath);
    const epoch = journal.epoch;
    for (let seq = 1; seq <= 3100; seq++) journal.append(journal.nextSeq(), envelope(seq));
    await journal.close();
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1001);
    const reopened = await SessionEventJournal.open(filePath);
    expect(reopened.epoch).toBe(epoch);
    expect(reopened.seq).toBe(3100);
    expect((await reopened.readSince(2100, 1000)).map((entry) => entry.seq))
      .toEqual(Array.from({ length: 1000 }, (_, index) => index + 2101));
    expect(reopened.nextSeq()).toBe(3101);
    reopened.append(3101, envelope(3101));
    await reopened.close();
  });

  it('uses the supplied replay capacity instead of shortening a larger window', async () => {
    const journal = await SessionEventJournal.open(filePath, undefined, 1500);
    for (let seq = 1; seq <= 1600; seq++) journal.append(journal.nextSeq(), envelope(seq));
    await journal.close();
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1501);
    const reopened = await SessionEventJournal.open(filePath, undefined, 1500);
    expect((await reopened.readSince(100, 1500))).toHaveLength(1500);
    await reopened.close();
  });

  it('preserves an oversized complete payload during old-journal convergence', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_big', created_at: 1 });
    const payload = 'x'.repeat(2 * 1024 * 1024);
    const old = JSON.stringify({ kind: 'event', seq: 1, envelope: envelope(1) });
    const large = JSON.stringify({ kind: 'event', seq: 50001, envelope: { ...envelope(50001), payload } });
    await writeFile(filePath, `${header}\n` + `${old}\n`.repeat(50000) + `${large}\n`);
    const reopened = await SessionEventJournal.open(filePath, undefined, 2);
    expect(reopened.epoch).toBe('ep_big');
    expect(reopened.seq).toBe(50001);
    reopened.append(reopened.nextSeq(), envelope(50002));
    expect((await reopened.readSince(50000, 1))[0]?.envelope.payload).toBe(payload);
    await reopened.close();
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!).seq).toBe(50001);
  });

  it('leaves a cold 1 GiB journal untouched and converges on its first append using only tail IO', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_sparse', created_at: 1 });
    const suffix = Array.from({ length: 8 }, (_, index) => {
      const seq = index + 93;
      return JSON.stringify({ kind: 'event', seq, envelope: envelope(seq) });
    }).join('\n') + '\n';
    const hugeSize = 1024 * 1024 * 1024;
    const source = await open(filePath, 'w');
    await source.truncate(hugeSize);
    await source.write(`${header}\n`, 0, 'utf8');
    await source.write(`\n${suffix}`, hugeSize - Buffer.byteLength(suffix) - 1, 'utf8');
    const read = vi.spyOn(Object.getPrototypeOf(source), 'read');
    await source.close();
    const wire = join(dir, 'wire.jsonl');
    const media = join(dir, 'original.png');
    await writeFile(wire, 'canonical history\n');
    await writeFile(media, Buffer.from([0, 1, 2, 255]));
    try {
      const cold = await SessionEventJournal.open(filePath, undefined, 3);
      expect(cold.seq).toBe(100);
      expect(cold.epoch).toBe('ep_sparse');
      await cold.close();
      expect((await stat(filePath)).size).toBe(hugeSize);
      expect(read.mock.calls.reduce((bytes, args) => bytes + (Number(args[2]) || 0), 0))
        .toBeLessThanOrEqual(2 * 64 * 1024);
      const writer = await SessionEventJournal.open(filePath, undefined, 3);
      writer.append(writer.nextSeq(), envelope(101));
      await writer.close();
      expect((await stat(filePath)).size).toBeLessThan(2048);
      expect(read.mock.calls.reduce((bytes, args) => bytes + (Number(args[2]) || 0), 0))
        .toBeLessThanOrEqual(6 * 64 * 1024 + 1);
      const restored = await SessionEventJournal.open(filePath, undefined, 3);
      expect(restored.seq).toBe(101);
      expect(restored.epoch).toBe('ep_sparse');
      expect((await restored.readSince(98, 3)).map((entry) => entry.seq)).toEqual([99, 100, 101]);
      await restored.close();
      expect(await readFile(wire, 'utf8')).toBe('canonical history\n');
      expect(await readFile(media)).toEqual(Buffer.from([0, 1, 2, 255]));
    } finally {
      read.mockRestore();
    }
  });

  it('keeps the appended source after failed atomic replacement and retries without duplicating events', async () => {
    const warn = vi.fn();
    const journal = await SessionEventJournal.open(filePath, { warn }, 2);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('replacement locked'), { code: 'EBUSY' }));
    for (let seq = 1; seq <= 5; seq++) journal.append(journal.nextSeq(), envelope(seq));
    await journal.flush();
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('compaction failed'));
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(6);
    expect((await readdir(dir)).filter((name) => name.includes('.tmp.'))).toEqual([]);
    journal.append(journal.nextSeq(), envelope(6));
    await journal.close();
    const restored = await SessionEventJournal.open(filePath, undefined, 2);
    expect(restored.seq).toBe(6);
    expect((await restored.readSince(4, 2)).map((entry) => entry.seq)).toEqual([5, 6]);
    await restored.close();
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('serializes append and close behind an in-flight atomic replacement', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let replacing = false;
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      replacing = true;
      await gate;
      await actual.rename(from, to);
    });
    const journal = await SessionEventJournal.open(filePath, undefined, 2);
    for (let seq = 1; seq <= 5; seq++) journal.append(journal.nextSeq(), envelope(seq));
    try {
      await vi.waitFor(() => { expect(replacing).toBe(true); });
      journal.append(journal.nextSeq(), envelope(6));
      journal.append(journal.nextSeq(), envelope(7));
      const closing = journal.close();
      release();
      await closing;
      const restored = await SessionEventJournal.open(filePath, undefined, 2);
      expect(restored.seq).toBe(7);
      expect((await restored.readSince(5, 2)).map((entry) => entry.seq)).toEqual([6, 7]);
      await restored.close();
      expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(3);
    } finally {
      release();
      await journal.close();
    }
  });

  it('keeps ongoing writers within two replay windows without rewriting every append', async () => {
    const journal = await SessionEventJournal.open(filePath, undefined, 3);
    for (let seq = 1; seq <= 30; seq++) {
      journal.append(journal.nextSeq(), envelope(seq));
      await journal.flush();
      expect((await readFile(filePath, 'utf8')).trim().split('\n').length).toBeLessThanOrEqual(7);
      expect((await journal.readSince(Math.max(0, seq - 3), 3)).map((entry) => entry.seq))
        .toEqual(Array.from({ length: Math.min(3, seq) }, (_, index) => Math.max(1, seq - 2) + index));
    }
    await journal.close();
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(4);
  });

  it('retains the durable watermark even when the existing replay window is zero', async () => {
    const journal = await SessionEventJournal.open(filePath, undefined, 0);
    const epoch = journal.epoch;
    journal.append(journal.nextSeq(), envelope(1));
    await journal.close();
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1);
    const restored = await SessionEventJournal.open(filePath, undefined, 0);
    expect(restored.epoch).toBe(epoch);
    expect(restored.seq).toBe(1);
    expect(restored.nextSeq()).toBe(2);
    restored.append(2, envelope(2));
    await restored.close();
  });

  it('separates new durable events from a torn old tail even if compaction fails', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_torn', created_at: 1 });
    const event = JSON.stringify({ kind: 'event', seq: 3, envelope: envelope(3) });
    await writeFile(filePath, `${header}\n${event}\n{"kind":"event","seq":4`);
    const journal = await SessionEventJournal.open(filePath, undefined, 10);
    vi.mocked(rename).mockRejectedValueOnce(new Error('replacement unavailable'));
    journal.append(journal.nextSeq(), envelope(4));
    await journal.flush();
    const restored = await SessionEventJournal.open(filePath, undefined, 10);
    expect(restored.seq).toBe(4);
    expect((await restored.readSince(2, 10)).map((entry) => entry.seq)).toEqual([3, 4]);
    await restored.close();
    await journal.close();
  });

  it('reads across a reverse chunk boundary that leaves only a line separator', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_boundary', created_at: 1 });
    const first = JSON.stringify({ kind: 'event', seq: 1, envelope: envelope(1) });
    const record = { kind: 'event', seq: 2, envelope: { ...envelope(2), payload: '' } };
    record.envelope.payload = 'x'.repeat(64 * 1024 - 1 - Buffer.byteLength(JSON.stringify(record)) - 1);
    const last = JSON.stringify(record) + '\n';
    expect(Buffer.byteLength(last)).toBe(64 * 1024 - 1);
    await writeFile(filePath, `${header}\n${first}\n${last}`);
    const journal = await SessionEventJournal.open(filePath, undefined, 2);
    journal.append(journal.nextSeq(), envelope(3));
    await journal.close();
    expect((await journal.readSince(1, 2)).map((entry) => entry.seq)).toEqual([2, 3]);
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(3);
  });
});

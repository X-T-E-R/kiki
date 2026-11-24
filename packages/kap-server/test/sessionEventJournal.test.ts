import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EventEnvelope,
  getJournalProcessPendingBytes,
  MAX_SINGLE_JOURNAL_LINE_BYTES,
  pruneExpiredEventJournals,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';
import { encodeJsonLineBounded } from '../src/transport/ws/v1/boundedJsonEncoder';

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

  it('persists the published epoch on close even when it has no events', async () => {
    const journal = await SessionEventJournal.open(filePath);
    await journal.close();
    expect(await SessionEventJournal.peekWatermark(filePath)).toEqual({ seq: 0, epoch: journal.epoch, attentionSeq: 0 });
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

  it('projects an oversized legacy payload to a gap during old-journal convergence while preserving watermark and bounded entries', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_big', created_at: 1 });
    const payload = 'x'.repeat(2 * 1024 * 1024);
    const old = JSON.stringify({ kind: 'event', seq: 1, envelope: envelope(1) });
    const large = JSON.stringify({ kind: 'event', seq: 50001, envelope: { ...envelope(50001), payload } });
    await writeFile(filePath, `${header}\n` + `${old}\n`.repeat(50000) + `${large}\n`);
    const reopened = await SessionEventJournal.open(filePath, undefined, 2);
    expect(reopened.epoch).toBe('ep_big');
    expect(reopened.seq).toBe(50001);
    reopened.append(reopened.nextSeq(), envelope(50002));
    const range = await reopened.readRecordsSince(50000, 50002, 10);
    expect(range.healthy).toBe(true);
    expect(range.records).toHaveLength(2);
    expect(range.records[0]).toMatchObject({
      kind: 'gap',
      seq: 50001,
      reason: 'legacy_oversized_line',
    });
    expect(range.records[1]).toMatchObject({
      kind: 'event',
      seq: 50002,
      envelope: expect.objectContaining({ seq: 50002, payload: { seq: 50002 } }),
    });
    await reopened.close();
    const text = await readFile(filePath, 'utf8');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(4096);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: 'gap', seq: 50001 });
    expect(JSON.parse(lines[2]!)).toMatchObject({ kind: 'event', seq: 50002 });
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

  it('tracks attentionSeq only for attention events and survives compaction and cold peekWatermark', async () => {
    const typedEnvelope = (seq: number, type: string): EventEnvelope => ({
      type,
      seq,
      timestamp: new Date().toISOString(),
      payload: { type, seq },
    });

    const journal = await SessionEventJournal.open(filePath, undefined, 2);
    const epoch = journal.epoch;
    expect(journal.attentionSeq).toBe(0);

    journal.append(journal.nextSeq(), typedEnvelope(1, 'event.session.created'));
    expect(journal.seq).toBe(1);
    expect(journal.attentionSeq).toBe(0);

    journal.append(journal.nextSeq(), typedEnvelope(2, 'turn.ended'));
    expect(journal.seq).toBe(2);
    expect(journal.attentionSeq).toBe(2);

    for (let seq = 3; seq <= 8; seq += 1) {
      journal.append(journal.nextSeq(), typedEnvelope(seq, seq % 2 === 0 ? 'session.meta.updated' : 'event.session.work_changed'));
    }
    expect(journal.seq).toBe(8);
    expect(journal.attentionSeq).toBe(2);
    await journal.close();

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: 'journal_header',
      epoch,
      last_seq: 8,
      attention_seq: 2,
    });

    const cold = await SessionEventJournal.peekWatermark(filePath);
    expect(cold).toEqual({ epoch, seq: 8, attentionSeq: 2 });

    const reopened = await SessionEventJournal.open(filePath, undefined, 2);
    expect(reopened.epoch).toBe(epoch);
    expect(reopened.seq).toBe(8);
    expect(reopened.attentionSeq).toBe(2);

    reopened.append(reopened.nextSeq(), typedEnvelope(9, 'event.approval.requested'));
    expect(reopened.attentionSeq).toBe(9);
    reopened.append(reopened.nextSeq(), typedEnvelope(10, 'event.session.work_changed'));
    expect(reopened.attentionSeq).toBe(9);
    reopened.append(reopened.nextSeq(), typedEnvelope(11, 'turn.ended'));
    expect(reopened.attentionSeq).toBe(11);
    await reopened.close();

    expect(await SessionEventJournal.peekWatermark(filePath)).toEqual({
      epoch,
      seq: 11,
      attentionSeq: 11,
    });
  });

  it('preserves attentionSeq across zero-capacity compaction and uncompacted large non-attention tails', async () => {
    const typedEnvelope = (seq: number, type: string, padding = ''): EventEnvelope => ({
      type,
      seq,
      timestamp: new Date().toISOString(),
      payload: { type, seq, padding },
    });

    const zeroCap = await SessionEventJournal.open(filePath, undefined, 0);
    zeroCap.append(zeroCap.nextSeq(), typedEnvelope(1, 'event.question.requested'));
    zeroCap.append(zeroCap.nextSeq(), typedEnvelope(2, 'event.session.work_changed'));
    await zeroCap.close();
    expect(await SessionEventJournal.peekWatermark(filePath)).toEqual({
      epoch: zeroCap.epoch,
      seq: 2,
      attentionSeq: 1,
    });

    const largePath = join(dir, 'large_tail.jsonl');
    const large = await SessionEventJournal.open(largePath, undefined, 100);
    large.append(large.nextSeq(), typedEnvelope(1, 'turn.ended'));
    const pad = 'x'.repeat(8 * 1024);
    for (let seq = 2; seq <= 15; seq += 1) {
      large.append(large.nextSeq(), typedEnvelope(seq, 'event.session.work_changed', pad));
    }
    await large.flush();
    expect(await SessionEventJournal.peekWatermark(largePath)).toEqual({
      epoch: large.epoch,
      seq: 15,
      attentionSeq: 1,
    });
    await large.close();
  });

  it('enforces maxRetainedBytes with 2x/1x hysteresis, projects oversized events to gaps, and drops to header-only for tiny budgets', async () => {
    const capBytes = 4096;
    const journal = await SessionEventJournal.open(filePath, undefined, 1000, capBytes);
    const pad = 'a'.repeat(1800);
    for (let seq = 1; seq <= 8; seq += 1) {
      journal.append(journal.nextSeq(), { ...envelope(seq), payload: { seq, pad } });
    }
    await journal.flush();
    const afterFlushSize = (await stat(filePath)).size;
    expect(afterFlushSize).toBeLessThanOrEqual(capBytes * 2 + 512);
    await journal.close();
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'journal_header', last_seq: 8 });
    expect(JSON.parse(lines.at(-1)!).seq).toBe(8);

    const oversizedPayload = 'z'.repeat(capBytes * 2);
    const reopened = await SessionEventJournal.open(filePath, undefined, 1000, capBytes);
    reopened.append(reopened.nextSeq(), { ...envelope(9), payload: oversizedPayload });
    expect(reopened.lastOutcome()?.kind).toBe('gap');
    await reopened.close();
    const afterOversized = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(afterOversized.length).toBeLessThanOrEqual(3);
    expect(JSON.parse(afterOversized.at(-1)!)).toMatchObject({
      kind: 'gap',
      seq: 9,
      reason: 'payload_too_large',
    });
    expect(Buffer.byteLength(afterOversized.at(-1)!, 'utf8')).toBeLessThan(512);

    const tinyPath = join(dir, 'tiny_budget.jsonl');
    const tiny = await SessionEventJournal.open(tinyPath, undefined, 1000, 32);
    tiny.append(tiny.nextSeq(), envelope(1));
    await tiny.close();
    const tinyLines = (await readFile(tinyPath, 'utf8')).trim().split('\n');
    expect(tinyLines).toHaveLength(1);
    expect(JSON.parse(tinyLines[0]!)).toMatchObject({ kind: 'journal_header', last_seq: 1, attention_seq: 1 });

    const oldHeader = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_bytes', created_at: 1 });
    const bigRow = (seq: number) => JSON.stringify({ kind: 'event', seq, envelope: { ...envelope(seq), payload: 'm'.repeat(3000) } });
    const oldPath = join(dir, 'oversized_old.jsonl');
    await writeFile(oldPath, `${oldHeader}\n` + Array.from({ length: 20 }, (_, i) => bigRow(i + 1)).join('\n') + '\n');
    const compacting = await SessionEventJournal.open(oldPath, undefined, 1000, capBytes);
    expect(compacting.seq).toBe(20);
    compacting.append(compacting.nextSeq(), { ...envelope(21), payload: 'short' });
    await compacting.close();
    const compactedLines = (await readFile(oldPath, 'utf8')).trim().split('\n');
    expect(compactedLines.length).toBeLessThanOrEqual(3);
    expect(JSON.parse(compactedLines.at(-1)!).seq).toBe(21);
  });

  it('coalesces background appends without per-append fsync and flushes immediately on readSince/flush/close', async () => {
    const probe = await open(filePath, 'w');
    const syncSpy = vi.spyOn(Object.getPrototypeOf(probe), 'sync');
    await probe.close();
    try {
      const journal = await SessionEventJournal.open(filePath);
      journal.append(journal.nextSeq(), envelope(1));
      journal.append(journal.nextSeq(), envelope(2));
      journal.append(journal.nextSeq(), envelope(3));
      const entries = await journal.readSince(0, 10);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(syncSpy).not.toHaveBeenCalled();
      await journal.close();
      expect(syncSpy).toHaveBeenCalledTimes(1);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('prunes expired inactive session journals and stale temp files while preserving active and global journals', async () => {
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const staleJournal = join(dir, 'sess_expired.jsonl');
    const activeJournal = join(dir, 'sess_active.jsonl');
    const globalJournal = join(dir, '_global.jsonl');
    const freshJournal = join(dir, 'sess_fresh.jsonl');
    const staleTemp = join(dir, 'sess_x.jsonl.tmp.abc');
    await Promise.all([
      writeFile(staleJournal, '{}\n'),
      writeFile(activeJournal, '{}\n'),
      writeFile(globalJournal, '{}\n'),
      writeFile(freshJournal, '{}\n'),
      writeFile(staleTemp, '{}\n'),
    ]);
    await Promise.all([
      utimes(staleJournal, oldTime, oldTime),
      utimes(activeJournal, oldTime, oldTime),
      utimes(globalJournal, oldTime, oldTime),
      utimes(staleTemp, oldTime, oldTime),
    ]);
    const removed = await pruneExpiredEventJournals(dir, {
      activeSessionIds: new Set(['sess_active']),
    });
    expect(removed).toBe(2);
    const remaining = (await readdir(dir)).toSorted();
    expect(remaining).toEqual(['_global.jsonl', 'sess_active.jsonl', 'sess_fresh.jsonl']);
  });

  it('settles close() cleanly on persistent sync failure and skips pruning when session activates before unlink', async () => {
    const probe = await open(filePath, 'w');
    const syncSpy = vi.spyOn(Object.getPrototypeOf(probe), 'sync').mockRejectedValue(new Error('EIO sync'));
    await probe.close();
    const warn = vi.fn();
    try {
      const journal = await SessionEventJournal.open(filePath, { warn });
      journal.append(journal.nextSeq(), envelope(1));
      await journal.close();
      expect(warn).toHaveBeenCalled();
    } finally {
      syncSpy.mockRestore();
    }

    const lateActive = join(dir, 'sess_race.jsonl');
    await writeFile(lateActive, '{}\n');
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(lateActive, oldTime, oldTime);
    let becameActive = false;
    const removed = await pruneExpiredEventJournals(dir, {
      isSessionActive: () => becameActive,
      beforeUnlink: () => {
        becameActive = true;
        return undefined;
      },
    });
    expect(removed).toBe(0);
    expect(await readdir(dir)).toContain('sess_race.jsonl');
  });

  it('enforces the exact 256 KiB UTF-8 line boundary with LF, CJK, surrogate pairs, escapes, and rejects unserializable objects', async () => {
    const baseLine = {
      kind: 'event',
      seq: 1,
      attention_seq: 1,
      envelope: { type: 'tool.result', seq: 1, timestamp: '2026-01-01T00:00:00.000Z', payload: { text: '' } },
    };
    const overhead = Buffer.byteLength(JSON.stringify(baseLine), 'utf8') + 1;
    const exactFill = 'a'.repeat(MAX_SINGLE_JOURNAL_LINE_BYTES - overhead);
    const exactOk = encodeJsonLineBounded(
      { ...baseLine, envelope: { ...baseLine.envelope, payload: { text: exactFill } } },
      MAX_SINGLE_JOURNAL_LINE_BYTES,
    );
    expect(exactOk.ok).toBe(true);
    if (exactOk.ok) {
      expect(exactOk.bytes).toBe(MAX_SINGLE_JOURNAL_LINE_BYTES);
      expect(exactOk.buffer[exactOk.bytes - 1]).toBe(10);
    }

    const overByOne = encodeJsonLineBounded(
      { ...baseLine, envelope: { ...baseLine.envelope, payload: { text: exactFill + 'b' } } },
      MAX_SINGLE_JOURNAL_LINE_BYTES,
    );
    expect(overByOne.ok).toBe(false);
    if (!overByOne.ok && overByOne.reason === 'exceeded') {
      expect(overByOne.omittedBytesAtLeast).toBeGreaterThan(MAX_SINGLE_JOURNAL_LINE_BYTES);
    }

    const cjkAndEscapes = '中文测试\n\t"\\🚀\uD800';
    const encodedUnicode = encodeJsonLineBounded({ text: cjkAndEscapes }, 1024);
    expect(encodedUnicode.ok).toBe(true);
    if (encodedUnicode.ok) {
      expect(JSON.parse(encodedUnicode.buffer.toString('utf8'))).toEqual({
        text: JSON.parse(JSON.stringify(cjkAndEscapes)),
      });
    }

    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    const warn = vi.fn();
    const journal = await SessionEventJournal.open(filePath, { warn });
    journal.append(journal.nextSeq(), {
      type: 'custom.bad',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: circular,
    });
    const badOutcome = journal.lastOutcome();
    expect(badOutcome?.kind).toBe('gap');
    if (badOutcome?.kind === 'gap') {
      expect(badOutcome.gap.reason).toBe('unserializable');
    }
    journal.append(journal.nextSeq(), {
      type: 'custom.bigint',
      seq: 2,
      timestamp: new Date().toISOString(),
      payload: { n: 42n },
    });
    const bigIntOutcome = journal.lastOutcome();
    expect(bigIntOutcome?.kind).toBe('gap');
    if (bigIntOutcome?.kind === 'gap') {
      expect(bigIntOutcome.gap.reason).toBe('unserializable');
    }
    await journal.close();
  });

  it('handles writev short writes, recovers from zero-progress failure via truncate rollback, and poisons on unprovable corruption', async () => {
    const probe = await open(filePath, 'w');
    const proto = Object.getPrototypeOf(probe);
    const originalWritev = proto.writev as (buffers: ArrayBufferView[], pos?: number) => Promise<{ bytesWritten: number; buffers: ArrayBufferView[] }>;
    await probe.close();

    let call = 0;
    const shortSpy = vi.spyOn(proto, 'writev').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const buffers = args[0] as ArrayBufferView[];
      const pos = args[1] as number | undefined;
      call += 1;
      if (call === 1 && buffers.length > 0) {
        const first = buffers[0]!;
        const sliceLen = Math.max(1, Math.floor(first.byteLength / 2));
        const partial = Buffer.from(first.buffer, first.byteOffset, sliceLen);
        const res = await originalWritev.call(this, [partial], pos);
        return { bytesWritten: res.bytesWritten, buffers };
      }
      return originalWritev.call(this, buffers, pos);
    });
    try {
      const journal = await SessionEventJournal.open(filePath);
      journal.append(journal.nextSeq(), envelope(1));
      journal.append(journal.nextSeq(), envelope(2));
      await journal.flush();
      expect(call).toBeGreaterThanOrEqual(2);
      const entries = await journal.readSince(0, 10);
      expect(entries.map((e) => e.seq)).toEqual([1, 2]);
      await journal.close();
    } finally {
      shortSpy.mockRestore();
    }

    const rollbackPath = join(dir, 'rollback.jsonl');
    const j2 = await SessionEventJournal.open(rollbackPath);
    j2.append(j2.nextSeq(), envelope(1));
    await j2.flush();
    const sizeBefore = (await stat(rollbackPath)).size;

    let injectedPartial = false;
    const failSpy = vi.spyOn(proto, 'writev').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const buffers = args[0] as ArrayBufferView[];
      const pos = args[1] as number | undefined;
      if (!injectedPartial) {
        injectedPartial = true;
        const partial = Buffer.from('{"kind":"event","seq":2');
        await originalWritev.call(this, [partial], pos);
        return { bytesWritten: 0, buffers };
      }
      return originalWritev.call(this, buffers, pos);
    });
    try {
      j2.append(j2.nextSeq(), envelope(2));
      await j2.flush();
      expect((await stat(rollbackPath)).size).toBe(sizeBefore);
      await j2.flush();
      const restored = await j2.readSince(0, 10);
      expect(restored.map((e) => e.seq)).toEqual([1, 2]);
      await j2.close();
    } finally {
      failSpy.mockRestore();
    }

    const poisonPath = join(dir, 'poison.jsonl');
    const j3 = await SessionEventJournal.open(poisonPath);
    j3.append(j3.nextSeq(), envelope(1));
    await j3.flush();
    const truncSpy = vi.spyOn(proto, 'truncate').mockRejectedValueOnce(new Error('EIO truncate'));
    const failSpy2 = vi.spyOn(proto, 'writev').mockImplementationOnce(async function (this: unknown, ...args: unknown[]) {
      const pos = args[1] as number | undefined;
      await originalWritev.call(this, [Buffer.from('{"torn')], pos);
      throw new Error('EIO writev');
    });
    try {
      j3.append(j3.nextSeq(), envelope(2));
      await j3.flush();
      expect(j3.poisoned).toBe(true);
      const range = await j3.readRecordsSince(0, 2, 10);
      expect(range.healthy).toBe(false);
      await j3.close();
    } finally {
      failSpy2.mockRestore();
      truncSpy.mockRestore();
    }
  });

  it('streams cold 4 MiB legacy lines at head, middle, and tail with <=64 KiB reads, ignores fake nested fields, and restores missing attentionSeq', async () => {
    const header = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_legacy_huge', created_at: 1 });
    const fakeNested = '{"kind":"event","seq":999999,"attention_seq":999999}';
    const hugeBody = fakeNested + 'x'.repeat(4 * 1024 * 1024);
    const line1 = JSON.stringify({
      kind: 'event',
      seq: 1,
      envelope: { type: 'turn.ended', seq: 1, epoch: 'ep_legacy_huge', session_id: 's1', timestamp: '2026-01-01T00:00:00Z', payload: { agentId: 'main', body: hugeBody } },
    });
    const line2 = JSON.stringify({
      kind: 'event',
      seq: 2,
      envelope: { type: 'tool.result', seq: 2, epoch: 'ep_legacy_huge', session_id: 's1', timestamp: '2026-01-01T00:00:01Z', payload: { agentId: 'main', output: hugeBody } },
    });
    const line3 = JSON.stringify({
      kind: 'event',
      seq: 3,
      envelope: { type: 'context.spliced', seq: 3, epoch: 'ep_legacy_huge', session_id: 's1', timestamp: '2026-01-01T00:00:02Z', payload: { agentId: 'main', messages: hugeBody } },
    });
    await writeFile(filePath, `${header}\n${line1}\n${line2}\n${line3}\n`);

    const probe = await open(filePath, 'r');
    const readSpy = vi.spyOn(Object.getPrototypeOf(probe), 'read');
    await probe.close();
    try {
      const wm = await SessionEventJournal.peekWatermark(filePath);
      expect(wm).toEqual({ epoch: 'ep_legacy_huge', seq: 3, attentionSeq: 1 });
      const maxReadChunk = Math.max(0, ...readSpy.mock.calls.map((args) => Number(args[2]) || 0));
      expect(maxReadChunk).toBeLessThanOrEqual(64 * 1024);

      const opened = await SessionEventJournal.open(filePath);
      const range = await opened.readRecordsSince(0, 3, 10);
      expect(range.healthy).toBe(true);
      expect(range.records).toHaveLength(3);
      expect(range.records.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(range.records.every((r) => r.kind === 'gap' && r.reason === 'legacy_oversized_line')).toBe(true);
      await opened.close();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('collapses backpressured pending writes into one constant-space gap preserving attentionSeq and keeps write amplification <= 2.5x', async () => {
    const pendingBefore = getJournalProcessPendingBytes();
    const bpPath = join(dir, 'backpressure.jsonl');
    const bp = await SessionEventJournal.open(bpPath, undefined, 1000, 4 * 1024 * 1024, {
      maxSessionPendingBytes: 1024,
    });
    const pad = 'p'.repeat(400);
    for (let i = 1; i <= 20; i += 1) {
      bp.append(bp.nextSeq(), {
        type: i === 15 ? 'turn.ended' : 'tool.result',
        seq: i,
        timestamp: new Date().toISOString(),
        payload: { agentId: 'main', pad },
      });
    }
    expect(bp.attentionSeq).toBe(15);
    expect(bp.stats().backpressureCollapseCount).toBeGreaterThan(0);
    await bp.close();
    expect(bp.stats().sessionPendingBytes).toBe(0);
    expect(getJournalProcessPendingBytes()).toBe(pendingBefore);
    expect(await SessionEventJournal.peekWatermark(bpPath)).toEqual({
      epoch: bp.epoch,
      seq: 20,
      attentionSeq: 15,
    });

    const ampPath = join(dir, 'write_amp.jsonl');
    const b0 = 64 * 1024;
    const amp = await SessionEventJournal.open(ampPath, undefined, 1000, b0);
    const body = 'k'.repeat(2000);
    for (let i = 1; i <= 260; i += 1) {
      amp.append(amp.nextSeq(), {
        type: 'event.session.work_changed',
        seq: i,
        timestamp: new Date().toISOString(),
        payload: { agentId: 'main', body },
      });
      if (i % 16 === 0) await amp.flush();
    }
    await amp.flush();
    const s = amp.stats();
    expect(s.compactionCount).toBeGreaterThanOrEqual(3);
    expect(s.diskFileBytes).toBeLessThanOrEqual(b0 * 2 + 64 * 1024);
    const writeAmp = (s.appendedBytes + s.compactedTempBytes) / s.validBoundedLineBytes;
    expect(writeAmp).toBeLessThanOrEqual(2.5);
    await amp.close();
    expect((await stat(ampPath)).size).toBeLessThanOrEqual(b0 + 512);
  });
});

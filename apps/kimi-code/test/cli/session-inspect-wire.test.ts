import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { readSessionWireWindow, SESSION_WIRE_WINDOW_BYTES } from '#/kiki/session-inspect-wire';

function virtualJournal() {
  const turn = Buffer.from(`${JSON.stringify({ type: 'turn.prompt', turnId: 1, input: [{ type: 'text', text: 'visible' }], origin: { kind: 'user' }, time: 1 })}\n${JSON.stringify({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 2 })}\n`);
  let size = Math.ceil((2 ** 30 + 1) / turn.length) * turn.length;
  let mtimeMs = 1;
  const stat = () => ({ dev: 1, ino: 2, birthtimeMs: 1, mtimeMs, size }) as Stats;
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const count = Math.min(length, size - position);
    for (let copied = 0; copied < count;) {
      const start = (position + copied) % turn.length;
      const piece = Math.min(count - copied, turn.length - start);
      turn.copy(buffer, offset + copied, start, start + piece);
      copied += piece;
    }
    return { bytesRead: count, buffer };
  });
  const handle = { read, stat: async () => stat() } as unknown as FileHandle;
  return {
    handle, read, stat,
    append() { size += turn.length; mtimeMs++; },
    shrink() { size = 1; mtimeMs++; },
    replace() { mtimeMs++; },
  };
}

describe('bounded offline wire windows', () => {
  it('opens and reopens a valid >1GiB record stream with bounded reads and no whole-file scan', async () => {
    const journal = virtualJournal();
    const info = journal.stat();
    expect(info.size).toBeGreaterThan(2 ** 30);
    for (let visit = 0; visit < 2; visit++) {
      journal.read.mockClear();
      const records: string[] = [];
      const page = await readSessionWireWindow(journal.handle, info, 'main', {}, (record) => { records.push(record.type); });
      expect(page.watermark).toBe(info.size);
      expect(page.endByteOffset).toBe(info.size);
      expect(page.startByteOffset).toBeGreaterThan(info.size - SESSION_WIRE_WINDOW_BYTES - (64 << 10));
      expect(page.bytesRead).toBeLessThan(SESSION_WIRE_WINDOW_BYTES + (128 << 10));
      expect(records[0]).toBe('turn.prompt');
      expect(records.at(-1)).toBe('turn.ended');
      expect(page.nextCursor).not.toBeNull();
      expect(Math.min(...journal.read.mock.calls.map((call) => call[3]))).toBeGreaterThan(2 ** 30 - SESSION_WIRE_WINDOW_BYTES - (64 << 10));
    }
  });

  it('keeps adjacent older windows on the original watermark while the writer appends', async () => {
    const journal = virtualJournal();
    const first = await readSessionWireWindow(journal.handle, journal.stat(), 'main', { maxBytes: 1024 }, () => {});
    journal.append();
    const older = await readSessionWireWindow(journal.handle, journal.stat(), 'main', { maxBytes: 1024, before: first.nextCursor! }, () => {});
    expect(older.watermark).toBe(first.watermark);
    expect(older.endByteOffset).toBe(first.startByteOffset);
    expect(older.startByteOffset).toBeLessThan(older.endByteOffset);
    expect(older.partialTail).toBe(false);
  });

  it('preserves legacy opening user messages without mistaking legacy injections for a new turn', async () => {
    const line = (record: object) => `${JSON.stringify(record)}\n`;
    const prelude = line({ type: 'config.update' });
    const opening = line({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'actual legacy prompt' }] } });
    const injection = line({ type: 'context.append_message', message: { role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: 'injected' }] } });
    const answer = line({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } });
    const wire = Buffer.from(prelude + opening + injection + answer);
    const info = { dev: 1, ino: 2, birthtimeMs: 1, mtimeMs: 1, size: wire.length } as Stats;
    const handle = {
      stat: async () => info,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: wire.copy(buffer, offset, position, position + length), buffer }),
    } as unknown as FileHandle;
    const page = await readSessionWireWindow(handle, info, 'legacy', { maxBytes: Buffer.byteLength(answer) - 1 }, () => {});
    expect(page.startByteOffset).toBe(Buffer.byteLength(prelude));
    expect(page.startBoundary).toBe('turn');
  });

  it.each([false, true])('opens an 80MiB turn and pages through every record exactly once (newer turn: %s)', async (newerTurn) => {
    const line = (record: object) => Buffer.from(`${JSON.stringify(record)}\n`);
    const prompt = line({ type: 'turn.prompt', turnId: 1, input: [{ type: 'text', text: 'real prompt' }], origin: { kind: 'user' } });
    const message = line({ type: 'context.append_message', message: { role: 'assistant', content: 'x'.repeat(1 << 20) } });
    const result = line({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'earlier-call', result: { output: 'actual result' } } });
    const suffix = Buffer.concat([
      result, line({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
      ...(newerTurn ? [line({ type: 'turn.prompt', turnId: 2, input: [{ type: 'text', text: 'new prompt' }] }), ...Array.from({ length: 10 }, () => message), line({ type: 'turn.ended', turnId: 2, reason: 'completed' })] : []),
    ]);
    const bodyEnd = prompt.length + 80 * message.length;
    const size = bodyEnd + suffix.length;
    const info = { dev: 1, ino: 2, birthtimeMs: 1, mtimeMs: 1, size } as Stats;
    const handle = {
      stat: async () => info,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const count = Math.min(length, size - position);
        for (let copied = 0; copied < count;) {
          const at = position + copied;
          const source = at < prompt.length ? prompt : at < bodyEnd ? message : suffix;
          const within = at < prompt.length ? at : at < bodyEnd ? (at - prompt.length) % message.length : at - bodyEnd;
          const piece = Math.min(count - copied, source.length - within);
          source.copy(buffer, offset + copied, within, within + piece);
          copied += piece;
        }
        return { bytesRead: count, buffer };
      },
    } as unknown as FileHandle;
    const offsets = new Set<number>();
    let before: string | undefined;
    let end = size;
    let pages = 0;
    let continuations = 0;
    let sawResult = false;
    const onRecord: Parameters<typeof readSessionWireWindow>[4] = (record, _line, source) => {
      expect(offsets.has(source.byteOffset)).toBe(false);
      offsets.add(source.byteOffset);
      if (source.continuation) continuations++;
      if (record.type === 'context.append_loop_event') sawResult = true;
    };
    do {
      const page = await readSessionWireWindow(handle, info, 'long-turn', { before }, onRecord);
      expect(page.watermark).toBe(size);
      expect(page.endByteOffset).toBe(end);
      expect(page.startByteOffset).toBeLessThan(end);
      expect(page.bytesRead).toBeLessThanOrEqual((136 << 20) + (64 << 10));
      expect(page.partialTail).toBe(false);
      end = page.startByteOffset;
      before = page.nextCursor ?? undefined;
      pages++;
      expect(pages).toBeLessThan(8);
    } while (before !== undefined);
    expect(end).toBe(0);
    expect(offsets.size).toBe(83 + (newerTurn ? 12 : 0));
    expect(continuations).toBeGreaterThan(0);
    expect(sawResult).toBe(true);
  });

  it('rejects another agent, a same-size rewrite and a shrunken source without calling it damaged', async () => {
    const journal = virtualJournal();
    const first = await readSessionWireWindow(journal.handle, journal.stat(), 'main', { maxBytes: 1024 }, () => {});
    const options = { before: first.nextCursor! };
    await expect(readSessionWireWindow(journal.handle, journal.stat(), 'other', options, () => {})).rejects.toThrow(/another or changed wire/);
    journal.replace();
    await expect(readSessionWireWindow(journal.handle, journal.stat(), 'main', options, () => {})).rejects.toThrow(/another or changed wire/);
    journal.shrink();
    await expect(readSessionWireWindow(journal.handle, journal.stat(), 'main', options, () => {})).rejects.toThrow(/another or changed wire/);
  });
});

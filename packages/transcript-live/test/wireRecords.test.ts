import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  readWireRecords,
  readWireRecordsWithCompleteness,
  streamWireRecords,
  WIRE_COLD_READ_MAX_BYTES,
  WIRE_COLD_READ_MAX_LINE_BYTES,
  WIRE_COLD_READ_MAX_RECORDS,
  WIRE_READ_CHUNK_BYTES,
  type ContextRecord,
  type WireRecordsReadResult,
} from '../src';

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

async function preRefactorReadWireRecords(wirePath: string): Promise<WireRecordsReadResult> {
  const raw = await readFile(wirePath, 'utf8');
  const lines = raw.split('\n');
  const records: ContextRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as ContextRecord);
    } catch (parseError) {
      if (i === lines.length - 1) return { records, complete: false };
      throw new Error(
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        { cause: parseError },
      );
    }
  }
  return { records, complete: true };
}

async function withWireFile<T>(raw: string, run: (wirePath: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'transcript-live-wire-'));
  try {
    const wirePath = join(home, 'wire.jsonl');
    await writeFile(wirePath, raw);
    return await run(wirePath);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

type WireReadLane = 'legacy' | 'array' | 'stream';

interface WireReadPeak {
  readonly count: number;
  readonly peakHeapBytes: number;
}

const ISOLATED_WIRE_PEAK_SCRIPT = String.raw`
import { readFile } from 'node:fs/promises';

const wirePath = process.env.WIRE_PATH;
const lane = process.env.WIRE_LANE;
const moduleUrl = process.env.WIRE_MODULE_URL;
if (wirePath === undefined || lane === undefined || moduleUrl === undefined || globalThis.gc === undefined) {
  throw new Error('invalid isolated wire benchmark environment');
}
const { readWireRecordsWithCompleteness, streamWireRecords } = await import(moduleUrl);
globalThis.gc();
const baseline = process.memoryUsage().heapUsed;
let peak = baseline;
const sample = () => {
  peak = Math.max(peak, process.memoryUsage().heapUsed);
};
let count = 0;
if (lane === 'legacy') {
  const raw = await readFile(wirePath, 'utf8');
  sample();
  const lines = raw.split('\n');
  sample();
  const records = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    records.push(JSON.parse(line));
    if (records.length % 5_000 === 0) sample();
  }
  count = records.length;
  sample();
} else if (lane === 'array') {
  const result = await readWireRecordsWithCompleteness(wirePath);
  if (!result.complete) throw new Error('array read was incomplete');
  count = result.records.length;
  sample();
} else if (lane === 'stream') {
  const result = await streamWireRecords(wirePath, {
    onRecord: () => {
      count += 1;
      if (count % 5_000 === 0) sample();
    },
  });
  if (!result.complete) throw new Error('stream read was incomplete');
  sample();
} else {
  throw new Error('unknown wire benchmark lane: ' + lane);
}
process.stdout.write(JSON.stringify({ count, peakHeapBytes: peak - baseline }));
`;

async function measureWireReadPeak(wirePath: string, lane: WireReadLane): Promise<WireReadPeak> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WIRE_PATH: wirePath,
    WIRE_LANE: lane,
    WIRE_MODULE_URL: new URL('../src/wireRecords.ts', import.meta.url).href,
  };
  delete env['TSX_TSCONFIG_PATH'];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', '--input-type=module', '--eval', ISOLATED_WIRE_PEAK_SCRIPT],
      { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`isolated wire benchmark failed (${code ?? signal}): ${stderr}`));
    });
  });
  const result = JSON.parse(output) as Partial<WireReadPeak>;
  if (!Number.isSafeInteger(result.count) || !Number.isFinite(result.peakHeapBytes)) {
    throw new Error(`invalid isolated wire benchmark result: ${output}`);
  }
  return result as WireReadPeak;
}

const WIRE_CORPUS = [
  { name: 'empty file', raw: '' },
  { name: 'a single newline', raw: '\n' },
  { name: 'blank lines only', raw: '\n\n\n' },
  { name: 'records with a trailing newline', raw: '{"type":"a"}\n{"type":"b"}\n' },
  { name: 'records without a trailing newline', raw: '{"type":"a"}\n{"type":"b"}' },
  { name: 'CRLF records', raw: '{"type":"a"}\r\n{"type":"b"}\r\n' },
  { name: 'CRLF records without a trailing newline', raw: '{"type":"a"}\r\n{"type":"b"}' },
  { name: 'a lone CR as the last line', raw: '{"type":"a"}\r' },
  { name: 'a CR-only line between records', raw: '{"type":"a"}\n\r\n{"type":"b"}\n' },
  { name: 'mixed CRLF and LF with blank lines', raw: '{"type":"a"}\r\n\n{"type":"b"}\n\n\n' },
  { name: 'a whitespace-only line', raw: '{"type":"a"}\n   \n{"type":"b"}\n' },
  { name: 'a record with surrounding spaces', raw: '  {"type":"a"}  \n{"type":"b"}\n' },
  { name: 'a corrupted middle line', raw: '{"type":"a"}\nnot-json\n{"type":"b"}\n' },
  { name: 'a corrupted first line', raw: 'not-json\n' },
  { name: 'a corrupted terminated tail', raw: '{"type":"a"}\n{"type":\n' },
  { name: 'a corrupted unterminated tail', raw: '{"type":"a"}\n{"type":' },
  { name: 'a truncated single record', raw: '{"type":' },
  { name: 'non-object records', raw: 'null\n1\n"text"\n[]\n' },
  { name: 'unicode escapes', raw: '{"type":"a","text":"\\u00e9\\u4e2d\\ud83d\\ude00"}\n' },
  { name: 'literal multi-byte text', raw: '{"type":"a","text":"é中文😀"}\n' },
  { name: 'an escaped CRLF inside a value', raw: '{"type":"a","text":"x\\r\\ny"}\n' },
  { name: 'nested objects and arrays', raw: '{"type":"a","event":{"type":"b","parts":[{"text":"x,y"}]}}\n' },
] as const;

describe('streamWireRecords', () => {
  it.each(WIRE_CORPUS)(
    '[STAT-R3] matches the full-file reader record for record at every chunk size: $name',
    async ({ raw }) => {
      await withWireFile(raw, async (wirePath) => {
        let legacy: WireRecordsReadResult | undefined;
        let legacyError: Error | undefined;
        try {
          legacy = await preRefactorReadWireRecords(wirePath);
        } catch (error) {
          legacyError = error as Error;
        }
        if (legacyError !== undefined) {
          await expect(readWireRecordsWithCompleteness(wirePath)).rejects.toThrow(legacyError.message);
          for (const chunkBytes of [1, 2, 3, 7, WIRE_READ_CHUNK_BYTES]) {
            await expect(
              streamWireRecords(wirePath, { chunkBytes, onRecord: () => undefined }),
            ).rejects.toThrow(legacyError.message);
          }
          return;
        }
        await expect(readWireRecordsWithCompleteness(wirePath)).resolves.toEqual(legacy);
        for (const chunkBytes of [1, 2, 3, 7, WIRE_READ_CHUNK_BYTES]) {
          const streamed: ContextRecord[] = [];
          const result = await streamWireRecords(wirePath, {
            chunkBytes,
            onRecord: (record) => streamed.push(record),
          });
          expect(streamed).toEqual(legacy!.records);
          expect(result.recordCount).toBe(legacy!.records.length);
          expect(result.complete).toBe(legacy!.complete);
          expect(result.bytesRead).toBe(Buffer.byteLength(raw));
        }
      });
    },
  );

  it('keeps a record order and payloads intact when chunks split multi-byte characters', async () => {
    const records = Array.from({ length: 64 }, (_, index) => ({
      type: 'context.append_loop_event',
      index,
      text: `值-${index}-😀`,
    }));
    const raw = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await withWireFile(raw, async (wirePath) => {
      for (const chunkBytes of [1, 2, 3, 5, 9, 17]) {
        const streamed: ContextRecord[] = [];
        await streamWireRecords(wirePath, { chunkBytes, onRecord: (record) => streamed.push(record) });
        expect(streamed).toEqual(records);
      }
    });
  });

  it('streams a record larger than the chunk size', async () => {
    const large = { type: 'context.append_loop_event', text: 'x'.repeat(300 * 1024) };
    const raw = `${JSON.stringify(large)}\n${JSON.stringify({ type: 'turn.ended' })}\n`;
    await withWireFile(raw, async (wirePath) => {
      const streamed: ContextRecord[] = [];
      const result = await streamWireRecords(wirePath, {
        chunkBytes: 4 * 1024,
        onRecord: (record) => streamed.push(record),
      });
      expect(streamed).toEqual([large, { type: 'turn.ended' }]);
      expect(result.complete).toBe(true);
    });
  });

  it.each([1, 2, 4])('[STAT-R3] stops at the byte budget without emitting a truncated record (%i)', async (extraBytes) => {
    const first = { type: 'metadata', index: 0 };
    const padded = `${JSON.stringify({ type: 'metadata', index: 9 })}${' '.repeat(64)}`;
    const raw = `${JSON.stringify(first)}\n${padded}\n`;
    const budget = Buffer.byteLength(`${JSON.stringify(first)}\n`) + JSON.stringify({ type: 'metadata', index: 9 }).length + extraBytes;
    await withWireFile(raw, async (wirePath) => {
      const streamed: ContextRecord[] = [];
      const result = await streamWireRecords(wirePath, {
        maxBytes: budget,
        onRecord: (record) => streamed.push(record),
      });
      expect(streamed).toEqual([first]);
      expect(result.recordCount).toBe(1);
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('byte_budget');
      expect(result.bytesRead).toBe(budget);
    });
  });

  it('[STAT-R3] truncates on the record budget and keeps the readable prefix', async () => {
    const records = Array.from({ length: 6 }, (_, index) => ({ type: 'metadata', index }));
    const raw = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await withWireFile(raw, async (wirePath) => {
      const streamed: ContextRecord[] = [];
      const result = await streamWireRecords(wirePath, {
        maxRecords: 2,
        onRecord: (record) => streamed.push(record),
      });
      expect(streamed).toEqual(records.slice(0, 2));
      expect(result.recordCount).toBe(2);
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('record_budget');
      const zero = await streamWireRecords(wirePath, { maxRecords: 0, onRecord: () => undefined });
      expect(zero.recordCount).toBe(0);
      expect(zero.complete).toBe(false);
      expect(zero.incompleteReason).toBe('record_budget');
    });
  });

  it('[STAT-R3] stays complete when the budgets cover the whole file', async () => {
    const records = Array.from({ length: 5 }, (_, index) => ({ type: 'metadata', index }));
    const raw = `${records.map((record) => JSON.stringify(record)).join('\n')}\n\n\n`;
    await withWireFile(raw, async (wirePath) => {
      const exactBytes = await streamWireRecords(wirePath, {
        maxBytes: Buffer.byteLength(raw),
        onRecord: () => undefined,
      });
      expect(exactBytes.complete).toBe(true);
      expect(exactBytes.recordCount).toBe(5);
      expect(exactBytes.bytesRead).toBe(Buffer.byteLength(raw));
      const exactRecords = await streamWireRecords(wirePath, {
        maxRecords: 5,
        onRecord: () => undefined,
      });
      expect(exactRecords.complete).toBe(true);
      expect(exactRecords.recordCount).toBe(5);
      expect(exactRecords.incompleteReason).toBeUndefined();
    });
  });

  it('[STAT-R3] does not spend the record budget on blank or CR-only lines', async () => {
    const raw = '{"type":"a"}\n\n\r\n{"type":"b"}\r\n\r\n';
    await withWireFile(raw, async (wirePath) => {
      const streamed: ContextRecord[] = [];
      const result = await streamWireRecords(wirePath, {
        maxRecords: 2,
        onRecord: (record) => streamed.push(record),
      });
      expect(streamed).toEqual([{ type: 'a' }, { type: 'b' }]);
      expect(result.complete).toBe(true);
    });
  });

  it('[STAT-R3] reports the byte budget for a non-empty file with a zero budget', async () => {
    await withWireFile('{"type":"a"}\n', async (wirePath) => {
      const streamed: ContextRecord[] = [];
      const result = await streamWireRecords(wirePath, {
        maxBytes: 0,
        onRecord: (record) => streamed.push(record),
      });
      expect(streamed).toEqual([]);
      expect(result.bytesRead).toBe(0);
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('byte_budget');
    });
    await withWireFile('', async (wirePath) => {
      const result = await streamWireRecords(wirePath, { maxBytes: 0, onRecord: () => undefined });
      expect(result.complete).toBe(true);
      expect(result.recordCount).toBe(0);
    });
  });

  it('aborts mid-read and surfaces the abort reason to the caller', async () => {
    const records = Array.from({ length: 4 }, (_, index) => ({
      type: 'metadata',
      index,
      padding: 'z'.repeat(16),
    }));
    const raw = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await withWireFile(raw, async (wirePath) => {
      const controller = new AbortController();
      const streamed: ContextRecord[] = [];
      await expect(
        streamWireRecords(wirePath, {
          chunkBytes: 16,
          signal: controller.signal,
          onRecord: (record) => {
            streamed.push(record);
            controller.abort(new DOMException('wire read stopped', 'AbortError'));
          },
        }),
      ).rejects.toThrow('wire read stopped');
      expect(streamed.length).toBe(1);
    });
  });

  it('rejects an already-aborted signal before opening the wire file', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already gone', 'AbortError'));
    await expect(
      streamWireRecords(join(tmpdir(), 'transcript-live-missing', 'wire.jsonl'), {
        signal: controller.signal,
        onRecord: () => undefined,
      }),
    ).rejects.toThrow('already gone');
  });

  it('rejects a wire that disappears before the read starts', async () => {
    await expect(
      streamWireRecords(join(tmpdir(), 'transcript-live-missing', 'wire.jsonl'), {
        onRecord: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads every record of a wire larger than any explicitly passed budget', async () => {
    const records = Array.from({ length: 40_000 }, (_, index) => ({
      type: 'metadata',
      index,
      padding: 'y'.repeat(60),
    }));
    const raw = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await withWireFile(raw, async (wirePath) => {
      const boundedRecords: ContextRecord[] = [];
      const bounded = await streamWireRecords(wirePath, {
        maxBytes: 64 * 1024,
        onRecord: (record) => boundedRecords.push(record),
      });
      expect(bounded.complete).toBe(false);
      expect(boundedRecords.length).toBeLessThan(records.length);

      const legacy = await preRefactorReadWireRecords(wirePath);
      await expect(readWireRecordsWithCompleteness(wirePath)).resolves.toEqual(legacy);
      await expect(readWireRecords(wirePath)).resolves.toEqual(records);
      const unbounded = await streamWireRecords(wirePath, {
        maxBytes: Number.POSITIVE_INFINITY,
        maxRecords: Number.POSITIVE_INFINITY,
        maxLineBytes: Number.POSITIVE_INFINITY,
        onRecord: () => undefined,
      });
      const omitted = await streamWireRecords(wirePath, { onRecord: () => undefined });
      expect(omitted).toEqual(unbounded);
      expect(omitted.recordCount).toBe(records.length);
      expect(omitted.complete).toBe(true);
      expect(omitted.bytesRead).toBe(Buffer.byteLength(raw));
    });
  });

  it('applies the cold-read fences without cutting a healthy wire', async () => {
    const records = Array.from({ length: 40_000 }, (_, index) => ({ type: 'metadata', index, pad: 'z'.repeat(24) }));
    const raw = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await withWireFile(raw, async (wirePath) => {
      const result = await streamWireRecords(wirePath, {
        maxBytes: WIRE_COLD_READ_MAX_BYTES,
        maxRecords: WIRE_COLD_READ_MAX_RECORDS,
        maxLineBytes: WIRE_COLD_READ_MAX_LINE_BYTES,
        onRecord: () => undefined,
      });
      expect(result.recordCount).toBe(records.length);
      expect(result.bytesRead).toBe(Buffer.byteLength(raw));
      expect(result.complete).toBe(true);
      expect(result.incompleteReason).toBeUndefined();
      expect(WIRE_COLD_READ_MAX_BYTES).toBeGreaterThan(Buffer.byteLength(raw) * 100);
      expect(WIRE_COLD_READ_MAX_RECORDS).toBeGreaterThan(1_000_000);
      expect(WIRE_COLD_READ_MAX_LINE_BYTES).toBeGreaterThan(WIRE_READ_CHUNK_BYTES);
    });
  });

  it('stops on the line fence without delivering the oversized line', async () => {
    const oversized = { type: 'metadata', text: 'x'.repeat(200_000) };
    const raw = `${JSON.stringify({ type: 'metadata', index: 0 })}\n${JSON.stringify(oversized)}\n${JSON.stringify({ type: 'metadata', index: 2 })}\n`;
    await withWireFile(raw, async (wirePath) => {
      const streamed: ContextRecord[] = [];
      const result = await streamWireRecords(wirePath, {
        chunkBytes: 4_096,
        maxLineBytes: 64 * 1024,
        onRecord: (record) => streamed.push(record),
      });
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('line_budget');
      expect(streamed).toEqual([{ type: 'metadata', index: 0 }]);
      expect(result.recordCount).toBe(1);
      const wholeFileFits = await streamWireRecords(wirePath, {
        chunkBytes: 4_096,
        maxLineBytes: Buffer.byteLength(raw),
        onRecord: () => undefined,
      });
      expect(wholeFileFits.complete).toBe(true);
      expect(wholeFileFits.recordCount).toBe(3);
    });
  });

  it('merges a line larger than a chunk once, keeping the accumulation linear', async () => {
    const lineBytes = 32 * 1024 * 1024;
    const raw = `${JSON.stringify({ type: 'metadata', text: 'x'.repeat(lineBytes) })}\n`;
    await withWireFile(raw, async (wirePath) => {
      const concat = vi.spyOn(Buffer, 'concat');
      try {
        const streamed: ContextRecord[] = [];
        const result = await streamWireRecords(wirePath, {
          chunkBytes: 64 * 1024,
          onRecord: (record) => streamed.push(record),
        });
        expect(result.complete).toBe(true);
        expect(result.recordCount).toBe(1);
        expect(streamed).toHaveLength(1);
        expect((streamed[0] as unknown as { text: string }).text.length).toBe(lineBytes);
        expect(concat).toHaveBeenCalledTimes(1);
        const merged = concat.mock.calls.reduce(
          (total, [, length]) => total + (length ?? 0),
          0,
        );
        expect(merged).toBeLessThan(Buffer.byteLength(raw) * 2);
      } finally {
        concat.mockRestore();
      }
    });
  });

  it('bounds peak heap on a >100 MiB wire in isolated GC-enabled processes', { timeout: 240_000 }, async () => {
    const total = 400_000;
    const batchSize = 5_000;
    const home = await mkdtemp(join(tmpdir(), 'transcript-live-wire-large-'));
    const wirePath = join(home, 'wire.jsonl');
    try {
      const padding = 'x'.repeat(240);
      await writeFile(wirePath, '');
      for (let batch = 0; batch < total / batchSize; batch++) {
        const lines: string[] = [];
        for (let index = 0; index < batchSize; index++) {
          const sequence = batch * batchSize + index;
          lines.push(
            JSON.stringify({
              type: 'context.append_loop_event',
              index: sequence,
              text: `chunk-${sequence}`,
              padding,
            }),
          );
        }
        await appendFile(wirePath, `${lines.join('\n')}\n`);
      }
      const fileSize = (await stat(wirePath)).size;
      expect(fileSize).toBeGreaterThan(100 * 1024 * 1024);

      const lanes: readonly WireReadLane[] = ['legacy', 'array', 'stream'];
      const peaks: Record<WireReadLane, number> = { legacy: 0, array: 0, stream: 0 };
      for (const round of [0, 1]) {
        const order = round === 0 ? lanes : [...lanes].reverse();
        for (const lane of order) {
          const measurement = await measureWireReadPeak(wirePath, lane);
          expect(measurement.count).toBe(total);
          peaks[lane] = Math.max(peaks[lane], measurement.peakHeapBytes);
        }
      }
      console.log(
        `isolated peak heap (max of 2 GC-enabled rotated rounds): legacy=${toMiB(peaks.legacy)}MiB array=${toMiB(peaks.array)}MiB stream=${toMiB(peaks.stream)}MiB (${toMiB(fileSize)}MiB wire, ${total} records)`,
      );
      expect(peaks.stream).toBeLessThan(peaks.legacy / 2);
      expect(peaks.array).toBeLessThan(peaks.legacy);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

function toMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

import { AgentTranscriptDraft, TranscriptFactReducer, TranscriptWireAdapter, type TranscriptTurn } from '@kiki/transcript';
import { historyDirectoryWindowGuard } from './historyDirectoryWindow';
import { openLogicalWire, streamLogicalWireRecords } from './logicalWireRead';
import { historyBoundaryCandidate, historyNavigationRecord } from './historyWirePrefilter';

const SEARCH_TAIL_BYTES = 32 << 20;
const SCAN_CHUNK_BYTES = 4 << 20;
const TAIL_RECORDS = 100_000;

async function findTurnOpeningInTail(
  wirePath: string,
  turnId: string,
  signal?: AbortSignal,
): Promise<{ readonly start: number; readonly end: number } | undefined> {
  const wire = await openLogicalWire(wirePath, signal);
  if (wire === undefined) return undefined;
  const end = wire.size;
  if (end === 0) {
    wire.close();
    return undefined;
  }
  const minStart = Math.max(0, end - SEARCH_TAIL_BYTES);
  try {
    let windowEnd = end;
    let effectiveEnd = end;
    let trimmedEof = false;
    let carry = Buffer.alloc(0);
    while (windowEnd > minStart) {
      signal?.throwIfAborted();
      const rawStart = Math.max(minStart, windowEnd - SCAN_CHUNK_BYTES);
      const readPos = rawStart > 0 ? rawStart - 1 : 0;
      let chunk = Buffer.from(await wire.readAt(readPos, windowEnd - readPos));
      if (!trimmedEof) {
        const lastNl = chunk.lastIndexOf(10);
        if (lastNl < 0) {
          if (rawStart === minStart) return undefined;
          windowEnd = rawStart;
          effectiveEnd = rawStart;
          continue;
        }
        trimmedEof = true;
        effectiveEnd = readPos + lastNl + 1;
        chunk = chunk.subarray(0, lastNl + 1);
      }
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;

      let firstLineOffset = 0;
      if (readPos > 0) {
        const nl = combined.indexOf(10);
        if (nl < 0) {
          carry = combined;
          windowEnd = rawStart;
          continue;
        }
        firstLineOffset = nl + 1;
      }

      const boundaryOffsets: Array<{ readonly absStart: number; readonly line: Buffer }> = [];
      let cursor = firstLineOffset;
      while (cursor < combined.length) {
        const next = combined.indexOf(10, cursor);
        if (next < 0) break;
        const line = combined.subarray(cursor, next);
        if (line.length > 0 && historyBoundaryCandidate(line)) {
          boundaryOffsets.push({ absStart: readPos + cursor, line });
        }
        cursor = next + 1;
      }

      for (let i = boundaryOffsets.length - 1; i >= 0; i -= 1) {
        const entry = boundaryOffsets[i]!;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(entry.line.toString('utf8')) as Record<string, unknown>;
        } catch (error) {
          if (error instanceof SyntaxError) return undefined;
          throw error;
        }
        const type = record['type'];
        if (type === 'context.undo' || type === 'context.clear' || type === 'branch.base') {
          return undefined;
        }
        if (type === 'turn.prompt' && `t${String(record['turnId'])}` === turnId) {
          return { start: readPos === 0 && i === 0 && entry.absStart === 0 ? 0 : entry.absStart, end: effectiveEnd };
        }
      }

      if (rawStart === minStart) break;
      carry = combined.subarray(0, firstLineOffset);
      windowEnd = rawStart;
    }
    return undefined;
  } finally {
    wire.close();
  }
}

export async function readHistoryColdTailTurn(
  wirePath: string,
  agent: string,
  turnId: string,
  signal?: AbortSignal,
): Promise<TranscriptTurn | undefined> {
  const located = await findTurnOpeningInTail(wirePath, turnId, signal);
  if (located === undefined) return undefined;
  const { start, end } = located;
  const draft = new AgentTranscriptDraft(agent);
  const reducer = new TranscriptFactReducer(draft);
  const adapter = new TranscriptWireAdapter(agent, {
    turn: id => draft.getTurn(id),
    tool: id => draft.getToolCall(id),
    task: id => draft.getTask(id),
  });
  const guard = start === 0 ? undefined : historyDirectoryWindowGuard();
  let opening = false;
  const read = await streamLogicalWireRecords(wirePath, {
    startByteOffset: start,
    endByteOffset: end,
    maxBytes: SEARCH_TAIL_BYTES,
    maxRecords: TAIL_RECORDS,
    chunkBytes: 1 << 20,
    maxLineBytes: SEARCH_TAIL_BYTES,
    decodeRecord: historyNavigationRecord,
    signal,
    onRecord(record, span) {
      if (record['type'] === 'turn.prompt' && `t${String(record['turnId'])}` === turnId) opening = true;
      if (!opening && start > 0) return;
      guard?.(record);
      reducer.apply(adapter.add(record, {
        startByteOffset: span.startByteOffset,
        endByteOffset: span.endByteOffset,
        ordinal: start === 0 ? span.ordinal : undefined,
      }));
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'history_directory_window_unsupported') return undefined;
    throw error;
  });
  if (!opening || read?.complete !== true) return undefined;
  reducer.apply(adapter.finish());
  return draft.getTurn(turnId);
}

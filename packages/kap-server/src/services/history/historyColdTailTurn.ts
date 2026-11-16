import { AgentTranscriptDraft, TranscriptFactReducer, TranscriptWireAdapter, type TranscriptTurn } from '@kiki/transcript';
import { historyDirectoryWindowGuard } from './historyDirectoryWindow';
import { openLogicalWire, streamLogicalWireRecords } from './logicalWireRead';
import { historyBoundaryCandidate } from './historyWirePrefilter';

const TAIL_BYTES = 2 << 20;
const TAIL_RECORDS = 50_000;

export async function readHistoryColdTailTurn(wirePath: string, agent: string, turnId: string,
  signal?: AbortSignal): Promise<TranscriptTurn | undefined> {
  const wire = await openLogicalWire(wirePath, signal);
  if (wire === undefined) return undefined;
  const end = wire.size;
  let start = Math.max(0, end - TAIL_BYTES);
  try {
    if (start > 0) {
      const bytes = Buffer.from(await wire.readAt(start - 1, end - start + 1));
      const boundary = bytes.indexOf(10);
      if (boundary < 0) return undefined;
      start += boundary;
      let cursor = boundary + 1;
      let opening: number | undefined;
      while (cursor < bytes.length) {
        const next = bytes.indexOf(10, cursor);
        if (next < 0) break;
        const line = bytes.subarray(cursor, next);
        if (historyBoundaryCandidate(line)) {
          const record = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
          if (record['type'] === 'turn.prompt' && `t${String(record['turnId'])}` === turnId) {
            opening = end - bytes.length + cursor;
            break;
          }
        }
        cursor = next + 1;
      }
      if (opening === undefined) return undefined;
      start = opening;
    }
  } finally { wire.close(); }
  const draft = new AgentTranscriptDraft(agent);
  const reducer = new TranscriptFactReducer(draft);
  const adapter = new TranscriptWireAdapter(agent, {
    turn: id => draft.getTurn(id), tool: id => draft.getToolCall(id), task: id => draft.getTask(id),
  });
  const guard = start === 0 ? undefined : historyDirectoryWindowGuard();
  let opening = false;
  const read = await streamLogicalWireRecords(wirePath, {
    startByteOffset: start, endByteOffset: end, maxBytes: TAIL_BYTES, maxRecords: TAIL_RECORDS, signal,
    onRecord(record, span) {
      if (record['type'] === 'turn.prompt' && `t${String(record['turnId'])}` === turnId) opening = true;
      if (!opening && start > 0) return;
      guard?.(record);
      reducer.apply(adapter.add(record, { startByteOffset: span.startByteOffset, endByteOffset: span.endByteOffset,
        ordinal: start === 0 ? span.ordinal : undefined }));
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'history_directory_window_unsupported') return undefined;
    throw error;
  });
  if (!opening || read?.complete !== true) return undefined;
  reducer.apply(adapter.finish());
  return draft.getTurn(turnId);
}

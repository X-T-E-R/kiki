/**
 * The tolerant read side of the transcript coverage negotiation owned by
 * `@kiki/transcript`. A server that does not echo `transcript_coverage_version`
 * predates coverage v2, so nothing in its response can be trusted as complete:
 * a coverage claim is rewritten to `coverage: unknown` (which the transcript
 * store applies as preserve-existing + append-only), and every definite
 * tool-call count is cleared so the viewer keeps showing "range unknown"
 * instead of a precise total that contradicts the unknown coverage. Responses
 * carrying a confirmed coverage version pass through untouched.
 */

export const UNKNOWN_TRANSCRIPT_COVERAGE = { kind: 'unknown', hasMoreOlder: true } as const;

export function degradeUnconfirmedTranscriptSignal(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  const signal = data as { type?: unknown; event?: unknown };
  if (signal.type !== 'transcript') return data;
  const event = signal.event;
  if (event === null || typeof event !== 'object') return data;
  const kind = (event as { type?: unknown }).type;
  if (kind === 'transcript.reset') {
    return {
      ...data,
      event: {
        ...event,
        coverage: UNKNOWN_TRANSCRIPT_COVERAGE,
        read: degradedRead((event as { read?: unknown }).read),
        snapshot: unknownToolCallCountSnapshot((event as { snapshot?: unknown }).snapshot),
      },
    };
  }
  if (kind === 'transcript.ops') {
    const ops = (event as { ops?: unknown }).ops;
    if (!Array.isArray(ops)) return data;
    return { ...data, event: { ...event, ops: ops.map(degradeUnconfirmedOp) } };
  }
  return data;
}

export function degradeUnconfirmedTranscriptPage(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  return { ...data, coverage: UNKNOWN_TRANSCRIPT_COVERAGE, read: degradedRead((data as { read?: unknown }).read), tool_call_count: undefined };
}

export function degradeUnconfirmedTranscriptCatchUp(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  const batches = (data as { batches?: unknown }).batches;
  if (!Array.isArray(batches)) return data;
  return { ...data, batches: batches.map(degradeUnconfirmedBatch) };
}

function degradeUnconfirmedBatch(batch: unknown): unknown {
  if (batch === null || typeof batch !== 'object') return batch;
  const ops = (batch as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return batch;
  return { ...batch, ops: ops.map(degradeUnconfirmedOp) };
}

function degradeUnconfirmedOp(op: unknown): unknown {
  if (op === null || typeof op !== 'object') return op;
  const record = op as { op?: unknown; snapshot?: unknown; read?: unknown };
  if (record.op === 'reset') {
    return {
      ...record,
      coverage: UNKNOWN_TRANSCRIPT_COVERAGE,
      read: degradedRead(record.read),
      snapshot: unknownToolCallCountSnapshot(record.snapshot),
    };
  }
  if (record.op === 'tool.count.set') {
    return { ...record, count: undefined };
  }
  return op;
}

function degradedRead(read: unknown): unknown {
  const source = read !== null && typeof read === 'object' &&
    ((read as { source?: unknown }).source === 'live' || (read as { source?: unknown }).source === 'cold' || (read as { source?: unknown }).source === 'derived')
    ? (read as { source: 'live' | 'cold' | 'derived' }).source : 'derived';
  return { source, readiness: 'partial', reason: 'source_unverified' };
}

function unknownToolCallCountSnapshot(snapshot: unknown): unknown {
  if (snapshot === null || typeof snapshot !== 'object') return snapshot;
  return { ...snapshot, toolCallCount: undefined, toolCallCountKnown: false };
}

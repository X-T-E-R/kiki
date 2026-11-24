import { constants } from 'node:fs';
import { type FileHandle, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionAttentionCursor } from '@kiki/protocol';
import { ulid } from 'ulid';
import {
  encodeJsonLineBounded,
  MAX_SINGLE_JOURNAL_LINE_BYTES,
  StreamingJournalLineParser,
  type StreamingParsedJournalLine,
} from './boundedJsonEncoder';

export { MAX_SINGLE_JOURNAL_LINE_BYTES } from './boundedJsonEncoder';

const JOURNAL_VERSION = 2;
const WATERMARK_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const WRITEV_MAX_BYTES = 256 * 1024;
const WRITEV_MAX_IOVS = 64;
const COMPACT_HYSTERESIS_FACTOR = 2;
const DEFAULT_MAX_SESSION_PENDING_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PROCESS_PENDING_BYTES = 64 * 1024 * 1024;
const HEADER_ONLY_PENDING_BYTES = 64;
const TRANSIENT_OPEN_RETRY_DELAYS_MS = [15, 30, 60, 120] as const;
const BACKGROUND_FLUSH_COALESCE_MS = 25;
const DEFAULT_STALE_JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_TEMP_JOURNAL_TTL_MS = 60 * 60 * 1000;

let processPendingBytes = 0;

/** Current aggregate pending and in-flight journal bytes across the process. */
export function getJournalProcessPendingBytes(): number {
  return processPendingBytes;
}

const ATTENTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.ended',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.suspended',
  'event.approval.requested',
  'event.approval.resolved',
  'event.question.requested',
  'event.question.answered',
  'event.question.dismissed',
]);

/** Whether a journaled event type advances the session's attention cursor. */
export function isAttentionEventType(type: string): boolean {
  return ATTENTION_EVENT_TYPES.has(type);
}

/** Project a journal epoch and attention sequence into a wire attention cursor when an epoch is known. */
export function toAttentionCursor(
  cursor: { readonly epoch?: string; readonly attentionSeq?: number } | undefined,
): SessionAttentionCursor | undefined {
  if (cursor?.epoch === undefined || cursor.epoch.length === 0) return undefined;
  const seq = cursor.attentionSeq;
  if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { epoch: cursor.epoch, seq };
}

/**
 * Wire event envelope — matches `wsEventEnvelopeSchema` /
 * `sessionEventMessageSchema` in the local `protocol/ws-control` catalog. Defined
 * structurally so the journal does not depend on the zod schema at runtime.
 */
export interface EventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly epoch?: string;
  readonly volatile?: boolean;
  readonly offset?: number;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

/** Why a durable sequence was recorded as an explicit journal gap instead of a full event. */
export type JournalGapReason =
  | 'payload_too_large'
  | 'transcript_projected_oversize'
  | 'legacy_oversized_line'
  | 'queue_backpressure'
  | 'write_failed'
  | 'unserializable';

/** Minimal roster metadata preserved on a gap record for suppressed roster-hint consumers. */
export interface JournalRosterHint {
  readonly required: boolean;
  readonly type: string;
  readonly agentId?: string;
  readonly subagentId?: string;
  readonly infoKind?: string;
  readonly infoAgentId?: string;
}

/** Explicit non-public gap record persisted in the journal for omitted or collapsed durable seqs. */
export interface JournalGapEntry {
  readonly kind: 'gap';
  readonly seq: number;
  readonly fromSeq?: number;
  readonly attentionSeq: number;
  readonly eventType: string;
  readonly agentId: string | null;
  readonly routingKnown: boolean;
  readonly omittedBytesAtLeast: number;
  readonly reason: JournalGapReason;
  readonly rosterHint?: JournalRosterHint;
  readonly epoch?: string;
  readonly sessionId?: string;
}

/** One durable journal record decoded from disk or memory: either a full event or an explicit gap. */
export type JournalRecord =
  | {
      readonly kind: 'event';
      readonly seq: number;
      readonly attentionSeq: number;
      readonly envelope: EventEnvelope;
    }
  | JournalGapEntry;

/** Result returned by `append` / `appendGap` carrying the bounded encoded representation. */
export type JournalAppendOutcome =
  | {
      readonly kind: 'event';
      readonly seq: number;
      readonly attentionSeq: number;
      readonly bytes: number;
      readonly encoded: Buffer;
      readonly eventType: string;
      readonly agentId: string | null;
      readonly epoch?: string;
      readonly sessionId?: string;
      readonly rosterHint?: JournalRosterHint;
    }
  | {
      readonly kind: 'gap';
      readonly seq: number;
      readonly fromSeq?: number;
      readonly attentionSeq: number;
      readonly bytes: number;
      readonly gap: JournalGapEntry;
      readonly collapsedIntoPrevious: boolean;
    };

/** Bounded disk replay read result carrying full coverage health metadata. */
export interface JournalReadRangeResult {
  readonly epoch: string;
  readonly records: JournalRecord[];
  readonly healthy: boolean;
  readonly headerEpochValid: boolean;
}

/** Deterministic I/O, encoding, compaction, and backpressure metrics for one journal writer. */
export interface JournalWriteStats {
  readonly appendedBytes: number;
  readonly compactedTempBytes: number;
  readonly closeCompactedTempBytes: number;
  readonly validBoundedLineBytes: number;
  readonly compactionCount: number;
  readonly closeCompactionCount: number;
  readonly maxSingleAllocBytes: number;
  readonly maxBatchWriteBytes: number;
  readonly maxLineBytes: number;
  readonly gapCount: number;
  readonly backpressureCollapseCount: number;
  readonly writeFailureCount: number;
  readonly compactFailureCount: number;
  readonly writePoisoned: boolean;
  readonly diskFileBytes: number;
  readonly retainedBytes: number;
  readonly sessionPendingBytes: number;
}

/** Input descriptor for recording an explicit gap directly without passing a raw oversized object. */
export interface JournalGapInput {
  readonly eventType: string;
  readonly agentId: string | null;
  readonly routingKnown: boolean;
  readonly omittedBytesAtLeast: number;
  readonly reason: JournalGapReason;
  readonly rosterHint?: JournalRosterHint;
  readonly sessionId?: string;
  readonly advancesAttention?: boolean;
  readonly fromSeq?: number;
}

interface JournalHeaderLineBase {
  version: number;
  epoch: string;
  created_at: number;
  last_seq?: number;
  attention_seq?: number;
  has_gaps?: boolean;
}

type JournalHeaderLine =
  | (JournalHeaderLineBase & { kind: 'journal_header' })
  | (JournalHeaderLineBase & { kind: 'journal_header_v2' });

interface JournalEventLine {
  kind: 'event';
  seq: number;
  attention_seq?: number;
  envelope: EventEnvelope;
}

interface JournalGapLine {
  kind: 'gap';
  seq: number;
  from_seq?: number;
  attention_seq: number;
  event_type: string;
  agent_id?: string | null;
  routing_known: boolean;
  omitted_bytes_at_least: number;
  reason: JournalGapReason;
  roster_hint?: JournalRosterHint;
  epoch?: string;
  session_id?: string;
}

export interface JournalEntry {
  seq: number;
  envelope: EventEnvelope;
}

/** Minimal logger surface — keeps the journal decoupled from the server logger. */
export interface JournalLogger {
  warn(obj: unknown, msg: string): void;
  error?(obj: unknown, msg: string): void;
}

const noopLogger: JournalLogger = { warn: () => {} };

interface RetainedJournalEntry {
  buf: Buffer;
  bytes: number;
  chargedPendingBytes: number;
  seq: number;
  fromSeq?: number;
  attentionSeq: number;
  readonly isGap: boolean;
  gap?: JournalGapEntry;
  headerOnly?: boolean;
}

/** Optional configuration overrides for `SessionEventJournal.open`. */
export interface SessionEventJournalOptions {
  readonly maxSingleLineBytes?: number;
  readonly maxSessionPendingBytes?: number;
  readonly maxProcessPendingBytes?: number;
}

function isTransientReadError(code: string | undefined): boolean {
  return (
    code === 'EBUSY' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EMFILE' ||
    code === 'ENFILE' ||
    code === 'EAGAIN'
  );
}

/** Extract lightweight routing and roster-hint fields from an envelope without scanning large payloads. */
export function extractEnvelopeRouting(envelope: EventEnvelope): {
  readonly agentId: string | null;
  readonly routingKnown: boolean;
  readonly rosterHint?: JournalRosterHint;
} {
  const payload = envelope.payload;
  if (typeof payload !== 'object' || payload === null) {
    return { agentId: null, routingKnown: true };
  }
  const rec = payload as {
    readonly agentId?: unknown;
    readonly subagentId?: unknown;
    readonly info?: unknown;
  };
  const agentId = typeof rec.agentId === 'string' ? rec.agentId : null;
  const rosterHint = extractRosterHintFromFields(
    envelope.type,
    agentId,
    typeof rec.subagentId === 'string' ? rec.subagentId : undefined,
    typeof rec.info === 'object' && rec.info !== null
      ? (rec.info as { readonly kind?: unknown }).kind
      : undefined,
    typeof rec.info === 'object' && rec.info !== null
      ? (rec.info as { readonly agentId?: unknown }).agentId
      : undefined,
  );
  return { agentId, routingKnown: true, rosterHint };
}

function isSubagentLifecycleHintType(type: string): boolean {
  return (
    type === 'subagent.spawned' ||
    type === 'subagent.started' ||
    type === 'subagent.suspended' ||
    type === 'subagent.completed' ||
    type === 'subagent.failed'
  );
}

function isChildStatusOrTurnHintType(type: string): boolean {
  return (
    type === 'agent.status.updated' ||
    type === 'agent.branch_sealed' ||
    type === 'agent.tool_lock_changed' ||
    type === 'turn.started' ||
    type === 'turn.ended'
  );
}

/** Whether an event type can emit a roster hint for transcript-suppressed ordered views. */
export function isRosterHintEventType(type: string): boolean {
  return (
    isSubagentLifecycleHintType(type) ||
    isChildStatusOrTurnHintType(type) ||
    type === 'task.started' ||
    type === 'task.terminated'
  );
}

function extractRosterHintFromFields(
  type: string,
  agentId: string | null,
  subagentId: string | undefined,
  infoKind: unknown,
  infoAgentId: unknown,
): JournalRosterHint | undefined {
  if (!isRosterHintEventType(type)) return undefined;
  if (type === 'task.started' || type === 'task.terminated') {
    if (infoKind === 'agent') {
      return {
        required: true,
        type,
        ...(agentId !== null ? { agentId } : {}),
        infoKind: 'agent',
        ...(typeof infoAgentId === 'string' && infoAgentId.length > 0 ? { infoAgentId } : {}),
      };
    }
    if (infoKind !== undefined) {
      return { required: false, type };
    }
    return undefined;
  }
  if (isSubagentLifecycleHintType(type)) {
    if (subagentId === undefined || subagentId.length === 0) return undefined;
    return {
      required: true,
      type,
      ...(agentId !== null ? { agentId } : {}),
      subagentId,
    };
  }
  if (agentId === null || agentId === 'main') {
    return { required: false, type };
  }
  return { required: true, type, agentId };
}

export class SessionEventJournal {
  private _epoch: string;
  private _seq: number;
  private _attentionSeq: number;
  private pendingEntries: RetainedJournalEntry[] = [];
  private sessionPendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private headerPending: boolean;
  private replaceOnFirstWrite: boolean;
  private initPending: boolean;
  private hasGapRecords: boolean;
  private headerIsV2: boolean;
  private tornTailTruncateTo: number | undefined;
  private hasWritten = false;
  private writeFailed = false;
  private writePoisoned = false;
  private compactFailed = false;
  private appendSeparator = false;
  private dirtySinceSync = false;
  private retainedEntries: RetainedJournalEntry[] | undefined;
  private retainedBytes = 0;
  private headerBytes = 0;
  private diskEventCount = 0;
  private diskEventBytes = 0;
  private diskFileBytes = 0;
  private compactPending = false;
  private closeSyncFailed = false;
  private closing = false;
  private durableSeq: number;
  private durableAttentionSeq: number;
  private createdAt = Date.now();
  private readonly maxSingleLineBytes: number;
  private readonly maxSessionPendingBytes: number;
  private readonly maxProcessPendingBytes: number;

  private statAppendedBytes = 0;
  private statCompactedTempBytes = 0;
  private statCloseCompactedTempBytes = 0;
  private statValidBoundedLineBytes = 0;
  private statCompactionCount = 0;
  private statCloseCompactionCount = 0;
  private statMaxSingleAllocBytes = 0;
  private statMaxBatchWriteBytes = 0;
  private statMaxLineBytes = 0;
  private statGapCount = 0;
  private statBackpressureCollapseCount = 0;
  private statWriteFailureCount = 0;
  private statCompactFailureCount = 0;
  private lastAppendOutcome: JournalAppendOutcome | undefined;

  private constructor(
    private readonly filePath: string,
    private readonly logger: JournalLogger,
    epoch: string,
    lastSeq: number,
    attentionSeq: number,
    isFresh: boolean,
    replaceOnFirstWrite: boolean,
    initPending: boolean,
    hasGapRecords: boolean,
    headerIsV2: boolean,
    private readonly capacity: number,
    private readonly maxRetainedBytes: number,
    options?: SessionEventJournalOptions,
  ) {
    this._epoch = epoch;
    this._seq = lastSeq;
    this._attentionSeq = attentionSeq;
    this.durableSeq = lastSeq;
    this.durableAttentionSeq = attentionSeq;
    this.headerPending = isFresh && !initPending;
    this.replaceOnFirstWrite = replaceOnFirstWrite && !initPending;
    this.initPending = initPending;
    this.hasGapRecords = hasGapRecords;
    this.headerIsV2 = headerIsV2;
    this.maxSingleLineBytes = Math.min(
      MAX_SINGLE_JOURNAL_LINE_BYTES,
      options?.maxSingleLineBytes ?? MAX_SINGLE_JOURNAL_LINE_BYTES,
    );
    this.maxSessionPendingBytes = options?.maxSessionPendingBytes ?? DEFAULT_MAX_SESSION_PENDING_BYTES;
    this.maxProcessPendingBytes = options?.maxProcessPendingBytes ?? DEFAULT_MAX_PROCESS_PENDING_BYTES;
    if (isFresh && !initPending) this.retainedEntries = [];
  }

  /** Active journal epoch identifier. */
  get epoch(): string {
    return this._epoch;
  }

  /** Highest durable seq appended (0 if none). */
  get seq(): number {
    return this._seq;
  }

  /** Highest durable attention seq appended (0 if none). */
  get attentionSeq(): number {
    return this._attentionSeq;
  }

  /** Whether the writer entered a fail-closed state after an unprovable write failure. */
  get poisoned(): boolean {
    return this.writePoisoned;
  }

  /** Return deterministic write, allocation, compaction, and backpressure counters. */
  stats(): JournalWriteStats {
    return {
      appendedBytes: this.statAppendedBytes,
      compactedTempBytes: this.statCompactedTempBytes,
      closeCompactedTempBytes: this.statCloseCompactedTempBytes,
      validBoundedLineBytes: this.statValidBoundedLineBytes,
      compactionCount: this.statCompactionCount,
      closeCompactionCount: this.statCloseCompactionCount,
      maxSingleAllocBytes: this.statMaxSingleAllocBytes,
      maxBatchWriteBytes: this.statMaxBatchWriteBytes,
      maxLineBytes: this.statMaxLineBytes,
      gapCount: this.statGapCount,
      backpressureCollapseCount: this.statBackpressureCollapseCount,
      writeFailureCount: this.statWriteFailureCount,
      compactFailureCount: this.statCompactFailureCount,
      writePoisoned: this.writePoisoned,
      diskFileBytes: this.diskFileBytes,
      retainedBytes: this.retainedBytes,
      sessionPendingBytes: this.sessionPendingBytes,
    };
  }

  /**
   * Recover the watermark without loading the replay window. Retention starts
   * on the first append, so cold watermark queries do not compact the journal.
   */
  static async open(
    filePath: string,
    logger: JournalLogger = noopLogger,
    capacity = 1000,
    maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
    options?: SessionEventJournalOptions,
  ): Promise<SessionEventJournal> {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new RangeError('journal capacity must be a nonnegative integer');
    }
    if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0) {
      throw new RangeError('journal maxRetainedBytes must be a nonnegative integer');
    }
    let epoch: string | undefined;
    let lastSeq = 0;
    let attentionSeq = 0;
    let sawAnyLine = false;
    let hasGaps = false;
    let headerIsV2 = false;
    let transientOpenError = false;

    try {
      const watermark = await readWatermarkWithTransientRetry(filePath);
      epoch = watermark.epoch;
      lastSeq = watermark.lastSeq;
      attentionSeq = watermark.attentionSeq;
      sawAnyLine = watermark.sawAnyLine;
      hasGaps = watermark.hasGaps;
      headerIsV2 = watermark.headerIsV2;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        transientOpenError = isTransientReadError(code);
        logger.warn(
          { filePath, err: String(error) },
          transientOpenError
            ? 'event journal temporarily locked; deferring initialization without overwriting existing file'
            : 'event journal unreadable; starting a fresh epoch',
        );
      }
    }

    if (transientOpenError) {
      return new SessionEventJournal(
        filePath,
        logger,
        `ep_${ulid()}`,
        0,
        0,
        true,
        false,
        true,
        false,
        false,
        capacity,
        maxRetainedBytes,
        options,
      );
    }

    if (epoch === undefined) {
      if (sawAnyLine) {
        logger.warn({ filePath }, 'event journal missing header; rotating to a fresh epoch');
      }
      return new SessionEventJournal(
        filePath,
        logger,
        `ep_${ulid()}`,
        0,
        0,
        true,
        sawAnyLine,
        false,
        false,
        false,
        capacity,
        maxRetainedBytes,
        options,
      );
    }
    return new SessionEventJournal(
      filePath,
      logger,
      epoch,
      lastSeq,
      attentionSeq,
      false,
      false,
      false,
      hasGaps,
      headerIsV2,
      capacity,
      maxRetainedBytes,
      options,
    );
  }

  /**
   * Read the persisted watermark without creating, truncating, or flushing the
   * journal file. Used for cold watermark queries (such as `GET /api/sessions`).
   */
  static async peekWatermark(
    filePath: string,
    logger: JournalLogger = noopLogger,
  ): Promise<{ seq: number; epoch: string; attentionSeq: number }> {
    try {
      const watermark = await readWatermark(filePath);
      if (watermark.epoch !== undefined) {
        return { seq: watermark.lastSeq, epoch: watermark.epoch, attentionSeq: watermark.attentionSeq };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn({ filePath, err: String(error) }, 'event journal watermark read failed');
      }
    }
    return { seq: 0, epoch: '', attentionSeq: 0 };
  }

  /** Reserve the next durable seq. The caller must follow with `append()` or `appendGap()`. */
  nextSeq(): number {
    this._seq += 1;
    return this._seq;
  }

  /** Outcome produced by the most recent `append()` or `appendGap()` call. */
  lastOutcome(): JournalAppendOutcome | undefined {
    return this.lastAppendOutcome;
  }

  /** Queue a durable event line for bounded UTF-8 write-behind flush. */
  append(
    seq: number,
    envelope: EventEnvelope,
    options?: { readonly advancesAttention?: boolean; readonly oversizeReason?: JournalGapReason },
  ): void {
    const advancesAttention = options?.advancesAttention ?? isAttentionEventType(envelope.type);
    if (advancesAttention && seq > this._attentionSeq) {
      this._attentionSeq = seq;
    }
    const attentionSeq = this._attentionSeq;
    const routing = extractEnvelopeRouting(envelope);
    const effectiveMaxLineBytes = Math.min(this.maxSingleLineBytes, this.maxRetainedBytes);

    if (this.capacity > 0 && effectiveMaxLineBytes >= 2) {
      const line: JournalEventLine = {
        kind: 'event',
        seq,
        attention_seq: attentionSeq,
        envelope,
      };
      const encoded = encodeJsonLineBounded(line, effectiveMaxLineBytes);
      if (encoded.ok) {
        this.recordAlloc(encoded.bytes);
        if (encoded.bytes > this.statMaxLineBytes) this.statMaxLineBytes = encoded.bytes;
        const entry: RetainedJournalEntry = {
          buf: encoded.buffer,
          bytes: encoded.bytes,
          chargedPendingBytes: 0,
          seq,
          attentionSeq,
          isGap: false,
        };
        const admitted = this.admitEntry(entry);
        if (admitted.kind === 'admitted') {
          this.lastAppendOutcome = {
            kind: 'event',
            seq,
            attentionSeq,
            bytes: encoded.bytes,
            encoded: encoded.buffer,
            eventType: envelope.type,
            agentId: routing.agentId,
            epoch: envelope.epoch ?? this.epoch,
            sessionId: envelope.session_id,
            rosterHint: routing.rosterHint,
          };
          return;
        }
        this.lastAppendOutcome = {
          kind: 'gap',
          seq,
          fromSeq: admitted.gap.fromSeq,
          attentionSeq,
          bytes: admitted.bytes,
          gap: admitted.gap,
          collapsedIntoPrevious: admitted.collapsedIntoPrevious,
        };
        return;
      }
      if (encoded.reason === 'invalid') {
        this.logger.warn(
          { filePath: this.filePath, seq, eventType: envelope.type, err: String(encoded.error) },
          'event journal serialization failed; recording explicit gap',
        );
        this.lastAppendOutcome = this.enqueueGapInternal(seq, attentionSeq, {
          eventType: envelope.type,
          agentId: routing.agentId,
          routingKnown: routing.routingKnown,
          omittedBytesAtLeast: 0,
          reason: 'unserializable',
          rosterHint: routing.rosterHint,
          sessionId: envelope.session_id,
        });
        return;
      }
      this.lastAppendOutcome = this.enqueueGapInternal(seq, attentionSeq, {
        eventType: envelope.type,
        agentId: routing.agentId,
        routingKnown: routing.routingKnown,
        omittedBytesAtLeast: encoded.omittedBytesAtLeast,
        reason: options?.oversizeReason ?? 'payload_too_large',
        rosterHint: routing.rosterHint,
        sessionId: envelope.session_id,
      });
      return;
    }

    this.lastAppendOutcome = this.enqueueGapInternal(seq, attentionSeq, {
      eventType: envelope.type,
      agentId: routing.agentId,
      routingKnown: routing.routingKnown,
      omittedBytesAtLeast: 0,
      reason: options?.oversizeReason ?? 'payload_too_large',
      rosterHint: routing.rosterHint,
      sessionId: envelope.session_id,
    });
  }

  /** Queue an explicit gap record directly without passing a raw oversized payload. */
  appendGap(seq: number, input: JournalGapInput): JournalAppendOutcome {
    const advancesAttention = input.advancesAttention ?? isAttentionEventType(input.eventType);
    if (advancesAttention && seq > this._attentionSeq) {
      this._attentionSeq = seq;
    }
    const outcome = this.enqueueGapInternal(seq, this._attentionSeq, input);
    this.lastAppendOutcome = outcome;
    return outcome;
  }

  private enqueueGapInternal(
    seq: number,
    attentionSeq: number,
    input: JournalGapInput,
  ): JournalAppendOutcome {
    this.statGapCount += 1;
    const gap: JournalGapEntry = {
      kind: 'gap',
      seq,
      ...(input.fromSeq !== undefined ? { fromSeq: input.fromSeq } : {}),
      attentionSeq,
      eventType: input.eventType,
      agentId: input.routingKnown ? input.agentId : null,
      routingKnown: input.routingKnown,
      omittedBytesAtLeast: Math.max(0, input.omittedBytesAtLeast),
      reason: input.reason,
      ...(input.rosterHint !== undefined ? { rosterHint: input.rosterHint } : {}),
      epoch: this.epoch,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };
    const encoded = encodeGapLine(gap);
    this.recordAlloc(encoded.bytes);
    if (encoded.bytes > this.statMaxLineBytes) this.statMaxLineBytes = encoded.bytes;
    const fitsBudget = this.capacity > 0 && encoded.bytes <= this.maxRetainedBytes;
    if (fitsBudget) {
      this.hasGapRecords = true;
    }
    const entry: RetainedJournalEntry = {
      buf: encoded.buffer,
      bytes: encoded.bytes,
      chargedPendingBytes: 0,
      seq,
      ...(gap.fromSeq !== undefined ? { fromSeq: gap.fromSeq } : {}),
      attentionSeq,
      isGap: true,
      gap,
      headerOnly: !fitsBudget,
    };
    const admitted = this.admitEntry(entry);
    if (admitted.kind === 'admitted') {
      return {
        kind: 'gap',
        seq,
        ...(gap.fromSeq !== undefined ? { fromSeq: gap.fromSeq } : {}),
        attentionSeq,
        bytes: encoded.bytes,
        gap,
        collapsedIntoPrevious: false,
      };
    }
    return {
      kind: 'gap',
      seq,
      ...(admitted.gap.fromSeq !== undefined ? { fromSeq: admitted.gap.fromSeq } : {}),
      attentionSeq,
      bytes: admitted.bytes,
      gap: admitted.gap,
      collapsedIntoPrevious: admitted.collapsedIntoPrevious,
    };
  }

  private availablePendingRoom(): number {
    return Math.max(
      0,
      Math.min(
        this.maxSessionPendingBytes - this.sessionPendingBytes,
        this.maxProcessPendingBytes - processPendingBytes,
      ),
    );
  }

  private admitEntry(entry: RetainedJournalEntry):
    | { readonly kind: 'admitted' }
    | { readonly kind: 'collapsed'; readonly gap: JournalGapEntry; readonly bytes: number; readonly collapsedIntoPrevious: boolean } {
    this.hasWritten = true;
    if (entry.headerOnly === true) {
      const tail = this.pendingEntries.at(-1);
      if (tail !== undefined && tail.headerOnly === true) {
        tail.fromSeq = tail.fromSeq ?? tail.seq;
        tail.seq = Math.max(tail.seq, entry.seq);
        tail.attentionSeq = Math.max(tail.attentionSeq, entry.attentionSeq);
        if (entry.gap !== undefined) {
          tail.gap = {
            ...entry.gap,
            fromSeq: tail.fromSeq,
            seq: tail.seq,
            attentionSeq: tail.attentionSeq,
          };
        }
        this.writeFailed = false;
        this.scheduleBackgroundFlush();
        return { kind: 'admitted' };
      }
      const headerCharge = Math.min(HEADER_ONLY_PENDING_BYTES, this.availablePendingRoom());
      entry.chargedPendingBytes = headerCharge;
      this.pendingEntries.push(entry);
      if (headerCharge > 0) this.adjustPendingBytes(headerCharge);
      this.writeFailed = false;
      this.scheduleBackgroundFlush();
      return { kind: 'admitted' };
    }

    const projectedBytes = entry.bytes;
    const overBudget =
      this.sessionPendingBytes + projectedBytes > this.maxSessionPendingBytes ||
      processPendingBytes + projectedBytes > this.maxProcessPendingBytes;

    if (overBudget) {
      this.statBackpressureCollapseCount += 1;
      const tail = this.pendingEntries.at(-1);
      if (tail !== undefined && tail.isGap && tail.gap?.reason === 'queue_backpressure') {
        const mergedFromSeq = Math.min(tail.fromSeq ?? tail.seq, entry.fromSeq ?? entry.seq);
        const mergedSeq = Math.max(tail.seq, entry.seq);
        const mergedAttention = Math.max(tail.attentionSeq, entry.attentionSeq);
        const mergedOmitted = tail.gap.omittedBytesAtLeast + entry.bytes;
        const mergedGap: JournalGapEntry = {
          kind: 'gap',
          seq: mergedSeq,
          fromSeq: mergedFromSeq,
          attentionSeq: mergedAttention,
          eventType: '*',
          agentId: null,
          routingKnown: false,
          omittedBytesAtLeast: mergedOmitted,
          reason: 'queue_backpressure',
          epoch: this.epoch,
        };
        const encoded = encodeGapLine(mergedGap);
        this.recordAlloc(encoded.bytes);
        const fits = this.capacity > 0 && encoded.bytes <= this.maxRetainedBytes;
        if (fits) this.hasGapRecords = true;
        const oldCharge = tail.chargedPendingBytes;
        if (oldCharge > 0) this.adjustPendingBytes(-oldCharge);
        const desiredCharge = fits ? encoded.bytes : HEADER_ONLY_PENDING_BYTES;
        const nextCharge = Math.min(desiredCharge, this.availablePendingRoom());
        tail.buf = encoded.buffer;
        tail.bytes = encoded.bytes;
        tail.chargedPendingBytes = nextCharge;
        tail.seq = mergedSeq;
        tail.fromSeq = mergedFromSeq;
        tail.attentionSeq = mergedAttention;
        tail.gap = mergedGap;
        tail.headerOnly = !fits;
        if (nextCharge > 0) this.adjustPendingBytes(nextCharge);
        this.writeFailed = false;
        this.scheduleBackgroundFlush();
        return { kind: 'collapsed', gap: mergedGap, bytes: encoded.bytes, collapsedIntoPrevious: true };
      }

      this.statGapCount += 1;
      let mergedFromSeq = entry.fromSeq ?? entry.seq;
      let mergedSeq = entry.seq;
      let mergedAttention = entry.attentionSeq;
      let mergedOmitted = entry.bytes;

      const makeGap = () => {
        const bpGap: JournalGapEntry = {
          kind: 'gap',
          seq: mergedSeq,
          fromSeq: mergedFromSeq,
          attentionSeq: mergedAttention,
          eventType: '*',
          agentId: null,
          routingKnown: false,
          omittedBytesAtLeast: mergedOmitted,
          reason: 'queue_backpressure',
          epoch: this.epoch,
        };
        const encoded = encodeGapLine(bpGap);
        this.recordAlloc(encoded.bytes);
        return { bpGap, encoded };
      };

      let built = makeGap();
      let fits = this.capacity > 0 && built.encoded.bytes <= this.maxRetainedBytes;
      let desiredCharge = fits ? built.encoded.bytes : HEADER_ONLY_PENDING_BYTES;
      while (
        this.pendingEntries.length > 0 &&
        desiredCharge > this.availablePendingRoom() &&
        desiredCharge <= this.maxSessionPendingBytes &&
        desiredCharge <= this.maxProcessPendingBytes
      ) {
        const popped = this.pendingEntries.pop()!;
        if (popped.chargedPendingBytes > 0) {
          this.adjustPendingBytes(-popped.chargedPendingBytes);
        }
        mergedFromSeq = Math.min(mergedFromSeq, popped.fromSeq ?? popped.seq);
        mergedSeq = Math.max(mergedSeq, popped.seq);
        mergedAttention = Math.max(mergedAttention, popped.attentionSeq);
        mergedOmitted += popped.gap !== undefined ? popped.gap.omittedBytesAtLeast : popped.bytes;
        built = makeGap();
        fits = this.capacity > 0 && built.encoded.bytes <= this.maxRetainedBytes;
        desiredCharge = fits ? built.encoded.bytes : HEADER_ONLY_PENDING_BYTES;
      }

      if (fits) this.hasGapRecords = true;
      const bpCharge = Math.min(desiredCharge, this.availablePendingRoom());
      const bpEntry: RetainedJournalEntry = {
        buf: built.encoded.buffer,
        bytes: built.encoded.bytes,
        chargedPendingBytes: bpCharge,
        seq: built.bpGap.seq,
        fromSeq: built.bpGap.fromSeq,
        attentionSeq: built.bpGap.attentionSeq,
        isGap: true,
        gap: built.bpGap,
        headerOnly: !fits,
      };
      this.pendingEntries.push(bpEntry);
      if (bpCharge > 0) this.adjustPendingBytes(bpCharge);
      this.writeFailed = false;
      this.scheduleBackgroundFlush();
      return { kind: 'collapsed', gap: built.bpGap, bytes: built.encoded.bytes, collapsedIntoPrevious: false };
    }

    entry.chargedPendingBytes = projectedBytes;
    this.pendingEntries.push(entry);
    if (projectedBytes > 0) this.adjustPendingBytes(projectedBytes);
    this.writeFailed = false;
    this.scheduleBackgroundFlush();
    return { kind: 'admitted' };
  }

  private adjustPendingBytes(delta: number): void {
    this.sessionPendingBytes = Math.max(0, this.sessionPendingBytes + delta);
    processPendingBytes = Math.max(0, processPendingBytes + delta);
  }

  private recordAlloc(bytes: number): void {
    if (bytes > this.statMaxSingleAllocBytes) this.statMaxSingleAllocBytes = bytes;
  }

  /** Read event entries with `seq > fromSeqExclusive`, capped at `limit`. */
  async readSince(fromSeqExclusive: number, limit: number): Promise<JournalEntry[]> {
    await this.flush();
    if (this.writePoisoned || this.initPending || limit <= 0) return [];
    const out: JournalEntry[] = [];
    try {
      for await (const parsed of streamJournalRecordsForward(this.filePath, this.maxSingleLineBytes)) {
        if (parsed.kind !== 'event') continue;
        if (parsed.seq <= fromSeqExclusive) continue;
        out.push({ seq: parsed.seq, envelope: parsed.envelope });
        if (out.length >= limit) break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return out;
  }

  /**
   * Read both event and explicit gap records in `(fromSeqExclusive, upToSeqInclusive]`
   * via bounded 64 KiB streaming I/O without allocating oversized line buffers.
   */
  async readRecordsSince(
    fromSeqExclusive: number,
    upToSeqInclusive: number,
    limit: number,
  ): Promise<JournalReadRangeResult> {
    await this.flush();
    if (this.writePoisoned || this.initPending) {
      return { epoch: this.epoch, records: [], healthy: false, headerEpochValid: false };
    }
    if (limit <= 0 || upToSeqInclusive <= fromSeqExclusive) {
      return { epoch: this.epoch, records: [], healthy: true, headerEpochValid: true };
    }
    const out: JournalRecord[] = [];
    let headerEpoch: string | undefined;
    let healthy = true;
    let runningAttentionSeq = 0;

    try {
      for await (const parsed of streamJournalRecordsForward(this.filePath, this.maxSingleLineBytes)) {
        if (parsed.kind === 'corrupt') {
          healthy = false;
          continue;
        }
        if (parsed.kind === 'journal_header' || parsed.kind === 'journal_header_v2') {
          if (headerEpoch === undefined) {
            headerEpoch = parsed.epoch;
            runningAttentionSeq = Math.max(runningAttentionSeq, nonNegativeSafeInt(parsed.attention_seq));
          } else if (parsed.epoch !== headerEpoch) {
            healthy = false;
          }
          continue;
        }
        if (parsed.kind === 'event') {
          runningAttentionSeq = resolveRecordAttention(parsed.seq, parsed.attentionSeq, parsed.envelope.type, runningAttentionSeq);
          if (parsed.seq <= fromSeqExclusive) continue;
          if (parsed.seq > upToSeqInclusive) continue;
          out.push({
            kind: 'event',
            seq: parsed.seq,
            attentionSeq: runningAttentionSeq,
            envelope: parsed.envelope,
          });
          if (out.length >= limit) break;
          continue;
        }
        runningAttentionSeq = resolveRecordAttention(parsed.seq, parsed.attentionSeq, parsed.eventType, runningAttentionSeq);
        const rangeEnd = parsed.seq;
        const rangeStart = parsed.fromSeq ?? parsed.seq;
        if (rangeEnd <= fromSeqExclusive) continue;
        if (rangeStart > upToSeqInclusive) continue;
        out.push({
          ...parsed,
          attentionSeq: runningAttentionSeq,
        });
        if (out.length >= limit) break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { epoch: this.epoch, records: [], healthy: true, headerEpochValid: true };
      }
      throw error;
    }

    const headerEpochValid = headerEpoch === undefined || headerEpoch === this.epoch;
    return {
      epoch: this.epoch,
      records: out,
      healthy: healthy && headerEpochValid && !this.writePoisoned,
      headerEpochValid,
    };
  }

  async flush(): Promise<void> {
    this.clearFlushTimer();
    this.closeSyncFailed = false;
    while (
      this.flushPromise !== undefined ||
      (!this.writePoisoned && this.pendingEntries.length > 0) ||
      (this.closing &&
        !this.writePoisoned &&
        ((this.headerPending && !this.initPending) ||
          (this.dirtySinceSync && !this.closeSyncFailed) ||
          (this.hasWritten && this.needsCompaction() && !this.compactFailed)))
    ) {
      this.scheduleFlush();
      await this.flushPromise;
      if (
        this.writePoisoned ||
        this.writeFailed ||
        ((this.compactFailed || this.closeSyncFailed) &&
          this.pendingEntries.length === 0 &&
          this.flushPromise === undefined)
      ) {
        return;
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.flush();
    if (this.pendingEntries.length > 0) {
      let leftover = 0;
      for (const entry of this.pendingEntries) {
        if (entry.headerOnly !== true) leftover += entry.bytes;
      }
      this.pendingEntries = [];
      if (leftover > 0) this.adjustPendingBytes(-leftover);
    }
    if (this.sessionPendingBytes > 0) {
      this.adjustPendingBytes(-this.sessionPendingBytes);
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleBackgroundFlush(): void {
    if (this.writePoisoned) return;
    if (this.closing) {
      this.clearFlushTimer();
      this.scheduleFlush();
      return;
    }
    if (this.flushPromise !== undefined || this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.writeFailed && !this.writePoisoned && this.pendingEntries.length > 0) {
        this.scheduleFlush();
      }
    }, BACKGROUND_FLUSH_COALESCE_MS);
    this.flushTimer.unref?.();
  }

  private scheduleFlush(): void {
    this.clearFlushTimer();
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
      if (!this.writeFailed && !this.writePoisoned && this.pendingEntries.length > 0) {
        if (this.closing) this.scheduleFlush();
        else this.scheduleBackgroundFlush();
      }
    });
  }

  private needsCompaction(): boolean {
    if (this.retainedEntries === undefined) return false;
    if (!this.hasWritten) return false;
    if (this.compactPending) return true;
    const factor = this.closing ? 1 : COMPACT_HYSTERESIS_FACTOR;
    if (this.diskEventCount > this.capacity * factor) return true;
    if (this.diskEventBytes > this.maxRetainedBytes * factor) return true;
    if (this.diskFileBytes > this.headerBytes + this.maxRetainedBytes * factor) return true;
    return false;
  }

  private header(): JournalHeaderLine {
    return {
      kind: this.hasGapRecords ? 'journal_header_v2' : 'journal_header',
      version: JOURNAL_VERSION,
      epoch: this.epoch,
      created_at: this.createdAt,
      last_seq: this.durableSeq,
      attention_seq: this.durableAttentionSeq,
      ...(this.hasGapRecords ? { has_gaps: true } : {}),
    };
  }

  private encodeHeader(): Buffer {
    const encoded = encodeJsonLineBounded(this.header(), WATERMARK_READ_BYTES);
    if (!encoded.ok) {
      const fallback = Buffer.from(JSON.stringify(this.header()) + '\n', 'utf8');
      this.headerBytes = fallback.byteLength;
      return fallback;
    }
    this.headerBytes = encoded.bytes;
    this.recordAlloc(encoded.bytes);
    return encoded.buffer;
  }

  private async loadRetention(): Promise<void> {
    if (this.retainedEntries !== undefined) return;
    const retained: RetainedJournalEntry[] = [];
    let retainedBytes = 0;
    let fileSize = 0;
    try {
      const file = await open(this.filePath, 'r');
      try {
        const info = await file.stat();
        fileSize = info.size;
        const headLen = Math.min(fileSize, WATERMARK_READ_BYTES);
        let headBuf: Buffer | undefined;
        let headReadBytes = 0;
        if (headLen > 0) {
          headBuf = Buffer.allocUnsafe(headLen);
          const { bytesRead } = await file.read(headBuf, 0, headLen, 0);
          headReadBytes = bytesRead;
          const end = headBuf.subarray(0, bytesRead).indexOf(10);
          const headerLen = end < 0 ? bytesRead : end + 1;
          this.headerBytes = headerLen;
          if (end >= 0) {
            const header = parseJournalLine(headBuf.subarray(0, end).toString('utf8'));
            if (header?.kind === 'journal_header' || header?.kind === 'journal_header_v2') {
              this.createdAt = header.created_at;
              if (header.kind === 'journal_header_v2') {
                this.headerIsV2 = true;
                this.hasGapRecords = true;
              }
            }
          }
        }
        let linesOnDisk = 0;
        const effectiveMaxLineBytes = Math.min(this.maxSingleLineBytes, this.maxRetainedBytes);
        const admitDiskLine = (line: ReverseLineResult): 'continue' | 'stop' => {
          if (line.kind === 'journal_header') return 'stop';
          linesOnDisk += 1;
          if (line.kind === 'corrupt') {
            this.compactPending = true;
            return 'continue';
          }
          let entry: RetainedJournalEntry;
          if (line.kind === 'event') {
            if (line.bytes > effectiveMaxLineBytes) {
              this.compactPending = true;
              this.hasGapRecords = true;
              const gap = projectOversizedEventToGap(line.seq, line.attentionSeq, line.envelope, line.bytes, this.epoch);
              const gapBuf = encodeGapLine(gap);
              entry = {
                buf: gapBuf.buffer,
                bytes: gapBuf.bytes,
                chargedPendingBytes: 0,
                seq: gap.seq,
                attentionSeq: gap.attentionSeq,
                isGap: true,
                gap,
              };
            } else {
              entry = {
                buf: line.buf,
                bytes: line.bytes,
                chargedPendingBytes: 0,
                seq: line.seq,
                attentionSeq: line.attentionSeq,
                isGap: false,
              };
            }
          } else {
            if (line.oversizedSource) this.compactPending = true;
            this.hasGapRecords = true;
            const gapBuf = line.buf ?? encodeGapLine(line.gap).buffer;
            const gapBytes = gapBuf.byteLength;
            entry = {
              buf: gapBuf,
              bytes: gapBytes,
              chargedPendingBytes: 0,
              seq: line.gap.seq,
              ...(line.gap.fromSeq !== undefined ? { fromSeq: line.gap.fromSeq } : {}),
              attentionSeq: line.gap.attentionSeq,
              isGap: true,
              gap: line.gap,
            };
          }
          if (
            this.capacity === 0 ||
            retained.length >= this.capacity ||
            retainedBytes + entry.bytes > this.maxRetainedBytes
          ) {
            this.compactPending = true;
            return 'stop';
          }
          retained.push(entry);
          retainedBytes += entry.bytes;
          return 'continue';
        };

        if (fileSize > 0) {
          let windowEnd = fileSize;
          let checkedTrailingByte = false;
          const chunkBuf = Buffer.allocUnsafe(WATERMARK_READ_BYTES);
          let stopped = false;

          while (windowEnd > 0 && !stopped) {
            const windowStart = Math.max(0, windowEnd - WATERMARK_READ_BYTES);
            const windowLen = windowEnd - windowStart;
            let activeBuf: Buffer;
            let activeLen: number;
            if (windowStart === 0 && headBuf !== undefined && windowLen <= headReadBytes) {
              activeBuf = headBuf;
              activeLen = windowLen;
            } else {
              let got = 0;
              while (got < windowLen) {
                const r = await file.read(chunkBuf, got, windowLen - got, windowStart + got);
                if (r.bytesRead === 0) throw new Error('event journal changed during retention read');
                got += r.bytesRead;
              }
              activeBuf = chunkBuf;
              activeLen = got;
            }

            let end = activeLen;
            if (!checkedTrailingByte) {
              checkedTrailingByte = true;
              if (activeBuf[end - 1] !== 10) {
                this.compactPending = true;
                const lastLfInChunk = activeBuf.subarray(0, end).lastIndexOf(10);
                if (lastLfInChunk >= 0) {
                  this.tornTailTruncateTo = windowStart + lastLfInChunk + 1;
                  end = lastLfInChunk;
                } else {
                  const earlierLf = await findLastNewlineBefore(file, windowStart);
                  this.tornTailTruncateTo = earlierLf >= 0 ? earlierLf + 1 : 0;
                  windowEnd = Math.max(earlierLf, 0);
                  continue;
                }
              } else {
                end -= 1;
              }
            }

            let nextWindowEnd = windowStart;
            while (end > 0 && !stopped) {
              const sep = activeBuf.subarray(0, end).lastIndexOf(10);
              if (sep < 0 && windowStart > 0) {
                const spanning = await readSingleLineReverse(file, windowStart + end, this.maxSingleLineBytes);
                if (admitDiskLine(spanning) === 'stop') {
                  stopped = true;
                  break;
                }
                nextWindowEnd = spanning.prevEnd;
                break;
              }
              const lineStart = sep + 1;
              const lineLen = end - lineStart;
              if (lineLen === 0) {
                this.compactPending = true;
              } else {
                const rawSlice = activeBuf.subarray(lineStart, end);
                const parsed = parseJournalLine(rawSlice.toString('utf8'));
                if (parsed === undefined) {
                  admitDiskLine({ kind: 'corrupt', prevEnd: 0 });
                } else if (parsed.kind === 'journal_header' || parsed.kind === 'journal_header_v2') {
                  if (admitDiskLine({ kind: 'journal_header', header: parsed, prevEnd: 0 }) === 'stop') {
                    stopped = true;
                    break;
                  }
                } else {
                  const withLf = Buffer.allocUnsafe(lineLen + 1);
                  rawSlice.copy(withLf, 0);
                  withLf[lineLen] = 0x0a;
                  const result: ReverseLineResult =
                    parsed.kind === 'event'
                      ? {
                          kind: 'event',
                          seq: parsed.seq,
                          attentionSeq: parsed.attentionSeq ?? (isAttentionEventType(parsed.envelope.type) ? parsed.seq : 0),
                          explicitAttention: parsed.attentionSeq !== undefined,
                          envelope: parsed.envelope,
                          buf: withLf,
                          bytes: withLf.byteLength,
                          prevEnd: 0,
                        }
                      : {
                          kind: 'gap',
                          gap: parsed.gap,
                          explicitAttention: parsed.explicitAttention,
                          oversizedSource: false,
                          buf: withLf,
                          prevEnd: 0,
                        };
                  if (admitDiskLine(result) === 'stop') {
                    stopped = true;
                    break;
                  }
                }
              }
              end = Math.max(sep, 0);
              if (sep === 0 && windowStart > 0) {
                nextWindowEnd = windowStart;
                break;
              }
            }
            windowEnd = nextWindowEnd;
          }
        }
        this.diskEventCount = linesOnDisk;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.retainedEntries = retained.toReversed();
    this.retainedBytes = retainedBytes;
    this.diskFileBytes = fileSize;
    this.diskEventBytes = Math.max(retainedBytes, Math.max(0, fileSize - this.headerBytes));
    if (this.diskEventBytes > this.maxRetainedBytes * COMPACT_HYSTERESIS_FACTOR) {
      this.compactPending = true;
    }
  }

  private takeNextSubBatch(): RetainedJournalEntry[] {
    if (this.pendingEntries.length === 0) return [];
    const maxBatchBytes = Math.max(1, Math.min(WRITEV_MAX_BYTES, Math.max(1024, this.maxRetainedBytes)));
    const batch: RetainedJournalEntry[] = [];
    let batchBytes = 0;
    while (batch.length < this.pendingEntries.length && batch.length < WRITEV_MAX_IOVS) {
      const next = this.pendingEntries[batch.length]!;
      const nextBytes = next.headerOnly === true ? 0 : next.bytes;
      if (batch.length > 0 && batchBytes + nextBytes > maxBatchBytes) break;
      batch.push(next);
      batchBytes += nextBytes;
    }
    this.pendingEntries.splice(0, batch.length);
    return batch;
  }

  private requeueFront(batch: RetainedJournalEntry[]): void {
    if (batch.length === 0) return;
    this.pendingEntries = batch.concat(this.pendingEntries);
  }

  private releaseBatchPendingBytes(batch: readonly RetainedJournalEntry[]): void {
    let released = 0;
    for (const entry of batch) {
      if (entry.chargedPendingBytes > 0) {
        released += entry.chargedPendingBytes;
        entry.chargedPendingBytes = 0;
      }
    }
    if (released > 0) this.adjustPendingBytes(-released);
  }

  private async reconcilePendingInit(): Promise<boolean> {
    if (!this.initPending) return true;
    try {
      const watermark = await readWatermark(this.filePath);
      if (watermark.epoch === undefined) {
        this.initPending = false;
        this.retainedEntries = [];
        if (watermark.sawAnyLine) {
          this.replaceOnFirstWrite = true;
          this.headerPending = true;
        } else {
          this.headerPending = true;
        }
        return true;
      }
      if (this._seq === 0 && this.pendingEntries.length === 0) {
        this._epoch = watermark.epoch;
        this._seq = watermark.lastSeq;
        this._attentionSeq = watermark.attentionSeq;
        this.durableSeq = watermark.lastSeq;
        this.durableAttentionSeq = watermark.attentionSeq;
        this.hasGapRecords = watermark.hasGaps;
        this.headerIsV2 = watermark.headerIsV2;
        this.initPending = false;
        return true;
      }
      this.initPending = false;
      this.writePoisoned = true;
      this.writeFailed = true;
      const dropped = this.pendingEntries.splice(0);
      this.releaseBatchPendingBytes(dropped);
      const log = this.logger.error ?? this.logger.warn;
      log(
        { filePath: this.filePath, existingEpoch: watermark.epoch, existingSeq: watermark.lastSeq },
        'event journal recovered intact file after transient lock; preserving existing file and pausing provisional writer',
      );
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.initPending = false;
        this.headerPending = true;
        this.retainedEntries = [];
        return true;
      }
      this.writeFailed = true;
      this.statWriteFailureCount += 1;
      this.logger.warn(
        { filePath: this.filePath, err: String(error) },
        'event journal still locked during deferred init; existing file preserved untouched',
      );
      return false;
    }
  }

  private wouldCrossHotCompaction(batch: readonly RetainedJournalEntry[]): boolean {
    if (this.retainedEntries === undefined || this.capacity === 0 || this.maxRetainedBytes === 0) return false;
    if (this.headerPending || this.replaceOnFirstWrite || this.tornTailTruncateTo !== undefined) return false;
    let addedBytes = 0;
    let addedCount = 0;
    for (const entry of batch) {
      if (entry.headerOnly === true) return false;
      addedBytes += entry.bytes;
      addedCount += 1;
    }
    if (addedCount === 0) return false;
    const factor = COMPACT_HYSTERESIS_FACTOR;
    return (
      this.diskEventCount + addedCount > this.capacity * factor ||
      this.diskEventBytes + addedBytes > this.maxRetainedBytes * factor ||
      this.diskFileBytes + addedBytes > this.headerBytes + this.maxRetainedBytes * factor
    );
  }

  private async compactWithBatch(batch: RetainedJournalEntry[]): Promise<boolean> {
    const retained = this.retainedEntries!;
    const addedRetainable = batch.filter((e) => e.headerOnly !== true);
    const trimmed = trimRetainedEntries(
      addedRetainable.length > 0 ? retained.concat(addedRetainable) : retained,
      this.capacity,
      this.maxRetainedBytes,
    );
    let nextDurableSeq = this.durableSeq;
    let nextDurableAttentionSeq = this.durableAttentionSeq;
    let batchLineBytes = 0;
    for (const entry of batch) {
      nextDurableSeq = Math.max(nextDurableSeq, entry.seq);
      nextDurableAttentionSeq = Math.max(nextDurableAttentionSeq, entry.attentionSeq);
      if (entry.headerOnly !== true) batchLineBytes += entry.bytes;
    }
    const prevDurableSeq = this.durableSeq;
    const prevDurableAttentionSeq = this.durableAttentionSeq;
    this.durableSeq = nextDurableSeq;
    this.durableAttentionSeq = nextDurableAttentionSeq;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const headerBuf = this.encodeHeader();
      const bufs: Buffer[] = [headerBuf];
      for (const entry of trimmed.entries) bufs.push(entry.buf);
      const written = await replaceJournalBuffers(this.filePath, bufs, (b) => this.recordBatchWrite(b));
      this.statCompactedTempBytes += written;
      this.statCompactionCount += 1;
      this.statValidBoundedLineBytes += batchLineBytes;
      this.headerIsV2 = this.hasGapRecords;
      this.headerPending = false;
      this.replaceOnFirstWrite = false;
      this.appendSeparator = false;
      this.tornTailTruncateTo = undefined;
      this.compactPending = false;
      this.dirtySinceSync = false;
      this.retainedEntries = trimmed.entries;
      this.retainedBytes = trimmed.bytes;
      this.diskEventCount = trimmed.entries.length;
      this.diskEventBytes = trimmed.bytes;
      this.diskFileBytes = written;
      this.releaseBatchPendingBytes(batch);
      return true;
    } catch (error) {
      this.durableSeq = prevDurableSeq;
      this.durableAttentionSeq = prevDurableAttentionSeq;
      this.compactPending = true;
      this.compactFailed = true;
      this.statCompactFailureCount += 1;
      this.logger.warn(
        { filePath: this.filePath, err: String(error) },
        'event journal direct batch compaction failed; falling back to append',
      );
      return false;
    }
  }

  private async flushOnce(): Promise<void> {
    if (this.writePoisoned) return;
    this.compactFailed = false;
    if (this.pendingEntries.length === 0 && !this.closing) return;
    if (this.pendingEntries.length === 0 && this.closing && !this.hasWritten && !this.headerPending) {
      return;
    }
    if (this.pendingEntries.length === 0 && this.closing && this.initPending && !this.hasWritten) {
      return;
    }

    if (this.initPending) {
      const ready = await this.reconcilePendingInit();
      if (!ready) return;
    }

    try {
      await this.loadRetention();
    } catch (error) {
      this.writeFailed = true;
      this.statWriteFailureCount += 1;
      this.logger.warn(
        { filePath: this.filePath, err: String(error) },
        'event journal retention read failed; append retained for retry',
      );
      return;
    }

    if (this.pendingEntries.length === 0 && this.headerPending && this.closing) {
      const ok = await this.writeHeaderOnlyInitial();
      if (!ok) return;
    }

    while (this.pendingEntries.length > 0 && !this.writePoisoned) {
      const batch = this.takeNextSubBatch();
      if (batch.length === 0) break;
      const needsV2HeaderUpgrade =
        !this.headerPending &&
        !this.headerIsV2 &&
        (this.hasGapRecords || batch.some((entry) => entry.isGap && entry.headerOnly !== true));
      if (needsV2HeaderUpgrade) {
        this.hasGapRecords = true;
        this.replaceOnFirstWrite = true;
      }
      if (!needsV2HeaderUpgrade && this.wouldCrossHotCompaction(batch)) {
        const compacted = await this.compactWithBatch(batch);
        if (compacted) continue;
      }
      const outcome = await this.flushSubBatch(batch);
      if (outcome !== 'ok') {
        return;
      }
      if (this.needsCompaction()) {
        const compacted = await this.compactNow(false);
        if (!compacted) return;
      }
    }

    this.writeFailed = false;
    if (this.closing && this.hasWritten && this.needsCompaction()) {
      const compacted = await this.compactNow(true);
      if (compacted) return;
    }
    if (this.closing && this.dirtySinceSync && !this.writePoisoned) {
      try {
        const file = await open(this.filePath, constants.O_RDWR);
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        this.dirtySinceSync = false;
      } catch (error) {
        this.closeSyncFailed = true;
        this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal close sync failed');
      }
    }
  }

  private async writeHeaderOnlyInitial(): Promise<boolean> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const headerBuf = this.encodeHeader();
      if (this.replaceOnFirstWrite) {
        const written = await replaceJournalBuffers(this.filePath, [headerBuf], (b) => this.recordBatchWrite(b));
        this.replaceOnFirstWrite = false;
        this.headerPending = false;
        this.headerIsV2 = this.hasGapRecords;
        this.appendSeparator = false;
        this.tornTailTruncateTo = undefined;
        this.dirtySinceSync = false;
        this.diskFileBytes = written;
        this.diskEventBytes = 0;
        this.diskEventCount = 0;
        return true;
      }
      const file = await open(this.filePath, constants.O_CREAT | constants.O_RDWR);
      try {
        const st = await file.stat();
        const written = await writevBuffers(file, [headerBuf], st.size, (b) => this.recordBatchWrite(b));
        this.diskFileBytes = st.size + written;
        this.statAppendedBytes += written;
      } finally {
        await file.close();
      }
      this.headerPending = false;
      this.headerIsV2 = this.hasGapRecords;
      this.appendSeparator = false;
      this.dirtySinceSync = true;
      return true;
    } catch (error) {
      this.writeFailed = true;
      this.statWriteFailureCount += 1;
      this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal initial header write failed');
      return false;
    }
  }

  private async flushSubBatch(batch: RetainedJournalEntry[]): Promise<'ok' | 'retryable' | 'poisoned'> {
    if (this.replaceOnFirstWrite) {
      const nextRetained = trimRetainedEntries(
        this.retainedEntries!.concat(batch.filter((e) => e.headerOnly !== true)),
        this.capacity,
        this.maxRetainedBytes,
      );
      let nextDurableSeq = this.durableSeq;
      let nextDurableAttentionSeq = this.durableAttentionSeq;
      let batchLineBytes = 0;
      for (const entry of batch) {
        nextDurableSeq = Math.max(nextDurableSeq, entry.seq);
        nextDurableAttentionSeq = Math.max(nextDurableAttentionSeq, entry.attentionSeq);
        if (entry.headerOnly !== true) batchLineBytes += entry.bytes;
      }
      const prevDurableSeq = this.durableSeq;
      const prevDurableAttentionSeq = this.durableAttentionSeq;
      this.durableSeq = nextDurableSeq;
      this.durableAttentionSeq = nextDurableAttentionSeq;
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const headerBuf = this.encodeHeader();
        const bufs = [headerBuf, ...nextRetained.entries.map((e) => e.buf)];
        const written = await replaceJournalBuffers(this.filePath, bufs, (b) => this.recordBatchWrite(b));
        this.statAppendedBytes += written;
        this.statValidBoundedLineBytes += batchLineBytes;
        this.replaceOnFirstWrite = false;
        this.headerPending = false;
        this.headerIsV2 = this.hasGapRecords;
        this.appendSeparator = false;
        this.tornTailTruncateTo = undefined;
        this.dirtySinceSync = false;
        this.compactPending = false;
        this.retainedEntries = nextRetained.entries;
        this.retainedBytes = nextRetained.bytes;
        this.diskEventCount = nextRetained.entries.length;
        this.diskEventBytes = nextRetained.bytes;
        this.diskFileBytes = written;
        this.releaseBatchPendingBytes(batch);
        return 'ok';
      } catch (error) {
        this.durableSeq = prevDurableSeq;
        this.durableAttentionSeq = prevDurableAttentionSeq;
        const hadNewer = this.pendingEntries.length > 0;
        this.requeueFront(batch);
        this.writeFailed = !hadNewer;
        this.statWriteFailureCount += 1;
        this.logger.warn(
          { filePath: this.filePath, err: String(error) },
          'event journal atomic init write failed; lines requeued for retry',
        );
        return 'retryable';
      }
    }

    const buffers: Buffer[] = [];
    let batchLineBytes = 0;
    if (this.appendSeparator) {
      buffers.push(Buffer.from('\n'));
    }
    if (this.headerPending) {
      buffers.push(this.encodeHeader());
    }
    for (const entry of batch) {
      if (entry.headerOnly === true) {
        this.compactPending = true;
      } else {
        buffers.push(entry.buf);
        batchLineBytes += entry.bytes;
      }
    }

    if (buffers.length === 0) {
      for (const entry of batch) {
        this.durableSeq = Math.max(this.durableSeq, entry.seq);
        this.durableAttentionSeq = Math.max(this.durableAttentionSeq, entry.attentionSeq);
      }
      this.compactPending = true;
      this.releaseBatchPendingBytes(batch);
      return 'ok';
    }

    let expectedWriteBytes = 0;
    for (const buf of buffers) expectedWriteBytes += buf.byteLength;
    const lastBuf = buffers.at(-1)!;

    let file: FileHandle | undefined;
    let beforeSize = 0;
    let beforeDev: number | bigint = 0;
    let beforeIno: number | bigint = 0;
    let writeCompleted = false;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      file = await open(this.filePath, constants.O_CREAT | constants.O_RDWR);
      const beforeStat = await file.stat({ bigint: true });
      beforeSize = Number(beforeStat.size);
      beforeDev = beforeStat.dev;
      beforeIno = beforeStat.ino;
      if (this.tornTailTruncateTo !== undefined && beforeSize > this.tornTailTruncateTo) {
        await file.truncate(this.tornTailTruncateTo);
        beforeSize = this.tornTailTruncateTo;
      }

      const written = await writevBuffers(file, buffers, beforeSize, (b) => this.recordBatchWrite(b));
      if (written !== expectedWriteBytes) {
        throw new Error(`event journal writev incomplete: wrote ${written} of ${expectedWriteBytes}`);
      }
      writeCompleted = true;
    } catch (error) {
      this.statWriteFailureCount += 1;
      let recovered = false;
      if (file === undefined) {
        recovered = true;
      } else {
        recovered = await recoverWriteBoundary(file, beforeDev, beforeIno, beforeSize);
      }
      if (file !== undefined) {
        await file.close().catch(() => {});
        file = undefined;
      }
      if (recovered) {
        const hadNewer = this.pendingEntries.length > 0;
        this.requeueFront(batch);
        this.writeFailed = !hadNewer;
        this.logger.warn(
          { filePath: this.filePath, err: String(error) },
          'event journal write failed; boundary restored and lines requeued',
        );
        return 'retryable';
      }
      this.writePoisoned = true;
      this.writeFailed = true;
      this.releaseBatchPendingBytes(batch);
      const log = this.logger.error ?? this.logger.warn;
      log(
        { filePath: this.filePath, err: String(error) },
        'event journal write failed with unprovable boundary; writer paused and replay marked gap',
      );
      return 'poisoned';
    }

    try {
      await file.close();
      file = undefined;
    } catch (closeError) {
      const verified = await verifyTailAndRetrySync(
        this.filePath,
        beforeDev,
        beforeIno,
        beforeSize + expectedWriteBytes,
        lastBuf,
      );
      if (!verified) {
        this.writePoisoned = true;
        this.writeFailed = true;
        this.statWriteFailureCount += 1;
        this.releaseBatchPendingBytes(batch);
        const log = this.logger.error ?? this.logger.warn;
        log(
          { filePath: this.filePath, err: String(closeError) },
          'event journal close failed with unverified tail; writer paused and replay marked gap',
        );
        return 'poisoned';
      }
    }

    if (!writeCompleted) return 'poisoned';

    if (this.headerPending) {
      this.headerIsV2 = this.hasGapRecords;
    }
    this.headerPending = false;
    this.appendSeparator = false;
    this.tornTailTruncateTo = undefined;
    this.dirtySinceSync = true;
    this.statAppendedBytes += expectedWriteBytes;
    this.statValidBoundedLineBytes += batchLineBytes;
    this.diskFileBytes = beforeSize + expectedWriteBytes;
    this.diskEventBytes += batchLineBytes;
    this.diskEventCount += batch.length;

    const retained = this.retainedEntries!;
    const addedRetainable: RetainedJournalEntry[] = [];
    for (const entry of batch) {
      this.durableSeq = Math.max(this.durableSeq, entry.seq);
      this.durableAttentionSeq = Math.max(this.durableAttentionSeq, entry.attentionSeq);
      if (entry.headerOnly !== true) addedRetainable.push(entry);
    }
    const trimmed = trimRetainedEntries(
      addedRetainable.length > 0 ? retained.concat(addedRetainable) : retained,
      this.capacity,
      this.maxRetainedBytes,
    );
    this.retainedEntries = trimmed.entries;
    this.retainedBytes = trimmed.bytes;
    this.releaseBatchPendingBytes(batch);
    return 'ok';
  }

  private async compactNow(isCloseConvergence: boolean): Promise<boolean> {
    try {
      const trimmed = trimRetainedEntries(this.retainedEntries!, this.capacity, this.maxRetainedBytes);
      this.retainedEntries = trimmed.entries;
      this.retainedBytes = trimmed.bytes;
      const headerBuf = this.encodeHeader();
      const retained = this.retainedEntries;
      const bufs: Buffer[] = [headerBuf];
      for (const entry of retained) bufs.push(entry.buf);
      const written = await replaceJournalBuffers(this.filePath, bufs, (b) => this.recordBatchWrite(b));
      if (isCloseConvergence) {
        this.statCloseCompactedTempBytes += written;
        this.statCloseCompactionCount += 1;
      } else {
        this.statCompactedTempBytes += written;
        this.statCompactionCount += 1;
      }
      this.headerIsV2 = this.hasGapRecords;
      this.tornTailTruncateTo = undefined;
      this.diskEventCount = retained.length;
      this.diskEventBytes = this.retainedBytes;
      this.diskFileBytes = written;
      this.compactPending = false;
      this.dirtySinceSync = false;
      return true;
    } catch (error) {
      this.compactPending = true;
      this.compactFailed = true;
      this.statCompactFailureCount += 1;
      this.logger.warn(
        { filePath: this.filePath, err: String(error) },
        'event journal compaction failed; durable source retained for retry',
      );
      return false;
    }
  }

  private recordBatchWrite(bytes: number): void {
    if (bytes > this.statMaxBatchWriteBytes) this.statMaxBatchWriteBytes = bytes;
  }
}

function encodeGapLine(gap: JournalGapEntry): { readonly buffer: Buffer; readonly bytes: number } {
  const line: JournalGapLine = {
    kind: 'gap',
    seq: gap.seq,
    ...(gap.fromSeq !== undefined ? { from_seq: gap.fromSeq } : {}),
    attention_seq: gap.attentionSeq,
    event_type: gap.eventType,
    agent_id: gap.routingKnown ? gap.agentId : undefined,
    routing_known: gap.routingKnown,
    omitted_bytes_at_least: gap.omittedBytesAtLeast,
    reason: gap.reason,
    ...(gap.rosterHint !== undefined ? { roster_hint: gap.rosterHint } : {}),
    ...(gap.epoch !== undefined ? { epoch: gap.epoch } : {}),
    ...(gap.sessionId !== undefined ? { session_id: gap.sessionId } : {}),
  };
  const encoded = encodeJsonLineBounded(line, MAX_SINGLE_JOURNAL_LINE_BYTES);
  if (encoded.ok) {
    return { buffer: encoded.buffer, bytes: encoded.bytes };
  }
  const minimal: JournalGapLine = {
    kind: 'gap',
    seq: gap.seq,
    ...(gap.fromSeq !== undefined ? { from_seq: gap.fromSeq } : {}),
    attention_seq: gap.attentionSeq,
    event_type: gap.eventType.slice(0, 128),
    routing_known: false,
    omitted_bytes_at_least: gap.omittedBytesAtLeast,
    reason: gap.reason,
  };
  const buf = Buffer.from(JSON.stringify(minimal) + '\n', 'utf8');
  return { buffer: buf, bytes: buf.byteLength };
}

function projectOversizedEventToGap(
  seq: number,
  attentionSeq: number,
  envelope: EventEnvelope,
  lineBytes: number,
  epoch: string,
): JournalGapEntry {
  const routing = extractEnvelopeRouting(envelope);
  return {
    kind: 'gap',
    seq,
    attentionSeq,
    eventType: envelope.type,
    agentId: routing.agentId,
    routingKnown: routing.routingKnown,
    omittedBytesAtLeast: lineBytes,
    reason: 'legacy_oversized_line',
    ...(routing.rosterHint !== undefined ? { rosterHint: routing.rosterHint } : {}),
    epoch: envelope.epoch ?? epoch,
    ...(envelope.session_id !== undefined ? { sessionId: envelope.session_id } : {}),
  };
}

function trimRetainedEntries(
  entries: readonly RetainedJournalEntry[],
  capacity: number,
  maxRetainedBytes: number,
): { entries: RetainedJournalEntry[]; bytes: number } {
  if (capacity === 0 || maxRetainedBytes === 0 || entries.length === 0) {
    return { entries: [], bytes: 0 };
  }
  const floor = Math.max(0, entries.length - capacity);
  let bytes = 0;
  let kept = 0;
  for (let index = entries.length - 1; index >= floor; index -= 1) {
    const entry = entries[index]!;
    if (bytes + entry.bytes > maxRetainedBytes) break;
    bytes += entry.bytes;
    kept += 1;
  }
  return { entries: entries.slice(entries.length - kept), bytes };
}

async function writevBuffers(
  file: FileHandle,
  buffers: readonly Buffer[],
  startPos: number,
  onBatchBytes?: (bytes: number) => void,
): Promise<number> {
  let pos = startPos;
  let totalWritten = 0;
  let idx = 0;
  let partialOffset = 0;

  while (idx < buffers.length) {
    const iovs: Buffer[] = [];
    let batchBytes = 0;

    while (idx < buffers.length && iovs.length < WRITEV_MAX_IOVS && batchBytes < WRITEV_MAX_BYTES) {
      const current = buffers[idx]!;
      const available = current.byteLength - partialOffset;
      if (available <= 0) {
        idx += 1;
        partialOffset = 0;
        continue;
      }
      const room = WRITEV_MAX_BYTES - batchBytes;
      if (available <= room) {
        const slice = partialOffset === 0 ? current : current.subarray(partialOffset);
        iovs.push(slice);
        batchBytes += slice.byteLength;
        idx += 1;
        partialOffset = 0;
      } else {
        if (iovs.length === 0) {
          const slice = current.subarray(partialOffset, partialOffset + room);
          iovs.push(slice);
          batchBytes += slice.byteLength;
          partialOffset += room;
        }
        break;
      }
    }

    if (iovs.length === 0) continue;
    onBatchBytes?.(batchBytes);

    let pendingIovs = iovs;
    while (pendingIovs.length > 0) {
      const result = await file.writev(pendingIovs, pos);
      const written = result.bytesWritten;
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error('event journal writev made zero progress');
      }
      pos += written;
      totalWritten += written;

      let consume = written;
      let nextStart = 0;
      let partialHead: Buffer | undefined;
      while (nextStart < pendingIovs.length && consume > 0) {
        const piece = pendingIovs[nextStart]!;
        if (consume >= piece.byteLength) {
          consume -= piece.byteLength;
          nextStart += 1;
        } else {
          partialHead = piece.subarray(consume);
          consume = 0;
          break;
        }
      }
      if (partialHead !== undefined) {
        pendingIovs = [partialHead, ...pendingIovs.slice(nextStart + 1)];
      } else {
        pendingIovs = pendingIovs.slice(nextStart);
      }
    }
  }

  return totalWritten;
}

async function recoverWriteBoundary(
  file: FileHandle,
  beforeDev: number | bigint,
  beforeIno: number | bigint,
  beforeSize: number,
): Promise<boolean> {
  try {
    const afterStat = await file.stat({ bigint: true });
    if (afterStat.dev !== beforeDev || afterStat.ino !== beforeIno) return false;
    const afterSize = Number(afterStat.size);
    if (afterSize < beforeSize) return false;
    if (afterSize === beforeSize) return true;
    await file.truncate(beforeSize);
    const verifiedStat = await file.stat({ bigint: true });
    return (
      verifiedStat.dev === beforeDev &&
      verifiedStat.ino === beforeIno &&
      Number(verifiedStat.size) === beforeSize
    );
  } catch {
    return false;
  }
}

async function verifyTailAndRetrySync(
  filePath: string,
  expectedDev: number | bigint,
  expectedIno: number | bigint,
  expectedSize: number,
  expectedTailBuf: Buffer,
): Promise<boolean> {
  try {
    const file = await open(filePath, constants.O_RDWR);
    try {
      const st = await file.stat({ bigint: true });
      if (st.dev !== expectedDev || st.ino !== expectedIno || Number(st.size) !== expectedSize) {
        return false;
      }
      const tailLen = Math.min(4096, expectedTailBuf.byteLength, expectedSize);
      if (tailLen > 0) {
        const actual = Buffer.allocUnsafe(tailLen);
        const { bytesRead } = await file.read(actual, 0, tailLen, expectedSize - tailLen);
        if (bytesRead !== tailLen) return false;
        const expectedSlice = expectedTailBuf.subarray(expectedTailBuf.byteLength - tailLen);
        if (!actual.equals(expectedSlice)) return false;
      }
      await file.sync();
      return true;
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

async function replaceJournalBuffers(
  filePath: string,
  buffers: readonly Buffer[],
  onBatchBytes?: (bytes: number) => void,
): Promise<number> {
  const temporary = `${filePath}.tmp.${ulid()}`;
  let written = 0;
  try {
    const file = await open(temporary, 'wx');
    try {
      written = await writevBuffers(file, buffers, 0, onBatchBytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
    if (process.platform !== 'win32') {
      try {
        const parent = await open(dirname(filePath), 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } catch {
      }
    }
    return written;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Remove expired inactive session event journals and stale temp files from `eventsDir`. */
export async function pruneExpiredEventJournals(
  eventsDir: string,
  options?: {
    readonly maxAgeMs?: number;
    readonly activeSessionIds?: ReadonlySet<string>;
    readonly isSessionActive?: (sessionId: string) => boolean;
    readonly beforeUnlink?: (sessionId: string) => (() => void) | undefined;
    readonly now?: number;
    readonly logger?: JournalLogger;
  },
): Promise<number> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_STALE_JOURNAL_TTL_MS;
  const activeSessionIds = options?.activeSessionIds;
  const isSessionActive = options?.isSessionActive;
  const beforeUnlink = options?.beforeUnlink;
  const now = options?.now ?? Date.now();
  const logger = options?.logger ?? noopLogger;
  let entries;
  try {
    entries = await readdir(eventsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    logger.warn({ eventsDir, err: String(error) }, 'event journal cleanup scan failed');
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const isTemp = name.includes('.jsonl.tmp.');
    const isJournal = !isTemp && name.endsWith('.jsonl');
    if (!isTemp && !isJournal) continue;
    const sessionId = isJournal
      ? name.slice(0, -'.jsonl'.length)
      : name.slice(0, name.indexOf('.jsonl.tmp.'));
    if (
      isJournal &&
      (sessionId === '_global' ||
        activeSessionIds?.has(sessionId) === true ||
        isSessionActive?.(sessionId) === true)
    ) {
      continue;
    }
    const fullPath = join(eventsDir, name);
    try {
      const info = await stat(fullPath);
      const ttl = isTemp ? STALE_TEMP_JOURNAL_TTL_MS : maxAgeMs;
      if (now - info.mtimeMs < ttl) continue;
      if (isJournal && (activeSessionIds?.has(sessionId) === true || isSessionActive?.(sessionId) === true)) {
        continue;
      }
      let release: (() => void) | undefined;
      if (isJournal && beforeUnlink !== undefined) {
        release = beforeUnlink(sessionId);
        if (release === undefined) continue;
      }
      try {
        await rm(fullPath, { force: true });
        removed += 1;
      } finally {
        release?.();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ filePath: fullPath, err: String(error) }, 'event journal cleanup failed');
      }
    }
  }
  return removed;
}

/** Default per-session journal path under `<eventsDir>/<sessionId>.jsonl`. */
export function sessionJournalPath(eventsDir: string, sessionId: string): string {
  return join(eventsDir, `${sessionId}.jsonl`);
}

/**
 * Remove derived v2 gap-bearing event journals from `<eventsDir>` before an
 * intentional binary downgrade, without ever touching canonical session wires.
 */
export async function prepareEventsDirForDowngrade(
  eventsDir: string,
  logger: JournalLogger = noopLogger,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(eventsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const fullPath = join(eventsDir, name);
    try {
      const wm = await readWatermark(fullPath);
      if (!wm.headerIsV2 && !wm.hasGaps) continue;
      await rm(fullPath, { force: true });
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ filePath: fullPath, err: String(error) }, 'event journal downgrade cleanup failed');
      }
    }
  }
  return removed;
}

function nonNegativeSafeInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function explicitAttentionSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resolveRecordAttention(
  seq: number,
  explicit: number | undefined,
  eventType: string,
  priorAttention: number,
): number {
  if (explicit !== undefined) return Math.max(priorAttention, explicit);
  if (isAttentionEventType(eventType)) return Math.max(priorAttention, seq);
  return priorAttention;
}

type ParsedDiskLine =
  | JournalHeaderLine
  | {
      readonly kind: 'event';
      readonly seq: number;
      readonly attentionSeq?: number;
      readonly envelope: EventEnvelope;
    }
  | {
      readonly kind: 'gap';
      readonly gap: JournalGapEntry;
      readonly explicitAttention: boolean;
    };

function parseJournalLine(raw: string): ParsedDiskLine | undefined {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const kind = rec['kind'];
  if (kind === 'journal_header' || kind === 'journal_header_v2') {
    const epoch = rec['epoch'];
    const version = rec['version'];
    if (typeof epoch !== 'string' || epoch.length === 0) return undefined;
    if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > JOURNAL_VERSION)) {
      return undefined;
    }
    return value as JournalHeaderLine;
  }
  if (kind === 'event') {
    const seq = rec['seq'];
    const envelope = rec['envelope'];
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
    if (typeof envelope !== 'object' || envelope === null) return undefined;
    const envType = (envelope as { type?: unknown }).type;
    if (typeof envType !== 'string' || envType.length === 0) return undefined;
    return {
      kind: 'event',
      seq,
      attentionSeq: explicitAttentionSeq(rec['attention_seq']),
      envelope: envelope as EventEnvelope,
    };
  }
  if (kind === 'gap') {
    const seq = rec['seq'];
    const eventType = rec['event_type'];
    const reason = rec['reason'];
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
    if (typeof eventType !== 'string' || eventType.length === 0) return undefined;
    if (typeof reason !== 'string' || reason.length === 0) return undefined;
    const fromSeqRaw = rec['from_seq'];
    const fromSeq =
      typeof fromSeqRaw === 'number' && Number.isSafeInteger(fromSeqRaw) && fromSeqRaw > 0 && fromSeqRaw <= seq
        ? fromSeqRaw
        : undefined;
    const att = explicitAttentionSeq(rec['attention_seq']);
    const routingKnown = rec['routing_known'] === true;
    const rawAgentId = rec['agent_id'];
    const agentId = typeof rawAgentId === 'string' ? rawAgentId : null;
    const rosterHint = parseRosterHint(rec['roster_hint']);
    const gap: JournalGapEntry = {
      kind: 'gap',
      seq,
      ...(fromSeq !== undefined ? { fromSeq } : {}),
      attentionSeq: att ?? (isAttentionEventType(eventType) ? seq : 0),
      eventType,
      agentId: routingKnown ? agentId : null,
      routingKnown,
      omittedBytesAtLeast: nonNegativeSafeInt(rec['omitted_bytes_at_least']),
      reason: reason as JournalGapReason,
      ...(rosterHint !== undefined ? { rosterHint } : {}),
      ...(typeof rec['epoch'] === 'string' && rec['epoch'].length > 0 ? { epoch: rec['epoch'] } : {}),
      ...(typeof rec['session_id'] === 'string' && rec['session_id'].length > 0 ? { sessionId: rec['session_id'] } : {}),
    };
    return { kind: 'gap', gap, explicitAttention: att !== undefined };
  }
  return undefined;
}

function parseRosterHint(raw: unknown): JournalRosterHint | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['type'] !== 'string' || rec['type'].length === 0) return undefined;
  const required = rec['required'] === true;
  return {
    required,
    type: rec['type'],
    ...(typeof rec['agentId'] === 'string' ? { agentId: rec['agentId'] } : {}),
    ...(typeof rec['subagentId'] === 'string' ? { subagentId: rec['subagentId'] } : {}),
    ...(typeof rec['infoKind'] === 'string' ? { infoKind: rec['infoKind'] } : {}),
    ...(typeof rec['infoAgentId'] === 'string' ? { infoAgentId: rec['infoAgentId'] } : {}),
  };
}

function projectStreamingMetaToParsedLine(
  meta: StreamingParsedJournalLine | undefined,
  lineBytes: number,
): ParsedDiskLine | undefined {
  if (meta === undefined) return undefined;
  if (meta.kind === 'journal_header' || meta.kind === 'journal_header_v2') {
    if (typeof meta.epoch !== 'string' || meta.epoch.length === 0) return undefined;
    if (
      meta.version !== undefined &&
      (!Number.isInteger(meta.version) || meta.version < 1 || meta.version > JOURNAL_VERSION)
    ) {
      return undefined;
    }
    return {
      kind: meta.kind,
      version: meta.version ?? (meta.kind === 'journal_header_v2' ? 2 : 1),
      epoch: meta.epoch,
      created_at: typeof meta.created_at === 'number' ? meta.created_at : 0,
      ...(meta.last_seq !== undefined ? { last_seq: meta.last_seq } : {}),
      ...(meta.attention_seq !== undefined ? { attention_seq: meta.attention_seq } : {}),
      ...(meta.kind === 'journal_header_v2' ? { has_gaps: true } : {}),
    };
  }
  if (meta.kind === 'event') {
    const seq = meta.seq;
    const env = meta.envelope;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
    if (env === undefined || typeof env.type !== 'string' || env.type.length === 0) return undefined;
    if (env.seq !== undefined && env.seq !== seq) return undefined;
    const att = explicitAttentionSeq(meta.attention_seq);
    const routingKnown = env.payloadAgentIdOverflowed !== true;
    const agentId = env.payloadAgentId !== undefined ? env.payloadAgentId : null;
    const rosterHint = routingKnown
      ? extractRosterHintFromFields(
          env.type,
          agentId,
          env.payloadSubagentId,
          env.payloadInfoKind,
          env.payloadInfoAgentId,
        )
      : undefined;
    const gap: JournalGapEntry = {
      kind: 'gap',
      seq,
      attentionSeq: att ?? (isAttentionEventType(env.type) ? seq : 0),
      eventType: env.type,
      agentId: routingKnown ? agentId : null,
      routingKnown,
      omittedBytesAtLeast: lineBytes,
      reason: 'legacy_oversized_line',
      ...(rosterHint !== undefined ? { rosterHint } : {}),
      ...(env.epoch !== undefined && env.epoch.length > 0 ? { epoch: env.epoch } : {}),
      ...(env.session_id !== undefined && env.session_id.length > 0 ? { sessionId: env.session_id } : {}),
    };
    return { kind: 'gap', gap, explicitAttention: att !== undefined };
  }
  if (meta.kind === 'gap') {
    const seq = meta.seq;
    const eventType = meta.event_type;
    const reason = meta.reason;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
    if (typeof eventType !== 'string' || eventType.length === 0) return undefined;
    if (typeof reason !== 'string' || reason.length === 0) return undefined;
    const att = explicitAttentionSeq(meta.attention_seq);
    const routingKnown = meta.routing_known === true;
    const fromSeq =
      typeof meta.from_seq === 'number' && Number.isSafeInteger(meta.from_seq) && meta.from_seq > 0 && meta.from_seq <= seq
        ? meta.from_seq
        : undefined;
    const gap: JournalGapEntry = {
      kind: 'gap',
      seq,
      ...(fromSeq !== undefined ? { fromSeq } : {}),
      attentionSeq: att ?? (isAttentionEventType(eventType) ? seq : 0),
      eventType,
      agentId: routingKnown ? (meta.agent_id ?? null) : null,
      routingKnown,
      omittedBytesAtLeast: Math.max(nonNegativeSafeInt(meta.omitted_bytes_at_least), lineBytes),
      reason: reason as JournalGapReason,
      ...(meta.epoch !== undefined && meta.epoch.length > 0 ? { epoch: meta.epoch } : {}),
      ...(meta.session_id !== undefined && meta.session_id.length > 0 ? { sessionId: meta.session_id } : {}),
    };
    return { kind: 'gap', gap, explicitAttention: att !== undefined };
  }
  return undefined;
}

async function readExactRange(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const res = await file.read(buf, offset, length - offset, start + offset);
    if (res.bytesRead === 0) throw new Error('event journal changed during bounded read');
    offset += res.bytesRead;
  }
  return buf;
}

async function parseOversizedLineRange(
  file: FileHandle,
  start: number,
  end: number,
): Promise<ParsedDiskLine | undefined> {
  const parser = new StreamingJournalLineParser();
  const chunkBuf = Buffer.allocUnsafe(WATERMARK_READ_BYTES);
  let pos = start;
  while (pos < end) {
    const toRead = Math.min(WATERMARK_READ_BYTES, end - pos);
    const res = await file.read(chunkBuf, 0, toRead, pos);
    if (res.bytesRead === 0) return undefined;
    if (!parser.feed(chunkBuf.subarray(0, res.bytesRead))) return undefined;
    pos += res.bytesRead;
  }
  return projectStreamingMetaToParsedLine(parser.finish(), end - start + 1);
}

async function findLineStartReverse(file: FileHandle, lineEndExclusive: number): Promise<number> {
  const scratch = Buffer.allocUnsafe(WATERMARK_READ_BYTES);
  let pos = lineEndExclusive;
  while (pos > 0) {
    const length = Math.min(pos, WATERMARK_READ_BYTES);
    pos -= length;
    let offset = 0;
    while (offset < length) {
      const res = await file.read(scratch, offset, length - offset, pos + offset);
      if (res.bytesRead === 0) throw new Error('event journal changed during reverse scan');
      offset += res.bytesRead;
    }
    const nl = scratch.subarray(0, length).lastIndexOf(10);
    if (nl >= 0) return pos + nl + 1;
  }
  return 0;
}

type ReverseLineResult =
  | { readonly kind: 'journal_header'; readonly header: JournalHeaderLine; readonly prevEnd: number }
  | {
      readonly kind: 'event';
      readonly seq: number;
      readonly attentionSeq: number;
      readonly explicitAttention: boolean;
      readonly envelope: EventEnvelope;
      readonly buf: Buffer;
      readonly bytes: number;
      readonly prevEnd: number;
    }
  | {
      readonly kind: 'gap';
      readonly gap: JournalGapEntry;
      readonly explicitAttention: boolean;
      readonly oversizedSource: boolean;
      readonly buf?: Buffer;
      readonly prevEnd: number;
    }
  | { readonly kind: 'corrupt'; readonly prevEnd: number };

async function readSingleLineReverse(
  file: FileHandle,
  endExclusive: number,
  maxLineBytes: number,
): Promise<ReverseLineResult> {
  let end = endExclusive;
  if (end <= 0) return { kind: 'corrupt', prevEnd: 0 };
  const lineStart = await findLineStartReverse(file, end);
  const prevEnd = lineStart > 0 ? lineStart - 1 : 0;
  const lineLen = end - lineStart;
  if (lineLen === 0) return { kind: 'corrupt', prevEnd };

  if (lineLen + 1 <= maxLineBytes) {
    const rawBuf = await readExactRange(file, lineStart, lineLen);
    const parsed = parseJournalLine(rawBuf.toString('utf8'));
    if (parsed === undefined) return { kind: 'corrupt', prevEnd };
    if (parsed.kind === 'journal_header' || parsed.kind === 'journal_header_v2') {
      return { kind: 'journal_header', header: parsed, prevEnd };
    }
    const withLf = Buffer.allocUnsafe(lineLen + 1);
    rawBuf.copy(withLf, 0);
    withLf[lineLen] = 0x0a;
    if (parsed.kind === 'event') {
      const att = parsed.attentionSeq ?? (isAttentionEventType(parsed.envelope.type) ? parsed.seq : 0);
      return {
        kind: 'event',
        seq: parsed.seq,
        attentionSeq: att,
        explicitAttention: parsed.attentionSeq !== undefined,
        envelope: parsed.envelope,
        buf: withLf,
        bytes: withLf.byteLength,
        prevEnd,
      };
    }
    return {
      kind: 'gap',
      gap: parsed.gap,
      explicitAttention: parsed.explicitAttention,
      oversizedSource: false,
      buf: withLf,
      prevEnd,
    };
  }

  const parsed = await parseOversizedLineRange(file, lineStart, end);
  if (parsed === undefined) return { kind: 'corrupt', prevEnd };
  if (parsed.kind === 'journal_header' || parsed.kind === 'journal_header_v2') {
    return { kind: 'journal_header', header: parsed, prevEnd };
  }
  if (parsed.kind === 'gap') {
    return {
      kind: 'gap',
      gap: parsed.gap,
      explicitAttention: parsed.explicitAttention,
      oversizedSource: true,
      prevEnd,
    };
  }
  return { kind: 'corrupt', prevEnd };
}

type StreamedForwardRecord =
  | JournalHeaderLine
  | {
      readonly kind: 'event';
      readonly seq: number;
      readonly attentionSeq?: number;
      readonly envelope: EventEnvelope;
    }
  | JournalGapEntry
  | { readonly kind: 'corrupt' };

async function* streamJournalRecordsForward(
  filePath: string,
  maxLineBytes: number,
): AsyncIterable<StreamedForwardRecord> {
  const file = await open(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(WATERMARK_READ_BYTES);
    let lineChunks: Buffer[] = [];
    let lineLen = 0;
    let oversizedParser: StreamingJournalLineParser | undefined;

    const flushCurrentLine = (): StreamedForwardRecord | undefined => {
      if (oversizedParser !== undefined) {
        const finished = projectStreamingMetaToParsedLine(oversizedParser.finish(), lineLen + 1);
        oversizedParser = undefined;
        lineChunks = [];
        lineLen = 0;
        if (finished === undefined) return { kind: 'corrupt' };
        if (finished.kind === 'journal_header' || finished.kind === 'journal_header_v2') return finished;
        if (finished.kind === 'gap') return finished.gap;
        return finished;
      }
      if (lineLen === 0) return undefined;
      const buf = lineChunks.length === 1 ? lineChunks[0]! : Buffer.concat(lineChunks, lineLen);
      lineChunks = [];
      lineLen = 0;
      const parsed = parseJournalLine(buf.toString('utf8'));
      if (parsed === undefined) return { kind: 'corrupt' };
      if (parsed.kind === 'journal_header' || parsed.kind === 'journal_header_v2') return parsed;
      if (parsed.kind === 'gap') return parsed.gap;
      return parsed;
    };

    const appendSegment = (segment: Buffer): void => {
      if (segment.byteLength === 0) return;
      lineLen += segment.byteLength;
      if (oversizedParser !== undefined) {
        oversizedParser.feed(segment);
        return;
      }
      if (lineLen + 1 > maxLineBytes) {
        oversizedParser = new StreamingJournalLineParser();
        for (const prev of lineChunks) {
          oversizedParser.feed(prev);
        }
        lineChunks = [];
        oversizedParser.feed(segment);
        return;
      }
      const copy = Buffer.allocUnsafe(segment.byteLength);
      segment.copy(copy, 0);
      lineChunks.push(copy);
    };

    let position = 0;
    for (;;) {
      const res = await file.read(chunk, 0, WATERMARK_READ_BYTES, position);
      if (res.bytesRead === 0) break;
      position += res.bytesRead;
      const view = chunk.subarray(0, res.bytesRead);
      let start = 0;
      while (start < view.byteLength) {
        const nl = view.indexOf(10, start);
        if (nl === -1) {
          appendSegment(view.subarray(start));
          break;
        }
        appendSegment(view.subarray(start, nl));
        const emitted = flushCurrentLine();
        if (emitted !== undefined) yield emitted;
        start = nl + 1;
      }
    }
    if (lineLen > 0 || oversizedParser !== undefined) {
      yield { kind: 'corrupt' };
    }
  } finally {
    await file.close();
  }
}

async function findLastNewlineBefore(file: FileHandle, endExclusive: number): Promise<number> {
  const chunk = Buffer.allocUnsafe(WATERMARK_READ_BYTES);
  let pos = endExclusive;
  while (pos > 0) {
    const start = Math.max(0, pos - WATERMARK_READ_BYTES);
    const len = pos - start;
    let got = 0;
    while (got < len) {
      const res = await file.read(chunk, got, len - got, start + got);
      if (res.bytesRead === 0) return -1;
      got += res.bytesRead;
    }
    const idx = chunk.subarray(0, got).lastIndexOf(10);
    if (idx >= 0) return start + idx;
    pos = start;
  }
  return -1;
}

interface ReadWatermarkResult {
  epoch: string | undefined;
  lastSeq: number;
  attentionSeq: number;
  sawAnyLine: boolean;
  hasGaps: boolean;
  headerIsV2: boolean;
}

async function readWatermarkWithTransientRetry(filePath: string): Promise<ReadWatermarkResult> {
  let attempt = 0;
  for (;;) {
    try {
      return await readWatermark(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!isTransientReadError(code) || attempt >= TRANSIENT_OPEN_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delayMs = TRANSIENT_OPEN_RETRY_DELAYS_MS[attempt]!;
      attempt += 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

async function readWatermark(filePath: string): Promise<ReadWatermarkResult> {
  const file = await open(filePath, 'r');
  let fast: ReadWatermarkResult | undefined;
  try {
    const { size } = await file.stat();
    if (size === 0) {
      return { epoch: undefined, lastSeq: 0, attentionSeq: 0, sawAnyLine: false, hasGaps: false, headerIsV2: false };
    }
    const headSize = Math.min(size, WATERMARK_READ_BYTES);
    const head = Buffer.allocUnsafe(headSize);
    const headRead = await file.read(head, 0, headSize, 0);
    const headSlice = head.subarray(0, headRead.bytesRead);
    const headerEnd = headSlice.indexOf(10);
    const header =
      headerEnd >= 0
        ? parseJournalLine(headSlice.subarray(0, headerEnd).toString('utf8'))
        : undefined;

    if (header?.kind === 'journal_header' || header?.kind === 'journal_header_v2') {
      const headerIsV2 = header.kind === 'journal_header_v2';
      let hasGaps = headerIsV2 || header.has_gaps === true;
      const tailStart = Math.max(0, size - WATERMARK_READ_BYTES);
      const tailLen = size - tailStart;
      const tail = Buffer.allocUnsafe(tailLen);
      let readTotal = 0;
      while (readTotal < tailLen) {
        const r = await file.read(tail, readTotal, tailLen - readTotal, tailStart + readTotal);
        if (r.bytesRead === 0) break;
        readTotal += r.bytesRead;
      }
      let end = readTotal;
      let lastSeq = 0;
      let attentionSeq = 0;
      let attentionResolved = false;
      let prevSeq = Number.POSITIVE_INFINITY;
      let valid = true;
      let reverseResumeOffset = size;

      if (end > 0 && tail[end - 1] !== 10) {
        const lastLf = tail.lastIndexOf(10, end - 1);
        if (lastLf >= 0) {
          end = lastLf + 1;
          reverseResumeOffset = tailStart + end;
        } else {
          const earlierLf = await findLastNewlineBefore(file, tailStart);
          end = 0;
          reverseResumeOffset = Math.max(earlierLf, 0);
        }
      }

      while (end > 0) {
        if (tail[end - 1] === 10) end -= 1;
        if (end === 0) {
          reverseResumeOffset = tailStart;
          break;
        }
        const separator = tail.lastIndexOf(10, end - 1);
        if (separator < 0 && tailStart > 0) {
          reverseResumeOffset = tailStart + end;
          break;
        }
        const line = tail.subarray(separator + 1, end);
        const parsed = parseJournalLine(line.toString('utf8'));
        if (parsed === undefined) {
          valid = false;
          break;
        }
        if (parsed.kind === 'event') {
          if (parsed.seq > prevSeq) {
            valid = false;
            break;
          }
          prevSeq = parsed.seq;
          lastSeq = Math.max(lastSeq, parsed.seq);
          if (parsed.attentionSeq !== undefined) {
            attentionSeq = Math.max(attentionSeq, parsed.attentionSeq);
            attentionResolved = true;
          } else if (isAttentionEventType(parsed.envelope.type)) {
            attentionSeq = Math.max(attentionSeq, parsed.seq);
            attentionResolved = true;
          }
        } else if (parsed.kind === 'gap') {
          hasGaps = true;
          if (parsed.gap.seq > prevSeq) {
            valid = false;
            break;
          }
          prevSeq = parsed.gap.fromSeq ?? parsed.gap.seq;
          lastSeq = Math.max(lastSeq, parsed.gap.seq);
          if (parsed.explicitAttention) {
            attentionSeq = Math.max(attentionSeq, parsed.gap.attentionSeq);
            attentionResolved = true;
          } else if (isAttentionEventType(parsed.gap.eventType)) {
            attentionSeq = Math.max(attentionSeq, parsed.gap.seq);
            attentionResolved = true;
          }
        } else if (tailStart > 0 || parsed.epoch !== header.epoch) {
          valid = false;
          break;
        } else {
          attentionResolved = true;
        }
        end = separator + 1;
        reverseResumeOffset = tailStart + end;
      }

      if (valid && tailStart > 0 && (lastSeq === 0 || !attentionResolved)) {
        let cursor = reverseResumeOffset;
        while (cursor > 0 && (lastSeq === 0 || !attentionResolved)) {
          const line = await readSingleLineReverse(file, cursor, MAX_SINGLE_JOURNAL_LINE_BYTES);
          cursor = line.prevEnd;
          if (line.kind === 'journal_header') {
            if (line.header.epoch !== header.epoch) {
              valid = false;
            }
            attentionResolved = true;
            break;
          }
          if (line.kind === 'corrupt') {
            valid = false;
            break;
          }
          if (line.kind === 'event') {
            if (line.seq > prevSeq) {
              valid = false;
              break;
            }
            prevSeq = line.seq;
            lastSeq = Math.max(lastSeq, line.seq);
            if (line.explicitAttention) {
              attentionSeq = Math.max(attentionSeq, line.attentionSeq);
              attentionResolved = true;
            } else if (isAttentionEventType(line.envelope.type)) {
              attentionSeq = Math.max(attentionSeq, line.seq);
              attentionResolved = true;
            }
          } else {
            hasGaps = true;
            if (line.gap.seq > prevSeq) {
              valid = false;
              break;
            }
            prevSeq = line.gap.fromSeq ?? line.gap.seq;
            lastSeq = Math.max(lastSeq, line.gap.seq);
            if (line.explicitAttention) {
              attentionSeq = Math.max(attentionSeq, line.gap.attentionSeq);
              attentionResolved = true;
            } else if (isAttentionEventType(line.gap.eventType)) {
              attentionSeq = Math.max(attentionSeq, line.gap.seq);
              attentionResolved = true;
            }
          }
        }
      }

      if (valid && (lastSeq > 0 || tailStart === 0)) {
        const savedSeq = nonNegativeSafeInt(header.last_seq);
        const savedAttentionSeq = nonNegativeSafeInt(header.attention_seq);
        fast = {
          epoch: header.epoch,
          lastSeq: Math.max(lastSeq, savedSeq),
          attentionSeq: Math.max(attentionSeq, savedAttentionSeq),
          sawAnyLine: true,
          hasGaps,
          headerIsV2,
        };
      }
    }
  } finally {
    await file.close();
  }
  if (fast !== undefined) return fast;

  let epoch: string | undefined;
  let lastSeq = 0;
  let attentionSeq = 0;
  let sawAnyLine = false;
  let hasGaps = false;
  let headerIsV2 = false;
  for await (const parsed of streamJournalRecordsForward(filePath, MAX_SINGLE_JOURNAL_LINE_BYTES)) {
    sawAnyLine = true;
    if (parsed.kind === 'corrupt') continue;
    if ((parsed.kind === 'journal_header' || parsed.kind === 'journal_header_v2') && epoch === undefined) {
      epoch = parsed.epoch;
      headerIsV2 = parsed.kind === 'journal_header_v2';
      hasGaps = hasGaps || headerIsV2 || parsed.has_gaps === true;
      lastSeq = Math.max(lastSeq, nonNegativeSafeInt(parsed.last_seq));
      attentionSeq = Math.max(attentionSeq, nonNegativeSafeInt(parsed.attention_seq));
      continue;
    }
    if (parsed.kind === 'event') {
      lastSeq = Math.max(lastSeq, parsed.seq);
      attentionSeq = resolveRecordAttention(parsed.seq, parsed.attentionSeq, parsed.envelope.type, attentionSeq);
      continue;
    }
    if (parsed.kind === 'gap') {
      hasGaps = true;
      lastSeq = Math.max(lastSeq, parsed.seq);
      attentionSeq = resolveRecordAttention(parsed.seq, parsed.attentionSeq, parsed.eventType, attentionSeq);
    }
  }
  return { epoch, lastSeq, attentionSeq, sawAnyLine, hasGaps, headerIsV2 };
}

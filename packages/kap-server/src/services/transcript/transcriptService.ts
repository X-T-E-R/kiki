import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { open, readFile, stat } from 'node:fs/promises';
import { scanColdWireMarkers } from '@kiki/agent-core-v2/persistence/coldSegmentLog';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';

import {
  AgentTaskPersistence,
  IAgentActivityView,
  IAtomicDocumentStore,
  IFileSystemStorageService,
  isError2,
  ErrorCodes,
  IAgentLifecycleService,
  IAgentPromptService,
  IConfigService,
  IFlagService,
  IQueryStore,
  ISessionIndex,
  ISessionInteractionService,
  ISessionMetadata,
  IWireService,
  agentScopeOf,
  followSessionLifecycles,
  getLiveSessionById,
  sessionScopeOf,
  workspacePersistenceScope,
  type AgentMeta,
  type AgentTaskInfo,
  type IAgentScopeHandle,
  type IDisposable,
  type Scope,
  type SessionMeta,
} from '@kiki/agent-core-v2';
import { StorageErrors } from '@kiki/agent-core-v2/persistence/interface/storage';
import {
  WIRE_TRANSCRIPT_RECEIPT_KEY,
  digestWireBytes,
  parseWireTranscriptReceipt,
  wireTailSha256,
  type WireTranscriptReceiptWire,
} from '@kiki/agent-core-v2/wire/transcriptReceipt';
import {
  AgentTranscript,
  AgentTranscriptDraft,
  compareTurnIds,
  TranscriptFactReducer,
  TranscriptStore,
  TranscriptWireAdapter,
  isPlainAgentId,
  transcriptResidentValueEquals,
  type AgentDescriptor,
  type AgentTranscriptSnapshot,
  type DurableTurnReleaseGlobals,
  type TranscriptAttachment,
  type TranscriptChangeEvent,
  type TranscriptCursor,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptPrompt,
  type TranscriptResidentLimits,
  type TranscriptWireAdapterCheckpoint,
  type TranscriptWireRecordPosition,
  type ToolCallFrame,
  type ToolCountSetOp,
  type TranscriptTask,
  type TranscriptTaskRef,
  type TranscriptTodo,
  type TranscriptTurn,
  type ContentSource,
} from '@kiki/transcript';

import {
  bindSessionTranscript,
  descriptorFromMeta,
  type ContextRecord,
  WIRE_COLD_READ_MAX_BYTES,
  WIRE_COLD_READ_MAX_LINE_BYTES,
  WIRE_COLD_READ_MAX_RECORDS,
  WIRE_READ_CHUNK_BYTES,
  type TranscriptBinding,
  type TranscriptBindingLogger,
  type TranscriptReplayState,
  type WireRecordsIncompleteReason,
  type WireRecordsStreamOptions,
  type WireRecordsStreamResult,
} from '@kiki/transcript-live';

import type { HistoryLocatorStore } from '../history/historyLocatorStore';
import { openLogicalWire, streamLogicalWireRecords } from '../history/logicalWireRead';
import { historyNavigationProof, matchesNavigationProof } from '../history/historyNavigationProof';
import { CanonicalEntityPreparingError, type CanonicalToolLookup, type ResidentProofFailure, type ResidentTurnProofResult } from '../history/historyCanonicalReader';

import {
  readWireRecordsBounded,
  type BoundedWireScanOptions,
} from './boundedWireScan';
import {
  DEFAULT_TRANSCRIPT_MEMORY_CONFIG,
  TRANSCRIPT_MEMORY_SECTION,
  TRANSCRIPT_RESIDENT_WINDOW_FLAG_ID,
  type TranscriptMemoryConfig,
} from './configSection';
import { HistoryReadLane } from './historyReadLane';
import {
  captureWirePrefixWitness,
  createYieldBudget,
  rangeHasHardClear,
  verifyWitnessAppendSafe,
  WIRE_YIELD_BUDGET_MS,
  wireExactFingerprint,
  wrapYieldingRecordCallback,
  yieldIfTimeBudgetExceeded,
  type WireFileStat,
  type WirePrefixWitness,
} from './prefixWitness';
import {
  estimateResidentTurnBytes,
  estimateResidentValueBytes,
  failureSetSignature,
  ResidencyMaintenanceScheduler,
  wireFingerprintForMaintenance,
  type AgentResidencyState,
} from './residencyMaintenance';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';
const MAIN_AGENT_ID = 'main';
const WIRE_FILE = 'wire.jsonl';
const STATE_FILE = 'state.json';
const TRANSCRIPT_CHECKPOINT_COLLECTION = '__transcript_projection_checkpoint__';
const TRANSCRIPT_CHECKPOINT_FORMAT = 31;
const TRANSCRIPT_CHECKPOINT_MIN_RECORDS = 256;
const TRANSCRIPT_CHECKPOINT_MAX_WIRE_BYTES = 8 << 20;
const OPS_JOURNAL_COMPACT_MIN_HEAD = 1024;
const OPS_JOURNAL_ESTIMATE_NODE_OVERHEAD_BYTES = 64;
const OPS_JOURNAL_ESTIMATE_SCALAR_BYTES = 8;
const OPS_JOURNAL_ESTIMATE_MAX_DEPTH = 24;
const DEFAULT_TOOL_CALL_COUNT_MAX_BYTES = 32 << 20;
const DEFAULT_TOOL_CALL_COUNT_MAX_FILES = 64;
const DEFAULT_TOOL_CALL_COUNT_CACHE_ENTRIES = 256;
const DEFAULT_TOOL_CALL_COUNT_CACHE_BYTES = 8 << 20;
const DEFAULT_TOOL_CALL_COUNT_READ_CHUNK_BYTES = 64 << 10;
const VERIFIED_WIRE_RECEIPT_CACHE_MAX_ENTRIES = 512;
const VERIFIED_WIRE_RECEIPT_CACHE_MAX_BYTES = 1 << 20;
const COLD_SNAPSHOT_CACHE_TTL_MS = 15_000;
const COLD_SNAPSHOT_CACHE_MAX_BYTES = 4 << 20;
const RETAINED_COLD_TURNS_BYTES = 1024 * 1024;
const RETAINED_COLD_TURN_ENTRY_BYTES = 8 << 20;
const RETAINED_COLD_TURNS_MAX_TOTAL_BYTES = 8 << 20;
const COLD_SNAPSHOT_CACHE_MAX_ENTRIES = 32;
const COLD_ROSTER_CACHE_MAX_ENTRIES = 32;
const FIRST_SCREEN_WINDOW_BYTES = 1 << 20;
const FIRST_SCREEN_WINDOW_MAX_BYTES = 8 << 20;
const FIRST_SCREEN_CHUNK_BYTES = 512 << 10;
const LOOP_EVENT_LINE_PREFIX = Buffer.from('{"type":"context.append_loop_event",');
const APPEND_MESSAGE_LINE_PREFIX = Buffer.from('{"type":"context.append_message",');
const TURN_ID_KEY_NEEDLE = Buffer.from('"turnId":');
const ROLE_KEY_NEEDLE = Buffer.from('"role":');
const HOOK_RESULT_NEEDLE = Buffer.from('"hook_result"');
const DELIVERY_NEEDLE = Buffer.from('"delivery"');
const TOOL_CALL_ID_NEEDLE = Buffer.from('"toolCallId":');
const TOOL_CALL_ID_SNAKE_NEEDLE = Buffer.from('"tool_call_id":');
const TOOL_CALLS_NEEDLE = Buffer.from('"toolCalls"');
const DEFAULT_DIRECT_TURN_MAX_BYTES = 64 << 20;
const DEFAULT_COLD_TURN_SPAN_MAX_TURNS = 16_384;
const DEFAULT_COLD_TURN_SPAN_MAX_WIRES = 32;
const DEFAULT_COLD_TOOL_TURN_IDS_MAX_PER_WIRE = 32_768;
const DEFAULT_COMPACT_TURN_LOOP_BYTES = 32 << 10;
const DEFAULT_COMPACT_TURNS_RESERVE_BYTES = 1 << 20;
const COLD_TURN_SPAN_PRE_RECORD_MAX_GAP_BYTES = 256 << 10;
const LIVE_EPOCH_VERIFY_WAIT_MS = 1_500;
const COLD_WIRE_WINDOW_MAX_BYTES = FIRST_SCREEN_WINDOW_MAX_BYTES;
const COLD_WIRE_WINDOWS_MAX_TOTAL_BYTES = 32 << 20;
const COLD_WIRE_WINDOWS_MAX_ENTRIES = 4;
const UNVERIFIED_RESIDENT_MAX_BYTES = 4 << 20;
const UNVERIFIED_RESIDENT_MAX_AGENTS = 16;
const TURN_START_INDEX_MAX_WIRES = 64;
const ANCHOR_OPENING_MAX_RECORDS = 8;
const ANCHOR_PROXIMITY_MAX_TURN_GAP = 64;
const ANCHOR_PROXIMITY_MAX_BYTES = 4 << 20;
const ANCHOR_PROXIMITY_MAX_RECORDS = 16_384;
const PROXIMITY_MISS_MAX_ENTRIES = 128;
const COLD_TODOS_CACHE_MAX_ENTRIES = 64;
const VALID_PERSISTED_TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;
const VALID_OUTCOME_REF = /^agent-outcomes\/[a-f0-9-]+\.json$/;
const PERSISTED_TASK_SUMMARY_MAX_BYTES = 4 << 20;
const PERSISTED_TASK_OUTPUT_TAIL_BYTES = 4 * 1024;
const WINDOW_OPAQUE_RECORDS = [
  'llm.request',
  'profile.dynamic_snapshot',
  'llm.tools_snapshot',
  'hook.step.prepared',
  'staleGuard.recorded',
  'plugin.session_start',
  'context_rebuild.reported',
  'auto_compact.override_changed',
  'todo.continuity_decision',
  'task.waitDelivered',
].map(type => ({
  prefix: Buffer.from(`{"type":"${type}",`), record: { type },
}));
const TODO_RELEVANT_PREFIXES = [
  'tools.update_store',
  'executor.plan.update',
  'executor.plan.remove',
].map(type => Buffer.from(`{"type":"${type}"`));
const INIT_RELEVANT_PREFIXES = [
  'metadata',
  'runtime.set_binding',
].map(type => Buffer.from(`{"type":"${type}"`));
const RECORD_JSON_HEAD = Buffer.from('{"type":"');
const TODO_PREFIX_MAX = Math.max(
  RECORD_JSON_HEAD.length,
  ...TODO_RELEVANT_PREFIXES.map(prefix => prefix.length),
  ...INIT_RELEVANT_PREFIXES.map(prefix => prefix.length),
);
const TODO_NOOP_RECORD: ContextRecord = { type: 'noop' };
const coldRecordBytesCache = new WeakMap<object, number>();

function hasClosedJsonObjectFrame(line: Buffer): boolean {
  const end = line.length > 0 && line.at(-1) === 0x0d ? line.length - 1 : line.length;
  return end >= 2 && line[end - 1] === 0x7d;
}

function readJsonQuotedAscii(buf: Buffer, start: number, limit: number): string | undefined {
  let cursor = start;
  while (cursor < limit && (buf[cursor] === 0x20 || buf[cursor] === 0x09)) cursor += 1;
  if (cursor >= limit || buf[cursor] !== 0x22) return undefined;
  cursor += 1;
  const valueStart = cursor;
  while (cursor < limit) {
    const byte = buf[cursor]!;
    if (byte === 0x5c) return undefined;
    if (byte === 0x22) return cursor > valueStart ? buf.toString('ascii', valueStart, cursor) : undefined;
    cursor += 1;
  }
  return undefined;
}

function extractTurnIdFromBuffer(buf: Buffer, maxScan: number): string | undefined {
  const limit = Math.min(buf.length, maxScan);
  const head = buf.subarray(0, limit);
  const idx = head.indexOf(TURN_ID_KEY_NEEDLE);
  if (idx < 0) return undefined;
  let cursor = idx + TURN_ID_KEY_NEEDLE.length;
  while (cursor < limit && (head[cursor] === 0x20 || head[cursor] === 0x09)) cursor += 1;
  if (cursor >= limit) return undefined;
  if (head[cursor] === 0x22) {
    const value = readJsonQuotedAscii(head, cursor, limit);
    if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
    const ordinal = Number(value);
    return Number.isSafeInteger(ordinal) && ordinal >= 0 ? `t${ordinal}` : undefined;
  }
  const digitStart = cursor;
  while (cursor < limit && head[cursor]! >= 0x30 && head[cursor]! <= 0x39) cursor += 1;
  if (cursor === digitStart) return undefined;
  const raw = head.toString('ascii', digitStart, cursor);
  if (raw.length > 1 && raw.codePointAt(0) === 0x30) return undefined;
  const ordinal = Number(raw);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? `t${ordinal}` : undefined;
}

function pushToolCallIdsFromSlice(slice: Buffer, turnId: string, out: Array<readonly [string, string]>): void {
  for (const needle of [TOOL_CALL_ID_NEEDLE, TOOL_CALL_ID_SNAKE_NEEDLE]) {
    let from = 0;
    while (from < slice.length) {
      const idx = slice.indexOf(needle, from);
      if (idx < 0) break;
      const value = readJsonQuotedAscii(slice, idx + needle.length, slice.length);
      if (value !== undefined) out.push([value, turnId]);
      from = idx + needle.length;
    }
  }
}

function extractLoopEventToolCallIdsFromBuffer(line: Buffer, turnId: string, out: Array<readonly [string, string]>): void {
  const headLimit = Math.min(line.length, 512);
  pushToolCallIdsFromSlice(line.subarray(0, headLimit), turnId, out);
  if (line.length > 512) {
    const tailStart = Math.max(headLimit, line.length - 256);
    pushToolCallIdsFromSlice(line.subarray(tailStart), turnId, out);
  }
}

function extractRoleFromBuffer(buf: Buffer, maxScan: number): 'tool' | 'assistant' | undefined {
  const limit = Math.min(buf.length, maxScan);
  const head = buf.subarray(0, limit);
  const idx = head.indexOf(ROLE_KEY_NEEDLE);
  if (idx < 0) return undefined;
  const value = readJsonQuotedAscii(head, idx + ROLE_KEY_NEEDLE.length, limit);
  if (value === 'tool' || value === 'assistant') return value;
  return undefined;
}

function transcriptOpaqueHeaderRecord(head: Buffer): ContextRecord | undefined {
  for (let index = 0; index < WINDOW_OPAQUE_RECORDS.length; index += 1) {
    const entry = WINDOW_OPAQUE_RECORDS[index]!;
    if (head.length >= entry.prefix.length && head.subarray(0, entry.prefix.length).equals(entry.prefix)) {
      return entry.record;
    }
  }
  return undefined;
}

function transcriptWindowRecord(line: Buffer): ContextRecord | undefined {
  if (!hasClosedJsonObjectFrame(line)) return undefined;
  return transcriptOpaqueHeaderRecord(line);
}

function transcriptTodoPrefixSkippable(head: Buffer, checkInit: boolean): boolean {
  if (head.length < RECORD_JSON_HEAD.length || !head.subarray(0, RECORD_JSON_HEAD.length).equals(RECORD_JSON_HEAD)) {
    return false;
  }
  for (let index = 0; index < TODO_RELEVANT_PREFIXES.length; index += 1) {
    const prefix = TODO_RELEVANT_PREFIXES[index]!;
    if (head.length >= prefix.length && head.subarray(0, prefix.length).equals(prefix)) return false;
  }
  if (checkInit) {
    for (let index = 0; index < INIT_RELEVANT_PREFIXES.length; index += 1) {
      const prefix = INIT_RELEVANT_PREFIXES[index]!;
      if (head.length >= prefix.length && head.subarray(0, prefix.length).equals(prefix)) return false;
    }
  }
  return true;
}

function transcriptTodoRecord(line: Buffer, checkInit: boolean): ContextRecord | undefined {
  if (!hasClosedJsonObjectFrame(line)) return undefined;
  return transcriptTodoPrefixSkippable(line, checkInit) ? TODO_NOOP_RECORD : undefined;
}

async function scanColdTodoWire(
  wirePath: string,
  signal: AbortSignal,
  initState: { onlyInit: boolean; sawMetadata: boolean },
  onRecord: (record: ContextRecord, span: { startByteOffset: number; endByteOffset: number; ordinal: number }) => void,
): Promise<WireRecordsStreamResult | undefined> {
  const opened = await openLogicalWire(wirePath, signal);
  if (opened === undefined) return undefined;
  const probeBuf = Buffer.allocUnsafe(TODO_PREFIX_MAX);
  let probeLen = 0;
  let mode: 'probe' | 'skip' | 'buffer' = 'probe';
  let lineChunks: Buffer[] = [];
  let lineChunksBytes = 0;
  let lineStartOffset = 0;
  let lineByteLen = 0;
  let lastByte = -1;
  let prevByte = -1;
  let lineNumber = 0;
  let recordCount = 0;
  let bytesRead = 0;
  let nextByteOffset = 0;
  let incompleteReason: WireRecordsIncompleteReason | undefined;
  let yieldedAt = performance.now();

  const finishLine = (terminated: boolean): void => {
    const endOffset = lineStartOffset + lineByteLen + (terminated ? 1 : 0);
    const trimmedLen = lineByteLen > 0 && lastByte === 0x0d ? lineByteLen - 1 : lineByteLen;
    if (trimmedLen === 0) {
      nextByteOffset = endOffset;
      return;
    }
    lineNumber += 1;
    if (mode === 'probe') {
      mode = transcriptTodoPrefixSkippable(probeBuf.subarray(0, probeLen), initState.onlyInit) ? 'skip' : 'buffer';
    }
    if (mode === 'skip') {
      const closingByte = lastByte === 0x0d ? prevByte : lastByte;
      if (trimmedLen >= 2 && closingByte === 0x7d) {
        initState.onlyInit = false;
        recordCount += 1;
        nextByteOffset = endOffset;
        return;
      }
      if (!terminated) {
        incompleteReason = 'partial_tail';
        return;
      }
      throw new Error(`wire.jsonl: corrupted line ${lineNumber} in ${wirePath}`);
    }
    const rawLine = lineChunks.length === 0
      ? probeBuf.subarray(0, probeLen)
      : lineChunks.length === 1
        ? lineChunks[0]!
        : Buffer.concat(lineChunks, lineChunksBytes);
    const normalized = rawLine.length > 0 && rawLine.at(-1) === 0x0d
      ? rawLine.subarray(0, rawLine.length - 1)
      : rawLine;
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized.toString('utf8'));
    } catch (parseError) {
      if (!terminated) {
        incompleteReason = 'partial_tail';
        return;
      }
      throw new Error(`wire.jsonl: corrupted line ${lineNumber} in ${wirePath}: ${String(parseError)}`, { cause: parseError });
    }
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      throw new Error('wire.jsonl: invalid record');
    }
    onRecord(parsed as ContextRecord, { startByteOffset: lineStartOffset, endByteOffset: endOffset, ordinal: recordCount });
    recordCount += 1;
    nextByteOffset = endOffset;
  };

  try {
    for await (const rawChunk of opened.chunks()) {
      signal.throwIfAborted();
      const chunk = Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
      bytesRead += chunk.byteLength;
      let cursor = 0;
      while (cursor < chunk.byteLength) {
        const nl = chunk.indexOf(0x0a, cursor);
        const segEnd = nl === -1 ? chunk.byteLength : nl;
        const segLen = segEnd - cursor;
        if (segLen > 0) {
          if (segLen >= 2) {
            prevByte = chunk[segEnd - 2]!;
            lastByte = chunk[segEnd - 1]!;
          } else {
            prevByte = lastByte;
            lastByte = chunk[segEnd - 1]!;
          }
          if (mode === 'probe') {
            const take = Math.min(TODO_PREFIX_MAX - probeLen, segLen);
            chunk.copy(probeBuf, probeLen, cursor, cursor + take);
            probeLen += take;
            if (probeLen === TODO_PREFIX_MAX) {
              mode = transcriptTodoPrefixSkippable(probeBuf, initState.onlyInit) ? 'skip' : 'buffer';
              if (mode === 'buffer') {
                lineChunks.push(Buffer.from(probeBuf));
                lineChunksBytes = TODO_PREFIX_MAX;
                if (segLen > take) {
                  lineChunks.push(Buffer.from(chunk.subarray(cursor + take, segEnd)));
                  lineChunksBytes += segLen - take;
                }
              }
            }
          } else if (mode === 'buffer') {
            lineChunks.push(Buffer.from(chunk.subarray(cursor, segEnd)));
            lineChunksBytes += segLen;
          }
          lineByteLen += segLen;
        }
        if (nl === -1) break;
        finishLine(true);
        signal.throwIfAborted();
        lineStartOffset = lineStartOffset + lineByteLen + 1;
        lineByteLen = 0;
        mode = 'probe';
        probeLen = 0;
        lastByte = -1;
        prevByte = -1;
        lineChunks = [];
        lineChunksBytes = 0;
        cursor = nl + 1;
        if (performance.now() - yieldedAt >= 4) {
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          signal.throwIfAborted();
          yieldedAt = performance.now();
        }
      }
      if (performance.now() - yieldedAt >= 4) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        signal.throwIfAborted();
        yieldedAt = performance.now();
      }
    }
    if (lineByteLen > 0) {
      finishLine(false);
    }
  } finally {
    opened.close();
  }
  signal.throwIfAborted();
  return {
    recordCount,
    bytesRead,
    nextByteOffset,
    complete: incompleteReason === undefined,
    incompleteReason,
  };
}

function estimateColdRecordWeight(entry: ColdWireRecord): number {
  const cached = coldRecordBytesCache.get(entry);
  if (cached !== undefined) return cached;
  const bytes = estimateColdSnapshotBytes(entry, COLD_WIRE_WINDOWS_MAX_TOTAL_BYTES + 1);
  coldRecordBytesCache.set(entry, bytes);
  return bytes;
}

export interface TranscriptToolCallCountLimits {
  readonly maxBytesPerRequest?: number;
  readonly maxFilesPerRequest?: number;
  readonly maxCacheEntries?: number;
  readonly maxCacheBytes?: number;
  readonly readChunkBytes?: number;
}

export interface TranscriptColdReadLimits {
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  readonly maxLineBytes?: number;
  readonly chunkBytes?: number;
}

export interface BoundedTranscriptSnapshot {
  readonly snapshot: AgentTranscriptSnapshot | undefined;
  readonly bytesRead: number;
  readonly recordsRead: number;
  readonly complete: boolean;
  readonly incompleteReason?: WireRecordsIncompleteReason;
}

export interface TranscriptOpsJournalLimits {
  readonly maxAgentBytes?: number;
  readonly maxSessionBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface TranscriptColdTurnSpanLimits {
  readonly maxDirectTurnBytes?: number;
  readonly maxTurnsPerWire?: number;
  readonly maxWires?: number;
  readonly maxToolIdsPerWire?: number;
  readonly firstScreenLoopBudgetBytes?: number;
  readonly compactTurnLoopBytes?: number;
  readonly compactTurnsReserveBytes?: number;
}

export interface TranscriptServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: TranscriptBindingLogger;
  readonly toolCallCountLimits?: TranscriptToolCallCountLimits;
  readonly toolCallCountReader?: (
    wirePath: string,
    fileSize: number,
    options: BoundedWireScanOptions,
  ) => Promise<number>;
  readonly coldReadLimits?: TranscriptColdReadLimits;
  readonly opsJournalLimits?: TranscriptOpsJournalLimits;
  readonly coldTurnSpanLimits?: TranscriptColdTurnSpanLimits;
  readonly residentLimits?: TranscriptResidentLimits | false;
  readonly wireRecordReader?: (
    wirePath: string,
    options: WireRecordsStreamOptions,
  ) => Promise<WireRecordsStreamResult>;
}

interface LiveEntry {
  readonly store: TranscriptStore;
  readonly binding: TranscriptBinding;
  ready: Promise<void>;
  readonly agentBackfills: Map<string, Promise<void>>;
  readonly agentHistory: Map<string, AgentHistoryState>;
  readonly dirtyLiveAgents: Set<string>;
  readonly tailFirstAgents: Set<string>;
  readonly tailBackfills: Map<string, Promise<void>>;
  readonly agentWires: Map<string, IWireService>;
  readonly pendingDisposals: Map<string, Promise<void>>;
  readonly unavailableAgents: Set<string>;
  readonly opsJournals: Map<string, AgentOpsJournal>;
  opsJournalSessionBytes: number;
  readonly agentToolCallStates: Map<string, MaterializedAgentToolCallState>;
  readonly agentCreation: IDisposable;
  readonly agentDisposal: IDisposable;
}

interface AgentHistoryState {
  status: 'pending' | 'complete' | 'unverified' | 'failed';
  failureSignature?: string;
  retryable?: boolean;
  initOnlyProven?: boolean;
}

interface ColdSnapshotStats {
  bytesRead: number;
  recordsRead: number;
  complete: boolean;
  incompleteReason?: WireRecordsIncompleteReason;
}

interface MaterializedAgentToolCallState {
  readonly toolFrameIdsByTurn: Map<string, Set<string>>;
  toolCallCount: number;
  known: boolean;
}

interface PersistedToolCallState {
  readonly fingerprint: string;
  readonly state: MaterializedAgentToolCallState;
  readonly weight: number;
}

interface ToolCallReadResult {
  readonly fingerprint: string;
  readonly state?: MaterializedAgentToolCallState;
  readonly weight: number;
  readonly known: boolean;
  readonly reason?: 'budget' | 'missing' | 'failed';
  readonly error?: unknown;
}

interface WireFileInfo {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface VerifiedWireReceipt {
  readonly fingerprint: string;
  readonly receipt: Buffer;
  readonly bytes: number;
}

interface ToolCallCountCandidate {
  readonly agentId: string;
  readonly wirePath: string;
  fingerprint?: string;
  info?: WireFileInfo;
  size?: number;
  cached?: MaterializedAgentToolCallState;
  reason?: 'budget' | 'missing' | 'failed';
}

interface AgentOpsJournal {
  epoch: string;
  nextSeq: number;
  start: number;
  batches: (JournaledOpsBatch | undefined)[];
  bytes: number;
}

interface JournaledOpsBatch {
  readonly seq: number;
  readonly ops: TranscriptOperation[];
  readonly bytes: number;
}

interface TranscriptProjectionCheckpoint {
  readonly format: typeof TRANSCRIPT_CHECKPOINT_FORMAT;
  readonly fingerprint: string;
  readonly nextByteOffset: number;
  readonly recordCount: number;
  readonly snapshot: AgentTranscriptSnapshot;
  readonly adapter: TranscriptWireAdapterCheckpoint;
  readonly acceptedDurableFacts: readonly string[];
}

interface ColdSnapshotFlight {
  readonly controller: AbortController;
  readonly promise: Promise<AgentTranscriptSnapshot | undefined>;
  waiters: number;
  settled: boolean;
}

interface WireReceiptVerificationFlight {
  readonly controller: AbortController;
  readonly promise: Promise<boolean>;
  waiters: number;
  settled: boolean;
}

interface ColdWindowFlight {
  readonly controller: AbortController;
  readonly promise: Promise<ColdWireWindow | undefined>;
  waiters: number;
  settled: boolean;
}

interface ColdTodosResult {
  readonly todos: readonly TranscriptTodo[];
  readonly verified: boolean;
}

interface ColdTodosFlight {
  readonly controller: AbortController;
  readonly promise: Promise<ColdTodosResult | undefined>;
  waiters: number;
  settled: boolean;
}

interface ColdSnapshotCacheEntry {
  readonly snapshot: AgentTranscriptSnapshot;
  readonly fingerprint: string;
  readonly pageOnly: boolean;
  readonly bytes: number;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

type TranscriptOpsListener = (event: TranscriptChangeEvent, cursor: TranscriptCursor) => void;

export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;
export const TRANSCRIPT_OPS_JOURNAL_MAX_AGENT_BYTES = 2 << 20;
export const TRANSCRIPT_OPS_JOURNAL_MAX_SESSION_BYTES = 8 << 20;
export const TRANSCRIPT_OPS_JOURNAL_MAX_TOTAL_BYTES = 64 << 20;

export interface TranscriptMemoryReport {
  readonly liveSessions: number;
  readonly liveAgents: number;
  readonly residentTurns: number;
  readonly residentBytes: number;
  readonly trimmedTurns: number;
  readonly overBudgetAgents: number;
  readonly unverifiedResidentAgents: number;
  readonly unverifiedResidentBytes: number;
  readonly opsJournalBytes: number;
  readonly opsJournalBatches: number;
  readonly opsJournalDroppedBytes: number;
  readonly toolCallCacheEntries: number;
  readonly toolCallCacheBytes: number;
  readonly coldWindowEntries: number;
  readonly coldWindowBytes: number;
  readonly anchorWindowEntries: number;
  readonly anchorWindowBytes: number;
  readonly anchorSeekEntries: number;
  readonly coldSnapshotBytes: number;
  readonly retainedTurnBytes: number;
  readonly readLane: ReturnType<HistoryReadLane['report']>;
  readonly eventLoopDelay: {
    readonly meanMs: number;
    readonly maxMs: number;
    readonly p99Ms: number;
  };
  readonly coldReads: {
    readonly completed: number;
    readonly shared: number;
    readonly cancelled: number;
    readonly fenced: number;
    readonly bytes: number;
    readonly records: number;
    readonly durationMs: number;
  };
}

export interface TranscriptOpsCatchup {
  readonly epoch: string;
  readonly batches: readonly {
    readonly seq: number;
    readonly ops: readonly TranscriptOperation[];
  }[];
  readonly throughSeq: number;
  readonly complete: boolean;
}

interface ColdTurnByteSpan {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly undoneOrReplaced: boolean;
}

interface ColdTurnSpanIndex {
  fingerprint: string;
  witness?: WirePrefixWitness;
  visibilityCheckedTo?: number;
  readonly spans: Map<string, ColdTurnByteSpan>;
  readonly promptStarts: Map<string, number>;
  visibilityResetOffset?: number;
}

interface ColdToolTurnIndex {
  fingerprint: string;
  witness?: WirePrefixWitness;
  visibilityCheckedTo?: number;
  readonly toolTurnIds: Map<string, string>;
}

interface ScannedSpanMarker {
  readonly kind: 'turn.prompt' | 'turn_begin' | 'turn.ended' | 'pre_turn' | 'visibility_reset' | 'implicit_turn';
  readonly startByteOffset: number;
  readonly endByteOffset: number;
  readonly turnId?: string;
  readonly promptId?: string;
  readonly userMessageId?: string;
}

interface ColdWireRecord {
  readonly record: ContextRecord;
  readonly position: TranscriptWireRecordPosition;
}

interface ColdWireWindow {
  readonly fingerprint: string;
  witness?: WirePrefixWitness;
  visibilityCheckedTo?: number;
  reachedTail?: boolean;
  start: number;
  end: number;
  entire: boolean;
  records: ColdWireRecord[];
  snapshot: AgentTranscriptSnapshot;
  bytes: number;
  droppedTail?: boolean;
  skippedTurnIds?: readonly string[];
  payloadEvicted?: boolean;
  headers?: readonly TranscriptTurn[];
  headerAttachments?: AgentTranscriptSnapshot['attachments'];
  replayState?: TranscriptReplayState;
  navigationProof?: import('../history/historyNavigationProof').HistoryNavigationProof;
}

function completeColdWindowTurn(window: ColdWireWindow, turnId: string): TranscriptTurn | undefined {
  if (window.skippedTurnIds?.some(id => id === turnId || id === '*') === true) return undefined;
  const index = window.snapshot.items.findIndex(item => item.kind === 'turn' && item.turnId === turnId);
  const turn = window.snapshot.items[index];
  if (turn?.kind !== 'turn' || !window.records.some(({ record }) => record.type === 'turn.prompt' && wireTurnId(record) === turnId)) return undefined;
  if (window.droppedTail === true && !window.snapshot.items.slice(index + 1).some(item => item.kind === 'turn')) return undefined;
  return turn;
}

function partialColdWindowSnapshot(window: ColdWireWindow): AgentTranscriptSnapshot {
  return { ...window.snapshot, items: window.snapshot.items.map(item => item.kind !== 'turn' || completeColdWindowTurn(window, item.turnId) !== undefined
    ? item : { ...item, stepsPartial: true }) };
}

function coldWindowCovers(items: AgentTranscriptSnapshot['items'], beforeTurn: string, contiguous = false): boolean {
  const ordered = items.flatMap((item) => item.kind === 'turn' ? [item.turnId] : []).toSorted(compareTurnIds);
  if (ordered.length === 0) return false;
  if (contiguous) return compareTurnIds(beforeTurn, ordered[0]!) > 0;
  let start = ordered[0]!;
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    if (compareTurnIds(current, ordered[index - 1]!) > 1) start = current;
  }
  const end = ordered.at(-1)!;
  if (compareTurnIds(beforeTurn, end) > 0) return true;
  return compareTurnIds(beforeTurn, start) > 0;
}

function envNonNegativeLimit(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function classifySpanMarker(record: ContextRecord, startByteOffset: number, endByteOffset: number): ScannedSpanMarker | undefined {
  const type = record.type;
  if (type === 'context.undo' || type === 'context.clear' || type === 'branch.base') {
    return { kind: 'visibility_reset', startByteOffset, endByteOffset };
  }
  if (type === 'turn.prompt') {
    const turnId = wireTurnId(record);
    if (turnId === undefined) return { kind: 'implicit_turn', startByteOffset, endByteOffset };
    const rawPromptId = (record as { promptId?: unknown }).promptId;
    const rawUserMessageId = (record as { userMessageId?: unknown }).userMessageId;
    return {
      kind: 'turn.prompt',
      startByteOffset,
      endByteOffset,
      turnId,
      promptId: typeof rawPromptId === 'string' && rawPromptId.length > 0 ? rawPromptId : undefined,
      userMessageId: typeof rawUserMessageId === 'string' && rawUserMessageId.length > 0 ? rawUserMessageId : undefined,
    };
  }
  if (type === 'turn_begin') {
    const turnId = wireTurnId(record);
    return { kind: 'turn_begin', startByteOffset, endByteOffset, turnId };
  }
  if (type === 'turn.ended') {
    const turnId = wireTurnId(record);
    return { kind: 'turn.ended', startByteOffset, endByteOffset, turnId };
  }
  if (type === 'prompt.enqueued' || type === 'prompt.replaced' || type === 'prompt.steer_accepted' || type === 'prompt.launch_committed') {
    const rawPromptId = (record as { promptId?: unknown }).promptId;
    const rawUserMessageId = (record as { userMessageId?: unknown }).userMessageId;
    const promptId = typeof rawPromptId === 'string' && rawPromptId.length > 0 ? rawPromptId : undefined;
    const userMessageId = typeof rawUserMessageId === 'string' && rawUserMessageId.length > 0 ? rawUserMessageId : undefined;
    if (promptId === undefined && userMessageId === undefined) return undefined;
    return { kind: 'pre_turn', startByteOffset, endByteOffset, promptId, userMessageId };
  }
  if (type === 'context.append_message') {
    const delivery = (record as { delivery?: { messageId?: unknown; turnId?: unknown } }).delivery;
    const message = (record as { message?: { id?: unknown; role?: unknown; origin?: { kind?: unknown } } }).message;
    if (delivery === undefined) {
      const kind = message?.origin?.kind;
      if (message?.role === 'user' &&
          kind !== 'injection' && kind !== 'agent_message' && kind !== 'task' && kind !== 'branch_fold' && kind !== 'external_record') {
        return { kind: 'implicit_turn', startByteOffset, endByteOffset };
      }
      return undefined;
    }
    const promptId = typeof delivery.messageId === 'string' && delivery.messageId.length > 0
      ? delivery.messageId
      : typeof message?.id === 'string' && message.id.length > 0 ? message.id : undefined;
    const turnId = typeof delivery.turnId === 'number' && Number.isFinite(delivery.turnId)
      ? `t${delivery.turnId}`
      : typeof delivery.turnId === 'string' && delivery.turnId.length > 0
        ? (delivery.turnId.startsWith('t') ? delivery.turnId : `t${delivery.turnId}`)
        : undefined;
    if (promptId === undefined && turnId === undefined) return undefined;
    return { kind: 'pre_turn', startByteOffset, endByteOffset, turnId, promptId };
  }
  return undefined;
}

function firstTurnOpeningOffset(records: readonly ColdWireRecord[]): number | undefined {
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index]!;
    const marker = classifySpanMarker(entry.record, entry.position.startByteOffset, entry.position.endByteOffset);
    if (marker !== undefined && (marker.kind === 'turn.prompt' || marker.kind === 'turn_begin' || marker.kind === 'implicit_turn' || marker.kind === 'visibility_reset')) {
      return marker.startByteOffset;
    }
  }
  return undefined;
}

function coldItemIdentity(item: AgentTranscriptSnapshot['items'][number]): string {
  switch (item.kind) {
    case 'turn': return `turn:${item.turnId}`;
    case 'marker': return `marker:${item.markerId}`;
    case 'taskref': return `taskref:${item.refId}`;
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}

function coldPrefixAddsItem(current: AgentTranscriptSnapshot['items'], merged: AgentTranscriptSnapshot['items']): boolean {
  if (current.length !== merged.length) return true;
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index]!;
    const after = merged[index]!;
    if (coldItemIdentity(before) !== coldItemIdentity(after)) return true;
    if (before.kind === 'turn' && after.kind === 'turn' && coldTurnVisibleDiffers(before, after)) return true;
  }
  return false;
}

function coldTurnVisibleDiffers(before: TranscriptTurn, after: TranscriptTurn): boolean {
  if (before.prompt !== after.prompt || before.promptId !== after.promptId || before.origin.kind !== after.origin.kind || before.startedAt !== after.startedAt) return true;
  if (before.message?.messageId !== after.message?.messageId) return true;
  return false;
}

function coldPrefixSkippedTurnIds(current: AgentTranscriptSnapshot['items'], merged: AgentTranscriptSnapshot['items']): string[] {
  const skipped: string[] = [];
  const count = Math.min(current.length, merged.length);
  for (let index = 0; index < count; index += 1) {
    const before = current[index]!;
    const after = merged[index]!;
    if (before.kind !== 'turn' || after.kind !== 'turn' || before.turnId !== after.turnId) continue;
    if ((before.contentRefs?.length ?? 0) !== (after.contentRefs?.length ?? 0) || before.steps.length !== after.steps.length) {
      skipped.push(before.turnId);
      continue;
    }
    let differs = false;
    for (let step = 0; step < before.steps.length && !differs; step += 1) {
      const left = before.steps[step]!;
      const right = after.steps[step]!;
      if (left.stepId !== right.stepId || left.frames.length !== right.frames.length) {
        differs = true;
        break;
      }
      for (let frame = 0; frame < left.frames.length; frame += 1) {
        if (left.frames[frame]!.frameId !== right.frames[frame]!.frameId) {
          differs = true;
          break;
        }
      }
    }
    if (differs) skipped.push(before.turnId);
  }
  return skipped;
}

function wireTurnId(record: ContextRecord): string | undefined {
  const value = record.type === 'context.append_loop_event'
    ? (record as { event?: { turnId?: unknown } }).event?.turnId
    : (record as { turnId?: unknown }).turnId;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) return undefined;
  const ordinal = Number(value);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? `t${ordinal}` : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractRecordToolCallIds(record: ContextRecord): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => {
    const id = nonEmptyString(value);
    if (id !== undefined) ids.push(id);
  };
  if (record.type === 'context.append_loop_event') {
    const event = (record as { event?: Record<string, unknown> }).event;
    if (event !== undefined && event !== null && typeof event === 'object') {
      push(event['toolCallId']);
      push(event['tool_call_id']);
    }
    return ids;
  }
  const raw = record as Record<string, unknown>;
  push(raw['toolCallId']);
  push(raw['tool_call_id']);
  const value = raw['value'];
  if (value !== null && typeof value === 'object') {
    push((value as Record<string, unknown>)['toolCallId']);
    push((value as Record<string, unknown>)['tool_call_id']);
  }
  if (record.type === 'context.append_message') {
    const message = raw['message'];
    if (message !== null && typeof message === 'object') {
      const msg = message as Record<string, unknown>;
      push(msg['toolCallId']);
      push(msg['tool_call_id']);
      if (Array.isArray(msg['toolCalls'])) {
        for (const call of msg['toolCalls']) {
          if (call !== null && typeof call === 'object') {
            push((call as Record<string, unknown>)['id']);
          }
        }
      }
    }
  }
  return ids;
}

function hasImplicitTurnRecords(records: readonly ColdWireRecord[]): boolean {
  let activeExplicitTurnId: string | undefined;
  let explicitTurnSlotOpen = false;
  const steeredPromptIds = new Set<string>();
  for (const { record } of records) {
    if (record.type === 'turn_begin') return true;
    if (record.type === 'turn.started' || record.type === 'turn.prompt') {
      const tid = wireTurnId(record);
      if (tid === undefined) return true;
      if (tid !== activeExplicitTurnId) steeredPromptIds.clear();
      activeExplicitTurnId = tid;
      explicitTurnSlotOpen = true;
      continue;
    }
    if (record.type === 'turn.steer') {
      const tid = wireTurnId(record);
      if ((record as { managed?: unknown }).managed !== true && tid !== undefined && tid === activeExplicitTurnId) {
        const promptId = (record as { promptId?: unknown }).promptId;
        if (typeof promptId === 'string' && promptId.length > 0) steeredPromptIds.add(promptId);
      }
      continue;
    }
    if (record.type === 'turn.ended' || record.type === 'context.clear' || record.type === 'branch.base') {
      activeExplicitTurnId = undefined;
      explicitTurnSlotOpen = false;
      steeredPromptIds.clear();
      continue;
    }
    if (record.type === 'context.undo') {
      activeExplicitTurnId = undefined;
      explicitTurnSlotOpen = false;
      steeredPromptIds.clear();
      if ((record as { replacementPrompt?: unknown }).replacementPrompt !== undefined) return true;
      continue;
    }
    if (record.type === 'context.append_message') {
      const delivery = (record as { delivery?: unknown }).delivery;
      const message = (record as { message?: { id?: unknown; role?: unknown; origin?: { kind?: unknown } } }).message;
      const kind = message?.origin?.kind;
      if (
        delivery === undefined &&
        message?.role === 'user' &&
        kind !== 'injection' &&
        kind !== 'agent_message' &&
        kind !== 'task' &&
        kind !== 'branch_fold' &&
        kind !== 'external_record'
      ) {
        if (typeof message.id === 'string' && steeredPromptIds.delete(message.id)) {
          continue;
        }
        if (!explicitTurnSlotOpen) return true;
        explicitTurnSlotOpen = false;
      }
    }
  }
  return false;
}

function hasVisibilityResetRecord(records: readonly ColdWireRecord[]): boolean {
  for (let index = 0; index < records.length; index += 1) {
    const type = records[index]!.record.type;
    if (type === 'context.undo' || type === 'context.clear' || type === 'branch.base') return true;
  }
  return false;
}

interface TurnStartIndex {
  fingerprint: string;
  witness?: WirePrefixWitness;
  visibilityCheckedTo?: number;
  scannedTo: number;
  complete: boolean;
  continuation?: WireRecordsStreamResult['continuation'];
  proofThrough?: number;
  readonly starts: Map<string, number>;
}

function parseTurnOrdinal(turnId: string): number | undefined {
  if (!/^t(0|[1-9]\d*)$/.test(turnId)) return undefined;
  const ordinal = Number(turnId.slice(1));
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : undefined;
}

function oldestTurnOrdinal(items: readonly AgentTranscriptSnapshot['items'][number][]): number | undefined {
  let oldest: number | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind !== 'turn') continue;
    const ordinal = parseTurnOrdinal(item.turnId);
    if (ordinal !== undefined && (oldest === undefined || ordinal < oldest)) oldest = ordinal;
  }
  return oldest;
}

function isWireInitOnlyRecord(record: ContextRecord, index: number): boolean {
  if (index === 0) {
    return record.type === 'metadata' &&
      typeof record['protocol_version'] === 'string' &&
      record['protocol_version'].length > 0 &&
      typeof record['created_at'] === 'number' &&
      Number.isFinite(record['created_at']);
  }
  return record.type === 'runtime.set_binding' &&
    typeof record['workspaceId'] === 'string' &&
    typeof record['runtimeId'] === 'string';
}

function isNonHistoryMetaOnlyOp(op: TranscriptOperation): boolean {
  if (op.op !== 'meta.merge') return false;
  if (
    op.meta.goal !== undefined ||
    op.meta.modes !== undefined ||
    op.meta.promptQueueHold !== undefined ||
    op.meta.modelSwitchQueuePositions !== undefined
  ) {
    return false;
  }
  if (op.meta.activity !== undefined && op.meta.activity !== 'idle') return false;
  const phase = op.meta.agent?.phase;
  return phase === undefined || phase.kind === 'idle';
}

interface AnchorOpeningSeek {
  fingerprint: string;
  witness?: WirePrefixWitness;
  visibilityCheckedTo?: number;
  from: number;
  offset: number;
  continuation?: WireRecordsStreamResult['continuation'];
}

function followingTurnStart(starts: ReadonlyMap<string, number>, turnId: string): number | undefined {
  let previous = -1;
  let following: number | undefined;
  for (const [candidate, at] of starts) {
    if (at <= previous) return undefined;
    previous = at;
    if (following === undefined && compareTurnIds(candidate, turnId) > 0) following = at;
  }
  return following;
}

interface AnchorWindowRead {
  start?: number;
  alignAt: number;
  offset: number;
  end?: number;
  records: ColdWireRecord[];
  continuation?: WireRecordsStreamResult['continuation'];
}

interface AnchorReadBudget {
  bytes: number;
  records: number;
}

interface AnchorSeek {
  fingerprint: string;
  witness?: WirePrefixWitness;
  visibilityCheckedTo?: number;
  at: number;
  window?: AnchorWindowRead;
}

export class TranscriptService {
  private readonly historyReads = new HistoryReadLane();
  private readonly coldTodoReads = new HistoryReadLane(1);

  scheduleHistoryRead<T>(signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>, priority = false): Promise<T> {
    return this.historyReads.run(signal, read, priority);
  }

  private readWireRecordsYielding(wirePath: string, options: WireRecordsStreamOptions): Promise<WireRecordsStreamResult> {
    return this.wireRecordReader(wirePath, {
      ...options,
      onRecord: wrapYieldingRecordCallback(options.onRecord, options.signal),
    });
  }

  private async matchesAppendSafeWitness(
    wirePath: string,
    entry: { readonly fingerprint: string; witness?: WirePrefixWitness; visibilityCheckedTo?: number },
    currentInfo: WireFileStat,
    signal?: AbortSignal,
    currentSealStamp?: string,
  ): Promise<boolean> {
    const currentExact = currentSealStamp === undefined
      ? wireExactFingerprint(currentInfo)
      : `${wireExactFingerprint(currentInfo)}:${currentSealStamp}`;
    if (entry.fingerprint === currentExact) {
      const completeTarget = entry.witness?.completeTailOffset;
      if (entry.visibilityCheckedTo === undefined || completeTarget === undefined || entry.visibilityCheckedTo >= completeTarget) {
        return true;
      }
    }
    if (entry.witness === undefined) return false;
    const checked = await verifyWitnessAppendSafe(
      wirePath,
      entry.witness,
      currentInfo,
      entry.visibilityCheckedTo,
      FIRST_SCREEN_WINDOW_BYTES,
      signal,
      currentSealStamp,
    );
    if (!checked.valid) return false;
    if (checked.witness !== undefined) entry.witness = checked.witness;
    entry.visibilityCheckedTo = checked.visibilityCheckedTo;
    return true;
  }

  private async reconcileColdSpanIndexes(
    wirePath: string,
    info: WireFileStat,
    stamp: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const spanFingerprint = `${wireExactFingerprint(info)}:${stamp}`;
    const spans = this.coldTurnSpans.get(wirePath);
    if (spans !== undefined) {
      if (await this.matchesAppendSafeWitness(wirePath, spans, info, signal, stamp)) {
        spans.fingerprint = spanFingerprint;
      } else {
        this.coldTurnSpans.delete(wirePath);
        this.coldToolTurnIds.delete(wirePath);
      }
    }
    const tools = this.coldToolTurnIds.get(wirePath);
    if (tools !== undefined) {
      if (await this.matchesAppendSafeWitness(wirePath, tools, info, signal, stamp)) {
        tools.fingerprint = spanFingerprint;
      } else {
        this.coldToolTurnIds.delete(wirePath);
      }
    }
    return spanFingerprint;
  }

  private rememberProximityMiss(key: string, identity: string): void {
    this.proximityMisses.delete(key);
    this.proximityMisses.set(key, identity);
    while (this.proximityMisses.size > PROXIMITY_MISS_MAX_ENTRIES) {
      const oldest = this.proximityMisses.keys().next().value;
      if (oldest === undefined) break;
      this.proximityMisses.delete(oldest);
    }
  }

  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<string, Set<TranscriptOpsListener>>();
  private readonly toolCallCountLimits: Required<TranscriptToolCallCountLimits>;
  private readonly persistedToolCallStates = new Map<string, PersistedToolCallState>();
  private persistedToolCallStateWeight = 0;
  private readonly resolvedToolCallCounts = new Map<string, Map<string, number>>();
  private readonly verifiedWireReceipts = new Map<string, VerifiedWireReceipt>();
  private verifiedWireReceiptBytes = 0;
  private readonly verifiedWireReceiptFlights = new Map<string, WireReceiptVerificationFlight>();
  private readonly persistedToolCallReads = new Map<string, Promise<ToolCallReadResult>>();
  private readonly persistedToolCallPins = new Map<string, number>();
  private readonly toolCallCountReader: NonNullable<TranscriptServiceDeps['toolCallCountReader']>;
  private readonly coldReadLimits: Required<TranscriptColdReadLimits>;
  private readonly opsJournalLimits: Required<TranscriptOpsJournalLimits>;
  private readonly wireRecordReader: NonNullable<TranscriptServiceDeps['wireRecordReader']>;
  private readonly coldSnapshotFlights = new Map<string, ColdSnapshotFlight>();
  private readonly coldWindowFlights = new Map<string, ColdWindowFlight>();
  private readonly coldTodosFlights = new Map<string, ColdTodosFlight>();
  private readonly coldTodosCache = new Map<string, { fingerprint: string; todos: readonly TranscriptTodo[]; verified: boolean }>();
  private readonly residencyMaintenance = new ResidencyMaintenanceScheduler();
  private readonly coldSnapshotCache = new Map<string, ColdSnapshotCacheEntry>();
  private readonly completeColdReplays = new WeakSet<AgentTranscriptSnapshot>();
  private readonly contiguousColdSnapshots = new WeakSet<AgentTranscriptSnapshot>();
  private readonly initOnlyProvenSnapshots = new WeakSet<AgentTranscriptSnapshot>();
  private readonly coldRosterCache = new Map<string, { readonly revision: string; readonly roster: readonly AgentDescriptor[] }>();
  private readonly retainedColdTurns = new Map<string, { fingerprint: string; turns: Map<string, TranscriptTurn>; bytes: number }>();
  private retainedColdTurnBytes = 0;
  private readonly coldWireWindows = new Map<string, ColdWireWindow>();
  private readonly coldTurnSpans = new Map<string, ColdTurnSpanIndex>();
  private readonly coldToolTurnIds = new Map<string, ColdToolTurnIndex>();
  private coldWireWindowBytes = 0;
  private readonly anchorSeeks = new Map<string, AnchorSeek>();
  private readonly anchorWindows = new Map<string, { fingerprint: string; witness?: WirePrefixWitness; visibilityCheckedTo?: number; at: number; snapshot: AgentTranscriptSnapshot; bytes: number }>();
  private readonly anchorReads = new WeakMap<AgentTranscriptSnapshot, 'window' | 'continues' | 'pending'>();
  private readonly turnStartIndexes = new Map<string, TurnStartIndex>();
  private readonly anchorOpeningSeeks = new Map<string, AnchorOpeningSeek>();
  private readonly proximityMisses = new Map<string, string>();
  private coldSnapshotCacheBytes = 0;
  private readonly unverifiedResident = new Map<string, { transcript: AgentTranscript; bytes: number }>();
  private unverifiedResidentBytes = 0;
  private opsJournalTotalBytes = 0;
  private opsJournalDroppedBytes = 0;
  private coldReadsCompleted = 0;
  private coldReadsShared = 0;
  private coldReadsCancelled = 0;
  private coldReadsFenced = 0;
  private coldReadBytes = 0;
  private coldReadRecords = 0;
  private coldReadDurationMs = 0;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(private readonly deps: TranscriptServiceDeps) {
    this.eventLoopDelay.enable();
    this.toolCallCountReader = deps.toolCallCountReader ?? readWireRecordsBounded;
    const limits = deps.toolCallCountLimits;
    this.toolCallCountLimits = {
      maxBytesPerRequest: nonNegativeLimit(limits?.maxBytesPerRequest, DEFAULT_TOOL_CALL_COUNT_MAX_BYTES),
      maxFilesPerRequest: nonNegativeLimit(limits?.maxFilesPerRequest, DEFAULT_TOOL_CALL_COUNT_MAX_FILES),
      maxCacheEntries: nonNegativeLimit(limits?.maxCacheEntries, DEFAULT_TOOL_CALL_COUNT_CACHE_ENTRIES),
      maxCacheBytes: nonNegativeLimit(limits?.maxCacheBytes, DEFAULT_TOOL_CALL_COUNT_CACHE_BYTES),
      readChunkBytes: positiveLimit(limits?.readChunkBytes, DEFAULT_TOOL_CALL_COUNT_READ_CHUNK_BYTES),
    };
    this.wireRecordReader = deps.wireRecordReader ?? streamLogicalWireRecords;
    const coldReadLimits = deps.coldReadLimits;
    this.coldReadLimits = {
      maxBytes: nonNegativeLimit(coldReadLimits?.maxBytes, WIRE_COLD_READ_MAX_BYTES),
      maxRecords: nonNegativeLimit(coldReadLimits?.maxRecords, WIRE_COLD_READ_MAX_RECORDS),
      maxLineBytes: nonNegativeLimit(coldReadLimits?.maxLineBytes, WIRE_COLD_READ_MAX_LINE_BYTES),
      chunkBytes: positiveLimit(coldReadLimits?.chunkBytes, WIRE_READ_CHUNK_BYTES),
    };
    const opsJournalLimits = deps.opsJournalLimits;
    this.opsJournalLimits = {
      maxAgentBytes: nonNegativeLimit(opsJournalLimits?.maxAgentBytes, TRANSCRIPT_OPS_JOURNAL_MAX_AGENT_BYTES),
      maxSessionBytes: nonNegativeLimit(opsJournalLimits?.maxSessionBytes, TRANSCRIPT_OPS_JOURNAL_MAX_SESSION_BYTES),
      maxTotalBytes: nonNegativeLimit(opsJournalLimits?.maxTotalBytes, TRANSCRIPT_OPS_JOURNAL_MAX_TOTAL_BYTES),
    };
    followSessionLifecycles(deps.core.accessor, (service) => {
      const d1 = service.onDidCloseSession(({ sessionId }) => this.dropSession(sessionId));
      const d2 = service.onDidArchiveSession(({ sessionId }) => this.dropSession(sessionId));
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
      };
    });
  }

  /**
   * Get (or create + bind) the transcript store for a session that is live in
   * this process. Returns `undefined` when the session is not in memory.
   */
  forSessionLive(sessionId: string, options: { readonly tailFirst?: boolean } = {}): TranscriptStore | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) {
      if (getLiveSessionById(this.deps.core.accessor, sessionId) !== undefined) {
        return existing.store;
      }
      this.dropSession(sessionId);
      return undefined;
    }
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session === undefined) return undefined;
    const store = new TranscriptStore(sessionId, this.resolveResidentLimits());
    let binding: TranscriptBinding;
    try {
      binding = bindSessionTranscript(
        store,
        session,
        this.deps.logger,
        (event) => this.handleLiveOps(sessionId, event),
        true,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return undefined;
      }
      throw error;
    }
    const agents = session.accessor.get(IAgentLifecycleService);
    const agentWires = new Map<string, IWireService>();
    const captureWire = (handle: IAgentScopeHandle): void => {
      try {
        const wire = handle.accessor.get(IWireService);
        if (wire !== undefined) agentWires.set(handle.id, wire);
      } catch {
      }
    };
    for (const handle of agents.list()) captureWire(handle);
    const entry: LiveEntry = {
      store,
      binding,
      ready: Promise.resolve(),
      agentBackfills: new Map(),
      agentHistory: new Map(),
      dirtyLiveAgents: new Set(),
      tailFirstAgents: new Set(options.tailFirst === true ? [MAIN_AGENT_ID] : []),
      tailBackfills: new Map(),
      agentWires,
      pendingDisposals: new Map(),
      unavailableAgents: new Set(),
      opsJournals: new Map(),
      opsJournalSessionBytes: 0,
      agentToolCallStates: new Map(),
      agentCreation: agents.onDidCreate(captureWire),
      agentDisposal: agents.onDidDispose((agentId) => this.evictAgent(sessionId, store, agentId)),
    };
    this.live.set(sessionId, entry);
    entry.ready = (async () => {
      await this.backfillMain(sessionId, store, options.tailFirst);
      if (this.live.get(sessionId)?.store === store) {
        binding.seedRunningTasks(MAIN_AGENT_ID);
        binding.seedPendingInteractions(MAIN_AGENT_ID);
        binding.seedPrompts(MAIN_AGENT_ID);
        this.reconcileQueuedPrompts(sessionId, store, MAIN_AGENT_ID);
      }
    })();
    return store;
  }

  private evictAgent(sessionId: string, store: TranscriptStore, agentId: string): void {
    if (agentId === MAIN_AGENT_ID) return;
    const entry = this.live.get(sessionId);
    if (entry === undefined || entry.store !== store) return;
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session?.accessor.get(IAgentLifecycleService).get(agentId) !== undefined) return;
    this.setResidentWeight(`${sessionId}\0${agentId}`, 0);
    this.residencyMaintenance.cancel(`${sessionId}\0${agentId}`, new DOMException('Transcript agent closed', 'AbortError'));
    const wire = entry.agentWires.get(agentId);
    entry.agentWires.delete(agentId);
    entry.agentBackfills.delete(agentId);
    entry.agentHistory.delete(agentId);
    entry.dirtyLiveAgents.delete(agentId);
    entry.tailFirstAgents.delete(agentId);
    entry.tailBackfills.delete(agentId);
    const journal = entry.opsJournals.get(agentId);
    if (journal !== undefined) {
      this.disposeOpsJournal(entry, journal);
      entry.opsJournals.delete(agentId);
    }
    entry.agentToolCallStates.delete(agentId);
    if (wire !== undefined) {
      const transcript = store.getAgent(agentId);
      if (transcript !== undefined && !entry.unavailableAgents.has(agentId)) {
        this.retainUnverifiedResident(sessionId, agentId, transcript);
      }
      let pending!: Promise<void>;
      pending = Promise.resolve().then(() => wire.flush()).then(
        () => {
          if (this.live.get(sessionId) === entry && !entry.unavailableAgents.has(agentId)) {
            this.deleteUnverifiedResident(`${sessionId}\0${agentId}`);
          }
        },
        (error: unknown) => {
          if (this.live.get(sessionId) !== entry) return;
          entry.unavailableAgents.add(agentId);
          this.deps.logger?.warn(
            { sessionId, agentId, error },
            'transcript: disposed agent wire flush failed; refusing later reads',
          );
        },
      ).finally(() => {
        if (entry.pendingDisposals.get(agentId) === pending) entry.pendingDisposals.delete(agentId);
      });
      entry.pendingDisposals.set(agentId, pending);
    }
    store.evictAgentTranscript(agentId);
  }

  private deleteUnverifiedResident(key: string): void {
    const retained = this.unverifiedResident.get(key);
    if (retained === undefined) return;
    this.unverifiedResident.delete(key);
    this.unverifiedResidentBytes -= retained.bytes;
  }

  private retainUnverifiedResident(sessionId: string, agentId: string, transcript: AgentTranscript): void {
    const key = `${sessionId}\0${agentId}`;
    this.deleteUnverifiedResident(key);
    const bytes = transcript.residentReport().estimatedBytes;
    if (bytes > UNVERIFIED_RESIDENT_MAX_BYTES) {
      this.deps.logger?.warn({ sessionId, agentId }, 'transcript: unverified resident history exceeds quarantine budget');
      return;
    }
    while (
      this.unverifiedResidentBytes + bytes > UNVERIFIED_RESIDENT_MAX_BYTES ||
      this.unverifiedResident.size >= UNVERIFIED_RESIDENT_MAX_AGENTS
    ) {
      const oldest = this.unverifiedResident.keys().next().value;
      if (oldest === undefined) break;
      this.deleteUnverifiedResident(oldest);
    }
    this.unverifiedResident.set(key, { transcript, bytes });
    this.unverifiedResidentBytes += bytes;
  }

  /** Best-effort diagnostic salvage only; never a complete history and evicted at the quarantine budget or session close. */
  getUnverifiedAgentSnapshot(
    sessionId: string,
    agentId: string,
  ): { readonly snapshot: AgentTranscriptSnapshot; readonly complete: false } | undefined {
    const retained = this.unverifiedResident.get(`${sessionId}\0${agentId}`);
    return retained === undefined ? undefined : { snapshot: retained.transcript.snapshot(), complete: false };
  }

  private assertReadableAgent(sessionId: string, agentId: string): void {
    const entry = this.live.get(sessionId);
    if (entry === undefined || agentId === MAIN_AGENT_ID) return;
    if (entry.pendingDisposals.has(agentId)) {
      throw new Error(`Transcript for disposed agent "${agentId}" is awaiting wire flush`);
    }
    if (!entry.unavailableAgents.has(agentId)) return;
    throw new Error(
      `Transcript for disposed agent "${agentId}" is unavailable: live facts were not verified against durable history`,
    );
  }

  private invalidateInitOnlyLiveProof(entry: LiveEntry, agentId: string): void {
    entry.dirtyLiveAgents.add(agentId);
    const history = entry.agentHistory.get(agentId);
    if (history?.initOnlyProven === true) history.initOnlyProven = false;
  }

  private hasOnlyNonHistoryResidentFacts(snapshot: AgentTranscriptSnapshot): boolean {
    if (
      snapshot.items.length > 0 ||
      snapshot.tasks.length > 0 ||
      snapshot.prompts.length > 0 ||
      snapshot.interactions.length > 0 ||
      snapshot.attachments.length > 0 ||
      snapshot.todos.length > 0
    ) {
      return false;
    }
    if (
      snapshot.meta.goal !== undefined ||
      snapshot.meta.modes !== undefined ||
      snapshot.meta.promptQueueHold !== undefined ||
      snapshot.meta.modelSwitchQueuePositions !== undefined
    ) {
      return false;
    }
    if (snapshot.meta.activity !== undefined && snapshot.meta.activity !== 'idle') return false;
    const phase = snapshot.meta.agent?.phase;
    return phase === undefined || phase.kind === 'idle';
  }

  private isVerifiedInitOnlyLiveTranscript(entry: LiveEntry, agentId: string): boolean {
    if (entry.unavailableAgents.has(agentId) || entry.dirtyLiveAgents.has(agentId)) return false;
    const history = entry.agentHistory.get(agentId);
    return history?.status === 'complete' && history.initOnlyProven === true;
  }

  isTranscriptLiveCoverageVerified(sessionId: string, agentId: string): boolean {
    const entry = this.live.get(sessionId);
    const wire = entry?.agentWires.get(agentId);
    if (wire?.verifyTranscriptLiveEpoch === undefined || wire.isTranscriptLiveEpochVerified?.() === true) return true;
    if (entry !== undefined && this.isVerifiedInitOnlyLiveTranscript(entry, agentId)) {
      void this.hasVerifiedLiveEpoch(sessionId, agentId).catch(() => {});
      return true;
    }
    return false;
  }

  /**
   * Proves the live epoch against durable wire. A proof that has not settled within
   * a short bound reports unverified while the shared verification continues.
   */
  async verifyTranscriptLiveCoverage(sessionId: string, agentId: string): Promise<boolean> {
    const entry = this.live.get(sessionId);
    const wire = entry?.agentWires.get(agentId);
    if (wire?.verifyTranscriptLiveEpoch === undefined || await this.hasVerifiedLiveEpoch(sessionId, agentId)) return true;
    return entry !== undefined && this.isVerifiedInitOnlyLiveTranscript(entry, agentId);
  }

  /**
   * Resolves when the session's initial history backfill has landed (or
   * immediately when the session has no live store). A tail-first store
   * establishes its visible window before releasing buffered live events;
   * explicit full-history reads recover the remaining canonical history.
   */
  async whenReady(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.ready;
  }

  /** Return an established projection; dormant agents use the bounded cold cache, not the live store. */
  async ensureAgentHistory(sessionId: string, agentId: string, options: { readonly fullHistory?: boolean; readonly tailFirst?: boolean; readonly signal?: AbortSignal } = {}): Promise<AgentTranscript | undefined> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const tailFirst = options.tailFirst === true && options.fullHistory !== true;
    const wait = <T>(promise: Promise<T>): Promise<T> => signal === undefined ? promise : abortable(promise, signal);
    const establish = async (transcript: AgentTranscript | undefined): Promise<AgentTranscript | undefined> => {
      if (transcript === undefined) return undefined;
      if (!transcript.hasMoreOlder && !transcript.hasEvictedTail && (!options.fullHistory || transcript.snapshot().toolCallCountKnown === true)) return transcript;
      if (!options.fullHistory && !transcript.hasEvictedTail && transcript.getItems().some(item => item.kind === 'turn')) return transcript;
      const snapshot = options.fullHistory
        ? await this.readFullAgentSnapshot(sessionId, agentId, transcript, signal)
        : await this.readScreenSnapshot(sessionId, agentId, undefined, signal, undefined, tailFirst);
      if (snapshot === undefined) return undefined;
      const full = new AgentTranscript(agentId);
      full.apply([{ op: 'reset', agentId, snapshot }]);
      if (!options.fullHistory) full.apply(snapshotToOps(transcript.snapshot()));
      return full;
    };
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    const disposal = entry.pendingDisposals.get(agentId);
    if (disposal !== undefined) await wait(disposal);
    this.assertReadableAgent(sessionId, agentId);
    if (tailFirst && entry.agentHistory.get(agentId)?.status === 'pending' && !entry.tailFirstAgents.has(agentId)) {
      let tail = entry.tailBackfills.get(agentId);
      if (tail === undefined) {
        tail = this.establishPendingReplayTail(sessionId, agentId, entry);
        entry.tailBackfills.set(agentId, tail);
      }
      await wait(tail);
      signal?.throwIfAborted();
      if (this.live.get(sessionId) === entry) return entry.store.getAgent(agentId);
      return;
    }
    if (tailFirst && entry.tailBackfills.has(agentId)) {
      await wait(entry.tailBackfills.get(agentId)!);
      if (this.live.get(sessionId) === entry) return entry.store.getAgent(agentId);
      return;
    }
    if (agentId === MAIN_AGENT_ID) await wait(entry.ready);
    signal?.throwIfAborted();
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (agentId !== MAIN_AGENT_ID && session?.accessor.get(IAgentLifecycleService).get(agentId) === undefined) {
      const snapshot = await this.readScreenSnapshot(sessionId, agentId, undefined, signal, undefined, tailFirst);
      if (snapshot === undefined) return;
      const transcript = new AgentTranscript(agentId);
      transcript.apply([{ op: 'reset', agentId, snapshot: this.reconcileQuestionSnapshot(sessionId, snapshot) }]);
      const descriptor = entry.store.agents().find((agent) => agent.agentId === agentId);
      if (this.live.get(sessionId) === entry && (descriptor !== undefined || snapshot.items.length > 0 || snapshot.tasks.length > 0)) {
        entry.store.describeAgent({ agentId, type: 'sub', ...descriptor });
      }
      return transcript;
    }
    let backfill = entry.agentBackfills.get(agentId);
    const history = entry.agentHistory.get(agentId);
    if (history?.status === 'failed') {
      const changed = history.retryable === true || await this.historyFailureChanged(sessionId, agentId, history);
      this.assertReadableAgent(sessionId, agentId);
      if (!changed) return establish(entry.store.getAgent(agentId));
      if (entry.agentBackfills.get(agentId) === backfill) entry.agentBackfills.delete(agentId);
      backfill = entry.agentBackfills.get(agentId);
    }
    if (backfill === undefined) {
      if (agentId === MAIN_AGENT_ID && history?.status !== 'failed') return establish(entry.store.getAgent(agentId));
      entry.agentHistory.set(agentId, { status: 'pending' });
      if (tailFirst) entry.tailFirstAgents.add(agentId);
      backfill = this.backfillAgent(sessionId, entry.store, agentId, tailFirst);
      entry.agentBackfills.set(agentId, backfill);
    }
    await wait(backfill);
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    if (this.live.get(sessionId)?.store === entry.store) {
      entry.binding.seedRunningTasks(agentId);
      entry.binding.seedPendingInteractions(agentId);
      entry.binding.seedPrompts(agentId);
      this.reconcileQueuedPrompts(sessionId, entry.store, agentId);
      return establish(entry.store.getAgent(agentId));
    }
  }

  private async establishPendingReplayTail(sessionId: string, agentId: string, entry: LiveEntry): Promise<void> {
    let replayState: TranscriptReplayState | undefined;
    const snapshot = await this.readScreenSnapshot(sessionId, agentId,
      () => this.liveActiveTurnIds(sessionId, agentId, undefined), undefined,
      (state) => { replayState = state; }, true).catch(() => undefined);
    if (snapshot === undefined || replayState === undefined || this.live.get(sessionId) !== entry) {
      if (entry.tailBackfills.get(agentId) !== undefined) entry.tailBackfills.delete(agentId);
      return;
    }
    const transcript = entry.store.ensureAgent(agentId);
    const result = transcript.apply(snapshotToOps(this.reconcileLiveInteractionSnapshot(sessionId, transcript, snapshot)));
    const countKnown = snapshotToolCallCountKnown(snapshot) && snapshot.hasMoreOlder !== true;
    if (!countKnown) transcript.noteOlderHistory();
    if (result.accepted.length > 0) this.dispatchOps(sessionId, { agentId, ops: result.accepted });
    entry.tailFirstAgents.add(agentId);
    const materialized = transcript.snapshot();
    const initOnlyProven =
      countKnown &&
      this.initOnlyProvenSnapshots.has(snapshot) &&
      !entry.dirtyLiveAgents.has(agentId) &&
      this.hasOnlyNonHistoryResidentFacts(materialized);
    entry.agentHistory.set(agentId, { status: countKnown ? 'complete' : 'unverified', initOnlyProven });
    entry.agentToolCallStates.set(agentId, toolCallStateFromSnapshot({ ...materialized, toolCallCountKnown: countKnown }));
    if (countKnown) this.dispatchToolCallCount(sessionId, transcript, countToolCallFrames(materialized.items), true);
    entry.binding.finishReplay(agentId, replayState);
    entry.binding.seedRunningTasks(agentId);
    entry.binding.seedPendingInteractions(agentId);
    entry.binding.seedPrompts(agentId);
    this.reconcileQueuedPrompts(sessionId, entry.store, agentId);
  }

  private reconcileQueuedPrompts(sessionId: string, store: TranscriptStore, agentId: string): void {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent = session?.accessor.get(IAgentLifecycleService).get(agentId);
    const prompts = agent?.accessor.get(IAgentPromptService);
    if (prompts === undefined) return;
    const transcript = store.getAgent(agentId);
    if (transcript === undefined) return;
    let snapshot: ReturnType<IAgentPromptService['list']>;
    try {
      snapshot = prompts.list();
    } catch {
      return;
    }
    const owned = new Set<string>();
    if (snapshot.active !== undefined) owned.add(snapshot.active.id);
    if (snapshot.launching !== undefined) owned.add(snapshot.launching.id);
    for (const pending of snapshot.pending) owned.add(pending.id);
    const entry = this.live.get(sessionId);
    if (owned.size > 0 && entry?.store === store) this.invalidateInitOnlyLiveProof(entry, agentId);
    const ops: TranscriptOperation[] = [];
    for (const prompt of transcript.snapshot().prompts) {
      if (prompt.status !== 'queued' || owned.has(prompt.promptId)) continue;
      ops.push({ op: 'prompt.upsert', prompt: { ...prompt, status: 'aborted', abortedBeforeStart: true } });
    }
    if (ops.length === 0) return;
    if (entry?.store === store) this.invalidateInitOnlyLiveProof(entry, agentId);
    const result = transcript.apply(ops);
    if (result.accepted.length > 0) this.dispatchOps(sessionId, { agentId, ops: result.accepted });
  }

  private reconcileLiveInteractionSnapshot(
    sessionId: string,
    transcript: AgentTranscript,
    snapshot: AgentTranscriptSnapshot,
  ): AgentTranscriptSnapshot {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session === undefined) return snapshot;
    const pendingIds = new Set(session.accessor.get(ISessionInteractionService).listPending().map((entry) => entry.id));
    const current = transcript.getInteractions();
    const interactions = new Map(snapshot.interactions.map((interaction) => {
      const live = current.get(interaction.interactionId);
      const value = pendingIds.has(interaction.interactionId)
        ? { ...(live ?? interaction), state: 'pending' as const, response: undefined }
        : live?.response !== undefined ? live : interaction;
      return [interaction.interactionId, value];
    }));
    for (const interaction of current.values()) {
      if (!interactions.has(interaction.interactionId) && pendingIds.has(interaction.interactionId)) {
        interactions.set(interaction.interactionId, { ...interaction, state: 'pending', response: undefined });
      }
    }
    return this.reconcileQuestionSnapshot(sessionId, { ...snapshot, interactions: [...interactions.values()] });
  }

  reconcileQuestionSnapshot(sessionId: string, snapshot: AgentTranscriptSnapshot): AgentTranscriptSnapshot {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const pendingIds = new Set(session?.accessor.get(ISessionInteractionService).listPending('question').map((entry) => entry.id) ?? []);
    return {
      ...snapshot,
      interactions: snapshot.interactions.map((interaction) =>
        interaction.interactionKind === 'question' &&
        (interaction.state === 'pending' || (interaction.state === 'cancelled' && interaction.response === undefined)) &&
        !pendingIds.has(interaction.interactionId)
          ? { ...interaction, state: 'cancelled', response: { cancelled: true, reason: 'agent_closed' } }
          : interaction),
    };
  }

  /** Initial backfill: main-agent history + the full roster from session metadata. */
  private async backfillMain(sessionId: string, store: TranscriptStore, tailFirst = false): Promise<void> {
    await this.backfillAgent(sessionId, store, MAIN_AGENT_ID, tailFirst);
    if (this.live.get(sessionId)?.store !== store) return;
    try {
      const session = getLiveSessionById(this.deps.core.accessor, sessionId);
      const metadata = session?.accessor.get(ISessionMetadata);
      if (tailFirst) await metadata?.ready;
      const meta = tailFirst ? metadata?.snapshot() : await metadata?.read();
      store.describeAgents(
        Object.entries(meta?.agents ?? {}).map(([agentId, agentMeta]) => descriptorFromMeta(agentId, agentMeta)),
      );
    } catch {
    }
  }

  private liveActiveTurnId(sessionId: string, agentId: string): string | undefined {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent = session?.accessor.get(IAgentLifecycleService).get(agentId);
    const view: IAgentActivityView | undefined = agent?.accessor.get(IAgentActivityView);
    const turnId = view?.state().turn?.turnId;
    return turnId === undefined ? undefined : `t${turnId}`;
  }

  private liveActiveTurnIds(
    sessionId: string,
    agentId: string,
    initialTurnId: string | undefined,
  ): string[] {
    const currentTurnId = this.liveActiveTurnId(sessionId, agentId);
    if (initialTurnId === undefined) return currentTurnId === undefined ? [] : [currentTurnId];
    if (currentTurnId === undefined || currentTurnId === initialTurnId) return [initialTurnId];
    return [initialTurnId, currentTurnId];
  }

  private async backfillAgent(sessionId: string, store: TranscriptStore, agentId: string, tailFirst = false): Promise<void> {
    const entryAtStart = this.live.get(sessionId);
    if (entryAtStart?.store !== store) return;
    entryAtStart.binding.beginReplay(agentId);
    entryAtStart.agentHistory.set(agentId, { status: 'pending' });
    const transcript = store.ensureAgent(agentId);
    this.dispatchToolCallCount(sessionId, transcript, undefined, true);
    const initialActiveTurnId = this.liveActiveTurnId(sessionId, agentId);
    let snapshot: AgentTranscriptSnapshot | undefined;
    let replayState: TranscriptReplayState | undefined;
    let failed = false;
    let retryable = false;
    try {
      snapshot = await this.readScreenSnapshot(
        sessionId,
        agentId,
        () => this.liveActiveTurnIds(sessionId, agentId, initialActiveTurnId),
        undefined,
        (state) => { replayState = state; },
        tailFirst,
      );
      if (!tailFirst && entryAtStart.tailFirstAgents.has(agentId)) return;
      if (snapshot === undefined || replayState === undefined) failed = true;
      if (snapshot !== undefined) {
        const liveMeta = transcript.snapshot().meta;
        const livePhase = liveMeta.agent?.phase;
        const coldPhase = snapshot.meta.agent?.phase;
        const liveTurn = livePhase !== undefined && 'turnId' in livePhase ? livePhase.turnId : undefined;
        const coldTurn = coldPhase !== undefined && 'turnId' in coldPhase ? coldPhase.turnId : undefined;
        const liveTime = livePhase !== undefined && 'since' in livePhase ? livePhase.since
          : livePhase !== undefined && 'at' in livePhase ? livePhase.at : undefined;
        const coldTime = coldPhase !== undefined && 'since' in coldPhase ? coldPhase.since
          : coldPhase !== undefined && 'at' in coldPhase ? coldPhase.at : undefined;
        const liveExecuting = livePhase?.kind === 'running' || livePhase?.kind === 'streaming' ||
          livePhase?.kind === 'tool_call' || livePhase?.kind === 'retrying' || livePhase?.kind === 'awaiting_approval';
        const keepLivePhase = liveExecuting || liveTurn !== undefined && (
          (coldTurn !== undefined && liveTurn > coldTurn) ||
          (coldTurn === undefined && coldPhase?.kind === 'idle' && livePhase?.kind !== 'ended') ||
          (coldTurn === liveTurn && liveTime !== undefined && coldTime !== undefined && liveTime >= coldTime)
        );
        const backfill = keepLivePhase
          ? { ...snapshot, meta: {
              ...snapshot.meta,
              activity: livePhase !== undefined && 'since' in livePhase
                ? 'turn' : liveMeta.activity ?? snapshot.meta.activity,
              agent: { ...snapshot.meta.agent, phase: livePhase },
            } }
          : snapshot;
        const result = transcript.apply(snapshotToOps(this.reconcileLiveInteractionSnapshot(sessionId, transcript, backfill)));
        if (result.gap !== undefined) {
          this.deps.logger?.warn({ sessionId, agentId, gap: result.gap }, 'transcript: backfill append gap');
        }
        if (result.accepted.length > 0) {
          this.dispatchOps(sessionId, { agentId, ops: result.accepted });
        }
      }
    } catch (error) {
      failed = true;
      retryable = isError2(error) && error.code === ErrorCodes.SESSION_BUSY;
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: history backfill failed, continuing without it',
      );
    }
    const entry = this.live.get(sessionId);
    if (entry?.store !== store) return;
    if (!tailFirst && entry.tailFirstAgents.has(agentId)) return;
    if (entry.unavailableAgents.has(agentId)) return;
    const existing = store.agents().find((d) => d.agentId === agentId);
    const hasContent =
      snapshot !== undefined && (snapshot.items.length > 0 || snapshot.tasks.length > 0);
    if (existing !== undefined || hasContent) {
      store.describeAgent({
        agentId,
        type: existing?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
        parentAgentId: existing?.parentAgentId,
        label: existing?.label,
        createdAt: existing?.createdAt,
      });
    }
    const materialized = transcript.snapshot();
    const countKnown = !failed && snapshot !== undefined && snapshotToolCallCountKnown(snapshot);
    entry.agentToolCallStates.set(agentId, toolCallStateFromSnapshot({ ...materialized, toolCallCountKnown: countKnown }));
    const failureSignature = failed
      ? await this.historyFailureSignature(sessionId, agentId)
      : undefined;
    if (failed) {
      entry.agentHistory.set(agentId, { status: 'failed', failureSignature, retryable });
      this.dispatchToolCallCount(sessionId, transcript, undefined, true);
    } else {
      const initOnlyProven =
        countKnown &&
        snapshot !== undefined &&
        this.initOnlyProvenSnapshots.has(snapshot) &&
        !entry.dirtyLiveAgents.has(agentId) &&
        this.hasOnlyNonHistoryResidentFacts(materialized);
      entry.agentHistory.set(agentId, { status: countKnown ? 'complete' : 'unverified', initOnlyProven });
      this.dispatchToolCallCount(sessionId, transcript, countKnown ? countToolCallFrames(materialized.items) : undefined, true);
    }
    entry.binding.finishReplay(agentId, failed ? undefined : replayState);
    if (snapshot !== undefined) this.releaseDurableHistory(entry, agentId, snapshot);
    if (snapshot !== undefined && await this.coldHistoryTruncated(sessionId, agentId)) {
      entry.store.getAgent(agentId)?.noteOlderHistory();
    }
  }

  private readonly residentWeights = new Map<string, number>();
  private residentWeight = 0;

  private setResidentWeight(key: string, bytes: number): void {
    this.residentWeight += bytes - (this.residentWeights.get(key) ?? 0);
    if (bytes === 0) this.residentWeights.delete(key);
    else this.residentWeights.set(key, bytes);
  }

  private effectiveResidentLimits(key: string, bytes: number, limits: TranscriptResidentLimits): TranscriptResidentLimits {
    const otherBytes = this.residentWeight - (this.residentWeights.get(key) ?? 0);
    const allowance = Math.max(0, (64 << 20) - otherBytes);
    return allowance < bytes ? { maxBytes: Math.min(limits.maxBytes, allowance), tailTurns: 0 } : limits;
  }

  private aggregateResidentLimits(key: string, bytes: number, limits: TranscriptResidentLimits): TranscriptResidentLimits {
    this.setResidentWeight(key, bytes);
    return this.effectiveResidentLimits(key, bytes, limits);
  }

  private releaseDurableHistory(entry: LiveEntry, agentId: string, snapshot: AgentTranscriptSnapshot): void {
    const limits = this.resolveResidentLimits();
    const transcript = entry.store.getAgent(agentId);
    if (limits === undefined || transcript === undefined) return;
    const key = `${entry.store.sessionId}\0${agentId}`;
    const released = transcript.releaseDurableHistory(snapshot, this.aggregateResidentLimits(key, transcript.residentReport().estimatedBytes, limits));
    this.setResidentWeight(key, transcript.residentReport().estimatedBytes);
    if (released.length === 0) return;
    const ids = new Set(released);
    const promptIds = snapshot.items.flatMap((item) => item.kind === 'turn' && ids.has(item.turnId) && item.promptId !== undefined ? [item.promptId] : []);
    entry.binding.releaseDurableTurns(agentId, released, promptIds);
  }

  private releaseDurableTurns(
    entry: LiveEntry,
    agentId: string,
    transcript: AgentTranscript,
    turns: readonly TranscriptTurn[],
    durableGlobals: DurableTurnReleaseGlobals,
    effective: TranscriptResidentLimits,
    initialBytes: number,
    provenBytesByTurn: ReadonlyMap<string, number>,
  ): readonly string[] {
    const key = `${entry.store.sessionId}\0${agentId}`;
    const retainedTasks = (durableGlobals.tasks ?? []).filter((task) => transcript.getTasks().has(task.taskId));
    const retainedAttachments = (durableGlobals.attachments ?? []).filter((attachment) => transcript.getAttachments().has(attachment.attachmentId));
    const retainedPrompts = (durableGlobals.prompts ?? []).filter((prompt) => transcript.getPrompts().has(prompt.promptId));
    const released = transcript.releaseDurableTurns(turns, effective, durableGlobals);
    if (released.length === 0) return released;
    const ids = new Set(released);
    const promptIds: string[] = [];
    let releasedBytes = 0;
    for (const turn of turns) {
      if (!ids.has(turn.turnId)) continue;
      if (turn.promptId !== undefined) promptIds.push(turn.promptId);
      releasedBytes += provenBytesByTurn.get(turn.turnId) ?? 0;
    }
    for (const task of retainedTasks) {
      if (!transcript.getTasks().has(task.taskId)) releasedBytes += estimateResidentValueBytes(task);
    }
    for (const attachment of retainedAttachments) {
      if (!transcript.getAttachments().has(attachment.attachmentId)) releasedBytes += estimateResidentValueBytes(attachment);
    }
    for (const prompt of retainedPrompts) {
      if (!transcript.getPrompts().has(prompt.promptId)) releasedBytes += estimateResidentValueBytes(prompt);
    }
    this.setResidentWeight(key, Math.max(0, initialBytes - releasedBytes));
    entry.binding.releaseDurableTurns(agentId, released, promptIds);
    return released;
  }

  private scheduleResidencyMaintenance(sessionId: string, agentId: string, entry: LiveEntry): void {
    const key = `${sessionId}\0${agentId}`;
    const transcript = entry.store.getAgent(agentId);
    const limits = this.resolveResidentLimits();
    const wire = entry.agentWires.get(agentId);
    if (transcript === undefined || limits === undefined || wire === undefined) return;
    const isCurrent = (signal?: AbortSignal) =>
      !(signal?.aborted ?? false) && this.live.get(sessionId) === entry && entry.agentWires.get(agentId) === wire;
    const hasUncheckedEligibleCandidate = (state: AgentResidencyState): boolean => {
      if (!isCurrent()) return false;
      if (this.historyLocatorReader === undefined) return true;
      const activeLimits = this.resolveResidentLimits();
      if (activeLimits === undefined) return false;
      const weight = this.residentWeights.get(key) ?? 0;
      const effective = this.effectiveResidentLimits(key, weight, activeLimits);
      const turns = completedResidentTurnIds(transcript);
      if (turns.length === 0) return false;
      const newestId = newestResidentTurnId(transcript);
      for (const turnId of turns) {
        if (effective.tailTurns > 0 && newestId === turnId) continue;
        const resident = transcript.getTurn(turnId);
        if (resident === undefined || resident.state === 'running') continue;
        const known = state.knownUnreleasable.get(turnId);
        if (known === undefined || known.turn.deref() !== resident) return true;
      }
      return false;
    };
    this.residencyMaintenance.schedule(key, {
      shouldReArm: hasUncheckedEligibleCandidate,
      run: async ({ signal, state, clearAgain }) => {
        try {
          await abortable(wire.flush(), signal);
          if (!isCurrent(signal)) return;
          clearAgain();
          const activeLimits = this.resolveResidentLimits();
          if (activeLimits === undefined) return;
          const initialReport = transcript.residentReport();
          let remainingTurns = initialReport.turns;
          let remainingBytes = initialReport.estimatedBytes;
          const initialEffective = this.aggregateResidentLimits(key, remainingBytes, activeLimits);
          if (remainingTurns <= initialEffective.tailTurns && remainingBytes <= initialEffective.maxBytes) {
            state.knownUnreleasable.clear();
            state.lastWarnedFailureSet = undefined;
            return;
          }
          if (this.historyLocatorReader === undefined) {
            if (!await this.verifyTranscriptLiveCoverage(sessionId, agentId)) return;
            const snapshot = await this.readScreenSnapshot(sessionId, agentId, () => this.liveActiveTurnIds(sessionId, agentId, undefined), signal);
            if (snapshot !== undefined && isCurrent(signal)) this.releaseDurableHistory(entry, agentId, snapshot);
            return;
          }
          const locator = this.detailLocator();
          if (state.verifiedLocator !== locator) {
            state.knownUnreleasable.clear();
            state.verifiedWireFingerprint = undefined;
            state.verifiedLocator = locator;
          }
          const turns = completedResidentTurnIds(transcript);
          const turnSet = new Set(turns);
          for (const [turnId, known] of state.knownUnreleasable) {
            const currentTurn = turnSet.has(turnId) ? transcript.getTurn(turnId) : undefined;
            if (currentTurn === undefined || known.turn.deref() !== currentTurn) {
              state.knownUnreleasable.delete(turnId);
            }
          }
          const initialNewestId = newestResidentTurnId(transcript);
          let hasNewCandidate = false;
          for (const turnId of turns) {
            if (initialEffective.tailTurns > 0 && initialNewestId === turnId) continue;
            const resident = transcript.getTurn(turnId);
            if (resident === undefined || resident.state === 'running') continue;
            const known = state.knownUnreleasable.get(turnId);
            if (known === undefined || known.turn.deref() !== resident) {
              hasNewCandidate = true;
              break;
            }
          }
          const location = await this.historyWireLocation(sessionId, agentId);
          if (!isCurrent(signal)) return;
          const currentWireFp = location === undefined ? undefined : await wireFingerprintForMaintenance(location.wirePath, signal);
          if (!isCurrent(signal)) return;
          if (!hasNewCandidate && currentWireFp !== undefined && currentWireFp === state.verifiedWireFingerprint) {
            return;
          }
          const retained = { notFound: 0, overBudget: 0, mismatch: 0 };
          const retainedByTurn = new Map<string, ResidentProofFailure>();
          let source;
          do {
            source = await locator.prepareResidentProof(sessionId, agentId, signal);
            await new Promise<void>(resolve => { setImmediate(resolve); });
            if (!isCurrent(signal)) return;
          } while (source === undefined);
          const provenTurns: TranscriptTurn[] = [];
          const provenBytesByTurn = new Map<string, number>();
          const durableTasks = new Map<string, TranscriptTask>();
          const durableAttachments = new Map<string, TranscriptAttachment>();
          const durablePrompts = new Map<string, TranscriptPrompt>();
          try {
            for (const turnId of turns) {
              signal.throwIfAborted();
              if (!isCurrent(signal)) return;
              let resident = transcript.getTurn(turnId);
              if (resident === undefined || resident.state === 'running') continue;
              const effective = this.effectiveResidentLimits(key, remainingBytes, activeLimits);
              if (remainingTurns <= effective.tailTurns && remainingBytes <= effective.maxBytes) break;
              const newestId = newestResidentTurnId(transcript);
              if (effective.tailTurns > 0 && newestId === resident.turnId) continue;
              let result: ResidentTurnProofResult | undefined;
              try {
                result = await source.prove(resident, signal);
                if (!isCurrent(signal)) return;
                if (transcript.getTurn(resident.turnId) !== resident) continue;
                if (result.status === 'found') {
                  const turnBytes = estimateResidentTurnBytes(resident);
                  provenTurns.push(resident);
                  provenBytesByTurn.set(resident.turnId, turnBytes);
                  remainingTurns = Math.max(0, remainingTurns - 1);
                  remainingBytes = Math.max(0, remainingBytes - turnBytes);
                  for (const task of result.snapshot.tasks) {
                    const current = transcript.getTask(task.taskId);
                    if (current !== undefined && transcriptResidentValueEquals(current, task)) {
                      durableTasks.set(task.taskId, current);
                    } else if (!durableTasks.has(task.taskId)) {
                      durableTasks.set(task.taskId, task);
                    }
                  }
                  for (const attachment of result.snapshot.attachments) {
                    const current = transcript.getAttachment(attachment.attachmentId);
                    if (current !== undefined && transcriptResidentValueEquals(current, attachment)) {
                      durableAttachments.set(attachment.attachmentId, current);
                    } else if (!durableAttachments.has(attachment.attachmentId)) {
                      durableAttachments.set(attachment.attachmentId, attachment);
                    }
                  }
                  for (const prompt of result.snapshot.prompts) {
                    const current = transcript.getPrompt(prompt.promptId);
                    if (current !== undefined && transcriptResidentValueEquals(current, prompt)) {
                      durablePrompts.set(prompt.promptId, current);
                    } else if (!durablePrompts.has(prompt.promptId)) {
                      durablePrompts.set(prompt.promptId, prompt);
                    }
                  }
                } else {
                  if (result.status === 'not_found') retained.notFound += 1;
                  else if (result.status === 'mismatch') retained.mismatch += 1;
                  else retained.overBudget += 1;
                  retainedByTurn.set(resident.turnId, result.status);
                  state.knownUnreleasable.set(resident.turnId, { turn: new WeakRef(resident), status: result.status });
                }
              } finally { resident = undefined; result = undefined; }
            }
            signal.throwIfAborted();
            if (!isCurrent(signal)) return;
            if (provenTurns.length > 0) {
              const unchangedTurns: TranscriptTurn[] = [];
              for (const proven of provenTurns) {
                if (transcript.getTurn(proven.turnId) === proven) unchangedTurns.push(proven);
              }
              if (unchangedTurns.length > 0) {
                const releaseLimits = this.resolveResidentLimits();
                if (releaseLimits !== undefined) {
                  const batchEffective = this.effectiveResidentLimits(key, initialReport.estimatedBytes, releaseLimits);
                  const released = this.releaseDurableTurns(
                    entry,
                    agentId,
                    transcript,
                    unchangedTurns,
                    {
                      tasks: [...durableTasks.values()],
                      attachments: [...durableAttachments.values()],
                      prompts: [...durablePrompts.values()],
                    },
                    batchEffective,
                    initialReport.estimatedBytes,
                    provenBytesByTurn,
                  );
                  const releasedSet = new Set(released);
                  for (const turnId of released) state.knownUnreleasable.delete(turnId);
                  if (released.length < unchangedTurns.length) {
                    const reconciled = transcript.residentReport();
                    const reconciledEffective = this.aggregateResidentLimits(key, reconciled.estimatedBytes, releaseLimits);
                    const stillOverBudget =
                      reconciled.turns > reconciledEffective.tailTurns ||
                      reconciled.estimatedBytes > reconciledEffective.maxBytes;
                    const newestId = newestResidentTurnId(transcript);
                    if (stillOverBudget) {
                      for (const proven of unchangedTurns) {
                        if (releasedSet.has(proven.turnId)) continue;
                        if (reconciledEffective.tailTurns > 0 && newestId === proven.turnId) continue;
                        if (transcript.getTurn(proven.turnId) !== proven) continue;
                        retained.mismatch += 1;
                        retainedByTurn.set(proven.turnId, 'mismatch');
                        state.knownUnreleasable.set(proven.turnId, { turn: new WeakRef(proven), status: 'mismatch' });
                      }
                    }
                  }
                }
              }
            }
          } finally {
            provenTurns.length = 0;
            provenBytesByTurn.clear();
            durableTasks.clear();
            durableAttachments.clear();
            durablePrompts.clear();
          }
          state.verifiedWireFingerprint = currentWireFp;
          state.verifiedLocator = locator;
          if (retained.notFound + retained.overBudget + retained.mismatch > 0) {
            const signature = failureSetSignature(retainedByTurn);
            if (signature !== state.lastWarnedFailureSet) {
              state.lastWarnedFailureSet = signature;
              this.deps.logger?.warn(
                { sessionId, agentId, ...retained },
                'transcript: retaining turns without matching bounded durable proof',
              );
            }
          } else {
            state.lastWarnedFailureSet = undefined;
          }
        } catch (error: unknown) {
          if (!signal.aborted) {
            this.deps.logger?.warn({ sessionId, agentId, error }, 'transcript: durability clearance failed; keeping resident history');
          }
        }
      },
    });
  }

  onSessionOps(sessionId: string, listener: TranscriptOpsListener): IDisposable | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    let listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.opsListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        const entry = this.opsListeners.get(sessionId);
        if (entry === undefined) return;
        entry.delete(listener);
        if (entry.size === 0) this.opsListeners.delete(sessionId);
      },
    };
  }

  private dispatchOps(sessionId: string, event: TranscriptChangeEvent): void {
    const cursor = this.journalOps(sessionId, event);
    if (cursor === undefined) return;
    const listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event, cursor);
      } catch {
      }
    }
  }

  private journalFor(sessionId: string, agentId: string): AgentOpsJournal | undefined {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return undefined;
    let journal = entry.opsJournals.get(agentId);
    if (journal === undefined) {
      journal = { epoch: randomUUID(), nextSeq: 1, start: 0, batches: [], bytes: 0 };
      entry.opsJournals.set(agentId, journal);
    }
    return journal;
  }

  private journalOps(sessionId: string, event: TranscriptChangeEvent): TranscriptCursor | undefined {
    if (event.ops.length === 0) return undefined;
    const entry = this.live.get(sessionId);
    const journal = this.journalFor(sessionId, event.agentId);
    if (entry === undefined || journal === undefined) return undefined;
    const seq = journal.nextSeq++;
    const bytes = estimateOpsJournalBatchBytes(event.ops, this.opsJournalLimits.maxAgentBytes);
    if (bytes <= this.opsJournalLimits.maxAgentBytes) {
      this.retainOpsJournalBatch(entry, journal, { seq, ops: [...event.ops], bytes });
    } else {
      this.evictOpsJournalBatchesBefore(entry, journal, seq);
    }
    return { epoch: journal.epoch, seq };
  }

  private opsJournalBatchCount(journal: AgentOpsJournal): number {
    return journal.batches.length - journal.start;
  }

  private retainOpsJournalBatch(
    entry: LiveEntry,
    journal: AgentOpsJournal,
    batch: JournaledOpsBatch,
  ): void {
    journal.batches.push(batch);
    journal.bytes += batch.bytes;
    entry.opsJournalSessionBytes += batch.bytes;
    this.opsJournalTotalBytes += batch.bytes;
    for (;;) {
      const overCapacity = this.opsJournalBatchCount(journal) > TRANSCRIPT_OPS_JOURNAL_CAPACITY;
      const overAgent = journal.bytes > this.opsJournalLimits.maxAgentBytes;
      const overSession = entry.opsJournalSessionBytes > this.opsJournalLimits.maxSessionBytes;
      const overTotal = this.opsJournalTotalBytes > this.opsJournalLimits.maxTotalBytes;
      if (!overCapacity && !overAgent && !overSession && !overTotal) return;
      if (!this.evictOpsJournalOldest(entry, journal)) return;
    }
  }

  private evictOpsJournalOldest(entry: LiveEntry, journal: AgentOpsJournal): boolean {
    if (journal.start >= journal.batches.length) return false;
    const batch = journal.batches[journal.start]!;
    journal.batches[journal.start] = undefined;
    journal.start += 1;
    journal.bytes -= batch.bytes;
    entry.opsJournalSessionBytes -= batch.bytes;
    this.opsJournalTotalBytes -= batch.bytes;
    this.opsJournalDroppedBytes += batch.bytes;
    if (
      journal.start >= OPS_JOURNAL_COMPACT_MIN_HEAD &&
      journal.start * 2 >= journal.batches.length
    ) {
      journal.batches.splice(0, journal.start);
      journal.start = 0;
    }
    return true;
  }

  private evictOpsJournalBatchesBefore(
    entry: LiveEntry,
    journal: AgentOpsJournal,
    beforeSeq: number,
  ): void {
    while (
      journal.start < journal.batches.length &&
      journal.batches[journal.start]!.seq < beforeSeq
    ) {
      this.evictOpsJournalOldest(entry, journal);
    }
  }

  private disposeOpsJournal(entry: LiveEntry, journal: AgentOpsJournal): void {
    this.evictOpsJournalBatchesBefore(entry, journal, journal.nextSeq);
  }

  getTranscriptCursor(sessionId: string, agentId: string): TranscriptCursor {
    this.assertReadableAgent(sessionId, agentId);
    const journal = this.journalFor(sessionId, agentId);
    return journal === undefined
      ? { epoch: undefined, seq: 0 }
      : { epoch: journal.epoch, seq: journal.nextSeq - 1 };
  }

  getSeqWatermark(sessionId: string, agentId: string): number {
    return this.getTranscriptCursor(sessionId, agentId).seq;
  }

  getOpsSince(
    sessionId: string,
    agentId: string,
    sinceInput: TranscriptCursor | number,
  ): TranscriptOpsCatchup | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    this.assertReadableAgent(sessionId, agentId);
    const journal = this.journalFor(sessionId, agentId);
    if (journal === undefined) return undefined;
    const since = typeof sinceInput === 'number' ? { epoch: undefined, seq: sinceInput } : sinceInput;
    const throughSeq = journal.nextSeq - 1;
    if ((since.epoch !== undefined && since.epoch !== journal.epoch) || since.seq > throughSeq) {
      return { epoch: journal.epoch, batches: [], throughSeq, complete: false };
    }
    const retained: JournaledOpsBatch[] = [];
    for (let index = journal.start; index < journal.batches.length; index += 1) {
      const batch = journal.batches[index]!;
      if (batch.seq > since.seq) retained.push(batch);
    }
    const complete =
      since.seq === throughSeq ||
      (retained.length > 0 && retained[0]!.seq <= since.seq + 1);
    const batches = retained.map((batch) => ({ seq: batch.seq, ops: batch.ops }));
    return { epoch: journal.epoch, batches, throughSeq, complete };
  }

  private handleLiveOps(sessionId: string, event: TranscriptChangeEvent): void {
    const entry = this.live.get(sessionId);
    if (entry === undefined) {
      this.dispatchOps(sessionId, event);
      return;
    }
    if (event.ops.some((operation) => !isNonHistoryMetaOnlyOp(operation))) {
      this.invalidateInitOnlyLiveProof(entry, event.agentId);
    }
    if (event.ops.some((operation) => operation.op === 'turn.upsert' && operation.turn.state !== 'running')) this.scheduleResidencyMaintenance(sessionId, event.agentId, entry);
    const transcript = entry.store.getAgent(event.agentId);
    let state = entry.agentToolCallStates.get(event.agentId);
    if (state === undefined && transcript !== undefined) {
      state = toolCallStateFromSnapshot(transcript.snapshot());
      entry.agentToolCallStates.set(event.agentId, state);
    }
    const before = state?.toolCallCount;
    if (state !== undefined) applyToolCallOps(state, event.ops);
    const countChanged = state !== undefined && before !== state.toolCallCount;
    if (!countChanged || transcript === undefined) {
      this.dispatchOps(sessionId, event);
      return;
    }
    if (state === undefined) {
      this.dispatchOps(sessionId, event);
      return;
    }
    const history = entry.agentHistory.get(event.agentId);
    const count = history?.status === 'complete' ? state.toolCallCount : undefined;
    const countOp = toolCallCountSetOperation(count);
    this.applyToolCallOperation(transcript, countOp);
    this.dispatchOps(sessionId, {
      agentId: event.agentId,
      ops: [...event.ops, countOp],
    });
  }

  getMaterializedAgentToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    const entry = this.live.get(sessionId);
    const resolved = this.resolvedToolCallCounts.get(sessionId);
    if (entry === undefined) {
      for (const agentId of new Set(agentIds)) {
        const count = resolved?.get(agentId);
        if (count !== undefined) result.set(agentId, count);
      }
      return result;
    }
    for (const agentId of new Set(agentIds)) {
      if (entry.unavailableAgents.has(agentId)) continue;
      if (!this.isTranscriptLiveCoverageVerified(sessionId, agentId)) continue;
      if (entry.agentHistory.get(agentId)?.status === 'complete') {
        const state = entry.agentToolCallStates.get(agentId);
        if (state?.known === true) {
          result.set(agentId, state.toolCallCount);
          continue;
        }
        const transcript = entry.store.getAgent(agentId);
        if (transcript !== undefined) {
          result.set(agentId, countToolCallFrames(transcript.getItems()));
          continue;
        }
      }
      const count = resolved?.get(agentId);
      if (count !== undefined) result.set(agentId, count);
    }
    return result;
  }

  async getAgentToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    const entry = this.live.get(sessionId);
    const candidateAgentIds: string[] = [];
    for (const agentId of new Set(agentIds)) {
      if (!isPlainAgentId(agentId)) continue;
      if (entry?.unavailableAgents.has(agentId)) continue;
      if (!await this.verifyTranscriptLiveCoverage(sessionId, agentId) ||
          !this.isTranscriptLiveCoverageVerified(sessionId, agentId)) continue;
      const history = entry?.agentHistory.get(agentId);
      if (history !== undefined) {
        if (history.status !== 'complete') continue;
        const state = entry?.agentToolCallStates.get(agentId);
        if (state?.known === true) {
          counts.set(agentId, state.toolCallCount);
          continue;
        }
        const transcript = entry?.store.getAgent(agentId);
        if (transcript !== undefined) {
          counts.set(agentId, countToolCallFrames(transcript.getItems()));
          continue;
        }
        continue;
      } else if (entry?.agentToolCallStates.has(agentId)) {
        continue;
      }
      candidateAgentIds.push(agentId);
    }
    if (candidateAgentIds.length === 0) {
      this.rememberToolCallCounts(sessionId, counts);
      return counts;
    }
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) {
      this.rememberToolCallCounts(sessionId, counts);
      return counts;
    }
    const candidates: ToolCallCountCandidate[] = candidateAgentIds.map((agentId) => ({
      agentId,
      wirePath: join(
        this.deps.homeDir,
        SESSIONS_ROOT,
        summary.workspaceId,
        sessionId,
        AGENTS_DIR,
        agentId,
        WIRE_FILE,
      ),
    }));
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate.wirePath);
        if (!Number.isSafeInteger(info.size) || info.size < 0) {
          candidate.reason = 'failed';
          this.forgetToolCallCount(sessionId, candidate.agentId);
          continue;
        }
        candidate.info = info;
        candidate.size = info.size;
        candidate.fingerprint = fileFingerprint(info);
        const cached = this.persistedToolCallStates.get(candidate.wirePath);
        if (cached?.fingerprint === candidate.fingerprint && cached.state.known) {
          candidate.cached = cached.state;
          this.pinPersistedToolCallState(candidate.wirePath);
        } else if (cached !== undefined) {
          this.deletePersistedToolCallState(candidate.wirePath);
        }
      } catch (error) {
        candidate.reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed';
        this.deletePersistedToolCallState(candidate.wirePath);
        this.forgetToolCallCount(sessionId, candidate.agentId);
        this.logToolCallCountFailure(sessionId, candidate.agentId, error);
      }
    }
    let remainingBytes = this.toolCallCountLimits.maxBytesPerRequest;
    let remainingFiles = this.toolCallCountLimits.maxFilesPerRequest;
    try {
      for (const candidate of candidates) {
        let persisted = candidate.cached;
        if (persisted === undefined && candidate.reason === undefined) {
          if (remainingFiles <= 0 || candidate.size === undefined || candidate.info === undefined) {
            candidate.reason = 'budget';
          } else {
            const verificationBytes = candidate.size;
            const countBytes = persisted === undefined ? candidate.size : 0;
            if (verificationBytes > remainingBytes ||
                countBytes > remainingBytes - verificationBytes) {
              candidate.reason = 'budget';
            } else {
              remainingFiles -= 1;
              remainingBytes -= verificationBytes + countBytes;
              const read = await this.readPersistedToolCallState(
                candidate.wirePath,
                candidate.fingerprint as string,
                candidate.size,
                candidate.agentId,
                sessionId,
                candidate.info,
              );
              if (read.known) {
                persisted = read.state;
                if (persisted !== undefined) {
                  this.admitPersistedToolCallState(candidate.wirePath, {
                    fingerprint: read.fingerprint,
                    state: persisted,
                    weight: read.weight,
                  });
                }
              } else {
                candidate.reason = read.reason ?? 'failed';
                this.deletePersistedToolCallState(candidate.wirePath);
                if (candidate.reason !== 'budget') this.forgetToolCallCount(sessionId, candidate.agentId);
              }
            }
          }
        } else if (candidate.reason === undefined && candidate.size !== undefined && candidate.info !== undefined) {
          if (remainingFiles <= 0 || candidate.size > remainingBytes) {
            candidate.reason = 'budget';
          } else {
            remainingFiles -= 1;
            remainingBytes -= candidate.size;
            if (!await this.hasVerifiedWireReceipt(candidate.wirePath, candidate.info)) {
              candidate.reason = 'failed';
              this.deletePersistedToolCallState(candidate.wirePath);
              this.forgetToolCallCount(sessionId, candidate.agentId);
              persisted = undefined;
            }
          }
        }
        if (persisted !== undefined) {
          this.touchPersistedToolCallState(candidate.wirePath);
          const live = entry?.agentToolCallStates.get(candidate.agentId);
          const count = mergeToolCallCount(persisted, live);
          counts.set(candidate.agentId, count);
          this.rememberToolCallCount(sessionId, candidate.agentId, count);
        }
      }
    } finally {
      for (const candidate of candidates) {
        if (candidate.cached !== undefined) this.unpinPersistedToolCallState(candidate.wirePath);
      }
    }
    this.rememberToolCallCounts(sessionId, counts);
    return counts;
  }

  private rememberToolCallCounts(sessionId: string, counts: ReadonlyMap<string, number>): void {
    for (const [agentId, count] of counts) this.rememberToolCallCount(sessionId, agentId, count);
  }

  private rememberToolCallCount(sessionId: string, agentId: string, count: number): void {
    let counts = this.resolvedToolCallCounts.get(sessionId);
    if (counts === undefined) {
      counts = new Map();
      this.resolvedToolCallCounts.set(sessionId, counts);
    }
    counts.set(agentId, count);
  }

  private forgetToolCallCount(sessionId: string, agentId: string): void {
    const counts = this.resolvedToolCallCounts.get(sessionId);
    if (counts === undefined) return;
    counts.delete(agentId);
    if (counts.size === 0) this.resolvedToolCallCounts.delete(sessionId);
  }

  private dispatchToolCallCount(
    sessionId: string,
    transcript: AgentTranscript,
    count: number | undefined,
    force: boolean,
  ): void {
    const op = toolCallCountSetOperation(count);
    const result = transcript.apply([op]);
    if (result.accepted.length > 0) {
      this.dispatchOps(sessionId, { agentId: transcript.agentId, ops: result.accepted });
    } else if (force) {
      this.dispatchOps(sessionId, { agentId: transcript.agentId, ops: [op] });
    }
  }

  private applyToolCallOperation(
    transcript: AgentTranscript,
    operation: TranscriptOperation,
  ): void {
    transcript.apply([operation]);
  }

  private async readPersistedToolCallState(
    wirePath: string,
    fingerprint: string,
    fileSize: number,
    agentId: string,
    sessionId: string,
    info?: WireFileInfo,
  ): Promise<ToolCallReadResult> {
    const key = `${wirePath}\\0${fingerprint}`;
    const existing = this.persistedToolCallReads.get(key);
    if (existing !== undefined) return existing;
    const read = (async (): Promise<ToolCallReadResult> => {
      if (info !== undefined && !await this.hasVerifiedWireReceipt(wirePath, info)) {
        return { fingerprint, weight: fileSize, known: false, reason: 'failed' };
      }
      return this.scanPersistedToolCallState(wirePath, fingerprint, fileSize, agentId);
    })();
    this.persistedToolCallReads.set(key, read);
    try {
      const result = await read;
      if (!result.known && result.reason === 'failed' && result.error !== undefined) {
        this.logToolCallCountFailure(sessionId, agentId, result.error);
      }
      return result;
    } finally {
      if (this.persistedToolCallReads.get(key) === read) this.persistedToolCallReads.delete(key);
    }
  }

  private async scanPersistedToolCallState(
    wirePath: string,
    fingerprint: string,
    fileSize: number,
    agentId: string,
  ): Promise<ToolCallReadResult> {
    const state: MaterializedAgentToolCallState = {
      toolFrameIdsByTurn: new Map(),
      toolCallCount: 0,
      known: true,
    };
    const adapter = new TranscriptWireAdapter(agentId);
    const acceptedDurableFacts = new Set<string>();
    try {
      await this.toolCallCountReader(wirePath, fileSize, {
        maxBytes: fileSize,
        chunkBytes: this.toolCallCountLimits.readChunkBytes,
        decodeRecord: transcriptWindowRecord,
        onRecord: (record) => {
          for (const fact of adapter.add(record)) {
            if (fact.durability === 'durable' && acceptedDurableFacts.has(fact.factId)) continue;
            applyToolCallOps(state, fact.operations);
            if (fact.durability === 'durable') acceptedDurableFacts.add(fact.factId);
          }
        },
      });
      return { fingerprint, state, weight: fileSize, known: true };
    } catch (error) {
      return { fingerprint, weight: fileSize, known: false, reason: 'failed', error };
    }
  }

  private pinPersistedToolCallState(wirePath: string): void {
    this.persistedToolCallPins.set(
      wirePath,
      (this.persistedToolCallPins.get(wirePath) ?? 0) + 1,
    );
  }

  private unpinPersistedToolCallState(wirePath: string): void {
    const count = this.persistedToolCallPins.get(wirePath);
    if (count === undefined || count <= 1) this.persistedToolCallPins.delete(wirePath);
    else this.persistedToolCallPins.set(wirePath, count - 1);
  }

  private touchPersistedToolCallState(wirePath: string): void {
    const entry = this.persistedToolCallStates.get(wirePath);
    if (entry === undefined) return;
    this.persistedToolCallStates.delete(wirePath);
    this.persistedToolCallStates.set(wirePath, entry);
  }

  private deletePersistedToolCallState(wirePath: string): void {
    const entry = this.persistedToolCallStates.get(wirePath);
    if (entry === undefined) return;
    this.persistedToolCallStates.delete(wirePath);
    this.persistedToolCallStateWeight -= entry.weight;
  }

  private admitPersistedToolCallState(
    wirePath: string,
    entry: PersistedToolCallState,
  ): void {
    if (
      this.toolCallCountLimits.maxCacheEntries <= 0 ||
      this.toolCallCountLimits.maxCacheBytes <= 0 ||
      entry.weight > this.toolCallCountLimits.maxCacheBytes
    ) {
      return;
    }
    this.deletePersistedToolCallState(wirePath);
    this.persistedToolCallStates.set(wirePath, entry);
    this.persistedToolCallStateWeight += entry.weight;
    for (;;) {
      const overEntries = this.persistedToolCallStates.size > this.toolCallCountLimits.maxCacheEntries;
      const overBytes = this.persistedToolCallStateWeight > this.toolCallCountLimits.maxCacheBytes;
      if (!overEntries && !overBytes) return;
      const oldest = this.oldestUnpinnedPersistedToolCallState();
      if (oldest === undefined) {
        this.deletePersistedToolCallState(wirePath);
        return;
      }
      this.deletePersistedToolCallState(oldest);
    }
  }

  private oldestUnpinnedPersistedToolCallState(): string | undefined {
    for (const wirePath of this.persistedToolCallStates.keys()) {
      if ((this.persistedToolCallPins.get(wirePath) ?? 0) === 0) return wirePath;
    }
    return undefined;
  }

  private logToolCallCountFailure(sessionId: string, agentId: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    this.deps.logger?.warn(
      { sessionId, agentId, err: detail },
      'transcript: tool-call count unavailable',
    );
  }

  private logTranscriptFailure(sessionId: string, agentId: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    this.deps.logger?.warn(
      { sessionId, agentId, err: detail },
      'transcript: history snapshot unavailable',
    );
  }

  private async historyFailureChanged(
    sessionId: string,
    agentId: string,
    prior: AgentHistoryState,
  ): Promise<boolean> {
    const current = await this.historyFailureSignature(sessionId, agentId);
    return current !== prior.failureSignature;
  }

  private async historyFailureSignature(sessionId: string, agentId: string): Promise<string> {
    if (!isPlainAgentId(agentId)) return 'invalid';
    try {
      const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
      if (summary === undefined) return 'unknown';
      const wirePath = join(
        this.deps.homeDir,
        SESSIONS_ROOT,
        summary.workspaceId,
        sessionId,
        AGENTS_DIR,
        agentId,
        WIRE_FILE,
      );
      try {
        const info = await stat(wirePath);
        if (!Number.isSafeInteger(info.size) || info.size < 0) return 'invalid';
        const receipt = await stat(join(dirname(wirePath), WIRE_TRANSCRIPT_RECEIPT_KEY)).catch(() => undefined);
        return `file:${fileFingerprint(info)}:receipt:${receipt === undefined ? 'missing' : fileFingerprint(receipt)}`;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code === 'ENOENT' ? 'missing' : `error:${code ?? 'unknown'}`;
      }
    } catch {
      return 'unknown';
    }
  }

  /**
   * Roster for a cold session, read from the persisted session metadata
   * (`<sessionDir>/state.json`) and mapped like the live seeding
   * (`descriptorFromMeta`). Returns `undefined` when the session is unknown
   * to the index; an unreadable or missing metadata file yields an empty
   * roster (best-effort — transcripts work without descriptors).
   */
  async readColdRoster(sessionId: string, signal?: AbortSignal): Promise<AgentDescriptor[] | undefined> {
    signal?.throwIfAborted();
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId, undefined, signal);
    signal?.throwIfAborted();
    if (summary === undefined) return undefined;
    const path = join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, STATE_FILE);
    let revision: string;
    let meta: SessionMeta;
    try {
      const statPromise = stat(path, { bigint: true });
      revision = stateFingerprint(signal === undefined ? await statPromise : await abortable(statPromise, signal));
      const cached = this.coldRosterCache.get(sessionId);
      if (cached?.revision === revision) {
        this.coldRosterCache.delete(sessionId);
        this.coldRosterCache.set(sessionId, cached);
        return [...cached.roster];
      }
      meta = JSON.parse(await readFile(path, { encoding: 'utf-8', signal })) as SessionMeta;
    } catch (error) {
      if (signal?.aborted === true || (error instanceof Error && (error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR'))) throw error;
      return [];
    }
    signal?.throwIfAborted();
    const roster = Object.entries(meta.agents ?? {}).map(([agentId, agentMeta]) =>
      descriptorFromMeta(agentId, agentMeta),
    );
    const afterStat = stat(path, { bigint: true });
    const after = await (signal === undefined ? afterStat : abortable(afterStat, signal)).catch(() => undefined);
    signal?.throwIfAborted();
    this.coldRosterCache.delete(sessionId);
    if (after !== undefined && stateFingerprint(after) === revision) {
      this.coldRosterCache.set(sessionId, { revision, roster });
      while (this.coldRosterCache.size > COLD_ROSTER_CACHE_MAX_ENTRIES) {
        this.coldRosterCache.delete(this.coldRosterCache.keys().next().value!);
      }
    }
    return [...roster];
  }

  private deleteColdSnapshotCache(key: string): void {
    const entry = this.coldSnapshotCache.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.coldSnapshotCache.delete(key);
    this.coldSnapshotCacheBytes -= entry.bytes;
  }

  private admitColdSnapshotCache(key: string, fingerprint: string, snapshot: AgentTranscriptSnapshot, pageOnly = false): void {
    if (!pageOnly && snapshot.toolCallCountKnown !== true) return;
    const bytes = estimateColdSnapshotBytes(snapshot, COLD_SNAPSHOT_CACHE_MAX_BYTES);
    if (bytes > COLD_SNAPSHOT_CACHE_MAX_BYTES) return;
    this.deleteColdSnapshotCache(key);
    while (this.coldSnapshotCacheBytes + bytes > COLD_SNAPSHOT_CACHE_MAX_BYTES ||
           this.coldSnapshotCache.size >= COLD_SNAPSHOT_CACHE_MAX_ENTRIES) {
      const oldest = this.coldSnapshotCache.keys().next().value;
      if (oldest === undefined) break;
      this.deleteColdSnapshotCache(oldest);
    }
    const expiresAt = Date.now() + COLD_SNAPSHOT_CACHE_TTL_MS;
    const timer = setTimeout(() => {
      if (this.coldSnapshotCache.get(key)?.timer === timer) this.deleteColdSnapshotCache(key);
    }, COLD_SNAPSHOT_CACHE_TTL_MS);
    timer.unref();
    this.coldSnapshotCache.set(key, { snapshot, fingerprint, pageOnly, bytes, expiresAt, timer });
    this.coldSnapshotCacheBytes += bytes;
  }

  /**
   * Rebuild one agent's transcript snapshot for a cold session from its
   * persisted wire records, continuing across cold-read scheduling slices.
   * Cold reads of the same session and agent that carry no `preserveOpenTurnIds`
   * share a single wire scan (that callback decides the projection, so callers
   * with one keep their own scan), and a shared scan is cancelled as soon as no
   * caller is left waiting for it.
   *
   * Byte, record and line budgets yield between complete records, never cap
   * accessible history. One indivisible record may exceed a scheduling slice.
   * Corruption and IO failures reject; a partial tail retains its readable
   * prefix with unknown coverage. Returns `undefined` for an unknown session.
   */
  async readColdSnapshot(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
    preserveOpenTurnIds?: () => readonly string[],
    signal?: AbortSignal,
    captureReplayState?: (state: TranscriptReplayState) => void,
    tailFirst = false,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    await this.live.get(sessionId)?.pendingDisposals.get(agentId);
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    if (preserveOpenTurnIds !== undefined) {
      const snapshot = await this.loadColdSnapshot(
        sessionId,
        agentId,
        preserveOpenTurnIds,
        signal ?? new AbortController().signal,
        undefined,
        undefined,
        captureReplayState,
        tailFirst,
      );
      this.assertReadableAgent(sessionId, agentId);
      return snapshot;
    }
    const key = `${sessionId}\0${agentId}\0${tailFirst}`;
    let flight = this.coldSnapshotFlights.get(key);
    if (flight !== undefined && !flight.controller.signal.aborted) this.coldReadsShared += 1;
    if (flight === undefined || flight.controller.signal.aborted) {
      const controller = new AbortController();
      let created!: ColdSnapshotFlight;
      const promise = Promise.resolve()
        .then(() => this.loadColdSnapshot(sessionId, agentId, undefined, controller.signal, undefined, undefined, undefined, tailFirst))
        .finally(() => {
          created.settled = true;
          if (this.coldSnapshotFlights.get(key) === created) this.coldSnapshotFlights.delete(key);
        });
      created = { controller, promise, waiters: 0, settled: false };
      flight = created;
      this.coldSnapshotFlights.set(key, flight);
    }
    const snapshot = await this.awaitColdSnapshot(flight, signal);
    this.assertReadableAgent(sessionId, agentId);
    return snapshot;
  }

  /** Cache a fingerprint-bound page projection and bounded tail turns for immediate continuations. */
  async readColdPageSnapshot(sessionId: string, agentId: string,
    project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot,
    signal?: AbortSignal, extendOlder = false, spanBytes = FIRST_SCREEN_WINDOW_BYTES, preserveWindow = false, tailFirst = false, boundedPage = false): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) {
      const fallback = await this.readColdSnapshot(sessionId, agentId, undefined, signal);
      return fallback === undefined ? undefined : project(fallback);
    }
    const { wirePath } = location;
    const info = await stat(wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) {
      const fallback = await this.readColdSnapshot(sessionId, agentId, undefined, signal);
      return fallback === undefined ? undefined : project(fallback);
    }
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    if (info.size <= (tailFirst || boundedPage ? FIRST_SCREEN_WINDOW_BYTES : FIRST_SCREEN_WINDOW_MAX_BYTES)) {
      if (this.coldWireWindows.has(wirePath)) {
        this.forgetColdWindow(wirePath);
        this.deleteRetainedColdTurns(wirePath);
        this.deleteColdSnapshotCache(wirePath);
      }
      return this.readLegacyColdPageSnapshot(sessionId, agentId, project, signal, tailFirst || boundedPage);
    }
    const retained = this.retainedColdTurns.get(wirePath);
    if (retained !== undefined && retained.fingerprint !== fingerprint) this.deleteRetainedColdTurns(wirePath);
    const opened = signal ?? new AbortController().signal;
    if (!extendOlder && !preserveWindow) {
      const existing = this.coldWireWindows.get(wirePath);
      if (existing !== undefined && existing.fingerprint === fingerprint && (existing.droppedTail === true || existing.end < info.size)) {
        this.forgetColdWindow(wirePath);
        this.deleteRetainedColdTurns(wirePath);
        this.deleteColdSnapshotCache(wirePath);
      }
    }
    if (extendOlder) {
      const span = spanBytes > 0 ? spanBytes : FIRST_SCREEN_WINDOW_BYTES;
      const extended = await this.extendColdWireWindow(sessionId, agentId, wirePath, info, fingerprint, opened, undefined, undefined, span, !tailFirst);
      if (extended === undefined) {
        return this.readLegacyColdPageSnapshot(sessionId, agentId, project, signal, false);
      }
      return this.publishColdWindow(sessionId, agentId, wirePath, extended.fingerprint, extended, project, opened);
    }
    const cached = this.coldSnapshotCache.get(wirePath);
    const cachedWindow = this.coldWireWindows.get(wirePath);
    const cachedWindowValid = cachedWindow !== undefined && await this.matchesAppendSafeWitness(wirePath, cachedWindow, info, opened);
    const windowCoversTail = cachedWindow !== undefined &&
      (cachedWindow.entire || (cachedWindow.end >= info.size && cachedWindow.droppedTail !== true));
    const windowReusable = cachedWindow !== undefined && cachedWindowValid && (preserveWindow
      ? tailFirst || cachedWindow.entire || cachedWindow.start === 0 || cachedWindow.headers !== undefined
      : windowCoversTail && (tailFirst || cachedWindow.entire || cachedWindow.headers !== undefined));
    const cacheMatches = cached !== undefined && (cached.fingerprint === fingerprint || (preserveWindow && cachedWindow !== undefined && cached.fingerprint === cachedWindow.fingerprint));
    if (cached !== undefined && cacheMatches && cached.expiresAt > Date.now() && cached.pageOnly && windowReusable) {
      signal?.throwIfAborted();
      this.assertReadableAgent(sessionId, agentId);
      if (preserveWindow && cachedWindow !== undefined && info.size > cachedWindow.end) {
        cachedWindow.droppedTail = true;
      }
      this.admitColdSnapshotCache(wirePath, cached.fingerprint, cached.snapshot, true);
      const projected = project(cached.snapshot);
      this.contiguousColdSnapshots.add(projected);
      return projected;
    }
    if (cached !== undefined) this.deleteColdSnapshotCache(wirePath);
    const mode = !tailFirst ? 'headers' : preserveWindow ? 'records' : 'first-screen';
    const window = await this.ensureColdWireWindow(sessionId, agentId, wirePath, info, fingerprint, opened, undefined, undefined, mode, preserveWindow);
    if (window === undefined) {
      return this.readLegacyColdPageSnapshot(sessionId, agentId, project, signal, tailFirst || boundedPage);
    }
    const after = await stat(wirePath);
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    const afterValid = await this.matchesAppendSafeWitness(wirePath, window, after, opened);
    if (!afterValid) {
      this.forgetColdWindow(wirePath);
      this.deleteRetainedColdTurns(wirePath);
      this.coldTurnSpans.delete(wirePath);
      this.coldToolTurnIds.delete(wirePath);
      const projected = project({ ...partialColdWindowSnapshot(window), hasMoreOlder: window.start > 0 });
      this.contiguousColdSnapshots.add(projected);
      return projected;
    }
    if (after.size > window.end) window.droppedTail = true;
    return this.publishColdWindow(sessionId, agentId, wirePath, window.fingerprint, window, project, opened);
  }

  private publishColdWindow(sessionId: string, agentId: string, wirePath: string, fingerprint: string,
    window: ColdWireWindow, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot, signal: AbortSignal,
  ): AgentTranscriptSnapshot {
    signal.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    this.retainColdTailTurns(wirePath, fingerprint, { ...window.snapshot,
      items: window.snapshot.items.filter(item => item.kind !== 'turn' || completeColdWindowTurn(window, item.turnId) !== undefined) });
    const unprojected = { ...partialColdWindowSnapshot(window), hasMoreOlder: window.start > 0 };
    this.admitColdSnapshotCache(wirePath, fingerprint, unprojected, true);
    const projected = project(unprojected);
    this.contiguousColdSnapshots.add(projected);
    return projected;
  }

  private async readScreenSnapshot(sessionId: string, agentId: string,
    preserveOpenTurnIds?: () => readonly string[], signal?: AbortSignal,
    captureReplayState?: (state: TranscriptReplayState) => void, tailFirst = false,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return this.readColdSnapshot(sessionId, agentId, preserveOpenTurnIds, signal, captureReplayState);
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) return this.readColdSnapshot(sessionId, agentId, preserveOpenTurnIds, signal, captureReplayState);
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    if (info.size <= (tailFirst ? FIRST_SCREEN_WINDOW_BYTES : FIRST_SCREEN_WINDOW_MAX_BYTES)) {
      return this.readColdSnapshot(sessionId, agentId, preserveOpenTurnIds, signal, captureReplayState, tailFirst);
    }
    const opened = signal ?? new AbortController().signal;
    const window = await this.ensureColdWireWindow(sessionId, agentId, location.wirePath, info, fingerprint, opened, preserveOpenTurnIds, captureReplayState, tailFirst ? 'first-screen' : 'headers', false);
    if (window === undefined) {
      return this.readColdSnapshot(sessionId, agentId, preserveOpenTurnIds, signal, captureReplayState, tailFirst);
    }
    if (tailFirst) {
      const after = await stat(location.wirePath, { bigint: true }).catch(() => undefined);
      const proof = window.navigationProof;
      const unchangedStat =
        after !== undefined &&
        after.isFile() &&
        proof !== undefined &&
        `${after.dev}:${after.ino}:${after.birthtimeNs}` === proof.identity &&
        Number(after.size) === proof.size &&
        String(after.mtimeNs) === proof.mtimeNs &&
        String(after.ctimeNs) === proof.ctimeNs;
      if (!unchangedStat) {
        const currentProof = await historyNavigationProof(location.wirePath, info.size, opened);
        if (proof !== undefined && !matchesNavigationProof(proof, currentProof)) {
          this.forgetColdWindow(location.wirePath);
          throw new Error('history_source_changed');
        }
        window.navigationProof = currentProof;
      }
    }
    opened.throwIfAborted();
    return partialColdWindowSnapshot(window);
  }

  async coldHistoryTruncated(sessionId: string, agentId: string): Promise<boolean> {
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return false;
    const window = this.coldWireWindows.get(location.wirePath);
    return window !== undefined && window.start > 0;
  }

  async coldWindowBoundary(sessionId: string, agentId: string): Promise<{ fingerprint: string; start: number; end: number } | undefined> {
    const location = await this.historyWireLocation(sessionId, agentId);
    const window = location === undefined ? undefined : this.coldWireWindows.get(location.wirePath);
    return window === undefined ? undefined : { fingerprint: window.fingerprint, start: window.start, end: window.end };
  }

  async coldWindowReachedStart(sessionId: string, agentId: string): Promise<boolean> {
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return false;
    const window = this.coldWireWindows.get(location.wirePath);
    return window !== undefined && window.payloadEvicted !== true && window.start === 0;
  }

  private async readLegacyColdPageSnapshot(sessionId: string, agentId: string,
    project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot,
    signal?: AbortSignal, tailFirst = false): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) {
      const fallback = await this.readColdSnapshot(sessionId, agentId, undefined, signal);
      return fallback === undefined ? undefined : project(fallback);
    }
    const { wirePath } = location;
    const info = await stat(wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) {
      const fallback = await this.readColdSnapshot(sessionId, agentId, undefined, signal);
      return fallback === undefined ? undefined : project(fallback);
    }
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    const retained = this.retainedColdTurns.get(wirePath);
    if (retained !== undefined && retained.fingerprint !== fingerprint) this.deleteRetainedColdTurns(wirePath);
    const cached = this.coldSnapshotCache.get(wirePath);
    if (cached !== undefined) {
      const fresh = cached.fingerprint === fingerprint && cached.expiresAt > Date.now();
      const reusable = fresh && (tailFirst || cached.pageOnly ||
        await this.hasVerifiedWireReceipt(wirePath, info, signal ?? new AbortController().signal) ||
        await this.hasVerifiedLiveEpoch(sessionId, agentId));
      if (reusable) {
        signal?.throwIfAborted();
        this.assertReadableAgent(sessionId, agentId);
        this.admitColdSnapshotCache(wirePath, fingerprint, cached.snapshot, cached.pageOnly);
        const projected = project(cached.snapshot);
        this.contiguousColdSnapshots.add(projected);
        return projected;
      }
      this.deleteColdSnapshotCache(wirePath);
    }
    const snapshot = await this.readColdSnapshot(sessionId, agentId, undefined, signal, undefined, tailFirst);
    if (snapshot === undefined) return snapshot;
    const after = await stat(wirePath);
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    if (`${fileIdentity(after)}:${fileFingerprint(after)}` !== fingerprint) {
      this.deleteRetainedColdTurns(wirePath);
      const projected = project(snapshot);
      this.contiguousColdSnapshots.add(projected);
      return projected;
    }
    this.retainColdTailTurns(wirePath, fingerprint, snapshot);
    const unprojected = this.completeColdReplays.has(snapshot) ? { ...snapshot, hasMoreOlder: false } : snapshot;
    this.admitColdSnapshotCache(wirePath, fingerprint, unprojected, true);
    const projected = project(unprojected);
    this.contiguousColdSnapshots.add(projected);
    return projected;
  }

  private async resolveColdWindowHeaders(sessionId: string, agentId: string, wirePath: string,
    window: ColdWireWindow, signal: AbortSignal, preserveOpenTurnIds?: () => readonly string[],
    captureReplayState?: (state: TranscriptReplayState) => void,
  ): Promise<void> {
    const orphans = window.snapshot.items.filter((item): item is TranscriptTurn => item.kind === 'turn' &&
      item.origin.kind === 'other' && item.message === undefined && item.promptId === undefined && item.startedAt === undefined);
    const existingHeaders = new Map((window.headers ?? []).map((header) => [header.turnId, header]));
    const attachmentsById = new Map((window.headerAttachments ?? []).map((attachment) => [attachment.attachmentId, attachment]));
    let added = false;
    let head: AgentTranscriptSnapshot | undefined;
    const locatorOrphans: string[] = [];
    for (const turn of orphans) {
      signal.throwIfAborted();
      if (existingHeaders.has(turn.turnId)) continue;
      if (turn.turnId === 't0') {
        head ??= await this.projectColdRecords(agentId, (await this.readWireRange(wirePath, 0, Math.min(window.start, FIRST_SCREEN_WINDOW_BYTES), signal)).records, false, undefined, undefined, undefined, signal);
        const header = head.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turn.turnId && item.startedAt !== undefined);
        if (header !== undefined) {
          existingHeaders.set(header.turnId, { ...header, steps: [] });
          for (const attachment of head.attachments) attachmentsById.set(attachment.attachmentId, attachment);
          added = true;
          continue;
        }
      }
      if (this.historyLocatorReader !== undefined) locatorOrphans.push(turn.turnId);
    }
    if (locatorOrphans.length > 0 && this.historyLocatorReader !== undefined) {
      const locator = this.detailLocator();
      if (typeof locator.readCanonicalTurnHeaders === 'function' && locatorOrphans.length > 1) {
        const foundBatch = await locator.readCanonicalTurnHeaders(sessionId, agentId, locatorOrphans, signal);
        for (const turnId of locatorOrphans) {
          const found = foundBatch.get(turnId);
          if (found?.status === 'found') {
            existingHeaders.set(found.turn.turnId, found.turn);
            for (const attachment of found.attachments) attachmentsById.set(attachment.attachmentId, attachment);
            added = true;
          }
        }
      } else {
        for (const turnId of locatorOrphans) {
          signal.throwIfAborted();
          const found = await locator.readCanonicalTurnHeader(sessionId, agentId, turnId, signal);
          if (found.status === 'found') {
            existingHeaders.set(found.turn.turnId, found.turn);
            for (const attachment of found.attachments) attachmentsById.set(attachment.attachmentId, attachment);
            added = true;
          }
        }
      }
    }
    window.headers = [...existingHeaders.values()];
    window.headerAttachments = [...attachmentsById.values()];
    if (added) window.snapshot = await this.projectColdRecords(agentId, window.records, window.entire, preserveOpenTurnIds, captureReplayState, window, signal);
  }

  async resolveOrphanOpenings(sessionId: string, agentId: string, snapshot: AgentTranscriptSnapshot,
    turnIds: readonly string[], signal?: AbortSignal): Promise<AgentTranscriptSnapshot> {
    if (turnIds.length === 0 || this.historyLocatorReader === undefined) return snapshot;
    const locator = this.detailLocator();
    const uniqueTurnIds = [...new Set(turnIds)];
    const foundBatch = typeof locator.readCanonicalTurnHeaders === 'function' && uniqueTurnIds.length > 1
      ? await locator.readCanonicalTurnHeaders(sessionId, agentId, uniqueTurnIds, signal)
      : new Map(await Promise.all(uniqueTurnIds.map(async (turnId) => [turnId, await locator.readCanonicalTurnHeader(sessionId, agentId, turnId, signal)] as const)));
    const headersByTurn = new Map<string, TranscriptTurn>();
    const attachmentsById = new Map(snapshot.attachments.map((attachment) => [attachment.attachmentId, attachment]));
    for (const [turnId, found] of foundBatch) {
      if (found.status !== 'found') continue;
      headersByTurn.set(turnId, found.turn);
      for (const attachment of found.attachments) attachmentsById.set(attachment.attachmentId, attachment);
    }
    if (headersByTurn.size === 0) return snapshot;
    const items = snapshot.items.map((item) => {
      if (item.kind !== 'turn') return item;
      const header = headersByTurn.get(item.turnId);
      if (header === undefined || !(item.origin.kind === 'other' && item.message === undefined && item.promptId === undefined)) return item;
      return {
        ...item,
        origin: header.origin,
        promptId: header.promptId,
        message: header.message,
        prompt: header.prompt,
        presentation: header.presentation,
        attachmentIds: header.attachmentIds,
        startedAt: header.startedAt,
        delivery: header.delivery,
      };
    });
    return { ...snapshot, items, attachments: [...attachmentsById.values()] };
  }

  private async ensureColdWireWindow(sessionId: string, agentId: string, wirePath: string,
    info: { size: number; mtimeMs: number; ctimeMs: number; dev: number | bigint; ino: number | bigint; birthtimeMs: number },
    fingerprint: string, signal: AbortSignal, preserveOpenTurnIds?: () => readonly string[],
    captureReplayState?: (state: TranscriptReplayState) => void, mode: 'headers' | 'records' | 'first-screen' = 'headers',
    allowDroppedTail = false,
  ): Promise<ColdWireWindow | undefined> {
    const resolveHeaders = mode === 'headers';
    const existing = this.coldWireWindows.get(wirePath);
    const existingMatches = existing !== undefined && existing.payloadEvicted !== true && (
      allowDroppedTail
        ? await this.matchesAppendSafeWitness(wirePath, existing, info, signal)
        : existing.fingerprint === fingerprint && existing.droppedTail !== true && existing.end >= info.size
    );
    if (existing !== undefined && existingMatches) {
      if (allowDroppedTail && info.size > existing.end) existing.droppedTail = true;
      if (resolveHeaders && !existing.entire && existing.end >= info.size && existing.headers === undefined) {
        await this.resolveColdWindowHeaders(sessionId, agentId, wirePath, existing, signal, undefined, undefined);
        existing.bytes = this.coldWindowBytes(existing.snapshot, existing.records);
        this.rememberColdWindow(wirePath, existing);
        this.deleteColdSnapshotCache(wirePath);
      }
      if (preserveOpenTurnIds === undefined && captureReplayState !== undefined && existing.replayState !== undefined) {
        captureReplayState(structuredClone(existing.replayState));
        return existing;
      }
      if (preserveOpenTurnIds !== undefined || captureReplayState !== undefined) {
        const snapshot = await this.projectColdRecords(agentId, existing.records, existing.entire, preserveOpenTurnIds, captureReplayState, existing, signal);
        return { ...existing, snapshot };
      }
      return existing;
    }
    if (existing !== undefined) this.forgetColdWindow(wirePath);
    const flightKey = `${wirePath}\0${fingerprint}\0${mode}`;
    let flight = this.coldWindowFlights.get(flightKey);
    if (flight !== undefined && !flight.controller.signal.aborted) {
      this.coldReadsShared += 1;
      const shared = await this.awaitColdWindowFlight(flight, signal);
      if (shared !== undefined) {
        if (preserveOpenTurnIds === undefined && captureReplayState !== undefined && shared.replayState !== undefined) {
          captureReplayState(structuredClone(shared.replayState));
          return shared;
        }
        if (preserveOpenTurnIds !== undefined || captureReplayState !== undefined) {
          const snapshot = await this.projectColdRecords(agentId, shared.records, shared.entire, preserveOpenTurnIds, captureReplayState, shared, signal);
          return { ...shared, snapshot };
        }
      }
      return shared;
    }
    const controller = new AbortController();
    let created!: ColdWindowFlight;
    const promise = Promise.resolve()
      .then(() => this.buildColdWireWindow(sessionId, agentId, wirePath, info, fingerprint, controller.signal, undefined, undefined, mode))
      .finally(() => {
        created.settled = true;
        if (this.coldWindowFlights.get(flightKey) === created) this.coldWindowFlights.delete(flightKey);
      });
    created = { controller, promise, waiters: 0, settled: false };
    flight = created;
    this.coldWindowFlights.set(flightKey, flight);
    const built = await this.awaitColdWindowFlight(flight, signal);
    if (built !== undefined) {
      if (preserveOpenTurnIds === undefined && captureReplayState !== undefined && built.replayState !== undefined) {
        captureReplayState(structuredClone(built.replayState));
        return built;
      }
      if (preserveOpenTurnIds !== undefined || captureReplayState !== undefined) {
        const snapshot = await this.projectColdRecords(agentId, built.records, built.entire, preserveOpenTurnIds, captureReplayState, built, signal);
        return { ...built, snapshot };
      }
    }
    return built;
  }

  private async awaitColdWindowFlight(flight: ColdWindowFlight, signal: AbortSignal): Promise<ColdWireWindow | undefined> {
    signal.throwIfAborted();
    flight.waiters += 1;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([flight.promise, aborted]);
    } catch (error) {
      if (signal.aborted) this.coldReadsCancelled += 1;
      throw error;
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(new DOMException('No cold wire window readers remain', 'AbortError'));
      }
    }
  }

  private async buildColdWireWindow(sessionId: string, agentId: string, wirePath: string,
    info: { size: number; mtimeMs: number; ctimeMs: number; dev: number | bigint; ino: number | bigint; birthtimeMs: number },
    fingerprint: string, signal: AbortSignal, preserveOpenTurnIds?: () => readonly string[],
    captureReplayState?: (state: TranscriptReplayState) => void, mode: 'headers' | 'records' | 'first-screen' = 'headers',
  ): Promise<ColdWireWindow | undefined> {
    const resolveHeaders = mode === 'headers';
    const witness = await captureWirePrefixWitness(wirePath, info, signal);
    const discovered = mode === 'first-screen' ? await this.firstScreenRecords(agentId, wirePath, info.size, signal) : undefined;
    const start = discovered?.start ?? await this.tailRecordStart(wirePath, info.size, signal);
    const read = discovered ?? await this.readWireRange(wirePath, start, info.size, signal, !resolveHeaders);
    const stamp = await sealStamp(wirePath);
    const spanFingerprint = await this.reconcileColdSpanIndexes(wirePath, info, stamp, signal);
    const spanWitness = witness === undefined ? undefined : { ...witness, sealStamp: stamp };
    if (discovered !== undefined) {
      await this.recordColdTurnSpans(wirePath, spanFingerprint, discovered.spanMarkers, start, info.size, discovered.complete, info.size, undefined, spanWitness, signal);
      this.recordColdToolTurnIds(wirePath, spanFingerprint, discovered.toolTurnIds, spanWitness, spanWitness?.completeTailOffset);
    } else {
      await this.recordColdTurnSpansFromRecords(wirePath, spanFingerprint, read.records, start, info.size, read.complete, info.size, undefined, spanWitness, signal);
      this.recordColdToolTurnIdsFromRecords(wirePath, spanFingerprint, read.records, spanWitness, spanWitness?.completeTailOffset);
    }
    if (start > 0 && read.records[0]?.record.type !== 'branch.base' && hasImplicitTurnRecords(read.records)) {
      return undefined;
    }
    const entire = start === 0 && read.complete && !(discovered?.skippedTurnIds.length);
    let capturedReplayState: TranscriptReplayState | undefined;
    const captureForWindow =
      mode === 'first-screen' && preserveOpenTurnIds === undefined
        ? (state: TranscriptReplayState) => {
            capturedReplayState = state;
            captureReplayState?.(structuredClone(state));
          }
        : captureReplayState;
    const snapshot = await this.projectColdRecords(agentId, read.records, entire, preserveOpenTurnIds, captureForWindow, undefined, signal);
    const window: ColdWireWindow = {
      fingerprint,
      witness,
      visibilityCheckedTo: witness?.completeTailOffset,
      reachedTail: true,
      start,
      end: info.size,
      entire,
      records: read.records,
      snapshot,
      bytes: 0,
      skippedTurnIds: discovered?.skippedTurnIds,
      replayState: capturedReplayState,
      navigationProof: discovered?.navigationProof,
    };
    if (!entire && resolveHeaders) {
      await this.resolveColdWindowHeaders(sessionId, agentId, wirePath, window, signal, preserveOpenTurnIds, captureReplayState);
    }
    window.bytes = this.coldWindowBytes(window.snapshot, window.records);
    this.rememberColdWindow(wirePath, window);
    let visible = window;
    let guard = 0;
    while (mode !== 'first-screen' && visible.snapshot.items.length === 0 && visible.start > 0 && guard < 8) {
      const before = visible.start;
      const extended = await this.extendColdWireWindow(sessionId, agentId, wirePath, info, fingerprint, signal, preserveOpenTurnIds, captureReplayState, undefined, resolveHeaders);
      if (extended === undefined) return undefined;
      if (extended.start === before) break;
      visible = extended;
      guard += 1;
    }
    return visible;
  }

  private async extendColdWireWindow(sessionId: string, agentId: string, wirePath: string,
    info: { size: number; mtimeMs: number; ctimeMs: number; dev: number | bigint; ino: number | bigint; birthtimeMs: number },
    fingerprint: string, signal: AbortSignal, preserveOpenTurnIds?: () => readonly string[],
    captureReplayState?: (state: TranscriptReplayState) => void, spanBytes = FIRST_SCREEN_WINDOW_BYTES, resolveHeaders = true,
  ): Promise<ColdWireWindow | undefined> {
    const retained = this.coldWireWindows.get(wirePath);
    const retainedValid = retained !== undefined && await this.matchesAppendSafeWitness(wirePath, retained, info, signal);
    const window = retainedValid && retained.payloadEvicted === true ? retained :
      await this.ensureColdWireWindow(sessionId, agentId, wirePath, info, fingerprint, signal, preserveOpenTurnIds, captureReplayState, resolveHeaders ? 'headers' : 'records', true);
    if (window === undefined || window.start === 0) return window;
    const next = await this.tailRecordStart(wirePath, window.start, signal, spanBytes);
    if (next >= window.start) return window;
    const read = await this.readWireRange(wirePath, next, window.start, signal, !resolveHeaders);
    const stamp = await sealStamp(wirePath);
    const spanFingerprint = await this.reconcileColdSpanIndexes(wirePath, info, stamp, signal);
    const spanWitness = window.witness === undefined ? undefined : { ...window.witness, sealStamp: stamp };
    const nextBoundary = firstTurnOpeningOffset(window.records)
      ?? this.nextKnownTurnStartAtOrAfter(wirePath, spanFingerprint, window.start)
      ?? (window.end === info.size && window.droppedTail !== true ? info.size : undefined);
    await this.recordColdTurnSpansFromRecords(wirePath, spanFingerprint, read.records, next, window.start, read.complete, info.size, nextBoundary, spanWitness, signal);
    this.recordColdToolTurnIdsFromRecords(wirePath, spanFingerprint, read.records, spanWitness, window.visibilityCheckedTo);
    const merged = [...read.records, ...window.records];
    if (next > 0 && merged[0]?.record.type !== 'branch.base' && hasImplicitTurnRecords(merged)) {
      this.forgetColdWindow(wirePath);
      this.deleteRetainedColdTurns(wirePath);
      this.deleteColdSnapshotCache(wirePath);
      return undefined;
    }
    const entire = next === 0 && read.complete && window.droppedTail !== true && !(window.skippedTurnIds?.length);
    const snapshot = await this.projectColdRecords(agentId, merged, entire, preserveOpenTurnIds, captureReplayState, entire ? undefined : window, signal);
    const bytes = this.coldWindowBytes(snapshot, merged);
    let extended: ColdWireWindow;
    if (window.records.length > 0 && bytes > COLD_WIRE_WINDOW_MAX_BYTES && read.records.length > 0) {
      if (read.complete && !coldPrefixAddsItem(window.snapshot.items, snapshot.items)) {
        const newlySkipped = coldPrefixSkippedTurnIds(window.snapshot.items, snapshot.items);
        const skippedTurnIds = [...new Set([...(window.skippedTurnIds ?? []), ...newlySkipped])];
        const skipped: ColdWireWindow = {
          ...window,
          start: next,
          entire: next === 0 && window.droppedTail !== true && skippedTurnIds.length === 0,
          snapshot: { ...window.snapshot, hasMoreOlder: next > 0 },
          skippedTurnIds: skippedTurnIds.length > 0 ? skippedTurnIds : undefined,
          payloadEvicted: false,
        };
        this.rememberColdWindow(wirePath, skipped);
        this.deleteColdSnapshotCache(wirePath);
        return skipped;
      }
      const fitted = await this.fitOlderColdWindow(agentId, read.records, window, signal, preserveOpenTurnIds, captureReplayState);
      const startAt = read.recordStarts[fitted.keepFrom];
      if (startAt === undefined || startAt >= window.start) return window;
      if (startAt > 0 && fitted.records[0]?.record.type !== 'branch.base' && hasImplicitTurnRecords(fitted.records)) {
        this.forgetColdWindow(wirePath);
        this.deleteRetainedColdTurns(wirePath);
        this.deleteColdSnapshotCache(wirePath);
        return undefined;
      }
      const retainedTurnIds = new Set(fitted.snapshot.items.flatMap(item => item.kind === 'turn' ? [item.turnId] : []));
      const skippedTurnIds = (window.skippedTurnIds ?? []).filter(turnId => turnId === '*' || retainedTurnIds.has(turnId));
      extended = { ...window, start: startAt, entire: false, records: fitted.records,
        snapshot: fitted.snapshot, bytes: fitted.bytes, droppedTail: fitted.droppedTail || window.droppedTail === true,
        skippedTurnIds: skippedTurnIds.length > 0 ? skippedTurnIds : undefined };
    } else {
      const retainedTurnIds = new Set(snapshot.items.flatMap(item => item.kind === 'turn' ? [item.turnId] : []));
      const skippedTurnIds = (window.skippedTurnIds ?? []).filter(turnId => turnId === '*' || retainedTurnIds.has(turnId));
      extended = { ...window, start: next, entire, records: merged, snapshot, bytes,
        skippedTurnIds: skippedTurnIds.length > 0 ? skippedTurnIds : undefined };
    }
    extended.payloadEvicted = false;
    if (!extended.entire && resolveHeaders) {
      await this.resolveColdWindowHeaders(sessionId, agentId, wirePath, extended, signal, preserveOpenTurnIds, captureReplayState);
      extended.bytes = this.coldWindowBytes(extended.snapshot, extended.records);
    }
    this.rememberColdWindow(wirePath, extended);
    this.deleteColdSnapshotCache(wirePath);
    return extended;
  }

  private async fitOlderColdWindow(agentId: string, older: readonly ColdWireRecord[], window: ColdWireWindow,
    signal: AbortSignal, preserveOpenTurnIds?: () => readonly string[], captureReplayState?: (state: TranscriptReplayState) => void,
  ): Promise<{ keepFrom: number; records: ColdWireRecord[]; snapshot: AgentTranscriptSnapshot; bytes: number; droppedTail: boolean }> {
    let yieldedAt = performance.now();
    const maybeYield = async () => {
      if (performance.now() - yieldedAt >= 4) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        signal.throwIfAborted();
        yieldedAt = performance.now();
      }
    };
    const projectFrom = async (keepFrom: number, oldCount: number) => {
      await maybeYield();
      const records = [...older.slice(keepFrom), ...window.records.slice(0, oldCount)];
      const snapshot = await this.projectColdRecords(agentId, records, false, preserveOpenTurnIds, captureReplayState, window, signal);
      await maybeYield();
      return {
        keepFrom, records, snapshot, bytes: this.coldWindowBytes(snapshot, records),
        droppedTail: oldCount < window.records.length,
      };
    };
    const allOld = window.records.length;
    const olderPrefix = new Float64Array(older.length + 1);
    for (let i = 0; i < older.length; i += 1) {
      olderPrefix[i + 1] = olderPrefix[i]! + estimateColdRecordWeight(older[i]!);
      if ((i & 15) === 15) await maybeYield();
    }
    const windowPrefix = new Float64Array(allOld + 1);
    for (let i = 0; i < allOld; i += 1) {
      windowPrefix[i + 1] = windowPrefix[i]! + estimateColdRecordWeight(window.records[i]!);
      if ((i & 15) === 15) await maybeYield();
    }
    const olderTotalWeight = olderPrefix[older.length]!;
    const windowTotalWeight = windowPrefix[allOld]!;
    let ratio = windowTotalWeight > 0 && window.bytes > 0
      ? Math.max(1.05, Math.min(3.5, window.bytes / windowTotalWeight))
      : 2.0;

    const findMaxOldCount = (maxWeight: number): number => {
      if (maxWeight <= 0 || allOld === 0) return 0;
      let low = 0;
      let high = allOld;
      let best = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (windowPrefix[mid]! <= maxWeight) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return best;
    };

    const findMinKeepFrom = (maxWeight: number): number => {
      let low = 0;
      let high = Math.max(0, older.length - 1);
      let best = high;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (olderTotalWeight - olderPrefix[mid]! <= maxWeight) {
          best = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      return best;
    };

    if (older.length === 0) return projectFrom(0, 0);

    let zeroOldCandidate: Awaited<ReturnType<typeof projectFrom>> | undefined;
    if (olderTotalWeight <= COLD_WIRE_WINDOW_MAX_BYTES) {
      const initialOldCount = findMaxOldCount(Math.max(0, (COLD_WIRE_WINDOW_MAX_BYTES * 0.92) / ratio - olderTotalWeight));
      const first = await projectFrom(0, initialOldCount);
      if (first.bytes <= COLD_WIRE_WINDOW_MAX_BYTES) {
        if (initialOldCount < allOld && first.bytes < COLD_WIRE_WINDOW_MAX_BYTES * 0.65) {
          const observedWeight = olderTotalWeight + windowPrefix[initialOldCount]!;
          if (observedWeight > 0) ratio = Math.max(1.02, first.bytes / observedWeight);
          const steppedCount = findMaxOldCount(Math.max(0, (COLD_WIRE_WINDOW_MAX_BYTES * 0.94) / ratio - olderTotalWeight));
          if (steppedCount > initialOldCount) {
            const stepped = await projectFrom(0, steppedCount);
            if (stepped.bytes <= COLD_WIRE_WINDOW_MAX_BYTES) return stepped;
          }
        }
        return first;
      }
      const observedWeight = olderTotalWeight + windowPrefix[initialOldCount]!;
      if (observedWeight > 0) ratio = Math.max(1.05, (first.bytes / observedWeight) * 1.06);
      if (initialOldCount === 0) {
        zeroOldCandidate = first;
      } else {
        const shrunkCount = findMaxOldCount(Math.max(0, (COLD_WIRE_WINDOW_MAX_BYTES * 0.9) / ratio - olderTotalWeight));
        if (shrunkCount > 0 && shrunkCount < initialOldCount) {
          const second = await projectFrom(0, shrunkCount);
          if (second.bytes <= COLD_WIRE_WINDOW_MAX_BYTES) return second;
        }
        zeroOldCandidate = await projectFrom(0, 0);
        if (zeroOldCandidate.bytes <= COLD_WIRE_WINDOW_MAX_BYTES) return zeroOldCandidate;
        if (olderTotalWeight > 0) ratio = Math.max(1.05, (zeroOldCandidate.bytes / olderTotalWeight) * 1.06);
      }
    }

    const lastOlder = older.length - 1;
    if (olderTotalWeight - olderPrefix[lastOlder]! > COLD_WIRE_WINDOW_MAX_BYTES) {
      return projectFrom(lastOlder, 0);
    }
    const estKeepFrom = findMinKeepFrom((COLD_WIRE_WINDOW_MAX_BYTES * 0.9) / ratio);
    let fitted = estKeepFrom === 0 && zeroOldCandidate !== undefined ? zeroOldCandidate : await projectFrom(estKeepFrom, 0);
    if (fitted.bytes > COLD_WIRE_WINDOW_MAX_BYTES) {
      const usedWeight = olderTotalWeight - olderPrefix[fitted.keepFrom]!;
      if (usedWeight > 0) ratio = Math.max(1.05, (fitted.bytes / usedWeight) * 1.08);
      const tighterKeepFrom = Math.max(fitted.keepFrom + 1, findMinKeepFrom((COLD_WIRE_WINDOW_MAX_BYTES * 0.88) / ratio));
      if (tighterKeepFrom < lastOlder) {
        const tighter = await projectFrom(tighterKeepFrom, 0);
        if (tighter.bytes <= COLD_WIRE_WINDOW_MAX_BYTES) fitted = tighter;
        else fitted = await projectFrom(lastOlder, 0);
      } else {
        fitted = await projectFrom(lastOlder, 0);
      }
    }
    if (fitted.bytes < COLD_WIRE_WINDOW_MAX_BYTES * 0.8 && allOld > 0) {
      const keptOlderWeight = olderTotalWeight - olderPrefix[fitted.keepFrom]!;
      if (keptOlderWeight > 0 && fitted.bytes > 0) ratio = Math.max(1.02, fitted.bytes / keptOlderWeight);
      const extraOldCount = findMaxOldCount(Math.max(0, (COLD_WIRE_WINDOW_MAX_BYTES * 0.92) / ratio - keptOlderWeight));
      if (extraOldCount > 0) {
        const withExtra = await projectFrom(fitted.keepFrom, extraOldCount);
        if (withExtra.bytes <= COLD_WIRE_WINDOW_MAX_BYTES) return withExtra;
      }
    }
    return fitted;
  }

  private coldWindowBytes(snapshot: AgentTranscriptSnapshot, records: readonly ColdWireRecord[]): number {
    return estimateColdSnapshotBytes([snapshot, records], COLD_WIRE_WINDOWS_MAX_TOTAL_BYTES + 1);
  }

  private rememberColdWindow(wirePath: string, window: ColdWireWindow): void {
    this.forgetColdWindow(wirePath);
    const retained: ColdWireWindow = window.bytes > COLD_WIRE_WINDOWS_MAX_TOTAL_BYTES ? {
      fingerprint: window.fingerprint, witness: window.witness, start: window.start, end: window.end, entire: false,
      records: [], snapshot: { ...unknownSnapshot(), hasMoreOlder: window.start > 0 }, bytes: 0, droppedTail: true, payloadEvicted: true,
    } : window;
    this.coldWireWindows.set(wirePath, retained);
    this.coldWireWindowBytes += retained.bytes;
    this.trimColdWindows();
  }

  private forgetColdWindow(wirePath: string): void {
    const existing = this.coldWireWindows.get(wirePath);
    if (existing === undefined) return;
    this.coldWireWindows.delete(wirePath);
    this.coldWireWindowBytes -= existing.bytes;
  }

  private trimColdWindows(): void {
    while (this.coldWireWindows.size > COLD_WIRE_WINDOWS_MAX_ENTRIES ||
      this.coldWireWindowBytes + this.retainedColdTurnBytes > COLD_WIRE_WINDOWS_MAX_TOTAL_BYTES) {
      if (this.coldWireWindows.size > COLD_WIRE_WINDOWS_MAX_ENTRIES || this.coldWireWindowBytes > COLD_WIRE_WINDOWS_MAX_TOTAL_BYTES) {
        const oldest = this.coldWireWindows.keys().next().value;
        if (oldest === undefined) break;
        this.forgetColdWindow(oldest);
        continue;
      }
      if (this.retainedColdTurns.size > 0) {
        const oldestRetained = this.retainedColdTurns.keys().next().value;
        if (oldestRetained !== undefined) {
          this.deleteRetainedColdTurns(oldestRetained);
          continue;
        }
      }
      const oldest = this.coldWireWindows.keys().next().value;
      if (oldest === undefined) break;
      this.forgetColdWindow(oldest);
    }
  }

  private deleteRetainedColdTurns(wirePath: string): void {
    const existing = this.retainedColdTurns.get(wirePath);
    if (existing === undefined) return;
    this.retainedColdTurns.delete(wirePath);
    this.retainedColdTurnBytes = Math.max(0, this.retainedColdTurnBytes - existing.bytes);
  }

  private clearRetainedColdTurns(): void {
    this.retainedColdTurns.clear();
    this.retainedColdTurnBytes = 0;
  }

  private setRetainedColdTurns(wirePath: string, entry: { fingerprint: string; turns: Map<string, TranscriptTurn>; bytes: number }): void {
    this.deleteRetainedColdTurns(wirePath);
    this.retainedColdTurns.set(wirePath, entry);
    this.retainedColdTurnBytes += entry.bytes;
    this.trimRetainedColdTurns(wirePath);
    this.trimColdWindows();
  }

  private trimRetainedColdTurns(protectedWirePath?: string): void {
    while (
      this.retainedColdTurns.size > COLD_WIRE_WINDOWS_MAX_ENTRIES ||
      this.retainedColdTurnBytes > RETAINED_COLD_TURNS_MAX_TOTAL_BYTES
    ) {
      let evicted = false;
      for (const candidate of this.retainedColdTurns.keys()) {
        if (candidate === protectedWirePath && this.retainedColdTurns.size > 1) continue;
        this.deleteRetainedColdTurns(candidate);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  private dropColdRetainedForSession(sessionId: string): void {
    for (const wirePath of this.coldSnapshotCache.keys()) {
      if (wirePath.split(/[/\\]/).includes(sessionId)) this.deleteColdSnapshotCache(wirePath);
    }
    for (const wirePath of Array.from(this.retainedColdTurns.keys())) {
      if (wirePath.split(/[/\\]/).includes(sessionId)) this.deleteRetainedColdTurns(wirePath);
    }
    for (const wirePath of this.coldWireWindows.keys()) {
      if (wirePath.split(/[/\\]/).includes(sessionId)) this.forgetColdWindow(wirePath);
    }
    for (const wirePath of this.coldTurnSpans.keys()) {
      if (wirePath.split(/[/\\]/).includes(sessionId)) this.coldTurnSpans.delete(wirePath);
    }
    for (const wirePath of this.coldToolTurnIds.keys()) {
      if (wirePath.split(/[/\\]/).includes(sessionId)) this.coldToolTurnIds.delete(wirePath);
    }
    for (const wirePath of this.anchorWindows.keys()) {
      if (wirePath.split(/[/\\]/).includes(sessionId)) this.anchorWindows.delete(wirePath);
    }
    for (const map of [this.turnStartIndexes, this.anchorOpeningSeeks, this.coldTodosCache]) {
      for (const wirePath of map.keys()) if (wirePath.split(/[/\\]/).includes(sessionId)) map.delete(wirePath);
    }
    for (const key of this.anchorSeeks.keys()) {
      if (key.split(/[/\\]/).includes(sessionId)) this.anchorSeeks.delete(key);
    }
    for (const key of this.proximityMisses.keys()) {
      if (key.split(/[/\\]/).includes(sessionId)) this.proximityMisses.delete(key);
    }
  }

  private async projectColdRecords(agentId: string, records: readonly ColdWireRecord[], sawEntireFile: boolean,
    preserveOpenTurnIds?: () => readonly string[], captureReplayState?: (state: TranscriptReplayState) => void,
    recovered?: Pick<ColdWireWindow, 'headers' | 'headerAttachments'>, signal?: AbortSignal,
  ): Promise<AgentTranscriptSnapshot> {
    const transcript = new AgentTranscriptDraft(agentId);
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter(agentId, {
      turn: (turnId) => transcript.getTurn(turnId),
      tool: (toolCallId) => transcript.getToolCall(toolCallId),
      task: (taskId) => transcript.getTask(taskId),
    });
    if (recovered?.headers?.length) {
      for (const turn of recovered.headers) transcript.apply(snapshotTurnOps({ ...turn, state: 'running', endedAt: undefined }));
      for (const attachment of recovered.headerAttachments ?? []) transcript.apply([{ op: 'attachment.upsert', attachment }]);
      const checkpoint = adapter.checkpoint();
      adapter.restore({ ...checkpoint, turns: recovered.headers.map((turn) => turn.turnId),
        turnIds: recovered.headers.map((turn) => turn.turnId),
        turnHeaders: recovered.headers.map(({ steps: _steps, ...header }) => [header.turnId, { ...header, state: 'running', endedAt: undefined }]),
        canonicalTurns: recovered.headers.map((turn) => turn.turnId) });
    }
    let yieldedAt = performance.now();
    const startOrdinal = records[0]?.position.ordinal;
    for (let index = 0; index < records.length; index += 1) {
      if ((index & 7) === 0) {
        signal?.throwIfAborted();
        if (index > 0 && performance.now() - yieldedAt >= WIRE_YIELD_BUDGET_MS) {
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          signal?.throwIfAborted();
          yieldedAt = performance.now();
        }
      }
      const { record, position } = records[index]!;
      if (typeof record.type !== 'string') throw new Error('wire.jsonl: invalid record');
      reducer.apply(adapter.add(record, { ...position, ordinal: startOrdinal === undefined ? position.ordinal : startOrdinal + index }));
    }
    const preservedTurns: TranscriptTurn[] = [];
    for (const turnId of preserveOpenTurnIds?.() ?? []) {
      const candidate = transcript.getTurn(turnId);
      if (candidate?.state === 'running') preservedTurns.push(structuredClone(candidate));
    }
    captureReplayState?.({ adapter: adapter.checkpoint(), acceptedDurableFacts: reducer.checkpoint() });
    reducer.apply(adapter.finish());
    for (const turn of preservedTurns) transcript.apply(snapshotTurnOps(turn));
    const snapshot = transcript.snapshot();
    if (!sawEntireFile) return { ...snapshot, toolCallCount: undefined, toolCallCountKnown: false, hasMoreOlder: true };
    return { ...snapshot, toolCallCount: undefined, toolCallCountKnown: false, hasMoreOlder: false };
  }

  private firstScreenRecords(agentId: string, wirePath: string, end: number, signal: AbortSignal): Promise<{ start: number; records: ColdWireRecord[]; complete: boolean; skippedTurnIds: string[]; spanMarkers: ScannedSpanMarker[]; toolTurnIds: Array<readonly [string, string]>; navigationProof?: import('../history/historyNavigationProof').HistoryNavigationProof }> {
    return this.scheduleHistoryRead(signal, owned => this.firstScreenRecordsInLane(agentId, wirePath, end, owned), true);
  }

  private async firstScreenRecordsInLane(agentId: string, wirePath: string, end: number, signal: AbortSignal): Promise<{ start: number; records: ColdWireRecord[]; complete: boolean; skippedTurnIds: string[]; spanMarkers: ScannedSpanMarker[]; toolTurnIds: Array<readonly [string, string]>; navigationProof?: import('../history/historyNavigationProof').HistoryNavigationProof }> {
    const records: ColdWireRecord[] = [];
    const spanMarkers: ScannedSpanMarker[] = [];
    const toolTurnIds: Array<readonly [string, string]> = [];
    const skippedTurnIds = new Set<string>();
    const loopBudgetBytes = this.resolveFirstScreenLoopBudgetBytes();
    const compactTurnLoopBytes = this.resolveCompactTurnLoopBytes();
    const compactTurnsReserveBytes = this.resolveCompactTurnsReserveBytes();
    let timelineBytes = 0;
    let compactLoopBytes = 0;
    let currentTurnLoopBytes = 0;
    let scannedRecords = 0;
    let reverseTurn: string | undefined;
    let skippedUnknownTurn = false;
    let complete = true;
    let boundary = end;
    const startedAt = performance.now();
    let navigationProof: import('../history/historyNavigationProof').HistoryNavigationProof | undefined;
    const finish = () => {
      if (skippedUnknownTurn) skippedTurnIds.add('*');
      records.reverse();
      spanMarkers.reverse();
      toolTurnIds.reverse();
      this.coldReadRecords += scannedRecords;
      this.coldReadsCompleted++;
      this.coldReadDurationMs += performance.now() - startedAt;
      return { start: boundary, records, complete, skippedTurnIds: [...skippedTurnIds], spanMarkers, toolTurnIds, navigationProof };
    };
    const opened = await openLogicalWire(wirePath, signal);
    if (opened === undefined) return { start: end, records, complete: false, skippedTurnIds: [], spanMarkers: [], toolTurnIds: [] };
    try {
      navigationProof = await historyNavigationProof(wirePath, end, signal, opened);
    } catch (error) {
      opened.close();
      throw error;
    }
    let position = end;
    let recordEnd = end;
    const suffix: Buffer[] = [];
    let suffixBytes = 0;
    let oversizedLine = false;
    let oversizedLeading: Buffer = Buffer.alloc(0);
    let turns = 0;
    let wantedTurns = DEFAULT_TRANSCRIPT_MEMORY_CONFIG.tailTurns;
    let hasUndo = false;
    let hasImplicitTurn = false;
    let yieldedAt = performance.now();
    const floor = Math.max(0, end - COLD_WIRE_WINDOWS_MAX_TOTAL_BYTES);
    const startChunkRead = (pos: number): { start: number; promise: Promise<Uint8Array> } | undefined => {
      if (pos <= floor) return undefined;
      const chunkStart = Math.max(floor, pos - FIRST_SCREEN_CHUNK_BYTES);
      return { start: chunkStart, promise: opened.readAt(chunkStart, pos - chunkStart) };
    };
    let pendingRead = startChunkRead(position);
    let chunksRead = 0;
    try {
      while (pendingRead !== undefined && scannedRecords < WIRE_COLD_READ_MAX_RECORDS) {
        signal.throwIfAborted();
        const { start, promise } = pendingRead;
        chunksRead += 1;
        pendingRead = chunksRead >= 4 ? startChunkRead(start) : undefined;
        const rawChunk = await promise;
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
        this.coldReadBytes += chunk.byteLength;
        let lineEnd = chunk.length;
        if (position === end && chunk.at(-1) === 0x0a) lineEnd--;
        while (lineEnd > 0) {
          const previous = chunk.lastIndexOf(0x0a, lineEnd - 1);
          if (previous < 0 && start > 0) {
            if (oversizedLine) {
              oversizedLeading = chunk.subarray(0, Math.min(64, lineEnd));
            } else if (suffixBytes + lineEnd > FIRST_SCREEN_WINDOW_MAX_BYTES) {
              oversizedLine = true;
              oversizedLeading = chunk.subarray(0, Math.min(64, lineEnd));
              suffix.length = 0;
              suffixBytes = 0;
            } else {
              suffix.push(chunk.subarray(0, lineEnd));
              suffixBytes += lineEnd;
            }
            break;
          }
          const lineStart = previous + 1;
          const prefix = chunk.subarray(lineStart, lineEnd);
          boundary = start + lineStart;
          if (oversizedLine) {
            const head = prefix.length >= 64 ? prefix : Buffer.concat([prefix, oversizedLeading]);
            const opaque = transcriptOpaqueHeaderRecord(head);
            oversizedLine = false;
            oversizedLeading = Buffer.alloc(0);
            if (opaque === undefined) {
              boundary = recordEnd;
              complete = false;
              if (reverseTurn !== undefined) skippedTurnIds.add(reverseTurn);
              else skippedUnknownTurn = true;
              return finish();
            }
            scannedRecords++;
            records.push({ record: opaque, position: { startByteOffset: boundary, endByteOffset: recordEnd } });
            recordEnd = boundary;
            lineEnd = previous;
            if (performance.now() - yieldedAt >= WIRE_YIELD_BUDGET_MS) {
              await new Promise<void>(resolve => { setImmediate(resolve); });
              signal.throwIfAborted();
              yieldedAt = performance.now();
            }
            continue;
          }
          const line = suffix.length === 0 ? prefix : Buffer.concat([prefix, ...suffix.toReversed()]);
          suffix.length = 0;
          suffixBytes = 0;
          if (line.length > 0) {
            scannedRecords++;
            const isClosedLoopEvent =
              line.length >= LOOP_EVENT_LINE_PREFIX.length &&
              line.subarray(0, LOOP_EVENT_LINE_PREFIX.length).equals(LOOP_EVENT_LINE_PREFIX) &&
              hasClosedJsonObjectFrame(line);
            if (isClosedLoopEvent) {
              const recordBytes = line.byteLength;
              const headTurn = extractTurnIdFromBuffer(line, 512)
                ?? (line.length > 512 ? extractTurnIdFromBuffer(line.subarray(Math.max(0, line.length - 256)), 256) : undefined);
              const projectedReverse = headTurn ?? reverseTurn;
              const projectedCurrentBytes = headTurn !== undefined && reverseTurn !== undefined && reverseTurn !== headTurn ? 0 : currentTurnLoopBytes;
              const turnAlreadySkipped = skippedUnknownTurn || (projectedReverse !== undefined && skippedTurnIds.has(projectedReverse));
              const fitsPrimary = !turnAlreadySkipped && timelineBytes + recordBytes <= loopBudgetBytes;
              const fitsCompact = !turnAlreadySkipped && projectedCurrentBytes + recordBytes <= compactTurnLoopBytes && compactLoopBytes + recordBytes <= compactTurnsReserveBytes;
              if (!fitsPrimary && !fitsCompact) {
                if (headTurn !== undefined) {
                  if (reverseTurn !== undefined && reverseTurn !== headTurn) currentTurnLoopBytes = 0;
                  reverseTurn = headTurn;
                  if (skippedUnknownTurn) {
                    skippedTurnIds.add(headTurn);
                    skippedUnknownTurn = false;
                  }
                }
                const effectiveTurn = headTurn ?? reverseTurn;
                if (effectiveTurn !== undefined) {
                  extractLoopEventToolCallIdsFromBuffer(line, effectiveTurn, toolTurnIds);
                  skippedTurnIds.add(effectiveTurn);
                } else {
                  skippedUnknownTurn = true;
                }
                if (scannedRecords >= WIRE_COLD_READ_MAX_RECORDS) return finish();
                recordEnd = boundary;
                lineEnd = previous;
                if ((line.byteLength >= 16_384 || (scannedRecords & 15) === 0) && performance.now() - yieldedAt >= WIRE_YIELD_BUDGET_MS) {
                  await new Promise<void>(resolve => { setImmediate(resolve); });
                  signal.throwIfAborted();
                  yieldedAt = performance.now();
                }
                continue;
              }
            }
            const isClosedAppendMessage =
              !isClosedLoopEvent &&
              line.length >= APPEND_MESSAGE_LINE_PREFIX.length &&
              line.subarray(0, APPEND_MESSAGE_LINE_PREFIX.length).equals(APPEND_MESSAGE_LINE_PREFIX) &&
              hasClosedJsonObjectFrame(line);
            if (isClosedAppendMessage && (skippedUnknownTurn || (reverseTurn !== undefined && skippedTurnIds.has(reverseTurn)))) {
              const role = extractRoleFromBuffer(line, 512);
              if (
                (role === 'tool' || (role === 'assistant' && !line.includes(HOOK_RESULT_NEEDLE))) &&
                !line.includes(DELIVERY_NEEDLE) &&
                !line.includes(TOOL_CALL_ID_NEEDLE) &&
                !line.includes(TOOL_CALL_ID_SNAKE_NEEDLE) &&
                !line.includes(TOOL_CALLS_NEEDLE)
              ) {
                if (scannedRecords >= WIRE_COLD_READ_MAX_RECORDS) return finish();
                recordEnd = boundary;
                lineEnd = previous;
                if ((line.byteLength >= 16_384 || (scannedRecords & 15) === 0) && performance.now() - yieldedAt >= WIRE_YIELD_BUDGET_MS) {
                  await new Promise<void>(resolve => { setImmediate(resolve); });
                  signal.throwIfAborted();
                  yieldedAt = performance.now();
                }
                continue;
              }
            }
            let record: ContextRecord;
            try {
              record = transcriptWindowRecord(line) ?? JSON.parse(line.toString('utf8')) as ContextRecord;
            } catch (error) {
              if (!(error instanceof SyntaxError) || recordEnd !== end) throw error;
              complete = false;
              recordEnd = boundary;
              lineEnd = previous;
              continue;
            }
            if (record === null || typeof record !== 'object' || typeof record.type !== 'string') throw new Error('wire.jsonl: invalid record');
            const marker = classifySpanMarker(record, boundary, recordEnd);
            if (marker !== undefined) spanMarkers.push(marker);
            const owningTurn = wireTurnId(record);
            if (owningTurn !== undefined) {
              if (reverseTurn !== undefined && reverseTurn !== owningTurn) {
                currentTurnLoopBytes = 0;
              }
              reverseTurn = owningTurn;
              if (skippedUnknownTurn) {
                skippedTurnIds.add(owningTurn);
                skippedUnknownTurn = false;
              }
            }
            const effectiveTurn = owningTurn ?? reverseTurn;
            if (effectiveTurn !== undefined) {
              for (const toolId of extractRecordToolCallIds(record)) {
                toolTurnIds.push([toolId, effectiveTurn]);
              }
            }
            if (record.type === 'context.append_loop_event') {
              const recordBytes = line.byteLength;
              const turnAlreadySkipped = skippedUnknownTurn || (reverseTurn !== undefined && skippedTurnIds.has(reverseTurn));
              if (!turnAlreadySkipped && timelineBytes + recordBytes <= loopBudgetBytes) {
                timelineBytes += recordBytes;
                currentTurnLoopBytes += recordBytes;
                records.push({ record, position: { startByteOffset: boundary, endByteOffset: recordEnd } });
              } else if (
                !turnAlreadySkipped &&
                currentTurnLoopBytes + recordBytes <= compactTurnLoopBytes &&
                compactLoopBytes + recordBytes <= compactTurnsReserveBytes
              ) {
                compactLoopBytes += recordBytes;
                currentTurnLoopBytes += recordBytes;
                records.push({ record, position: { startByteOffset: boundary, endByteOffset: recordEnd } });
              } else if (reverseTurn === undefined) {
                skippedUnknownTurn = true;
              } else {
                skippedTurnIds.add(reverseTurn);
              }
            } else {
              records.push({ record, position: { startByteOffset: boundary, endByteOffset: recordEnd } });
            }
            if (record.type === 'context.undo') hasUndo = true;
            if (record.type === 'context.append_message') {
              const delivery = (record as { delivery?: unknown }).delivery;
              const message = (record as { message?: { role?: unknown; origin?: { kind?: unknown } } }).message;
              const kind = message?.origin?.kind;
              if (delivery === undefined && message?.role === 'user' &&
                  kind !== 'injection' && kind !== 'agent_message' && kind !== 'task' && kind !== 'branch_fold' && kind !== 'external_record') {
                hasImplicitTurn = true;
              }
            }
            if (record.type === 'turn.prompt' || record.type === 'turn_begin') {
              if (owningTurn === undefined) hasImplicitTurn = true;
              if (skippedUnknownTurn) skippedTurnIds.add('*');
              skippedUnknownTurn = false;
              reverseTurn = undefined;
              currentTurnLoopBytes = 0;
              turns++;
            }
            if (!hasImplicitTurn && turns >= wantedTurns) {
              const visible = hasUndo ? (await this.projectColdRecords(agentId, records.toReversed(), false, undefined, undefined, undefined, signal)).items.filter(item => item.kind === 'turn').length : turns;
              if (visible >= DEFAULT_TRANSCRIPT_MEMORY_CONFIG.tailTurns) return finish();
              wantedTurns += DEFAULT_TRANSCRIPT_MEMORY_CONFIG.tailTurns - visible;
            }
            if (scannedRecords >= WIRE_COLD_READ_MAX_RECORDS || record.type === 'branch.base' || (!hasImplicitTurn && record.type === 'context.clear')) return finish();
          }
          recordEnd = boundary;
          lineEnd = previous;
          if (performance.now() - yieldedAt >= WIRE_YIELD_BUDGET_MS) {
            await new Promise<void>(resolve => { setImmediate(resolve); });
            signal.throwIfAborted();
            yieldedAt = performance.now();
          }
        }
        position = start;
        if (pendingRead === undefined) pendingRead = startChunkRead(position);
      }
      if (suffix.length > 0 || oversizedLine) {
        boundary = recordEnd;
        complete = false;
      }
      return finish();
    } finally {
      if (pendingRead !== undefined) await pendingRead.promise.catch(() => undefined);
      opened.close();
    }
  }

  private async tailRecordStart(wirePath: string, end: number, signal: AbortSignal, spanBytes = FIRST_SCREEN_WINDOW_BYTES): Promise<number> {
    if (end <= spanBytes) return 0;
    return (await this.alignRecordStart(wirePath, end - spanBytes, signal)).start!;
  }

  private async alignRecordStart(wirePath: string, offset: number, signal: AbortSignal, budget?: AnchorReadBudget): Promise<{ start?: number; next: number }> {
    if (offset <= 0) return { start: 0, next: 0 };
    const opened = await openLogicalWire(wirePath, signal);
    if (opened === undefined) {
      await (await open(wirePath, 'r')).close();
      return { start: 0, next: 0 };
    }
    let cursor = offset;
    const yieldBudget = createYieldBudget();
    try {
      while (cursor > 0) {
        signal.throwIfAborted();
        const length = Math.min(64 * 1024, cursor, budget?.bytes ?? Number.POSITIVE_INFINITY);
        if (length === 0) return { next: cursor };
        const position = cursor - length;
        const bytes = await opened.readAt(position, length);
        this.coldReadBytes += bytes.byteLength;
        if (budget !== undefined) budget.bytes -= bytes.byteLength;
        signal.throwIfAborted();
        if (bytes.byteLength === 0) break;
        const newline = Buffer.from(bytes).lastIndexOf(0x0a);
        if (newline >= 0) return { start: position + newline + 1, next: position + newline + 1 };
        cursor = position;
        await yieldIfTimeBudgetExceeded(yieldBudget, signal);
      }
    } finally {
      opened.close();
    }
    return { start: 0, next: 0 };
  }

  private readWireRange(wirePath: string, start: number, end: number, signal: AbortSignal, priority = false): ReturnType<TranscriptService['readWireRangeInLane']> {
    return this.scheduleHistoryRead(signal, owned => this.readWireRangeInLane(wirePath, start, end, owned), priority);
  }

  private async readWireRangeInLane(wirePath: string, start: number, end: number, signal: AbortSignal): Promise<{
    records: ColdWireRecord[];
    recordStarts: number[];
    complete: boolean;
  }> {
    const records: ColdWireRecord[] = [];
    const recordStarts: number[] = [];
    const startedAt = Date.now();
    const read = await this.readWireRecordsYielding(wirePath, {
      startByteOffset: start === 0 ? undefined : start,
      endByteOffset: end,
      chunkBytes: this.coldReadLimits.chunkBytes,
      signal,
      decodeRecord: transcriptWindowRecord,
      onRecord: (record, span) => {
        if (record === null || typeof record !== 'object' || typeof record.type !== 'string') throw new Error('wire.jsonl: invalid record');
        records.push({ record, position: { startByteOffset: span.startByteOffset, endByteOffset: span.endByteOffset,
          ordinal: start === 0 ? span.ordinal : undefined } });
        recordStarts.push(span.startByteOffset);
      },
    });
    this.coldReadsCompleted += 1;
    this.coldReadBytes += read.bytesRead;
    this.coldReadRecords += read.recordCount;
    this.coldReadDurationMs += Date.now() - startedAt;
    if (!read.complete && read.incompleteReason !== 'partial_tail') this.coldReadsFenced += 1;
    return { records, recordStarts, complete: read.complete };
  }

  async readColdWindowTurn(sessionId: string, agentId: string, turnId: string, signal?: AbortSignal): Promise<TranscriptTurn | undefined> {
    signal?.throwIfAborted();
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return undefined;
    const window = this.coldWireWindows.get(location.wirePath);
    if (window === undefined || window.payloadEvicted === true) return undefined;
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined || !await this.matchesAppendSafeWitness(location.wirePath, window, info, signal)) return undefined;
    if (info.size > window.end) window.droppedTail = true;
    const item = window.snapshot.items.find(candidate => candidate.kind === 'turn' && candidate.turnId === turnId);
    return item?.kind !== 'turn' ? undefined : completeColdWindowTurn(window, turnId) ?? { ...item, stepsPartial: true };
  }

  async readProjectedColdTurn(sessionId: string, agentId: string, turnId: string, signal?: AbortSignal): Promise<TranscriptTurn | undefined> {
    signal?.throwIfAborted();
    const retained = await this.readRetainedColdTurn(sessionId, agentId, turnId, signal);
    if (retained !== undefined) return retained;
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return undefined;
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) return undefined;
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    const opened = signal ?? new AbortController().signal;
    const turnOf = (window: ColdWireWindow | undefined): TranscriptTurn | undefined =>
      window === undefined ? undefined : completeColdWindowTurn(window, turnId);
    const existing = this.coldWireWindows.get(location.wirePath);
    if (existing !== undefined && existing.payloadEvicted !== true &&
        await this.matchesAppendSafeWitness(location.wirePath, existing, info, opened)) {
      if (info.size > existing.end) existing.droppedTail = true;
      const existingTurn = turnOf(existing);
      if (existingTurn !== undefined) return existingTurn;
    }
    const direct = await this.readDirectColdTurn(agentId, location.wirePath, info, fingerprint, turnId, opened);
    if (direct !== undefined) return direct;
    const window = await this.ensureColdWireWindow(sessionId, agentId, location.wirePath, info, fingerprint, opened, undefined, undefined, 'records');
    const found = turnOf(window);
    if (found !== undefined || window === undefined || window.start === 0) return found;
    if (window.end - window.start > FIRST_SCREEN_WINDOW_BYTES) return undefined;
    return turnOf(await this.extendColdWireWindow(sessionId, agentId, location.wirePath, info, fingerprint, opened, undefined, undefined, FIRST_SCREEN_WINDOW_BYTES, false));
  }

  private resolveDirectTurnMaxBytes(): number {
    return nonNegativeLimit(
      this.deps.coldTurnSpanLimits?.maxDirectTurnBytes ?? envNonNegativeLimit('KIKI_TRANSCRIPT_DIRECT_TURN_MAX_BYTES'),
      DEFAULT_DIRECT_TURN_MAX_BYTES,
    );
  }

  private resolveColdTurnSpanMaxTurns(): number {
    return positiveLimit(
      this.deps.coldTurnSpanLimits?.maxTurnsPerWire ?? envNonNegativeLimit('KIKI_TRANSCRIPT_COLD_TURN_SPAN_MAX_TURNS'),
      DEFAULT_COLD_TURN_SPAN_MAX_TURNS,
    );
  }

  private resolveColdTurnSpanMaxWires(): number {
    return positiveLimit(
      this.deps.coldTurnSpanLimits?.maxWires ?? envNonNegativeLimit('KIKI_TRANSCRIPT_COLD_TURN_SPAN_MAX_WIRES'),
      DEFAULT_COLD_TURN_SPAN_MAX_WIRES,
    );
  }

  private resolveColdToolTurnIdsMaxPerWire(): number {
    return positiveLimit(
      this.deps.coldTurnSpanLimits?.maxToolIdsPerWire ?? envNonNegativeLimit('KIKI_TRANSCRIPT_COLD_TOOL_TURN_IDS_MAX'),
      DEFAULT_COLD_TOOL_TURN_IDS_MAX_PER_WIRE,
    );
  }

  private resolveFirstScreenLoopBudgetBytes(): number {
    return nonNegativeLimit(
      this.deps.coldTurnSpanLimits?.firstScreenLoopBudgetBytes ?? envNonNegativeLimit('KIKI_TRANSCRIPT_FIRST_SCREEN_LOOP_BUDGET_BYTES'),
      FIRST_SCREEN_WINDOW_BYTES,
    );
  }

  private resolveCompactTurnLoopBytes(): number {
    return nonNegativeLimit(
      this.deps.coldTurnSpanLimits?.compactTurnLoopBytes ?? envNonNegativeLimit('KIKI_TRANSCRIPT_COMPACT_TURN_LOOP_BYTES'),
      DEFAULT_COMPACT_TURN_LOOP_BYTES,
    );
  }

  private resolveCompactTurnsReserveBytes(): number {
    return nonNegativeLimit(
      this.deps.coldTurnSpanLimits?.compactTurnsReserveBytes ?? envNonNegativeLimit('KIKI_TRANSCRIPT_COMPACT_TURNS_RESERVE_BYTES'),
      DEFAULT_COMPACT_TURNS_RESERVE_BYTES,
    );
  }

  private async recordColdTurnSpansFromRecords(
    wirePath: string,
    fingerprint: string,
    records: readonly ColdWireRecord[],
    rangeStart: number,
    rangeEnd: number,
    complete: boolean,
    fileSize: number,
    contiguousNextBoundary?: number,
    witness?: WirePrefixWitness,
    signal?: AbortSignal,
  ): Promise<void> {
    const markers: ScannedSpanMarker[] = [];
    const yieldBudget = createYieldBudget();
    for (let index = 0; index < records.length; index += 1) {
      const entry = records[index]!;
      const marker = classifySpanMarker(entry.record, entry.position.startByteOffset, entry.position.endByteOffset);
      if (marker !== undefined) markers.push(marker);
      if ((index & 255) === 255) await yieldIfTimeBudgetExceeded(yieldBudget, signal);
    }
    await this.recordColdTurnSpans(wirePath, fingerprint, markers, rangeStart, rangeEnd, complete, fileSize, contiguousNextBoundary, witness, signal);
  }

  private async recordColdTurnSpans(
    wirePath: string,
    fingerprint: string,
    markers: readonly ScannedSpanMarker[],
    rangeStart: number,
    rangeEnd: number,
    complete: boolean,
    fileSize: number,
    contiguousNextBoundary?: number,
    witness?: WirePrefixWitness,
    signal?: AbortSignal,
  ): Promise<void> {
    if (markers.length === 0) return;
    const maxTurns = this.resolveColdTurnSpanMaxTurns();
    const maxWires = this.resolveColdTurnSpanMaxWires();
    const checkedTo = rangeEnd >= fileSize ? witness?.completeTailOffset : rangeEnd;
    let index = this.coldTurnSpans.get(wirePath);
    if (index !== undefined && index.fingerprint !== fingerprint) {
      this.coldTurnSpans.delete(wirePath);
      index = undefined;
    }
    if (index === undefined) {
      index = { fingerprint, witness, visibilityCheckedTo: checkedTo, spans: new Map(), promptStarts: new Map() };
    } else {
      if (index.witness === undefined && witness !== undefined) {
        index.witness = witness;
      }
      if (index.visibilityCheckedTo === undefined) {
        index.visibilityCheckedTo = checkedTo;
      } else if (checkedTo !== undefined && rangeStart <= index.visibilityCheckedTo && checkedTo > index.visibilityCheckedTo) {
        index.visibilityCheckedTo = checkedTo;
      }
      this.coldTurnSpans.delete(wirePath);
    }
    this.coldTurnSpans.set(wirePath, index);
    while (this.coldTurnSpans.size > maxWires) {
      const oldest = this.coldTurnSpans.keys().next().value;
      if (oldest === undefined || oldest === wirePath) break;
      this.coldTurnSpans.delete(oldest);
    }

    const storeSpan = (turnId: string, startOffset: number, endOffset: number, undoneOrReplaced: boolean): void => {
      if (endOffset <= startOffset || startOffset < 0) return;
      const existing = index!.spans.get(turnId);
      const invalidated = undoneOrReplaced
        || existing?.undoneOrReplaced === true
        || (index!.visibilityResetOffset !== undefined && startOffset < index!.visibilityResetOffset);
      index!.spans.delete(turnId);
      index!.spans.set(turnId, { startOffset, endOffset, undoneOrReplaced: invalidated });
      while (index!.spans.size > maxTurns) {
        const oldest = index!.spans.keys().next().value;
        if (oldest === undefined) break;
        index!.spans.delete(oldest);
      }
    };

    const preTurnByPromptId = new Map<string, number>();
    let openTurn: {
      readonly turnId: string;
      readonly startOffset: number;
      readonly duplicate: boolean;
      readonly promptId?: string;
      readonly userMessageId?: string;
      ended: boolean;
      firstForeignPreTurnOffset?: number;
    } | undefined;

    const belongsToOpenTurn = (
      current: NonNullable<typeof openTurn>,
      marker: ScannedSpanMarker,
    ): boolean => {
      if (marker.turnId !== undefined) return marker.turnId === current.turnId;
      if (current.promptId !== undefined && (marker.promptId === current.promptId || marker.userMessageId === current.promptId)) {
        return true;
      }
      if (current.userMessageId !== undefined && (marker.userMessageId === current.userMessageId || marker.promptId === current.userMessageId)) {
        return true;
      }
      return false;
    };

    const closeOpenTurn = (endOffset: number, forceInvalidated = false): void => {
      if (openTurn === undefined) return;
      const boundedEnd = openTurn.firstForeignPreTurnOffset !== undefined
        ? Math.min(openTurn.firstForeignPreTurnOffset, endOffset)
        : endOffset;
      storeSpan(openTurn.turnId, openTurn.startOffset, boundedEnd, forceInvalidated || openTurn.duplicate);
      openTurn = undefined;
    };

    const markerYieldBudget = createYieldBudget();
    for (let i = 0; i < markers.length; i += 1) {
      if ((i & 255) === 255) await yieldIfTimeBudgetExceeded(markerYieldBudget, signal);
      const marker = markers[i]!;
      if (marker.kind === 'visibility_reset') {
        index.visibilityResetOffset = Math.max(index.visibilityResetOffset ?? 0, marker.endByteOffset);
        for (const [turnId, span] of index.spans) {
          if (!span.undoneOrReplaced && span.startOffset < marker.endByteOffset) {
            index.spans.set(turnId, { ...span, undoneOrReplaced: true });
          }
        }
        closeOpenTurn(marker.startByteOffset, true);
        preTurnByPromptId.clear();
        continue;
      }
      if (marker.kind === 'turn.ended') {
        if (openTurn !== undefined && (marker.turnId === undefined || marker.turnId === openTurn.turnId)) {
          openTurn.ended = true;
          openTurn.firstForeignPreTurnOffset = undefined;
          preTurnByPromptId.clear();
        }
        continue;
      }
      if (marker.kind === 'pre_turn') {
        if (openTurn !== undefined && !belongsToOpenTurn(openTurn, marker)) {
          if (openTurn.ended) {
            storeSpan(openTurn.turnId, openTurn.startOffset, marker.startByteOffset, openTurn.duplicate);
            openTurn = undefined;
          } else if (openTurn.firstForeignPreTurnOffset === undefined) {
            openTurn.firstForeignPreTurnOffset = marker.startByteOffset;
          }
        }
        if (marker.promptId !== undefined && !preTurnByPromptId.has(marker.promptId)) {
          preTurnByPromptId.set(marker.promptId, marker.startByteOffset);
        }
        if (marker.userMessageId !== undefined && !preTurnByPromptId.has(marker.userMessageId)) {
          preTurnByPromptId.set(marker.userMessageId, marker.startByteOffset);
        }
        continue;
      }
      if (marker.kind === 'implicit_turn' || marker.kind === 'turn_begin') {
        closeOpenTurn(marker.startByteOffset);
        preTurnByPromptId.clear();
        continue;
      }
      if (marker.kind === 'turn.prompt' && marker.turnId !== undefined) {
        let startOffset = marker.startByteOffset;
        const preStart = (marker.promptId !== undefined ? preTurnByPromptId.get(marker.promptId) : undefined)
          ?? (marker.userMessageId !== undefined ? preTurnByPromptId.get(marker.userMessageId) : undefined);
        if (
          preStart !== undefined &&
          preStart >= rangeStart &&
          preStart < startOffset &&
          startOffset - preStart <= COLD_TURN_SPAN_PRE_RECORD_MAX_GAP_BYTES
        ) {
          startOffset = preStart;
        }
        closeOpenTurn(Math.min(startOffset, marker.startByteOffset));
        preTurnByPromptId.clear();
        const priorPromptStart = index.promptStarts.get(marker.turnId);
        const duplicate = priorPromptStart !== undefined && priorPromptStart !== startOffset;
        if (duplicate) {
          const existing = index.spans.get(marker.turnId);
          if (existing !== undefined && !existing.undoneOrReplaced) {
            index.spans.set(marker.turnId, { ...existing, undoneOrReplaced: true });
          }
        } else {
          index.promptStarts.delete(marker.turnId);
          index.promptStarts.set(marker.turnId, startOffset);
          while (index.promptStarts.size > maxTurns) {
            const oldest = index.promptStarts.keys().next().value;
            if (oldest === undefined) break;
            index.promptStarts.delete(oldest);
          }
        }
        openTurn = {
          turnId: marker.turnId,
          startOffset,
          duplicate,
          promptId: marker.promptId,
          userMessageId: marker.userMessageId,
          ended: false,
        };
      }
    }

    if (openTurn !== undefined) {
      if (rangeEnd >= fileSize && complete) {
        closeOpenTurn(rangeEnd);
      } else if (contiguousNextBoundary !== undefined && contiguousNextBoundary > openTurn.startOffset) {
        closeOpenTurn(contiguousNextBoundary);
      }
    }
  }

  private nextKnownTurnStartAtOrAfter(wirePath: string, fingerprint: string, offset: number): number | undefined {
    const index = this.coldTurnSpans.get(wirePath);
    if (index === undefined || index.fingerprint !== fingerprint) return undefined;
    let best: number | undefined;
    for (const startOffset of index.promptStarts.values()) {
      if (startOffset >= offset && (best === undefined || startOffset < best)) {
        best = startOffset;
      }
    }
    return best;
  }

  private recordColdToolTurnIdsFromRecords(
    wirePath: string,
    fingerprint: string,
    records: readonly ColdWireRecord[],
    witness?: WirePrefixWitness,
    visibilityCheckedTo?: number,
  ): void {
    const pairs: Array<readonly [string, string]> = [];
    let currentTurnId: string | undefined;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!.record;
      if (record.type === 'context.undo' || record.type === 'context.clear' || record.type === 'branch.base') {
        currentTurnId = undefined;
        continue;
      }
      const recordTurn = wireTurnId(record);
      if (recordTurn !== undefined) currentTurnId = recordTurn;
      const effectiveTurn = recordTurn ?? currentTurnId;
      if (effectiveTurn === undefined) continue;
      for (const toolId of extractRecordToolCallIds(record)) {
        pairs.push([toolId, effectiveTurn]);
      }
    }
    this.recordColdToolTurnIds(wirePath, fingerprint, pairs, witness, visibilityCheckedTo);
  }

  private recordColdToolTurnIds(
    wirePath: string,
    fingerprint: string,
    pairs: readonly (readonly [string, string])[],
    witness?: WirePrefixWitness,
    visibilityCheckedTo?: number,
  ): void {
    if (pairs.length === 0) return;
    const maxWires = this.resolveColdTurnSpanMaxWires();
    const maxToolIds = this.resolveColdToolTurnIdsMaxPerWire();
    let index = this.coldToolTurnIds.get(wirePath);
    if (index !== undefined && index.fingerprint !== fingerprint) {
      this.coldToolTurnIds.delete(wirePath);
      index = undefined;
    }
    if (index === undefined) {
      index = { fingerprint, witness, visibilityCheckedTo, toolTurnIds: new Map() };
    } else {
      if (index.witness === undefined && witness !== undefined) {
        index.witness = witness;
      }
      if (index.visibilityCheckedTo === undefined) {
        index.visibilityCheckedTo = visibilityCheckedTo;
      } else if (visibilityCheckedTo !== undefined && visibilityCheckedTo < index.visibilityCheckedTo) {
        index.visibilityCheckedTo = visibilityCheckedTo;
      }
      this.coldToolTurnIds.delete(wirePath);
    }
    this.coldToolTurnIds.set(wirePath, index);
    while (this.coldToolTurnIds.size > maxWires) {
      const oldest = this.coldToolTurnIds.keys().next().value;
      if (oldest === undefined || oldest === wirePath) break;
      this.coldToolTurnIds.delete(oldest);
    }
    for (let i = 0; i < pairs.length; i += 1) {
      const [toolCallId, turnId] = pairs[i]!;
      if (toolCallId.length === 0 || turnId.length === 0) continue;
      index.toolTurnIds.delete(toolCallId);
      index.toolTurnIds.set(toolCallId, turnId);
      while (index.toolTurnIds.size > maxToolIds) {
        const oldest = index.toolTurnIds.keys().next().value;
        if (oldest === undefined) break;
        index.toolTurnIds.delete(oldest);
      }
    }
  }

  private lookupColdToolTurnId(wirePath: string, spanFingerprint: string, toolCallId: string): string | undefined {
    const index = this.coldToolTurnIds.get(wirePath);
    if (index === undefined) return undefined;
    if (index.fingerprint !== spanFingerprint) {
      this.coldToolTurnIds.delete(wirePath);
      return undefined;
    }
    const turnId = index.toolTurnIds.get(toolCallId);
    if (turnId === undefined) return undefined;
    index.toolTurnIds.delete(toolCallId);
    index.toolTurnIds.set(toolCallId, turnId);
    return turnId;
  }

  private lookupColdTurnSpan(wirePath: string, spanFingerprint: string, turnId: string): ColdTurnByteSpan | undefined {
    const index = this.coldTurnSpans.get(wirePath);
    if (index === undefined) return undefined;
    if (index.fingerprint !== spanFingerprint) {
      this.coldTurnSpans.delete(wirePath);
      this.coldToolTurnIds.delete(wirePath);
      return undefined;
    }
    const span = index.spans.get(turnId);
    if (span === undefined || span.undoneOrReplaced) return undefined;
    if (index.visibilityResetOffset !== undefined && span.startOffset < index.visibilityResetOffset) return undefined;
    index.spans.delete(turnId);
    index.spans.set(turnId, span);
    return span;
  }

  private async readDirectColdTurn(
    agentId: string,
    wirePath: string,
    info: WireFileStat,
    fingerprint: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<TranscriptTurn | undefined> {
    const maxDirectTurnBytes = this.resolveDirectTurnMaxBytes();
    if (maxDirectTurnBytes <= 0) return undefined;
    const stampBefore = await sealStamp(wirePath);
    signal.throwIfAborted();
    const spanFingerprint = await this.reconcileColdSpanIndexes(wirePath, info, stampBefore, signal);
    const spanIndex = this.coldTurnSpans.get(wirePath);
    const span = this.lookupColdTurnSpan(wirePath, spanFingerprint, turnId);
    if (span === undefined) return undefined;
    const spanLength = span.endOffset - span.startOffset;
    if (spanLength <= 0 || spanLength > maxDirectTurnBytes) return undefined;
    const beforeWitness = spanIndex?.witness ?? await captureWirePrefixWitness(wirePath, info, signal, stampBefore);
    const records: ColdWireRecord[] = [];
    let sawPromptForTurn = false;
    let sawVisibilityReset = false;
    let sawImplicitTurn = false;
    const startedAt = Date.now();
    const read = await this.scheduleHistoryRead(signal, (owned) => this.readWireRecordsYielding(wirePath, {
      startByteOffset: span.startOffset === 0 ? undefined : span.startOffset,
      endByteOffset: span.endOffset,
      maxBytes: maxDirectTurnBytes,
      chunkBytes: this.coldReadLimits.chunkBytes,
      signal: owned,
      decodeRecord: transcriptWindowRecord,
      onRecord: (record, recordSpan) => {
        if (record === null || typeof record !== 'object' || typeof record.type !== 'string') {
          throw new Error('wire.jsonl: invalid record');
        }
        const marker = classifySpanMarker(record, recordSpan.startByteOffset, recordSpan.endByteOffset);
        if (marker?.kind === 'visibility_reset') {
          sawVisibilityReset = true;
          return false;
        }
        if (marker?.kind === 'implicit_turn' || marker?.kind === 'turn_begin') {
          sawImplicitTurn = true;
          return false;
        }
        if (marker?.kind === 'turn.prompt' && marker.turnId === turnId) {
          sawPromptForTurn = true;
        }
        records.push({
          record,
          position: {
            startByteOffset: recordSpan.startByteOffset,
            endByteOffset: recordSpan.endByteOffset,
            ordinal: span.startOffset === 0 ? recordSpan.ordinal : undefined,
          },
        });
        return true;
      },
    }), true);
    this.coldReadsCompleted += 1;
    this.coldReadBytes += read.bytesRead;
    this.coldReadRecords += read.recordCount;
    this.coldReadDurationMs += Date.now() - startedAt;
    if (sawVisibilityReset) {
      const index = this.coldTurnSpans.get(wirePath);
      if (index !== undefined && index.fingerprint === spanFingerprint) {
        index.spans.set(turnId, { ...span, undoneOrReplaced: true });
      }
      return undefined;
    }
    if (sawImplicitTurn || !sawPromptForTurn || !read.complete || read.nextByteOffset !== span.endOffset) {
      return undefined;
    }
    const after = await stat(wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const stampAfter = after === undefined ? undefined : await sealStamp(wirePath);
    signal.throwIfAborted();
    if (after === undefined || stampAfter === undefined) {
      this.coldTurnSpans.delete(wirePath);
      this.coldToolTurnIds.delete(wirePath);
      return undefined;
    }
    const exactAfter = `${fileIdentity(after)}:${fileFingerprint(after)}:${stampAfter}` === spanFingerprint;
    if (!exactAfter) {
      const checked = beforeWitness === undefined
        ? { valid: false }
        : await verifyWitnessAppendSafe(wirePath, beforeWitness, after, spanIndex?.visibilityCheckedTo, FIRST_SCREEN_WINDOW_BYTES, signal, stampAfter);
      if (!checked.valid) {
        this.coldTurnSpans.delete(wirePath);
        this.coldToolTurnIds.delete(wirePath);
        return undefined;
      }
      if (spanIndex !== undefined) {
        if (checked.witness !== undefined) spanIndex.witness = checked.witness;
        spanIndex.visibilityCheckedTo = checked.visibilityCheckedTo;
      }
    }
    const snapshot = await this.projectColdRecords(agentId, records, span.startOffset === 0, undefined, undefined, undefined, signal);
    signal.throwIfAborted();
    const turn = snapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId);
    if (
      turn === undefined ||
      turn.stepsPartial === true ||
      (turn.origin.kind === 'other' && turn.message === undefined && turn.promptId === undefined && turn.startedAt === undefined)
    ) {
      return undefined;
    }
    if (exactAfter) this.retainDirectColdTurn(wirePath, fingerprint, turn);
    return turn;
  }

  private retainDirectColdTurn(wirePath: string, fingerprint: string, turn: TranscriptTurn): void {
    const maxEntryBytes = Math.min(RETAINED_COLD_TURN_ENTRY_BYTES, RETAINED_COLD_TURNS_MAX_TOTAL_BYTES);
    const size = estimateColdSnapshotBytes({
      items: [turn], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
    }, maxEntryBytes + 1);
    if (size > maxEntryBytes) return;
    const existing = this.retainedColdTurns.get(wirePath);
    const turns = existing !== undefined && existing.fingerprint === fingerprint
      ? existing.turns
      : new Map<string, TranscriptTurn>();
    let bytes = existing !== undefined && existing.fingerprint === fingerprint ? existing.bytes : 0;
    const prior = turns.get(turn.turnId);
    if (prior !== undefined) {
      const priorSize = estimateColdSnapshotBytes({
        items: [prior], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
      }, maxEntryBytes + 1);
      bytes = Math.max(0, bytes - priorSize);
      turns.delete(turn.turnId);
    }
    const budget = Math.min(RETAINED_COLD_TURNS_MAX_TOTAL_BYTES, Math.max(RETAINED_COLD_TURNS_BYTES, size));
    while (turns.size > 0 && bytes + size > budget) {
      const oldestKey = turns.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = turns.get(oldestKey)!;
      const oldestSize = estimateColdSnapshotBytes({
        items: [oldest], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
      }, maxEntryBytes + 1);
      turns.delete(oldestKey);
      bytes = Math.max(0, bytes - oldestSize);
    }
    turns.set(turn.turnId, structuredClone(turn));
    bytes += size;
    this.setRetainedColdTurns(wirePath, { fingerprint, turns, bytes });
  }

  async readRetainedColdTurn(sessionId: string, agentId: string, turnId: string, signal?: AbortSignal): Promise<TranscriptTurn | undefined> {
    signal?.throwIfAborted();
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return undefined;
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) return undefined;
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    const retained = this.retainedColdTurns.get(location.wirePath);
    if (retained === undefined || retained.fingerprint !== fingerprint) {
      if (retained !== undefined) this.deleteRetainedColdTurns(location.wirePath);
      return undefined;
    }
    return retained.turns.get(turnId);
  }

  private retainColdTailTurns(wirePath: string, fingerprint: string, snapshot: AgentTranscriptSnapshot): void {
    const existing = this.retainedColdTurns.get(wirePath);
    if (existing !== undefined && existing.fingerprint === fingerprint && existing.turns.size > 0) return;
    const maxEntryBytes = Math.min(RETAINED_COLD_TURN_ENTRY_BYTES, RETAINED_COLD_TURNS_MAX_TOTAL_BYTES);
    const turns = new Map<string, TranscriptTurn>();
    let bytes = 0;
    for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
      const item = snapshot.items[index];
      if (item?.kind !== 'turn') continue;
      const size = estimateColdSnapshotBytes({
        items: [item], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
      }, maxEntryBytes + 1);
      if (size > maxEntryBytes || (turns.size > 0 && bytes + size > RETAINED_COLD_TURNS_BYTES)) break;
      turns.set(item.turnId, structuredClone(item));
      bytes += size;
      if (bytes >= RETAINED_COLD_TURNS_BYTES) break;
    }
    if (turns.size === 0) {
      this.deleteRetainedColdTurns(wirePath);
      return;
    }
    this.setRetainedColdTurns(wirePath, { fingerprint, turns, bytes });
  }

  /** Oversized canonical detail cache admission; zero disables retention, never reading. */
  detailCacheBudgetBytes(): number {
    return (this.deps.core.accessor.get(IConfigService) as IConfigService | undefined)
      ?.get<TranscriptMemoryConfig>(TRANSCRIPT_MEMORY_SECTION)?.maxDetailCacheBytes ??
      DEFAULT_TRANSCRIPT_MEMORY_CONFIG.maxDetailCacheBytes;
  }

  private historyLocatorReader?: () => HistoryLocatorStore;
  private detailHistoryLocator?: HistoryLocatorStore;

  setHistoryLocatorReader(reader: () => HistoryLocatorStore): void {
    this.detailHistoryLocator?.invalidateCanonical();
    this.detailHistoryLocator = undefined;
    this.historyLocatorReader = reader;
    this.residencyMaintenance.clearFailureCaches();
  }

  canonicalReadReport(): ReturnType<HistoryLocatorStore['canonicalReadReport']> | undefined {
    return this.detailHistoryLocator?.canonicalReadReport();
  }

  private detailLocator(): HistoryLocatorStore {
    if (this.historyLocatorReader === undefined) throw new Error('history_canonical_reader_unavailable');
    return this.detailHistoryLocator ??= this.historyLocatorReader();
  }

  async readColdWindowEntity(sessionId: string, agentId: string, source: ContentSource, signal?: AbortSignal): Promise<object | undefined> {
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    if (source.kind === 'turn' || source.kind === 'frame' || source.kind === 'roster' || source.kind === 'snapshot') return undefined;
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return undefined;
    const window = this.coldWireWindows.get(location.wirePath);
    const cached = this.coldSnapshotCache.get(location.wirePath);
    const hasWindow = window !== undefined && window.payloadEvicted !== true;
    const hasCached = cached !== undefined && cached.expiresAt > Date.now();
    if (!hasWindow && !hasCached) return undefined;
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) return undefined;
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    const snapshot = hasWindow && window.fingerprint === fingerprint
      ? window.snapshot
      : hasCached && cached.fingerprint === fingerprint
        ? cached.snapshot
        : undefined;
    if (snapshot === undefined) return undefined;
    switch (source.kind) {
      case 'task': return snapshot.tasks.find((task) => task.taskId === source.id);
      case 'attachment': return snapshot.attachments.find((attachment) => attachment.attachmentId === source.id);
      case 'prompt': return snapshot.prompts.find((prompt) => prompt.promptId === source.id);
      case 'interaction': return this.reconcileQuestionSnapshot(sessionId, snapshot).interactions.find((interaction) => interaction.interactionId === source.id);
      case 'marker': return snapshot.items.find((item) => item.kind === 'marker' && item.markerId === source.id);
      case 'todo': return snapshot.todos.find((todo) => todo.todoId === source.id);
      case 'meta': return snapshot.meta;
      default: return undefined;
    }
  }

  async readPersistedTask(sessionId: string, agentId: string, taskId: string, signal?: AbortSignal): Promise<TranscriptTask | undefined> {
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    if (!isPlainAgentId(agentId) || taskId.length === 0 || taskId === '.' || taskId === '..' || /[/\\\0]/.test(taskId)) return undefined;
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    signal?.throwIfAborted();
    if (summary === undefined) return undefined;
    const sessionScope = sessionScopeOf(workspacePersistenceScope(SESSIONS_ROOT, summary.workspaceId), sessionId);
    const ownerScope = agentScopeOf(sessionScope, agentId);
    const sessionDir = join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId);
    const agentDir = join(sessionDir, AGENTS_DIR, agentId);
    const docs = this.optionalCoreService<IAtomicDocumentStore>(IAtomicDocumentStore);
    const storage = this.optionalCoreService<IFileSystemStorageService>(IFileSystemStorageService);
    let info: AgentTaskInfo | undefined;
    let outputText: string | undefined;
    if (VALID_PERSISTED_TASK_ID.test(taskId)) {
      if (docs !== undefined && storage !== undefined) {
        const fallback = agentId === MAIN_AGENT_ID ? { dir: sessionDir, scope: sessionScope } : undefined;
        const persistence = new AgentTaskPersistence(agentDir, ownerScope, docs, storage, fallback);
        const raw = await persistence.readTask(taskId).catch(() => undefined);
        signal?.throwIfAborted();
        if (raw !== undefined && (raw.ownerAgentId === undefined || raw.ownerAgentId === agentId)) {
          info = raw;
          if (info.kind === 'agent' && info.receipt?.contentState !== 'unavailable') {
            const page = await persistence.readTaskOutputPage(taskId, 0, PERSISTED_TASK_SUMMARY_MAX_BYTES).catch(() => undefined);
            outputText = page?.text;
          } else if (info.kind === 'process') {
            const snap = await persistence.readTaskOutputSnapshot(taskId, PERSISTED_TASK_OUTPUT_TAIL_BYTES).catch(() => undefined);
            outputText = snap?.preview;
          }
          signal?.throwIfAborted();
        }
      } else {
        const roots = agentId === MAIN_AGENT_ID ? [agentDir, sessionDir] : [agentDir];
        for (const rootDir of roots) {
          const rawText = await readFile(join(rootDir, 'tasks', `${taskId}.json`), 'utf8').catch(() => undefined);
          signal?.throwIfAborted();
          if (rawText === undefined) continue;
          const parsed = parseDirectPersistedTask(rawText, taskId);
          if (parsed === undefined || (parsed.ownerAgentId !== undefined && parsed.ownerAgentId !== agentId)) continue;
          info = parsed;
          const outPath = join(rootDir, 'tasks', taskId, 'output.log');
          if (info.kind === 'agent' && info.receipt?.contentState !== 'unavailable') {
            outputText = await readBoundedFileHead(outPath, PERSISTED_TASK_SUMMARY_MAX_BYTES, signal);
          } else if (info.kind === 'process') {
            outputText = await readBoundedFileTail(outPath, PERSISTED_TASK_OUTPUT_TAIL_BYTES, signal);
          }
          break;
        }
      }
    }
    let targetSubagentId = info?.kind === 'agent' ? info.agentId : undefined;
    let agentMeta: AgentMeta | undefined;
    if (info === undefined || (targetSubagentId !== undefined && targetSubagentId !== '')) {
      const meta = await this.readSessionMetaDocument(sessionDir, sessionScope, docs, signal);
      let rawAgent = targetSubagentId !== undefined && targetSubagentId !== ''
        ? meta?.agents?.[targetSubagentId]
        : isPlainAgentId(taskId)
          ? meta?.agents?.[taskId]
          : undefined;
      if (rawAgent !== undefined && rawAgent.taskId !== undefined && rawAgent.taskId !== taskId) {
        rawAgent = undefined;
      }
      if (rawAgent !== undefined && targetSubagentId === undefined) {
        targetSubagentId = taskId;
      }
      if (rawAgent === undefined && info === undefined && meta?.agents !== undefined) {
        for (const [candidateAgentId, candidate] of Object.entries(meta.agents)) {
          if (candidate?.taskId !== taskId) continue;
          const parentMatches = agentId === MAIN_AGENT_ID
            ? (candidate.parentAgentId === undefined || candidate.parentAgentId === MAIN_AGENT_ID)
            : candidate.parentAgentId === agentId;
          if (!parentMatches) continue;
          targetSubagentId = candidateAgentId;
          rawAgent = candidate;
          break;
        }
      }
      if (rawAgent !== undefined) {
        agentMeta = await this.hydrateAgentOutcome(sessionDir, sessionScope, docs, rawAgent, signal);
      }
    }
    if (info !== undefined) {
      return persistedTaskToTranscriptTask(info, outputText, agentMeta);
    }
    if (agentMeta === undefined || (agentMeta.resultSummary === undefined && agentMeta.error === undefined && agentMeta.status === undefined)) {
      return undefined;
    }
    const state = agentMeta.status === 'cancelled'
      ? 'killed'
      : agentMeta.status === 'failed'
        ? 'failed'
        : agentMeta.status === 'completed'
          ? 'completed'
          : 'running';
    return {
      taskId,
      kind: 'subagent',
      state,
      detached: true,
      agentId: targetSubagentId ?? taskId,
      name: agentMeta.userLabel,
      subagentName: agentMeta.displayName,
      model: agentMeta.model,
      thinkingEffort: agentMeta.thinkingEffort,
      executorId: agentMeta.executor,
      executorProtocol: agentMeta.executorProtocol,
      outputTail: '',
      endedAt: agentMeta.completedAt === undefined ? undefined : new Date(agentMeta.completedAt).toISOString(),
      resultSummary: agentMeta.resultSummary,
      error: state === 'failed' ? agentMeta.error : undefined,
      usage: agentMeta.usage,
    };
  }

  private optionalCoreService<T>(token: unknown): T | undefined {
    try {
      return this.deps.core.accessor.get(token as never) as T | undefined;
    } catch {
      return undefined;
    }
  }

  private async readSessionMetaDocument(
    sessionDir: string,
    sessionScope: string,
    docs: IAtomicDocumentStore | undefined,
    signal?: AbortSignal,
  ): Promise<SessionMeta | undefined> {
    signal?.throwIfAborted();
    if (docs !== undefined) {
      const direct = await docs.get<SessionMeta>(sessionScope, STATE_FILE).catch(() => undefined);
      if (direct !== undefined) return direct;
      return docs.get<SessionMeta>(`${sessionScope}/session-meta`, STATE_FILE).catch(() => undefined);
    }
    for (const candidate of [join(sessionDir, STATE_FILE), join(sessionDir, 'session-meta', STATE_FILE)]) {
      const raw = await readFile(candidate, 'utf8').catch(() => undefined);
      signal?.throwIfAborted();
      if (raw === undefined) continue;
      try {
        return JSON.parse(raw) as SessionMeta;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async hydrateAgentOutcome(
    sessionDir: string,
    sessionScope: string,
    docs: IAtomicDocumentStore | undefined,
    agent: AgentMeta,
    signal?: AbortSignal,
  ): Promise<AgentMeta> {
    const stored = agent as AgentMeta & { readonly outcomeRef?: unknown };
    if (typeof stored.outcomeRef !== 'string' || !VALID_OUTCOME_REF.test(stored.outcomeRef)) return agent;
    signal?.throwIfAborted();
    let outcome: { version?: unknown; resultSummary?: unknown; error?: unknown } | undefined;
    if (docs !== undefined) {
      outcome = await docs.get<{ version?: unknown; resultSummary?: unknown; error?: unknown }>(sessionScope, stored.outcomeRef).catch(() => undefined);
    } else {
      const raw = await readFile(join(sessionDir, stored.outcomeRef), 'utf8').catch(() => undefined);
      signal?.throwIfAborted();
      if (raw !== undefined) {
        try { outcome = JSON.parse(raw) as { version?: unknown; resultSummary?: unknown; error?: unknown }; }
        catch { outcome = undefined; }
      }
    }
    if (
      outcome?.version !== 1 ||
      (outcome.resultSummary !== undefined && typeof outcome.resultSummary !== 'string') ||
      (outcome.error !== undefined && typeof outcome.error !== 'string')
    ) {
      return agent;
    }
    return {
      ...agent,
      resultSummary: outcome.resultSummary as string | undefined,
      error: outcome.error as string | undefined,
    };
  }

  private async readWarmColdToolCall(
    sessionId: string,
    agentId: string,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly turnId: string; readonly stepId: string; readonly frame: ToolCallFrame } | undefined> {
    signal?.throwIfAborted();
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return undefined;
    const retained = this.retainedColdTurns.get(location.wirePath);
    const window = this.coldWireWindows.get(location.wirePath);
    const cached = this.coldSnapshotCache.get(location.wirePath);
    const hasRetained = retained !== undefined && retained.turns.size > 0;
    const hasWindow = window !== undefined && window.payloadEvicted !== true;
    const hasCached = cached !== undefined && cached.expiresAt > Date.now();
    if (!hasRetained && !hasWindow && !hasCached) return undefined;
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) return undefined;
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    if (hasRetained && retained.fingerprint === fingerprint) {
      const hit = findToolCallInTurns(retained.turns.values(), toolCallId);
      if (hit !== undefined) return hit;
    }
    if (hasWindow && await this.matchesAppendSafeWitness(location.wirePath, window, info, signal)) {
      if (info.size > window.end) window.droppedTail = true;
      const completeTurns = window.snapshot.items.flatMap((item) => {
        if (item.kind !== 'turn') return [];
        const complete = completeColdWindowTurn(window, item.turnId);
        return complete === undefined ? [] : [complete];
      });
      const hit = findToolCallInTurns(completeTurns, toolCallId);
      if (hit !== undefined) return hit;
    }
    if (hasCached && cached.fingerprint === fingerprint) {
      const completeTurns = cached.snapshot.items.filter(
        (item): item is TranscriptTurn => item.kind === 'turn' && item.stepsPartial !== true,
      );
      const hit = findToolCallInTurns(completeTurns, toolCallId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private async readDirectColdToolCall(
    sessionId: string,
    agentId: string,
    toolCallId: string,
    hintTurnId?: string,
    signal?: AbortSignal,
  ): Promise<{ readonly turnId: string; readonly stepId: string; readonly frame: ToolCallFrame } | undefined> {
    signal?.throwIfAborted();
    if (this.coldTurnSpans === undefined || typeof this.historyWireLocation !== 'function') return undefined;
    const location = await this.historyWireLocation(sessionId, agentId);
    signal?.throwIfAborted();
    if (location === undefined) return undefined;
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined) return undefined;
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    const stamp = await sealStamp(location.wirePath);
    const spanFingerprint = await this.reconcileColdSpanIndexes(location.wirePath, info, stamp, signal);
    signal?.throwIfAborted();
    const indexedTurnId = this.lookupColdToolTurnId(location.wirePath, spanFingerprint, toolCallId);
    const candidates: string[] = [];
    if (hintTurnId !== undefined && hintTurnId.length > 0) candidates.push(hintTurnId);
    if (indexedTurnId !== undefined && !candidates.includes(indexedTurnId)) candidates.push(indexedTurnId);
    if (candidates.length === 0) return undefined;
    const transcript = this.live.get(sessionId)?.store.getAgent(agentId);
    const opened = signal ?? new AbortController().signal;
    for (const candidateTurnId of candidates) {
      if (transcript?.getTurn(candidateTurnId)?.state === 'running') continue;
      const direct = await this.readDirectColdTurn(agentId, location.wirePath, info, fingerprint, candidateTurnId, opened);
      if (direct === undefined) continue;
      const hit = findToolCallInTurns([direct], toolCallId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  async lookupToolCall(sessionId: string, agentId: string, toolCallId: string,
    signal?: AbortSignal, turnId?: string): Promise<CanonicalToolLookup> {
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    const transcript = this.live.get(sessionId)?.store.getAgent(agentId);
    if (transcript !== undefined) {
      const hit = transcript.getToolCall(toolCallId);
      if (hit !== undefined) return { status: 'found', ...hit };
    }
    const warmCold = await this.readWarmColdToolCall(sessionId, agentId, toolCallId, signal);
    if (warmCold !== undefined) return { status: 'found', ...warmCold };
    const directCold = await this.readDirectColdToolCall(sessionId, agentId, toolCallId, turnId, signal);
    if (directCold !== undefined) return { status: 'found', ...directCold };
    return this.detailLocator().lookupToolCall(sessionId, agentId, toolCallId, signal);
  }

  async readCanonicalEntity(sessionId: string, agentId: string, source: ContentSource,
    signal?: AbortSignal): Promise<object | undefined> {
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    if (source.kind !== 'turn' && source.kind !== 'frame') throw new Error('history_canonical_unsupported_source');
    const turnId = source.kind === 'turn' ? source.id : source.turnId;
    const transcript = this.live.get(sessionId)?.store.getAgent(agentId);
    if (transcript !== undefined) {
      const turn = transcript.getTurn(turnId ?? '');
      if (source.kind === 'frame') {
        const frame = turn?.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id);
        if (frame !== undefined) return frame;
      } else {
        const completeTurn = turn !== undefined && turn.stepsPartial !== true &&
          !(turn.origin.kind === 'other' && turn.message === undefined && turn.promptId === undefined && turn.startedAt === undefined);
        if (completeTurn && await this.verifyTranscriptLiveCoverage(sessionId, agentId)) {
          signal?.throwIfAborted();
          return turn;
        }
      }
    }
    if (turnId !== undefined && this.coldTurnSpans !== undefined && typeof this.historyWireLocation === 'function') {
      const liveTurn = transcript?.getTurn(turnId);
      if (liveTurn?.state !== 'running') {
        const location = await this.historyWireLocation(sessionId, agentId);
        signal?.throwIfAborted();
        if (location !== undefined) {
          const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          signal?.throwIfAborted();
          if (info !== undefined) {
            const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
            const retained = this.retainedColdTurns?.get(location.wirePath);
            const retainedTurn = retained !== undefined && retained.fingerprint === fingerprint
              ? retained.turns.get(turnId)
              : undefined;
            const window = this.coldWireWindows?.get(location.wirePath);
            const windowValid = window !== undefined && window.payloadEvicted !== true &&
              await this.matchesAppendSafeWitness(location.wirePath, window, info, signal);
            if (windowValid && info.size > window.end) window.droppedTail = true;
            const windowTurn = windowValid
              ? completeColdWindowTurn(window, turnId)
              : undefined;
            const fastTurn = retainedTurn
              ?? windowTurn
              ?? await this.readDirectColdTurn(agentId, location.wirePath, info, fingerprint, turnId, signal ?? new AbortController().signal);
            if (fastTurn !== undefined) {
              if (source.kind === 'turn') return fastTurn;
              const frame = fastTurn.steps.find((step) => step.stepId === source.stepId)
                ?.frames.find((candidate) => candidate.frameId === source.id);
              if (frame !== undefined) return frame;
            }
          }
        }
      }
    }
    const result = await this.detailLocator().readCanonicalEntity(sessionId, agentId, source, signal);
    signal?.throwIfAborted();
    if (result.status === 'preparing') throw new CanonicalEntityPreparingError();
    return result.status === 'found' ? result.entity : undefined;
  }

  async historyWireLocation(sessionId: string, agentId: string): Promise<{ workspaceId: string; wirePath: string } | undefined> {
    this.assertReadableAgent(sessionId, agentId);
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined || !isPlainAgentId(agentId)) return undefined;
    return { workspaceId: summary.workspaceId, wirePath: join(
      this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, AGENTS_DIR, agentId, WIRE_FILE,
    ) };
  }

  async hasColdWireMarker(
    sessionId: string,
    agentId: string,
    marker: string,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    signal?.throwIfAborted();
    if (this.deps.wireRecordReader !== undefined) return undefined;
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return undefined;
    const scanned = await scanColdWireMarkers(location.wirePath, [marker], signal, FIRST_SCREEN_WINDOW_BYTES);
    if (scanned === undefined) return undefined;
    return scanned.matches.get(marker) ?? false;
  }

  async readColdTodos(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
    signal?: AbortSignal,
  ): Promise<{ readonly todos: readonly TranscriptTodo[]; readonly verified: boolean } | undefined> {
    signal?.throwIfAborted();
    await this.live.get(sessionId)?.pendingDisposals.get(agentId);
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    const key = `${sessionId}\0${agentId}`;
    let flight = this.coldTodosFlights.get(key);
    if (flight !== undefined && !flight.controller.signal.aborted) this.coldReadsShared += 1;
    if (flight === undefined || flight.controller.signal.aborted) {
      const controller = new AbortController();
      let created!: ColdTodosFlight;
      const promise = Promise.resolve()
        .then(() => this.loadColdTodos(sessionId, agentId, controller.signal))
        .finally(() => {
          created.settled = true;
          if (this.coldTodosFlights.get(key) === created) this.coldTodosFlights.delete(key);
        });
      created = { controller, promise, waiters: 0, settled: false };
      flight = created;
      this.coldTodosFlights.set(key, flight);
    }
    const result = await this.awaitColdTodos(flight, signal);
    this.assertReadableAgent(sessionId, agentId);
    return result;
  }

  private async awaitColdTodos(flight: ColdTodosFlight, signal?: AbortSignal): Promise<ColdTodosResult | undefined> {
    signal?.throwIfAborted();
    flight.waiters += 1;
    let onAbort: (() => void) | undefined;
    try {
      if (signal === undefined) return await flight.promise;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([flight.promise, aborted]);
    } catch (error) {
      if (signal?.aborted === true) this.coldReadsCancelled += 1;
      throw error;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(new DOMException('No cold todo readers remain', 'AbortError'));
      }
    }
  }

  private async loadColdTodos(sessionId: string, agentId: string, signal: AbortSignal): Promise<ColdTodosResult | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    if (!isPlainAgentId(agentId)) return { todos: [], verified: false };
    const wirePath = join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, AGENTS_DIR, agentId, WIRE_FILE);
    let info = await stat(wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal.throwIfAborted();
    const missingWire = info === undefined;
    const sealed = info !== undefined && await this.hasVerifiedWireReceipt(wirePath, info, signal);
    const liveVerified = info !== undefined && !sealed && await this.hasVerifiedLiveEpoch(sessionId, agentId);
    if (liveVerified) info = await stat(wirePath).catch(() => undefined);
    const verified = sealed || liveVerified;
    signal.throwIfAborted();
    const fingerprint = info === undefined ? undefined : fileIdentity(info);
    const cacheFingerprint = info === undefined ? undefined : `${fingerprint}:${fileFingerprint(info)}`;
    if (cacheFingerprint !== undefined) {
      const cachedFull = this.coldSnapshotCache.get(wirePath);
      if (cachedFull !== undefined && !cachedFull.pageOnly && cachedFull.fingerprint === cacheFingerprint && cachedFull.expiresAt > Date.now()) {
        return { todos: cachedFull.snapshot.todos, verified: cachedFull.snapshot.toolCallCountKnown === true };
      }
      const cachedTodos = this.coldTodosCache.get(wirePath);
      if (cachedTodos !== undefined && cachedTodos.fingerprint === cacheFingerprint && (cachedTodos.verified || !verified)) {
        this.coldTodosCache.delete(wirePath);
        this.coldTodosCache.set(wirePath, cachedTodos);
        return { todos: cachedTodos.todos, verified: cachedTodos.verified };
      }
      if (sealed && fingerprint !== undefined && info !== undefined && info.size <= TRANSCRIPT_CHECKPOINT_MAX_WIRE_BYTES) {
        const checkpointStore = this.deps.core.accessor.get(IQueryStore) as IQueryStore | undefined;
        if (checkpointStore !== undefined) {
          const checkpoint = await readTranscriptProjectionCheckpoint(
            checkpointStore,
            `${summary.workspaceId}\0${sessionId}\0${agentId}`,
            fingerprint,
            info.size,
          );
          if (checkpoint !== undefined && checkpoint.nextByteOffset === info.size) {
            return { todos: checkpoint.snapshot.todos, verified: true };
          }
        }
      }
    }
    const transcript = new AgentTranscriptDraft(agentId);
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter(agentId);
    const initState = { onlyInit: true, sawMetadata: false };
    const readLimits = this.coldReadLimits;
    const todoSliceBytes = this.deps.coldReadLimits?.maxBytes ?? Math.max(readLimits.maxBytes, 32 * 1024 * 1024);
    const startedAt = Date.now();
    let complete = false;
    let readResult!: WireRecordsStreamResult;
    const applyTodoRecord = (record: ContextRecord, span: { startByteOffset: number; endByteOffset: number; ordinal: number }) => {
      if (record === TODO_NOOP_RECORD) {
        initState.onlyInit = false;
        return;
      }
      if (record === null || typeof record !== 'object' || typeof record.type !== 'string') throw new Error('wire.jsonl: invalid record');
      if (initState.onlyInit) {
        if (isWireInitOnlyRecord(record, span.ordinal)) {
          if (span.ordinal === 0) initState.sawMetadata = true;
        } else {
          initState.onlyInit = false;
        }
      }
      return reducer.apply(adapter.add(record, {
        startByteOffset: span.startByteOffset,
        endByteOffset: span.endByteOffset,
        ordinal: span.ordinal,
      }));
    };
    try {
      const fastScan = this.deps.wireRecordReader === undefined && this.deps.coldReadLimits === undefined && !missingWire
        ? await this.coldTodoReads.run(signal, (owned) => scanColdTodoWire(wirePath, owned, initState, applyTodoRecord), false)
        : undefined;
      if (fastScan !== undefined) {
        readResult = fastScan;
      } else {
        let nextByteOffset = 0;
        let recordCount = 0;
        let bytesRead = 0;
        let oversizedRecord = false;
        for (;;) {
          signal.throwIfAborted();
          const sliceStartOffset = nextByteOffset;
          const sliceStartOrdinal = recordCount;
          const sliceOversized: boolean = oversizedRecord;
          const read: WireRecordsStreamResult = await this.coldTodoReads.run(signal, (owned) => this.readWireRecordsYielding(wirePath, {
            startByteOffset: sliceStartOffset === 0 ? undefined : sliceStartOffset,
            startRecordOrdinal: sliceStartOrdinal,
            chunkBytes: readLimits.chunkBytes,
            maxBytes: sliceOversized ? undefined : todoSliceBytes,
            maxRecords: sliceOversized ? 1 : readLimits.maxRecords,
            maxLineBytes: sliceOversized ? undefined : readLimits.maxLineBytes,
            signal: owned,
            decodeRecord: (line) => transcriptTodoRecord(line, initState.onlyInit),
            onRecord: applyTodoRecord,
          }), false);
          bytesRead += read.bytesRead;
          recordCount += read.recordCount;
          readResult = { ...read, bytesRead, recordCount };
          if (read.complete || read.incompleteReason === 'partial_tail') break;
          const progressed = read.nextByteOffset > nextByteOffset;
          if (!progressed && oversizedRecord) throw new Error('history_canonical_source_no_progress');
          if (read.incompleteReason !== 'byte_budget' && read.incompleteReason !== 'record_budget' && read.incompleteReason !== 'line_budget') {
            throw new Error(`history_canonical_source_incomplete:${read.incompleteReason ?? 'unknown'}`);
          }
          oversizedRecord = !progressed;
          nextByteOffset = read.nextByteOffset;
          await new Promise<void>((resolve) => { setImmediate(resolve); });
        }
      }
      this.coldReadsCompleted += 1;
      this.coldReadBytes += readResult.bytesRead;
      this.coldReadRecords += readResult.recordCount;
      this.coldReadDurationMs += Date.now() - startedAt;
      if (!readResult.complete && readResult.incompleteReason !== 'partial_tail') this.coldReadsFenced += 1;
      complete = readResult.complete;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new DOMException('The cold todo read was aborted', 'AbortError');
      if (missingWire && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const metadata = agentId === MAIN_AGENT_ID
          ? await readFile(join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, STATE_FILE), 'utf-8').then(text => JSON.parse(text) as SessionMeta).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined;
              throw error;
            })
          : undefined;
        signal.throwIfAborted();
        if (metadata?.agents !== undefined && Object.keys(metadata.agents).length === 0) return { todos: [], verified: true };
        return { todos: [], verified: false };
      }
      this.logTranscriptFailure(sessionId, agentId, error);
      throw error;
    }
    reducer.apply(adapter.finish());
    const snapshot = transcript.snapshot();
    const stillVerified = verified && (sealed
      ? await this.hasVerifiedWireReceipt(wirePath, info!, signal)
      : await this.hasVerifiedLiveEpoch(sessionId, agentId));
    const initOnlyReplay = complete && info !== undefined && info.size > 0 && readResult !== undefined &&
      readResult.recordCount > 0 && readResult.nextByteOffset === info.size &&
      initState.onlyInit && initState.sawMetadata && snapshot.todos.length === 0;
    const after = (stillVerified || initOnlyReplay || complete) ? await stat(wirePath).catch(() => undefined) : undefined;
    const unchanged = after !== undefined && `${fileIdentity(after)}:${fileFingerprint(after)}` === cacheFingerprint;
    const proven = complete && (stillVerified || initOnlyReplay) && unchanged;
    const entry = { todos: snapshot.todos, verified: proven };
    if (complete && unchanged && cacheFingerprint !== undefined && !signal.aborted) {
      this.coldTodosCache.delete(wirePath);
      this.coldTodosCache.set(wirePath, { fingerprint: cacheFingerprint, todos: snapshot.todos, verified: proven });
      while (this.coldTodosCache.size > COLD_TODOS_CACHE_MAX_ENTRIES) {
        const oldest = this.coldTodosCache.keys().next().value;
        if (oldest === undefined) break;
        this.coldTodosCache.delete(oldest);
      }
    }
    return entry;
  }

  async readColdSnapshotBounded(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
    limits: TranscriptColdReadLimits = {},
    signal?: AbortSignal,
  ): Promise<BoundedTranscriptSnapshot> {
    signal?.throwIfAborted();
    await this.live.get(sessionId)?.pendingDisposals.get(agentId);
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    const stats: ColdSnapshotStats = {
      bytesRead: 0,
      recordsRead: 0,
      complete: false,
    };
    const snapshot = await this.loadColdSnapshot(
      sessionId,
      agentId,
      undefined,
      signal ?? new AbortController().signal,
      limits,
      stats,
    );
    this.assertReadableAgent(sessionId, agentId);
    return { snapshot, ...stats };
  }

  private async awaitColdSnapshot(
    flight: ColdSnapshotFlight,
    signal?: AbortSignal,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    flight.waiters += 1;
    let onAbort: (() => void) | undefined;
    try {
      if (signal === undefined) return await flight.promise;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([flight.promise, aborted]);
    } catch (error) {
      if (signal?.aborted === true) this.coldReadsCancelled += 1;
      throw error;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(
          new DOMException('No cold transcript snapshot readers remain', 'AbortError'),
        );
      }
    }
  }

  private async hasVerifiedWireReceipt(
    wirePath: string,
    wireInfo: WireFileInfo,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = `${wirePath}\0${fileFingerprint(wireInfo)}\0${await sealStamp(wirePath)}`;
    let flight = this.verifiedWireReceiptFlights.get(key);
    if (flight !== undefined && !flight.controller.signal.aborted) {
      return this.awaitWireReceiptVerification(flight, signal);
    }
    const controller = new AbortController();
    let created!: WireReceiptVerificationFlight;
    const promise = Promise.resolve()
      .then(() => this.verifyWireReceipt(wirePath, wireInfo, controller.signal))
      .finally(() => {
        created.settled = true;
        if (this.verifiedWireReceiptFlights.get(key) === created) {
          this.verifiedWireReceiptFlights.delete(key);
        }
      });
    created = { controller, promise, waiters: 0, settled: false };
    this.verifiedWireReceiptFlights.set(key, created);
    return this.awaitWireReceiptVerification(created, signal);
  }

  private async awaitWireReceiptVerification(
    flight: WireReceiptVerificationFlight,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    flight.waiters += 1;
    let onAbort: (() => void) | undefined;
    try {
      if (signal === undefined) return await flight.promise;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(signal.reason ?? new DOMException('The wire receipt verification was aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([flight.promise, aborted]);
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(
          new DOMException('No wire receipt verification readers remain', 'AbortError'),
        );
      }
    }
  }

  private async verifyWireReceipt(
    wirePath: string,
    wireInfo: WireFileInfo,
    signal: AbortSignal,
  ): Promise<boolean> {
    const receiptPath = join(dirname(wirePath), WIRE_TRANSCRIPT_RECEIPT_KEY);
    let bytes: Buffer;
    try {
      bytes = await readFile(receiptPath, { signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.deleteVerifiedWireReceipt(wirePath);
        return false;
      }
      throw error;
    }
    signal.throwIfAborted();
    let receipt: ReturnType<typeof parseWireTranscriptReceipt>;
    try {
      receipt = parseWireTranscriptReceipt(JSON.parse(bytes.toString('utf8')));
    } catch {
      receipt = undefined;
    }
    if (receipt?.state !== 'sealed' || !receipt.trusted || receipt.wire?.size !== wireInfo.size) {
      this.deleteVerifiedWireReceipt(wirePath);
      return false;
    }
    const fingerprint = `${fileFingerprint(wireInfo)}\0${await sealStamp(wirePath)}`;
    const cached = this.verifiedWireReceipts.get(wirePath);
    if (cached?.fingerprint === fingerprint && cached.receipt.equals(bytes)) {
      this.touchVerifiedWireReceipt(wirePath);
      return true;
    }
    let verified: boolean;
    try {
      verified = await verifySealedWireBytes(wirePath, receipt.wire, signal);
    } catch (error) {
      if (isStorageCorrupted(error)) {
        this.deleteVerifiedWireReceipt(wirePath);
        return false;
      }
      throw error;
    }
    signal.throwIfAborted();
    if (!verified) {
      this.deleteVerifiedWireReceipt(wirePath);
      return false;
    }
    const currentReceipt = await readFile(receiptPath, { signal }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    signal.throwIfAborted();
    const after = await stat(wirePath).catch(() => undefined);
    const afterStamp = after === undefined ? undefined : await sealStamp(wirePath);
    if (currentReceipt === undefined || !bytes.equals(currentReceipt) ||
        after === undefined || `${fileFingerprint(after)}\0${afterStamp}` !== fingerprint) {
      this.deleteVerifiedWireReceipt(wirePath);
      return false;
    }
    this.admitVerifiedWireReceipt(wirePath, { fingerprint, receipt: bytes, bytes: bytes.byteLength });
    return true;
  }

  private touchVerifiedWireReceipt(wirePath: string): void {
    const entry = this.verifiedWireReceipts.get(wirePath);
    if (entry === undefined) return;
    this.verifiedWireReceipts.delete(wirePath);
    this.verifiedWireReceipts.set(wirePath, entry);
  }

  private deleteVerifiedWireReceipt(wirePath: string): void {
    const entry = this.verifiedWireReceipts.get(wirePath);
    if (entry === undefined) return;
    this.verifiedWireReceipts.delete(wirePath);
    this.verifiedWireReceiptBytes -= entry.bytes;
  }

  private admitVerifiedWireReceipt(wirePath: string, entry: VerifiedWireReceipt): void {
    if (entry.bytes > VERIFIED_WIRE_RECEIPT_CACHE_MAX_BYTES) {
      this.deleteVerifiedWireReceipt(wirePath);
      return;
    }
    this.deleteVerifiedWireReceipt(wirePath);
    this.verifiedWireReceipts.set(wirePath, entry);
    this.verifiedWireReceiptBytes += entry.bytes;
    while (this.verifiedWireReceipts.size > VERIFIED_WIRE_RECEIPT_CACHE_MAX_ENTRIES ||
           this.verifiedWireReceiptBytes > VERIFIED_WIRE_RECEIPT_CACHE_MAX_BYTES) {
      const oldest = this.verifiedWireReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.deleteVerifiedWireReceipt(oldest);
    }
  }

  private async hasVerifiedLiveEpoch(sessionId: string, agentId: string): Promise<boolean> {
    const entry = this.live.get(sessionId);
    const wire = entry?.agentWires.get(agentId);
    if (wire?.verifyTranscriptLiveEpoch === undefined) return false;
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent = session?.accessor.get(IAgentLifecycleService).get(agentId);
    if (agent === undefined) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false); }, LIVE_EPOCH_VERIFY_WAIT_MS); });
      const verified = await Promise.race([wire.verifyTranscriptLiveEpoch(), expired]);
      return verified && this.live.get(sessionId) === entry &&
        session?.accessor.get(IAgentLifecycleService).get(agentId) === agent;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private loadColdSnapshot(...[sessionId, agentId, preserve, signal, ...options]: Parameters<TranscriptService['loadColdSnapshotInLane']>): Promise<AgentTranscriptSnapshot | undefined> {
    const tailFirst = options[3] === true;
    return this.scheduleHistoryRead(signal, owned => this.loadColdSnapshotInLane(sessionId, agentId, preserve, owned, ...options), tailFirst);
  }

  private async loadColdSnapshotInLane(
    sessionId: string,
    agentId: string,
    preserveOpenTurnIds: (() => readonly string[]) | undefined,
    signal: AbortSignal,
    limits?: TranscriptColdReadLimits,
    stats?: ColdSnapshotStats,
    captureReplayState?: (state: TranscriptReplayState) => void,
    tailFirst = false,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    if (!isPlainAgentId(agentId)) return unknownSnapshot();
    const wirePath = join(
      this.deps.homeDir,
      SESSIONS_ROOT,
      summary.workspaceId,
      sessionId,
      AGENTS_DIR,
      agentId,
      WIRE_FILE,
    );
    let info = await stat(wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal.throwIfAborted();
    const missingWire = info === undefined;
    const bounded = limits !== undefined;
    const shouldVerify = !bounded && !tailFirst && info !== undefined;
    const sealed = shouldVerify && info !== undefined && await this.hasVerifiedWireReceipt(wirePath, info, signal);
    const liveVerified = shouldVerify && !sealed && await this.hasVerifiedLiveEpoch(sessionId, agentId);
    if (liveVerified) info = await stat(wirePath).catch(() => undefined);
    const verified = sealed || liveVerified;
    signal.throwIfAborted();
    const fingerprint = info === undefined ? undefined : fileIdentity(info);
    const cacheFingerprint = info === undefined ? undefined : `${fingerprint}:${fileFingerprint(info)}`;
    if (verified && preserveOpenTurnIds === undefined) {
      const cached = this.coldSnapshotCache.get(wirePath);
      if (cached !== undefined && !cached.pageOnly) {
        if (cached.fingerprint === cacheFingerprint && cached.expiresAt > Date.now()) return cached.snapshot;
        this.deleteColdSnapshotCache(wirePath);
      }
    }
    const transcript = new AgentTranscriptDraft(agentId);
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter(agentId, {
      turn: (turnId) => transcript.getTurn(turnId),
      tool: (toolCallId) => transcript.getToolCall(toolCallId),
      task: (taskId) => transcript.getTask(taskId),
    });
    const checkpointKey = `${summary.workspaceId}\0${sessionId}\0${agentId}`;
    const checkpointStore = this.deps.core.accessor.get(IQueryStore) as IQueryStore | undefined;
    const checkpointEligible = sealed && fingerprint !== undefined && preserveOpenTurnIds === undefined &&
      checkpointStore !== undefined && info !== undefined && info.size <= TRANSCRIPT_CHECKPOINT_MAX_WIRE_BYTES;
    const checkpoint = checkpointEligible
      ? await readTranscriptProjectionCheckpoint(
          checkpointStore,
          checkpointKey,
          fingerprint,
          info!.size,
        ) : undefined;
    if (checkpoint !== undefined) {
      transcript.seed(checkpoint.snapshot);
      adapter.restore(checkpoint.adapter);
      reducer.restore(checkpoint.acceptedDurableFacts);
    }
    let complete: boolean;
    let readResult!: WireRecordsStreamResult;
    const initState = { onlyInit: checkpoint === undefined && !bounded, sawMetadata: false };
    const onColdRecord: NonNullable<WireRecordsStreamOptions['onRecord']> = (record, span) => {
      if (record === null || typeof record !== 'object' || typeof record.type !== 'string') throw new Error('wire.jsonl: invalid record');
      if (initState.onlyInit) {
        if (isWireInitOnlyRecord(record, span.ordinal)) {
          if (span.ordinal === 0) initState.sawMetadata = true;
        } else {
          initState.onlyInit = false;
        }
      }
      return reducer.apply(adapter.add(record));
    };
    const readLimits = limits ?? this.coldReadLimits;
    const startedAt = Date.now();
    try {
      let nextByteOffset = checkpoint?.nextByteOffset ?? 0;
      let recordCount = 0;
      let bytesRead = 0;
      let oversizedRecord = false;
      for (;;) {
        signal.throwIfAborted();
        const sliceStartOffset = nextByteOffset;
        const sliceStartOrdinal = (checkpoint?.recordCount ?? 0) + recordCount;
        const sliceOversized: boolean = oversizedRecord;
        const read: WireRecordsStreamResult = await this.readWireRecordsYielding(wirePath, {
          startByteOffset: sliceStartOffset === 0 ? undefined : sliceStartOffset,
          startRecordOrdinal: sliceStartOrdinal,
          chunkBytes: readLimits.chunkBytes,
          maxBytes: sliceOversized ? undefined : readLimits.maxBytes,
          maxRecords: sliceOversized ? 1 : readLimits.maxRecords,
          maxLineBytes: sliceOversized ? undefined : readLimits.maxLineBytes,
          signal,
          decodeRecord: transcriptWindowRecord,
          onRecord: onColdRecord,
        });
        bytesRead += read.bytesRead;
        recordCount += read.recordCount;
        readResult = { ...read, bytesRead, recordCount };
        if (bounded || read.complete || read.incompleteReason === 'partial_tail') break;
        const progressed = read.nextByteOffset > nextByteOffset;
        if (!progressed && oversizedRecord) throw new Error('history_canonical_source_no_progress');
        if (read.incompleteReason !== 'byte_budget' && read.incompleteReason !== 'record_budget' && read.incompleteReason !== 'line_budget') {
          throw new Error(`history_canonical_source_incomplete:${read.incompleteReason ?? 'unknown'}`);
        }
        oversizedRecord = !progressed;
        nextByteOffset = read.nextByteOffset;
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      const read = readResult;
      if (stats !== undefined) {
        stats.bytesRead = read.bytesRead;
        stats.recordsRead = read.recordCount;
        stats.complete = read.complete;
        stats.incompleteReason = read.incompleteReason;
      }
      this.coldReadsCompleted += 1;
      this.coldReadBytes += read.bytesRead;
      this.coldReadRecords += read.recordCount;
      this.coldReadDurationMs += Date.now() - startedAt;
      if (!read.complete && read.incompleteReason !== 'partial_tail') this.coldReadsFenced += 1;
      complete = read.complete;
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('The cold transcript read was aborted', 'AbortError');
      }
      if (missingWire && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const metadata = agentId === MAIN_AGENT_ID
          ? await readFile(join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, STATE_FILE), 'utf-8').then(text => JSON.parse(text) as SessionMeta).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined;
              throw error;
            })
          : undefined;
        signal.throwIfAborted();
        if (metadata?.agents !== undefined && Object.keys(metadata.agents).length === 0) {
          captureReplayState?.({ adapter: adapter.checkpoint(), acceptedDurableFacts: reducer.checkpoint() });
          const empty = { ...knownSnapshot(transcript.snapshot(), 0), hasMoreOlder: false };
          this.initOnlyProvenSnapshots.add(empty);
          return empty;
        }
        return unknownSnapshot();
      }
      this.logTranscriptFailure(sessionId, agentId, error);
      throw error;
    }
    try {
      const preservedTurns: TranscriptTurn[] = [];
      for (const turnId of preserveOpenTurnIds?.() ?? []) {
        const candidate = transcript.getTurn(turnId);
        if (candidate?.state === 'running') preservedTurns.push(structuredClone(candidate));
      }
      if (
        checkpointEligible &&
        complete &&
        readResult !== undefined &&
        (checkpoint === undefined || readResult.nextByteOffset !== checkpoint.nextByteOffset) &&
        readResult.nextByteOffset <= TRANSCRIPT_CHECKPOINT_MAX_WIRE_BYTES &&
        (checkpoint?.recordCount ?? 0) + readResult.recordCount >= TRANSCRIPT_CHECKPOINT_MIN_RECORDS
      ) {
        const seed = transcript.checkpoint();
        const checkpointPayload: TranscriptProjectionCheckpoint = {
          format: TRANSCRIPT_CHECKPOINT_FORMAT,
          fingerprint,
          nextByteOffset: readResult.nextByteOffset,
          recordCount: (checkpoint?.recordCount ?? 0) + readResult.recordCount,
          snapshot: seed,
          adapter: adapter.checkpoint(),
          acceptedDurableFacts: reducer.checkpoint(),
        };
        if (checkpointStore !== undefined) {
          await checkpointStore.put(
            TRANSCRIPT_CHECKPOINT_COLLECTION,
            checkpointKey,
            checkpointPayload,
          ).catch(() => undefined);
        }
      }
      captureReplayState?.({ adapter: adapter.checkpoint(), acceptedDurableFacts: reducer.checkpoint() });
      reducer.apply(adapter.finish());
      for (const turn of preservedTurns) transcript.apply(snapshotTurnOps(turn));
      const snapshot = transcript.snapshot();
      const stillVerified = verified && (sealed
        ? await this.hasVerifiedWireReceipt(wirePath, info!, signal)
        : await this.hasVerifiedLiveEpoch(sessionId, agentId));
      const initOnlyReplay = complete && !bounded && checkpoint === undefined &&
        info !== undefined && info.size > 0 && readResult !== undefined &&
        readResult.recordCount > 0 && readResult.nextByteOffset === info.size &&
        initState.onlyInit && initState.sawMetadata &&
        this.hasOnlyNonHistoryResidentFacts(snapshot);
      const after = (stillVerified || initOnlyReplay) ? await stat(wirePath).catch(() => undefined) : undefined;
      const unchanged = after !== undefined && `${fileIdentity(after)}:${fileFingerprint(after)}` === cacheFingerprint;
      const proven = complete && (stillVerified || initOnlyReplay) && unchanged;
      const result = proven
        ? { ...knownSnapshot(snapshot, countToolCallFrames(snapshot.items)), hasMoreOlder: false }
        : { ...snapshot, toolCallCount: undefined, toolCallCountKnown: false, hasMoreOlder: true };
      if (complete) this.completeColdReplays.add(result);
      this.contiguousColdSnapshots.add(result);
      if (initOnlyReplay && unchanged) this.initOnlyProvenSnapshots.add(result);
      if (proven && preserveOpenTurnIds === undefined && cacheFingerprint !== undefined && !signal.aborted) {
        try { this.admitColdSnapshotCache(wirePath, cacheFingerprint, result); }
        catch { this.deleteColdSnapshotCache(wirePath); }
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new DOMException('The cold transcript read was aborted', 'AbortError');
      this.logTranscriptFailure(sessionId, agentId, error);
      throw error;
    }
  }

  private async invalidateProjectionCheckpoint(sessionId: string, agentId: string): Promise<void> {
    const store = this.deps.core.accessor.get(IQueryStore) as IQueryStore | undefined;
    if (store === undefined) return;
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return;
    const key = `${summary.workspaceId}\0${sessionId}\0${agentId}`;
    await store.delete(TRANSCRIPT_CHECKPOINT_COLLECTION, key).catch(() => undefined);
  }

  async reconcileAfterRewrite(sessionId: string, agentId: string = MAIN_AGENT_ID): Promise<void> {
    await this.invalidateProjectionCheckpoint(sessionId, agentId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    const transcript = entry.store.ensureAgent(agentId);
    entry.agentHistory.set(agentId, { status: 'pending' });
    this.dispatchToolCallCount(sessionId, transcript, undefined, true);
    const initialActiveTurnId = this.liveActiveTurnId(sessionId, agentId);
    let snapshot: AgentTranscriptSnapshot | undefined;
    let replayState: TranscriptReplayState | undefined;
    entry.binding.beginReplay(agentId);
    try {
      snapshot = await this.readColdSnapshot(
        sessionId,
        agentId,
        () => this.liveActiveTurnIds(sessionId, agentId, initialActiveTurnId),
        undefined,
        (state) => { replayState = state; },
      );
    } catch (error) {
      this.logTranscriptFailure(sessionId, agentId, error);
    }
    if (
      snapshot === undefined ||
      !snapshotToolCallCountKnown(snapshot) ||
      this.live.get(sessionId) !== entry
    ) {
      const failureSignature = await this.historyFailureSignature(sessionId, agentId);
      entry.agentHistory.set(agentId, { status: 'failed', failureSignature });
      this.dispatchToolCallCount(sessionId, transcript, undefined, true);
      entry.binding.finishReplay(agentId);
      return;
    }
    transcript.apply([
      {
        op: 'reset',
        agentId,
        grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false },
        snapshot: this.reconcileLiveInteractionSnapshot(sessionId, transcript, snapshot),
      },
    ]);
    const materialized = transcript.snapshot();
    entry.agentToolCallStates.set(agentId, toolCallStateFromSnapshot(materialized));
    entry.agentHistory.set(agentId, { status: 'complete' });
    this.dispatchToolCallCount(sessionId, transcript, countToolCallFrames(materialized.items), true);
    const journal = entry.opsJournals.get(agentId);
    if (journal !== undefined) this.disposeOpsJournal(entry, journal);
    entry.opsJournals.set(agentId, { epoch: randomUUID(), nextSeq: 1, start: 0, batches: [], bytes: 0 });
    entry.binding.finishReplay(agentId, replayState);
    this.releaseDurableHistory(entry, agentId, snapshot);
  }

  /** Recover evicted history into a request-local projection and overlay current live facts. */
  async readFullAgentSnapshot(sessionId: string, agentId: string, transcript: AgentTranscript, signal?: AbortSignal,
    pageProject?: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot, beforeTurn?: string,
    pageSource?: AgentTranscriptSnapshot): Promise<AgentTranscriptSnapshot | undefined> {
    if (!transcript.hasMoreOlder) {
      const resident = transcript.snapshot();
      if (resident.toolCallCountKnown === true || pageProject !== undefined || pageSource !== undefined) return resident;
    }
    let cold = pageSource ?? (pageProject === undefined ? await this.readColdSnapshot(sessionId, agentId, undefined, signal)
      : await this.readColdPageSnapshot(sessionId, agentId, pageProject, signal));
    if (cold === undefined) return undefined;
    const contiguousCold = this.contiguousColdSnapshots.has(cold);
    if (pageSource === undefined && beforeTurn !== undefined && cold.hasMoreOlder !== false && !coldWindowCovers(cold.items, beforeTurn, contiguousCold)) {
      const anchored = await this.readAnchoredColdSnapshot(sessionId, agentId, beforeTurn, signal);
      if (anchored !== undefined) cold = pageProject === undefined ? anchored : this.projectAnchored(anchored, pageProject);
    }
    const merged = new AgentTranscript(agentId);
    merged.apply([{ op: 'reset', agentId, snapshot: cold }]);
    const live = transcript.snapshot();
    const tasks = live.tasks.filter((task) => {
      const recovered = merged.getTask(task.taskId);
      return task.state !== 'running' || recovered === undefined || recovered.state === 'running';
    });
    merged.apply(snapshotToOps({ ...live, tasks }, turn => {
      const recovered = merged.getTurn(turn.turnId);
      if (turn.origin.kind !== 'other' || turn.message !== undefined || turn.promptId !== undefined ||
          recovered === undefined || (recovered.message === undefined && recovered.promptId === undefined)) return snapshotTurnOps(turn);
      return snapshotTurnOps({ ...turn, prompt: recovered.prompt, promptId: recovered.promptId, message: recovered.message,
        origin: recovered.origin, startedAt: recovered.startedAt, presentation: recovered.presentation,
        attachmentIds: recovered.attachmentIds, contentRefs: recovered.contentRefs });
    }));
    const snapshot = this.reconcileQuestionSnapshot(sessionId, merged.snapshot());
    const state = this.anchorReads.get(cold);
    if (state !== undefined) this.anchorReads.set(snapshot, state);
    return snapshot;
  }

  anchorReadState(snapshot: AgentTranscriptSnapshot): 'window' | 'continues' | 'pending' | undefined {
    return this.anchorReads.get(snapshot);
  }

  async readAnchoredColdSnapshot(sessionId: string, agentId: string, beforeTurn: string, signal?: AbortSignal): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    const location = await this.historyWireLocation(sessionId, agentId);
    if (location === undefined) return undefined;
    const info = await stat(location.wirePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (info === undefined || info.size <= FIRST_SCREEN_WINDOW_MAX_BYTES) return undefined;
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    const key = `${location.wirePath}\0${beforeTurn}`;
    const cached = this.anchorSeeks.get(key);
    const resume = cached !== undefined && await this.matchesAppendSafeWitness(location.wirePath, cached, info, signal)
      ? cached : undefined;
    if (cached !== undefined && resume === undefined) {
      this.anchorSeeks.delete(key);
    }
    const budget: AnchorReadBudget = { bytes: FIRST_SCREEN_WINDOW_MAX_BYTES, records: 50_000 };
    try {
      if (resume !== undefined) return await this.readAnchorWindow(sessionId, agentId, location.wirePath, info, key, resume, budget, signal);
      const stamp = await sealStamp(location.wirePath);
      const spanFingerprint = await this.reconcileColdSpanIndexes(location.wirePath, info, stamp, signal);
      const knownSpan = this.lookupColdTurnSpan(location.wirePath, spanFingerprint, beforeTurn);
      if (knownSpan !== undefined && knownSpan.startOffset <= info.size) {
        const witness = await captureWirePrefixWitness(location.wirePath, info, signal);
        const seek: AnchorSeek = { fingerprint, witness, visibilityCheckedTo: witness?.completeTailOffset, at: knownSpan.startOffset };
        this.rememberAnchorSeek(key, seek);
        return await this.readAnchorWindow(sessionId, agentId, location.wirePath, info, key, seek, budget, signal);
      }
      const indexed = await this.indexedTurnByte(sessionId, agentId, beforeTurn);
      if (indexed !== undefined && indexed <= info.size) {
        const witness = await captureWirePrefixWitness(location.wirePath, info, signal);
        const seek: AnchorSeek = { fingerprint, witness, visibilityCheckedTo: witness?.completeTailOffset, at: indexed };
        this.rememberAnchorSeek(key, seek);
        return await this.readAnchorWindow(sessionId, agentId, location.wirePath, info, key, seek, budget, signal);
      }
      if (this.deps.wireRecordReader === undefined) {
        const identity = fileIdentity(info);
        const existingIndex = this.turnStartIndexes.get(location.wirePath);
        const alreadyScanningForward = existingIndex !== undefined && existingIndex.scannedTo > 0 &&
          await this.matchesAppendSafeWitness(location.wirePath, existingIndex, info, signal);
        if (!alreadyScanningForward && this.proximityMisses.get(key) !== identity) {
          const nearTail = await this.trySeekTurnOffsetNearTail(sessionId, agentId, location.wirePath, info, beforeTurn, signal, budget);
          if (nearTail !== undefined) {
            const seek: AnchorSeek = {
              fingerprint,
              witness: nearTail.witness,
              visibilityCheckedTo: nearTail.witness?.completeTailOffset,
              at: nearTail.at,
            };
            this.rememberAnchorSeek(key, seek);
            return await this.readAnchorWindow(sessionId, agentId, location.wirePath, info, key, seek, budget, signal);
          }
          this.rememberProximityMiss(key, identity);
        }
      }
      const started = await this.scheduleHistoryRead(signal, owned => this.turnStartOffset(location.wirePath, info, beforeTurn, owned, budget));
      const startAt = started.kind === 'found' ? started.at : started.kind === 'absent' ? started.following : undefined;
      if (startAt !== undefined && started.kind !== 'pending') {
        const seek: AnchorSeek = {
          fingerprint,
          witness: started.witness,
          visibilityCheckedTo: started.witness?.completeTailOffset,
          at: startAt,
          window: started.kind === 'found' ? started.window : undefined,
        };
        this.rememberAnchorSeek(key, seek);
        return await this.readAnchorWindow(sessionId, agentId, location.wirePath, info, key, seek, budget, signal);
      }
      if (started.kind === 'absent') return undefined;
      return this.pendingAnchor(agentId);
    } catch (error) {
      if (signal?.aborted === true) this.coldReadsCancelled += 1;
      throw error;
    }
  }

  private async trySeekTurnOffsetNearTail(
    sessionId: string,
    agentId: string,
    wirePath: string,
    info: WireFileStat,
    beforeTurn: string,
    signal: AbortSignal | undefined,
    budget: AnchorReadBudget,
  ): Promise<{ readonly at: number; readonly witness?: WirePrefixWitness } | undefined> {
    const targetOrdinal = parseTurnOrdinal(beforeTurn);
    if (targetOrdinal === undefined || budget.bytes <= 0 || budget.records <= 0) return undefined;
    const existingWindow = this.coldWireWindows.get(wirePath);
    const validWindow = existingWindow !== undefined &&
      await this.matchesAppendSafeWitness(wirePath, existingWindow, info, signal)
      ? existingWindow : undefined;
    let searchEnd: number | undefined;
    let fallbackAtSearchEnd: number | undefined;
    if (validWindow !== undefined && !hasVisibilityResetRecord(validWindow.records)) {
      const inWindowPrompt = validWindow.records.find(
        (entry) => entry.record.type === 'turn.prompt' && wireTurnId(entry.record) === beforeTurn,
      );
      if (inWindowPrompt !== undefined && inWindowPrompt.position.startByteOffset > 0) {
        return { at: inWindowPrompt.position.startByteOffset, witness: validWindow.witness };
      }
      if (validWindow.start > 0) {
        const windowOldest = oldestTurnOrdinal(validWindow.snapshot.items);
        if (windowOldest !== undefined && targetOrdinal <= windowOldest && windowOldest - targetOrdinal <= ANCHOR_PROXIMITY_MAX_TURN_GAP) {
          searchEnd = validWindow.start;
          if (targetOrdinal === windowOldest) {
            fallbackAtSearchEnd = validWindow.start;
          }
        }
      }
    }
    if (searchEnd === undefined) {
      const resident = this.live.get(sessionId)?.store.getAgent(agentId);
      const residentOldest = resident === undefined ? undefined : oldestTurnOrdinal(resident.getItems());
      if (residentOldest !== undefined && targetOrdinal <= residentOldest &&
          residentOldest - targetOrdinal <= ANCHOR_PROXIMITY_MAX_TURN_GAP &&
          targetOrdinal >= DEFAULT_TRANSCRIPT_MEMORY_CONFIG.tailTurns) {
        searchEnd = info.size;
      }
    }
    if (searchEnd === undefined || searchEnd <= 0) return undefined;
    return this.scheduleHistoryRead(signal, owned => this.seekTurnOffsetNearTailInLane(wirePath, info, searchEnd, beforeTurn, owned, budget, fallbackAtSearchEnd));
  }

  private async seekTurnOffsetNearTailInLane(
    wirePath: string,
    info: WireFileStat,
    searchEnd: number,
    beforeTurn: string,
    signal: AbortSignal,
    budget: AnchorReadBudget,
    fallbackAtSearchEnd?: number,
  ): Promise<{ readonly at: number; readonly witness?: WirePrefixWitness } | undefined> {
    const beforeWitness = await captureWirePrefixWitness(wirePath, info, signal);
    if (beforeWitness === undefined) return undefined;
    const opened = await openLogicalWire(wirePath, signal);
    if (opened === undefined) return undefined;
    const maxScanBytes = Math.min(Math.floor(budget.bytes / 2), ANCHOR_PROXIMITY_MAX_BYTES);
    const maxScanRecords = Math.min(Math.floor(budget.records / 2), ANCHOR_PROXIMITY_MAX_RECORDS);
    if (maxScanBytes <= 0 || maxScanRecords <= 0) {
      opened.close();
      return undefined;
    }
    const floor = Math.max(0, searchEnd - maxScanBytes);
    let position = searchEnd;
    let recordEnd = searchEnd;
    const suffix: Buffer[] = [];
    let suffixBytes = 0;
    let oversizedLine = false;
    let scannedRecords = 0;
    const markers: ScannedSpanMarker[] = [];
    const yieldBudget = createYieldBudget();
    const startedAt = performance.now();
    try {
      while (position > floor && scannedRecords < maxScanRecords) {
        signal.throwIfAborted();
        const start = Math.max(floor, position - FIRST_SCREEN_CHUNK_BYTES);
        const rawChunk = await opened.readAt(start, position - start);
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
        this.coldReadBytes += chunk.byteLength;
        budget.bytes -= chunk.byteLength;
        let lineEnd = chunk.length;
        if (position === searchEnd && chunk.at(-1) === 0x0a) lineEnd -= 1;
        while (lineEnd > 0) {
          const previous = chunk.lastIndexOf(0x0a, lineEnd - 1);
          if (previous < 0 && start > 0) {
            if (oversizedLine || suffixBytes + lineEnd > FIRST_SCREEN_WINDOW_MAX_BYTES) {
              oversizedLine = true;
              suffix.length = 0;
              suffixBytes = 0;
            } else {
              suffix.push(chunk.subarray(0, lineEnd));
              suffixBytes += lineEnd;
            }
            break;
          }
          const lineStart = previous + 1;
          const prefix = chunk.subarray(lineStart, lineEnd);
          const boundary = start + lineStart;
          if (oversizedLine) {
            oversizedLine = false;
            recordEnd = boundary;
            lineEnd = previous;
            await yieldIfTimeBudgetExceeded(yieldBudget, signal);
            continue;
          }
          const line = suffix.length === 0 ? prefix : Buffer.concat([prefix, ...suffix.toReversed()]);
          suffix.length = 0;
          suffixBytes = 0;
          if (line.length > 0) {
            scannedRecords += 1;
            budget.records -= 1;
            const skippableLoopEvent =
              line.length >= LOOP_EVENT_LINE_PREFIX.length &&
              line.subarray(0, LOOP_EVENT_LINE_PREFIX.length).equals(LOOP_EVENT_LINE_PREFIX) &&
              hasClosedJsonObjectFrame(line);
            const opaqueRecord = skippableLoopEvent ? undefined : transcriptWindowRecord(line);
            if (!skippableLoopEvent && opaqueRecord === undefined) {
              let record: ContextRecord;
              try {
                record = JSON.parse(line.toString('utf8')) as ContextRecord;
              } catch (error) {
                if (!(error instanceof SyntaxError) || recordEnd !== info.size) throw error;
                recordEnd = boundary;
                lineEnd = previous;
                await yieldIfTimeBudgetExceeded(yieldBudget, signal);
                continue;
              }
              if (record === null || typeof record !== 'object' || typeof record.type !== 'string') {
                throw new Error('wire.jsonl: invalid record');
              }
              const marker = classifySpanMarker(record, boundary, recordEnd);
              if (marker !== undefined) {
                if (marker.kind === 'visibility_reset' || marker.kind === 'implicit_turn' || marker.kind === 'turn_begin') {
                  return undefined;
                }
                markers.push(marker);
                if (marker.kind === 'turn.prompt' && marker.turnId !== undefined) {
                  const matchedExact = marker.turnId === beforeTurn;
                  const crossedBefore = !matchedExact && compareTurnIds(marker.turnId, beforeTurn) < 0;
                  if (matchedExact || (crossedBefore && fallbackAtSearchEnd !== undefined)) {
                    const resolvedAt = matchedExact ? boundary : fallbackAtSearchEnd!;
                    const after = await stat(wirePath);
                    signal.throwIfAborted();
                    const checked = await verifyWitnessAppendSafe(wirePath, beforeWitness, after, beforeWitness.completeTailOffset, FIRST_SCREEN_WINDOW_BYTES, signal);
                    if (!checked.valid) return undefined;
                    const afterWitness = checked.witness
                      ?? (after.size === beforeWitness.observedSize ? beforeWitness : await captureWirePrefixWitness(wirePath, after, signal));
                    if (afterWitness === undefined) return undefined;
                    const stamp = await sealStamp(wirePath);
                    const spanFingerprint = await this.reconcileColdSpanIndexes(wirePath, after, stamp, signal);
                    markers.reverse();
                    await this.recordColdTurnSpans(wirePath, spanFingerprint, markers, boundary, searchEnd, searchEnd >= after.size, after.size, undefined, { ...afterWitness, sealStamp: stamp }, signal);
                    return { at: resolvedAt, witness: afterWitness };
                  }
                  if (crossedBefore) return undefined;
                }
              }
            }
            if (scannedRecords >= maxScanRecords) return undefined;
          }
          recordEnd = boundary;
          lineEnd = previous;
          await yieldIfTimeBudgetExceeded(yieldBudget, signal);
        }
        position = start;
      }
      return undefined;
    } finally {
      this.coldReadRecords += scannedRecords;
      this.coldReadsCompleted += 1;
      this.coldReadDurationMs += performance.now() - startedAt;
      opened.close();
    }
  }

  private projectAnchored(snapshot: AgentTranscriptSnapshot, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot): AgentTranscriptSnapshot {
    const projected = project(snapshot);
    const state = this.anchorReads.get(snapshot);
    if (state !== undefined) this.anchorReads.set(projected, state);
    return projected;
  }

  private async readAnchorWindow(sessionId: string, agentId: string, wirePath: string, info: WireFileStat, key: string, seek: AnchorSeek,
    budget: AnchorReadBudget, signal?: AbortSignal): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    this.assertReadableAgent(sessionId, agentId);
    const { fingerprint } = seek;
    const fileSize = info.size;
    const end = Math.min(fileSize, Math.max(0, seek.at));
    const cached = this.anchorWindows.get(wirePath);
    const current = this.coldWireWindows.get(wirePath);
    if (cached !== undefined && cached.at === end && current !== undefined && current.payloadEvicted !== true &&
        current.start <= end && current.end >= end &&
        await this.matchesAppendSafeWitness(wirePath, cached, info, signal) &&
        await this.matchesAppendSafeWitness(wirePath, current, info, signal)) {
      if (fileSize > current.end) current.droppedTail = true;
      return cached.snapshot;
    }
    const opened = signal ?? new AbortController().signal;
    const seekWitness = seek.witness ?? await captureWirePrefixWitness(wirePath, info, opened);
    if (seekWitness === undefined) {
      this.anchorSeeks.delete(key);
      return this.pendingAnchor(agentId);
    }
    const window: AnchorWindowRead = seek.window === undefined
      ? { alignAt: Math.max(0, end - FIRST_SCREEN_WINDOW_BYTES), offset: 0, records: [] }
      : { ...seek.window, records: [...seek.window.records] };
    if (window.start === undefined) {
      const aligned = await this.scheduleHistoryRead(opened, owned => this.alignRecordStart(wirePath, window.alignAt, owned, budget));
      window.alignAt = aligned.next;
      window.start = aligned.start;
      window.offset = aligned.start ?? 0;
    }
    if (window.start !== undefined && window.end === undefined && budget.bytes > 0 && budget.records > 0) {
      const startedAt = Date.now();
      const read = await this.scheduleHistoryRead(opened, owned => this.readWireRecordsYielding(wirePath, {
        startByteOffset: window.offset,
        continuation: window.continuation,
        retainIncompleteRecord: true,
        endByteOffset: fileSize,
        maxBytes: budget.bytes,
        maxRecords: budget.records,
        chunkBytes: this.coldReadLimits.chunkBytes,
        signal: owned,
        decodeRecord: transcriptWindowRecord,
        onRecord: (record, span) => {
          if (record === null || typeof record !== 'object' || typeof record.type !== 'string') throw new Error('wire.jsonl: invalid record');
          window.records.push({ record, position: { startByteOffset: span.startByteOffset, endByteOffset: span.endByteOffset } });
          if (span.startByteOffset >= end) { window.end = span.endByteOffset; return false; }
          return true;
        },
      }));
      this.coldReadsCompleted += 1;
      this.coldReadBytes += read.bytesRead;
      this.coldReadRecords += read.recordCount;
      this.coldReadDurationMs += Date.now() - startedAt;
      budget.bytes -= read.bytesRead;
      budget.records -= read.recordCount;
      window.offset = read.nextByteOffset;
      window.continuation = read.continuation;
      if (read.complete || read.incompleteReason === 'partial_tail') window.end ??= read.nextByteOffset;
    }
    const after = await stat(wirePath);
    opened.throwIfAborted();
    const afterChecked = await verifyWitnessAppendSafe(wirePath, seekWitness, after, seek.visibilityCheckedTo, FIRST_SCREEN_WINDOW_BYTES, opened);
    if (!afterChecked.valid) {
      this.anchorSeeks.delete(key);
      return this.pendingAnchor(agentId);
    }
    const updatedSeek: AnchorSeek = {
      ...seek,
      witness: afterChecked.witness ?? seekWitness,
      visibilityCheckedTo: afterChecked.visibilityCheckedTo,
      window,
    };
    if (window.continuation !== undefined) this.clearRecordContinuations();
    this.rememberAnchorSeek(key, updatedSeek);
    if (window.start === undefined || window.end === undefined) return this.pendingAnchor(agentId);
    const { start, end: readEnd } = window;
    const afterWitness = afterChecked.witness
      ?? (after.size === seekWitness.observedSize ? seekWitness : await captureWirePrefixWitness(wirePath, after, opened));
    if (afterWitness === undefined) {
      this.anchorSeeks.delete(key);
      return this.pendingAnchor(agentId);
    }
    const stamp = await sealStamp(wirePath);
    const spanFingerprint = await this.reconcileColdSpanIndexes(wirePath, after, stamp, opened);
    const existingResetOffset = this.coldTurnSpans.get(wirePath)?.visibilityResetOffset;
    if (
      (existingResetOffset !== undefined && readEnd <= existingResetOffset) ||
      (readEnd < after.size && await rangeHasHardClear(wirePath, readEnd, after.size, FIRST_SCREEN_WINDOW_BYTES, opened))
    ) {
      this.anchorSeeks.delete(key);
      return undefined;
    }
    const afterFingerprint = wireExactFingerprint(after);
    const opening = readEnd < after.size ? await this.anchorOpeningRecords(wirePath, after, afterFingerprint, afterWitness, window.records, readEnd, after.size, opened, budget) : undefined;
    if (opening === 'pending') return this.pendingAnchor(agentId);
    const records = opening === undefined ? window.records : [...window.records, opening];
    const spanWitness = { ...afterWitness, sealStamp: stamp };
    await this.recordColdTurnSpansFromRecords(wirePath, spanFingerprint, window.records, start, readEnd, readEnd >= after.size, after.size, undefined, spanWitness, opened);
    this.recordColdToolTurnIdsFromRecords(wirePath, spanFingerprint, window.records, spanWitness, readEnd >= after.size ? spanWitness.completeTailOffset : readEnd);
    const snapshot = await this.projectColdRecords(agentId, records, start === 0, undefined, undefined, undefined, opened);
    opened.throwIfAborted();
    this.rememberAnchorSeek(key, { fingerprint: afterFingerprint, witness: afterWitness, visibilityCheckedTo: afterWitness.completeTailOffset, at: seek.at });
    const openingTurn = opening === undefined ? undefined : wireTurnId(window.records.at(-1)!.record);
    const headers = opening === undefined ? undefined : snapshot.items.flatMap(item => item.kind === 'turn' && item.turnId === openingTurn ? [{ ...item, steps: [] }] : []);
    const coldWindow: ColdWireWindow = { fingerprint: afterFingerprint, witness: afterWitness, visibilityCheckedTo: afterWitness.completeTailOffset, reachedTail: readEnd >= after.size, start, end: readEnd, entire: false, records: window.records,
      headers, headerAttachments: opening === undefined ? undefined : snapshot.attachments,
      snapshot, bytes: 0, droppedTail: readEnd < after.size };
    if (start > 0) {
      await this.resolveColdWindowHeaders(sessionId, agentId, wirePath, coldWindow, opened);
    }
    coldWindow.bytes = this.coldWindowBytes(coldWindow.snapshot, window.records);
    const preview = partialColdWindowSnapshot(coldWindow);
    this.anchorReads.set(preview, start === 0 ? 'window' : 'continues');
    this.rememberAnchorWindow(wirePath, afterFingerprint, afterWitness, end, preview);
    this.rememberColdWindow(wirePath, coldWindow);
    this.deleteColdSnapshotCache(wirePath);
    return preview;
  }

  private async anchorOpeningRecords(wirePath: string, info: WireFileStat, fingerprint: string, witness: WirePrefixWitness, records: readonly ColdWireRecord[], from: number, fileSize: number,
    signal: AbortSignal, budget: AnchorReadBudget): Promise<ColdWireRecord | 'pending' | undefined> {
    const opening = records.at(-1)?.record;
    if (opening?.type !== 'turn.prompt' || (opening as { managed?: unknown }).managed !== true) return undefined;
    const turnId = wireTurnId(opening);
    const promptId = (opening as { promptId?: unknown }).promptId;
    if (turnId === undefined) return undefined;
    if (budget.bytes <= 0 || budget.records <= 0) return 'pending';
    const cached = this.anchorOpeningSeeks.get(wirePath);
    const saved = cached !== undefined && cached.from === from &&
      await this.matchesAppendSafeWitness(wirePath, cached, info, signal)
      ? cached : undefined;
    const offset = saved?.offset ?? from;
    let deliveryRecord: ColdWireRecord | undefined;
    let ended = false;
    const read = await this.scheduleHistoryRead(signal, owned => this.readWireRecordsYielding(wirePath, {
      startByteOffset: offset,
      continuation: saved?.continuation,
      retainIncompleteRecord: true,
      endByteOffset: fileSize,
      maxRecords: Math.min(ANCHOR_OPENING_MAX_RECORDS, budget.records),
      maxBytes: budget.bytes,
      chunkBytes: this.coldReadLimits.chunkBytes,
      signal: owned,
      decodeRecord: transcriptWindowRecord,
      onRecord: (record, span) => {
        const recordTurn = wireTurnId(record);
        if (recordTurn !== undefined && recordTurn !== turnId) { ended = true; return false; }
        const delivery = (record as { delivery?: { turnId?: unknown; messageId?: unknown } }).delivery;
        const messageId = (record as { message?: { id?: unknown } }).message?.id;
        if (record.type === 'context.append_message' && delivery !== undefined &&
            (`t${String(delivery.turnId)}` === turnId || (promptId !== undefined && (delivery.messageId === promptId || messageId === promptId)))) {
          deliveryRecord = { record, position: { startByteOffset: span.startByteOffset, endByteOffset: span.endByteOffset } };
          return false;
        }
        if (record.type === 'turn.ended') { ended = true; return false; }
        return true;
      },
    }));
    signal.throwIfAborted();
    budget.bytes -= read.bytesRead;
    budget.records -= read.recordCount;
    this.coldReadBytes += read.bytesRead;
    this.coldReadRecords += read.recordCount;
    if (read.continuation !== undefined) this.clearRecordContinuations();
    const nextOffset = deliveryRecord?.position.startByteOffset ?? read.nextByteOffset;
    this.anchorOpeningSeeks.delete(wirePath);
    this.anchorOpeningSeeks.set(wirePath, { fingerprint, witness, visibilityCheckedTo: witness.completeTailOffset, from, offset: nextOffset, continuation: read.continuation });
    while (this.anchorOpeningSeeks.size > COLD_WIRE_WINDOWS_MAX_ENTRIES) {
      const oldest = this.anchorOpeningSeeks.keys().next().value;
      if (oldest === undefined) break;
      this.anchorOpeningSeeks.delete(oldest);
    }
    return deliveryRecord ?? (ended || read.complete ? undefined : 'pending');
  }

  private clearRecordContinuations(): void {
    for (const index of this.turnStartIndexes.values()) index.continuation = undefined;
    for (const seek of this.anchorOpeningSeeks.values()) seek.continuation = undefined;
    for (const seek of this.anchorSeeks.values()) if (seek.window !== undefined) seek.window.continuation = undefined;
  }

  private pendingAnchor(agentId: string): AgentTranscriptSnapshot {
    const pending: AgentTranscriptSnapshot = {
      ...new AgentTranscriptDraft(agentId).snapshot(),
      toolCallCount: undefined,
      toolCallCountKnown: false,
      hasMoreOlder: true,
    };
    this.anchorReads.set(pending, 'pending');
    return pending;
  }

  private async turnStartOffset(wirePath: string,
    info: WireFileStat,
    turnId: string, signal: AbortSignal, budget: AnchorReadBudget): Promise<{ kind: 'found'; at: number; witness?: WirePrefixWitness; window?: AnchorWindowRead } | { kind: 'pending' } | { kind: 'absent'; following?: number; witness?: WirePrefixWitness }> {
    const fingerprint = `${fileIdentity(info)}:${fileFingerprint(info)}`;
    let index = this.turnStartIndexes.get(wirePath);
    if (index !== undefined && index.fingerprint !== fingerprint) {
      const witnessMatched = await this.matchesAppendSafeWitness(wirePath, index, info, signal);
      index = witnessMatched ? { ...index, fingerprint, complete: false } : undefined;
    }
    index ??= { fingerprint, scannedTo: 0, complete: false, starts: new Map() };
    this.turnStartIndexes.delete(wirePath);
    this.turnStartIndexes.set(wirePath, index);
    while (this.turnStartIndexes.size > TURN_START_INDEX_MAX_WIRES) {
      const oldest = this.turnStartIndexes.keys().next().value;
      if (oldest === undefined) break;
      this.turnStartIndexes.delete(oldest);
    }
    const known = index.starts.get(turnId);
    if (known !== undefined) return { kind: 'found', at: known, witness: index.witness };
    if (index.complete) return { kind: 'absent', following: followingTurnStart(index.starts, turnId), witness: index.witness };
    const beforeWitness = await captureWirePrefixWitness(wirePath, info, signal);
    if (beforeWitness === undefined) return { kind: 'pending' };
    const starts = new Map(index.starts);
    const records: ColdWireRecord[] = [];
    const spanMarkers: ScannedSpanMarker[] = [];
    const toolTurnIds: Array<readonly [string, string]> = [];
    let scanTurnId: string | undefined;
    const startedAt = Date.now();
    const read = await this.readWireRecordsYielding(wirePath, {
      startByteOffset: index.scannedTo,
      continuation: index.continuation,
      retainIncompleteRecord: true,
      endByteOffset: info.size,
      maxBytes: budget.bytes,
      maxRecords: budget.records,
      chunkBytes: this.coldReadLimits.chunkBytes,
      signal,
      decodeRecord: transcriptWindowRecord,
      onRecord: (record, span) => {
        const marker = classifySpanMarker(record, span.startByteOffset, span.endByteOffset);
        if (marker !== undefined) spanMarkers.push(marker);
        if (marker?.kind === 'visibility_reset') scanTurnId = undefined;
        const found = wireTurnId(record);
        if (found !== undefined) {
          scanTurnId = found;
          if (!starts.has(found)) starts.set(found, span.startByteOffset);
        }
        const effectiveTurn = found ?? scanTurnId;
        if (effectiveTurn !== undefined) {
          for (const toolId of extractRecordToolCallIds(record)) {
            toolTurnIds.push([toolId, effectiveTurn]);
          }
        }
        records.push({ record, position: { startByteOffset: span.startByteOffset, endByteOffset: span.endByteOffset } });
        return found !== turnId;
      },
    });
    budget.bytes -= read.bytesRead;
    budget.records -= read.recordCount;
    this.coldReadsCompleted += 1;
    this.coldReadBytes += read.bytesRead;
    this.coldReadRecords += read.recordCount;
    this.coldReadDurationMs += Date.now() - startedAt;
    if (!read.complete && read.incompleteReason !== 'partial_tail' && read.incompleteReason !== 'record_budget') this.coldReadsFenced += 1;
    const proofThrough = read.nextByteOffset + (read.continuation?.chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0) ?? 0);
    const after = await stat(wirePath);
    signal.throwIfAborted();
    const afterChecked = await verifyWitnessAppendSafe(wirePath, beforeWitness, after, beforeWitness.completeTailOffset, FIRST_SCREEN_WINDOW_BYTES, signal);
    if (!afterChecked.valid) {
      this.turnStartIndexes.delete(wirePath);
      return { kind: 'pending' };
    }
    const nextWitness = after.size === beforeWitness.observedSize
      ? beforeWitness
      : await captureWirePrefixWitness(wirePath, after, signal);
    if (nextWitness === undefined) {
      this.turnStartIndexes.delete(wirePath);
      return { kind: 'pending' };
    }
    const stamp = await sealStamp(wirePath);
    const spanFingerprint = await this.reconcileColdSpanIndexes(wirePath, after, stamp, signal);
    const spanWitness = { ...nextWitness, sealStamp: stamp };
    const fullyComplete = read.complete && after.size === info.size;
    await this.recordColdTurnSpans(wirePath, spanFingerprint, spanMarkers, index.scannedTo, read.nextByteOffset, fullyComplete, after.size, undefined, spanWitness, signal);
    this.recordColdToolTurnIds(wirePath, spanFingerprint, toolTurnIds, spanWitness, fullyComplete ? spanWitness.completeTailOffset : read.nextByteOffset);
    if (read.continuation !== undefined) this.clearRecordContinuations();
    this.turnStartIndexes.set(wirePath, {
      fingerprint: wireExactFingerprint(after),
      witness: nextWitness,
      visibilityCheckedTo: nextWitness.completeTailOffset,
      scannedTo: read.nextByteOffset,
      complete: fullyComplete,
      proofThrough,
      starts,
      continuation: read.continuation,
    });
    const found = starts.get(turnId);
    if (found !== undefined) {
      let keepFrom = records.length - 1;
      while (keepFrom > 0 && records[keepFrom - 1]!.position.endByteOffset > read.nextByteOffset - FIRST_SCREEN_WINDOW_BYTES) keepFrom -= 1;
      const retained = records.slice(keepFrom);
      const start = retained[0]!.position.startByteOffset;
      return { kind: 'found', at: found, witness: nextWitness, window: { start, alignAt: start, offset: read.nextByteOffset, end: read.nextByteOffset, records: retained } };
    }
    return fullyComplete ? { kind: 'absent', following: followingTurnStart(starts, turnId), witness: nextWitness } : { kind: 'pending' };
  }

  private rememberAnchorWindow(wirePath: string, fingerprint: string, witness: WirePrefixWitness | undefined, at: number, snapshot: AgentTranscriptSnapshot): void {
    this.anchorWindows.delete(wirePath);
    const bytes = estimateColdSnapshotBytes(snapshot, COLD_WIRE_WINDOW_MAX_BYTES);
    if (bytes > COLD_WIRE_WINDOW_MAX_BYTES) return;
    this.anchorWindows.set(wirePath, { fingerprint, witness, visibilityCheckedTo: witness?.completeTailOffset, at, snapshot, bytes });
    while (this.anchorWindows.size > COLD_WIRE_WINDOWS_MAX_ENTRIES) {
      const oldest = this.anchorWindows.keys().next().value;
      if (oldest === undefined) break;
      this.anchorWindows.delete(oldest);
    }
  }

  private rememberAnchorSeek(key: string, seek: AnchorSeek): void {
    this.anchorSeeks.delete(key);
    if (seek.window !== undefined) for (const previous of this.anchorSeeks.values()) previous.window = undefined;
    this.anchorSeeks.set(key, seek);
    while (this.anchorSeeks.size > COLD_SNAPSHOT_CACHE_MAX_ENTRIES) {
      const oldest = this.anchorSeeks.keys().next().value;
      if (oldest === undefined) break;
      this.anchorSeeks.delete(oldest);
    }
  }

  private async indexedTurnByte(sessionId: string, agentId: string, turnId: string): Promise<number | undefined> {
    if (this.historyLocatorReader === undefined) return undefined;
    return this.detailLocator().indexedTurnByte(sessionId, agentId, turnId);
  }

  private resolveResidentLimits(): TranscriptResidentLimits | undefined {
    if (this.deps.residentLimits === false) return undefined;
    if (this.deps.residentLimits !== undefined) return this.deps.residentLimits;
    const flags = this.deps.core.accessor.get(IFlagService) as IFlagService | undefined;
    if (flags?.enabled(TRANSCRIPT_RESIDENT_WINDOW_FLAG_ID) === false) return undefined;
    const configured = (this.deps.core.accessor.get(IConfigService) as IConfigService | undefined)
      ?.get<TranscriptMemoryConfig>(TRANSCRIPT_MEMORY_SECTION);
    const config = { ...DEFAULT_TRANSCRIPT_MEMORY_CONFIG, ...configured };
    return { tailTurns: config.tailTurns, maxBytes: config.maxAgentBytes };
  }

  memoryReport(): TranscriptMemoryReport {
    let liveAgents = 0;
    let residentTurns = 0;
    let residentBytes = 0;
    let trimmedTurns = 0;
    let overBudgetAgents = 0;
    let opsJournalBatches = 0;
    for (const entry of this.live.values()) {
      const agentIds = new Set([
        ...entry.store.agents().map((descriptor) => descriptor.agentId),
        ...entry.agentHistory.keys(),
      ]);
      liveAgents += agentIds.size;
      for (const agentId of agentIds) {
        const transcript = entry.store.getAgent(agentId);
        if (transcript !== undefined) {
          const report = transcript.residentReport();
          residentTurns += report.turns;
          residentBytes += report.estimatedBytes;
          trimmedTurns += report.trimmedTurns;
          if (report.overBudget) overBudgetAgents += 1;
        }
      }
      for (const journal of entry.opsJournals.values()) {
        opsJournalBatches += this.opsJournalBatchCount(journal);
      }
    }
    return {
      liveSessions: this.live.size,
      liveAgents,
      residentTurns,
      residentBytes,
      trimmedTurns,
      overBudgetAgents,
      unverifiedResidentAgents: this.unverifiedResident.size,
      unverifiedResidentBytes: this.unverifiedResidentBytes,
      opsJournalBytes: this.opsJournalTotalBytes,
      opsJournalBatches,
      opsJournalDroppedBytes: this.opsJournalDroppedBytes,
      toolCallCacheEntries: this.persistedToolCallStates.size,
      toolCallCacheBytes: this.persistedToolCallStateWeight,
      coldWindowEntries: this.coldWireWindows.size,
      coldWindowBytes: this.coldWireWindowBytes,
      anchorWindowEntries: this.anchorWindows.size,
      anchorWindowBytes: [...this.anchorWindows.values()].reduce((bytes, entry) => bytes + entry.bytes, 0),
      anchorSeekEntries: this.anchorSeeks.size,
      coldSnapshotBytes: this.coldSnapshotCacheBytes,
      retainedTurnBytes: this.retainedColdTurnBytes,
      readLane: this.historyReads.report(),
      eventLoopDelay: {
        meanMs: Number.isFinite(this.eventLoopDelay.mean) ? this.eventLoopDelay.mean / 1e6 : 0,
        maxMs: this.eventLoopDelay.max / 1e6,
        p99Ms: this.eventLoopDelay.percentile(99) / 1e6,
      },
      coldReads: {
        completed: this.coldReadsCompleted,
        shared: this.coldReadsShared,
        cancelled: this.coldReadsCancelled,
        fenced: this.coldReadsFenced,
        bytes: this.coldReadBytes,
        records: this.coldReadRecords,
        durationMs: this.coldReadDurationMs,
      },
    };
  }

  dispose(): void {
    this.residencyMaintenance.dispose();
    this.historyReads.dispose();
    this.coldTodoReads.dispose();
    this.detailHistoryLocator?.invalidateCanonical();
    this.eventLoopDelay.disable();
    this.clearVerifiedWireReceipts();
    this.resolvedToolCallCounts.clear();
    for (const key of this.coldSnapshotCache.keys()) this.deleteColdSnapshotCache(key);
    this.coldWireWindows.clear();
    this.coldTurnSpans.clear();
    this.coldToolTurnIds.clear();
    this.coldWireWindowBytes = 0;
    for (const flight of this.coldWindowFlights.values()) {
      if (!flight.settled) flight.controller.abort(new DOMException('Transcript service is disposing', 'AbortError'));
    }
    this.coldWindowFlights.clear();
    for (const flight of this.coldTodosFlights.values()) {
      if (!flight.settled) flight.controller.abort(new DOMException('Transcript service is disposing', 'AbortError'));
    }
    this.coldTodosFlights.clear();
    this.coldTodosCache.clear();
    this.anchorSeeks.clear();
    this.anchorWindows.clear();
    this.turnStartIndexes.clear();
    this.anchorOpeningSeeks.clear();
    this.proximityMisses.clear();
    this.clearRetainedColdTurns();
    for (const sessionId of this.live.keys()) this.dropSession(sessionId);
  }

  private clearVerifiedWireReceipts(): void {
    for (const flight of this.verifiedWireReceiptFlights.values()) {
      if (!flight.settled) flight.controller.abort(
        new DOMException('Transcript service is disposing', 'AbortError'),
      );
    }
    this.verifiedWireReceiptFlights.clear();
    this.verifiedWireReceipts.clear();
    this.verifiedWireReceiptBytes = 0;
  }

  /** Dispose the live store + binding for a session (session closed / server shutdown). */
  dropSession(sessionId: string): void {
    this.residencyMaintenance.cancelPrefix(`${sessionId}\0`, new DOMException('Transcript session closed', 'AbortError'));
    for (const key of this.residentWeights.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.setResidentWeight(key, 0);
    }
    this.resolvedToolCallCounts.delete(sessionId);
    this.opsListeners.delete(sessionId);
    for (const key of this.unverifiedResident.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.deleteUnverifiedResident(key);
    }
    this.dropColdRetainedForSession(sessionId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    this.live.delete(sessionId);
    for (const journal of entry.opsJournals.values()) {
      this.disposeOpsJournal(entry, journal);
    }
    Promise.all([entry.agentCreation.dispose(), entry.agentDisposal.dispose(), entry.binding.dispose()]).catch((error: unknown) => {
      this.deps.logger?.warn({ sessionId, error }, 'transcript: session cleanup failed');
    });
  }
}

export function countToolCallFrames(items: AgentTranscriptSnapshot['items']): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      count += step.frames.filter((frame) => frame.kind === 'tool').length;
    }
  }
  return count;
}

function toolCallStateFromSnapshot(
  snapshot: AgentTranscriptSnapshot,
): MaterializedAgentToolCallState {
  const toolCallState: MaterializedAgentToolCallState = {
    toolFrameIdsByTurn: new Map(),
    toolCallCount: 0,
    known: snapshot.toolCallCountKnown !== false,
  };
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') {
          addToolFrame(toolCallState, item.turnId, step.stepId, frame.frameId);
        }
      }
    }
  }
  return toolCallState;
}

function applyToolCallOps(
  toolCallState: MaterializedAgentToolCallState,
  ops: readonly TranscriptOperation[],
): void {
  for (const op of ops) {
    if (op.op === 'reset') {
      const replacement = toolCallStateFromSnapshot(op.snapshot);
      toolCallState.toolFrameIdsByTurn.clear();
      for (const [turnId, frameIds] of replacement.toolFrameIdsByTurn) {
        toolCallState.toolFrameIdsByTurn.set(turnId, frameIds);
      }
      toolCallState.toolCallCount = replacement.toolCallCount;
      toolCallState.known = replacement.known;
    } else if (op.op === 'frame.upsert') {
      if (op.frame.kind === 'tool') {
        addToolFrame(toolCallState, op.turnId, op.stepId, op.frame.frameId);
      } else {
        removeToolFrame(toolCallState, op.turnId, op.stepId, op.frame.frameId);
      }
    } else if (op.op === 'items.remove') {
      for (const itemId of op.ids) removeToolTurn(toolCallState, itemId);
    }
  }
}

function addToolFrame(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
  stepId: string,
  frameId: string,
): void {
  let frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) {
    frameIds = new Set();
    toolCallState.toolFrameIdsByTurn.set(turnId, frameIds);
  }
  const key = `${stepId}\0${frameId}`;
  if (frameIds.has(key)) return;
  frameIds.add(key);
  toolCallState.toolCallCount += 1;
}

function removeToolFrame(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
  stepId: string,
  frameId: string,
): void {
  const frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) return;
  if (!frameIds.delete(`${stepId}\0${frameId}`)) return;
  toolCallState.toolCallCount -= 1;
  if (frameIds.size === 0) toolCallState.toolFrameIdsByTurn.delete(turnId);
}

function removeToolTurn(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
): void {
  const frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) return;
  toolCallState.toolCallCount -= frameIds.size;
  toolCallState.toolFrameIdsByTurn.delete(turnId);
}

/**
 * Flatten a snapshot into idempotent upsert ops (turn/step/frame upserts,
 * standalone items, tasks, meta). Deliberately never a `reset`: upserts merge
 * by id and keep ordinal order, so the backfill cannot clobber live ops that
 * landed while the records were being read. Global attachment entities flatten
 * too — without them a backfilled turn's `attachmentIds` would dangle.
 *
 * Standalone items (markers / taskrefs) carry a `beforeTurn` placement anchor:
 * the reducer's standalone path is append-only, so without an anchor a
 * historical marker replayed after live turns arrived would land past them.
 * The anchor is the ordinal of the snapshot turn directly following the item
 * (trailing items anchor past the last snapshot turn, which is where the
 * engine's next live turn lands); a turn-anchored insert places the item
 * before the first turn with `ordinal >= beforeTurn`.
 *
 * `turnOps` customizes the per-turn flattening (the backfill passes a
 * live-first merge; the default flattens wholesale for cold reads).
 */
export function snapshotToOps(
  snapshot: AgentTranscriptSnapshot,
  turnOps: (turn: TranscriptTurn) => TranscriptOperation[] = snapshotTurnOps,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const taskById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      if (item.kind === 'marker') {
        ops.push({ op: 'marker.upsert', item, beforeTurn });
        continue;
      }
      const task = taskById.get(item.taskId);
      const ownerBeforeTurn = task?.ownerTurnId !== undefined && Number.isSafeInteger(task.ownerTurnId)
        ? task.ownerTurnId + 1
        : undefined;
      const effectiveBeforeTurn = ownerBeforeTurn !== undefined && (beforeTurn === undefined || ownerBeforeTurn < beforeTurn)
        ? ownerBeforeTurn
        : beforeTurn;
      ops.push({ op: 'taskref.upsert', item, beforeTurn: effectiveBeforeTurn });
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      ops.push(...turnOps(item));
    } else {
      pending.push(item);
    }
  }
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const attachment of snapshot.attachments) {
    ops.push({ op: 'attachment.upsert', attachment });
  }
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  for (const interaction of snapshot.interactions) {
    ops.push({ op: 'interaction.upsert', interaction });
  }
  for (const todo of snapshot.todos) {
    ops.push({ op: 'todo.upsert', todo });
  }
  for (const prompt of snapshot.prompts) {
    ops.push({ op: 'prompt.upsert', prompt });
  }
  ops.push({ op: 'meta.merge', meta: snapshot.meta });
  return ops;
}

/** One snapshot turn flattened wholesale (the cold / unseen-turn path). */
export function snapshotTurnOps(turn: TranscriptTurn): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const { steps, ...header } = turn;
  ops.push({ op: 'turn.upsert', turn: header });
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: 'step.upsert', turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) {
      ops.push({ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}

function toolCallCountSetOperation(count: number | undefined): TranscriptOperation {
  const operation: ToolCountSetOp = { op: 'tool.count.set', count };
  return operation;
}

function snapshotToolCallCountKnown(snapshot: AgentTranscriptSnapshot): boolean {
  return snapshot.toolCallCountKnown !== false;
}

function knownSnapshot(snapshot: AgentTranscriptSnapshot, count: number): AgentTranscriptSnapshot {
  return {
    ...snapshot,
    toolCallCount: count,
    toolCallCountKnown: true,
  };
}

function unknownSnapshot(): AgentTranscriptSnapshot {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    toolCallCount: undefined,
    toolCallCountKnown: false,
    meta: {},
    hasMoreOlder: true,
  };
}

function isStorageCorrupted(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === StorageErrors.codes.STORAGE_CORRUPTED;
}

async function verifySealedWireBytes(wirePath: string, wire: WireTranscriptReceiptWire, signal: AbortSignal): Promise<boolean> {
  if (wire.size === 0) return false;
  if ('tailSha256' in wire) {
    const tail = await readWireTail(wirePath, wire.size, wire.tailBytes, signal);
    return tail.byteLength === wire.tailBytes && tail.at(-1) === 0x0a && wireTailSha256(tail) === wire.tailSha256;
  }
  const logical = await openLogicalWire(wirePath, signal);
  let digest: Awaited<ReturnType<typeof digestWireBytes>>;
  try {
    digest = logical === undefined
      ? await digestWireBytes(createReadStream(wirePath, { signal }))
      : await digestWireBytes(logical.chunks());
  } finally {
    logical?.close();
  }
  return digest.endsWithNewline && digest.size === wire.size && digest.sha256 === wire.sha256;
}

async function readWireTail(wirePath: string, size: number, length: number, signal: AbortSignal): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const logical = await openLogicalWire(wirePath);
  if (logical !== undefined) {
    try {
      if (logical.size !== size) return Buffer.alloc(0);
      return Buffer.from(await logical.readAt(size - length, length));
    } finally {
      logical.close();
    }
  }
  const handle = await open(wirePath, 'r');
  try {
    signal.throwIfAborted();
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sealStamp(wirePath: string): Promise<string> {
  try {
    const info = await stat(join(dirname(wirePath), `${basename(wirePath)}.segments.json`));
    return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'plain';
    throw error;
  }
}

function stateFingerprint(info: { readonly size: bigint; readonly ino: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint }): string {
  return `${String(info.size)}:${String(info.ino)}:${String(info.mtimeNs)}:${String(info.ctimeNs)}`;
}

function fileFingerprint(info: {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): string {
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function fileIdentity(info: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

async function readTranscriptProjectionCheckpoint(
  store: IQueryStore | undefined,
  key: string,
  fingerprint: string,
  fileSize: number,
): Promise<TranscriptProjectionCheckpoint | undefined> {
  if (store === undefined) return undefined;
  try {
    const value = await store.get<TranscriptProjectionCheckpoint>(
      TRANSCRIPT_CHECKPOINT_COLLECTION,
      key,
    );
    if (value === undefined) return undefined;
    if (
      value.format !== TRANSCRIPT_CHECKPOINT_FORMAT ||
      value.fingerprint !== fingerprint ||
      !Number.isSafeInteger(value.nextByteOffset) ||
      value.nextByteOffset < 0 ||
      value.nextByteOffset > fileSize ||
      (value.adapter?.version !== 1 && value.adapter?.version !== 2) ||
      !Array.isArray(value.acceptedDurableFacts)
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function mergeToolCallCount(
  persisted: MaterializedAgentToolCallState,
  live: MaterializedAgentToolCallState | undefined,
): number {
  let count = persisted.toolCallCount;
  for (const [turnId, frameIds] of live?.toolFrameIdsByTurn ?? []) {
    const prior = persisted.toolFrameIdsByTurn.get(turnId);
    for (const frameId of frameIds) if (!prior?.has(frameId)) count += 1;
  }
  return count;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function nonNegativeLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function completedResidentTurnIds(transcript: AgentTranscript): string[] {
  return transcript.getItems().flatMap(item => item.kind === 'turn' && item.state !== 'running' ? [item.turnId] : []);
}

function newestResidentTurnId(transcript: AgentTranscript): string | undefined {
  const items = transcript.getItems();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === 'turn') return item.turnId;
  }
  return undefined;
}

function estimateColdSnapshotBytes(snapshot: unknown, cap: number): number {
  let bytes = 0;
  const stack: unknown[] = [snapshot];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') bytes += value.length * 2;
    else if (typeof value === 'number' || typeof value === 'boolean') bytes += 8;
    else if (typeof value === 'object' && value !== null && !seen.has(value)) {
      seen.add(value);
      bytes += 64;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) stack.push(value[index]);
      } else {
        const record = value as Record<string, unknown>;
        for (const key in record) {
          if (!Object.hasOwn(record, key)) continue;
          bytes += key.length * 2;
          stack.push(record[key]);
        }
      }
    }
    if (bytes > cap) return bytes;
  }
  return bytes;
}

function estimateOpsJournalBatchBytes(ops: readonly TranscriptOperation[], cap: number): number {
  let bytes = 0;
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [];
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    stack.push({ value: ops[index], depth: 0 });
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    const value = node.value;
    if (typeof value === 'string') {
      bytes += value.length * 2;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      bytes += OPS_JOURNAL_ESTIMATE_SCALAR_BYTES;
    } else if (typeof value === 'object' && value !== null) {
      bytes += OPS_JOURNAL_ESTIMATE_NODE_OVERHEAD_BYTES;
      if (node.depth < OPS_JOURNAL_ESTIMATE_MAX_DEPTH) {
        const depth = node.depth + 1;
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) {
            stack.push({ value: value[index], depth });
          }
        } else {
          for (const nested of Object.values(value)) {
            stack.push({ value: nested, depth });
          }
        }
      }
    }
    if (bytes > cap) return bytes;
  }
  return bytes;
}

function findToolCallInTurns(
  turns: Iterable<TranscriptTurn>,
  toolCallId: string,
): { readonly turnId: string; readonly stepId: string; readonly frame: ToolCallFrame } | undefined {
  for (const turn of turns) {
    for (const step of turn.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
          return { turnId: turn.turnId, stepId: step.stepId, frame };
        }
      }
    }
  }
  return undefined;
}

function parseDirectPersistedTask(rawText: string, expectedTaskId: string): AgentTaskInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record['task_id'] === 'string' && record['task_id'] === expectedTaskId) {
    const statusRaw = record['status'];
    const status: AgentTaskInfo['status'] =
      statusRaw === 'awaiting_approval'
        ? 'running'
        : statusRaw === 'failed' && record['timed_out'] === true
          ? 'timed_out'
          : statusRaw === 'running' || statusRaw === 'completed' || statusRaw === 'failed' || statusRaw === 'killed' || statusRaw === 'lost'
            ? statusRaw
            : 'lost';
    const base = {
      taskId: expectedTaskId,
      description: typeof record['description'] === 'string' ? record['description'] : '',
      status,
      detached: true,
      startedAt: typeof record['started_at'] === 'number' ? record['started_at'] : 0,
      endedAt: typeof record['ended_at'] === 'number' ? record['ended_at'] : null,
      stopReason: typeof record['stop_reason'] === 'string' ? record['stop_reason'] : undefined,
    };
    if (expectedTaskId.startsWith('agent-')) {
      return {
        ...base,
        kind: 'agent',
        agentId: typeof record['agent_id'] === 'string' ? record['agent_id'] : undefined,
        profile: typeof record['subagent_type'] === 'string' ? record['subagent_type'] : undefined,
      };
    }
    return {
      ...base,
      kind: 'process',
      command: typeof record['command'] === 'string' ? record['command'] : '',
      pid: typeof record['pid'] === 'number' ? record['pid'] : 0,
      exitCode: typeof record['exit_code'] === 'number' ? record['exit_code'] : null,
    };
  }
  if (record['taskId'] !== expectedTaskId || typeof record['kind'] !== 'string') return undefined;
  return {
    ...(record as unknown as AgentTaskInfo),
    detached: typeof record['detached'] === 'boolean' ? record['detached'] : true,
  };
}

async function readBoundedFileHead(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const fileStat = await handle.stat();
    signal?.throwIfAborted();
    const length = Math.min(fileStat.size, maxBytes);
    if (length === 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let end = offset;
    if (fileStat.size > end && end > 0) {
      let start = end - 1;
      const minStart = Math.max(0, end - 4);
      while (start > minStart && (buffer[start]! & 0xc0) === 0x80) start -= 1;
      const lead = buffer[start]!;
      const expected = (lead & 0x80) === 0
        ? 1
        : (lead & 0xe0) === 0xc0
          ? 2
          : (lead & 0xf0) === 0xe0
            ? 3
            : (lead & 0xf8) === 0xf0
              ? 4
              : 1;
      if (start + expected > end) end = start;
    }
    return buffer.subarray(0, end).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readBoundedFileTail(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const fileStat = await handle.stat();
    signal?.throwIfAborted();
    const length = Math.min(fileStat.size, maxBytes);
    if (length === 0) return '';
    const startPos = fileStat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, startPos + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let trim = 0;
    if (startPos > 0) {
      while (trim < offset && (buffer[trim]! & 0xc0) === 0x80) trim += 1;
    }
    return buffer.subarray(trim, offset).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sliceUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  const tail = buf.subarray(buf.byteLength - maxBytes);
  let trim = 0;
  while (trim < tail.byteLength && (tail[trim]! & 0xc0) === 0x80) trim += 1;
  return tail.subarray(trim).toString('utf8');
}

function persistedTaskToTranscriptTask(
  info: AgentTaskInfo,
  outputText: string | undefined,
  agentMeta: AgentMeta | undefined,
): TranscriptTask {
  const kind: TranscriptTask['kind'] =
    info.kind === 'process'
      ? 'shell'
      : info.kind === 'agent'
        ? 'subagent'
        : info.kind === 'question' || info.kind === 'media'
          ? 'tool'
          : 'other';
  const state = info.status;
  const subagentInfo = info.kind === 'agent' ? info : undefined;
  const processInfo = info.kind === 'process' ? info : undefined;
  const questionInfo = info.kind === 'question' ? info : undefined;
  const resultSummary =
    info.kind === 'agent'
      ? (outputText !== undefined && outputText.length > 0 ? outputText : agentMeta?.resultSummary)
      : undefined;
  const outputTail =
    info.kind === 'process'
      ? (outputText ?? '')
      : info.kind === 'agent' && outputText !== undefined && outputText.length > 0
        ? sliceUtf8Tail(outputText, PERSISTED_TASK_OUTPUT_TAIL_BYTES)
        : '';
  return {
    taskId: info.taskId,
    kind,
    state,
    detached: info.detached ?? true,
    lifetime: info.lifetime,
    ownerAgentId: info.ownerAgentId,
    ownerTurnId: info.ownerTurnId,
    goalId: info.goalId,
    receipt: info.receiptVerification === 'invalid' ? undefined : info.receipt,
    receiptVerification: info.receiptVerification,
    name: subagentInfo?.collaborationTaskName ?? agentMeta?.userLabel,
    subagentName: subagentInfo?.profile ?? agentMeta?.displayName,
    model: subagentInfo?.model ?? agentMeta?.model,
    thinkingEffort: subagentInfo?.thinkingEffort ?? agentMeta?.thinkingEffort,
    thinkingEffortExplicit: subagentInfo?.thinkingEffortExplicit,
    executorId: subagentInfo?.executorId ?? agentMeta?.executor,
    executorProtocol: subagentInfo?.executorProtocol ?? agentMeta?.executorProtocol,
    sourceRef: subagentInfo?.sourceRef,
    parentToolCallId: subagentInfo?.parentToolCallId,
    toolCallId: questionInfo?.toolCallId,
    questionCount: questionInfo?.questionCount,
    exitCode: processInfo?.exitCode,
    taskKind: info.kind,
    description: info.description,
    command: processInfo?.command,
    agentId: subagentInfo?.agentId,
    outputTail,
    startedAt: Number.isFinite(info.startedAt) ? new Date(info.startedAt).toISOString() : undefined,
    endedAt: info.endedAt !== null && Number.isFinite(info.endedAt) ? new Date(info.endedAt).toISOString() : undefined,
    resultSummary,
    usage: agentMeta?.usage,
    error: state === 'failed' || state === 'timed_out' || state === 'lost' ? (info.stopReason ?? agentMeta?.error) : undefined,
    stateReason: info.stopReason,
  };
}

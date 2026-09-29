import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import { decodeHistoryDirectoryCursor, encodeHistoryDirectoryCursor,
  type HistoryDirectoryRequest, type HistoryDirectoryPage, type HistoryDirectoryTurn,
} from '@kiki/agent-core-v2/agent/tools/history/historyListTool';
import type { HistoryHit } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import type { IQueryStore, WriteOp } from '@kiki/agent-core-v2/persistence/interface/queryStore';
import { NavigationWireAdapter, openingText, type NavigationEffect } from '@kiki/transcript/navigationWireAdapter';
import { streamWireRecordsAwaited, type WireRecordSpan } from '@kiki/transcript-live/wireRecords';

import { decodeHistoryRef, encodeHistoryRef, hashHistoryRecord, historySourceIncarnation, verifyHistorySource,
  type HistorySourceAnchor, type HistoryRefKind } from './historySource';
import type { LazyHistoryNavigationDb } from './historyNavigationDb';
import { historyNavigationProof, matchesNavigationProof } from './historyNavigationProof';
import { matchHistoryText, planHistoryQuery, type HistoryMode } from './historyQuery';
import { makeSnippet } from '../../search/snippet';
import type { TranscriptService } from '../transcript/transcriptService';

export const HISTORY_NAV_COLLECTION = 'history_navigation_v1';
export const HISTORY_NAV_SCAN_BYTES = 8 << 20;
export const HISTORY_NAV_SCAN_RECORDS = 50_000;
const HISTORY_NAV_CHUNK_BYTES = 64 << 10;
const HISTORY_NAV_MAX_LINE_BYTES = 32 << 20;
const MAX_SCANNERS = 2;
const MAX_QUEUED_SCANS = 8;

export interface HistoryNavRow {
  readonly workspace: string;
  readonly session: string;
  readonly agent: string;
  readonly kind: HistoryRefKind;
  readonly turn: number;
  readonly position?: number;
  readonly ended?: boolean;
  readonly step?: string;
  readonly frame?: string;
  readonly part?: 'prompt' | 'text' | 'input' | 'output';
  readonly role?: 'user' | 'assistant' | 'tool';
  readonly toolName?: string;
  readonly time?: number;
  readonly excerpt?: string;
  readonly answerExcerpt?: string;
  readonly stepCount?: number;
  readonly toolCount?: number;
  readonly contentHash?: string;
  readonly length?: number;
  readonly selector?: string;
  readonly anchor: HistorySourceAnchor;
  readonly active: boolean;
}

export interface HistoryNavScan {
  readonly complete: boolean;
  readonly nextByteOffset: number;
  readonly ordinal: number;
  readonly bytesRead: number;
  readonly recordsRead: number;
  /** Extra source IO to advance the shared projection, separate from query coverage. */
  readonly projectionBytesRead?: number;
  readonly projectionRecordsRead?: number;
  readonly incarnation: string;
  readonly incompleteReason?: string;
  readonly hits?: readonly HistoryHit[];
}

export interface HistoryNavSearch {
  readonly query: string;
  readonly mode: HistoryMode;
  readonly role?: 'user' | 'assistant' | 'tool';
  readonly after?: number;
  readonly before?: number;
  readonly pageSize: number;
  readonly asOf?: number;
  readonly cursor?: { readonly offset: number; readonly incarnation: string };
}

export interface HistoryNavBlock {
  readonly ref: string;
  readonly turn: number;
  readonly stepId?: string;
  readonly role?: HistoryNavRow['role'];
  readonly toolName?: string;
  readonly part?: HistoryNavRow['part'];
  readonly text: string;
  readonly range: { readonly start: number; readonly end: number; readonly total: number; readonly unit: 'utf16' };
}

export interface HistoryNavBlocksPage {
  readonly status: 'ok' | 'stale_ref' | 'source_missing' | 'navigation_building';
  readonly blocks?: readonly HistoryNavBlock[];
  readonly next?: { readonly position: number; readonly offset: number; readonly watermark: number;
    readonly asOfBytes: number };
  readonly complete?: boolean;
}

interface Scanner {
  readonly adapter: NavigationWireAdapter;
  readonly incarnation: string;
  readonly generation: string;
  offset: number;
  ordinal: number;
}

interface PendingRecord {
  readonly operations: readonly NavigationEffect[];
  readonly span: WireRecordSpan;
  readonly digest: string;
  readonly recordTime?: number;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const NON_ASCII_LOWERCASE = /[^\u0000-\u007F]|[A-Z]/u;

function rowKey(row: Pick<HistoryNavRow, 'workspace' | 'session' | 'agent' | 'kind' | 'turn' | 'step' | 'frame' | 'part'>): string {
  return `${row.workspace}\0${row.session}\0${row.agent}\0${row.kind}\0${row.turn}\0${row.step ?? ''}\0${row.frame ?? ''}\0${row.kind === 'frame' ? row.part ?? '' : ''}`;
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((entry): entry is { type: 'text'; text: string } =>
    entry !== null && typeof entry === 'object' && (entry as { type?: unknown }).type === 'text' &&
    typeof (entry as { text?: unknown }).text === 'string').map((entry) => entry.text).join('');
}

function detachedExcerpt(text: string): string {
  return JSON.parse(JSON.stringify(text.slice(0, 120))) as string;
}

function originalText(record: Record<string, unknown>, part: HistoryNavRow['part'], selector?: string): string | undefined {
  const message = record['message'];
  const legacy = message !== null && typeof message === 'object' ? message as Record<string, unknown> : undefined;
  if (selector === 'message.content' && part === 'prompt') return openingText(legacy?.['content'], legacy?.['origin']);
  if (selector === 'message.content' && part === 'output') return outputText(legacy?.['content']);
  if (selector?.startsWith('message.content.') && part === 'text') {
    const index = Number(selector.slice('message.content.'.length));
    const value = Array.isArray(legacy?.['content']) ? legacy['content'][index] as Record<string, unknown> | undefined : undefined;
    return value?.['type'] === 'text' ? value['text'] as string : undefined;
  }
  if (selector?.startsWith('message.toolCalls.') && part === 'input') {
    const index = Number(selector.slice('message.toolCalls.'.length, -'.arguments'.length));
    const call = Array.isArray(legacy?.['toolCalls']) ? legacy['toolCalls'][index] as Record<string, unknown> | undefined : undefined;
    const arg = call?.['arguments'];
    if (typeof arg !== 'string') return undefined;
    try { return JSON.stringify(JSON.parse(arg)); } catch { return JSON.stringify(arg); }
  }
  const event = record['event'];
  const data = event !== null && typeof event === 'object' ? event as Record<string, unknown> : undefined;
  if (part === 'prompt') {
    const input = record['input'];
    if (record['type'] === 'turn.prompt' && Array.isArray(input)) return openingText(input, record['origin']);
    return undefined;
  }
  if (part === 'text') {
    const content = data?.['part'];
    if (data?.['type'] === 'content.part' && content !== null && typeof content === 'object' &&
        (content as Record<string, unknown>)['type'] === 'text') {
      return (content as Record<string, unknown>)['text'] as string | undefined;
    }
    return undefined;
  }
  if (part === 'input' && data?.['type'] === 'tool.call') return JSON.stringify(data['args'] ?? null);
  if (part === 'output' && data?.['type'] === 'tool.result') {
    const result = data['result'];
    return result !== null && typeof result === 'object'
      ? outputText((result as Record<string, unknown>)['output']) : undefined;
  }
  return undefined;
}

export class HistoryLocatorStore {
  private readonly scanners = new Map<string, Scanner>();
  private readonly flights = new Map<string, Promise<HistoryNavScan>>();
  private scanTail: Promise<void> = Promise.resolve();
  private queuedScans = 0;

  constructor(private readonly store: Pick<IQueryStore, 'get' | 'put' | 'batch' | 'pageByColumn'>,
    private readonly transcript: TranscriptService) {}

  get retainedBodyChars(): number {
    let chars = 0;
    for (const scanner of this.scanners.values()) chars += scanner.adapter.retainedBodyChars;
    return chars;
  }

  async scan(session: string, agent: string, signal?: AbortSignal,
    search?: HistoryNavSearch): Promise<HistoryNavScan | undefined> {
    const location = await this.transcript.historyWireLocation(session, agent);
    if (location === undefined) return undefined;
    const { wirePath, workspaceId: workspace } = location;
    const incarnation = await historySourceIncarnation(wirePath);
    if (incarnation === undefined) return undefined;
    const key = `${workspace}\0${session}\0${agent}`;
    // Search callers have independent cancellation signals; only unfiltered
    // projection scans share a flight.
    const existing = search === undefined ? this.flights.get(key) : undefined;
    if (existing !== undefined) return existing;
    if (this.queuedScans >= MAX_QUEUED_SCANS) throw new Error('history_navigation_busy');
    this.queuedScans += 1;
    const previous = this.scanTail;
    let release!: () => void;
    this.scanTail = new Promise<void>((resolve) => { release = resolve; });
    const flight = (async (): Promise<HistoryNavScan> => {
      try {
        await previous;
        signal?.throwIfAborted();
        const input = { workspace, session, agent, wirePath, incarnation, key, signal };
        return await (search !== undefined && 'ready' in this.store
          ? this.scanSearchSlice(input, search) : this.scanSlice({ ...input, search }));
      } catch (error) {
        this.scanners.delete(key);
        if ('ready' in this.store) {
          const db = await (this.store as LazyHistoryNavigationDb).ready().catch(() => undefined);
          db?.rollbackSlice();
        }
        throw error;
      } finally {
        this.queuedScans -= 1;
        release();
      }
    })();
    if (search === undefined) this.flights.set(key, flight);
    try { return await flight; }
    catch (error) { this.scanners.delete(key); throw error; }
    finally { if (this.flights.get(key) === flight) this.flights.delete(key); }
  }

  /** Search reads a fixed byte page against the one durable session projection. Query state is ephemeral. */
  private async scanSearchSlice(input: { workspace: string; session: string; agent: string; wirePath: string;
    incarnation: string; key: string; signal?: AbortSignal }, search: HistoryNavSearch): Promise<HistoryNavScan> {
    const db = await (this.store as LazyHistoryNavigationDb).ready();
    const start = search.cursor?.offset ?? 0;
    const fileSize = (await stat(input.wirePath)).size;
    const asOf = search.asOf ?? fileSize;
    if (search.cursor !== undefined && search.cursor.incarnation !== input.incarnation ||
        !Number.isSafeInteger(asOf) || asOf < 0 || asOf > fileSize ||
        !Number.isSafeInteger(start) || start < 0 || start > asOf) throw new Error('stale_scan_cursor');
    const target = Math.min(asOf, start + HISTORY_NAV_SCAN_BYTES);
    let saved = db.readManifest(input.key);
    // Even a completed projection must be checked before using source-derived rows.
    if (saved !== undefined) {
      const manifest = saved;
      if (manifest.incarnation !== input.incarnation ||
          !await historyNavigationProof(input.wirePath, manifest.offset)
            .then((proof) => matchesNavigationProof(manifest.source, proof), () => false)) {
        if (search.cursor !== undefined) throw new Error('stale_scan_cursor');
        saved = undefined;
      }
    }
    if (saved !== undefined && saved.offset > asOf) throw new Error('stale_scan_cursor');
    let projected: HistoryNavScan | undefined;
    let projectionBytesRead = 0;
    let projectionRecordsRead = 0;
    while (saved === undefined || saved.offset < target) {
      input.signal?.throwIfAborted();
      const before = saved?.offset ?? 0;
      projected = await this.scanSlice({ ...input, stopAt: target });
      projectionBytesRead += projected.bytesRead;
      projectionRecordsRead += projected.recordsRead;
      saved = db.readManifest(input.key);
      if (saved === undefined || saved.offset <= before || projected.complete && saved.offset < target) break;
    }
    const available = Math.min(target, saved?.offset ?? 0);
    if (available <= start) return { complete: start === asOf, nextByteOffset: start,
      ordinal: saved?.ordinal ?? 0, bytesRead: 0, recordsRead: 0,
      projectionBytesRead, projectionRecordsRead, incarnation: input.incarnation,
      incompleteReason: start === asOf ? undefined : projected?.incompleteReason ?? 'byte_budget', hits: [] };
    const plan = planHistoryQuery(search.query, search.mode);
    const asciiClauses = plan.mode !== 'terms' && plan.clauses.length > 0 &&
      plan.clauses.every((clause) => !NON_ASCII_LOWERCASE.test(clause.text))
      ? plan.clauses.map((clause) => clause.text) : undefined;
    const hits: HistoryHit[] = [];
    const emitted = new Set<string>();
    let matchedRecords = 0;
    const read = await streamWireRecordsAwaited(input.wirePath, {
      startByteOffset: start, maxBytes: available - start, maxRecords: HISTORY_NAV_SCAN_RECORDS,
      maxLineBytes: HISTORY_NAV_MAX_LINE_BYTES, chunkBytes: HISTORY_NAV_CHUNK_BYTES,
      signal: input.signal, includeRawRecord: true,
      onRecord: async (record, span, raw) => {
        // Most canonical records carry no searchable text. Check the single source
        // field before a disk lookup; legacy messages can carry several parts and
        // still use the source-row path below.
        const event = record['event'];
        const eventType = event !== null && typeof event === 'object'
          ? (event as Record<string, unknown>)['type'] : undefined;
        const canonicalPart = record['type'] === 'turn.prompt' ? 'prompt' :
          eventType === 'content.part' ? 'text' : eventType === 'tool.result' ? 'output' : undefined;
        if (canonicalPart !== undefined) {
          const candidate = originalText(record, canonicalPart);
          if (candidate === undefined) return;
          // NFKC leaves lowercase ASCII unchanged. A missing ASCII clause can
          // therefore be rejected before allocating a normalized 8 KiB+ body;
          // Unicode or uppercase source text keeps the full matcher semantics.
          if (asciiClauses !== undefined && !NON_ASCII_LOWERCASE.test(candidate) &&
              !asciiClauses.some((clause) => candidate.includes(clause))) return;
          if (matchHistoryText(candidate, plan) === undefined) return;
        } else if (record['type'] === 'context.append_loop_event' || record['type'] === 'turn.ended') return;
        const rows = db.rowsAtSource(input.workspace, input.session, input.agent, span.startByteOffset);
        if (rows.length === 0) return;
        const recordDigest = hashHistoryRecord(raw!);
        let matched = false;
        for (const row of rows) {
          // Completed turn rows written by the previous indexer kept the prompt
          // but dropped its role during the turn.ended metadata update.
          const role = row.role ?? (row.kind === 'turn' && row.part === 'prompt' ? 'user' : undefined);
          if (row.part === undefined || row.part === 'input' || role === undefined ||
              row.anchor.end !== span.endByteOffset || row.anchor.digest !== recordDigest ||
              search.role !== undefined && role !== search.role ||
              search.after !== undefined && (row.time === undefined || row.time < search.after) ||
              search.before !== undefined && (row.time === undefined || row.time >= search.before) ||
              emitted.has(rowKey(row))) continue;
          const parent = await db.get<HistoryNavRow>(HISTORY_NAV_COLLECTION, rowKey({ ...row,
            kind: 'turn', step: undefined, frame: undefined }));
          if (parent?.active !== true) continue;
          const text = originalText(record, row.part, row.selector);
          if (text === undefined || digest(text) !== row.contentHash) continue;
          const match = matchHistoryText(text, plan);
          if (match === undefined) continue;
          matched = true;
          emitted.add(rowKey(row));
          hits.push({ sessionId: row.session, agentId: row.agent, turn: row.turn, stepId: row.step,
            role, time: row.time, matched: match.matched,
            ref: this.ref(row, match.start), snippet: makeSnippet(text, match.matched[0] ?? search.query) });
        }
        if (matched) matchedRecords += 1;
        return matchedRecords < search.pageSize;
      },
    });
    const throughWatermark = read.nextByteOffset >= asOf;
    const complete = throughWatermark || read.complete && available >= asOf;
    return { complete, nextByteOffset: read.nextByteOffset, ordinal: saved?.ordinal ?? 0,
      bytesRead: read.bytesRead, recordsRead: read.recordCount,
      projectionBytesRead, projectionRecordsRead, incarnation: input.incarnation,
      incompleteReason: complete ? undefined : read.incompleteReason ?? projected?.incompleteReason,
      hits };
  }

  private async scanSlice(input: { workspace: string; session: string; agent: string; wirePath: string;
    incarnation: string; key: string; signal?: AbortSignal; search?: HistoryNavSearch;
    stopAt?: number }): Promise<HistoryNavScan> {
    const stateDb = 'ready' in this.store
      ? await (this.store as LazyHistoryNavigationDb).ready() : undefined;
    let scanner = this.scanners.get(input.key);
    const saved = stateDb?.readManifest(input.key);
    const cursor = saved === undefined ? undefined : stateDb?.readAdapterCursor(input.key);
    const sourceMatches = saved !== undefined && cursor?.ordinal === saved.ordinal &&
      saved.incarnation === input.incarnation && await historyNavigationProof(input.wirePath, saved.offset)
        .then((proof) => matchesNavigationProof(saved.source, proof), () => false);
    const freshSearch = input.search !== undefined && input.search.cursor === undefined;
    const rebuild = stateDb === undefined
      ? freshSearch || scanner === undefined || scanner.incarnation !== input.incarnation
      : !sourceMatches;
    stateDb?.beginSlice();
    if (rebuild) {
      stateDb?.clearProjection(input.key, input.workspace, input.session, input.agent);
      scanner = undefined;
    }
    if (scanner === undefined || scanner.incarnation !== input.incarnation) {
      const adapter = new NavigationWireAdapter(input.agent, stateDb?.scalarState(input.key));
      if (!rebuild && cursor !== undefined) adapter.restore(cursor);
      scanner = { adapter, incarnation: input.incarnation,
        generation: !rebuild && saved !== undefined ? saved.generation : randomUUID(),
        offset: !rebuild && saved !== undefined ? saved.offset : 0,
        ordinal: !rebuild && saved !== undefined ? saved.ordinal : 0 };
      this.scanners.delete(input.key);
      if (this.scanners.size >= MAX_SCANNERS) this.scanners.delete(this.scanners.keys().next().value!);
      this.scanners.set(input.key, scanner);
    }
    if (input.search?.cursor !== undefined && (scanner.offset !== input.search.cursor.offset ||
        scanner.incarnation !== input.search.cursor.incarnation)) throw new Error('stale_scan_cursor');
    const pending: PendingRecord[] = [];
    const store = this.store;
    const plan = input.search === undefined ? undefined : planHistoryQuery(input.search.query, input.search.mode);
    let matchedRecords = 0;
    const writes: WriteOp[] = [];
    const touched = new Map<string, HistoryNavRow>();
    const hits: HistoryHit[] = [];
    const emitted = new Set<string>();
    const addHit = (row: HistoryNavRow, text: string): void => {
      if (plan === undefined || row.role === undefined ||
          input.search?.role !== undefined && row.role !== input.search.role ||
          input.search?.after !== undefined && (row.time === undefined || row.time < input.search.after) ||
          input.search?.before !== undefined && (row.time === undefined || row.time >= input.search.before)) return;
      const match = matchHistoryText(text, plan);
      if (match === undefined || emitted.has(rowKey(row))) return;
      emitted.add(rowKey(row));
      hits.push({ sessionId: row.session, agentId: row.agent, turn: row.turn, stepId: row.step,
        role: row.role, time: row.time, matched: match.matched,
        ref: this.ref(row, match.start), snippet: makeSnippet(text, match.matched[0] ?? input.search!.query) });
    };
    const load = async (key: string): Promise<HistoryNavRow | undefined> => {
      if (touched.has(key)) return touched.get(key);
      const row = await this.store.get<HistoryNavRow>(HISTORY_NAV_COLLECTION, key);
      if (row !== undefined) touched.set(key, row);
      return row;
    };
    let pendingBytes = 0;
    const read = await streamWireRecordsAwaited(input.wirePath, {
      startByteOffset: scanner.offset, startRecordOrdinal: scanner.ordinal,
      maxBytes: input.stopAt === undefined && input.search?.asOf === undefined ? HISTORY_NAV_SCAN_BYTES :
        Math.min(HISTORY_NAV_SCAN_BYTES, Math.max(0, (input.stopAt ?? input.search!.asOf!) - scanner.offset)),
      maxRecords: HISTORY_NAV_SCAN_RECORDS,
      maxLineBytes: HISTORY_NAV_MAX_LINE_BYTES, chunkBytes: HISTORY_NAV_CHUNK_BYTES,
      signal: input.signal, includeRawRecord: true,
      onRecord: async (record, span, raw) => {
        const projected = scanner.adapter.add(record);
        pending.push({ operations: projected, span,
          digest: hashHistoryRecord(raw!), recordTime: typeof record['time'] === 'number' ? record['time'] : undefined });
        pendingBytes += span.endByteOffset - span.startByteOffset;
        if (plan !== undefined) {
          const hasMatch = projected.some((op) => {
            const time = typeof record['time'] === 'number' ? record['time'] : undefined;
            if (input.search?.after !== undefined && (time === undefined || time < input.search.after) ||
                input.search?.before !== undefined && (time === undefined || time >= input.search.before)) return false;
            if (op.op === 'turn.upsert' && input.search?.role !== 'assistant' && input.search?.role !== 'tool') {
              return op.turn.prompt !== undefined && matchHistoryText(op.turn.prompt, plan) !== undefined;
            }
            if (op.op !== 'frame.upsert') return false;
            const frame = op.frame;
            if (frame.kind === 'text' && frame.role === 'assistant' && frame.text !== undefined &&
                (input.search?.role === undefined || input.search.role === 'assistant')) {
              return matchHistoryText(frame.text, plan) !== undefined;
            }
            if (frame.kind === 'tool' && (input.search?.role === undefined || input.search.role === 'tool')) {
              return frame.output !== undefined && matchHistoryText(outputText(frame.output), plan) !== undefined;
            }
            return false;
          });
          if (hasMatch) matchedRecords += 1;
        }
        const pageFull = input.search !== undefined && matchedRecords >= input.search.pageSize;
        if (pageFull || pending.length >= 128 || pendingBytes >= (1 << 20)) await flushPending();
        return !pageFull;
      },
    });
    async function flushPending(): Promise<void> {
      const commitTouched = async (): Promise<void> => {
        for (const [key, value] of touched) writes.push({ kind: 'put', collection: HISTORY_NAV_COLLECTION,
          key, value, columns: { turn: value.turn, time: value.time ?? 0, position: value.position ?? 0 } });
        if (writes.length > 0) await store.batch(writes);
        writes.length = 0;
        touched.clear();
      };
      for (const record of pending) {
      input.signal?.throwIfAborted();
      const anchorBase = { v: 1 as const, workspace: input.workspace, session: input.session,
        agent: input.agent, incarnation: input.incarnation,
        start: record.span.startByteOffset, end: record.span.endByteOffset, digest: record.digest };
      let sequence = 0;
      const nextPosition = (): number => {
        if (sequence >= 1024 || !Number.isSafeInteger(record.span.ordinal * 1024 + sequence)) {
          throw new Error('history navigation record contains too many projected entries');
        }
        return record.span.ordinal * 1024 + sequence++;
      };
      for (const operation of record.operations) {
        if (operation.op === 'turn.upsert') {
          const turn = operation.turn;
          const row: HistoryNavRow = { workspace: input.workspace, session: input.session,
            agent: input.agent, kind: 'turn', turn: turn.ordinal, position: nextPosition(),
            ended: turn.state !== 'running',
            time: turn.startedAt === undefined ? record.recordTime : Date.parse(turn.startedAt),
            excerpt: turn.prompt === undefined ? undefined : detachedExcerpt(turn.prompt),
            contentHash: turn.prompt === undefined ? undefined : digest(turn.prompt),
            length: turn.prompt?.length, part: turn.prompt === undefined ? undefined : 'prompt',
            role: turn.prompt === undefined ? undefined : 'user', selector: turn.selector,
            anchor: { ...anchorBase, kind: 'turn', turn: turn.ordinal }, active: true };
          const key = rowKey(row);
          const old = await load(key);
          touched.set(key, { ...row, position: old?.active ? old.position ?? row.position : row.position,
            time: turn.startedAt === undefined && old?.active ? old.time : row.time,
            excerpt: row.excerpt ?? old?.excerpt,
            contentHash: row.contentHash ?? old?.contentHash, length: row.length ?? old?.length,
            part: row.part ?? old?.part, role: row.role ?? old?.role,
            selector: row.part === undefined ? old?.selector : row.selector,
            answerExcerpt: old?.answerExcerpt,
            stepCount: old?.active ? old.stepCount ?? 0 : 0,
            toolCount: old?.active ? old.toolCount ?? 0 : 0,
            anchor: old?.active && old.contentHash === row.contentHash ||
              row.part === undefined && old?.active ? old.anchor : row.anchor });
          if (turn.prompt !== undefined) addHit(old?.active && old.contentHash === row.contentHash ? old : row, turn.prompt);
        } else if (operation.op === 'step.upsert') {
          const turn = Number(operation.turnId.slice(1));
          const step = `t${turn}.${operation.step.ordinal}`;
          const row: HistoryNavRow = { workspace: input.workspace, session: input.session,
            agent: input.agent, kind: 'step', turn, step, position: nextPosition(),
            ended: operation.step.state !== 'running',
            time: operation.step.startedAt === undefined ? record.recordTime : Date.parse(operation.step.startedAt),
            anchor: { ...anchorBase, kind: 'step', turn, step }, active: true };
          const previousStep = await load(rowKey(row));
          touched.set(rowKey(row), previousStep?.active ? { ...row,
            anchor: previousStep.anchor, position: previousStep.position ?? row.position } : row);
          if (previousStep?.active !== true) {
            const turnId = rowKey({ ...row, kind: 'turn', step: undefined });
            const parent = await load(turnId);
            if (parent !== undefined) touched.set(turnId, { ...parent, stepCount: (parent.stepCount ?? 0) + 1 });
          }
        } else if (operation.op === 'frame.upsert') {
          const turn = Number(operation.turnId.slice(1));
          const step = `t${turn}.${operation.stepOrdinal}`;
          const frame = operation.frame;
          if (frame.kind !== 'text' && frame.kind !== 'tool') continue;
          const parts: Array<{ part: 'text' | 'input' | 'output'; text: string;
            role: HistoryNavRow['role']; selector?: string }> = [];
          if (frame.kind === 'text' && frame.role === 'assistant' && frame.text !== undefined) {
            parts.push({ part: 'text', text: frame.text, role: 'assistant', selector: frame.selector });
          } else if (frame.kind === 'tool') {
            if (frame.input !== undefined) parts.push({ part: 'input', text: JSON.stringify(frame.input),
              role: 'tool', selector: frame.selector });
            if (frame.output !== undefined) parts.push({ part: 'output', text: outputText(frame.output),
              role: 'tool', selector: frame.selector });
          }
          for (const part of parts) {
            const id = `${frame.frameId}:${part.part}`;
            if (id.length > 256) continue;
            const row: HistoryNavRow = { workspace: input.workspace, session: input.session,
              agent: input.agent, kind: 'frame', turn, step, frame: id, part: part.part, role: part.role,
              position: nextPosition(), toolName: frame.kind === 'tool' ? frame.name : undefined,
              time: record.recordTime, excerpt: detachedExcerpt(part.text), length: part.text.length,
              contentHash: digest(part.text), selector: part.selector,
              anchor: { ...anchorBase, kind: 'frame', turn, step, frame: id },
              active: true };
            const rowId = rowKey(row);
            const old = await load(rowId);
            if (old?.contentHash === row.contentHash && old?.active === true) {
              if (old.position === undefined) touched.set(rowId, { ...old, position: row.position });
              if (part.part !== 'input') addHit(old, part.text);
              continue;
            }
            touched.set(rowId, { ...row, position: old?.active ? old.position ?? row.position : row.position });
            const parentKey = rowKey({ ...row, kind: 'turn', step: undefined, frame: undefined });
            const parent = await load(parentKey);
            if (parent !== undefined) {
              const countTool = frame.kind === 'tool' && part.part === 'input' && old === undefined;
              const firstAnswer = frame.kind === 'text' && parent.answerExcerpt === undefined;
              if (countTool || firstAnswer) touched.set(parentKey, { ...parent,
                toolCount: (parent.toolCount ?? 0) + (countTool ? 1 : 0),
                answerExcerpt: firstAnswer ? detachedExcerpt(part.text) : parent.answerExcerpt });
            }
            if (part.part !== 'input') addHit(row, part.text);
          }
        } else if (operation.op === 'visibility.reset') {
          if (stateDb !== undefined) {
            await commitTouched();
            stateDb.deactivateRange({ scope: input.key, workspace: input.workspace,
              session: input.session, agent: input.agent,
              range: operation.sequenceRange, retain: operation.retain });
            continue;
          }
          const removed = new Set(operation.turns);
          if (operation.retain !== undefined) removed.add(operation.retain.turn);
          for (const turn of removed) {
            let position = -1;
            for (;;) {
              const page = await store.pageByColumn<HistoryNavRow>(HISTORY_NAV_COLLECTION, {
                column: 'position', dir: 'asc',
                filter: { workspace: input.workspace, session: input.session, agent: input.agent, turn },
                bounds: { gt: position }, limit: 128,
              });
              if (page.items.length === 0) break;
              for (const row of page.items) {
                if (row.position === undefined) continue;
                const retain = operation.retain?.turn === turn;
                if (retain && (row.kind === 'turn' || row.position < operation.retain.beforeOrdinal * 1024)) continue;
                touched.set(rowKey(row), { ...row, active: false });
              }
              position = page.items.at(-1)?.position ?? position;
              if (page.items.length < 128) break;
            }
            for (const [key, row] of touched) {
              if (row.turn !== turn) continue;
              if (operation.retain?.turn === turn && (row.kind === 'turn' ||
                  (row.position ?? -1) < operation.retain.beforeOrdinal * 1024)) continue;
              touched.set(key, { ...row, active: false });
            }
            if (operation.retain?.turn !== turn) {
              const parentKey = rowKey({ workspace: input.workspace, session: input.session, agent: input.agent,
                kind: 'turn', turn });
              const old = await load(parentKey);
              if (old !== undefined) touched.set(parentKey, { ...old, active: false });
            }
          }
        }
      }
    }
      await commitTouched();
      pending.length = 0;
      pendingBytes = 0;
    }
    await flushPending();
    const nextOrdinal = scanner.ordinal + read.recordCount;
    if (stateDb !== undefined) {
      const proof = await historyNavigationProof(input.wirePath, read.nextByteOffset);
      if (proof.identity !== input.incarnation) throw new Error('history_source_changed');
      stateDb.commitSlice(input.key, { v: 2, generation: scanner.generation,
        incarnation: input.incarnation, offset: read.nextByteOffset, ordinal: nextOrdinal,
        complete: read.complete, source: proof }, scanner.adapter.checkpoint());
    } else {
      await this.store.put(HISTORY_NAV_COLLECTION, `${input.key}\0checkpoint`, {
        v: 1, incarnation: input.incarnation, offset: read.nextByteOffset, ordinal: nextOrdinal,
        complete: read.complete,
      });
    }
    scanner.offset = read.nextByteOffset;
    scanner.ordinal = nextOrdinal;
    const activeHits: HistoryHit[] = [];
    for (const hit of hits) {
      const parent = await load(rowKey({ workspace: input.workspace, session: input.session, agent: input.agent,
        kind: 'turn', turn: hit.turn! }));
      if (parent?.active === false || hit.ref === undefined) continue;
      const anchor = decodeHistoryRef(hit.ref);
      const row = await load(rowKey({ workspace: input.workspace, session: input.session, agent: input.agent,
        kind: anchor.kind, turn: anchor.turn, step: anchor.step, frame: anchor.frame,
        part: anchor.frame?.split(':').at(-1) as HistoryNavRow['part'] }));
      if (row?.active !== true || row.anchor.digest !== anchor.digest) continue;
      activeHits.push(hit);
    }
    const throughWatermark = input.search?.asOf !== undefined && read.nextByteOffset >= input.search.asOf;
    return { complete: read.complete || throughWatermark, nextByteOffset: read.nextByteOffset, ordinal: scanner.ordinal,
      bytesRead: read.bytesRead, recordsRead: read.recordCount, incarnation: input.incarnation,
      incompleteReason: throughWatermark ? undefined : read.incompleteReason, hits: activeHits };
  }

  async list(request: HistoryDirectoryRequest): Promise<HistoryDirectoryPage> {
    const target = { workspaceId: request.workspaceId, sessionId: request.sessionId, agentId: request.agentId };
    if (request.kind !== 'turns' || request.agentId === undefined) return {
      status: 'unavailable', target, source: 'navigation',
      coverage: { complete: false, domain: 'directory', gaps: ['agent_roster_not_projected'] },
    };
    const cursor = request.cursor === undefined ? undefined : decodeHistoryDirectoryCursor(request.cursor);
    const scan = await this.scan(request.sessionId, request.agentId, request.signal);
    if (scan === undefined) return { status: 'unavailable', target, source: 'navigation',
      coverage: { complete: false, domain: 'directory', gaps: ['source_missing'] } };
    const dir = request.order === 'newest' ? 'desc' : 'asc';
    const filter = { workspace: request.workspaceId, session: request.sessionId,
      agent: request.agentId, kind: 'turn', active: true };
    let atTurn: number | undefined;
    if (request.at !== undefined && cursor === undefined) {
      const [earlier, later] = await Promise.all([
        this.store.pageByColumn<HistoryNavRow>(HISTORY_NAV_COLLECTION, {
          column: 'time', dir: 'desc', bounds: { lte: request.at }, filter, limit: 1,
        }),
        this.store.pageByColumn<HistoryNavRow>(HISTORY_NAV_COLLECTION, {
          column: 'time', dir: 'asc', bounds: { gt: request.at }, filter, limit: 1,
        }),
      ]);
      const lower = earlier.items[0];
      const upper = later.items[0];
      atTurn = lower === undefined ? upper?.turn : upper === undefined ? lower.turn :
        request.at - (lower.time ?? 0) <= (upper.time ?? 0) - request.at ? lower.turn : upper.turn;
    }
    const before = Math.min(request.beforeTurn ?? Number.MAX_SAFE_INTEGER,
      request.order === 'newest' ? cursor?.afterTurn ?? (atTurn === undefined ? Number.MAX_SAFE_INTEGER : atTurn + 1) :
        Number.MAX_SAFE_INTEGER);
    const after = Math.max(request.afterTurn ?? -1,
      request.order === 'oldest' ? cursor?.afterTurn ?? (atTurn === undefined ? -1 : atTurn - 1) : -1);
    const bounds = { gt: after, lt: before };
    const page = await this.store.pageByColumn<HistoryNavRow>(HISTORY_NAV_COLLECTION, {
      column: 'turn', dir, bounds, filter, limit: request.limit + 1,
    });
    const rows = page.items;
    const entries: HistoryDirectoryTurn[] = [];
    let stale = false;
    for (const row of rows.slice(0, request.limit)) {
      const checked = await this.read(this.ref(row));
      if (checked.status !== 'ok') { stale = true; continue; }
      entries.push({ ref: this.ref(row), turn: row.turn,
        startedAt: row.time === undefined ? undefined : new Date(row.time).toISOString(),
        promptExcerpt: row.excerpt, answerExcerpt: row.answerExcerpt,
        stepCount: row.stepCount ?? 0, toolCount: row.toolCount ?? 0 });
    }
    const more = rows.length > request.limit;
    const lastTurn = rows[Math.min(rows.length, request.limit) - 1]?.turn;
    const nextCursor = more && lastTurn !== undefined ? encodeHistoryDirectoryCursor({ v: 1,
      request: { workspaceId: request.workspaceId, sessionId: request.sessionId, kind: 'turns',
        agentId: request.agentId, beforeTurn: request.beforeTurn, afterTurn: request.afterTurn,
        at: request.at, order: request.order, limit: request.limit }, afterTurn: lastTurn }) : undefined;
    const complete = scan.complete && !stale;
    return { status: !complete ? 'partial' : entries.length > 0 ? 'ok' : 'no_match',
      target, source: 'navigation', turns: entries, nextCursor,
      coverage: { complete, domain: 'directory',
        gaps: [!scan.complete ? 'navigation_building' : undefined, stale ? 'stale_source' : undefined]
          .filter((item): item is string => item !== undefined),
        scanned: { bytes: scan.bytesRead, records: scan.recordsRead } },
    };
  }

  async directoryRef(workspace: string, session: string, agent: string,
    turn: number, step?: string): Promise<string | undefined> {
    const kind = step === undefined ? 'turn' : 'step';
    let row = await this.row(workspace, session, agent, kind, turn, step);
    if (row === undefined || row.position === undefined) {
      await this.scan(session, agent);
      row = await this.row(workspace, session, agent, kind, turn, step);
    }
    if (row?.active !== true || row.position === undefined) return undefined;
    const checked = await this.read(this.ref(row));
    return checked.status === 'ok' ? this.ref(row) : undefined;
  }

  async readBlocks(ref: string, maxChars: number,
    cursor?: { readonly position: number; readonly offset: number; readonly watermark: number;
      readonly asOfBytes: number }): Promise<HistoryNavBlocksPage> {
    const source = await this.read(ref);
    if (source.status !== 'ok') return { status: source.status };
    const selected = source.row;
    if (selected.kind === 'frame' || selected.position === undefined) return { status: 'navigation_building' };
    const location = await this.transcript.historyWireLocation(selected.session, selected.agent);
    if (location === undefined) return { status: 'source_missing' };
    const asOfBytes = cursor?.asOfBytes ?? (await stat(location.wirePath)).size;
    if (selected.anchor.end > asOfBytes) return { status: 'stale_ref' };
    const filter = { workspace: selected.workspace, session: selected.session, agent: selected.agent,
      turn: selected.turn, active: true, ...(selected.kind === 'step' ? { step: selected.step } : {}) };
    const latest = cursor?.watermark ?? (await this.store.pageByColumn<HistoryNavRow>(HISTORY_NAV_COLLECTION,
      { column: 'position', dir: 'desc', filter, limit: 1 })).items[0]?.position;
    if (latest === undefined) return { status: 'navigation_building' };
    const position = cursor?.position ?? -1;
    const page = await this.store.pageByColumn<HistoryNavRow>(HISTORY_NAV_COLLECTION, {
      column: 'position', dir: 'asc', filter,
      bounds: { ...(cursor?.offset ? { gte: position } : { gt: position }), lte: latest }, limit: 33,
    });
    const blocks: HistoryNavBlock[] = [];
    let remaining = maxChars;
    let next: HistoryNavBlocksPage['next'];
    for (let i = 0; i < Math.min(page.items.length, 32); i += 1) {
      const row = page.items[i]!;
      if (row.position === undefined) return { status: 'navigation_building' };
      if (row.anchor.end > asOfBytes) return { status: 'stale_ref' };
      if (row.part === undefined || row.kind === 'step') {
        if (remaining === 0 && (i + 1 < page.items.length || page.items.length > 32)) {
          next = { position: row.position, offset: 0, watermark: latest, asOfBytes };
          break;
        }
        continue;
      }
      const checked = await this.read(this.ref(row));
      if (checked.status !== 'ok') return { status: checked.status };
      const text = checked.text;
      if (text === undefined) return { status: 'stale_ref' };
      const start = row.position === position ? cursor?.offset ?? 0 : 0;
      if (start > text.length) return { status: 'stale_ref' };
      let end = Math.min(text.length, start + remaining);
      if (end < text.length && end > start && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
      if (end > start) blocks.push({ ref: this.ref(row), turn: row.turn, stepId: row.step,
        role: row.role, toolName: row.toolName, part: row.part, text: text.slice(start, end),
        range: { start, end, total: text.length, unit: 'utf16' } });
      remaining -= end - start;
      if (end < text.length || (remaining === 0 && i + 1 < page.items.length) ||
          (i === 31 && page.items.length > 32)) {
        next = { position: row.position, offset: end < text.length ? end : 0,
          watermark: latest, asOfBytes };
        break;
      }
    }
    if (next === undefined && page.items.length > 32) {
      const last = page.items[31]!;
      if (last.position !== undefined) next = { position: last.position, offset: 0,
        watermark: latest, asOfBytes };
    }
    return { status: 'ok', blocks, next, complete: selected.ended === true };
  }

  async row(workspace: string, session: string, agent: string, kind: HistoryRefKind,
    turn: number, step?: string, frame?: string, part?: HistoryNavRow['part']): Promise<HistoryNavRow | undefined> {
    return this.store.get<HistoryNavRow>(HISTORY_NAV_COLLECTION,
      rowKey({ workspace, session, agent, kind, turn, step, frame, part }));
  }

  async read(ref: string): Promise<{ status: 'ok'; row: HistoryNavRow; text?: string } |
    { status: 'stale_ref' | 'source_missing' }> {
    const anchor = decodeHistoryRef(ref);
    const location = await this.transcript.historyWireLocation(anchor.session, anchor.agent);
    if (location === undefined) return { status: 'source_missing' };
    if (location.workspaceId !== anchor.workspace) return { status: 'stale_ref' };
    const result = await verifyHistorySource(location.wirePath, anchor);
    if (result.status !== 'ok') return result;
    const row = await this.row(anchor.workspace, anchor.session, anchor.agent,
      anchor.kind, anchor.turn, anchor.step, anchor.frame, anchor.frame?.split(':').at(-1) as HistoryNavRow['part']);
    const turn = await this.row(anchor.workspace, anchor.session, anchor.agent, 'turn', anchor.turn);
    if (row === undefined || !row.active || turn?.active === false ||
        row.anchor.start !== anchor.start || row.anchor.digest !== anchor.digest ||
        row.selector !== anchor.selector) return { status: 'stale_ref' };
    if (row.part === undefined) return { status: 'ok', row };
    const handle = await open(location.wirePath, 'r');
    try {
      const bytes = Buffer.allocUnsafe(anchor.end - anchor.start);
      const read = await handle.read(bytes, 0, bytes.length, anchor.start);
      if (read.bytesRead !== bytes.length) return { status: 'stale_ref' };
      const record = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      const text = originalText(record, row.part, row.selector);
      if (text === undefined || digest(text) !== row.contentHash) return { status: 'stale_ref' };
      return { status: 'ok', row, text };
    } finally { await handle.close(); }
  }

  ref(row: HistoryNavRow, focus?: number): string {
    return encodeHistoryRef({ ...row.anchor, selector: row.selector, focus });
  }
}

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { HistoryHit } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import type { HistoryNavigationDb } from './historyNavigationDb';
import type { HistoryNavRow, HistoryNavScan, HistoryNavSearch } from './historyLocatorStore';
import { historyNavigationProof, matchesNavigationProof } from './historyNavigationProof';
import { hashHistoryRecord } from './historySource';
import { matchHistoryText, planHistoryQuery } from './historyQuery';
import { makeSnippet } from '../../search/snippet';

export interface HistorySortedBoundary { readonly time: number; readonly key: string }
export interface HistorySortedCursor {
  readonly v: 2;
  readonly asOf: number;
  readonly incarnation: string;
  readonly fingerprint: string;
  readonly requestHash: string;
  readonly generation: string;
  readonly offset: number;
  readonly phase: 'prepare' | 'query';
  readonly after?: HistorySortedBoundary;
  readonly skippedOversize?: boolean;
  readonly proof?: import('./historyNavigationProof').HistoryNavigationProof;
}

export function decodeHistorySortedCursor(value: string): HistorySortedCursor {
  let cursor: Partial<HistorySortedCursor>;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<HistorySortedCursor>; }
  catch { throw new Error('invalid_scan_cursor'); }
  if (cursor?.v !== 2 || !Number.isSafeInteger(cursor.asOf) || cursor.asOf! < 0 ||
      !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0 || cursor.offset! > cursor.asOf! ||
      !['prepare', 'query'].includes(cursor.phase ?? '') ||
      typeof cursor.incarnation !== 'string' || !cursor.incarnation || cursor.incarnation.length > 256 ||
      typeof cursor.fingerprint !== 'string' || !cursor.fingerprint || cursor.fingerprint.length > 256 ||
      typeof cursor.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.requestHash) ||
      typeof cursor.generation !== 'string' || !cursor.generation || cursor.generation.length > 128 ||
      cursor.after !== undefined && (!Number.isFinite(cursor.after?.time) ||
        typeof cursor.after?.key !== 'string' || !cursor.after.key || cursor.after.key.length > 2048) ||
      cursor.skippedOversize !== undefined && typeof cursor.skippedOversize !== 'boolean' ||
      cursor.proof !== undefined && (cursor.proof === null || typeof cursor.proof !== 'object' ||
        cursor.proof.identity !== cursor.incarnation || !Number.isSafeInteger(cursor.proof.size) || cursor.proof.size < cursor.asOf! ||
        !/^[a-f0-9]{64}$/.test(cursor.proof.head) || !/^[a-f0-9]{64}$/.test(cursor.proof.tail) ||
        typeof cursor.proof.mtimeNs !== 'string' || typeof cursor.proof.ctimeNs !== 'string') ||
      cursor.phase === 'prepare' && cursor.after !== undefined) throw new Error('invalid_scan_cursor');
  return cursor as HistorySortedCursor;
}

interface SortedSearchInput {
  readonly db: HistoryNavigationDb;
  readonly workspace: string;
  readonly session: string;
  readonly agent: string;
  readonly wirePath: string;
  readonly incarnation: string;
  readonly key: string;
  readonly signal?: AbortSignal;
  readonly search: HistoryNavSearch;
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly prepare: (asOf: number) => Promise<HistoryNavScan>;
  readonly textOf: (record: Record<string, unknown>, part: HistoryNavRow['part'], selector?: string) => string | undefined;
  readonly refOf: (row: HistoryNavRow, focus: number) => string;
}

export async function searchSortedHistory(input: SortedSearchInput): Promise<HistoryNavScan> {
  const { db, search } = input;
  const source = await stat(input.wirePath, { bigint: true });
  const cursor = search.orderedCursor;
  const asOf = cursor?.asOf ?? Number(source.size);
  const fingerprint = `${source.size}:${source.mtimeNs}:${source.ctimeNs}`;
  const order = search.sort ?? 'relevance';
  const requestHash = createHash('sha256').update(JSON.stringify([input.workspace, input.session, input.agent,
    search.query, search.mode, order, search.role, search.after, search.before, search.pageSize])).digest('hex');
  if (cursor !== undefined && (asOf > Number(source.size) ||
      cursor.proof === undefined && cursor.fingerprint !== fingerprint ||
      cursor.incarnation !== input.incarnation || cursor.requestHash !== requestHash)) throw new Error('stale_scan_cursor');
  const proof = await historyNavigationProof(input.wirePath, asOf);
  if (cursor?.proof !== undefined && !matchesNavigationProof(cursor.proof, proof)) throw new Error('stale_scan_cursor');
  let saved = db.readManifest(input.key);
  if (saved !== undefined && (saved.incarnation !== input.incarnation ||
      !await historyNavigationProof(input.wirePath, saved.offset)
        .then((proof) => matchesNavigationProof(saved!.source, proof), () => false))) {
    if (cursor !== undefined) throw new Error('stale_scan_cursor');
    saved = undefined;
  }
  if (cursor !== undefined && (saved === undefined || saved.generation !== cursor.generation ||
      saved.offset < cursor.offset)) throw new Error('stale_scan_cursor');
  let bytesRead = 0;
  let recordsRead = 0;
  let preparation: HistoryNavScan | undefined;
  if (saved === undefined || saved.offset < asOf) {
    preparation = await input.prepare(asOf);
    bytesRead += preparation.bytesRead;
    recordsRead += preparation.recordsRead;
    saved = db.readManifest(input.key);
  }
  if (saved !== undefined && saved.offset > asOf) throw new Error('stale_scan_cursor');
  const identity = { v: 2 as const, asOf, fingerprint, proof, incarnation: input.incarnation, requestHash,
    generation: saved?.generation ?? '', offset: saved?.offset ?? 0 };
  const unchanged = async () => {
    const current = await historyNavigationProof(input.wirePath, asOf);
    if (!matchesNavigationProof(proof, current)) throw new Error('stale_scan_cursor');
  };
  if (saved === undefined || saved.offset < asOf) {
    await unchanged();
    const pending = preparation?.incompleteReason === 'partial_tail';
    const progressed = !pending && saved !== undefined && saved.offset > (cursor?.offset ?? 0);
    const reason = pending ? 'source_pending' : progressed ? 'navigation_building' : preparation?.incompleteReason ?? 'projection_stalled';
    return { complete: false, nextByteOffset: saved?.offset ?? 0, ordinal: saved?.ordinal ?? 0,
      bytesRead, recordsRead, incarnation: input.incarnation, hits: [], ordered: true,
      orderedNext: progressed ? { ...identity, phase: 'prepare' } : undefined,
      incompleteReason: reason, gaps: [reason] };
  }
  const plan = planHistoryQuery(search.query, search.mode);
  const matches: Array<{ hit: HistoryHit; score: number; time: number; key: string }> = [];
  const gaps = new Set<string>(cursor?.skippedOversize ? ['record_exceeds_page_budget'] : []);
  let after = cursor?.after;
  let complete = false;
  const file = await open(input.wirePath, 'r');
  try {
    outer: while (bytesRead < input.maxBytes && recordsRead < input.maxRecords) {
      input.signal?.throwIfAborted();
      const limit = Math.min(64, input.maxRecords - recordsRead);
      const candidates = db.searchRows({ workspace: input.workspace, session: input.session, agent: input.agent,
        direction: order === 'oldest' ? 'asc' : 'desc', after, role: search.role,
        startTime: search.after, endTime: search.before, limit });
      recordsRead += candidates.length;
      if (candidates.length === 0) { complete = true; break; }
      for (const [index, candidate] of candidates.entries()) {
        input.signal?.throwIfAborted();
        const { row, key, time } = candidate;
        const size = row.anchor.end - row.anchor.start;
        if (size > input.maxBytes) {
          gaps.add('record_exceeds_page_budget');
          after = { key, time };
        } else {
          if (size > input.maxBytes - bytesRead) break outer;
          if (size <= 0 || row.anchor.end > asOf) throw new Error('stale_scan_cursor');
          const raw = Buffer.allocUnsafe(size);
          let received = 0;
          while (received < size) {
            input.signal?.throwIfAborted();
            const read = await file.read(raw, received, Math.min(64 << 10, size - received), row.anchor.start + received);
            if (read.bytesRead === 0) throw new Error('stale_scan_cursor');
            received += read.bytesRead;
            bytesRead += read.bytesRead;
          }
          if (hashHistoryRecord(raw) !== row.anchor.digest) throw new Error('stale_scan_cursor');
          const record = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          const text = input.textOf(record, row.part, row.selector);
          if (text === undefined || createHash('sha256').update(text).digest('hex') !== row.contentHash) throw new Error('stale_scan_cursor');
          after = { key, time };
          const match = matchHistoryText(text, plan);
          if (match !== undefined) matches.push({ score: match.score, key, time, hit: {
            sessionId: row.session, agentId: row.agent, turn: row.turn, stepId: row.step,
            role: row.role ?? 'user', time: row.time, matched: match.matched,
            ref: input.refOf(row, match.start), snippet: makeSnippet(text, match.matched[0] ?? search.query),
          } });
        }
        if (index === candidates.length - 1 && candidates.length < limit) complete = true;
        if (matches.length >= search.pageSize) break outer;
      }
      if (complete) break;
    }
  } finally { await file.close(); }
  await unchanged();
  if (order === 'relevance') {
    matches.sort((left, right) => right.score - left.score || right.time - left.time || right.key.localeCompare(left.key));
    if (!complete) gaps.add('page_local_relevance');
  }
  return { complete: complete && gaps.size === 0, nextByteOffset: asOf, ordinal: saved.ordinal,
    bytesRead, recordsRead, incarnation: input.incarnation, ordered: true,
    orderedNext: complete ? undefined : { ...identity, phase: 'query', after,
      skippedOversize: gaps.has('record_exceeds_page_budget') },
    incompleteReason: complete ? gaps.size > 0 ? 'record_exceeds_page_budget' : undefined : 'wire_scan_limit',
    gaps: [...gaps], hits: matches.map((match) => match.hit) };
}

import { stat } from 'node:fs/promises';

import {
  IHistoryArchive,
  IThreadCommunicationService,
  type HistoryHit,
  type HistorySearchPage,
  type Scope,
  type ScopeSeed,
} from '@kiki/agent-core-v2';
import {
  isPlainAgentId,
  type AgentTranscriptSnapshot,
  type TranscriptTurn,
} from '@kiki/transcript';

import { GlobalSearchError, IGlobalSearchService } from '../search/searchService';
import { SearchWorkerError } from '../search/worker/host';
import { makeSnippet } from '../search/snippet';
import { matchHistoryText, planHistoryQuery } from './history/historyQuery';
import type { HistoryLocatorStore } from './history/historyLocatorStore';
import { decodeHistorySortedCursor } from './history/historySortedSearch';
import type {
  BoundedTranscriptSnapshot,
  TranscriptColdReadLimits,
  TranscriptService,
} from './transcript/transcriptService';

const HISTORY_FALLBACK_MAX_BYTES = 2 << 20;
const HISTORY_FALLBACK_MAX_RECORDS = 10_000;
const HISTORY_FALLBACK_CHUNK_BYTES = 64 << 10;
const SEARCH_INDEX_UNAVAILABLE = 'search index unavailable';

interface FallbackInput {
  readonly query: string;
  readonly mode?: 'auto' | 'all' | 'any' | 'terms' | 'literal';
  readonly role?: 'user' | 'assistant' | 'tool';
  readonly after?: number;
  readonly before?: number;
  readonly sort?: 'relevance' | 'newest' | 'oldest';
  readonly pageSize: number;
  readonly sessionId?: string;
  readonly agentId?: string;
}

interface BoundedSnapshotReader {
  (
    sessionId: string,
    agentId: string,
    limits: TranscriptColdReadLimits,
  ): Promise<BoundedTranscriptSnapshot>;
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return output
    .filter((part): part is { type: 'text'; text: string } =>
      part !== null && typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

function fallbackHits(
  snapshot: AgentTranscriptSnapshot | undefined,
  input: FallbackInput,
): HistoryHit[] {
  if (snapshot === undefined) return [];
  const plan = planHistoryQuery(input.query, input.mode ?? 'auto');
  const hits: HistoryHit[] = [];
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    const time = item.startedAt === undefined ? undefined : Date.parse(item.startedAt);
    if (input.after !== undefined && (time === undefined || time < input.after)) continue;
    if (input.before !== undefined && (time === undefined || time >= input.before)) continue;
    const prompt = item.prompt?.trim();
    const promptMatch = prompt !== undefined && (input.role === undefined || input.role === 'user')
      ? matchHistoryText(prompt, plan) : undefined;
    if (prompt !== undefined && promptMatch !== undefined) {
      hits.push({
        sessionId: input.sessionId!,
        agentId: input.agentId!,
        role: 'user',
        turn: item.ordinal,
        time, matched: promptMatch.matched,
        snippet: makeSnippet(prompt, promptMatch.matched[0] ?? input.query),
      });
    }
    for (const step of item.steps) {
      for (const frame of step.frames) {
        const role = frame.kind === 'text' && frame.role === 'assistant'
          ? 'assistant' : frame.kind === 'tool' ? 'tool' : undefined;
        if (role === undefined || (input.role !== undefined && input.role !== role)) continue;
        const text = frame.kind === 'text' ? frame.text.trim() :
          frame.kind === 'tool' ? outputText(frame.output).trim() : '';
        const match = text.length > 0 ? matchHistoryText(text, plan) : undefined;
        if (match === undefined) continue;
        hits.push({
          sessionId: input.sessionId!,
          agentId: input.agentId!,
          role,
          turn: item.ordinal,
          stepId: step.stepId,
          time: step.startedAt === undefined ? time : Date.parse(step.startedAt), matched: match.matched,
          snippet: makeSnippet(text, match.matched[0] ?? input.query),
        });
      }
    }
  }
  if (input.sort === 'newest' || input.sort === 'oldest') {
    const direction = input.sort === 'newest' ? -1 : 1;
    hits.sort((left, right) => direction * ((left.time ?? 0) - (right.time ?? 0)) ||
      (left.turn ?? 0) - (right.turn ?? 0));
  } else {
    hits.sort((left, right) => (right.matched?.length ?? 0) - (left.matched?.length ?? 0) ||
      (right.time ?? 0) - (left.time ?? 0));
  }
  return hits;
}

async function fallbackSearch(
  transcript: TranscriptService,
  input: FallbackInput,
): Promise<HistorySearchPage> {
  const limits: TranscriptColdReadLimits = {
    maxBytes: HISTORY_FALLBACK_MAX_BYTES,
    maxRecords: HISTORY_FALLBACK_MAX_RECORDS,
    chunkBytes: HISTORY_FALLBACK_CHUNK_BYTES,
  };
  const reader = (transcript as unknown as { readColdSnapshotBounded?: BoundedSnapshotReader })
    .readColdSnapshotBounded;
  let scan: BoundedTranscriptSnapshot | undefined;
  let scanError = false;
  if (input.sessionId !== undefined && input.agentId !== undefined && reader !== undefined) {
    try {
      scan = await reader.call(transcript, input.sessionId, input.agentId, limits);
    } catch {
      scanError = true;
    }
  } else {
    scanError = true;
  }
  const hits = fallbackHits(scan?.snapshot, input);
  const resultLimited = hits.length > input.pageSize;
  const truncated = scanError || scan?.complete === false || resultLimited;
  return {
    items: hits.slice(0, input.pageSize),
    hasMore: false,
    incomplete: scanError ? 'wire_scan_error' : scan?.complete === false ? 'wire_scan_limit' :
      resultLimited ? 'result_limit' : undefined,
    coverage: { complete: !truncated, domain: 'full_text',
      gaps: scanError ? ['wire_scan_error'] : scan?.complete === false ? ['wire_scan_limit'] :
        resultLimited ? ['result_limit_without_cursor'] : undefined,
      scanned: { bytes: scan?.bytesRead ?? 0, records: scan?.recordsRead ?? 0 } },
    continuation: undefined,
    indexState: {
      state: 'unavailable',
      stale: true,
      degraded: SEARCH_INDEX_UNAVAILABLE,
    },
    warning: SEARCH_INDEX_UNAVAILABLE,
    fallback: {
      reason: SEARCH_INDEX_UNAVAILABLE,
      scope: 'current_session_wire',
      maxBytes: HISTORY_FALLBACK_MAX_BYTES,
      maxRecords: HISTORY_FALLBACK_MAX_RECORDS,
      bytesRead: scan?.bytesRead ?? 0,
      recordsRead: scan?.recordsRead ?? 0,
      truncated,
    },
    source: 'fallback',
  };
}

interface ScanCursor {
  readonly v: 1;
  readonly offset: number;
  readonly incarnation: string;
  readonly asOf: number;
}

function parseScanCursor(value: string | undefined): ScanCursor | undefined {
  if (value === undefined) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_scan_cursor'); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_scan_cursor');
  const c = raw as Partial<ScanCursor>;
  if (c.v !== 1 || !Number.isSafeInteger(c.offset) || c.offset! < 0 ||
      typeof c.incarnation !== 'string' || !c.incarnation ||
      !Number.isSafeInteger(c.asOf) || c.asOf! < c.offset!) throw new Error('invalid_scan_cursor');
  return c as ScanCursor;
}

async function navigationSearch(transcript: TranscriptService, nav: HistoryLocatorStore,
  input: FallbackInput, pageToken?: string, signal?: AbortSignal): Promise<HistorySearchPage> {
  let version: unknown;
  if (pageToken !== undefined) {
    try { version = (JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as { v?: unknown })?.v; }
    catch { throw new Error('invalid_scan_cursor'); }
  }
  if (!nav.supportsSortedSearch || version === 1) {
    const page = await legacyNavigationSearch(transcript, nav, input, pageToken, signal);
    return { ...page, warning: 'Legacy transcript scans use source order rather than sort; restart without cursor for sorted navigation.',
      coverage: page.coverage === undefined ? undefined : { ...page.coverage,
        gaps: [...(page.coverage.gaps ?? []), 'legacy_source_order'] } };
  }
  const cursor = pageToken === undefined ? undefined : decodeHistorySortedCursor(pageToken);
  const scan = await nav.scan(input.sessionId!, input.agentId!, signal, {
    query: input.query, mode: input.mode ?? 'auto', role: input.role, after: input.after, before: input.before,
    sort: input.sort ?? 'relevance', pageSize: input.pageSize, orderedCursor: cursor,
  });
  if (scan === undefined) return { items: [], hasMore: false, source: 'fallback',
    indexState: { state: 'unavailable' }, incomplete: 'source_missing',
    coverage: { complete: false, domain: 'full_text', gaps: ['source_missing'] } };
  const next = scan.orderedNext === undefined ? undefined : Buffer.from(JSON.stringify(scan.orderedNext)).toString('base64url');
  const gaps = [...new Set([...(scan.gaps ?? []), scan.complete ? undefined : scan.incompleteReason]
    .filter((gap): gap is string => gap !== undefined))];
  return { items: scan.hits ?? [], hasMore: next !== undefined, pageToken: next,
    source: 'fallback', continuation: next === undefined ? undefined : 'scan', incomplete: scan.incompleteReason,
    coverage: { complete: scan.complete, domain: 'full_text', gaps, scanned: { bytes: scan.bytesRead, records: scan.recordsRead } },
    warning: gaps.includes('source_pending') ? 'The captured transcript ends in an unfinished record; restart the query after its writer settles.' :
      gaps.includes('page_local_relevance') ? 'Transcript relevance ranks only this page; continuation scans newest-first and may find stronger matches.' : undefined,
    indexState: { state: 'unavailable', stale: true, degraded: SEARCH_INDEX_UNAVAILABLE },
    fallback: { reason: SEARCH_INDEX_UNAVAILABLE, scope: 'requested_session_wire', maxBytes: 8 << 20,
      maxRecords: 50_000, bytesRead: scan.bytesRead, recordsRead: scan.recordsRead, truncated: !scan.complete } };
}

async function legacyNavigationSearch(transcript: TranscriptService, nav: HistoryLocatorStore,
  input: FallbackInput, pageToken?: string, signal?: AbortSignal): Promise<HistorySearchPage> {
  signal?.throwIfAborted();
  const location = await transcript.historyWireLocation(input.sessionId!, input.agentId!);
  const missing: HistorySearchPage = { items: [], hasMore: false, source: 'fallback',
    indexState: { state: 'unavailable', degraded: 'transcript source missing' },
    incomplete: 'source_missing', coverage: { complete: false, domain: 'full_text', gaps: ['source_missing'] } };
  if (location === undefined) return missing;
  const cursor = parseScanCursor(pageToken);
  const size = cursor?.asOf ?? await stat(location.wirePath).then((info) => info.size, (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (size === undefined) return missing;
  const asOf = size;
  const scan = await nav.scan(input.sessionId!, input.agentId!, signal, {
    query: input.query, mode: input.mode ?? 'auto', role: input.role,
    after: input.after, before: input.before, pageSize: input.pageSize, asOf,
    cursor: cursor === undefined ? undefined : { offset: cursor.offset, incarnation: cursor.incarnation },
  });
  if (scan === undefined) return { items: [], hasMore: false, source: 'fallback',
    indexState: { state: 'unavailable' }, incomplete: 'source_missing',
    coverage: { complete: false, domain: 'full_text', gaps: ['source_missing'] } };
  const hits = scan.hits ?? [];
  const stuck = !scan.complete && scan.nextByteOffset <= (cursor?.offset ?? 0);
  const next = scan.complete || stuck ? undefined : Buffer.from(JSON.stringify({ v: 1,
    offset: scan.nextByteOffset, incarnation: scan.incarnation, asOf } satisfies ScanCursor)).toString('base64url');
  return { items: hits.slice(0, input.pageSize), hasMore: next !== undefined, pageToken: next,
    source: 'fallback', continuation: next === undefined ? undefined : 'scan',
    incomplete: stuck ? scan.incompleteReason ?? 'wire_scan_error' : !scan.complete ? 'wire_scan_limit' :
      hits.length > input.pageSize ? 'result_limit' : undefined,
    coverage: { complete: scan.complete && hits.length <= input.pageSize, domain: 'full_text',
      gaps: stuck ? [scan.incompleteReason ?? 'wire_scan_error'] :
        hits.length > input.pageSize ? ['result_limit_without_cursor'] : !scan.complete ? ['wire_scan_limit'] : undefined,
      scanned: { bytes: scan.bytesRead, records: scan.recordsRead } },
    indexState: { state: 'unavailable', stale: true, degraded: SEARCH_INDEX_UNAVAILABLE },
    fallback: { reason: SEARCH_INDEX_UNAVAILABLE, scope: 'requested_session_wire',
      maxBytes: 8 << 20, maxRecords: 50_000, bytesRead: scan.bytesRead,
      recordsRead: scan.recordsRead, truncated: !scan.complete || hits.length > input.pageSize },
  };
}

export function historyArchiveSeed(getCore: () => Scope, getTranscript: () => TranscriptService,
  getNavigation?: () => HistoryLocatorStore): ScopeSeed {
  const archive: IHistoryArchive = {
    _serviceBrand: undefined,
    async readRef(ref) {
      const nav = getNavigation?.();
      if (nav === undefined) return { status: 'source_missing' };
      let result: Awaited<ReturnType<HistoryLocatorStore['read']>>;
      try { result = await nav.read(ref); }
      catch (error) {
        if (error instanceof Error && error.message === 'invalid_ref') return { status: 'invalid_ref' };
        throw error;
      }
      if (result.status !== 'ok') return result;
      const { row, text } = result;
      return { status: 'ok', text, turn: row.turn, stepId: row.step, role: row.role,
        toolName: row.toolName, part: row.part, ref: nav.ref(row) };
    },
    async lookupDirectory(workspace, session, agent, turn, step, preparation, signal) {
      const nav = getNavigation?.();
      if (nav === undefined) return { status: 'navigation_unavailable', reason: 'navigation_not_configured' };
      return nav.lookupDirectory(workspace, session, agent, turn, step, preparation, signal);
    },
    async directoryRef(workspace, session, agent, turn, step) {
      return getNavigation?.().directoryRef(workspace, session, agent, turn, step);
    },
    async readDirectory(ref, maxChars, cursor) {
      const nav = getNavigation?.();
      if (nav === undefined) return { status: 'source_missing' };
      try { return await nav.readBlocks(ref, maxChars, cursor); }
      catch (error) {
        if (error instanceof Error && error.message === 'invalid_ref') return { status: 'invalid_ref' };
        throw error;
      }
    },
    search: async ({
      query,
      peer,
      mode,
      workspaceId,
      sessionId,
      agentId,
      includeSubagents,
      role,
      after,
      before,
      sort,
      source,
      pageSize,
      pageToken,
      fallbackSessionId,
      fallbackAgentId,
      signal,
    }) => {
      signal?.throwIfAborted();
      planHistoryQuery(query, mode ?? 'auto');
      if (peer === true) return peerSearch(getCore().accessor.get(IThreadCommunicationService), {
        query, mode, workspaceId, sessionId, role, after, before, pageSize, pageToken, signal,
      });
      let unavailablePage: HistorySearchPage | undefined;
      const indexedPhrases = source !== 'transcript' && sessionId === undefined &&
        (mode === 'auto' || mode === 'all' || mode === 'any');
      if (source !== 'transcript' && (indexedPhrases || mode === 'terms' || mode === 'literal')) {
        try {
          const page = await getCore().accessor.get(IGlobalSearchService).search({
            query, mode: indexedPhrases ? 'terms' : mode as 'terms' | 'literal',
            historyMode: indexedPhrases ? mode : undefined,
            workspaceId, indexOnly: sessionId === undefined,
            container: sessionId === undefined && agentId === undefined
              ? undefined : { sessionId, agentId }, role, pageSize, pageToken,
            startTime: after, endTime: before === undefined ? undefined : before - 1,
            sort: sort === 'oldest' ? 'time_asc' : sort === 'newest' ? 'time_desc' : 'score',
          });
          signal?.throwIfAborted();
          if (page.indexState.state !== 'unavailable' || page.items.length > 0) return indexedPhrases ? {
            ...page, coverage: { complete: page.indexState.state === 'ready' &&
              page.indexState.stale !== true && page.incomplete === undefined && includeSubagents !== true,
            domain: 'indexed_text', gaps: [
              'tool_tail_not_indexed', 'refs_unavailable',
              includeSubagents ? 'subagents_may_be_unindexed' : undefined,
              page.incomplete, page.indexState.state === 'ready' ? undefined : 'index_not_ready',
            ].filter((gap): gap is string => gap !== undefined) },
          } : page;
          unavailablePage = page;
        } catch (error) {
          if (!(error instanceof GlobalSearchError && error.reason === 'index_unavailable') &&
              !(error instanceof SearchWorkerError)) throw error;
        }
      }
      if (sessionId === undefined || agentId === undefined || includeSubagents === true ||
          (source !== 'transcript' && mode !== undefined && mode !== 'auto' && mode !== 'all' && mode !== 'any' &&
           (sessionId !== fallbackSessionId || agentId !== fallbackAgentId))) {
        return { ...unavailablePage, items: [], hasMore: false, source: 'index',
          indexState: unavailablePage?.indexState ?? { state: 'unavailable', degraded: SEARCH_INDEX_UNAVAILABLE },
          incomplete: 'index_unavailable',
          coverage: { complete: false, domain: source === 'transcript' ? 'full_text' : 'indexed_text',
            gaps: [includeSubagents ? 'multi_agent_scan_unavailable' : 'index_unavailable'] },
          warning: "The requested range needs a searchable index or a specific session and agent for a transcript scan.",
        };
      }
      const fallback = { query, mode, role, after, before, sort, pageSize, sessionId, agentId };
      return getNavigation === undefined ? fallbackSearch(getTranscript(), fallback) :
        navigationSearch(getTranscript(), getNavigation(), fallback, pageToken, signal);
    },
    async readTurn(sessionId, agentId, ordinal, stepId) {
      if (!isPlainAgentId(agentId)) throw new Error('Invalid agent id.');
      const transcript = getTranscript();
      const store = transcript.forSessionLive(sessionId);
      let turn: TranscriptTurn | undefined;
      if (store !== undefined) {
        const projection = await transcript.ensureAgentHistory(sessionId, agentId);
        turn = projection?.snapshot().items.find(
          (item): item is TranscriptTurn => item.kind === 'turn' && item.ordinal === ordinal,
        );
      }
      if (turn === undefined) {
        const snapshot = await transcript.readColdSnapshot(sessionId, agentId);
        turn = snapshot?.items.find(
          (item): item is TranscriptTurn => item.kind === 'turn' && item.ordinal === ordinal,
        );
      }
      if (turn === undefined) return undefined;
      const steps = stepId === undefined ? turn.steps : turn.steps.filter((step) => step.stepId === stepId);
      if (stepId !== undefined && steps.length === 0) return undefined;
      return JSON.stringify({
        turn: turn.ordinal,
        state: turn.state,
        origin: turn.origin,
        ...(stepId === undefined ? { user: turn.prompt } : {}),
        steps: steps.map((step) => ({
          step_id: step.stepId,
          frames: step.frames.filter((frame) => frame.kind === 'text' || frame.kind === 'tool').map((frame) =>
            frame.kind === 'text' ? { role: frame.role, text: frame.text } :
              { role: 'tool', name: frame.name, input: frame.input, output: frame.output, error: frame.error }),
        })),
      });
    },
  };
  return [[IHistoryArchive, archive]];
}

async function peerSearch(service: IThreadCommunicationService, input: FallbackInput & {
  readonly workspaceId: string;
  readonly pageToken?: string;
  readonly signal?: AbortSignal;
}): Promise<HistorySearchPage> {
  const plan = planHistoryQuery(input.query, input.mode ?? 'auto');
  const items: HistoryHit[] = [];
  let cursor = input.pageToken;
  let scanned = 0;
  let bytes = 0;
  let more = false;
  let preparing = false;
  while (items.length < input.pageSize && scanned < 200 && bytes < (2 << 20)) {
    input.signal?.throwIfAborted();
    const page = await service.listMessages({ workspaceId: input.workspaceId, sessionId: input.sessionId, cursor, limit: 1 });
    scanned++;
    cursor = page.nextCursor;
    more = cursor !== undefined;
    preparing = page.incomplete === 'history_preparing';
    for (const message of page.items) {
      bytes += Buffer.byteLength(message.content);
      if (input.role !== undefined && input.role !== 'user' ||
          input.after !== undefined && message.acceptedAt < input.after ||
          input.before !== undefined && message.acceptedAt >= input.before) continue;
      const match = matchHistoryText(message.content, plan);
      if (match === undefined) continue;
      const { content, ...communication } = message;
      items.push({ sessionId: message.target.ref.sessionId, agentId: 'main', role: 'user',
        time: message.acceptedAt, snippet: makeSnippet(content, match.matched[0] ?? input.query),
        matched: match.matched, communication });
    }
    if (!more || page.incomplete !== undefined) break;
  }
  const incomplete = preparing ? 'history_preparing' : more && items.length < input.pageSize ? 'scan_budget' : undefined;
  return { items, hasMore: more, pageToken: cursor, incomplete, source: 'mailbox',
    indexState: { state: preparing ? 'building' : 'ready' }, continuation: more ? 'scan' : undefined,
    coverage: { complete: incomplete === undefined, domain: 'full_text',
      gaps: incomplete === undefined ? [] : [incomplete], scanned: { bytes, records: scanned } } };
}

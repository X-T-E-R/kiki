import {
  IHistoryArchive,
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
  readonly mode?: 'terms' | 'literal';
  readonly role?: 'user' | 'assistant' | 'tool';
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
  const plan = planHistoryQuery(input.query, input.mode ?? 'terms');
  const hits: HistoryHit[] = [];
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    const prompt = item.prompt?.trim();
    const promptMatch = prompt !== undefined && (input.role === undefined || input.role === 'user')
      ? matchHistoryText(prompt, plan) : undefined;
    if (prompt !== undefined && promptMatch !== undefined) {
      hits.push({
        sessionId: input.sessionId!,
        agentId: input.agentId!,
        role: 'user',
        turn: item.ordinal,
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
          snippet: makeSnippet(text, match.matched[0] ?? input.query),
        });
      }
    }
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

export function historyArchiveSeed(getCore: () => Scope, getTranscript: () => TranscriptService): ScopeSeed {
  const archive: IHistoryArchive = {
    _serviceBrand: undefined,
    search: async ({
      query,
      mode,
      workspaceId,
      sessionId,
      agentId,
      role,
      pageSize,
      pageToken,
      fallbackSessionId,
      fallbackAgentId,
    }) => {
      let unavailablePage: HistorySearchPage | undefined;
      try {
        const page = await getCore().accessor.get(IGlobalSearchService).search({
          query, mode, workspaceId, indexOnly: true,
          container: sessionId === undefined && agentId === undefined
            ? undefined : { sessionId, agentId }, role, pageSize, pageToken,
        });
        if (page.indexState.state !== 'unavailable' || page.items.length > 0) return page;
        unavailablePage = page;
      } catch (error) {
        if (!(error instanceof GlobalSearchError && error.reason === 'index_unavailable') &&
            !(error instanceof SearchWorkerError)) throw error;
      }
      if (sessionId === undefined || agentId === undefined || sessionId !== fallbackSessionId || agentId !== fallbackAgentId) {
        return { ...unavailablePage, items: [], hasMore: false, source: 'index',
          indexState: unavailablePage?.indexState ?? { state: 'unavailable', degraded: SEARCH_INDEX_UNAVAILABLE },
          incomplete: 'index_unavailable',
          warning: 'The index cannot search this requested range. Select one session and agent for a bounded transcript scan.',
        };
      }
      return fallbackSearch(getTranscript(), {
        query,
        mode,
        role,
        pageSize,
        sessionId,
        agentId,
      });
    },
    async readTurn(sessionId, agentId, ordinal, stepId) {
      if (!isPlainAgentId(agentId)) throw new Error('Invalid agent id.');
      const transcript = getTranscript();
      const store = transcript.forSessionLive(sessionId);
      let turn: TranscriptTurn | undefined;
      if (store !== undefined) {
        await transcript.whenReady(sessionId);
        await transcript.ensureAgentHistory(sessionId, agentId);
        turn = store.getAgent(agentId)?.snapshot().items.find(
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

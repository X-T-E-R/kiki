import {
  decodeHistoryDirectoryCursor,
  encodeHistoryDirectoryCursor,
  IHistoryDirectory,
  type HistoryDirectoryAgent,
  type HistoryDirectoryCoverage,
  type HistoryDirectoryCursorRequest,
  type HistoryDirectoryPage,
  type HistoryDirectoryRequest,
  type HistoryDirectoryTarget,
  type HistoryDirectoryTurn,
} from '@kiki/agent-core-v2/agent/tools/history/historyListTool';
import type { ScopeSeed } from '@kiki/agent-core-v2';
import type {
  AgentDescriptor,
  AgentTranscriptSnapshot,
} from '@kiki/transcript';

import type {
  BoundedTranscriptSnapshot,
  TranscriptColdReadLimits,
  TranscriptService,
} from '../transcript/transcriptService';

const FALLBACK_MAX_BYTES = 2 << 20;
const FALLBACK_MAX_RECORDS = 10_000;
const FALLBACK_CHUNK_BYTES = 64 << 10;

export interface HistoryNavigationAdapter {
  list(request: HistoryDirectoryRequest): Promise<HistoryDirectoryPage>;
}

interface DirectoryRead {
  readonly snapshot: AgentTranscriptSnapshot;
  readonly source: 'live' | 'transcript';
  readonly complete: boolean;
  readonly gaps: readonly string[];
  readonly stats: { readonly bytes: number; readonly records: number };
}

interface RosterRead {
  readonly roster: readonly AgentDescriptor[];
  readonly source: 'live' | 'transcript';
  readonly complete: boolean;
  readonly gaps: readonly string[];
}

interface LiveTranscriptStore {
  getAgent(agentId: string): { snapshot(): AgentTranscriptSnapshot } | undefined;
  agents(): readonly AgentDescriptor[];
}

interface TranscriptDirectorySource {
  forSessionLive(sessionId: string): LiveTranscriptStore | undefined;
  whenReady(sessionId: string): Promise<void>;
  readColdSnapshotBounded(
    sessionId: string,
    agentId: string,
    limits: TranscriptColdReadLimits,
    signal?: AbortSignal,
  ): Promise<BoundedTranscriptSnapshot>;
  readColdRoster(sessionId: string): Promise<readonly AgentDescriptor[] | undefined>;
  isTranscriptLiveCoverageVerified?(sessionId: string, agentId: string): boolean;
}

export function historyDirectorySeed(
  getTranscript: () => TranscriptService,
  getNavigation?: () => HistoryNavigationAdapter | undefined,
): ScopeSeed {
  const directory: IHistoryDirectory = {
    _serviceBrand: undefined,
    list: async (request) => {
      const navigation = getNavigation?.();
      if (navigation !== undefined && request.kind === 'turns') return navigation.list(request);
      return listFromTranscript(getTranscript() as unknown as TranscriptDirectorySource, request);
    },
  };
  return [[IHistoryDirectory, directory]];
}

async function listFromTranscript(
  transcript: TranscriptDirectorySource,
  request: HistoryDirectoryRequest,
): Promise<HistoryDirectoryPage> {
  const target: HistoryDirectoryTarget = {
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    agentId: request.agentId,
  };
  const selection: HistoryDirectoryCursorRequest = {
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    kind: request.kind,
    agentId: request.agentId,
    beforeTurn: request.beforeTurn,
    afterTurn: request.afterTurn,
    at: request.at,
    order: request.order,
    limit: request.limit,
  };
  const cursor = request.cursor === undefined ? undefined : decodeHistoryDirectoryCursor(request.cursor);
  if (cursor !== undefined && !sameSelection(cursor.request, selection)) {
    throw new Error('HistoryList cursor conflicts with the requested directory.');
  }
  if (request.kind === 'agents') {
    return listAgents(transcript, request, target, selection, cursor);
  }
  if (request.agentId === undefined) throw new Error('HistoryList turns requires an agent.');
  return listTurns(transcript, request, target, selection, cursor);
}

async function listTurns(
  transcript: TranscriptDirectorySource,
  request: HistoryDirectoryRequest,
  target: HistoryDirectoryTarget,
  selection: HistoryDirectoryCursorRequest,
  cursor: ReturnType<typeof decodeHistoryDirectoryCursor> | undefined,
): Promise<HistoryDirectoryPage> {
  const read = await readTranscript(transcript, request.sessionId, request.agentId!, request.signal);
  if (read === undefined) {
    return {
      status: 'unavailable',
      target,
      source: 'transcript',
      coverage: { complete: false, domain: 'directory', gaps: ['transcript_unavailable'] },
      turns: [],
    };
  }
  const all = turnsFromSnapshot(read.snapshot);
  const ordered = orderTurns(all, request.order);
  const filtered = filterTurns(ordered, request, cursor);
  const page = filtered.slice(0, request.limit);
  const nextCursor = page.length < filtered.length
    ? encodeHistoryDirectoryCursor({
        v: 1,
        request: selection,
        afterTurn: page.at(-1)!.turn,
      })
    : undefined;
  const coverage = turnCoverage(read, all);
  return {
    status: coverage.complete ? page.length > 0 ? 'ok' : 'no_match' : 'partial',
    target,
    source: read.source,
    coverage,
    turns: page,
    nextCursor,
  };
}

async function listAgents(
  transcript: TranscriptDirectorySource,
  request: HistoryDirectoryRequest,
  target: HistoryDirectoryTarget,
  selection: HistoryDirectoryCursorRequest,
  cursor: ReturnType<typeof decodeHistoryDirectoryCursor> | undefined,
): Promise<HistoryDirectoryPage> {
  const read = await readRoster(transcript, request.sessionId);
  if (read === undefined) {
    return {
      status: 'unavailable',
      target: { workspaceId: target.workspaceId, sessionId: target.sessionId },
      source: 'transcript',
      coverage: { complete: false, domain: 'directory', gaps: ['roster_unavailable'] },
      agents: [],
    };
  }
  const all = agentsFromRoster(read.roster);
  const ordered = orderAgents(all, request.order);
  const filtered = filterAgents(ordered, cursor);
  const page = filtered.slice(0, request.limit);
  const last = page.at(-1);
  const nextCursor = page.length < filtered.length && last !== undefined
    ? encodeHistoryDirectoryCursor({
        v: 1,
        request: selection,
        afterAgent: { agentId: last.agentId, time: last.lastTime },
      })
    : undefined;
  const coverage: HistoryDirectoryCoverage = {
    complete: read.complete,
    domain: 'directory',
    gaps: read.gaps.length > 0 ? read.gaps : undefined,
  };
  return {
    status: coverage.complete ? page.length > 0 ? 'ok' : 'no_match' : 'partial',
    target: { workspaceId: target.workspaceId, sessionId: target.sessionId },
    source: read.source,
    coverage,
    agents: page,
    nextCursor,
  };
}

async function readTranscript(
  transcript: TranscriptDirectorySource,
  sessionId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<DirectoryRead | undefined> {
  signal?.throwIfAborted();
  const live = transcript.forSessionLive(sessionId);
  if (live !== undefined) {
    try {
      await transcript.whenReady(sessionId);
      signal?.throwIfAborted();
      const agent = live.getAgent(agentId);
      if (agent !== undefined) {
        const snapshot = agent.snapshot();
        const verified = transcript.isTranscriptLiveCoverageVerified?.(sessionId, agentId) === true;
        const gaps = ['refs_unavailable'];
        if (!verified) gaps.push('live_source_unverified');
        if (snapshot.hasMoreOlder === true) gaps.push('resident_history_window');
        return {
          snapshot,
          source: 'live',
          complete: verified && snapshot.hasMoreOlder !== true && gaps.length === 0,
          gaps,
          stats: { bytes: 0, records: 0 },
        };
      }
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason ?? error;
    }
  }
  const limits: TranscriptColdReadLimits = {
    maxBytes: FALLBACK_MAX_BYTES,
    maxRecords: FALLBACK_MAX_RECORDS,
    chunkBytes: FALLBACK_CHUNK_BYTES,
  };
  let bounded: BoundedTranscriptSnapshot;
  try {
    bounded = await transcript.readColdSnapshotBounded(sessionId, agentId, limits, signal);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error;
    return undefined;
  }
  if (bounded.snapshot === undefined) return undefined;
  return {
    snapshot: bounded.snapshot,
    source: 'transcript',
    complete: false,
    gaps: ['navigation_unavailable', 'bounded_cold_read', bounded.complete ? 'refs_unavailable' : 'cold_read_partial'],
    stats: { bytes: bounded.bytesRead, records: bounded.recordsRead },
  };
}

async function readRoster(
  transcript: TranscriptDirectorySource,
  sessionId: string,
): Promise<RosterRead | undefined> {
  const live = transcript.forSessionLive(sessionId);
  if (live !== undefined) {
    try {
      await transcript.whenReady(sessionId);
      return { roster: live.agents(), source: 'live', complete: true, gaps: [] };
    } catch {
    }
  }
  try {
    const roster = await transcript.readColdRoster(sessionId);
    if (roster === undefined) return undefined;
    return {
      roster,
      source: 'transcript',
      complete: false,
      gaps: ['roster_best_effort', 'navigation_unavailable'],
    };
  } catch {
    return undefined;
  }
}

function turnsFromSnapshot(snapshot: AgentTranscriptSnapshot): HistoryDirectoryTurn[] {
  return snapshot.items.flatMap((item): HistoryDirectoryTurn[] => {
    if (item.kind !== 'turn') return [];
    const assistant = item.steps.flatMap((step) => step.frames)
      .map((frame) => frame.kind === 'text' && frame.role === 'assistant' ? frame.text : undefined)
      .filter((text): text is string => text !== undefined)
      .join(' ');
    const toolCount = item.steps.flatMap((step) => step.frames)
      .filter((frame) => frame.kind === 'tool').length;
    return [{
      turn: item.ordinal,
      startedAt: item.startedAt,
      promptExcerpt: excerpt(item.prompt),
      answerExcerpt: excerpt(assistant),
      stepCount: item.steps.length,
      toolCount,
    }];
  });
}

function agentsFromRoster(roster: readonly AgentDescriptor[]): HistoryDirectoryAgent[] {
  const seen = new Set<string>();
  const entries: HistoryDirectoryAgent[] = [];
  for (const descriptor of roster) {
    if (seen.has(descriptor.agentId)) continue;
    seen.add(descriptor.agentId);
    entries.push({
      agentId: descriptor.agentId,
      name: descriptor.label,
      parentAgentId: descriptor.parentAgentId,
      firstTime: descriptor.createdAt,
      lastTime: descriptor.disposedAt ?? descriptor.createdAt,
      indexed: false,
    });
  }
  if (!seen.has('main')) entries.unshift({ agentId: 'main', indexed: false });
  return entries;
}

function orderTurns(turns: readonly HistoryDirectoryTurn[], order: HistoryDirectoryRequest['order']): HistoryDirectoryTurn[] {
  return turns.toSorted((left, right) => order === 'newest' ? right.turn - left.turn : left.turn - right.turn);
}

function filterTurns(
  turns: readonly HistoryDirectoryTurn[],
  request: HistoryDirectoryRequest,
  cursor: ReturnType<typeof decodeHistoryDirectoryCursor> | undefined,
): HistoryDirectoryTurn[] {
  let result = turns.filter((turn) =>
    (request.beforeTurn === undefined || turn.turn < request.beforeTurn) &&
    (request.afterTurn === undefined || turn.turn > request.afterTurn),
  );
  if (request.at !== undefined) {
    let nearest = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < result.length; index += 1) {
      const value = turnTime(result[index]!);
      if (value === undefined) continue;
      const candidate = Math.abs(value - request.at);
      const prior = nearest < 0 ? undefined : result[nearest];
      if (candidate < distance || candidate === distance && prior !== undefined && result[index]!.turn < prior.turn) {
        nearest = index;
        distance = candidate;
      }
    }
    result = nearest < 0 ? [] : result.slice(nearest);
  }
  const afterTurn = cursor?.afterTurn;
  if (afterTurn === undefined) return result;
  return request.order === 'newest'
    ? result.filter((turn) => turn.turn < afterTurn)
    : result.filter((turn) => turn.turn > afterTurn);
}

function orderAgents(agents: readonly HistoryDirectoryAgent[], order: HistoryDirectoryRequest['order']): HistoryDirectoryAgent[] {
  return agents.toSorted((left, right) => {
    const time = compareOptionalTime(left.lastTime, right.lastTime);
    if (time !== 0) return order === 'newest' ? -time : time;
    return order === 'newest'
      ? right.agentId.localeCompare(left.agentId)
      : left.agentId.localeCompare(right.agentId);
  });
}

function filterAgents(
  agents: readonly HistoryDirectoryAgent[],
  cursor: ReturnType<typeof decodeHistoryDirectoryCursor> | undefined,
): HistoryDirectoryAgent[] {
  const after = cursor?.afterAgent;
  if (after === undefined) return [...agents];
  const index = agents.findIndex((agent) => agent.agentId === after.agentId && agent.lastTime === after.time);
  return index < 0 ? [...agents] : agents.slice(index + 1);
}

function turnCoverage(read: DirectoryRead, turns: readonly HistoryDirectoryTurn[]): HistoryDirectoryCoverage {
  const ordered = turns.toSorted((left, right) => left.turn - right.turn);
  const bounds: readonly [number, number] | undefined = ordered.length === 0
    ? undefined
    : [ordered[0]!.turn, ordered.at(-1)!.turn];
  return {
    complete: read.complete,
    domain: 'directory',
    gaps: read.gaps.length > 0 ? read.gaps : undefined,
    scanned: { turns: bounds, bytes: read.stats.bytes, records: read.stats.records },
  };
}

function turnTime(turn: HistoryDirectoryTurn): number | undefined {
  if (turn.startedAt === undefined) return undefined;
  const value = Date.parse(turn.startedAt);
  return Number.isFinite(value) ? value : undefined;
}

function compareOptionalTime(left: string | undefined, right: string | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left.localeCompare(right);
}

function excerpt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 119)}…`;
}

function sameSelection(left: HistoryDirectoryCursorRequest, right: HistoryDirectoryCursorRequest): boolean {
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId &&
    left.kind === right.kind && left.agentId === right.agentId &&
    left.beforeTurn === right.beforeTurn && left.afterTurn === right.afterTurn &&
    left.at === right.at && left.order === right.order && left.limit === right.limit;
}

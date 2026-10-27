import type { SessionSummary } from '@kiki/agent-core-v2';
import type { UsageFact } from '@kiki/agent-core-v2/agent/usage/usageFact';

import type { FoldBucketView, FoldedUsageRecord } from './usageRangeFold';

export interface UsageProjectionWatermark {
  readonly size: number;
  readonly mtimeMs: number;
  readonly generation: string;
  readonly boundaryHash: string;
}

export interface UsageProjectionSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}

export interface UsageProjectionTurn {
  readonly bucket: string;
  readonly turnIds: readonly number[];
  readonly unknownTurnRecords: number;
}

export interface UsageProjectionAgent {
  readonly scope: string;
  readonly sessionId: string;
  readonly watermark: UsageProjectionWatermark;
  readonly rows: readonly FoldedUsageRecord[];
  readonly turns: readonly UsageProjectionTurn[];
}

/** Unpriced folded rows for one normalized range. Watermarks cover agents still inside the range. */
export interface UsageRangeProjection {
  readonly version: 2;
  readonly fingerprint: string;
  readonly folded: true;
  readonly storedBuckets: boolean;
  readonly journalReplayVersion?: number;
  readonly agents: readonly UsageProjectionAgent[];
  readonly buckets: readonly FoldBucketView[];
  readonly sessions: readonly UsageProjectionSession[];
}

export interface UsageProjectionSource {
  readonly scope: string;
  readonly sessionId: string;
  readonly watermark: UsageProjectionWatermark;
  readonly records: readonly UsageFact[];
}

export class UsageProjectionFold {
  constructor(
    private readonly rows: readonly { readonly sessionId: string; readonly record: FoldedUsageRecord }[],
    private readonly bucketList: readonly FoldBucketView[],
  ) {}

  recordPage(cursor?: string): Promise<{ items: readonly { readonly sessionId: string; readonly record: FoldedUsageRecord }[]; nextCursor?: string }> {
    const offset = cursor === undefined ? 0 : Number(cursor);
    const items = this.rows.slice(offset, offset + 256);
    const next = offset + items.length;
    return Promise.resolve({ items, nextCursor: next < this.rows.length ? String(next) : undefined });
  }

  buckets(keys: readonly string[]): Promise<Map<string, FoldBucketView>> {
    const wanted = new Set(keys);
    const page = new Map<string, FoldBucketView>();
    for (const bucket of this.bucketList) if (wanted.has(bucket.key)) page.set(`bucket:${bucket.key}`, bucket);
    return Promise.resolve(page);
  }
}

export function projectionFileName(fingerprint: string): string {
  return `range-projection-${fingerprint.slice(0, 24)}.json`;
}

export function projectionSessionOf(summary: Pick<SessionSummary, 'id' | 'workspaceId' | 'title' | 'createdAt' | 'updatedAt' | 'archived'>): UsageProjectionSession {
  return {
    id: summary.id,
    workspaceId: summary.workspaceId,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived,
  };
}

export function buildRangeProjection(
  fingerprint: string,
  sessions: readonly UsageProjectionSession[],
  agents: readonly UsageProjectionSource[],
  bucketOf: (sessionId: string, record: UsageFact) => string,
): UsageRangeProjection {
  return {
    version: 2,
    fingerprint,
    folded: true,
    storedBuckets: false,
    sessions,
    buckets: [],
    agents: agents.map((agent) => {
      const folded = foldAgentRecords(agent.records, (record) => bucketOf(agent.sessionId, record));
      return { scope: agent.scope, sessionId: agent.sessionId, watermark: agent.watermark, rows: folded.rows, turns: folded.turns };
    }),
  };
}

export function appendProjectionAgent(
  projection: UsageRangeProjection,
  scope: string,
  watermark: UsageProjectionWatermark,
  records: readonly UsageFact[],
  bucketOf: (record: UsageFact) => string,
): UsageRangeProjection | undefined {
  const agent = projection.agents.find((item) => item.scope === scope);
  if (agent === undefined) return undefined;
  const added = foldAgentRecords(records, bucketOf);
  const merged = new Map<string, FoldedUsageRecord>();
  for (const row of agent.rows) merged.set(foldKey(row, bucketOf(row)), row);
  for (const row of added.rows) {
    const key = foldKey(row, bucketOf(row));
    const previous = merged.get(key);
    merged.set(key, previous === undefined ? row : mergeFolded(previous, row));
  }
  const turns = new Map(agent.turns.map((turn) => [turn.bucket, { ids: new Set(turn.turnIds), unknown: turn.unknownTurnRecords }]));
  for (const turn of added.turns) {
    const existing = turns.get(turn.bucket) ?? { ids: new Set<number>(), unknown: 0 };
    for (const id of turn.turnIds) existing.ids.add(id);
    existing.unknown += turn.unknownTurnRecords;
    turns.set(turn.bucket, existing);
  }
  const next: UsageProjectionAgent = {
    scope,
    sessionId: agent.sessionId,
    watermark,
    rows: [...merged.values()],
    turns: [...turns].map(([bucket, turn]) => ({ bucket, turnIds: [...turn.ids], unknownTurnRecords: turn.unknown })),
  };
  return { ...projection, agents: projection.agents.map((item) => item.scope === scope ? next : item) };
}

export function projectionRows(projection: UsageRangeProjection): { readonly sessionId: string; readonly record: FoldedUsageRecord }[] {
  return projection.agents.flatMap((agent) => agent.rows.map((record) => ({ sessionId: agent.sessionId, record })));
}

export function appendStoredBuckets(
  buckets: readonly FoldBucketView[],
  agents: readonly UsageProjectionAgent[],
  tails: readonly { readonly scope: string; readonly sessionId: string; readonly records: readonly UsageFact[] }[],
  bucketOf: (sessionId: string, record: UsageFact) => string,
  sessionLimit: number,
  turnLimit: number,
): FoldBucketView[] {
  const next: FoldBucketView[] = buckets.map((bucket) => ({
    key: bucket.key,
    turnCount: bucket.turnCount,
    sessionsTruncated: bucket.sessionsTruncated,
    sessions: bucket.sessions.map((session) => ({
      sessionId: session.sessionId,
      turnIds: [...session.turnIds],
      turnCount: session.turnCount,
      unknownTurnRecords: session.unknownTurnRecords,
    })),
  }));
  const byKey = new Map(next.map((bucket) => [bucket.key, bucket]));
  const agentSeen = new Map<string, Set<number>>();
  const sessionSeen = new Map<string, Set<number>>();
  for (const agent of agents) {
    const agentId = agent.scope.slice(agent.scope.lastIndexOf('/') + 1);
    for (const turn of agent.turns) {
      const agentKey = `${agent.sessionId}\0${turn.bucket}\0${agentId}`;
      const ids = agentSeen.get(agentKey) ?? new Set<number>();
      for (const id of turn.turnIds) ids.add(id);
      agentSeen.set(agentKey, ids);
      const seenKey = `${agent.sessionId}\0${turn.bucket}`;
      const shared = sessionSeen.get(seenKey) ?? new Set<number>();
      for (const id of turn.turnIds) shared.add(id);
      sessionSeen.set(seenKey, shared);
    }
  }
  for (const bucket of next) {
    for (const session of bucket.sessions) {
      const seenKey = `${session.sessionId}\0${bucket.key}`;
      const shared = sessionSeen.get(seenKey) ?? new Set<number>();
      for (const id of session.turnIds) shared.add(id);
      sessionSeen.set(seenKey, shared);
    }
  }
  for (const tail of tails) {
    const scopeAgent = tail.scope.slice(tail.scope.lastIndexOf('/') + 1);
    for (const record of tail.records) {
      if (record.invalid) continue;
      const key = bucketOf(tail.sessionId, record);
      let bucket = byKey.get(key);
      if (bucket === undefined) {
        bucket = { key, turnCount: 0, sessions: [], sessionsTruncated: false };
        byKey.set(key, bucket);
        next.push(bucket);
      }
      let session = bucket.sessions.find((item) => item.sessionId === tail.sessionId);
      if (session === undefined && bucket.sessions.length < sessionLimit) {
        session = { sessionId: tail.sessionId, turnIds: [], turnCount: 0, unknownTurnRecords: 0 };
        bucket.sessions.push(session);
      }
      if (record.turnId === undefined) {
        if (session === undefined) bucket.sessionsTruncated = true;
        else session.unknownTurnRecords += 1;
        continue;
      }
      const agentId = record.agentId ?? record.sourceAgentId ?? scopeAgent;
      const agentKey = `${tail.sessionId}\0${key}\0${agentId}`;
      const seenAgent = agentSeen.get(agentKey) ?? new Set<number>();
      if (!seenAgent.has(record.turnId)) {
        seenAgent.add(record.turnId);
        agentSeen.set(agentKey, seenAgent);
        bucket.turnCount += 1;
      }
      if (session === undefined) bucket.sessionsTruncated = true;
      else {
        const seenKey = `${tail.sessionId}\0${key}`;
        const seenSession = sessionSeen.get(seenKey) ?? new Set<number>();
        if (!seenSession.has(record.turnId)) {
          seenSession.add(record.turnId);
          sessionSeen.set(seenKey, seenSession);
          session.turnCount += 1;
          const index = session.turnIds.findIndex((value) => value > record.turnId!);
          session.turnIds.splice(index < 0 ? session.turnIds.length : index, 0, record.turnId);
          if (session.turnIds.length > turnLimit) session.turnIds.pop();
        }
      }
    }
  }
  return next;
}

export function bucketsFromAgents(agents: readonly UsageProjectionAgent[], sessionLimit: number, turnLimit: number): FoldBucketView[] {
  const buckets = new Map<string, FoldBucketView>();
  for (const agent of agents) {
    for (const turn of agent.turns) {
      let bucket = buckets.get(turn.bucket);
      if (bucket === undefined) {
        bucket = { key: turn.bucket, turnCount: 0, sessions: [], sessionsTruncated: false };
        buckets.set(turn.bucket, bucket);
      }
      bucket.turnCount += turn.turnIds.length;
      let session = bucket.sessions.find((item) => item.sessionId === agent.sessionId);
      if (session === undefined && bucket.sessions.length < sessionLimit) {
        session = { sessionId: agent.sessionId, turnIds: [], turnCount: 0, unknownTurnRecords: 0 };
        bucket.sessions.push(session);
      }
      if (session === undefined) {
        bucket.sessionsTruncated = true;
        continue;
      }
      session.unknownTurnRecords += turn.unknownTurnRecords;
      for (const id of turn.turnIds) {
        if (session.turnIds.includes(id)) continue;
        session.turnCount += 1;
        if (session.turnIds.length < turnLimit) {
          const index = session.turnIds.findIndex((value) => value > id);
          session.turnIds.splice(index < 0 ? session.turnIds.length : index, 0, id);
        }
      }
    }
  }
  return [...buckets.values()];
}

export function hasProjectionTurnEvidence(projection: UsageRangeProjection): boolean {
  if (projection.version !== 2) return false;
  if (!projection.storedBuckets) return projection.agents.every((agent) => Array.isArray(agent.turns));
  const counts = new Map<string, number>();
  for (const agent of projection.agents) {
    if (!Array.isArray(agent.turns)) return false;
    for (const turn of agent.turns) counts.set(turn.bucket, (counts.get(turn.bucket) ?? 0) + new Set(turn.turnIds).size);
  }
  return projection.buckets.every((bucket) => bucket.sessionsTruncated === true || (counts.get(bucket.key) ?? 0) === bucket.turnCount);
}

export function parseUsageRangeProjection(bytes: Uint8Array): UsageRangeProjection | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as UsageRangeProjection;
    if (parsed?.version !== 2 || parsed.folded !== true || typeof parsed.fingerprint !== 'string' || !Array.isArray(parsed.agents) || !Array.isArray(parsed.sessions)) return undefined;
    if (parsed.storedBuckets !== true && parsed.storedBuckets !== false) return undefined;
    if (!Array.isArray(parsed.buckets)) return undefined;
    if (!hasProjectionTurnEvidence(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function foldAgentRecords(records: readonly UsageFact[], bucketOf: (record: UsageFact) => string): { rows: FoldedUsageRecord[]; turns: UsageProjectionTurn[] } {
  const groups = new Map<string, FoldedUsageRecord>();
  const turns = new Map<string, { ids: Set<number>; unknown: number }>();
  for (const record of records) {
    if (record.invalid) continue;
    const bucket = bucketOf(record);
    const key = foldKey(record, bucket);
    const previous = groups.get(key);
    const zero = record.usageKnown === undefined && record.usage.inputOther === 0 && record.usage.output === 0 && record.usage.inputCacheRead === 0 && record.usage.inputCacheCreation === 0;
    const known = record.usageKnown !== false && !zero;
    const usage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, ...previous?.usage };
    if (known) {
      usage.inputOther += record.usage.inputOther;
      usage.output += record.usage.output;
      usage.inputCacheRead += record.usage.inputCacheRead;
      usage.inputCacheCreation += record.usage.inputCacheCreation;
    }
    groups.set(key, {
      time: Math.min(previous?.time ?? record.time, record.time),
      model: record.model,
      usage,
      usageKnown: true,
      agentId: record.agentId,
      parentAgentId: record.parentAgentId,
      provider: record.provider,
      modelAlias: record.modelAlias,
      profileName: record.profileName,
      sourceAgentId: record.sourceAgentId,
      folded: {
        records: (previous?.folded.records ?? 0) + 1,
        known: (previous?.folded.known ?? 0) + Number(known),
        missing: (previous?.folded.missing ?? 0) + Number(record.usageKnown === false),
        legacyZero: (previous?.folded.legacyZero ?? 0) + Number(zero),
        latestAt: Math.max(previous?.folded.latestAt ?? record.time, record.time),
      },
    });
    const turn = turns.get(bucket) ?? { ids: new Set<number>(), unknown: 0 };
    if (record.turnId === undefined) turn.unknown += 1;
    else turn.ids.add(record.turnId);
    turns.set(bucket, turn);
  }
  return {
    rows: [...groups.values()],
    turns: [...turns].map(([bucket, turn]) => ({ bucket, turnIds: [...turn.ids], unknownTurnRecords: turn.unknown })),
  };
}

function foldKey(record: Pick<UsageFact, 'model' | 'agentId' | 'parentAgentId' | 'provider' | 'modelAlias' | 'profileName'>, bucket: string): string {
  return JSON.stringify([bucket, record.model, record.agentId ?? null, record.parentAgentId ?? null, record.provider ?? null, record.modelAlias ?? null, record.profileName ?? null]);
}

function mergeFolded(left: FoldedUsageRecord, right: FoldedUsageRecord): FoldedUsageRecord {
  return {
    ...left,
    time: Math.min(left.time, right.time),
    usage: {
      inputOther: left.usage.inputOther + right.usage.inputOther,
      output: left.usage.output + right.usage.output,
      inputCacheRead: left.usage.inputCacheRead + right.usage.inputCacheRead,
      inputCacheCreation: left.usage.inputCacheCreation + right.usage.inputCacheCreation,
    },
    folded: {
      records: left.folded.records + right.folded.records,
      known: left.folded.known + right.folded.known,
      missing: left.folded.missing + right.folded.missing,
      legacyZero: left.folded.legacyZero + right.folded.legacyZero,
      latestAt: Math.max(left.folded.latestAt, right.folded.latestAt),
    },
  };
}

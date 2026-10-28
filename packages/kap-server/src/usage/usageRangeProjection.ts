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

export function projectionFileName(fingerprint: string): string {
  return `range-projection-${fingerprint.slice(0, 24)}.json`;
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

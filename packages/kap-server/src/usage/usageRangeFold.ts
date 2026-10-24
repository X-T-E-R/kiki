import { createHash } from 'node:crypto';

import type { SessionSummary } from '@kiki/agent-core-v2';
import type { UsageFact } from '@kiki/agent-core-v2/agent/usage/usageFact';
import type { IQueryStore, WriteOp } from '@kiki/agent-core-v2/persistence/interface/queryStore';

export interface FoldedUsageRecord extends UsageFact {
  readonly folded: {
    readonly records: number;
    readonly known: number;
    readonly missing: number;
    readonly legacyZero: number;
    readonly latestAt: number;
  };
}

export interface FoldBucketView {
  readonly key: string;
  turnCount: number;
  readonly sessions: {
    readonly sessionId: string;
    readonly turnIds: number[];
    turnCount: number;
    unknownTurnRecords: number;
    agents?: {
      agentId: string;
      turnIds: number[];
      unknownTurnRecords: number;
    }[];
  }[];
  sessionsTruncated: boolean;
}

interface GroupRow {
  readonly kind: 'group';
  readonly sessionId: string;
  readonly record: FoldedUsageRecord;
}

interface BucketRow extends FoldBucketView { readonly kind: 'bucket' }

/** A bounded page folds into unpriced groups and exact disk-backed turn sets. Group changes, dedup markers and the caller's continuation head commit together. */
export class UsageRangeFold {
  constructor(
    private readonly query: IQueryStore,
    private readonly collection: string,
    private readonly sessionLimit: number,
    private readonly turnLimit: number,
  ) {}

  head<T>(): Promise<T | undefined> { return this.query.get<T>(this.collection, 'head'); }
  saveHead(head: unknown): Promise<void> { return this.query.put(this.collection, 'head', head); }
  reset(): Promise<void> { return this.query.dropCollection(this.collection); }

  async addPage(
    summary: SessionSummary,
    records: readonly UsageFact[],
    bucketOf: (record: UsageFact) => string,
    matches: (record: UsageFact) => boolean,
    head: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const selected = records.filter((record) => !record.invalid && matches(record));
    const rows = selected.map((record) => {
      const bucket = bucketOf(record);
      const group = foldKey(`group:${JSON.stringify([summary.id, bucket, record.model, record.agentId, record.parentAgentId, record.provider, record.modelAlias, record.profileName])}`);
      const turn = record.turnId === undefined ? undefined : foldKey(`turn:${JSON.stringify([bucket, summary.id, record.agentId ?? record.sourceAgentId ?? '', record.turnId])}`);
      const drilldown = record.turnId === undefined ? undefined : foldKey(`drilldown:${JSON.stringify([bucket, summary.id, record.turnId])}`);
      return { record, bucket: foldKey(`bucket:${bucket}`), bucketKey: bucket, group, turn, drilldown };
    });
    const keys = [...new Set(rows.flatMap((row) => [row.group, row.bucket, row.turn, row.drilldown].filter((key): key is string => key !== undefined)))];
    const existing = await this.query.getMany<GroupRow | BucketRow | true>(this.collection, keys);
    signal?.throwIfAborted();
    const changed = new Map<string, GroupRow | BucketRow | true>();
    const read = <T extends GroupRow | BucketRow | true>(key: string): T | undefined => (changed.get(key) ?? existing.get(key)) as T | undefined;
    for (const row of rows) {
      const { record } = row;
      const previous = read<GroupRow>(row.group);
      const legacyZero = record.usageKnown === undefined && Object.values(record.usage).every((value) => value === 0);
      const known = record.usageKnown !== false && !legacyZero;
      const usage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, ...previous?.record.usage };
      if (known) for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'] as const) usage[key] += record.usage[key];
      changed.set(row.group, {
        kind: 'group', sessionId: summary.id,
        record: {
          time: Math.min(previous?.record.time ?? record.time, record.time), model: record.model,
          usage, usageKnown: true, sourceAgentId: record.sourceAgentId, agentId: record.agentId, parentAgentId: record.parentAgentId,
          provider: record.provider, modelAlias: record.modelAlias, profileName: record.profileName,
          folded: {
            records: (previous?.record.folded.records ?? 0) + 1,
            known: (previous?.record.folded.known ?? 0) + Number(known),
            missing: (previous?.record.folded.missing ?? 0) + Number(record.usageKnown === false),
            legacyZero: (previous?.record.folded.legacyZero ?? 0) + Number(legacyZero),
            latestAt: Math.max(previous?.record.folded.latestAt ?? record.time, record.time),
          },
        },
      });
      let bucket = read<BucketRow>(row.bucket);
      if (!changed.has(row.bucket)) {
        bucket = bucket === undefined ? { kind: 'bucket', key: row.bucketKey, turnCount: 0, sessions: [], sessionsTruncated: false } : structuredClone(bucket);
        changed.set(row.bucket, bucket);
      }
      const turnIsNew = row.turn !== undefined && read(row.turn) === undefined;
      if (turnIsNew) { changed.set(row.turn!, true); bucket!.turnCount++; }
      let session = bucket!.sessions.find((value) => value.sessionId === summary.id);
      if (session === undefined && bucket!.sessions.length < this.sessionLimit) {
        session = { sessionId: summary.id, turnIds: [], turnCount: 0, unknownTurnRecords: 0, agents: [] };
        bucket!.sessions.push(session);
      }
      if (session === undefined) bucket!.sessionsTruncated = true;
      else {
        const agentId = record.agentId ?? record.sourceAgentId ?? '';
        const listedAgents = session.agents ?? [];
        if (session.agents === undefined) session.agents = listedAgents;
        let agent = listedAgents.find((item) => item.agentId === agentId);
        if (agent === undefined) {
          agent = { agentId, turnIds: [], unknownTurnRecords: 0 };
          listedAgents.push(agent);
        }
        if (row.drilldown === undefined) { session.unknownTurnRecords++; agent.unknownTurnRecords++; }
        else if (read(row.drilldown) === undefined) {
          changed.set(row.drilldown, true);
          session.turnCount++;
          const index = session.turnIds.findIndex((value) => value > record.turnId!);
          session.turnIds.splice(index < 0 ? session.turnIds.length : index, 0, record.turnId!);
          if (session.turnIds.length > this.turnLimit) session.turnIds.pop();
        }
        if (turnIsNew) agent.turnIds.push(record.turnId!);
      }
    }
    const ops: WriteOp[] = [...changed].map(([key, value]) => ({ kind: 'put', collection: this.collection, key, value, columns: value === true ? undefined : { view: value.kind === 'group' ? 1 : 2 } }));
    ops.push({ kind: 'put', collection: this.collection, key: 'head', value: head });
    signal?.throwIfAborted();
    await this.query.batch(ops);
  }

  recordPage(cursor?: string) {
    return this.query.query<GroupRow>(this.collection).whereColumn('view', { gte: 1, lte: 1 }).limit(256).cursor(cursor).execute();
  }

  buckets(keys: readonly string[]): Promise<Map<string, FoldBucketView>> {
    return this.query.getMany<BucketRow>(this.collection, keys.map((key) => foldKey(`bucket:${key}`)));
  }
}

function foldKey(key: string): string {
  if (key.length <= 90) return key;
  const prefix = key.slice(0, Math.max(0, key.indexOf(':')));
  const hashed = `${prefix}:${createHash('sha256').update(key).digest('hex')}`;
  return hashed.length <= 90 ? hashed : createHash('sha256').update(key).digest('hex');
}

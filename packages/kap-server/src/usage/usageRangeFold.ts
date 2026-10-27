import { createHash, randomUUID } from 'node:crypto';

import type { SessionSummary } from '@kiki/agent-core-v2';
import type { UsageFact } from '@kiki/agent-core-v2/agent/usage/usageFact';
import { UsageFactCursorChangedError } from '@kiki/agent-core-v2/app/usageFacts/usageFactStore';
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
  turnAgents?: boolean;
}

interface GroupRow {
  readonly kind: 'group';
  readonly sessionId: string;
  readonly record: FoldedUsageRecord;
}

interface BucketRow extends FoldBucketView { readonly kind: 'bucket' }

export interface UsageFoldCheckpoint {
  readonly generation?: string;
  readonly offset: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly boundaryHash: string;
  readonly valid: boolean;
}

export interface RangeFoldSource {
  readonly agentId: string;
  readonly scope: string;
  checkpoint: UsageFoldCheckpoint;
  cursor?: string;
  done: boolean;
}

export interface RangeFoldSession {
  readonly summary: SessionSummary;
  sources?: RangeFoldSource[];
  invalid: boolean;
  prepared: boolean;
}

export interface RangeFoldHead {
  readonly version: 1;
  readonly journalReplayVersion?: 2 | 3;
  readonly fingerprint: string;
  readonly sessions: RangeFoldSession[];
  complete: boolean;
  inventoryComplete: boolean;
  invalidated: boolean;
}

interface FoldRevision { readonly epoch: string; readonly revision: number }
interface StoredHead { readonly layout: 2; readonly value: unknown; readonly sessions?: readonly string[] }
interface StoredSession { readonly value: Omit<RangeFoldSession, 'sources'>; readonly hasSources: boolean }
interface FoldProgress { readonly session: RangeFoldSession; readonly source?: RangeFoldSource }
const REVISION = 'head:revision';

export class UsageRangeFoldChangedError extends UsageFactCursorChangedError {}

/** A bounded page folds into unpriced groups and exact disk-backed turn sets. Source continuation, group changes and revision/epoch comparison commit together. */
export class UsageRangeFold {
  private initialized = false;
  private revision?: FoldRevision;
  private readonly persisted = new Map<string, string>();

  constructor(
    private readonly query: IQueryStore,
    private readonly collection: string,
    private readonly sessionLimit: number,
    private readonly turnLimit: number,
  ) {}

  async head<T>(): Promise<T | undefined> {
    if (this.query.batchIf === undefined) return this.query.get<T>(this.collection, 'head');
    const roots = await this.query.getMany<StoredHead | FoldRevision>(this.collection, ['head', REVISION]);
    this.revision = roots.get(REVISION) as FoldRevision | undefined;
    this.initialized = true;
    this.persisted.clear();
    const root = roots.get('head') as StoredHead | undefined;
    if (root?.layout !== 2 || this.revision === undefined) return undefined;
    this.persisted.set('head', JSON.stringify(root));
    if (root.sessions === undefined) return root.value as T;
    const sessionRows = await this.query.getMany<StoredSession | readonly string[]>(this.collection, root.sessions.flatMap((key) => [key, `${key}:sources`]));
    const sourceKeys = root.sessions.flatMap((key) => sessionRows.get(`${key}:sources`) as readonly string[] ?? []);
    const sources = await this.query.getMany<RangeFoldSource>(this.collection, sourceKeys);
    const current = await this.query.get<FoldRevision>(this.collection, REVISION);
    if (current?.epoch !== this.revision.epoch || current.revision !== this.revision.revision) throw new UsageRangeFoldChangedError();
    const sessions = root.sessions.map((key) => {
      const row = sessionRows.get(key) as StoredSession | undefined;
      if (row === undefined) throw new UsageRangeFoldChangedError();
      this.persisted.set(key, JSON.stringify(row));
      const keys = sessionRows.get(`${key}:sources`) as readonly string[] | undefined;
      if (keys !== undefined) this.persisted.set(`${key}:sources`, JSON.stringify(keys));
      return { ...row.value, sources: row.hasSources ? (keys ?? []).map((sourceKey) => {
        const source = sources.get(sourceKey);
        if (source === undefined) throw new UsageRangeFoldChangedError();
        this.persisted.set(sourceKey, JSON.stringify(source));
        return source;
      }) : undefined };
    });
    return { ...(root.value as object), sessions } as T;
  }

  async saveHead(head: unknown, session?: RangeFoldSession): Promise<void> {
    if (this.query.batchIf === undefined) return this.query.put(this.collection, 'head', head);
    await this.initialize();
    const rows = this.headRows(head, session === undefined ? undefined : { session });
    await this.commit([], rows, session === undefined, this.revision);
  }

  async reset(): Promise<void> {
    if (this.query.batchIf === undefined) return this.query.dropCollection(this.collection);
    await this.initialize();
    const revision = { epoch: randomUUID(), revision: 0 };
    const committed = await this.query.batchIf([{ collection: this.collection, key: REVISION, value: this.revision }], [{ kind: 'put', collection: this.collection, key: REVISION, value: revision }], { source: `${this.collection}:reset:${revision.epoch}`, collection: this.collection, replace: true });
    if (!committed) this.conflict();
    this.revision = revision;
    this.persisted.clear();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.revision = await this.query.get<FoldRevision>(this.collection, REVISION);
    this.initialized = true;
  }

  private headRows(head: unknown, progress?: FoldProgress): Map<string, unknown> {
    const rows = new Map<string, unknown>();
    if (!isRangeHead(head)) { rows.set('head', { layout: 2, value: head }); return rows; }
    const { sessions, ...value } = head;
    if (progress === undefined) rows.set('head', { layout: 2, value, sessions: sessions.map(sessionRowKey) });
    for (const session of progress === undefined ? sessions : [progress.session]) {
      const key = sessionRowKey(session);
      const { sources, ...value } = session;
      rows.set(key, { value, hasSources: sources !== undefined });
      if (progress?.source === undefined) {
        if (sources !== undefined) rows.set(`${key}:sources`, sources.map(sourceRowKey));
        for (const source of sources ?? []) rows.set(sourceRowKey(source), source);
      } else rows.set(sourceRowKey(progress.source), progress.source);
    }
    return rows;
  }

  private async commit(ops: WriteOp[], rows: Map<string, unknown>, replace: boolean, expected: FoldRevision | undefined): Promise<void> {
    const changes = new Map<string, string>();
    for (const [key, value] of rows) {
      const json = JSON.stringify(value);
      if (this.persisted.get(key) !== json) { ops.push({ kind: 'put', collection: this.collection, key, value }); changes.set(key, json); }
    }
    if (replace) for (const key of this.persisted.keys()) if (!rows.has(key)) ops.push({ kind: 'delete', collection: this.collection, key });
    const revision = { epoch: expected?.epoch ?? randomUUID(), revision: (expected?.revision ?? 0) + 1 };
    ops.push({ kind: 'put', collection: this.collection, key: REVISION, value: revision });
    if (!await this.query.batchIf!([{ collection: this.collection, key: REVISION, value: expected }], ops)) this.conflict();
    this.revision = revision;
    if (replace) for (const key of this.persisted.keys()) if (!rows.has(key)) this.persisted.delete(key);
    for (const [key, value] of changes) this.persisted.set(key, value);
  }

  private conflict(): never {
    this.initialized = false;
    this.persisted.clear();
    throw new UsageRangeFoldChangedError();
  }

  async addPage(
    summary: SessionSummary,
    records: readonly UsageFact[],
    bucketOf: (record: UsageFact) => string,
    matches: (record: UsageFact) => boolean,
    head: unknown,
    signal?: AbortSignal,
    progress?: FoldProgress,
  ): Promise<void> {
    signal?.throwIfAborted();
    const selected = records.filter((record) => !record.invalid && matches(record));
    const keyLimit = this.query.batchIf === undefined ? Math.min(90, 127 - this.collection.length) : 90;
    const rows = selected.map((record) => {
      const bucket = bucketOf(record);
      const group = foldKey(`group:${JSON.stringify([summary.id, bucket, record.model, record.agentId, record.parentAgentId, record.provider, record.modelAlias, record.profileName])}`, keyLimit);
      const turn = record.turnId === undefined ? undefined : foldKey(`turn:${JSON.stringify([bucket, summary.id, record.agentId ?? record.sourceAgentId ?? '', record.turnId])}`, keyLimit);
      const drilldown = record.turnId === undefined ? undefined : foldKey(`drilldown:${JSON.stringify([bucket, summary.id, record.turnId])}`, keyLimit);
      return { record, bucket: foldKey(`bucket:${bucket}`, keyLimit), bucketKey: bucket, group, turn, drilldown };
    });
    const keys = [...new Set(rows.flatMap((row) => [row.group, row.bucket, row.turn, row.drilldown].filter((key): key is string => key !== undefined)))];
    if (this.query.batchIf !== undefined) await this.initialize();
    const revision = this.revision;
    const existing = await this.query.getMany<GroupRow | BucketRow | true>(this.collection, keys, signal);
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
        bucket = bucket === undefined ? { kind: 'bucket', key: row.bucketKey, turnCount: 0, sessions: [], sessionsTruncated: false, turnAgents: true } : structuredClone(bucket);
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
        if (turnIsNew && agent.turnIds.includes(record.turnId!)) bucket!.turnCount -= 1;
        else if (turnIsNew) agent.turnIds.push(record.turnId!);
      }
    }
    const ops: WriteOp[] = [...changed].map(([key, value]) => ({ kind: 'put', collection: this.collection, key, value, columns: value === true ? undefined : { view: value.kind === 'group' ? 1 : 2 } }));
    signal?.throwIfAborted();
    if (this.query.batchIf !== undefined) await this.commit(ops, this.headRows(head, progress), false, revision);
    else { ops.push({ kind: 'put', collection: this.collection, key: 'head', value: head }); await this.query.batch(ops); }
  }

  recordPage(cursor?: string) {
    return this.query.query<GroupRow>(this.collection).whereColumn('view', { gte: 1, lte: 1 }).limit(256).cursor(cursor).execute();
  }

  buckets(keys: readonly string[]): Promise<Map<string, FoldBucketView>> {
    const keyLimit = this.query.batchIf === undefined ? Math.min(90, 127 - this.collection.length) : 90;
    return this.query.getMany<BucketRow>(this.collection, keys.map((key) => foldKey(`bucket:${key}`, keyLimit)));
  }

  async putBucket(bucket: FoldBucketView): Promise<void> {
    const keyLimit = this.query.batchIf === undefined ? Math.min(90, 127 - this.collection.length) : 90;
    const op: WriteOp = { kind: 'put', collection: this.collection, key: foldKey(`bucket:${bucket.key}`, keyLimit), value: { kind: 'bucket', ...bucket }, columns: { view: 2 } };
    if (this.query.batchIf === undefined) return this.query.batch([op]);
    await this.initialize();
    await this.commit([op], new Map(), false, this.revision);
  }
}

function isRangeHead(head: unknown): head is RangeFoldHead {
  return head !== null && typeof head === 'object' && 'version' in head && head.version === 1 && 'sessions' in head && Array.isArray(head.sessions);
}
function sessionRowKey(session: RangeFoldSession): string { return foldKey(`session:${JSON.stringify([session.summary.workspaceId, session.summary.id])}`); }
function sourceRowKey(source: RangeFoldSource): string { return foldKey(`source:${source.scope}`); }

function foldKey(key: string, limit = 90): string {
  if (key.length <= limit) return key;
  const prefix = key.slice(0, Math.max(0, key.indexOf(':')));
  const hash = createHash('sha256').update(key).digest('hex');
  return `${prefix}:${hash}`.slice(0, limit);
}

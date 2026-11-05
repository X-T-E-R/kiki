import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { UsageSettled } from '#/agent/usage/usageEvents';
import { usageFactTotalsSchema, type UsageFact } from '#/agent/usage/usageFact';
import { IUsageReadModel, type UsageImportProgress, type UsageReadModelSession } from '#/persistence/interface/usageReadModel';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { readSessionMetadataResult } from '#/app/sessionIndex/sessionIndexSource';
import { ILogService } from '#/_base/log/log';
import type { IDisposable } from '#/_base/di/lifecycle';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, type IStorageLock } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  IRetainedUsageService,
  RETAINED_USAGE_VERSION,
  RETAINED_USAGE_SCOPE,
  RETAINED_USAGE_KEY,
  EPHEMERAL_USAGE_KEY,
  OPERATION_USAGE_KEY,
  operationUsageSource,
  type OperationUsageSession,
  type OperationUsageRecord,
  type EphemeralUsageTotal,
  type RetainedDeletedSessionUsage,
  type RetainedUsageIncompleteReason,
  type RetainedUsageListQuery,
  type RetainedUsageListResult,
  type RetainedUsageRecord,
  type RetainedUsageExportEvent,
} from './retainedUsage';

const RETAINED_READ_CHUNK_BYTES = 64 * 1024;

const tokenUsageSchema = z.object({
  inputOther: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  inputCacheRead: z.number().finite().nonnegative(),
  inputCacheCreation: z.number().finite().nonnegative(),
});

const sessionUsageSummarySchema = z.object({
  total: tokenUsageSchema,
  byModel: z.record(z.string(), tokenUsageSchema).optional(),
  wireComplete: z.literal(true).optional(),
  accounting: usageFactTotalsSchema.optional(),
});

const retainedUsageRecordSchema = z.object({
  time: z.number().finite().nonnegative(),
  model: z.string(),
  usage: tokenUsageSchema,
  usageScope: z.enum(['session', 'turn']).optional(),
  turnId: z.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  parentAgentId: z.string().optional(),
  provider: z.string().optional(),
  modelAlias: z.string().optional(),
  profileName: z.string().optional(),
  executorId: z.string().optional(),
  usageKnown: z.boolean().optional(),
});

const operationUsageSchema = z.object({
  version: z.literal(1),
  session: z.object({
    id: z.string().min(1), workspaceId: z.string().min(1),
    createdAt: z.number().finite().nonnegative(), updatedAt: z.number().finite().nonnegative(), archived: z.boolean(),
  }),
  record: retainedUsageRecordSchema.omit({ turnId: true, usageScope: true }).extend({
    model: z.string().min(1), agentId: z.string().min(1), usageKnown: z.boolean(), requestKind: z.string().min(1),
  }),
});

const ephemeralUsageSchema = z.object({
  workspaceId: z.string(),
  time: z.number().finite().nonnegative(),
  model: z.string(),
  usage: tokenUsageSchema,
  usageKnown: z.boolean().optional(),
});

const ephemeralUsageStartSchema = z.object({
  kind: z.literal('source'),
  sourceId: z.string(),
  recordCount: z.number().int().nonnegative(),
});

const ephemeralUsageRecordSchema = z.object({
  kind: z.literal('record'),
  record: ephemeralUsageSchema,
});

const ephemeralUsageCommitSchema = z.object({
  kind: z.literal('commit'),
  sourceId: z.string(),
});

type EphemeralUsageEvent =
  | { kind: 'progress' }
  | { kind: 'record'; record: EphemeralUsageTotal }
  | { kind: 'commit'; sourceId: string }
  | { kind: 'incomplete'; reason?: RetainedUsageIncompleteReason };

const retainedDeletedSessionUsageHeaderSchema = z.object({
  version: z.literal(RETAINED_USAGE_VERSION),
  id: z.string(),
  workspaceId: z.string(),
});

const retainedDeletedSessionUsageMetaSchema = z.object({
  cwd: z.string().optional(),
  title: z.string().optional(),
  lastPrompt: z.string().optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  archived: z.boolean(),
  archivedAt: z.number().finite().nonnegative().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  lastTurnReason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  usage: sessionUsageSummarySchema.optional(),
  deleted: z.literal(true),
  deletedAt: z.number().finite().nonnegative(),
  complete: z.boolean(),
});

const retainedUsageLedgerStartSchema = retainedDeletedSessionUsageHeaderSchema.extend({
  kind: z.literal('session'),
  recordCount: z.number().int().nonnegative(),
});

const retainedUsageLedgerMetaSchema = retainedDeletedSessionUsageMetaSchema.extend({
  kind: z.literal('meta'),
});

const retainedUsageLedgerRecordSchema = z.object({
  kind: z.literal('record'),
  record: retainedUsageRecordSchema,
});

const retainedUsageLedgerCommitSchema = z.object({
  kind: z.literal('commit'),
});

const retainedUsageLedgerKindSchema = z.object({
  kind: z.string(),
});

type RetainedUsageLedgerStart = z.infer<typeof retainedUsageLedgerStartSchema>;
type RetainedUsageLedgerMeta = z.infer<typeof retainedUsageLedgerMetaSchema>;
interface RetainedImportState {
  generation: string;
  damaged: boolean;
  current?: { source: string; transactionId?: string; count: number; observed: number; valid: boolean; session?: UsageReadModelSession; header?: RetainedUsageLedgerStart; meta?: RetainedUsageLedgerMeta };
}

type OperationUsageEntry = z.infer<typeof operationUsageSchema>;
interface OperationWriter {
  readonly lock: IStorageLock;
  readonly owner: IDisposable;
  readonly appended: OperationUsageEntry[];
}
interface OperationSourceSnapshot {
  readonly generation: string;
  readonly size: number;
  readonly mtimeMs: number;
}
interface OperationImportState extends OperationSourceSnapshot {
  readonly publicationGeneration: string;
  readonly boundaryHash: string;
  damaged: boolean;
}

export class RetainedUsageService implements IRetainedUsageService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @IEventService private readonly events: IEventService,
    @IUsageReadModel private readonly model: IUsageReadModel,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {}

  private importing = Promise.resolve();
  private operationWrites = Promise.resolve();
  private readonly operationQueue: OperationUsageEntry[] = [];
  private operationWriter?: OperationWriter;

  get operationWritesPending(): boolean {
    return this.operationQueue.length > 0 || (this.operationWriter?.appended.length ?? 0) > 0;
  }

  recordOperation(session: OperationUsageSession, record: OperationUsageRecord): Promise<void> {
    this.operationQueue.push(operationUsageSchema.parse({ version: 1, session, record }));
    return this.runOperationWrite(async () => {
      if (this.operationQueue.length === 0 && this.operationWriter === undefined) return;
      try { await this.withOperationWriter(3000, undefined, async () => {}); }
      catch (error) {
        if (!(error instanceof StorageError)) throw error;
        this.log.warn('operation usage awaiting persistence recovery', { sessionId: session.id, agentId: record.agentId, error: error.code });
      }
    });
  }

  private runOperationWrite<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.operationWrites.then(work);
    this.operationWrites = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async withOperationWriter<T>(waitForMs: number, signal: AbortSignal | undefined, observe: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const key = OPERATION_USAGE_KEY;
    let writer = this.operationWriter;
    if (writer === undefined) {
      const lock = await this.storage.acquireLock(this.storeScope, 'session-operations-v1.lock', { waitForMs, signal, owner: { kind: 'usage-operations' } });
      writer = { lock, owner: this.appendLog.acquire(this.storeScope, key), appended: [] };
      this.operationWriter = writer;
    }
    for (const entry of this.operationQueue.splice(0)) {
      this.appendLog.append(this.storeScope, key, entry);
      writer.appended.push(entry);
    }
    await this.appendLog.flush(this.storeScope, key);
    this.operationWriter = undefined;
    try { return await observe(); }
    finally {
      await this.releaseOperationWriter(writer);
      for (const { session, record } of writer.appended) this.events.publish(new UsageSettled({ payload: { sessionId: session.id, agentId: record.agentId } }));
    }
  }

  private async releaseOperationWriter(writer: OperationWriter): Promise<void> {
    try { await writer.owner.dispose(); }
    finally { await writer.lock.release(); }
  }

  private async inspectOperationSource(deadlineAt: number, signal?: AbortSignal): Promise<OperationSourceSnapshot | undefined> {
    return this.runOperationWrite(async () => {
      const key = OPERATION_USAGE_KEY;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return undefined;
      try {
        return await this.withOperationWriter(Math.min(3000, remaining), signal, async () => ({
          size: await this.storage.size(this.storeScope, key) ?? 0,
          mtimeMs: await this.storage.mtime(this.storeScope, key) ?? 0,
          generation: await this.appendLog.generation(this.storeScope, key),
        }));
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof StorageError)) throw error;
        return undefined;
      }
    });
  }

  private async operationSourceUnchanged(snapshot: OperationSourceSnapshot): Promise<boolean> {
    const key = OPERATION_USAGE_KEY;
    return (await this.storage.size(this.storeScope, key) ?? 0) === snapshot.size
      && (await this.storage.mtime(this.storeScope, key) ?? 0) === snapshot.mtimeMs
      && await this.appendLog.generation(this.storeScope, key) === snapshot.generation
      && !this.operationWritesPending;
  }

  private async operationBoundaryHash(end: number, signal?: AbortSignal): Promise<string> {
    if (end === 0) return '';
    const digest = createHash('sha256');
    for await (const bytes of this.storage.readStream(this.storeScope, OPERATION_USAGE_KEY, { start: Math.max(0, end - 4096), end: end - 1 }, { signal })) digest.update(bytes);
    return digest.digest('base64url');
  }

  async readOperationSummary(workspaceId: string, sessionId: string, query: RetainedUsageListQuery) {
    const progress = await this.prepareOperations(query);
    const { totals, head } = await this.model.summary(operationUsageSource(workspaceId, sessionId), query.signal);
    return { totals, revision: head?.revision, complete: progress.complete };
  }

  private prepareOperations(query: RetainedUsageListQuery) {
    const next = this.importing.then(() => this.importOperations(query));
    this.importing = next.then(() => undefined, () => undefined);
    return next;
  }

  async dispose(): Promise<void> {
    await this.importing;
    await this.runOperationWrite(async () => {
      if (this.operationWriter === undefined && this.operationQueue.length === 0) return;
      try { await this.withOperationWriter(3000, undefined, async () => {}); }
      catch (error) {
        const writer = this.operationWriter;
        this.operationWriter = undefined;
        if (writer !== undefined) {
          try { await writer.owner.dispose(); await this.appendLog.drainRetirements(); }
          finally { await writer.lock.release(); }
        }
        throw error;
      }
    });
  }

  private async importOperations(query: RetainedUsageListQuery): Promise<{ complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
    const key = OPERATION_USAGE_KEY;
    const snapshot = await this.inspectOperationSource(query.deadlineAt, query.signal);
    if (snapshot === undefined) return { complete: false, scannedRecords: 0, incompleteReason: Date.now() >= query.deadlineAt ? 'deadline' : undefined };
    const { size, mtimeMs } = snapshot;
    const source = `retained-ledger:${key}`;
    let expected = await this.model.progress(source, query.signal);
    if (size === 0 && expected === undefined) return { complete: true, scannedRecords: 0 };
    const prior = expected?.parser as OperationImportState | undefined;
    const reusable = operationPrefixCurrent(prior, snapshot) && (size === prior.size || await this.operationBoundaryHash(prior.size, query.signal) === prior.boundaryHash);
    const boundaryHash = reusable && size === prior.size ? prior.boundaryHash : await this.operationBoundaryHash(size, query.signal);
    const state: OperationImportState = { ...snapshot, boundaryHash, publicationGeneration: reusable ? prior.publicationGeneration : randomUUID(), damaged: reusable && prior.damaged };
    const generation = state.publicationGeneration;
    let offset = reusable ? expected?.offset ?? 0 : 0;
    let scannedRecords = 0;
    const remaining = (): RetainedUsageIncompleteReason | undefined => Date.now() >= query.deadlineAt ? 'deadline' : scannedRecords >= query.recordLimit ? 'record_budget' : undefined;
    for await (const raw of this.appendLog.read<unknown>(this.storeScope, key, { startOffset: offset, endOffset: size, signal: query.signal, chunkBytes: RETAINED_READ_CHUNK_BYTES, onPosition: (position) => { offset = position; }, onTruncate: () => { state.damaged = true; } })) {
      const reason = remaining();
      if (reason !== undefined) return { complete: false, scannedRecords, incompleteReason: reason };
      const parsed = operationUsageSchema.safeParse(raw);
      scannedRecords++;
      if (!parsed.success) state.damaged = true;
      const progress: UsageImportProgress = { batchStart: offset, offset, ordinal: parsed.success ? 1 : 0, parser: { ...state } };
      const value = parsed.success ? parsed.data : undefined;
      const target = value === undefined ? undefined : operationUsageSource(value.session.workspaceId, value.session.id);
      const previous = target === undefined ? undefined : (await this.model.source(target, query.signal))?.checkpoint;
      if (!await this.model.apply({ source, expected, progress, records: value === undefined ? [] : [value.record], reset: true,
        publish: value === undefined ? undefined : { source: target, kind: 'operation', session: { ...value.session, deleted: false }, start: previous?.generation === generation ? previous.offset : 0,
          checkpoint: { generation, offset, size: offset, mtimeMs, boundaryHash: '', valid: true }, journalSize: size },
        continuation: { ...progress, ordinal: 0 },
      })) throw new Error('Operation Usage progress changed; retry');
      expected = { ...progress, ordinal: 0 };
    }
    const saved = expected?.parser as OperationImportState | undefined;
    if (saved?.publicationGeneration !== generation || saved.size !== size || saved.damaged !== state.damaged || expected?.offset !== offset) {
      const progress: UsageImportProgress = { batchStart: offset, offset, ordinal: 0, parser: state };
      if (!await this.model.apply({ source, expected, progress, records: [] })) throw new Error('Operation Usage progress changed; retry');
    }
    const complete = !state.damaged && offset === size && await this.operationSourceUnchanged(snapshot);
    if (complete) await this.model.settleRetained(source, generation);
    return { complete, scannedRecords };
  }

  async readModelImportProgress(signal?: AbortSignal): Promise<readonly { source: string; size: number; readBytes: number; complete: boolean }[]> {
    const sources = await Promise.all([RETAINED_USAGE_KEY, EPHEMERAL_USAGE_KEY, OPERATION_USAGE_KEY].map(async (key) => {
      signal?.throwIfAborted();
      const source = `retained-ledger:${key}`;
      const [size, generation, progress, mtimeMs] = await Promise.all([this.storage.size(this.storeScope, key), this.appendLog.generation(this.storeScope, key), this.model.progress(source, signal), key === OPERATION_USAGE_KEY ? this.storage.mtime(this.storeScope, key) : 0]);
      const state = progress?.parser as RetainedImportState | undefined;
      const current = key !== OPERATION_USAGE_KEY || !this.operationWritesPending && operationPrefixCurrent(progress?.parser as OperationImportState | undefined, { generation, size: size ?? 0, mtimeMs: mtimeMs ?? 0 });
      const readBytes = current && state?.generation === generation ? Math.min(size ?? 0, progress?.offset ?? 0) : 0;
      return { source, size: size ?? 0, readBytes, complete: current && state?.generation === generation && readBytes === size && state.current === undefined && !state.damaged };
    }));
    return sources.filter((row) => row.size > 0);
  }

  prepareReadModel(query: RetainedUsageListQuery, includeEphemeral = true): Promise<{ complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
    const next = this.importing.then(async () => {
      const deleted = await this.importLedger(RETAINED_USAGE_KEY, false, query);
      if (!deleted.complete) return deleted;
      const ephemeral = includeEphemeral ? await this.importLedger(EPHEMERAL_USAGE_KEY, true, { ...query, recordLimit: query.recordLimit - deleted.scannedRecords }) : { complete: true, scannedRecords: 0 };
      if (!ephemeral.complete) return { ...ephemeral, scannedRecords: deleted.scannedRecords + ephemeral.scannedRecords };
      const operations = await this.importOperations({ ...query, recordLimit: query.recordLimit - deleted.scannedRecords - ephemeral.scannedRecords });
      return { ...operations, scannedRecords: deleted.scannedRecords + ephemeral.scannedRecords + operations.scannedRecords };
    });
    this.importing = next.then(() => undefined, () => undefined);
    return next;
  }

  private async importLedger(key: string, ephemeral: boolean, query: RetainedUsageListQuery): Promise<{ complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
    query.signal?.throwIfAborted();
    await this.appendLog.flush(this.storeScope, key);
    const source = `retained-ledger:${key}`;
    const [storedSize, storedMtime, generation, progress] = await Promise.all([
      this.storage.size(this.storeScope, key), this.storage.mtime(this.storeScope, key),
      this.appendLog.generation(this.storeScope, key), this.model.progress(source, query.signal),
    ]);
    const size = storedSize ?? 0;
    const mtimeMs = storedMtime ?? 0;
    let expected = progress;
    let state = expected?.parser as RetainedImportState | undefined;
    if (state?.generation !== generation || (expected?.offset ?? 0) > size) { await this.model.abandon(source); expected = undefined; state = undefined; }
    state = structuredClone(state ?? { generation, damaged: false });
    let offset = expected?.offset ?? 0;
    let scannedRecords = 0;
    let records: UsageFact[] = [];
    let reset = false;
    const save = async (publish?: { source: string; session: UsageReadModelSession }): Promise<void> => {
      const progress: UsageImportProgress = { batchStart: expected?.batchStart ?? offset, offset, ordinal: state!.current?.observed ?? 0, parser: structuredClone(state) };
      const continuation = publish === undefined ? undefined : { batchStart: offset, offset, ordinal: 0, parser: { ...state, current: undefined } };
      if (!await this.model.apply({ source, expected, progress, records, reset, publish: publish === undefined ? undefined : { ...publish, start: 0, checkpoint: { generation, offset, size: offset, mtimeMs, boundaryHash: '', valid: state!.current?.valid === true && state!.current?.meta?.complete !== false }, journalSize: size }, continuation })) throw new Error('Retained Usage progress changed; retry');
      records = []; reset = false; expected = continuation ?? progress;
      if (publish !== undefined) state!.current = undefined;
    };
    const remaining = (): RetainedUsageIncompleteReason | undefined => Date.now() >= query.deadlineAt ? 'deadline' : scannedRecords >= query.recordLimit ? 'record_budget' : undefined;
    if (offset === size) {
      if (state.current === undefined && !state.damaged) await this.model.settleRetained(source, generation);
      return { complete: state.current === undefined && !state.damaged, scannedRecords };
    }
    let reason = remaining();
    if (reason !== undefined) return { complete: false, scannedRecords, incompleteReason: reason };
    for await (const raw of this.appendLog.read<unknown>(this.storeScope, key, { signal: query.signal, startOffset: offset, endOffset: size, chunkBytes: RETAINED_READ_CHUNK_BYTES, onPosition: (position) => { offset = position; }, onTruncate: () => { state!.damaged = true; } })) {
      query.signal?.throwIfAborted();
      const kind = raw !== null && typeof raw === 'object' ? (raw as { kind?: unknown }).kind : undefined;
      const start = ephemeral ? ephemeralUsageStartSchema.safeParse(raw) : retainedUsageLedgerStartSchema.safeParse(raw);
      if (start.success || kind === 'record' || kind === undefined) scannedRecords++;
      if (start.success) {
        if (state.current !== undefined) {
          const nextSource = ephemeral ? `retained:ephemeral:${(start.data as z.infer<typeof ephemeralUsageStartSchema>).sourceId}` : `retained:deleted:${(start.data as RetainedUsageLedgerStart).workspaceId}\0${(start.data as RetainedUsageLedgerStart).id}`;
          if (state.current.source !== nextSource) state.damaged = true;
        }
        records = []; reset = true;
        if (ephemeral) {
          const header = start.data as z.infer<typeof ephemeralUsageStartSchema>;
          state.current = { source: `retained:ephemeral:${header.sourceId}`, transactionId: header.sourceId, count: header.recordCount, observed: 0, valid: true };
        } else {
          const header = start.data as RetainedUsageLedgerStart;
          state.current = { source: `retained:deleted:${header.workspaceId}\0${header.id}`, count: header.recordCount, observed: 0, valid: true, header };
        }
      } else if (!ephemeral && kind === 'meta' && state.current !== undefined) {
        const meta = retainedUsageLedgerMetaSchema.safeParse(raw);
        if (meta.success) {
          state.current.meta = meta.data;
          state.current.session = { ...retainedDeletedSessionUsageHeaderSchema.parse(state.current.header), ...retainedDeletedSessionUsageMetaSchema.parse(meta.data) };
        } else state.current.valid = false;
      } else if (kind === 'record' && state.current !== undefined) {
        state.current.observed++;
        const parsed = ephemeral ? ephemeralUsageRecordSchema.safeParse(raw) : retainedUsageLedgerRecordSchema.safeParse(raw);
        if (parsed.success) {
          const record = parsed.data.record;
          records.push(record);
          if (ephemeral && 'workspaceId' in record) {
            const previous = state.current.session;
            if (previous !== undefined && previous.workspaceId !== record.workspaceId) state.current.valid = false;
            state.current.session = { id: state.current.source, workspaceId: record.workspaceId, createdAt: Math.min(previous?.createdAt ?? record.time, record.time), updatedAt: Math.max(previous?.updatedAt ?? record.time, record.time), archived: false, deleted: true, ephemeral: true };
          }
        } else state.current.valid = false;
      } else if (kind === 'commit' && state.current !== undefined) {
        const parsed = ephemeral ? ephemeralUsageCommitSchema.safeParse(raw) : retainedUsageLedgerCommitSchema.safeParse(raw);
        const current = state.current;
        const valid = parsed.success && (!ephemeral || 'sourceId' in parsed.data && parsed.data.sourceId === current.transactionId) && current.valid && current.observed === current.count && (current.session !== undefined || ephemeral && current.count === 0) && (ephemeral || current.meta !== undefined);
        if (valid && current.session !== undefined) await save({ source: current.source, session: current.session });
        else { state.damaged ||= !valid; state.current = undefined; records = []; reset = true; }
      } else if (ephemeral && state.current === undefined) {
        const legacy = ephemeralUsageSchema.safeParse(raw);
        if (legacy.success) {
          const value = legacy.data;
          state.current = { source: `retained:ephemeral:legacy:${generation}:${offset}`, count: 1, observed: 1, valid: true, session: { id: `retained:ephemeral:legacy:${generation}:${offset}`, workspaceId: value.workspaceId, createdAt: value.time, updatedAt: value.time, archived: false, deleted: true, ephemeral: true } };
          records.push(value);
          await save({ source: state.current.source, session: state.current.session! });
        } else state.damaged = true;
      } else { state.damaged = true; if (state.current !== undefined) state.current.valid = false; }
      reason = remaining();
      if (reason === 'record_budget' && (offset === size || state.current !== undefined && state.current.observed === state.current.count)) reason = undefined;
      if (records.length >= 256 || reason !== undefined) await save();
      if (reason !== undefined) return { complete: false, scannedRecords, incompleteReason: reason };
    }
    if (expected?.offset !== offset || records.length > 0 || reset
      || state.damaged !== (expected?.parser as RetainedImportState | undefined)?.damaged) await save();
    const stable = await this.appendLog.generation(this.storeScope, key) === generation;
    const complete = stable && offset === size && state.current === undefined && !state.damaged;
    if (complete) await this.model.settleRetained(source, generation);
    return { complete, scannedRecords };
  }

  async retainEphemeralUsage(sessionScope: string, workspaceId: string): Promise<void> {
    const sourceId = createHash('sha256').update(sessionScope).digest('hex');
    for await (const event of this.readEphemeralUsage()) {
      if (event.kind === 'commit' && event.sourceId === sourceId) return;
    }
    const { records } = await this.readSessionRecords(sessionScope);
    this.appendLog.append(this.storeScope, EPHEMERAL_USAGE_KEY, {
      kind: 'source', sourceId, recordCount: records.length,
    });
    for (const { time, model, usage, usageKnown } of records) {
      this.appendLog.append(this.storeScope, EPHEMERAL_USAGE_KEY, {
        kind: 'record', record: { workspaceId, time, model, usage, usageKnown },
      });
    }
    this.appendLog.append(this.storeScope, EPHEMERAL_USAGE_KEY, {
      kind: 'commit', sourceId,
    });
    await this.appendLog.flush(this.storeScope, EPHEMERAL_USAGE_KEY);
    this.events.publish(new UsageSettled({ payload: {} }));
  }

  listEphemeralUsage(query: RetainedUsageListQuery): Promise<{ items: readonly EphemeralUsageTotal[]; complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
    return readWithDeadline(query, (query) => this.readEphemeralTotals(query));
  }

  private async readEphemeralTotals(query: RetainedUsageListQuery): Promise<{ items: readonly EphemeralUsageTotal[]; complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
    const progress = await this.prepareReadModel(query);
    const items: EphemeralUsageTotal[] = [];
    for (const row of await this.model.retained(query.workspaceIds, query.signal)) {
      if (!row.session.ephemeral) continue;
      let offset: number | undefined = 0;
      do {
        const page = await this.model.read(row.source, undefined, offset, 1000, query.signal);
        for (const fact of page.records) items.push({ workspaceId: row.session.workspaceId, time: fact.time, model: fact.model, usage: fact.usage, usageKnown: fact.usageKnown });
        offset = page.nextOffset;
      } while (offset !== undefined);
    }
    return { ...progress, items };
  }

  async listEphemeralUsageLegacy(query: RetainedUsageListQuery): Promise<{
    readonly items: readonly EphemeralUsageTotal[];
    readonly complete: boolean;
    readonly scannedRecords: number;
    readonly incompleteReason?: RetainedUsageIncompleteReason;
  }> {
    const items: EphemeralUsageTotal[] = [];
    let complete = true;
    const workspaceIds = query.workspaceIds === undefined ? undefined : new Set(query.workspaceIds);
    for await (const event of this.readEphemeralUsage(query.signal, query.recordLimit, workspaceIds)) {
      if (Date.now() >= query.deadlineAt || query.signal?.aborted) return { items, complete: false, scannedRecords: items.length, incompleteReason: 'deadline' };
      if (event.kind === 'incomplete') {
        complete = false;
        if (event.reason !== undefined) return { items, complete, scannedRecords: items.length, incompleteReason: event.reason };
      }
      if (event.kind !== 'record') continue;
      if (workspaceIds !== undefined && !workspaceIds.has(event.record.workspaceId)) continue;
      if (items.length >= query.recordLimit) return { items, complete: false, scannedRecords: items.length, incompleteReason: 'record_budget' };
      items.push(event.record);
    }
    return { items, complete, scannedRecords: items.length };
  }

  async retainDeletedSession(summary: SessionSummary): Promise<RetainedDeletedSessionUsage> {
    const sessionsScope = this.bootstrap.scope('sessions');
    const sessionScope = `${sessionsScope}/${summary.workspaceId}/${summary.id}`;
    const metadata = await readSessionMetadataResult(this.documents, sessionsScope, summary.workspaceId, summary.id, this.log);
    const registry = z.object({ agents: z.record(z.string(), z.unknown()) }).safeParse(metadata.kind === 'found' ? metadata.meta : undefined);
    const expectedAgents = registry.success ? Object.keys(registry.data.agents) : undefined;
    const { records, complete } = await this.readSessionRecords(sessionScope, expectedAgents);
    const snapshot: RetainedDeletedSessionUsage = {
      version: RETAINED_USAGE_VERSION,
      ...summary,
      deleted: true,
      deletedAt: Date.now(),
      records,
      complete,
    };
    const {
      version,
      id,
      workspaceId,
      records: retainedRecords,
      ...meta
    } = snapshot;
    this.appendLog.append(this.storeScope, RETAINED_USAGE_KEY, {
      kind: 'session',
      version,
      id,
      workspaceId,
      recordCount: retainedRecords.length,
    });
    this.appendLog.append(this.storeScope, RETAINED_USAGE_KEY, { kind: 'meta', ...meta });
    for (const record of retainedRecords) {
      this.appendLog.append(this.storeScope, RETAINED_USAGE_KEY, { kind: 'record', record });
    }
    this.appendLog.append(this.storeScope, RETAINED_USAGE_KEY, { kind: 'commit' });
    await this.appendLog.flush(this.storeScope, RETAINED_USAGE_KEY);
    return snapshot;
  }

  async *readExportUsage(includeEphemeral: boolean, signal?: AbortSignal): AsyncGenerator<RetainedUsageExportEvent, { operationsComplete: boolean }> {
    let damaged = false;
    let current: { start: RetainedUsageLedgerStart; meta?: RetainedUsageLedgerMeta; records: RetainedUsageRecord[]; observed: number; valid: boolean } | undefined;
    for await (const raw of this.appendLog.read<unknown>(this.storeScope, RETAINED_USAGE_KEY, { signal, chunkBytes: RETAINED_READ_CHUNK_BYTES, onTruncate: () => { damaged = true; } })) {
      yield { kind: 'progress' };
      const kind = retainedUsageLedgerKindSchema.safeParse(raw);
      if (!kind.success) { damaged = true; if (current !== undefined) current.valid = false; continue; }
      if (kind.data.kind === 'session') {
        if (current !== undefined) damaged = true;
        const start = retainedUsageLedgerStartSchema.safeParse(raw);
        current = start.success ? { start: start.data, records: [], observed: 0, valid: true } : undefined;
        if (!start.success) damaged = true;
      } else if (current !== undefined && kind.data.kind === 'meta') {
        const meta = retainedUsageLedgerMetaSchema.safeParse(raw); if (meta.success) current.meta = meta.data; else current.valid = false;
      } else if (current !== undefined && kind.data.kind === 'record') {
        current.observed++; const record = retainedUsageLedgerRecordSchema.safeParse(raw);
        if (record.success) current.records.push(record.data.record); else current.valid = false;
      } else if (current !== undefined && kind.data.kind === 'commit') {
        const complete = retainedUsageLedgerCommitSchema.safeParse(raw).success && current.valid && current.meta !== undefined && current.observed === current.start.recordCount;
        if (complete) {
          const header = retainedDeletedSessionUsageHeaderSchema.parse(current.start); const meta = retainedDeletedSessionUsageMetaSchema.parse(current.meta);
          yield { kind: 'session', snapshot: { ...header, ...meta, records: current.records } };
        } else damaged = true;
        current = undefined;
      } else if (current !== undefined) current.valid = false;
    }
    if (current !== undefined) damaged = true;
    if (includeEphemeral) for await (const event of this.readEphemeralUsage(signal)) {
      if (event.kind === 'progress') yield event;
      else if (event.kind === 'record') yield { kind: 'ephemeral', record: event.record };
      else if (event.kind === 'incomplete') damaged = true;
    }
    const operations = await this.inspectOperationSource(Date.now() + 3000, signal);
    let position = 0;
    let operationDamaged = false;
    if (operations !== undefined && operations.size > 0) {
      for await (const raw of this.appendLog.read<unknown>(this.storeScope, OPERATION_USAGE_KEY, { signal, endOffset: operations.size, chunkBytes: RETAINED_READ_CHUNK_BYTES, onPosition: (end) => { position = end; }, onTruncate: () => { operationDamaged = true; } })) {
        yield { kind: 'progress' };
        const parsed = operationUsageSchema.safeParse(raw);
        if (parsed.success) yield { kind: 'operation', session: parsed.data.session, record: parsed.data.record, position };
        else operationDamaged = true;
      }
    }
    const operationsComplete = operations !== undefined && !operationDamaged && position === operations.size && await this.operationSourceUnchanged(operations);
    if (damaged || !operationsComplete) yield { kind: 'incomplete' };
    return { operationsComplete };
  }

  listDeletedSessions(query: RetainedUsageListQuery): Promise<RetainedUsageListResult> {
    return readWithDeadline(query, (query) => this.readDeletedSessions(query));
  }

  private async readDeletedSessions(query: RetainedUsageListQuery): Promise<RetainedUsageListResult> {
    const progress = await this.prepareReadModel(query, false);
    const items: RetainedDeletedSessionUsage[] = [];
    for (const row of await this.model.retained(query.workspaceIds, query.signal)) {
      if (row.session.ephemeral) continue;
      const records: RetainedUsageRecord[] = [];
      let offset: number | undefined = 0;
      do {
        const page = await this.model.read(row.source, undefined, offset, 1000, query.signal);
        records.push(...page.records);
        offset = page.nextOffset;
      } while (offset !== undefined);
      const head = await this.model.source(row.source, query.signal);
      items.push({ ...row.session, version: RETAINED_USAGE_VERSION, deleted: true, deletedAt: row.session.deletedAt ?? row.session.updatedAt, records, complete: row.session.complete !== false && head?.checkpoint?.valid === true });
    }
    return { ...progress, items };
  }

  async listDeletedSessionsLegacy(query: RetainedUsageListQuery): Promise<RetainedUsageListResult> {
    const workspaceIds =
      query.workspaceIds === undefined ? undefined : new Set(query.workspaceIds);
    const records = new Map<string, RetainedDeletedSessionUsage>();
    let scannedRecords = 0;
    let ledgerTruncated = false;
    let current:
      | {
          readonly start: RetainedUsageLedgerStart;
          meta: RetainedUsageLedgerMeta | undefined;
          readonly records: RetainedUsageRecord[];
          readonly included: boolean;
          observedRecordCount: number;
          valid: boolean;
        }
      | undefined;
    const result = (
      incompleteReason?: RetainedUsageIncompleteReason,
    ): RetainedUsageListResult => ({
      items: [...records.values()],
      complete: incompleteReason === undefined && !ledgerTruncated,
      incompleteReason,
      scannedRecords,
    });
    const expired = (): boolean => query.signal?.aborted === true || Date.now() >= query.deadlineAt;
    if (expired()) return result('deadline');
    const readController = new AbortController();
    const abortRead = (): void => readController.abort();
    query.signal?.addEventListener('abort', abortRead, { once: true });
    if (query.signal?.aborted === true) abortRead();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadline = (): void => {
      const remaining = query.deadlineAt - Date.now();
      if (remaining <= 0) {
        abortRead();
        return;
      }
      deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
    };
    scheduleDeadline();
    try {
      for await (const raw of this.appendLog.read<unknown>(
        this.storeScope,
        RETAINED_USAGE_KEY,
        {
          onTruncate: () => { ledgerTruncated = true; },
          signal: readController.signal,
          chunkBytes: RETAINED_READ_CHUNK_BYTES,
        },
      )) {
        if (expired()) {
          abortRead();
          return result('deadline');
        }
        const kind = retainedUsageLedgerKindSchema.safeParse(raw);
        if (!kind.success) {
          if (current !== undefined) current.valid = false;
          continue;
        }
        if (kind.data.kind === 'session') {
          if (current !== undefined) ledgerTruncated = true;
          const start = retainedUsageLedgerStartSchema.safeParse(raw);
          if (!start.success) {
            current = undefined;
            continue;
          }
          const included = workspaceIds === undefined || workspaceIds.has(start.data.workspaceId);
          if (included) {
            if (scannedRecords >= query.recordLimit) return result('record_budget');
            scannedRecords += 1;
            if (start.data.recordCount > query.recordLimit - scannedRecords) {
              return result('record_budget');
            }
          }
          current = {
            start: start.data,
            meta: undefined,
            records: [],
            included,
            observedRecordCount: 0,
            valid: true,
          };
          continue;
        }
        if (current === undefined) continue;
        if (kind.data.kind === 'meta') {
          const meta = retainedUsageLedgerMetaSchema.safeParse(raw);
          if (!meta.success) {
            current.valid = false;
            continue;
          }
          current.meta = meta.data;
          continue;
        }
        if (kind.data.kind === 'record') {
          if (current.included) {
            if (scannedRecords >= query.recordLimit) return result('record_budget');
            scannedRecords += 1;
          }
          current.observedRecordCount += 1;
          const record = retainedUsageLedgerRecordSchema.safeParse(raw);
          if (!record.success) {
            current.valid = false;
            continue;
          }
          if (current.included) current.records.push(record.data.record);
          continue;
        }
        if (kind.data.kind !== 'commit') {
          current.valid = false;
          continue;
        }
        const commit = retainedUsageLedgerCommitSchema.safeParse(raw);
        if (!commit.success) {
          current.valid = false;
          continue;
        }
        const transactionComplete =
          current.valid &&
          current.meta !== undefined &&
          current.observedRecordCount === current.start.recordCount;
        if (!transactionComplete) {
          ledgerTruncated = true;
        } else if (current.included) {
          const header = retainedDeletedSessionUsageHeaderSchema.parse(current.start);
          const meta = retainedDeletedSessionUsageMetaSchema.parse(current.meta);
          records.set(`${header.workspaceId}\0${header.id}`, {
            ...header,
            ...meta,
            records: current.records,
          });
        }
        current = undefined;
      }
      if (current !== undefined) ledgerTruncated = true;
      if (expired()) return result('deadline');
      return result();
    } catch (error) {
      if (readController.signal.aborted) return result('deadline');
      throw error;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      query.signal?.removeEventListener('abort', abortRead);
    }
  }

  private async *readEphemeralUsage(
    signal?: AbortSignal,
    recordLimit = Number.MAX_SAFE_INTEGER,
    workspaceIds?: ReadonlySet<string>,
  ): AsyncGenerator<EphemeralUsageEvent> {
    const committed = new Set<string>();
    const unfinished = new Set<string>();
    let damaged = false;
    let current: {
      start: z.infer<typeof ephemeralUsageStartSchema>;
      records: EphemeralUsageTotal[];
      observed: number;
      valid: boolean;
    } | undefined;
    for await (const raw of this.appendLog.read<unknown>(this.storeScope, EPHEMERAL_USAGE_KEY, {
      signal, chunkBytes: RETAINED_READ_CHUNK_BYTES, onTruncate: () => { damaged = true; },
    })) {
      yield { kind: 'progress' };
      const start = ephemeralUsageStartSchema.safeParse(raw);
      if (start.success) {
        if (current !== undefined && !committed.has(current.start.sourceId)) unfinished.add(current.start.sourceId);
        current = { start: start.data, records: [], observed: 0, valid: true };
        continue;
      }
      if (current !== undefined) {
        const record = ephemeralUsageRecordSchema.safeParse(raw);
        if (record.success) {
          current.observed++;
          if (!committed.has(current.start.sourceId) &&
            (workspaceIds === undefined || workspaceIds.has(record.data.record.workspaceId))) {
            if (current.records.length >= recordLimit) {
              yield { kind: 'incomplete', reason: 'record_budget' };
              return;
            }
            current.records.push(record.data.record);
          }
          continue;
        }
        const commit = ephemeralUsageCommitSchema.safeParse(raw);
        if (commit.success) {
          const sourceId = current.start.sourceId;
          if (commit.data.sourceId === sourceId && current.valid && current.observed === current.start.recordCount) {
            unfinished.delete(sourceId);
            if (!committed.has(sourceId)) {
              committed.add(sourceId);
              for (const record of current.records) yield { kind: 'record', record };
              yield { kind: 'commit', sourceId };
            }
          } else if (!committed.has(sourceId)) unfinished.add(sourceId);
          current = undefined;
          continue;
        }
        current.valid = false;
        continue;
      }
      const legacy = ephemeralUsageSchema.safeParse(raw);
      if (legacy.success) yield { kind: 'record', record: legacy.data };
      else damaged = true;
    }
    if (current !== undefined && !committed.has(current.start.sourceId)) unfinished.add(current.start.sourceId);
    if (damaged || unfinished.size > 0) yield { kind: 'incomplete' };
  }

  private get storeScope(): string {
    return this.bootstrap.scope(RETAINED_USAGE_SCOPE);
  }

  private async readSessionRecords(
    sessionScope: string,
    expectedAgents?: readonly string[],
  ): Promise<{ readonly records: readonly RetainedUsageRecord[]; readonly complete: boolean }> {
    const agentIds = await this.storage.list(`${sessionScope}/agents`);
    const records: RetainedUsageRecord[] = [];
    let complete = expectedAgents === undefined ? agentIds.length > 0 : expectedAgents.every((id) => agentIds.includes(id));
    for (const agentId of agentIds) {
      let hasRecords = false;
      let truncated = false;
      try {
        for await (const raw of this.appendLog.read<WireRecord>(
          `${sessionScope}/agents/${agentId}`,
          AGENT_WIRE_RECORD_KEY,
          { onTruncate: () => { truncated = true; } },
        )) {
          hasRecords = true;
          if (raw.type !== 'usage.record') continue;
          const parsed = retainedUsageRecordSchema.safeParse(raw);
          if (!parsed.success) {
            complete = false;
            continue;
          }
          records.push(parsed.data);
        }
      } catch {
        complete = false;
      }
      if (!hasRecords || truncated) complete = false;
    }
    return { records, complete };
  }
}

async function readWithDeadline<T>(query: RetainedUsageListQuery, read: (query: RetainedUsageListQuery) => Promise<{ items: readonly T[]; complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }>): Promise<{ items: readonly T[]; complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
  const expired = { items: [], complete: false, scannedRecords: 0, incompleteReason: 'deadline' as const };
  if (query.signal?.aborted || Date.now() >= query.deadlineAt) return expired;
  const controller = new AbortController();
  const signal = query.signal === undefined ? controller.signal : AbortSignal.any([query.signal, controller.signal]);
  const remaining = query.deadlineAt - Date.now();
  const timer = remaining <= 2_147_483_647 ? setTimeout(() => controller.abort(new DOMException('Retained Usage deadline', 'TimeoutError')), remaining) : undefined;
  timer?.unref();
  let abort!: () => void;
  const aborted = new Promise<typeof expired>((resolve) => { abort = () => resolve(expired); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([read({ ...query, signal }), aborted]); }
  finally { signal.removeEventListener('abort', abort); if (timer !== undefined) clearTimeout(timer); }
}

function operationPrefixCurrent(prior: OperationImportState | undefined, current: OperationSourceSnapshot): prior is OperationImportState {
  return prior !== undefined && typeof prior.publicationGeneration === 'string' && typeof prior.boundaryHash === 'string'
    && prior.generation === current.generation && current.size >= prior.size
    && (current.size > prior.size || current.mtimeMs === prior.mtimeMs);
}

registerScopedService(
  LifecycleScope.App,
  IRetainedUsageService,
  RetainedUsageService,
  ScopeActivation.OnDemand,
  'retainedUsage',
);

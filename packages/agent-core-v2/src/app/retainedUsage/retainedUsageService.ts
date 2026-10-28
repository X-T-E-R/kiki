import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { UsageSettled } from '#/agent/usage/usageEvents';
import { usageFactTotalsSchema, type UsageFact } from '#/agent/usage/usageFact';
import { IUsageReadModel, type UsageImportProgress, type UsageReadModelSession } from '#/persistence/interface/usageReadModel';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  IRetainedUsageService,
  RETAINED_USAGE_VERSION,
  type EphemeralUsageTotal,
  type RetainedDeletedSessionUsage,
  type RetainedUsageIncompleteReason,
  type RetainedUsageListQuery,
  type RetainedUsageListResult,
  type RetainedUsageRecord,
  type RetainedUsageExportEvent,
} from './retainedUsage';

const RETAINED_USAGE_KEY = 'deleted-sessions-v2.jsonl';
const EPHEMERAL_USAGE_KEY = 'ephemeral-totals-v1.jsonl';
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

export class RetainedUsageService implements IRetainedUsageService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @IEventService private readonly events: IEventService,
    @IUsageReadModel private readonly model: IUsageReadModel,
  ) {}

  private importing = Promise.resolve();

  prepareReadModel(query: RetainedUsageListQuery, includeEphemeral = true): Promise<{ complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
    const next = this.importing.then(async () => {
      const deleted = await this.importLedger(RETAINED_USAGE_KEY, false, query);
      if (!deleted.complete || !includeEphemeral) return deleted;
      const ephemeral = await this.importLedger(EPHEMERAL_USAGE_KEY, true, { ...query, recordLimit: query.recordLimit - deleted.scannedRecords });
      return { ...ephemeral, scannedRecords: deleted.scannedRecords + ephemeral.scannedRecords };
    });
    this.importing = next.then(() => undefined, () => undefined);
    return next;
  }

  private async importLedger(key: string, ephemeral: boolean, query: RetainedUsageListQuery): Promise<{ complete: boolean; scannedRecords: number; incompleteReason?: RetainedUsageIncompleteReason }> {
    query.signal?.throwIfAborted();
    await this.appendLog.flush(this.storeScope, key);
    const size = await this.storage.size(this.storeScope, key) ?? 0;
    const mtimeMs = await this.storage.mtime(this.storeScope, key) ?? 0;
    const generation = await this.appendLog.generation(this.storeScope, key);
    const source = `retained-ledger:${key}`;
    let expected = await this.model.progress(source, query.signal);
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
    await save();
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
    await this.appendLog.flush();
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
    const sessionScope = `${this.bootstrap.scope('sessions')}/${summary.workspaceId}/${summary.id}`;
    const { records, complete } = await this.readSessionRecords(sessionScope);
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
    await this.appendLog.flush();
    return snapshot;
  }

  async *readExportUsage(includeEphemeral: boolean, signal?: AbortSignal): AsyncGenerator<RetainedUsageExportEvent> {
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
    if (damaged) yield { kind: 'incomplete' };
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
    return this.bootstrap.scope('store');
  }

  private async readSessionRecords(
    sessionScope: string,
  ): Promise<{ readonly records: readonly RetainedUsageRecord[]; readonly complete: boolean }> {
    const agentIds = await this.storage.list(`${sessionScope}/agents`);
    const records: RetainedUsageRecord[] = [];
    let complete = agentIds.length > 0;
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

registerScopedService(
  LifecycleScope.App,
  IRetainedUsageService,
  RetainedUsageService,
  ScopeActivation.OnDemand,
  'retainedUsage',
);

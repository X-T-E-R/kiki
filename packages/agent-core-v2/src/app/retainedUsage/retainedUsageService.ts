import { z } from 'zod';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  IRetainedUsageService,
  RETAINED_USAGE_VERSION,
  type RetainedDeletedSessionUsage,
  type RetainedUsageIncompleteReason,
  type RetainedUsageListQuery,
  type RetainedUsageListResult,
  type RetainedUsageRecord,
} from './retainedUsage';

const RETAINED_USAGE_KEY = 'deleted-sessions-v2.jsonl';

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
});

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

export class RetainedUsageService implements IRetainedUsageService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
  ) {}

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

  async listDeletedSessions(query: RetainedUsageListQuery): Promise<RetainedUsageListResult> {
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

registerScopedService(
  LifecycleScope.App,
  IRetainedUsageService,
  RetainedUsageService,
  ScopeActivation.OnDemand,
  'retainedUsage',
);

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

const RETAINED_USAGE_KEY = 'deleted-sessions-v1.jsonl';

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

const retainedDeletedSessionUsageMetaSchema = retainedDeletedSessionUsageHeaderSchema.extend({
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
    this.appendLog.append(this.storeScope, RETAINED_USAGE_KEY, snapshot);
    await this.appendLog.flush();
    return snapshot;
  }

  async listDeletedSessions(query: RetainedUsageListQuery): Promise<RetainedUsageListResult> {
    const workspaceIds =
      query.workspaceIds === undefined ? undefined : new Set(query.workspaceIds);
    const records = new Map<string, RetainedDeletedSessionUsage>();
    let scannedRecords = 0;
    let ledgerTruncated = false;
    const result = (
      incompleteReason?: RetainedUsageIncompleteReason,
    ): RetainedUsageListResult => ({
      items: [...records.values()],
      complete: incompleteReason === undefined && !ledgerTruncated,
      incompleteReason,
      scannedRecords,
    });
    if (query.signal?.aborted || Date.now() >= query.deadlineAt) return result('deadline');
    for await (const raw of this.appendLog.read<unknown>(
      this.storeScope,
      RETAINED_USAGE_KEY,
      { onTruncate: () => { ledgerTruncated = true; } },
    )) {
      if (query.signal?.aborted || Date.now() >= query.deadlineAt) return result('deadline');
      const header = retainedDeletedSessionUsageHeaderSchema.safeParse(raw);
      if (!header.success) continue;
      if (workspaceIds !== undefined && !workspaceIds.has(header.data.workspaceId)) continue;
      if (scannedRecords >= query.recordLimit) return result('record_budget');
      scannedRecords += 1;
      const meta = retainedDeletedSessionUsageMetaSchema.safeParse(raw);
      if (!meta.success) continue;
      const rawRecords = (raw as Record<string, unknown>)['records'];
      if (!Array.isArray(rawRecords)) continue;
      const parsedRecords: RetainedUsageRecord[] = [];
      let valid = true;
      for (const rawRecord of rawRecords) {
        if (query.signal?.aborted || Date.now() >= query.deadlineAt) {
          return result('deadline');
        }
        if (scannedRecords >= query.recordLimit) return result('record_budget');
        scannedRecords += 1;
        const parsed = retainedUsageRecordSchema.safeParse(rawRecord);
        if (!parsed.success) {
          valid = false;
          break;
        }
        parsedRecords.push(parsed.data);
      }
      if (!valid) continue;
      records.set(`${meta.data.workspaceId}\0${meta.data.id}`, {
        ...meta.data,
        records: parsedRecords,
      });
    }
    if (query.signal?.aborted || Date.now() >= query.deadlineAt) return result('deadline');
    return result();
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

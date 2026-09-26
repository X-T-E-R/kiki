import { createHash } from 'node:crypto';
import { join } from 'pathe';

import { BugIndicatingError } from '#/errors';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { AgentTaskInfo, AgentTaskReceipt, AgentTaskStatus } from './types';

const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

const TASKS_SCOPE = 'tasks';
const OUTPUT_LOG_KEY = 'output.log';
const JSON_SUFFIX = '.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type PersistedTask = AgentTaskInfo;

type DiskPersistedTask = PersistedTask | LegacyPersistedTask;

export interface AgentTaskPersistenceRoot {
  readonly dir: string;
  readonly scope: string;
}

export interface AgentTaskStoredOutputSnapshot {
  readonly outputPath: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly preview: string;
}

interface ListedTask {
  readonly keyId: string;
  readonly task: PersistedTask;
}

interface TaskOutputData {
  readonly root: AgentTaskPersistenceRoot;
  readonly data: Uint8Array;
}

function validateTaskId(taskId: string): void {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new BugIndicatingError(`Invalid task id: "${taskId}"`);
  }
}

export class AgentTaskPersistence {
  constructor(
    private readonly agentDir: string,
    private readonly agentScope: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly bytes: IFileSystemStorageService,
    private readonly fallbackRoot?: AgentTaskPersistenceRoot,
  ) {}

  private primaryRoot(): AgentTaskPersistenceRoot {
    return { dir: this.agentDir, scope: this.agentScope };
  }

  private tasksScope(root: AgentTaskPersistenceRoot = this.primaryRoot()): string {
    return `${root.scope}/${TASKS_SCOPE}`;
  }

  private taskOutputScope(
    taskId: string,
    root: AgentTaskPersistenceRoot = this.primaryRoot(),
  ): string {
    validateTaskId(taskId);
    return `${root.scope}/${TASKS_SCOPE}/${taskId}`;
  }

  private taskOutputFileAt(taskId: string, root: AgentTaskPersistenceRoot): string {
    validateTaskId(taskId);
    return join(root.dir, TASKS_SCOPE, taskId, OUTPUT_LOG_KEY);
  }

  taskOutputFile(taskId: string): string {
    return this.taskOutputFileAt(taskId, this.primaryRoot());
  }

  async writeTask(task: PersistedTask): Promise<void> {
    validateTaskId(task.taskId);
    await this.docs.set(this.tasksScope(), `${task.taskId}${JSON_SUFFIX}`, task);
  }

  async commitTerminalTask(task: PersistedTask, finalOutput?: string): Promise<AgentTaskReceipt> {
    const scope = this.taskOutputScope(task.taskId);
    if (finalOutput !== undefined) {
      await this.bytes.write(scope, OUTPUT_LOG_KEY, textEncoder.encode(finalOutput), { atomic: true });
    }
    let data = await this.bytes.read(scope, OUTPUT_LOG_KEY);
    if (data === undefined) {
      await this.bytes.write(scope, OUTPUT_LOG_KEY, new Uint8Array(), { atomic: true });
      data = await this.bytes.read(scope, OUTPUT_LOG_KEY);
      if (data === undefined) throw new Error('Task output was not persisted');
    }
    const receipt: AgentTaskReceipt = {
      schemaVersion: 1,
      path: `${TASKS_SCOPE}/${task.taskId}/${OUTPUT_LOG_KEY}`,
      mediaType: 'text/plain; charset=utf-8',
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      contentState: task.kind === 'agent' && (task.status !== 'completed' || finalOutput === undefined)
        ? 'unavailable' : 'final',
      committedAt: new Date().toISOString(),
      sourceTurnId: task.ownerTurnId,
    };
    await this.writeTask({ ...task, receipt, receiptVerification: 'verified' });
    return receipt;
  }

  async deleteTask(taskId: string): Promise<void> {
    validateTaskId(taskId);
    await Promise.all([
      this.docs.delete(this.tasksScope(), `${taskId}${JSON_SUFFIX}`),
      this.bytes.delete(this.taskOutputScope(taskId), OUTPUT_LOG_KEY),
    ]);
  }

  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    validateTaskId(taskId);
    const key = `${taskId}${JSON_SUFFIX}`;
    const task = await this.docs.get<DiskPersistedTask>(this.tasksScope(), key);
    if (task !== undefined) {
      return isReadablePersistedTask(task)
        ? this.verifyReceipt(normalizePersistedTask(task), this.primaryRoot()) : undefined;
    }
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.docs.get<DiskPersistedTask>(this.tasksScope(fallbackRoot), key);
    if (fallback === undefined || !isReadablePersistedTask(fallback)) return undefined;
    return this.verifyReceipt(normalizePersistedTask(fallback), fallbackRoot);
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    if (chunk.length === 0) return;
    await this.bytes.append(this.taskOutputScope(taskId), OUTPUT_LOG_KEY, textEncoder.encode(chunk));
  }

  async taskOutputSizeBytes(taskId: string): Promise<number> {
    const output = await this.readTaskOutputData(taskId);
    return output?.data.byteLength ?? 0;
  }

  async taskOutputExists(taskId: string): Promise<boolean> {
    return (await this.readTaskOutputData(taskId)) !== undefined;
  }

  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    const output = await this.readTaskOutputData(taskId);
    if (output === undefined || start >= output.data.byteLength) return '';
    const end = Math.min(output.data.byteLength, start + limit);
    return textDecoder.decode(output.data.subarray(start, end));
  }

  async readTaskOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskStoredOutputSnapshot | undefined> {
    const roots = [this.primaryRoot(), this.fallbackRoot];
    for (const root of roots) {
      if (root === undefined) continue;
      const scope = this.taskOutputScope(taskId, root);
      const size = await this.bytes.size(scope, OUTPUT_LOG_KEY);
      if (size === undefined) continue;
      const limit = Math.min(size, Math.max(0, Math.trunc(maxPreviewBytes)));
      const data = new Uint8Array(limit);
      let length = 0;
      if (limit > 0) {
        for await (const chunk of this.bytes.readStream(scope, OUTPUT_LOG_KEY, { start: size - limit, end: size - 1 })) {
          const retained = chunk.subarray(0, limit - length);
          data.set(retained, length);
          length += retained.byteLength;
          if (length === limit) break;
        }
      }
      let start = 0;
      if (size > limit) {
        while (start < length && (data[start]! & 0xc0) === 0x80) start++;
      }
      const preview = textDecoder.decode(data.subarray(start, length));
      const previewBytes = textEncoder.encode(preview).byteLength;
      return {
        outputPath: this.taskOutputFileAt(taskId, root),
        outputSizeBytes: size,
        previewBytes,
        truncated: size > previewBytes,
        preview,
      };
    }
    return undefined;
  }

  async listTasks(): Promise<readonly PersistedTask[]> {
    const primary = await this.listTasksAt(this.primaryRoot());
    const tasks = [...primary.tasks];
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot !== undefined) {
      const fallback = await this.listTasksAt(fallbackRoot);
      for (const entry of fallback.tasks) {
        if (!primary.reservedIds.has(entry.keyId)) tasks.push(entry);
      }
    }
    return tasks.map((entry) => entry.task).toSorted((a, b) => a.taskId.localeCompare(b.taskId));
  }

  private async listTasksAt(root: AgentTaskPersistenceRoot): Promise<{
    readonly reservedIds: ReadonlySet<string>;
    readonly tasks: readonly ListedTask[];
  }> {
    const keys = (await this.docs.list(this.tasksScope(root))).toSorted();
    const reservedIds = new Set<string>();
    const tasks: ListedTask[] = [];
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!VALID_TASK_ID.test(id)) continue;
      reservedIds.add(id);
      let task: DiskPersistedTask | undefined;
      try {
        task = await this.docs.get<DiskPersistedTask>(this.tasksScope(root), key);
      } catch {
        continue;
      }
      if (task === undefined || !isReadablePersistedTask(task)) continue;
      tasks.push({ keyId: id, task: await this.verifyReceipt(normalizePersistedTask(task), root) });
    }
    return { reservedIds, tasks };
  }

  private async verifyReceipt(task: PersistedTask, root: AgentTaskPersistenceRoot): Promise<PersistedTask> {
    if (task.endedAt === null) return task;
    const receipt = task.receipt;
    if (receipt === undefined) {
      return { ...task, receiptVerification: task.receiptVerification === 'invalid' ? 'invalid' : 'legacy_unverified' };
    }
    if (!isRecord(receipt) || receipt.schemaVersion !== 1 ||
        receipt.path !== `${TASKS_SCOPE}/${task.taskId}/${OUTPUT_LOG_KEY}` ||
        receipt.mediaType !== 'text/plain; charset=utf-8' ||
        !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 ||
        typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
        (receipt.contentState !== 'final' && receipt.contentState !== 'unavailable') ||
        typeof receipt.committedAt !== 'string') {
      return { ...task, receipt: undefined, receiptVerification: 'invalid' };
    }
    try {
      const scope = this.taskOutputScope(task.taskId, root);
      if (await this.bytes.size(scope, OUTPUT_LOG_KEY) !== receipt.bytes) {
        return { ...task, receipt: undefined, receiptVerification: 'invalid' };
      }
      const hash = createHash('sha256');
      let total = 0;
      for await (const chunk of this.bytes.readStream(scope, OUTPUT_LOG_KEY)) {
        total += chunk.byteLength;
        if (total > receipt.bytes) break;
        hash.update(chunk);
      }
      if (total === receipt.bytes && hash.digest('hex') === receipt.sha256) {
        return { ...task, receiptVerification: 'verified' };
      }
    } catch {}
    return { ...task, receipt: undefined, receiptVerification: 'invalid' };
  }

  private async readTaskOutputData(taskId: string): Promise<TaskOutputData | undefined> {
    const primaryRoot = this.primaryRoot();
    const primary = await this.bytes.read(this.taskOutputScope(taskId, primaryRoot), OUTPUT_LOG_KEY);
    if (primary !== undefined) return { root: primaryRoot, data: primary };
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.bytes.read(
      this.taskOutputScope(taskId, fallbackRoot),
      OUTPUT_LOG_KEY,
    );
    return fallback === undefined ? undefined : { root: fallbackRoot, data: fallback };
  }
}

function normalizePersistedTask(task: DiskPersistedTask): PersistedTask {
  if (isLegacyPersistedTask(task)) return legacyPersistedTaskToInfo(task);
  const live = {
    ...task,
    detached: task.detached ?? true,
  };
  if (live.kind !== 'agent') return live;
  const record = live as Extract<PersistedTask, { kind: 'agent' }> & {
    readonly subagentType?: string;
  };
  const profile = record.profile ?? optionalNonEmptyString(record.subagentType);
  return {
    taskId: record.taskId,
    description: record.description,
    status: record.status,
    detached: record.detached,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    stopReason: record.stopReason,
    terminalNotificationSuppressed: record.terminalNotificationSuppressed,
    timeoutMs: record.timeoutMs,
    lifetime: record.lifetime,
    ownerAgentId: record.ownerAgentId,
    ownerTurnId: record.ownerTurnId,
    goalId: record.goalId,
    receipt: record.receipt,
    receiptVerification: record.receiptVerification,
    kind: 'agent',
    agentId: record.agentId,
    profile,
    parentToolCallId: record.parentToolCallId,
    model: record.model,
    thinkingEffort: record.thinkingEffort,
    collaborationTaskName: record.collaborationTaskName,
    collaborationAgentType: record.collaborationAgentType,
  };
}

type LegacyAgentTaskStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

interface LegacyPersistedTask {
  readonly task_id: string;
  readonly command: string;
  readonly description: string;
  readonly pid: number;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly exit_code: number | null;
  readonly status: LegacyAgentTaskStatus;
  readonly timed_out?: boolean;
  readonly stop_reason?: string;
  readonly timeout_ms?: number;
  readonly agent_id?: string;
  readonly subagent_type?: string;
}

function legacyPersistedTaskToInfo(task: LegacyPersistedTask): PersistedTask {
  const status = legacyStatusToCurrent(task);
  const stopReason = optionalNonEmptyString(task.stop_reason);
  const timeoutMs = typeof task.timeout_ms === 'number' ? task.timeout_ms : undefined;
  const base = {
    taskId: task.task_id,
    description: task.description,
    status,
    detached: true,
    startedAt: task.started_at,
    endedAt: task.ended_at,
    stopReason,
    timeoutMs,
  };

  if (task.task_id.startsWith('agent-')) {
    return {
      ...base,
      kind: 'agent',
      agentId: optionalNonEmptyString(task.agent_id),
      profile: optionalNonEmptyString(task.subagent_type),
    };
  }

  return {
    ...base,
    kind: 'process',
    command: task.command,
    pid: task.pid,
    exitCode: task.exit_code,
  };
}

function legacyStatusToCurrent(task: LegacyPersistedTask): AgentTaskStatus {
  if (task.status === 'awaiting_approval') return 'running';
  if (task.status === 'failed' && task.timed_out === true) return 'timed_out';
  return task.status;
}

function isReadablePersistedTask(obj: unknown): obj is DiskPersistedTask {
  return (
    isRecord(obj) &&
    (typeof obj['taskId'] === 'string' || typeof obj['task_id'] === 'string')
  );
}

function isLegacyPersistedTask(task: DiskPersistedTask): task is LegacyPersistedTask {
  return 'task_id' in task;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

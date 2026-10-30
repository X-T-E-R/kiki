import { createHash } from 'node:crypto';

import type { ModelSwitchInput } from '#/agent/modelSwitch/modelSwitch';
import { Error2, ErrorCodes } from '#/errors';
import type { AgentMeta, ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { AgentRunRequest } from '#/session/subagent/subagent';
import type { DispatchRunOptions } from './dispatch';

export interface DispatchResumeRecord {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly request: AgentRunRequest;
  readonly switchInput: ModelSwitchInput;
  readonly toolOverride?: import('#/agent/profile/profile').ToolBindingOverride;
  readonly state: 'accepted' | 'ready' | 'started';
  readonly turnId?: number;
  readonly taskId?: string;
  readonly createdAt?: number;
  readonly retentionVersion?: 1;
  readonly outcome?: { readonly taskId: string; readonly completedAt: number };
}

export function resumeFingerprint(request: AgentRunRequest, options: DispatchRunOptions): string {
  return createHash('sha256').update(JSON.stringify({
    request,
    requesterAgentId: options.requesterAgentId,
    bindingOverride: {
      modelAlias: options.bindingOverride?.modelAlias,
      thinkingEffort: options.bindingOverride?.thinkingEffort,
      allowModelChange: options.bindingOverride?.allowModelChange,
      newWindow: options.bindingOverride?.newWindow,
    },
    allowParentNotify: options.allowParentNotify,
    tools: options.toolOverride?.tools,
    disallowedTools: options.toolOverride?.disallowedTools,
  })).digest('hex');
}

function label(operationId: string): string {
  return `dispatchResume:${operationId}`;
}

export function readResumeRecord(meta: AgentMeta | undefined, operationId: string): DispatchResumeRecord | undefined {
  const raw = meta?.labels?.[label(operationId)];
  if (raw === undefined) return undefined;
  let record: DispatchResumeRecord;
  try {
    record = JSON.parse(raw) as DispatchResumeRecord;
  } catch (cause) {
    throw new Error2(ErrorCodes.STORAGE_DECODE_FAILED, 'The saved resume operation could not be read.', { cause });
  }
  if (record.operationId !== operationId || typeof record.fingerprint !== 'string' || record.request === undefined
    || record.switchInput?.operationId !== operationId || !['accepted', 'ready', 'started'].includes(record.state)) {
    throw new Error2(ErrorCodes.STORAGE_DECODE_FAILED, 'The saved resume operation is inconsistent.');
  }
  return record;
}

export function assertResumeFingerprint(previous: string, fingerprint: string): void {
  if (previous !== fingerprint) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'This resume operationId already belongs to a different request or binding. Use the original request to recover it.');
  }
}

export async function writeResumeRecord(metadata: ISessionMetadata, agentId: string, record: DispatchResumeRecord): Promise<void> {
  let updated = false;
  await metadata.updateAgent(agentId, (meta) => {
    const previous = readResumeRecord(meta, record.operationId);
    if (previous !== undefined) assertResumeFingerprint(previous.fingerprint, record.fingerprint);
    const states = ['accepted', 'ready', 'started'] as const;
    const merged = { ...record, taskId: record.taskId ?? previous?.taskId, turnId: record.turnId ?? previous?.turnId,
      createdAt: previous?.createdAt ?? record.createdAt ?? (previous === undefined ? Date.now() : undefined),
      retentionVersion: previous === undefined ? 1 : previous.retentionVersion,
      outcome: previous?.outcome ?? record.outcome,
      state: previous !== undefined && states.indexOf(previous.state) > states.indexOf(record.state) ? previous.state : record.state };
    updated = true;
    return { ...meta, labels: { ...meta.labels, [label(record.operationId)]: JSON.stringify(merged) } };
  });
  if (!updated) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${agentId}" has no durable metadata.`);
}

function resumeEntries(meta: AgentMeta): Array<{ key: string; record: DispatchResumeRecord }> {
  const entries: Array<{ key: string; record: DispatchResumeRecord }> = [];
  for (const key of Object.keys(meta.labels ?? {})) {
    if (!key.startsWith('dispatchResume:')) continue;
    try {
      const record = readResumeRecord(meta, key.slice('dispatchResume:'.length));
      if (record !== undefined) entries.push({ key, record });
    } catch {}
  }
  return entries;
}

/** Binds only the named accepted resume operation to its registered task. */
export function bindResumeTask(meta: AgentMeta, operationId: string | undefined, taskId: string): AgentMeta {
  if (operationId === undefined) return meta;
  const record = readResumeRecord(meta, operationId);
  if (record === undefined) return meta;
  return { ...meta, labels: { ...meta.labels, [label(operationId)]: JSON.stringify({ ...record, taskId }) } };
}

/** Commits task/outcome correspondence in the same atomic metadata document as the outcome. */
export function acknowledgeResumeOutcome(meta: AgentMeta, taskId: string | undefined, completedAt: number): AgentMeta {
  if (taskId === undefined) return meta;
  let labels: Record<string, string> | undefined;
  for (const { key, record } of resumeEntries(meta)) {
    if (record.state !== 'started' || record.taskId !== taskId) continue;
    labels ??= { ...meta.labels };
    labels[key] = JSON.stringify({ ...record, outcome: { taskId, completedAt } });
  }
  return labels === undefined ? meta : { ...meta, labels };
}

/** Keeps the newest 32 operations and every operation from the last seven days. Legacy records require a current quiescence proof. */
export function pruneResumeRecords(meta: AgentMeta, quiescent: boolean, now = Date.now()): AgentMeta {
  const entries = resumeEntries(meta);
  if (entries.length <= 32) return meta;
  entries.sort((a, b) => (a.record.createdAt ?? 0) - (b.record.createdAt ?? 0));
  const recent = new Set(entries.slice(-32).map(({ key }) => key));
  let labels: Record<string, string> | undefined;
  for (const { key, record } of entries) {
    if (recent.has(key) || record.state !== 'started') continue;
    const timestamp = record.createdAt ?? record.outcome?.completedAt;
    if (timestamp !== undefined && (!Number.isFinite(timestamp) || timestamp > now - 7 * 24 * 60 * 60_000)) continue;
    const proven = typeof record.taskId === 'string' && record.taskId.length > 0
      && record.outcome?.taskId === record.taskId && Number.isFinite(record.outcome.completedAt);
    if (!proven && (record.retentionVersion === 1 || !quiescent)) continue;
    labels ??= { ...meta.labels };
    delete labels[key];
  }
  return labels === undefined ? meta : { ...meta, labels };
}

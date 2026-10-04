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
      state: previous !== undefined && states.indexOf(previous.state) > states.indexOf(record.state) ? previous.state : record.state };
    updated = true;
    return { ...meta, labels: { ...meta.labels, [label(record.operationId)]: JSON.stringify(merged) } };
  });
  if (!updated) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${agentId}" has no durable metadata.`);
}

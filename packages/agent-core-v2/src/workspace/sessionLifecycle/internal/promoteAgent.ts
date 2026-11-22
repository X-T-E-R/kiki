import { TERMINAL_STATUSES, type AgentTaskStatus } from '#/agent/task/types';
import { subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { WireRecord } from '#/wire/record';
import { event2FromRecord } from '#/app/event/event2';
import { agentExecutorBindingFingerprint } from '#/app/agentExecutor/agentExecutor';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import { ExecutorSessionUpdated } from '#/agent/execution/externalExecutorOps';

/** Descendant subagent or branch captured from the promoted root subagent's subtree. */
export interface PromotedDescendantSource {
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly agentMeta: AgentMeta;
  readonly records: readonly WireRecord[];
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly wasOpen?: boolean;
}

/** What the source workspace hands the target workspace when a subagent becomes its own thread. */
export interface PromotionSource {
  readonly sourceSessionId: string;
  readonly private?: boolean;
  readonly agentId: string;
  readonly agentMeta: AgentMeta;
  readonly records: readonly WireRecord[];
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly descendants?: readonly PromotedDescendantSource[];
  readonly sourceSessionScope: string;
  readonly sourceSessionDir: string;
  readonly sourceMediaDirs: readonly string[];
  readonly sourceTitle?: string;
  readonly sessionCwd: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
}

export interface SettledAgentRecords {
  readonly records: readonly WireRecord[];
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly wasOpen?: boolean;
}

export interface PromotedTaskDocument {
  readonly info: Record<string, unknown>;
  readonly output?: Uint8Array;
}

export interface PromotedAgentOutcome {
  readonly taskId?: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly completedAt: number;
  readonly resultSummary?: string;
  readonly error?: string;
}

export interface SettledPromotedWire {
  readonly records: readonly WireRecord[];
  readonly tasks: ReadonlyMap<string, PromotedTaskDocument>;
  readonly agentOutcomes: ReadonlyMap<string, PromotedAgentOutcome>;
  readonly settleTime: number;
}

export interface RetargetedRecords {
  readonly records: readonly WireRecord[];
  readonly foreignBlobs: readonly { readonly agentId: string; readonly hash: string }[];
  readonly fileIds: ReadonlySet<string>;
}

const MAIN_DROPPED_TYPES: ReadonlySet<string> = new Set([
  'forked',
  'runtime.set_binding',
  'profile.bind',
  'profile.dynamic_snapshot',
  'config.update',
  'tools.set_active_tools',
  'tools.reset_active_tools',
  'tools.policy_refreshed',
  'permission.set_mode',
  'agent.branch_sealed',
  'agent.branch_turn_merged',
  'agent.tool_lock_changed',
  'branch.base',
  'turn.cancel',
  'subagent.autonomous_receipt_delivered',
]);

const DESCENDANT_DROPPED_TYPES: ReadonlySet<string> = new Set([
  'forked',
  'turn.cancel',
]);

const DROPPED_PREFIXES: readonly string[] = [
  'prompt.',
  'cron.',
  'interaction.',
  'permission.approval.',
];

const BLOBREF_PATTERN = /blobref:([A-Za-z0-9][A-Za-z0-9_-]{0,255})[/:]([0-9a-f]{64})/gu;
const FILE_ID_PATTERN = /\bf_[A-Za-z0-9][A-Za-z0-9_-]*/gu;

/** Collects all transitive child subagents and branches owned by `rootAgentId`, reparenting direct children to `main`. */
export function collectPromotedDescendantIds(
  agents: Readonly<Record<string, AgentMeta>> | undefined,
  rootAgentId: string,
): readonly { readonly agentId: string; readonly parentAgentId: string; readonly agentMeta: AgentMeta }[] {
  if (agents === undefined) return [];
  const entries = Object.entries(agents);
  const visited = new Set<string>(['main', rootAgentId]);
  const queue: string[] = [rootAgentId];
  const out: { readonly agentId: string; readonly parentAgentId: string; readonly agentMeta: AgentMeta }[] = [];
  while (queue.length > 0) {
    const parentInSource = queue.shift()!;
    for (const [agentId, agentMeta] of entries) {
      if (visited.has(agentId) || agentMeta.delegator?.kind === 'external') continue;
      const owner = subagentParentAgentId(agentMeta) ??
        (agentMeta.labels?.['branch'] === 'true' ? agentMeta.forkedFrom : undefined);
      if (owner !== parentInSource) continue;
      visited.add(agentId);
      const parentAgentId = parentInSource === rootAgentId ? 'main' : parentInSource;
      out.push({ agentId, parentAgentId, agentMeta });
      queue.push(agentId);
    }
  }
  return out;
}

/**
 * Cuts a subagent journal at a closed boundary. A finished agent keeps everything; an agent that is
 * mid-turn keeps the steps whose tool calls all returned and gets a synthetic cancelled turn end, so
 * the promoted thread never inherits a half-open step or a turn that would resume on its own.
 */
export function sliceSettledAgentRecords(records: readonly WireRecord[]): SettledAgentRecords {
  let lastEnded = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]!.type === 'turn.ended') {
      lastEnded = index;
      break;
    }
  }
  const endedReason = lastEnded === -1 ? undefined : turnOutcome(records[lastEnded]!['reason']);
  let openTurnId: number | undefined;
  let open = false;
  let lastStepEnd = -1;
  let firstStepBegin = -1;
  for (let index = lastEnded + 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (
      record.type === 'branch.base' ||
      record.type === 'context.clear' ||
      (record.type === 'agent.branch_sealed' && record['sealed'] === true)
    ) {
      open = false;
      openTurnId = undefined;
      lastStepEnd = -1;
      firstStepBegin = -1;
      continue;
    }
    const event = loopEvent(record);
    if (event !== undefined) {
      open = true;
      openTurnId ??= parseTurnId(event['turnId']);
      if (event['type'] === 'step.begin' && firstStepBegin === -1) firstStepBegin = index;
      if (event['type'] === 'step.end' && event['finishReason'] !== 'error' && event['finishReason'] !== 'interrupted') lastStepEnd = index;
      continue;
    }
    if (record.type === 'turn.prompt' || record.type === 'turn.steer') {
      open = true;
      openTurnId ??= typeof record['turnId'] === 'number' ? record['turnId'] : undefined;
      continue;
    }
    if (record.type === 'context.append_message' && messageRole(record) === 'user') open = true;
  }
  if (!open) return { records, lastTurnReason: endedReason };
  const cut = lastStepEnd !== -1 ? lastStepEnd + 1 : firstStepBegin !== -1 ? firstStepBegin : records.length;
  const kept = records.slice(0, cut);
  const time = latestTime(kept) ?? Date.now();
  return {
    records: [...kept, { type: 'turn.ended', turnId: openTurnId ?? nextTurnId(kept), reason: 'cancelled', time }],
    lastTurnReason: 'cancelled',
    wasOpen: true,
  };
}

/**
 * Removes records that belong to the source session's runtime rather than the promoted main agent's
 * conversation: its subagent binding and tool activation (the promoted main binds fresh), queued or
 * unsettled prompt bookkeeping, cron entries, pending interactions, session-scoped approval grants,
 * and branch-only execution locks while preserving the promoted executor's session continuity.
 */
export function filterPromotedRecords(records: readonly WireRecord[]): readonly WireRecord[] {
  return records.filter((record) => !isSessionScopedApprovedGrant(record) &&
    !MAIN_DROPPED_TYPES.has(record.type) &&
    !DROPPED_PREFIXES.some((prefix) => record.type.startsWith(prefix)));
}

export function promotedExecutorSession(
  records: readonly WireRecord[],
  source: AgentMeta,
  binding: ProfileBindingSnapshot,
): ExecutorSessionUpdated | undefined {
  const record = records.findLast((record) => record.type === ExecutorSessionUpdated.type);
  if (record === undefined) return undefined;
  const event = event2FromRecord(ExecutorSessionUpdated, record);
  if (!(event instanceof ExecutorSessionUpdated) || event.executionGeneration !== source.execution?.generation ||
    event.executorId !== binding.executorId || event.descriptorRevision !== binding.executorDescriptorRevision) return undefined;
  return Object.assign(event, {
    executionGeneration: binding.execution?.generation,
    bindingFingerprint: agentExecutorBindingFingerprint(binding),
    profileDeliveredSessionId: undefined,
    profileDelivery: undefined,
  });
}

/**
 * Filters a promoted descendant's journal while preserving its subagent/branch binding and tool configuration
 * so cold inspection and later explicit resumption remain valid inside the promoted thread.
 */
export function filterPromotedDescendantRecords(records: readonly WireRecord[]): readonly WireRecord[] {
  return records.filter((record) => !isSessionScopedApprovedGrant(record) &&
    !DESCENDANT_DROPPED_TYPES.has(record.type) &&
    !DROPPED_PREFIXES.some((prefix) => record.type.startsWith(prefix)))
    .map((record) => record.type !== 'executor.session.updated' ? record : {
      ...record,
      sessionRef: { executorId: record['executorId'], version: 1, ref: { copiedIdentity: true } },
      profileDeliveredSessionId: undefined,
      lastCumulativeUsage: undefined,
    });
}

/**
 * Rewrites parent/owner agent references from `sourceRootAgentId` to `main`, suppresses duplicate restored
 * task notifications, and appends terminal settlement records for any task, subagent run, pending autonomous
 * receipt, or unsealed branch that was still open at the promotion snapshot boundary.
 */
export function settlePromotedWireRecords(
  records: readonly WireRecord[],
  options: {
    readonly sourceRootAgentId: string;
    readonly targetAgentId: string;
    readonly isDescendant?: boolean;
    readonly isUnsealedBranch?: boolean;
    readonly fallbackTime?: number;
    readonly taskDocuments?: ReadonlyMap<string, PromotedTaskDocument>;
  },
): SettledPromotedWire {
  const { sourceRootAgentId, targetAgentId } = options;
  const settleTime = Math.max(latestTime(records) ?? 0, options.fallbackTime ?? 0) || Date.now();
  const wireTasks = new Map<string, Record<string, unknown>>();
  const terminatedTaskIds = new Set<string>();
  const subagentTaskIds = new Map<string, string>();
  const subagentRuns = new Map<string, {
    subagentId: string;
    taskId?: string;
    state: 'running' | 'terminal';
    record?: WireRecord;
  }>();
  let activeAutonomous: { turnId: number; summary: string } | undefined;
  const pendingAutonomousTurnIds = new Set<number>();
  let branchSealedSeen = false;

  const out: WireRecord[] = records.map((record) => {
    if (options.isDescendant === true) {
      if (record.type === 'agent.branch_sealed') branchSealedSeen = record['sealed'] === true;
      if (record.type === 'turn.prompt') {
        const turnId = parseTurnId(record['turnId']);
        activeAutonomous = record['parentReceiptManaged'] !== false || turnId === undefined ? undefined : { turnId, summary: '' };
      } else if (record.type === 'turn.started') {
        const turnId = parseTurnId(record['turnId']);
        activeAutonomous = record['parentReceiptManaged'] === true || turnId === undefined ? undefined : { turnId, summary: '' };
      } else if (record.type === 'context.append_loop_event' && activeAutonomous !== undefined) {
        const event = loopEvent(record);
        if (event !== undefined && event['type'] !== 'tool.result' && parseTurnId(event['turnId']) === activeAutonomous.turnId) {
          if (event['type'] === 'step.begin') activeAutonomous.summary = '';
          const part = isPlainObject(event['part']) ? event['part'] : undefined;
          if (event['type'] === 'content.part' && part?.['type'] === 'text' && typeof part['text'] === 'string') {
            activeAutonomous.summary += part['text'];
          }
        }
      } else if (record.type === 'context.append_message' && activeAutonomous !== undefined) {
        const message = isPlainObject(record['message']) ? record['message'] : undefined;
        const source = isPlainObject(message?.['source']) ? message['source'] : undefined;
        if (message?.['role'] === 'assistant' && parseTurnId(source?.['turnId']) === activeAutonomous.turnId) {
          activeAutonomous.summary = extractAssistantText(message['content']);
        }
      } else if (record.type === 'turn.ended' && activeAutonomous !== undefined && parseTurnId(record['turnId']) === activeAutonomous.turnId) {
        if (record['reason'] === 'completed' && activeAutonomous.summary.trim() !== '') {
          pendingAutonomousTurnIds.add(activeAutonomous.turnId);
        }
        activeAutonomous = undefined;
      } else if (record.type === 'subagent.autonomous_receipt_delivered') {
        const turnId = parseTurnId(record['turnId']);
        if (turnId !== undefined) pendingAutonomousTurnIds.delete(turnId);
      }
    }

    if (record.type === 'subagent.spawned') {
      const subagentId = stringOf(record['subagentId']);
      if (subagentId !== undefined) {
        const explicitTaskId = stringOf(record['taskId']);
        if (explicitTaskId === undefined) subagentTaskIds.delete(subagentId);
        else subagentTaskIds.set(subagentId, explicitTaskId);
        const runKey = explicitTaskId ?? subagentId;
        const prev = subagentRuns.get(runKey);
        if (!(explicitTaskId !== undefined && prev?.subagentId === subagentId && prev.state === 'terminal')) {
          subagentRuns.set(runKey, { subagentId, taskId: explicitTaskId, state: 'running' });
        }
      }
      if (record['parentAgentId'] === sourceRootAgentId || record['callerAgentId'] === sourceRootAgentId) {
        const next: Record<string, unknown> = { ...record };
        if (next['parentAgentId'] === sourceRootAgentId) next['parentAgentId'] = 'main';
        if (next['callerAgentId'] === sourceRootAgentId) next['callerAgentId'] = 'main';
        return next as WireRecord;
      }
      return record;
    }

    if (record.type === 'subagent.started' || record.type === 'subagent.suspended') {
      const subagentId = stringOf(record['subagentId']);
      if (subagentId !== undefined) {
        const explicitTaskId = stringOf(record['taskId']) ?? subagentTaskIds.get(subagentId);
        const runKey = explicitTaskId ?? subagentId;
        const prev = subagentRuns.get(runKey);
        if (!(explicitTaskId !== undefined && prev?.subagentId === subagentId && prev.state === 'terminal')) {
          subagentRuns.set(runKey, { subagentId, taskId: explicitTaskId, state: 'running' });
        }
      }
      return record;
    }

    if (record.type === 'subagent.completed' || record.type === 'subagent.failed') {
      const subagentId = stringOf(record['subagentId']);
      if (subagentId !== undefined) {
        const explicitTaskId = stringOf(record['taskId']) ?? subagentTaskIds.get(subagentId);
        const runKey = explicitTaskId ?? subagentId;
        const terminalRecord = { ...record, taskId: explicitTaskId };
        subagentRuns.set(runKey, { subagentId, taskId: explicitTaskId, state: 'terminal', record: terminalRecord });
        return terminalRecord;
      }
      return record;
    }

    if (record.type === 'task.started' || record.type === 'task.terminated') {
      if (!isPlainObject(record['info'])) return record;
      const normalizedInfo = rewritePromotedTaskInfo(record['info'], sourceRootAgentId);
      const taskId = stringOf(normalizedInfo['taskId']);
      if (taskId !== undefined) {
        const previous = wireTasks.get(taskId);
        if (previous === undefined || !isSettledTerminalTask(previous) || isSettledTerminalTask(normalizedInfo)) {
          wireTasks.set(taskId, normalizedInfo);
        }
        if (record.type === 'task.terminated') terminatedTaskIds.add(taskId);
        else terminatedTaskIds.delete(taskId);
      }
      return { ...record, info: normalizedInfo };
    }

    if (record.type === 'branch.base' && record['parentAgentId'] === sourceRootAgentId) {
      return { ...record, parentAgentId: 'main' };
    }

    if (record.type === 'agent.model_switch' && targetAgentId === 'main' && record['agentId'] === sourceRootAgentId) {
      return { ...record, agentId: 'main' };
    }

    if (record.type === 'usage.record') {
      if (targetAgentId === 'main' && (record['agentId'] === sourceRootAgentId || record['parentAgentId'] !== undefined)) {
        const next: Record<string, unknown> = { ...record };
        if (next['agentId'] === sourceRootAgentId) next['agentId'] = 'main';
        delete next['parentAgentId'];
        return next as WireRecord;
      }
      if (targetAgentId !== 'main' && record['parentAgentId'] === sourceRootAgentId) {
        return { ...record, parentAgentId: 'main' };
      }
    }

    return record;
  });

  const tasks = new Map<string, PromotedTaskDocument>();
  const taskIds = new Set([...wireTasks.keys(), ...(options.taskDocuments?.keys() ?? [])]);
  for (const taskId of taskIds) {
    const stored = options.taskDocuments?.get(taskId);
    const wire = wireTasks.get(taskId);
    const run = subagentRuns.get(taskId);
    const terminalRun = run?.record;
    let info = stored?.info !== undefined && isSettledTerminalTask(stored.info) ? stored.info
      : wire !== undefined && isSettledTerminalTask(wire) ? wire
        : stored?.info ?? wire!;
    if (!isSettledTerminalTask(info) && terminalRun !== undefined) {
      info = {
        ...info,
        status: terminalRun.type === 'subagent.completed' ? 'completed'
          : terminalRun['error'] === 'terminated' ? 'killed' : 'failed',
        endedAt: terminalRun.time ?? settleTime,
        stopReason: terminalRun.type === 'subagent.failed' && terminalRun['error'] !== 'terminated' ? terminalRun['error'] : undefined,
        cleanupPending: undefined,
      };
    }
    const normalized = normalizePromotedTaskDocument(info, sourceRootAgentId, settleTime)!;
    tasks.set(taskId, { info: normalized, output: stored?.output });
    if (!terminatedTaskIds.has(taskId)) {
      out.push({ type: 'task.terminated', info: normalized, time: normalized['endedAt'] as number });
    }
    const agentId = stringOf(normalized['agentId']);
    if (normalized['kind'] === 'agent' && agentId !== undefined && !subagentRuns.has(taskId)) {
      subagentRuns.set(taskId, { subagentId: agentId, taskId, state: 'running' });
    }
  }

  const agentOutcomes = new Map<string, PromotedAgentOutcome>();
  const runSettlements = new Map<string, WireRecord>();
  for (const [runKey, run] of subagentRuns) {
    const task = run.taskId === undefined ? undefined : tasks.get(run.taskId);
    const info = task?.info;
    const status = info?.['status'];
    const completedAt = typeof info?.['endedAt'] === 'number' ? info['endedAt'] : run.record?.time ?? settleTime;
    const completed = status === 'completed' || (info === undefined && run.record?.type === 'subagent.completed');
    const resultSummary = completed ? (task?.output === undefined
      ? stringOf(run.record?.['resultSummary']) ?? ''
      : new TextDecoder().decode(task.output)) : undefined;
    const error = completed ? undefined : status === 'killed' || (info === undefined && run.state === 'running')
      ? 'terminated' : stringOf(info?.['stopReason']) ?? stringOf(run.record?.['error']) ?? stringOf(status) ?? 'terminated';
    const settlement: WireRecord = completed
      ? { ...run.record, type: 'subagent.completed', subagentId: run.subagentId, taskId: run.taskId, resultSummary, time: completedAt }
      : { type: 'subagent.failed', subagentId: run.subagentId, taskId: run.taskId, error, time: completedAt };
    runSettlements.set(runKey, settlement);
    if ((agentOutcomes.get(run.subagentId)?.completedAt ?? 0) <= completedAt) {
      agentOutcomes.set(run.subagentId, {
        taskId: run.taskId,
        status: completed ? 'completed' : error === 'terminated' ? 'cancelled' : 'failed',
        completedAt, resultSummary, error,
      });
    }
    if (run.state === 'running') out.push(settlement);
  }
  for (let index = 0; index < out.length; index += 1) {
    const record = out[index]!;
    if (record.type === 'task.terminated' && isPlainObject(record['info'])) {
      const taskId = stringOf(record['info']['taskId']);
      const task = taskId === undefined ? undefined : tasks.get(taskId);
      if (task !== undefined) out[index] = { ...record, info: task.info };
    } else if (record.type === 'subagent.completed' || record.type === 'subagent.failed') {
      const runKey = stringOf(record['taskId']) ?? stringOf(record['subagentId']);
      const settlement = runKey === undefined ? undefined : runSettlements.get(runKey);
      if (settlement !== undefined) out[index] = settlement;
    }
  }
  if (options.isDescendant === true) {
    for (const turnId of pendingAutonomousTurnIds) {
      out.push({ type: 'subagent.autonomous_receipt_delivered', turnId, time: settleTime });
    }
    if (options.isUnsealedBranch === true && !branchSealedSeen) {
      out.push({ type: 'agent.branch_sealed', sealed: true, time: settleTime });
    }
  }

  return { records: out, tasks, agentOutcomes, settleTime };
}

/** Normalizes a persisted task JSON document for the promoted session so restored tasks stay terminal and quiet. */
export function normalizePromotedTaskDocument(
  raw: unknown,
  sourceRootAgentId: string,
  settleTime: number,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw) || stringOf(raw['taskId']) === undefined) return undefined;
  const rewritten = rewritePromotedTaskInfo(raw, sourceRootAgentId);
  return isSettledTerminalTask(rewritten) ? rewritten : settleOpenTaskInfo(rewritten, settleTime);
}

/** Normalizes a promoted descendant's `AgentMeta`, reparenting direct children to `main` and settling open state. */
export function normalizePromotedDescendantMeta(
  descendant: PromotedDescendantSource,
  options: {
    readonly sourceRootAgentId: string;
    readonly targetAgentHome: string;
    readonly settleTime: number;
    readonly outcome?: PromotedAgentOutcome;
  },
): AgentMeta {
  const { agentMeta: meta, parentAgentId } = descendant;
  const labels: Record<string, string> = { ...meta.labels };
  const isBranch = labels['branch'] === 'true';
  if (labels['parentAgentId'] !== undefined || !isBranch) labels['parentAgentId'] = parentAgentId;
  if (labels['requestIdentityRootAgent'] === options.sourceRootAgentId) labels['requestIdentityRootAgent'] = 'main';
  if (isBranch) labels['branchSealed'] = 'true';

  const branchAlreadySealed = isBranch && meta.labels?.['branchSealed'] === 'true' && descendant.wasOpen !== true;
  const terminalSubagent = !isBranch && descendant.wasOpen !== true &&
    (meta.status === 'completed' || meta.status === 'failed' || meta.status === 'cancelled');
  const preserveOutcome = branchAlreadySealed || terminalSubagent;
  const latestTurnIndex = descendant.records.findLastIndex((record) => record.type === 'turn.prompt' || record.type === 'turn.started');
  const latestTurnTime = descendant.records[latestTurnIndex]?.time;
  const outcomeBeforeLatestTurn = options.outcome !== undefined && (
    (latestTurnTime !== undefined && options.outcome.completedAt < latestTurnTime) ||
    descendant.records.some((record, index) => index < latestTurnIndex && record['subagentId'] === descendant.agentId &&
      record['taskId'] === options.outcome!.taskId && (record.type === 'subagent.completed' || record.type === 'subagent.failed'))
  );
  const outcome = descendant.wasOpen === true && outcomeBeforeLatestTurn ? undefined : options.outcome;

  let status: 'completed' | 'failed' | 'cancelled';
  if (branchAlreadySealed) status = meta.status ?? 'completed';
  else if (isBranch) status = meta.status ?? 'cancelled';
  else if (terminalSubagent) status = meta.status!;
  else status = 'cancelled';

  const completedAt = preserveOutcome
    ? (meta.completedAt ?? options.settleTime)
    : Math.max(meta.completedAt ?? 0, options.settleTime);

  const next: Record<string, unknown> = {
    ...meta,
    homedir: options.targetAgentHome,
    parentAgentId,
    delegator: { kind: 'agent', agentId: parentAgentId },
    status,
    completedAt,
    resultSummary: preserveOutcome ? meta.resultSummary : undefined,
    error: preserveOutcome ? meta.error : undefined,
  };
  if (outcome !== undefined && !isBranch) Object.assign(next, outcome);
  if (meta.forkedFrom === options.sourceRootAgentId) next['forkedFrom'] = 'main';
  if (Object.keys(labels).length > 0) next['labels'] = labels;
  return next as AgentMeta;
}

/**
 * Points agent-scoped blob references at their promoted owner and moves absolute paths under
 * the source agent homes and session media directories onto the target. Returns the blobs that live under
 * external source agents so the caller can copy them next to the target owner, and referenced media file ids.
 */
export function retargetPromotedRecords(
  records: readonly WireRecord[],
  sourceAgentId: string,
  sourceAgentHome: string,
  targetAgentHome: string,
  sourceMediaDirs: readonly string[],
  targetMediaDir: string,
  options?: {
    readonly targetOwnerAgentId?: string;
    readonly preservedAgentIds?: ReadonlySet<string>;
    readonly extraPathMappings?: readonly (readonly [string, string])[];
  },
): RetargetedRecords {
  const targetOwner = options?.targetOwnerAgentId ?? 'main';
  const preserved = options?.preservedAgentIds;
  const foreign = new Map<string, { agentId: string; hash: string }>();
  const fileIds = new Set<string>();
  const homeVariants = [
    ...pathVariants(sourceAgentHome, targetAgentHome),
    ...(options?.extraPathMappings ?? []).flatMap(([from, to]) => pathVariants(from, to)),
    ...sourceMediaDirs.flatMap((sourceMediaDir) => pathVariants(sourceMediaDir, targetMediaDir)),
  ];
  const retargeted = records.map((record) => {
    let text = JSON.stringify(record);
    let changed = false;
    if (text.includes('blobref:')) {
      text = text.replace(BLOBREF_PATTERN, (_match, agentId: string, hash: string) => {
        if (targetOwner === 'main') {
          if (agentId !== sourceAgentId && agentId !== 'main') foreign.set(`${agentId}:${hash}`, { agentId, hash });
          else if (agentId === 'main' && sourceAgentId !== 'main') foreign.set(`main:${hash}`, { agentId, hash });
          changed = true;
          return `blobref:main:${hash}`;
        }
        if (agentId === targetOwner) return `blobref:${targetOwner}:${hash}`;
        if (agentId === sourceAgentId) {
          changed = true;
          return `blobref:main:${hash}`;
        }
        if (preserved?.has(agentId) === true) return `blobref:${agentId}:${hash}`;
        foreign.set(`${agentId}:${hash}`, { agentId, hash });
        changed = true;
        return `blobref:${targetOwner}:${hash}`;
      });
    }
    for (const [from, to] of homeVariants) {
      if (!text.includes(from)) continue;
      const next = text.replace(new RegExp(`${escapeRegExp(from)}(?=[/\\\\"])`, 'gu'), to);
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
    for (const match of text.matchAll(FILE_ID_PATTERN)) fileIds.add(match[0]);
    return changed ? JSON.parse(text) as WireRecord : record;
  });
  return { records: retargeted, foreignBlobs: [...foreign.values()], fileIds };
}

function isSessionScopedApprovedGrant(record: WireRecord): boolean {
  if (record.type !== 'permission.record_approval_result' || record['sessionApprovalRule'] === undefined) return false;
  const result = record['result'];
  if (!isPlainObject(result)) return false;
  return result['decision'] === 'approved' && result['scope'] === 'session';
}

function rewritePromotedTaskInfo(info: Record<string, unknown>, sourceRootAgentId: string): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...info,
    terminalNotificationSuppressed: true,
  };
  if (next['ownerAgentId'] === sourceRootAgentId) next['ownerAgentId'] = 'main';
  return next;
}

function isSettledTerminalTask(info: Record<string, unknown>): boolean {
  const status = stringOf(info['status']);
  if (status === undefined || !TERMINAL_STATUSES.has(status as AgentTaskStatus)) return false;
  return info['cleanupPending'] !== true && info['endedAt'] !== null;
}

function settleOpenTaskInfo(info: Record<string, unknown>, settleTime: number): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...info,
    status: 'killed',
    endedAt: settleTime,
    terminalNotificationSuppressed: true,
  };
  delete next['cleanupPending'];
  delete next['receipt'];
  delete next['receiptVerification'];
  return next;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => isPlainObject(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : [])
    .join('');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pathVariants(from: string, to: string): readonly (readonly [string, string])[] {
  const forwardFrom = from.replaceAll('\\', '/');
  const forwardTo = to.replaceAll('\\', '/');
  const escapedBackFrom = forwardFrom.replaceAll('/', '\\\\');
  const escapedBackTo = forwardTo.replaceAll('/', '\\\\');
  return [[forwardFrom, forwardTo], [escapedBackFrom, escapedBackTo]];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function loopEvent(record: WireRecord): Record<string, unknown> | undefined {
  if (record.type !== 'context.append_loop_event') return undefined;
  const event = record['event'];
  return isPlainObject(event) ? event : undefined;
}

function messageRole(record: WireRecord): unknown {
  const message = record['message'];
  return isPlainObject(message) ? message['role'] : undefined;
}

function parseTurnId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function turnOutcome(value: unknown): 'completed' | 'cancelled' | 'failed' | undefined {
  if (value === 'blocked') return 'failed';
  return value === 'completed' || value === 'cancelled' || value === 'failed' ? value : undefined;
}

function nextTurnId(records: readonly WireRecord[]): number {
  let next = 0;
  for (const record of records) {
    const direct = record.type === 'turn.prompt' || record.type === 'turn.steer' || record.type === 'turn.ended'
      ? parseTurnId(record['turnId'])
      : undefined;
    const id = direct ?? parseTurnId(loopEvent(record)?.['turnId']);
    if (id !== undefined) next = Math.max(next, id + 1);
  }
  return next;
}

function latestTime(records: readonly WireRecord[]): number | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const time = records[index]!.time;
    if (typeof time === 'number' && Number.isFinite(time)) return time;
  }
  return undefined;
}

import type { SessionInterruptedWork } from '@kiki/protocol';
import type { Block, NoticeBlock, TurnTailInfo } from './types';

export type TimelinePlacement = 'epoch' | 'visible-activity' | 'foldable' | 'error';

export interface NoticePlacementContext {
  readonly latestGoalUpdateId?: string;
  readonly latestPlanRevisionId?: string;
  readonly planModeActive?: boolean;
}

const FOLDABLE_MARKERS: ReadonlySet<string> = new Set([
  'hook',
  'skill',
  'cron',
  'cron_fired',
  'notice',
]);

const FAILED_TASKREF_STATES: ReadonlySet<string> = new Set([
  'failed',
  'lost',
  'timed_out',
  'timeout',
  'error',
]);

const ACTIVE_TASKREF_STATES: ReadonlySet<string> = new Set([
  'running',
  'waiting',
  'pending',
  'queued',
  'suspended',
  'background',
]);

export function buildNoticePlacementContext(
  blocks: readonly Block[],
  options?: { readonly planModeActive?: boolean },
): NoticePlacementContext {
  let latestGoalUpdateId: string | undefined;
  let latestPlanRevisionId: string | undefined;
  let goalCleared = false;
  let planExited = false;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== 'notice') continue;
    if (!goalCleared && block.goalChange !== undefined) {
      if (block.goalChange.kind === 'cleared' || block.goalChange.kind === 'completed') {
        goalCleared = true;
      } else if (block.goalChange.kind === 'updated' && latestGoalUpdateId === undefined) {
        latestGoalUpdateId = block.id;
      }
    }
    if (!planExited) {
      const marker = block.markerKind;
      if (marker === 'plan.exit') {
        planExited = true;
      } else if (marker === 'plan.revision' && latestPlanRevisionId === undefined) {
        latestPlanRevisionId = block.id;
      }
    }
  }
  return {
    latestGoalUpdateId,
    latestPlanRevisionId,
    planModeActive: options?.planModeActive,
  };
}

export function classifyNoticePlacement(
  block: NoticeBlock,
  context: NoticePlacementContext = {},
): TimelinePlacement {
  if (block.earlierPromptOutcomes !== undefined) return 'visible-activity';
  if (block.externalText !== undefined) return 'visible-activity';

  if (block.executor !== undefined) {
    return block.executor.kind === 'compaction' ? 'epoch' : 'foldable';
  }

  if (block.taskRef !== undefined) {
    const state = block.taskRef.state?.toLowerCase();
    if (block.tone === 'danger' || (state !== undefined && FAILED_TASKREF_STATES.has(state))) {
      return 'error';
    }
    if (state !== undefined && ACTIVE_TASKREF_STATES.has(state)) {
      return 'visible-activity';
    }
    return 'foldable';
  }

  if (block.compactionPhase !== undefined || block.markerKind === 'compaction') {
    if (block.compactionPhase === 'failed' || block.compactionPhase === 'interrupted') {
      return 'error';
    }
    if (block.compactionPhase === 'cancelled') {
      return block.compactionFailure !== undefined ? 'error' : 'foldable';
    }
    return 'epoch';
  }

  if (
    block.i18n?.key === 'notice.compacting' ||
    block.i18n?.key === 'transcript.marker.compaction' ||
    block.i18n?.key === 'transcript.marker.compactionSummarize' ||
    block.i18n?.key === 'transcript.marker.compactionFresh' ||
    block.i18n?.key === 'transcript.marker.compactionFallback' ||
    block.i18n?.key === 'transcript.marker.compactionQueued' ||
    block.i18n?.key === 'transcript.marker.compactionRunning'
  ) {
    return 'epoch';
  }

  if (
    block.i18n?.key === 'transcript.marker.compactionFailed' ||
    block.i18n?.key === 'transcript.marker.compactionInterrupted'
  ) {
    return 'error';
  }

  if (block.i18n?.key === 'transcript.marker.compactionCancelled') {
    return block.compactionFailure !== undefined ? 'error' : 'foldable';
  }

  if (block.modelSwitch !== undefined) {
    const sw = block.modelSwitch;
    if (sw.state === 'failed') return 'error';
    if (sw.state === 'pending' || sw.state === 'preparing') return 'visible-activity';
    if (sw.state === 'cancelled') return 'foldable';
    if (sw.from !== sw.to || sw.mode === 'fresh' || sw.mode === 'compact') {
      return 'epoch';
    }
    return 'foldable';
  }

  if (block.markerKind === 'model.switch.uncertain') {
    return 'visible-activity';
  }

  if (block.markerKind === 'model.switch') {
    if (block.modelSwitchFrom !== undefined && block.modelSwitchTo !== undefined) {
      return block.modelSwitchFrom !== block.modelSwitchTo ? 'epoch' : 'foldable';
    }
    return block.i18n?.key === 'transcript.marker.modelSwitch' ? 'epoch' : 'foldable';
  }

  if (block.branchBase !== undefined || block.markerKind === 'branch.base') {
    return 'epoch';
  }

  if (block.markerKind === 'context.clear' || block.i18n?.key === 'transcript.marker.contextClear') {
    return 'epoch';
  }

  if (block.markerKind === 'context.handoff') {
    return 'epoch';
  }

  if (block.goalChange !== undefined) {
    if (block.goalChange.kind === 'updated') {
      return context.latestGoalUpdateId === block.id ? 'visible-activity' : 'foldable';
    }
    return 'visible-activity';
  }

  if (block.markerKind === 'plan.enter' || block.markerKind === 'plan.exit') {
    return 'visible-activity';
  }

  if (block.markerKind === 'plan.revision') {
    return context.latestPlanRevisionId === block.id ? 'visible-activity' : 'foldable';
  }

  if (
    block.markerKind === 'interruption' ||
    block.i18n?.key === 'transcript.marker.interruption' ||
    block.i18n?.key === 'notice.turnCancelledDetail'
  ) {
    return 'visible-activity';
  }

  if (block.i18n?.key === 'transcript.lastRetryFailed') {
    return 'foldable';
  }

  if (
    block.tone === 'danger' ||
    block.i18n?.key === 'notice.turnFailedDetail' ||
    block.i18n?.key === 'notice.turnFailed' ||
    block.i18n?.key === 'notice.promptFailed'
  ) {
    return 'error';
  }

  if (block.markerKind !== undefined && FOLDABLE_MARKERS.has(block.markerKind)) {
    return 'foldable';
  }

  return 'foldable';
}

export function latestUnresolvedCompactionId(blocks: readonly Block[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== 'notice') continue;
    const isCompaction = block.compactionPhase !== undefined || block.markerKind === 'compaction';
    if (!isCompaction) continue;
    if (
      block.compactionPhase === 'completed' ||
      block.compactionPhase === 'queued' ||
      block.compactionPhase === 'running' ||
      block.i18n?.key === 'transcript.marker.compaction' ||
      block.i18n?.key === 'transcript.marker.compactionSummarize' ||
      block.i18n?.key === 'transcript.marker.compactionFresh' ||
      block.i18n?.key === 'transcript.marker.compactionFallback' ||
      block.i18n?.key === 'transcript.marker.compactionRescue'
    ) {
      return undefined;
    }
    if (
      block.compactionPhase === 'failed' ||
      block.compactionPhase === 'interrupted' ||
      block.compactionFailure !== undefined ||
      block.i18n?.key === 'transcript.marker.compactionFailed' ||
      block.i18n?.key === 'transcript.marker.compactionInterrupted'
    ) {
      return block.id;
    }
  }
  return undefined;
}

function canonicalTurnKey(turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId === '') return undefined;
  return turnId.startsWith('t') ? turnId : `t${turnId}`;
}

function numericTurnOrdinal(turnKey: string): number | undefined {
  const raw = turnKey.startsWith('t') ? turnKey.slice(1) : turnKey;
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

export function collectOrderedTurnIds(
  blocks: readonly Block[],
  turnTerminals?: Readonly<Record<string, TurnTailInfo>>,
): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (turnId: string | undefined) => {
    const key = canonicalTurnKey(turnId);
    if (key === undefined || seen.has(key)) return;
    seen.add(key);
    ordered.push(key);
  };
  for (const block of blocks) {
    if (block.kind === 'subagent') add(block.parentTurnId);
    else if (block.kind === 'approval' || block.kind === 'question') {
      add(block.request.turn_id === undefined ? undefined : `t${block.request.turn_id}`);
    } else {
      add(block.turnId);
    }
  }
  if (turnTerminals !== undefined) {
    for (const key of Object.keys(turnTerminals)) add(key);
  }
  return ordered;
}

export function hasConfirmedSubsequentSuccess(
  targetTurnId: string | undefined,
  blocks: readonly Block[],
  turnTerminals: Readonly<Record<string, TurnTailInfo>> | undefined,
): boolean {
  const target = canonicalTurnKey(targetTurnId);
  if (target === undefined || turnTerminals === undefined) return false;
  const targetOrdinal = numericTurnOrdinal(target);
  const ordered = collectOrderedTurnIds(blocks, turnTerminals);
  const targetIndex = ordered.indexOf(target);

  for (const [rawId, info] of Object.entries(turnTerminals)) {
    if (info.state !== 'completed') continue;
    const candidate = canonicalTurnKey(rawId);
    if (candidate === undefined || candidate === target) continue;
    const candidateOrdinal = numericTurnOrdinal(candidate);
    if (targetOrdinal !== undefined && candidateOrdinal !== undefined) {
      if (candidateOrdinal > targetOrdinal) return true;
      continue;
    }
    if (targetIndex >= 0) {
      const candidateIndex = ordered.indexOf(candidate);
      if (candidateIndex > targetIndex) return true;
    }
  }
  return false;
}

export function hasSubsequentCompactionResolution(
  blocks: readonly Block[],
  targetBlockId: string,
): boolean {
  const index = blocks.findIndex((block) => block.id === targetBlockId);
  if (index < 0) return false;
  for (let i = index + 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block?.kind !== 'notice') continue;
    if (block.compactionPhase === 'completed') return true;
  }
  return false;
}

export function hasSubsequentModelSwitchResolution(
  blocks: readonly Block[],
  targetBlockId: string,
): boolean {
  const index = blocks.findIndex((block) => block.id === targetBlockId);
  if (index < 0) return false;
  for (let i = index + 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block?.kind !== 'notice') continue;
    if (block.modelSwitch?.state === 'completed') return true;
  }
  return false;
}

export interface RecoverableInterruptionSummary {
  readonly recoverable: boolean;
  readonly mainInterrupted: boolean;
  readonly lostTasks: number;
  readonly interruptedBranches: number;
  readonly heldQueueCount: number;
  readonly targets: readonly { readonly agent_id: string; readonly label?: string; readonly kind: 'main' | 'branch' | 'subagent'; readonly reason: 'recovery' | 'lost_task' | 'branch_interrupted'; readonly lost_tasks?: number }[];
}

export function resolveRecoverableInterruption(input: {
  readonly agentId: string;
  readonly turnTail?: TurnTailInfo;
  readonly interruptedWork?: SessionInterruptedWork;
  readonly promptQueueHold?: { readonly reason: 'recovery'; readonly count: number };
}): RecoverableInterruptionSummary {
  const isMain = input.agentId === 'main';
  const isRecoveryCancelledTail =
    input.turnTail?.state === 'cancelled' && input.turnTail.cancellation === 'recovery';
  const heldQueueCount = input.promptQueueHold?.reason === 'recovery' ? Math.max(0, input.promptQueueHold.count) : 0;
  const rawTargets = input.interruptedWork?.targets ?? [];
  const dedupedTargets = new Map<string, (typeof rawTargets)[number]>();
  for (const target of rawTargets) {
    if (!isMain && target.agent_id !== input.agentId) continue;
    if (!dedupedTargets.has(target.agent_id)) dedupedTargets.set(target.agent_id, target);
  }
  const targets = [...dedupedTargets.values()];
  const mainInterrupted = isMain && (input.interruptedWork?.main_interrupted === true || isRecoveryCancelledTail);
  const lostTasksFromTargets = targets.reduce((sum, target) => sum + (target.lost_tasks ?? (target.reason === 'lost_task' ? 1 : 0)), 0);
  const lostTasks = isMain
    ? Math.max(input.interruptedWork?.lost_tasks ?? 0, lostTasksFromTargets)
    : lostTasksFromTargets;
  const branchesFromTargets = targets.filter((target) => target.kind === 'branch').length;
  const interruptedBranches = isMain
    ? Math.max(input.interruptedWork?.interrupted_branches ?? 0, branchesFromTargets)
    : branchesFromTargets;

  const recoverable =
    isRecoveryCancelledTail ||
    mainInterrupted ||
    heldQueueCount > 0 ||
    lostTasks > 0 ||
    interruptedBranches > 0 ||
    targets.length > 0;

  return {
    recoverable,
    mainInterrupted,
    lostTasks,
    interruptedBranches,
    heldQueueCount,
    targets,
  };
}

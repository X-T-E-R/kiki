import type { Block } from '@kiki/session-core/session';

import type { ActivityLineParts } from '#/tui/components/chrome/activity-line';
import { STATUS_NOTICE_TTL_MS } from '#/tui/constant/rendering';

export interface BusyActivityMessageInput {
  readonly runningTasks: number;
  readonly turnStartedAt: number | undefined;
  readonly hasResponded: boolean;
  readonly lastResponseAt: number | undefined;
  readonly now: number;
  /** The input box holds a draft, so Esc needs a second press to interrupt. */
  readonly hasDraft: boolean;
}

export type StatusNoticeCategory = 'transient' | 'sticky' | 'error';

export interface ShowStatusOptions {
  readonly tone?: 'normal' | 'error';
  readonly transient?: boolean;
  readonly ttlMs?: number;
  readonly source?: string;
  /** Render the notice as a structured activity line instead of plain text. */
  readonly activity?: ActivityLineParts;
}

export interface StatusNotice {
  readonly message: string;
  readonly tone: 'normal' | 'error';
  readonly transient: boolean;
  readonly source?: string;
  readonly timer?: ReturnType<typeof setTimeout>;
}

export interface StatusNoticePolicy {
  readonly transient: boolean;
  readonly ttlMs?: number;
  readonly source?: string;
}

/**
 * Resolve display policy for a status notice based on explicit caller options.
 * Does not guess semantics or TTL from arbitrary message text.
 */
export function resolveStatusNoticePolicy(
  tone: 'normal' | 'error',
  options?: ShowStatusOptions,
): StatusNoticePolicy {
  const isTransient = options?.transient ?? false;
  return {
    transient: isTransient,
    ttlMs: isTransient ? (options?.ttlMs ?? STATUS_NOTICE_TTL_MS) : undefined,
    source: options?.source,
  };
}

/**
 * Format elapsed milliseconds into the representation used by footer:
 * <60s -> Ns, <60m -> Nm, >=60m -> NhNm.
 */
export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60)}m`;
}

/**
 * A fingerprint of the newest agent output in a block list: it changes when
 * the agent streams text, starts or finishes a tool, or a subagent moves, and
 * stays put for the user's own rows (a queued prompt, an approval answer).
 * Ported from apps/kiki-gui/src/components/composerWorking.ts.
 */
export function agentOutputSignature(blocks: readonly Block[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    switch (block.kind) {
      case 'assistant':
      case 'thinking':
        return `${block.id}:${String(block.text.length)}:${block.streaming ? '1' : '0'}`;
      case 'tool':
        return `${block.id}:${block.status}:${block.progressText ?? ''}`;
      case 'shell':
        return `${block.id}:${String(block.output.length)}:${block.done ? '1' : '0'}`;
      case 'subagent':
        return `${block.id}:${block.status}:${String(block.toolCallCount)}`;
      default:
        break;
    }
  }
  return undefined;
}

/**
 * Check if a block represents a user prompt that is queued or pending admission,
 * rather than the prompt that opened the currently running turn.
 */
export function isQueuedUserBlock(block: Block, queuedPromptIds?: readonly string[]): boolean {
  if (block.kind !== 'user') return false;
  if (block.promptStatus === 'queued') return true;
  if (block.steerStatus === 'waiting' || block.steerStatus === 'sending') return true;
  if (block.promptId !== undefined && queuedPromptIds !== undefined && queuedPromptIds.includes(block.promptId)) {
    return true;
  }
  return false;
}

/**
 * Check if a block is an agent-produced block (assistant, thinking, tool, shell, subagent).
 */
export function isAgentBlock(block: Block): boolean {
  return (
    block.kind === 'assistant' ||
    block.kind === 'thinking' ||
    block.kind === 'tool' ||
    block.kind === 'shell' ||
    block.kind === 'subagent'
  );
}

/**
 * Extract the numeric epoch timestamp (ms) of an agent block if known.
 */
export function getBlockTimestamp(block: Block): number | undefined {
  if (block.kind === 'assistant' || block.kind === 'thinking') {
    if (block.createdAt === undefined) return undefined;
    const parsed = Date.parse(block.createdAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (block.kind === 'tool' || block.kind === 'shell') {
    return block.startedAt;
  }
  if (block.kind === 'subagent') {
    if (block.startedAt === undefined) return undefined;
    const parsed = Date.parse(block.startedAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Extract blocks that belong strictly to the current turn:
 * Slices blocks strictly after the last non-queued user block, excluding any queued user prompts.
 * If no non-queued user block is present, falls back to turnStartedAt filtering.
 */
export function getCurrentTurnBlocks(
  blocks: readonly Block[],
  queuedPromptIds?: readonly string[],
  turnStartedAt?: number,
): readonly Block[] {
  let lastActiveUserIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block !== undefined && block.kind === 'user' && !isQueuedUserBlock(block, queuedPromptIds)) {
      lastActiveUserIndex = index;
      break;
    }
  }

  if (lastActiveUserIndex !== -1) {
    return blocks
      .slice(lastActiveUserIndex + 1)
      .filter((block) => {
        if (isQueuedUserBlock(block, queuedPromptIds)) return false;
        const timestamp = getBlockTimestamp(block);
        return turnStartedAt === undefined || timestamp === undefined || timestamp >= turnStartedAt;
      });
  }

  if (turnStartedAt === undefined) {
    return [];
  }

  return blocks.filter((block) => {
    if (!isAgentBlock(block)) return false;
    const timestamp = getBlockTimestamp(block);
    return timestamp !== undefined && timestamp >= turnStartedAt;
  });
}

/**
 * Derives the newest known timestamp among agent blocks belonging to the current turn.
 */
export function latestAgentTimestamp(
  currentTurnBlocks: readonly Block[],
  turnStartedAt?: number,
): number | undefined {
  for (let index = currentTurnBlocks.length - 1; index >= 0; index -= 1) {
    const block = currentTurnBlocks[index];
    if (block === undefined) continue;
    const timestamp = getBlockTimestamp(block);
    if (timestamp !== undefined) {
      if (turnStartedAt === undefined || timestamp >= turnStartedAt) {
        return timestamp;
      }
    }
  }
  return undefined;
}

/**
 * Whether any agent output has been produced in the current turn.
 */
export function hasAgentOutputThisTurn(
  blocks: readonly Block[],
  queuedPromptIds?: readonly string[],
  turnStartedAt?: number,
): boolean {
  const current = getCurrentTurnBlocks(blocks, queuedPromptIds, turnStartedAt);
  return current.some(isAgentBlock);
}

/**
 * Tracks agent activity in the current running turn:
 * - Distinguishes whether the agent has produced ANY output this turn (Window 1 vs Window 2)
 * - Tracks streaming text increments and tool progress changes via agentOutputSignature
 * - Seeds from actual block timestamps on rising edge (if turnStartedAt is known and block >= turnStartedAt)
 * - Never seeds from local clock on cold-open/unknown turnStartedAt
 * - Ignores user and queued prompt mutations
 */
export class TurnActivityTracker {
  private lastSeenSignature: string | undefined = undefined;
  private lastResponseAt: number | undefined = undefined;
  private lastTurnStartedAt: number | undefined = undefined;
  private wasBusy = false;

  reset(): void {
    this.lastSeenSignature = undefined;
    this.lastResponseAt = undefined;
    this.lastTurnStartedAt = undefined;
    this.wasBusy = false;
  }

  hasAgentResponded(): boolean {
    return this.lastSeenSignature !== undefined;
  }

  getLastResponseAt(): number | undefined {
    return this.lastResponseAt;
  }

  update(
    busy: boolean,
    blocks: readonly Block[],
    turnStartedAt: number | undefined,
    queuedPromptIds: readonly string[] | undefined,
    now: number,
  ): {
    readonly hasResponded: boolean;
    readonly lastResponseAt: number | undefined;
  } {
    if (!busy) {
      this.reset();
      return { hasResponded: false, lastResponseAt: undefined };
    }

    // Cold-open / unknown start: never treat past turns as current turn
    if (turnStartedAt === undefined || !Number.isFinite(turnStartedAt) || turnStartedAt > now) {
      this.reset();
      this.wasBusy = true;
      return { hasResponded: false, lastResponseAt: undefined };
    }

    const currentTurnBlocks = getCurrentTurnBlocks(blocks, queuedPromptIds, turnStartedAt);
    const hasResponded = currentTurnBlocks.some(isAgentBlock);
    const hasTimedOutput = currentTurnBlocks.some(
      (b) => isAgentBlock(b) && getBlockTimestamp(b) !== undefined,
    );
    const signature = agentOutputSignature(currentTurnBlocks);

    const isNewTurn = !this.wasBusy || turnStartedAt !== this.lastTurnStartedAt;
    if (isNewTurn) {
      this.wasBusy = true;
      this.lastTurnStartedAt = turnStartedAt;
      this.lastSeenSignature = signature;

      if (hasTimedOutput) {
        const seeded = latestAgentTimestamp(currentTurnBlocks, turnStartedAt);
        this.lastResponseAt = seeded !== undefined && seeded >= turnStartedAt && seeded <= now ? seeded : undefined;
      } else {
        this.lastResponseAt = undefined;
      }
      return { hasResponded, lastResponseAt: this.lastResponseAt };
    }

    // Still busy in the same turn: advance lastResponseAt when agent output signature changes
    if (signature !== undefined && signature !== this.lastSeenSignature) {
      this.lastSeenSignature = signature;
      if (hasTimedOutput) {
        if (this.lastResponseAt === undefined) {
          const seeded = latestAgentTimestamp(currentTurnBlocks, turnStartedAt);
          this.lastResponseAt =
            seeded !== undefined && seeded >= turnStartedAt && seeded <= now ? seeded : undefined;
        } else {
          this.lastResponseAt = now;
        }
      } else {
        this.lastResponseAt = undefined;
      }
    }

    return { hasResponded, lastResponseAt: this.lastResponseAt };
  }
}

/**
 * The busy status line: elapsed time from the first second, background
 * tasks, time since the last agent output once the agent has responded, and
 * how to interrupt (a draft in the input box makes Esc ask twice).
 */
export function formatBusyActivityLine(input: BusyActivityMessageInput): ActivityLineParts {
  const elapsed =
    input.turnStartedAt !== undefined && input.now >= input.turnStartedAt
      ? formatElapsedDuration(input.now - input.turnStartedAt)
      : undefined;
  const details: string[] = [];
  if (input.runningTasks > 0) {
    details.push(`${String(input.runningTasks)} ${input.runningTasks === 1 ? 'task' : 'tasks'} running`);
  }
  // Untimed output (a subagent, a cold open mid-turn) shows no fake "ago".
  if (input.hasResponded && input.lastResponseAt !== undefined) {
    const agoMs = Math.max(0, input.now - input.lastResponseAt);
    details.push(`last response ${formatElapsedDuration(agoMs)} ago`);
  }
  return {
    lead: elapsed === undefined ? 'Working…' : `Working ${elapsed}`,
    tone: 'text',
    details,
    hint: input.hasDraft ? 'Esc twice to interrupt' : 'Esc to interrupt',
  };
}

/** The status line while a turn is blocked on the user's approval or answer. */
export function formatWaitingActivityLine(
  kind: 'approval' | 'question',
  deferred: boolean,
): ActivityLineParts {
  return {
    lead: kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer',
    tone: 'warning',
    details: [],
    // The request is held back while the user's own dialog is open (see
    // DaemonTUI.syncInteractionBlocks); closing that dialog shows it.
    hint: deferred ? 'Esc to close this dialog and review' : undefined,
  };
}

/** Plain-text form of an activity line, kept as the status notice message. */
export function activityLineText(parts: ActivityLineParts): string {
  return [parts.lead, ...parts.details, ...(parts.hint === undefined ? [] : [parts.hint])].join(' · ');
}

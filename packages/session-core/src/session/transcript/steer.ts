/**
 * "Send now" (steer) echo: a message sent into a running turn stays on the
 * timeline from the keypress until its canonical user frame is delivered.
 *
 * The accepted prompt stays in the server queue until a boundary takes it.
 * The overlay shows that pending prompt on the timeline instead of in the
 * queue strip. It uses the original user-message id so the delivered frame
 * takes over the same row.
 */
import type { MediaRef } from '../../composer/media';
import type { Block, SessionViewState, UserBlock } from './types';

export interface PendingSteer {
  readonly promptId: string;
  readonly userMessageId?: string;
  readonly text: string;
  readonly presentation?: import('@kiki/transcript').TextPresentation;
  readonly media?: readonly MediaRef[];
  readonly createdAt: string;
  readonly phase: NonNullable<UserBlock['steerStatus']>;
}

/** Client-chosen prompt id for a "send now"; the engine keeps it end to end. */
export function newSteerPromptId(): string {
  return `msg_now_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
}

function matchesPrompt(block: UserBlock, promptId: string): boolean {
  return block.promptId === promptId || block.userMessageId === promptId;
}

/**
 * The prompt already shows as a real message and the echo must yield:
 *  - its delivered frame, owned by a turn (same id — the engine keeps the
 *    client's prompt id on the steered context message);
 *  - its own running turn (the agent went idle before the steer);
 *  - a settled outcome (the turn was stopped before the next step).
 * A queued preview does not count — the timeline hides it. For a server that
 * still mints a fresh id for the merged steer message, a turn-owned user
 * block with the same text written after the echo is taken as its delivery.
 */
export function isSteerSettled(blocks: readonly Block[], steer: PendingSteer): boolean {
  const since = Date.parse(steer.createdAt);
  return blocks.some((block) => {
    if (block.kind !== 'user' || block.steerStatus !== undefined) return false;
    if (matchesPrompt(block, steer.promptId)) {
      return block.turnId !== undefined || block.promptStatus === 'running' || block.promptStatus === 'blocked' || block.promptOutcome !== undefined;
    }
    return steer.phase === 'waiting' && block.turnId !== undefined && block.text === steer.text &&
      block.promptId === undefined && Date.parse(block.createdAt) >= since;
  });
}

export function steerBlock(steer: PendingSteer): UserBlock {
  return {
    kind: 'user',
    // Same id the projection gives the delivered frame (`user-${messageId}`).
    id: `user-${steer.userMessageId ?? steer.promptId}`,
    text: steer.text,
    presentation: steer.presentation,
    media: steer.media,
    createdAt: steer.createdAt,
    promptId: steer.promptId,
    userMessageId: steer.userMessageId ?? steer.promptId,
    steerStatus: steer.phase,
  };
}

/**
 * Lay pending steers over a projected view: each one sits at the tail (where
 * its delivery will land), its queued preview and queue-strip slot are
 * removed, and a settled one is left to the projection. Returns `state`
 * itself when nothing is pending, so unchanged publishes keep identity.
 */
export function withPendingSteers(state: SessionViewState, steers: readonly PendingSteer[]): SessionViewState {
  const live = steers.filter((steer) => !isSteerSettled(state.blocks, steer));
  if (live.length === 0) return state;
  const ids = new Set(live.map((steer) => steer.promptId));
  const blocks = state.blocks.filter((block) =>
    block.kind !== 'user' || ![...ids].some((id) => matchesPrompt(block, id)));
  const queuedPromptIds = state.queuedPromptIds.some((id) => ids.has(id))
    ? state.queuedPromptIds.filter((id) => !ids.has(id))
    : state.queuedPromptIds;
  return { ...state, blocks: [...blocks, ...live.map(steerBlock)], queuedPromptIds };
}

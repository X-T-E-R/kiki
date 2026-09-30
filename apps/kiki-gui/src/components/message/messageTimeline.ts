/**
 * Pure projection glue between session-core's `projectMessageView` and the
 * GUI's message rows: which turns are complete, who is speaking, whether a
 * row continues the previous speaker, and what the presence line says.
 */

import {
  projectMessageView,
  type ActivitySummary,
  type Block,
  type MessageBlock,
  type MessageViewNode,
  type UserBlock,
} from '@kiki/session-core/session';

function turnOf(block: Block): string | undefined {
  if (block.kind === 'subagent') return block.parentTurnId;
  if (block.kind === 'question' || block.kind === 'approval') {
    return block.request.turn_id === undefined ? undefined : `t${block.request.turn_id}`;
  }
  return block.turnId;
}

/**
 * Every turn on the page is complete except the one still running. The live
 * turn is the last turn id seen while the session is busy.
 */
export function completedTurnIds(blocks: readonly Block[], busy: boolean): string[] {
  const turns: string[] = [];
  for (const block of blocks) {
    const turn = turnOf(block);
    if (turn !== undefined && !turns.includes(turn)) turns.push(turn);
  }
  return busy ? turns.slice(0, -1) : turns;
}

/** A Bot message addressed to another Bot reads as a handoff line, not as speech to the user. */
export function isHandoffMessage(block: MessageBlock): boolean {
  return block.handoff !== undefined;
}

/** An inbound message another Bot sent into this session. */
export function isInboundHandoff(block: UserBlock): boolean {
  return block.peerThread?.personaId !== undefined || block.peerThread?.senderName !== undefined;
}

export function buildMessageNodes(
  blocks: readonly Block[],
  options: { readonly busy: boolean; readonly personaName?: string },
): MessageViewNode[] {
  return projectMessageView(blocks, {
    completedTurnIds: completedTurnIds(blocks, options.busy),
    personaName: options.personaName,
  });
}

/** Speaker identity for continuity: the persona id, 'user', or undefined for anything that breaks a run. */
export function speakerKey(node: MessageViewNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.kind === 'message') {
    if (node.status === 'failed' || node.status === 'cancelled' || isHandoffMessage(node)) return undefined;
    return `bot:${node.personaId ?? 'self'}`;
  }
  if (node.kind === 'question') return 'bot:self';
  if (node.kind === 'user') return isInboundHandoff(node) ? undefined : 'user';
  return undefined;
}

/** What the presence line should say while the turn runs, if anything. */
export type Presence =
  | { readonly kind: 'typing' }
  | { readonly kind: 'working'; readonly reads: number; readonly commands: number; readonly steps: number };

export function presenceOf(nodes: readonly MessageViewNode[], busy: boolean): Presence | undefined {
  if (!busy) return undefined;
  const last = nodes[nodes.length - 1];
  if (last?.kind === 'message' && last.status === 'sending') {
    // The growing draft is the signal once text arrives; before that the
    // call has started but nothing is readable yet.
    const args = last.sourceTool?.argsText ?? '';
    return /"text"\s*:\s*"[^"]/.test(args) || last.text !== '' ? undefined : { kind: 'typing' };
  }
  if (last?.kind === 'question' || last?.kind === 'approval') return undefined;
  const summary = last?.kind === 'activity-summary' ? last as ActivitySummary : undefined;
  const steps = summary === undefined ? 0 : summary.members.filter((member) => member.kind === 'tool' || member.kind === 'shell').length;
  return { kind: 'working', reads: summary?.counts.reads ?? 0, commands: summary?.counts.commands ?? 0, steps };
}

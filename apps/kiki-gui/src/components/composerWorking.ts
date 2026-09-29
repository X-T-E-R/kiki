import { useEffect, useRef, useState } from 'react';

import type { Block } from '@kiki/session-core/session';

/**
 * A fingerprint of the newest agent output in a block list: it changes when
 * the agent streams text, starts or finishes a tool, or a subagent moves, and
 * stays put for the user's own rows (a queued prompt, an approval answer).
 */
export function agentOutputSignature(blocks: readonly Block[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    switch (block.kind) {
      case 'assistant':
      case 'thinking':
        return `${block.id}:${block.text.length}:${block.streaming ? 1 : 0}`;
      case 'tool':
        return `${block.id}:${block.status}:${block.progressText ?? ''}`;
      case 'shell':
        return `${block.id}:${block.output.length}:${block.done ? 1 : 0}`;
      case 'subagent':
        return `${block.id}:${block.status}:${block.toolCallCount}`;
      default:
        break;
    }
  }
  return undefined;
}

/** Epoch ms of the newest agent output whose own timestamp is known. */
function latestAgentTimestamp(blocks: readonly Block[]): number | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'assistant' || block.kind === 'thinking') {
      const at = block.createdAt === undefined ? Number.NaN : Date.parse(block.createdAt);
      if (!Number.isNaN(at)) return at;
    } else if ((block.kind === 'tool' || block.kind === 'shell') && block.startedAt !== undefined) {
      return block.startedAt;
    }
  }
  return undefined;
}

/**
 * When the agent last produced output during the running turn, for the
 * composer's working line. Seeded from the newest timestamped agent block of
 * this turn (so a reload mid-turn does not reset it to "just now"), then
 * advanced to the receive time on every change of the agent-output
 * fingerprint. `undefined` while idle, and before the turn's first output.
 */
export function useLastResponseAt(
  busy: boolean,
  blocks: readonly Block[],
  turnStartedAt: number | undefined,
): number | undefined {
  const signature = agentOutputSignature(blocks);
  const seenRef = useRef<string | undefined>(undefined);
  const [at, setAt] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!busy) {
      seenRef.current = undefined;
      setAt(undefined);
      return;
    }
    if (seenRef.current === undefined) {
      // Rising edge: output already on screen predates this mount.
      seenRef.current = signature ?? '';
      const seeded = latestAgentTimestamp(blocks);
      setAt(seeded !== undefined && (turnStartedAt === undefined || seeded >= turnStartedAt) ? seeded : undefined);
      return;
    }
    if (signature !== undefined && signature !== seenRef.current) {
      seenRef.current = signature;
      setAt(Date.now());
    }
    // blocks is read only on the rising edge; the signature carries changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, signature, turnStartedAt]);
  return at;
}

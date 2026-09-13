export type SubagentToolCalls = { count: number; known: boolean };

type ToolCallTally = { toolCallCount: number; toolCallCountKnown?: boolean };

/**
 * Resolve the tool-call tally a subagent card should display.
 *
 * The forest node carries the AUTHORITATIVE rollup — the session core
 * refreshes it on every child update and may revise it DOWN (a stale
 * over-count corrected, or known-ness withdrawn). Parent-timeline blocks
 * keep the snapshot they were projected with and are not re-projected, so a
 * block can hold an outdated larger count. A declared node value therefore
 * always wins over the block; the block's own declaration is the fallback;
 * and only when nothing declares do we keep the legacy behavior — the max of
 * the raw counts, treated as trustworthy (legacy blocks predate the flag).
 */
export function resolveSubagentToolCalls(
  block: ToolCallTally | undefined,
  node: ToolCallTally | undefined,
): SubagentToolCalls {
  if (node !== undefined) {
    if (node.toolCallCountKnown === true) return { count: node.toolCallCount, known: true };
    if (node.toolCallCountKnown === false) return { count: node.toolCallCount, known: false };
  }
  if (block !== undefined) {
    if (block.toolCallCountKnown === true) return { count: block.toolCallCount, known: true };
    if (block.toolCallCountKnown === false) return { count: block.toolCallCount, known: false };
  }
  return { count: Math.max(block?.toolCallCount ?? 0, node?.toolCallCount ?? 0), known: true };
}

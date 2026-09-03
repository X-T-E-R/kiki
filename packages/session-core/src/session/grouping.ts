/**
 * Tool-group folding for the transcript (aionui's MessageToolGroupSummary
 * pattern — https://github.com/AionUi/AionUi, Apache-2.0 — as a pure
 * reducer-side grouping): runs of ≥2 consecutive tool blocks fold into one
 * "Steps · N" node; single tools stay bare; any other block breaks a run.
 * Grouping is a render-time projection — the underlying block list (and its
 * reducer semantics) is untouched.
 */

import type { Block, ToolBlock } from './transcript';

export interface ToolGroup {
  readonly kind: 'tool-group';
  /** Stable id derived from the first tool in the run. */
  readonly id: string;
  readonly tools: readonly ToolBlock[];
}

export type DisplayNode = Block | ToolGroup;

export function groupBlocks(blocks: readonly Block[]): DisplayNode[] {
  const nodes: DisplayNode[] = [];
  let run: ToolBlock[] = [];

  const flush = () => {
    if (run.length >= 2) {
      nodes.push({ kind: 'tool-group', id: `group-${run[0]!.id}`, tools: run });
    } else if (run.length === 1) {
      nodes.push(run[0]!);
    }
    run = [];
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      run.push(block);
    } else {
      flush();
      nodes.push(block);
    }
  }
  flush();
  return nodes;
}

export function groupHasRunning(group: ToolGroup): boolean {
  return group.tools.some((tool) => tool.status === 'running');
}

export function groupHasError(group: ToolGroup): boolean {
  return group.tools.some((tool) => tool.status === 'error');
}

/** One-line names preview for the collapsed summary, e.g. "Read, Edit, Bash". */
export function groupToolNames(group: ToolGroup, max = 4): string {
  const names = group.tools.map((tool) => tool.name);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

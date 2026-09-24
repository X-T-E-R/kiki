/**
 * Step folding for the transcript (aionui's MessageToolGroupSummary
 * pattern — https://github.com/AionUi/AionUi, Apache-2.0 — as a pure
 * reducer-side grouping): a step is a block that carries no assistant prose —
 * tool calls, shell runs, and thinking. Runs of ≥2 consecutive steps fold
 * into one "Steps · N" node; single steps and any other block stay bare.
 * Grouping is a render-time projection — the underlying block list (and its
 * reducer semantics) is untouched.
 *
 * Never folded (they break a run by definition): user and assistant text,
 * subagent cards and lifecycle events, approvals, questions, notices,
 * system/skill blocks — anything the user must read or act on.
 */

import type { Block, ShellBlock, ThinkingBlock, ToolBlock } from './transcript';

export interface ToolGroup {
  readonly kind: 'tool-group';
  /** Stable id derived from the first step in the run. */
  readonly id: string;
  /**
   * The run's steps in ORIGINAL occurrence order — the expanded view renders
   * this, never the per-kind lists, so Read → shell → thinking → Edit stays
   * in the order it happened.
   */
  readonly members: readonly Block[];
  /** Tool calls in the run, in order (summary aggregation only). */
  readonly tools: readonly ToolBlock[];
  /** Shell runs in the run, in order (summary aggregation only). */
  readonly shells: readonly ShellBlock[];
  /** Thinking blocks in the run, in order (summary aggregation only). */
  readonly thinking: readonly ThinkingBlock[];
  /** Total member count (tools + shells + thinking). */
  readonly count: number;
  /** Epoch ms of the earliest member start; undefined when none is known. */
  readonly startedAt: number | undefined;
  /**
   * Sum of per-member wall-clock durations that carry a real `'frame'`
   * source; turn-level fallbacks and unknown timings are excluded so the
   * summary never presents a fabricated total.
   */
  readonly durationMs: number | undefined;
}

export type DisplayNode = Block | ToolGroup;

/** A step: tool call, shell run, or thinking — no assistant prose. */
function isStepBlock(block: Block): boolean {
  return block.kind === 'tool' || block.kind === 'shell' || block.kind === 'thinking';
}

export function groupBlocks(blocks: readonly Block[]): DisplayNode[] {
  const nodes: DisplayNode[] = [];
  let run: Block[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const tools = run.filter((block): block is ToolBlock => block.kind === 'tool');
      const shells = run.filter((block): block is ShellBlock => block.kind === 'shell');
      const thinking = run.filter((block): block is ThinkingBlock => block.kind === 'thinking');
      const starts = run
        .map((block) => (block.kind === 'tool' || block.kind === 'shell' ? block.startedAt : undefined))
        .filter((start): start is number => start !== undefined);
      let duration: number | undefined;
      let framed = false;
      for (const block of run) {
        const own =
          block.kind === 'tool' && block.durationSource === 'frame' ? block.durationMs : undefined;
        if (own !== undefined) {
          framed = true;
          duration = (duration ?? 0) + own;
        }
      }
      nodes.push({
        kind: 'tool-group',
        id: `group-${run[0]!.id}`,
        members: run,
        tools,
        shells,
        thinking,
        count: run.length,
        startedAt: starts.length > 0 ? Math.min(...starts) : undefined,
        durationMs: framed ? duration : undefined,
      });
    } else if (run.length === 1) {
      nodes.push(run[0]!);
    }
    run = [];
  };

  for (const block of blocks) {
    if (isStepBlock(block)) {
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
  return (
    group.tools.some((tool) => tool.status === 'running') ||
    group.shells.some((shell) => !shell.done)
  );
}

export function groupHasError(group: ToolGroup): boolean {
  return (
    group.tools.some((tool) => tool.status === 'error' || tool.isError === true) ||
    group.shells.some((shell) => shell.isError === true)
  );
}

/** One-line names preview for the collapsed summary, e.g. "Read, Edit, Bash". */
export function groupToolNames(group: ToolGroup, max = 4): string {
  const names = group.tools.map((tool) => tool.name);
  if (group.shells.length > 0) names.push('shell');
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

/**
 * Read-run folding for the transcript (aionui's MessageToolGroupSummary
 * pattern — https://github.com/AionUi/AionUi, Apache-2.0 — as a pure
 * reducer-side grouping). Opt-in (the `foldSteps` preference is off by
 * default): settled actions stay in place in the timeline, and only a run of
 * ≥3 consecutive PURE READS (read / list / search / fetch) folds into one
 * summary line that still names every object it looked at.
 *
 * Anything that changes the world or carries the agent's voice breaks a run:
 * edits, writes, shell commands, thinking, assistant/user text, subagent
 * cards and lifecycle events, approvals, questions, notices, system/skill
 * blocks, and the memory tools. Grouping is a render-time projection — the
 * underlying block list (and its reducer semantics) is untouched.
 */

import type { Block, ShellBlock, ThinkingBlock, ToolBlock } from './transcript';

export interface ToolGroup {
  readonly kind: 'tool-group';
  /** Stable id derived from the first step in the run. */
  readonly id: string;
  /**
   * The run's steps in ORIGINAL occurrence order — the expanded view renders
   * this, never the per-kind lists.
   */
  readonly members: readonly Block[];
  /** Tool calls in the run, in order (summary aggregation only). */
  readonly tools: readonly ToolBlock[];
  /** Shell runs in the run (always empty for read runs; kept for the shape). */
  readonly shells: readonly ShellBlock[];
  /** Thinking blocks in the run (always empty for read runs; kept for the shape). */
  readonly thinking: readonly ThinkingBlock[];
  /** Total member count. */
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

export type DisplayNode = Block | ToolGroup | HistoryFold;

/**
 * A settled stretch of work between two messages of a FINISHED turn, folded
 * into one expandable line ("Worked · 12 steps · 3 thoughts"). Members keep
 * their order and identity; the fold is a render-time projection only.
 */
export interface HistoryFold {
  readonly kind: 'history-fold';
  /** Stable id from the first member (survives turns appending below). */
  readonly id: string;
  readonly turnId: string | undefined;
  /** Members in occurrence order; read runs stay folded inside. */
  readonly members: readonly (Block | ToolGroup)[];
  /** Tool calls + shell runs (a read run counts each read). */
  readonly steps: number;
  readonly thoughts: number;
  /** Reminders, system injections, skills and quiet notices. */
  readonly notes: number;
  readonly failed: number;
  /** Sum of real per-tool frame durations; undefined when none is known. */
  readonly durationMs: number | undefined;
}

/** A stretch this short reads faster in place than behind a fold. */
export const HISTORY_FOLD_MIN = 2;

function foldTurnId(node: Block | ToolGroup): string | undefined {
  if (node.kind === 'tool-group') return node.tools[0]?.turnId;
  if (node.kind === 'subagent') return node.parentTurnId;
  if (node.kind === 'approval') return node.request.turn_id === undefined ? undefined : `t${node.request.turn_id}`;
  if (node.kind === 'question') return node.request.turn_id === undefined ? undefined : `t${node.request.turn_id}`;
  return node.turnId;
}

function normTurn(turnId: string | undefined): string | undefined {
  if (turnId === undefined) return undefined;
  return turnId.startsWith('t') ? turnId : `t${turnId}`;
}

/**
 * What may disappear into a fold: the agent's settled process, never its
 * voice, the user, a boundary, or anything that still wants attention.
 * Subagent cards and lifecycle rows stay out — they are navigation targets.
 */
function foldable(node: Block | ToolGroup): boolean {
  switch (node.kind) {
    case 'tool-group':
      return !groupHasRunning(node);
    case 'tool':
      return node.status !== 'running' && !isMemoryToolName(node.name);
    case 'shell':
      return node.done;
    case 'thinking':
      return !node.streaming;
    case 'system-reminder':
    case 'skill':
      return true;
    case 'system':
      return node.variant !== 'compaction_summary';
    case 'notice':
      return node.tone === 'neutral' && node.executor !== undefined && node.executor.kind !== 'compaction';
    case 'approval':
      return node.resolution !== undefined;
    case 'question':
      return node.outcome !== undefined;
    default:
      return false;
  }
}

function nodeFailed(node: Block | ToolGroup): boolean {
  if (node.kind === 'tool-group') return groupHasError(node);
  if (node.kind === 'tool') return node.status === 'error' || node.isError === true;
  if (node.kind === 'shell') return node.isError === true;
  return false;
}

function buildFold(run: readonly (Block | ToolGroup)[], turnId: string | undefined): HistoryFold {
  let steps = 0;
  let thoughts = 0;
  let notes = 0;
  let failed = 0;
  let duration: number | undefined;
  const addDuration = (tool: ToolBlock) => {
    if (tool.durationSource === 'frame' && tool.durationMs !== undefined) duration = (duration ?? 0) + tool.durationMs;
  };
  for (const node of run) {
    if (node.kind === 'tool-group') {
      failed += node.tools.filter((tool) => tool.status === 'error' || tool.isError === true).length;
    } else if (nodeFailed(node)) {
      failed += 1;
    }
    if (node.kind === 'tool-group') {
      steps += node.count;
      node.tools.forEach(addDuration);
    } else if (node.kind === 'tool') {
      steps += 1;
      addDuration(node);
    } else if (node.kind === 'shell') {
      steps += 1;
    } else if (node.kind === 'thinking') {
      thoughts += 1;
    } else {
      notes += 1;
    }
  }
  return { kind: 'history-fold', id: `fold-${run[0]!.id}`, turnId, members: run, steps, thoughts, notes, failed, durationMs: duration };
}

/** The latest turn on the page: the one a fold must leave open. */
export function latestTurnId(nodes: readonly DisplayNode[]): string | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    const turn = node.kind === 'history-fold' ? node.turnId : foldTurnId(node);
    if (turn !== undefined) return normTurn(turn);
  }
  return undefined;
}

/**
 * Fold settled history: inside every finished turn, each run of ≥2
 * consecutive process rows (tools, read runs, shell, thinking, reminders,
 * settled decisions, engine notes) becomes one `HistoryFold`. The turn in
 * progress (`liveTurnId`) and turn-less rows are never folded, and a run
 * breaks at anything the user reads: messages, subagent cards, dividers.
 */
export function foldHistory(
  nodes: readonly DisplayNode[],
  liveTurnId: string | undefined,
): DisplayNode[] {
  const live = normTurn(liveTurnId);
  const out: DisplayNode[] = [];
  let run: (Block | ToolGroup)[] = [];
  let runTurn: string | undefined;
  const flush = () => {
    if (run.length >= HISTORY_FOLD_MIN) out.push(buildFold(run, runTurn));
    else out.push(...run);
    run = [];
    runTurn = undefined;
  };
  for (const node of nodes) {
    if (node.kind === 'history-fold') {
      flush();
      out.push(node);
      continue;
    }
    const turn = normTurn(foldTurnId(node));
    const eligible = turn !== undefined && turn !== live && foldable(node);
    if (!eligible || (run.length > 0 && turn !== runTurn)) flush();
    if (eligible) {
      run.push(node);
      runTurn = turn;
    } else {
      out.push(node);
    }
  }
  flush();
  return out;
}

/** Minimum run length that folds. Two reads are cheaper to show than to hide. */
export const READ_RUN_MIN = 3;

/**
 * The memory tools. Their rows are already one quiet line and carry the
 * write's own actions (view, undo), so folding them would hide an action
 * behind an expand — the same reason approvals are never folded.
 */
const MEMORY_TOOL_NAMES: readonly string[] = ['MemoryWrite', 'MemoryRead', 'MemorySearch'];

export function isMemoryToolName(name: string): boolean {
  return MEMORY_TOOL_NAMES.includes(name);
}

/** What a step did to its object, in the summary's vocabulary. */
export type StepVerb = 'read' | 'list' | 'search' | 'fetch' | 'edit' | 'create' | 'run' | 'other';

const READ_VERBS: ReadonlySet<StepVerb> = new Set(['read', 'list', 'search', 'fetch']);

export interface StepObject {
  readonly verb: StepVerb;
  /** Short human object: a file's basename, a pattern, a query, a host/path. */
  readonly target: string | undefined;
}

function stringField(record: unknown, ...keys: readonly string[]): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Last path segment; keeps glob patterns and bare names intact. */
function basename(path: string): string {
  if (/[*?[\]{}]/.test(path)) return path;
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function clip(text: string, limit = 48): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function verbFromName(name: string): StepVerb {
  const lower = name.toLowerCase();
  if (/bash|shell|cmd|exec/.test(lower)) return 'run';
  if (/multiedit|edit|str_replace|patch/.test(lower)) return 'edit';
  if (/write|create/.test(lower)) return 'create';
  if (/fetch|browse/.test(lower)) return 'fetch';
  if (/grep|search/.test(lower)) return 'search';
  if (/glob|^ls$|list/.test(lower)) return 'list';
  if (/read|view|cat/.test(lower)) return 'read';
  return 'other';
}

/** The verb + object a tool call acted on, from its display payload or args. */
export function stepObject(block: ToolBlock): StepObject {
  const display = block.display as { kind?: string } | undefined;
  switch (display?.kind) {
    case 'file_io': {
      const d = display as { operation?: string; path?: string; before?: unknown };
      const path = d.path === undefined ? undefined : basename(d.path);
      const verb: StepVerb =
        d.operation === 'read' ? 'read'
          : d.operation === 'edit' ? 'edit'
            : d.operation === 'write' ? (typeof d.before === 'string' ? 'edit' : 'create')
              : d.operation === 'grep' ? 'search'
                : 'list';
      return { verb, target: path };
    }
    case 'diff':
      return { verb: 'edit', target: stringField(display, 'path') === undefined ? undefined : basename(stringField(display, 'path')!) };
    case 'search':
      return { verb: 'search', target: stringField(display, 'query') === undefined ? undefined : clip(stringField(display, 'query')!) };
    case 'url_fetch':
      return { verb: 'fetch', target: stringField(display, 'url') === undefined ? undefined : clip(shortUrl(stringField(display, 'url')!)) };
    case 'command':
      return { verb: 'run', target: stringField(display, 'command') === undefined ? undefined : clip(stringField(display, 'command')!) };
    case undefined:
      break;
    default:
      return { verb: 'other', target: undefined };
  }
  const verb = verbFromName(block.name);
  const path = stringField(block.args, 'file_path', 'path');
  const query = stringField(block.args, 'pattern', 'query');
  const url = stringField(block.args, 'url');
  const command = stringField(block.args, 'command');
  const target =
    verb === 'run' ? (command === undefined ? undefined : clip(command))
      : verb === 'fetch' ? (url === undefined ? undefined : clip(shortUrl(url)))
        : verb === 'search' || verb === 'list' ? (query ?? (path === undefined ? undefined : basename(path)))
          : path === undefined ? undefined : basename(path);
  return { verb, target: target === undefined ? undefined : clip(target) };
}

/** A pure read: a non-memory tool call that only looks at the world. */
export function isReadStep(block: Block): block is ToolBlock {
  if (block.kind !== 'tool' || isMemoryToolName(block.name)) return false;
  return READ_VERBS.has(stepObject(block).verb);
}

export function groupBlocks(blocks: readonly Block[]): DisplayNode[] {
  const nodes: DisplayNode[] = [];
  let run: ToolBlock[] = [];

  const flush = () => {
    if (run.length >= READ_RUN_MIN) {
      const starts = run
        .map((block) => block.startedAt)
        .filter((start): start is number => start !== undefined);
      let duration: number | undefined;
      for (const block of run) {
        if (block.durationSource === 'frame' && block.durationMs !== undefined) {
          duration = (duration ?? 0) + block.durationMs;
        }
      }
      nodes.push({
        kind: 'tool-group',
        id: `group-${run[0]!.id}`,
        members: run,
        tools: run,
        shells: [],
        thinking: [],
        count: run.length,
        startedAt: starts.length > 0 ? Math.min(...starts) : undefined,
        durationMs: duration,
      });
    } else {
      nodes.push(...run);
    }
    run = [];
  };

  for (const block of blocks) {
    if (isReadStep(block)) {
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

export interface StepSummaryPart {
  readonly verb: StepVerb;
  /** Distinct objects in first-seen order, capped. */
  readonly targets: readonly string[];
  /** Objects beyond the cap (rendered as "+N"). */
  readonly more: number;
}

/**
 * The folded line's object summary: consecutive steps with the same verb
 * share one verb ("read plan.ts, notes.md · searched *.ts"), objects are
 * de-duplicated, and each verb lists at most `maxTargets` objects.
 */
export function groupSummary(group: ToolGroup, maxTargets = 3): StepSummaryPart[] {
  const parts: { verb: StepVerb; targets: string[]; more: number }[] = [];
  for (const tool of group.tools) {
    const { verb, target } = stepObject(tool);
    let part = parts.at(-1);
    if (part?.verb !== verb) {
      part = { verb, targets: [], more: 0 };
      parts.push(part);
    }
    if (target === undefined || part.targets.includes(target)) continue;
    if (part.targets.length < maxTargets) part.targets.push(target);
    else part.more += 1;
  }
  return parts;
}

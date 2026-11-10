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
 * blocks. Ordinary memory reads follow the same read-run rules. Grouping is a
 * render-time projection — the underlying block list is untouched.
 */

import { extractToolOutputMedia, toolResultMedia } from '../composer/media';
import type { AgentForest, AgentStatus } from './agentTree';
import { mergeTaskNotifications } from './transcript/project';
import type { Block, ShellBlock, SubagentBlock, SystemBlock, ThinkingBlock, ToolBlock } from './transcript';

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

export type DisplayNode = Block | ToolGroup | HistoryFold | SubagentGroup | MediaRun | SubagentEnding;

export type SubagentOutcome = 'completed' | 'failed' | 'cancelled' | 'timedOut';

/**
 * A subagent's run ended in a later turn than the one that dispatched it:
 * the task notification, read as the agent it is about. When the dispatch
 * sits in the same turn the card itself carries the end and no row is made.
 */
export interface SubagentEnding {
  readonly kind: 'subagent-ended';
  readonly id: string;
  readonly turnId: string | undefined;
  readonly agentId: string;
  readonly taskId: string;
  readonly task?: EndingTask;
  readonly outcome: SubagentOutcome;
  /** The notification this row stands for (its text is the fallback receipt). */
  readonly note: SystemBlock;
  /** The dispatch card is on this page, so the row can point back to it. */
  readonly dispatchOnPage: boolean;
  /** Specific run card id on this page when multiple runs exist for the same agent. */
  readonly dispatchCardId?: string;
}

/**
 * Two or more subagents dispatched together while at least one still runs:
 * one head line ("Dispatched 4 subagents · 2/4 done") with a row per agent.
 * Once all settle, the members join the surrounding fold like any process.
 */
export interface SubagentGroup {
  readonly kind: 'subagent-group';
  /** Stable id from the first card (survives agents appending). */
  readonly id: string;
  readonly turnId: string | undefined;
  readonly members: readonly SubagentBlock[];
}

/**
 * Consecutive image-returning tool calls (ReadMediaFile, screenshot tools):
 * what the agent looked at. Always its own row; a fold stops at it and
 * resumes after it. `latest` marks the run that ends the live turn, which
 * renders a preview instead of the thumbnail strip.
 */
export interface MediaRun {
  readonly kind: 'media-run';
  readonly id: string;
  readonly turnId: string | undefined;
  readonly members: readonly ToolBlock[];
  readonly latest: boolean;
}

/**
 * A settled stretch of process between two things the reader reads, folded
 * into one expandable line ("Worked · 12 steps · 3 thoughts · 4 subagents").
 * Members keep their order and identity; the fold is a render-time projection.
 */
export interface HistoryFold {
  readonly kind: 'history-fold';
  /** Stable id from the first member (survives turns appending below). */
  readonly id: string;
  readonly turnId: string | undefined;
  /** Members in occurrence order; read runs stay folded inside. */
  readonly members: readonly (Block | ToolGroup | SubagentEnding)[];
  /** Tool calls + shell runs (a read run counts each read). */
  readonly steps: number;
  readonly thoughts: number;
  /** Subagent cards folded in (each dispatched agent once). */
  readonly agents: number;
  /** Subagent runs that completed in this stretch (their end rows folded in). */
  readonly agentsDone: number;
  /** Reminders, system injections, skills and quiet notices. */
  readonly notes: number;
  readonly failed: number;
  /** Sum of real per-tool frame durations; undefined when none is known. */
  readonly durationMs: number | undefined;
  /** Delivered AgentSend messages folded in this contiguous process stretch, grouped by target agent. */
  readonly sentMessages?: readonly { readonly subagentId: string; readonly name: string; readonly count: number }[];
}

/** What a fold can hold. */
type Row = Block | ToolGroup | SubagentEnding;

/** A stretch this short reads faster in place than behind a fold. */
export const HISTORY_FOLD_MIN = 2;

function foldTurnId(node: Block | ToolGroup | SubagentGroup | MediaRun | SubagentEnding): string | undefined {
  if (node.kind === 'tool-group') return node.tools[0]?.turnId;
  if (node.kind === 'subagent-group' || node.kind === 'media-run' || node.kind === 'subagent-ended') return node.turnId;
  if (node.kind === 'subagent') return node.parentTurnId;
  if (node.kind === 'approval') return node.request.turn_id === undefined ? undefined : `t${node.request.turn_id}`;
  if (node.kind === 'question') return node.request.turn_id === undefined ? undefined : `t${node.request.turn_id}`;
  return node.turnId;
}

function normTurn(turnId: string | undefined): string | undefined {
  if (turnId === undefined) return undefined;
  return turnId.startsWith('t') ? turnId : `t${turnId}`;
}

/** An agent status whose run is still active or waiting on user input. */
export function isLiveSubagentStatus(status: AgentStatus | SubagentBlock['status'] | string): boolean {
  return status === 'running' || status === 'background' || status === 'suspended';
}

/** Resolve the effective status of a subagent card against the live forest. */
export function effectiveSubagentStatus(
  block: SubagentBlock,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
): AgentStatus | SubagentBlock['status'] {
  const isLatestRun = latestCardIdByAgent === undefined || latestCardIdByAgent.get(block.subagentId) === block.id;
  if (!isLatestRun) return block.status;
  return forest?.byId[block.subagentId]?.status ?? block.status;
}

/** A subagent whose run is still going (it needs watching, so it stays out). */
export function subagentLive(
  block: SubagentBlock,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
): boolean {
  return isLiveSubagentStatus(effectiveSubagentStatus(block, forest, latestCardIdByAgent));
}

/**
 * A tool call whose result is an image the agent looked at (ReadMediaFile,
 * a screenshot MCP, a browser capture). Recognised by the result itself, so
 * any image-returning tool qualifies without a name list — whether the image
 * arrives as an engine content part or as the result's own attachment.
 */
export function isMediaTool(block: Block): block is ToolBlock {
  if (block.kind !== 'tool' || block.status === 'running') return false;
  const media = toolResultMedia(block.media, extractToolOutputMedia(block.output)?.media, undefined, true, block.outputPending === true);
  return media.some((item) => item.kind === 'image');
}

/**
 * What may disappear into a fold: the agent's settled process, never its
 * voice, the user, a boundary, or anything that still wants attention.
 * A settled subagent card is process too (its conclusion is the answer that
 * follows); a live one stays out until it settles.
 */
function isFailedTaskSystemBlock(node: SystemBlock): boolean {
  if (node.variant !== 'task') return false;
  if (node.taskNotification?.severity === 'warning' || node.taskNotification?.severity === 'error') return true;
  if (node.taskNotification?.type === 'task.failed' || node.taskNotification?.status === 'failed') return true;
  const firstLine = node.text.split('\n', 1)[0] ?? '';
  return (
    /^(?:Title:\s*)?Background \S+ (?:failed|timed_out|killed|lost)\b/i.test(firstLine) ||
    /^Severity:\s*warning\s*$/m.test(node.text)
  );
}

function subagentFailed(
  block: SubagentBlock,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
): boolean {
  const status = effectiveSubagentStatus(block, forest, latestCardIdByAgent);
  if (isLiveSubagentStatus(status)) return false;
  if (status === 'failed' || status === 'lost') return true;
  const isLatestRun = latestCardIdByAgent === undefined || latestCardIdByAgent.get(block.subagentId) === block.id;
  const error = isLatestRun ? (forest?.byId[block.subagentId]?.error ?? block.error) : block.error;
  return error !== undefined && error !== '';
}

function foldable(
  node: Row,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
): boolean {
  switch (node.kind) {
    case 'subagent-ended':
      // A cross-turn or separated subagent ending stays in view at its first
      // recorded result position as a named, independently expandable summary.
      return false;
    case 'subagent-event':
      return (
        node.event === 'sent' &&
        node.delivery === 'delivered' &&
        node.status !== 'running' &&
        node.status !== 'failed' &&
        node.error === undefined
      );
    case 'tool-group':
      return !groupHasRunning(node);
    case 'tool':
      return node.status !== 'running';
    case 'shell':
      return node.done;
    case 'thinking':
      return !node.streaming;
    case 'subagent':
      return !subagentLive(node, forest, latestCardIdByAgent);
    case 'system-reminder':
    case 'skill':
      return true;
    case 'system':
      if (node.variant === 'compaction_summary') return false;
      if (node.variant === 'task' && isFailedTaskSystemBlock(node)) return false;
      return true;
    case 'notice':
      // Text an external client saved stays in view: its body is the reason
      // the row exists, and folding it away would hide a record the session
      // was asked to keep.
      if (node.externalText !== undefined) return false;
      return node.tone === 'neutral' && node.executor !== undefined && node.executor.kind !== 'compaction';
    case 'approval':
      return node.resolution !== undefined;
    case 'question':
      return false;
    default:
      return false;
  }
}

function nodeFailed(
  node: Row,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
): boolean {
  if (node.kind === 'tool-group') return groupHasError(node);
  if (node.kind === 'tool') return node.status === 'error' || node.isError === true;
  if (node.kind === 'shell') return node.isError === true;
  if (node.kind === 'subagent') return subagentFailed(node, forest, latestCardIdByAgent);
  return false;
}

function buildFold(
  run: readonly Row[],
  turnId: string | undefined,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
): HistoryFold {
  let steps = 0;
  let thoughts = 0;
  let agents = 0;
  let agentsDone = 0;
  let notes = 0;
  let failed = 0;
  let duration: number | undefined;
  const sentMap = new Map<string, { subagentId: string; name: string; count: number }>();
  const addDuration = (tool: ToolBlock) => {
    if (tool.durationSource === 'frame' && tool.durationMs !== undefined) duration = (duration ?? 0) + tool.durationMs;
  };
  for (const node of run) {
    if (node.kind === 'tool-group') {
      failed += node.tools.filter((tool) => tool.status === 'error' || tool.isError === true).length;
    } else if (nodeFailed(node, forest, latestCardIdByAgent)) {
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
    } else if (node.kind === 'subagent') {
      agents += 1;
    } else if (node.kind === 'subagent-ended') {
      agentsDone += 1;
    } else if (node.kind === 'subagent-event' && node.event === 'sent') {
      const existing = sentMap.get(node.subagentId);
      if (existing === undefined) {
        sentMap.set(node.subagentId, { subagentId: node.subagentId, name: node.name, count: 1 });
      } else {
        sentMap.set(node.subagentId, { ...existing, count: existing.count + 1 });
      }
    } else {
      notes += 1;
    }
  }
  const sentMessages = sentMap.size > 0 ? [...sentMap.values()] : undefined;
  return {
    kind: 'history-fold', id: `fold-${run[0]!.id}`, turnId, members: run,
    steps, thoughts, agents, agentsDone, notes, failed, durationMs: duration, sentMessages,
  };
}

/** The latest turn on the page: the one whose last process row stays open. */
export function latestTurnId(nodes: readonly DisplayNode[]): string | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    const turn = node.kind === 'history-fold' ? node.turnId : foldTurnId(node);
    if (turn !== undefined) return normTurn(turn);
  }
  return undefined;
}
/** Just the fields of a session task this needs. */
export interface EndingTask {
  readonly id: string;
  readonly agent_id?: string;
  readonly status: string;
  readonly stop_reason?: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly output_preview?: string;
  readonly model?: string;
  readonly thinking_effort?: string;
}

function outcomeOf(task: EndingTask | undefined, note: SystemBlock): SubagentOutcome {
  // The headline ("Background agent failed") is agent-core's; the task
  // record wins when it knows.
  const head = note.text.split('\n', 1)[0] ?? '';
  if (/\btimed[_ ]out\b/i.test(head) || task?.stop_reason === 'timeout') return 'timedOut';
  if (task?.status === 'cancelled' || /\b(?:killed|cancelled|stopped)\b/i.test(head)) return 'cancelled';
  if (task?.status === 'failed' || /\b(?:failed|lost)\b/i.test(head)) return 'failed';
  return 'completed';
}

/**
 * Read subagent task notifications as the agent they are about (FOLDING §3).
 * The notification's task id resolves to the agent through the session's
 * task list. Same turn as the dispatch card: the note is dropped, the card
 * states the end. Later turn: it becomes a `SubagentEnding` row. Notes that
 * resolve to no subagent stay as they are.
 */
export function readSubagentEndings(
  nodes: readonly DisplayNode[],
  tasks: readonly EndingTask[],
): DisplayNode[] {
  const agentByTask = new Map<string, EndingTask>();
  const taskIdsByAgent = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (task.agent_id === undefined || task.agent_id === '') continue;
    agentByTask.set(task.id, task);
    const set = taskIdsByAgent.get(task.agent_id);
    if (set === undefined) taskIdsByAgent.set(task.agent_id, new Set([task.id]));
    else set.add(task.id);
  }
  const merged = mergeTaskNotifications(nodes);
  const cardsByTaskId = new Map<string, { card: SubagentBlock; index: number }>();
  const untaggedCardsByAgentId = new Map<string, { card: SubagentBlock; index: number }[]>();
  const allCardsByAgentId = new Map<string, { card: SubagentBlock; index: number }[]>();
  merged.forEach((node, index) => {
    if (node.kind !== 'subagent') return;
    const allList = allCardsByAgentId.get(node.subagentId);
    if (allList === undefined) allCardsByAgentId.set(node.subagentId, [{ card: node, index }]);
    else allList.push({ card: node, index });
    if (node.taskId !== undefined && node.taskId !== '') {
      cardsByTaskId.set(node.taskId, { card: node, index });
      const set = taskIdsByAgent.get(node.subagentId);
      if (set === undefined) taskIdsByAgent.set(node.subagentId, new Set([node.taskId]));
      else set.add(node.taskId);
      return;
    }
    const untaggedList = untaggedCardsByAgentId.get(node.subagentId);
    if (untaggedList === undefined) untaggedCardsByAgentId.set(node.subagentId, [{ card: node, index }]);
    else untaggedList.push({ card: node, index });
  });
  const isContiguousSameTurn = (cardIndex: number, noteIndex: number, turn: string | undefined): boolean => {
    const start = Math.min(cardIndex, noteIndex) + 1;
    const end = Math.max(cardIndex, noteIndex) - 1;
    for (let i = start; i <= end; i += 1) {
      const mid = merged[i]!;
      if (mid.kind === 'user' || mid.kind === 'assistant' || mid.kind === 'message' || mid.kind === 'question' || mid.kind === 'approval') {
        return false;
      }
      if (mid.kind === 'notice' && (mid.externalText !== undefined || mid.tone !== 'neutral' || mid.executor === undefined || mid.executor.kind === 'compaction')) {
        return false;
      }
      const midTurn = mid.kind === 'history-fold' ? normTurn(mid.turnId) : normTurn(foldTurnId(mid));
      if (midTurn !== undefined && turn !== undefined && midTurn !== turn) return false;
    }
    return true;
  };
  const resolveTaskForNode = (node: DisplayNode): EndingTask | undefined => {
    let task = node.kind === 'system' && node.variant === 'task' && node.taskId !== undefined ? agentByTask.get(node.taskId) : undefined;
    if (node.kind === 'system' && node.variant === 'task' && task === undefined && node.taskNotification?.agentId !== undefined) {
      const meta = node.taskNotification;
      const taskId = node.taskId ?? meta.sourceId ?? node.id;
      task = {
        id: taskId,
        agent_id: meta.agentId,
        status: meta.type === 'task.failed' || meta.status === 'failed' ? 'failed' : 'completed',
        stop_reason: meta.stopReason,
        output_preview: meta.outputPreview ?? meta.body,
      };
    }
    if (task?.agent_id !== undefined && task.agent_id !== '') {
      const set = taskIdsByAgent.get(task.agent_id);
      if (set === undefined) taskIdsByAgent.set(task.agent_id, new Set([task.id]));
      else set.add(task.id);
    }
    return task;
  };
  const resolvedTasks = merged.map(resolveTaskForNode);
  const resolveMatchedCard = (
    task: EndingTask,
  ): { card: SubagentBlock; index: number } | undefined => {
    const exactCard = cardsByTaskId.get(task.id);
    if (exactCard !== undefined) return exactCard;
    const agentId = task.agent_id!;
    const allCards = allCardsByAgentId.get(agentId) ?? [];
    const untaggedCards = untaggedCardsByAgentId.get(agentId) ?? [];
    if (allCards.length !== 1 || untaggedCards.length !== 1 || (taskIdsByAgent.get(agentId)?.size ?? 0) > 1) return undefined;
    return untaggedCards[0];
  };
  const precomputedCardSummaries = new Map<string, string>();
  const precomputedCardTaskIds = new Map<string, string>();
  const absorbedNoteIndices = new Set<number>();
  for (let index = 0; index < merged.length; index += 1) {
    const node = merged[index]!;
    const task = resolvedTasks[index];
    if (node.kind !== 'system' || task === undefined || task.agent_id === undefined) continue;
    const turn = normTurn(node.turnId);
    const matchedCard = resolveMatchedCard(task);
    const canAbsorbIntoCard =
      matchedCard !== undefined &&
      normTurn(matchedCard.card.parentTurnId) === turn &&
      isContiguousSameTurn(matchedCard.index, index, turn);
    if (canAbsorbIntoCard) {
      absorbedNoteIndices.add(index);
      if (
        (matchedCard.card.taskId === undefined || matchedCard.card.taskId === '') &&
        task.id !== '' &&
        !precomputedCardTaskIds.has(matchedCard.card.id)
      ) {
        precomputedCardTaskIds.set(matchedCard.card.id, task.id);
      }
      if (
        (matchedCard.card.summary === undefined || matchedCard.card.summary === '') &&
        !precomputedCardSummaries.has(matchedCard.card.id) &&
        task.output_preview !== undefined &&
        task.output_preview !== ''
      ) {
        precomputedCardSummaries.set(matchedCard.card.id, task.output_preview);
      }
    }
  }
  const out: DisplayNode[] = [];
  for (let index = 0; index < merged.length; index += 1) {
    if (absorbedNoteIndices.has(index)) continue;
    const node = merged[index]!;
    if (node.kind === 'subagent') {
      const summary = precomputedCardSummaries.get(node.id);
      const taskId = precomputedCardTaskIds.get(node.id);
      const nextSummary = summary !== undefined && (node.summary === undefined || node.summary === '') ? summary : node.summary;
      const nextTaskId = taskId !== undefined && (node.taskId === undefined || node.taskId === '') ? taskId : node.taskId;
      out.push(nextSummary !== node.summary || nextTaskId !== node.taskId ? { ...node, summary: nextSummary, taskId: nextTaskId } : node);
      continue;
    }
    const task = resolvedTasks[index];
    if (node.kind !== 'system' || task === undefined || task.agent_id === undefined) {
      out.push(node);
      continue;
    }
    const agentId = task.agent_id;
    const turn = normTurn(node.turnId);
    const matchedCard = resolveMatchedCard(task);
    const onPage = matchedCard !== undefined;
    out.push({
      kind: 'subagent-ended',
      id: `ended-task-${task.id}`,
      turnId: turn,
      agentId,
      taskId: task.id,
      task,
      outcome: outcomeOf(task, node),
      note: node,
      dispatchOnPage: onPage,
      dispatchCardId: matchedCard?.card.id,
    });
  }
  return out;
}

export interface FoldOptions {
  /**
   * Blocks of the live turn that must stay where they are: the reader has
   * scrolled up into them, so a fold forming now would move what they read.
   * The fold catches up once they return to the end.
   */
  readonly keepOpen?: ReadonlySet<string>;
  /**
   * Live agent roster/tree state used to settle subagent cards whose frozen
   * transcript block snapshot has not yet received a terminal task update.
   */
  readonly forest?: AgentForest;
}

function latestSubagentCardIds(nodes: readonly DisplayNode[]): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  const visit = (node: DisplayNode) => {
    if (node.kind === 'subagent') {
      latest.set(node.subagentId, node.id);
      return;
    }
    if (node.kind === 'subagent-group' || node.kind === 'history-fold') {
      for (const member of node.members) visit(member);
    }
  };
  for (const node of nodes) visit(node);
  return latest;
}

/** Media runs and live subagent groups: rows of their own, never folded. */
function gatherRows(
  nodes: readonly DisplayNode[],
  live: string | undefined,
  forest: AgentForest | undefined,
  latestCardIdByAgent: ReadonlyMap<string, string>,
): DisplayNode[] {
  const out: DisplayNode[] = [];
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index]!;
    if (node.kind === 'tool' && isMediaTool(node)) {
      const turn = normTurn(node.turnId);
      const members: ToolBlock[] = [];
      while (index < nodes.length) {
        const next = nodes[index]!;
        if (next.kind !== 'tool' || !isMediaTool(next) || normTurn(next.turnId) !== turn) break;
        members.push(next);
        index += 1;
      }
      const tail = nodes.slice(index).every((rest) => rest.kind !== 'history-fold' && normTurn(foldTurnId(rest)) !== live);
      out.push({ kind: 'media-run', id: `media-${members[0]!.id}`, turnId: turn, members, latest: turn !== undefined && turn === live && tail });
      continue;
    }
    if (node.kind === 'subagent') {
      const turn = normTurn(node.parentTurnId);
      const members: SubagentBlock[] = [];
      while (index < nodes.length) {
        const next = nodes[index]!;
        if (next.kind !== 'subagent' || normTurn(next.parentTurnId) !== turn) break;
        members.push(next);
        index += 1;
      }
      if (members.length >= 2 && members.some((member) => subagentLive(member, forest, latestCardIdByAgent))) {
        out.push({ kind: 'subagent-group', id: `agents-${members[0]!.id}`, turnId: turn, members });
      } else {
        out.push(...members);
      }
      continue;
    }
    out.push(node);
    index += 1;
  }
  return out;
}

/**
 * Fold settled process: each run of ≥2 consecutive process rows of one turn
 * (tools, including ordinary memory tools, read runs, shell, thinking,
 * settled subagents, reminders, settled decisions, engine notes), or a single
 * completed shell, becomes one `HistoryFold`. In the latest turn
 * (`liveTurnId`) the newest process row stays out, as does anything still
 * running or held by `keepOpen`; the next row to arrive folds it in. A run
 * breaks at anything the user reads: messages, dividers, image rows, live
 * subagent groups, and an interaction that is still open.
 */
export function foldHistory(
  nodes: readonly DisplayNode[],
  liveTurnId: string | undefined,
  options: FoldOptions = {},
): DisplayNode[] {
  const live = normTurn(liveTurnId);
  const forest = options.forest;
  const latestCardIdByAgent = forest === undefined ? new Map<string, string>() : latestSubagentCardIds(nodes);
  const rows = gatherRows(nodes, live, forest, latestCardIdByAgent);
  // The newest row of the live turn, when it is process (the one the reader
  // is watching arrive); a message at the end already closes the stretch.
  let newest: string | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const node = rows[index]!;
    const turn = node.kind === 'history-fold' ? node.turnId : normTurn(foldTurnId(node));
    if (turn !== live) continue;
    newest = node.id;
    break;
  }
  const keepOpen = options.keepOpen;
  const out: DisplayNode[] = [];
  let run: Row[] = [];
  let runTurn: string | undefined;
  const flush = () => {
    if (run.length >= HISTORY_FOLD_MIN || run.some((node) => node.kind === 'shell')) out.push(buildFold(run, runTurn, forest, latestCardIdByAgent));
    else out.push(...run);
    run = [];
    runTurn = undefined;
  };
  for (const node of rows) {
    if (node.kind === 'history-fold' || node.kind === 'subagent-group' || node.kind === 'media-run') {
      flush();
      out.push(node);
      continue;
    }
    const turn = normTurn(foldTurnId(node));
    const held = turn === live && (node.id === newest || keepOpen?.has(node.id) === true);
    const eligible = turn !== undefined && !held && foldable(node, forest, latestCardIdByAgent);
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
 * Memory tools. The row keeps its record and its view/undo actions; ordinary
 * settled calls fold with the rest of the process, and a running call stays out.
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

/** A pure read: a settled tool call that only looks at the world. */
export function isReadStep(block: Block): block is ToolBlock {
  if (block.kind !== 'tool') return false;
  // An image the agent looked at is its own row (see `MediaRun`), not a read.
  return READ_VERBS.has(stepObject(block).verb) && !isMediaTool(block);
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
      if (run.length > 0 && normTurn(run[0]?.turnId) !== normTurn(block.turnId)) flush();
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

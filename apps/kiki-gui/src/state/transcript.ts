/**
 * Session view state: an immutable-ish transcript model rebuilt from the REST
 * snapshot and advanced by WS `session_event` frames.
 *
 * Rebuild rules (matches rest/snapshot.ts docs):
 *   1. `GET /sessions/{sid}/snapshot` → messages + in_flight_turn + watermark
 *   2. subscribe with cursor `{seq: as_of_seq, epoch}`
 *   3. apply durable events with `seq > cursor.seq`; volatile text deltas use
 *      the cumulative envelope `offset` for alignment:
 *        offset === local length → append
 *        offset <  local length → tail rewrite (idempotent for re-sends)
 *        offset >  local length → gap → caller resyncs from a fresh snapshot
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  GoalSnapshot,
  Message,
  PermissionMode,
  QuestionRequest,
  Session,
  SessionPendingInteraction,
  SessionSnapshotResponse,
  Task,
  TaskInfo,
  ToolInputDisplay,
  UsageStatus,
} from '@moonshot-ai/protocol';

import type { AgentTranscriptResponse } from '../lib/client';
import type { SessionEventFrame } from '../lib/types';

// ---------------------------------------------------------------------------

export interface UserBlock {
  readonly kind: 'user';
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  /** Stable daemon identities when known. `turn.started.prompt` placeholders
   * have neither until the REST result or a future prompt.submitted arrives. */
  readonly promptId?: string;
  readonly userMessageId?: string;
}

export interface AssistantBlock {
  readonly kind: 'assistant';
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string | undefined;
}

export interface ThinkingBlock {
  readonly kind: 'thinking';
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string | undefined;
}

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolBlock {
  readonly kind: 'tool';
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  /** Raw streamed argument text (tool.call.delta), before args are known. */
  readonly argsText: string;
  readonly args: unknown;
  readonly display: ToolInputDisplay | undefined;
  readonly description: string | undefined;
  readonly status: ToolStatus;
  readonly output: unknown;
  readonly isError: boolean | undefined;
  readonly startedAt: number;
  readonly durationMs: number | undefined;
  readonly progressText: string | undefined;
}

export interface ShellBlock {
  readonly kind: 'shell';
  readonly id: string;
  readonly commandId: string;
  readonly output: string;
  readonly done: boolean;
  readonly isError: boolean | undefined;
}

export interface SubagentBlock {
  readonly kind: 'subagent';
  readonly id: string;
  readonly subagentId: string;
  readonly parentToolCallId: string | undefined;
  readonly name: string;
  readonly description: string | undefined;
  readonly model: string | undefined;
  readonly thinkingEffort: string | undefined;
  readonly status: 'running' | 'suspended' | 'completed' | 'failed';
  readonly summary: string | undefined;
  readonly error: string | undefined;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly toolCallCount: number;
  /** Events captured for the child in this client's unfiltered session stream. */
  readonly transcript: readonly Block[];
}

/** Subtle in-flow notice: compaction, abort, errors, turn failures. */
export interface NoticeBlock {
  readonly kind: 'notice';
  readonly id: string;
  readonly text: string;
  readonly tone: 'neutral' | 'danger';
}

export interface ApprovalResolution {
  readonly decision: ApprovalDecision | 'expired' | 'resolved_elsewhere';
  readonly resolvedAt: string;
}

export interface ApprovalBlock {
  readonly kind: 'approval';
  readonly id: string;
  readonly request: ApprovalRequest;
  readonly resolution: ApprovalResolution | undefined;
}

export type QuestionOutcome =
  | { readonly kind: 'answered'; readonly at: string }
  | { readonly kind: 'dismissed'; readonly at: string }
  | { readonly kind: 'expired' };

export interface QuestionBlock {
  readonly kind: 'question';
  readonly id: string;
  readonly request: QuestionRequest;
  readonly outcome: QuestionOutcome | undefined;
}

export type Block =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | ShellBlock
  | SubagentBlock
  | NoticeBlock
  | ApprovalBlock
  | QuestionBlock;

export interface TodoItem {
  readonly title: string;
  readonly status: string;
}

export interface SessionCursorState {
  readonly seq: number;
  readonly epoch: string | undefined;
}

export interface SessionViewState {
  readonly version: number;
  readonly sessionId: string;
  /** Latest session record (from snapshot, list poll, or work_changed). */
  readonly session: Session | undefined;
  readonly blocks: readonly Block[];
  readonly cursor: SessionCursorState;
  readonly busy: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly activePromptId: string | undefined;
  readonly queuedPromptIds: readonly string[];
  readonly model: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly planMode: boolean;
  readonly swarmMode: boolean;
  /** undefined until the goal endpoint has been checked; null means no goal. */
  readonly goal: GoalSnapshot | null | undefined;
  readonly goalUpdatedAt: string | undefined;
  readonly contextTokens: number | undefined;
  readonly maxContextTokens: number | undefined;
  readonly usage: UsageStatus | undefined;
  readonly todos: readonly TodoItem[];
  readonly tasks: readonly Task[];
  /** Set when a delta gap was detected and a resync has been requested. */
  readonly resyncing: boolean;
  /** Set when the last resync failed and a retry is scheduled/pending. */
  readonly resyncFailed: boolean;
  /** How many resync attempts have been made since the last success. */
  readonly resyncAttempt: number;
  readonly loaded: boolean;
  /** Human-readable snapshot/resync error; empty when healthy. */
  readonly loadError: string | undefined;
  /** Snapshot said older messages exist beyond the current first block. */
  readonly hasMoreHistory: boolean;
  /** Wire id of the oldest loaded message — the `before_id` pagination cursor. */
  readonly oldestMessageId: string | undefined;
  /** An older-page fetch is in flight (drives the top affordance). */
  readonly loadingOlder: boolean;
  /** At least one older page has been fetched (drives the history-start cap). */
  readonly fetchedOlder: boolean;
}

export function createViewState(sessionId: string): SessionViewState {
  return {
    version: 0,
    sessionId,
    session: undefined,
    blocks: [],
    cursor: { seq: 0, epoch: undefined },
    busy: false,
    pendingInteraction: 'none',
    activePromptId: undefined,
    queuedPromptIds: [],
    model: undefined,
    permissionMode: undefined,
    planMode: false,
    swarmMode: false,
    goal: undefined,
    goalUpdatedAt: undefined,
    contextTokens: undefined,
    maxContextTokens: undefined,
    usage: undefined,
    todos: [],
    tasks: [],
    resyncing: false,
    resyncFailed: false,
    resyncAttempt: 0,
    loaded: false,
    loadError: undefined,
    hasMoreHistory: false,
    oldestMessageId: undefined,
    loadingOlder: false,
    fetchedOlder: false,
  };
}

// ---------------------------------------------------------------------------
// Snapshot → blocks
// ---------------------------------------------------------------------------

function textOfContent(content: Message['content']): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push(part.text);
    else if (part.type === 'image') parts.push('[image]');
    else if (part.type === 'video') parts.push('[video]');
    else if (part.type === 'file') parts.push(`[file: ${part.name}]`);
  }
  return parts.join('\n');
}

function messagesToBlocks(messages: readonly Message[]): Block[] {
  const blocks: Block[] = [];
  const toolByCallId = new Map<string, ToolBlock>();

  const upsertToolResult = (toolCallId: string, output: unknown, isError: boolean | undefined) => {
    const existing = toolByCallId.get(toolCallId);
    if (existing !== undefined) {
      const index = blocks.indexOf(existing);
      const updated: ToolBlock = {
        ...existing,
        status: isError === true ? 'error' : 'done',
        output,
        isError,
      };
      if (index >= 0) blocks[index] = updated;
      toolByCallId.set(toolCallId, updated);
    } else {
      const block: ToolBlock = {
        kind: 'tool',
        id: `tool-${toolCallId}`,
        toolCallId,
        name: 'tool',
        argsText: '',
        args: undefined,
        display: undefined,
        description: undefined,
        status: isError === true ? 'error' : 'done',
        output,
        isError,
        startedAt: 0,
        durationMs: undefined,
        progressText: undefined,
      };
      toolByCallId.set(toolCallId, block);
      blocks.push(block);
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const text = textOfContent(message.content);
        if (text.trim() !== '') {
          blocks.push({
            kind: 'user',
            id: `user-${message.id}`,
            text,
            createdAt: message.created_at,
            promptId: message.prompt_id ?? message.id,
            userMessageId: message.id,
          });
        }
        break;
      }
      case 'assistant': {
        let textIndex = 0;
        for (const part of message.content) {
          if (part.type === 'text') {
            blocks.push({
              kind: 'assistant',
              id: `assistant-${message.id}-${textIndex}`,
              text: part.text,
              streaming: false,
              createdAt: message.created_at,
            });
            textIndex += 1;
          } else if (part.type === 'thinking') {
            blocks.push({
              kind: 'thinking',
              id: `thinking-${message.id}-${textIndex}`,
              text: part.thinking,
              streaming: false,
              createdAt: message.created_at,
            });
            textIndex += 1;
          } else if (part.type === 'tool_use') {
            const block: ToolBlock = {
              kind: 'tool',
              id: `tool-${part.tool_call_id}`,
              toolCallId: part.tool_call_id,
              name: part.tool_name,
              argsText: '',
              args: part.input,
              display: undefined,
              description: undefined,
              status: 'done',
              output: undefined,
              isError: undefined,
              startedAt: 0,
              durationMs: undefined,
              progressText: undefined,
            };
            toolByCallId.set(part.tool_call_id, block);
            blocks.push(block);
          }
        }
        break;
      }
      case 'tool': {
        for (const part of message.content) {
          if (part.type === 'tool_result') {
            upsertToolResult(part.tool_call_id, part.output, part.is_error);
          }
        }
        break;
      }
      case 'system': {
        const text = textOfContent(message.content);
        if (text.trim() !== '') {
          const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text;
          blocks.push({
            kind: 'notice',
            id: `system-${message.id}`,
            text: preview,
            tone: 'neutral',
          });
        }
        break;
      }
    }
  }
  return blocks;
}

export function agentTranscriptToBlocks(response: AgentTranscriptResponse): Block[] {
  const blocks: Block[] = [];
  for (const item of response.items) {
    if (item.kind === 'marker') {
      blocks.push({
        kind: 'notice',
        id: `agent-marker-${item.markerId}`,
        text: item.marker,
        tone: 'neutral',
      });
      continue;
    }
    if (item.kind !== 'turn') continue;
    if (item.prompt !== undefined && item.prompt.trim() !== '') {
      blocks.push({
        kind: 'user',
        id: `agent-turn-${item.turnId}-prompt`,
        text: item.prompt,
        createdAt: item.startedAt ?? '',
      });
    }
    for (const step of item.steps) {
      for (const frame of step.frames) {
        switch (frame.kind) {
          case 'text':
            if (
              frame.role === 'user' &&
              item.prompt !== undefined &&
              frame.text === item.prompt
            ) {
              break;
            }
            blocks.push(
              frame.role === 'user'
                ? {
                    kind: 'user',
                    id: `agent-frame-${frame.frameId}`,
                    text: frame.text,
                    createdAt: step.startedAt ?? item.startedAt ?? '',
                  }
                : {
                    kind: 'assistant',
                    id: `agent-frame-${frame.frameId}`,
                    text: frame.text,
                    streaming: false,
                    createdAt: step.endedAt ?? item.endedAt,
                  },
            );
            break;
          case 'thinking':
            blocks.push({
              kind: 'thinking',
              id: `agent-frame-${frame.frameId}`,
              text: frame.text,
              streaming: false,
              createdAt: step.endedAt ?? item.endedAt,
            });
            break;
          case 'tool': {
            const startedAt = new Date(step.startedAt ?? item.startedAt ?? '').getTime();
            const endedAt = new Date(step.endedAt ?? item.endedAt ?? '').getTime();
            blocks.push({
              kind: 'tool',
              id: `tool-${frame.toolCallId}`,
              toolCallId: frame.toolCallId,
              name: frame.name,
              argsText: frame.inputText ?? '',
              args: frame.input,
              display: frame.display as ToolInputDisplay | undefined,
              description: undefined,
              status: frame.state === 'error' ? 'error' : frame.state,
              output: frame.output ?? frame.error,
              isError: frame.state === 'error',
              startedAt: Number.isNaN(startedAt) ? 0 : startedAt,
              durationMs:
                Number.isNaN(startedAt) || Number.isNaN(endedAt)
                  ? item.durationMs
                  : Math.max(0, endedAt - startedAt),
              progressText: frame.progress?.text,
            });
            break;
          }
          case 'notice':
            blocks.push({
              kind: 'notice',
              id: `agent-frame-${frame.frameId}`,
              text: frame.message,
              tone: frame.level === 'error' ? 'danger' : 'neutral',
            });
            break;
        }
      }
    }
  }
  return blocks;
}

export function applySnapshot(
  sessionId: string,
  snapshot: SessionSnapshotResponse,
): SessionViewState {
  const blocks = messagesToBlocks(snapshot.messages.items);

  const inFlight = snapshot.in_flight_turn;
  if (inFlight !== null) {
    if (inFlight.thinking_text !== '') {
      blocks.push({
        kind: 'thinking',
        id: `thinking-live-${inFlight.turn_id}`,
        text: inFlight.thinking_text,
        streaming: true,
        createdAt: undefined,
      });
    }
    if (inFlight.assistant_text !== '') {
      blocks.push({
        kind: 'assistant',
        id: `assistant-live-${inFlight.turn_id}`,
        text: inFlight.assistant_text,
        streaming: true,
        createdAt: undefined,
      });
    }
    for (const tool of inFlight.running_tools) {
      blocks.push({
        kind: 'tool',
        id: `tool-${tool.tool_call_id}`,
        toolCallId: tool.tool_call_id,
        name: tool.name,
        argsText: '',
        args: tool.args,
        display: tool.display as ToolInputDisplay | undefined,
        description: tool.description,
        status: 'running',
        output: undefined,
        isError: undefined,
        startedAt: Date.now(),
        durationMs: undefined,
        progressText: tool.last_progress?.text,
      });
    }
  }

  for (const subagent of snapshot.subagents ?? []) {
    const status =
      subagent.subagent_phase === 'failed' || subagent.status === 'failed'
        ? 'failed'
        : subagent.subagent_phase === 'suspended'
          ? 'suspended'
          : subagent.subagent_phase === 'completed' || subagent.status === 'completed'
            ? 'completed'
            : 'running';
    blocks.push({
      kind: 'subagent',
      id: `subagent-${subagent.id}`,
      subagentId: subagent.id,
      parentToolCallId: subagent.parent_tool_call_id,
      name: subagent.subagent_type ?? subagent.description,
      description: subagent.description,
      model: subagent.model,
      thinkingEffort: subagent.thinking_effort,
      status,
      summary: subagent.output_preview,
      error: subagent.suspended_reason,
      startedAt: subagent.started_at ?? subagent.created_at,
      endedAt: subagent.completed_at,
      toolCallCount: 0,
      transcript: [],
    });
  }

  for (const approval of snapshot.pending_approvals) {
    blocks.push(approvalBlock(approval));
  }
  for (const question of snapshot.pending_questions) {
    blocks.push(questionBlock(question));
  }

  // Todos ride todo_list tool payloads; recover the latest list from history
  // (live events refine it from here on).
  let todos: readonly TodoItem[] = [];
  for (const message of snapshot.messages.items) {
    for (const part of message.content) {
      if (part.type === 'tool_result') {
        const found = extractTodosFromOutput(part.output);
        if (found !== undefined) todos = found;
      } else if (part.type === 'tool_use') {
        const found = extractTodosFromInput(part.input);
        if (found !== undefined) todos = found;
      }
    }
  }

  const base = createViewState(sessionId);
  return {
    ...base,
    version: 1,
    session: snapshot.session,
    blocks,
    cursor: { seq: snapshot.as_of_seq, epoch: snapshot.epoch },
    busy: snapshot.session.busy,
    pendingInteraction: snapshot.session.pending_interaction ?? 'none',
    activePromptId: inFlight?.current_prompt_id,
    model:
      snapshot.session.agent_config.model !== ''
        ? snapshot.session.agent_config.model
        : undefined,
    permissionMode: snapshot.session.agent_config.permission_mode,
    planMode: snapshot.session.agent_config.plan_mode ?? false,
    swarmMode: snapshot.session.agent_config.swarm_mode ?? false,
    loaded: true,
    loadError: undefined,
    resyncFailed: false,
    resyncAttempt: 0,
    todos,
    hasMoreHistory: snapshot.messages.has_more,
    oldestMessageId: snapshot.messages.items[0]?.id,
  };
}

/**
 * Prepend an older messages page (from `GET /sessions/{id}/messages
 * ?before_id=oldest`). The server returns pages newest-first; we reverse them
 * to restore oldest-first reading order before prepending. The new
 * `oldestMessageId` is the oldest message now loaded (the last item of the
 * reversed page), which becomes the next `before_id` cursor.
 */
export function prependOlderMessages(
  state: SessionViewState,
  messages: readonly Message[],
  hasMore: boolean,
): SessionViewState {
  if (messages.length === 0) {
    return {
      ...state,
      version: state.version + 1,
      loadingOlder: false,
      fetchedOlder: true,
      hasMoreHistory: false,
    };
  }
  const oldestFirst = messages.toReversed();
  const olderBlocks = messagesToBlocks(oldestFirst);
  return {
    ...state,
    version: state.version + 1,
    blocks: [...olderBlocks, ...state.blocks],
    oldestMessageId: oldestFirst[0]?.id ?? state.oldestMessageId,
    hasMoreHistory: hasMore,
    loadingOlder: false,
    fetchedOlder: true,
  };
}

export function setLoadingOlder(state: SessionViewState, loading: boolean): SessionViewState {
  if (state.loadingOlder === loading) return state;
  return { ...state, version: state.version + 1, loadingOlder: loading };
}

/** Todo extraction from a TodoWrite-style tool input ({todos:[...]}). */
function extractTodosFromInput(input: unknown): readonly TodoItem[] | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const list = (input as { todos?: unknown }).todos;
  if (!Array.isArray(list)) return undefined;
  const items: TodoItem[] = [];
  for (const raw of list as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { title?: unknown; content?: unknown; status?: unknown };
    const title = typeof entry.title === 'string' ? entry.title : entry.content;
    if (typeof title === 'string' && typeof entry.status === 'string') {
      items.push({ title, status: entry.status });
    }
  }
  return items.length > 0 ? items : undefined;
}

function approvalBlock(request: ApprovalRequest): ApprovalBlock {
  return {
    kind: 'approval',
    id: `approval-${request.approval_id}`,
    request,
    resolution: undefined,
  };
}

function questionBlock(request: QuestionRequest): QuestionBlock {
  return {
    kind: 'question',
    id: `question-${request.question_id}`,
    request,
    outcome: undefined,
  };
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

let noticeCounter = 0;
function nextNoticeId(prefix: string): string {
  noticeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${noticeCounter}`;
}

interface DeltaResult {
  readonly text: string;
  readonly gap: boolean;
}

/** Cumulative-offset delta application (see file header). */
export function applyDelta(local: string, delta: string, offset: number | undefined): DeltaResult {
  if (offset === undefined) return { text: local + delta, gap: false };
  if (offset > local.length) return { text: local, gap: true };
  return { text: local.slice(0, offset) + delta, gap: false };
}

export interface ApplyResult {
  readonly state: SessionViewState;
  /** True when a volatile-delta gap was detected — caller should resync. */
  readonly gapDetected: boolean;
}

function replaceBlock(blocks: readonly Block[], updated: Block): Block[] {
  const index = blocks.findIndex((b) => b.id === updated.id);
  if (index < 0) return [...blocks, updated];
  const next = blocks.slice();
  next[index] = updated;
  return next;
}

/**
 * Mark still-streaming text blocks as final at a step/turn boundary AND
 * rename their live ids (`assistant-live-<turn>` → `…-final-<tag>`). The
 * rename matters: volatile offsets reset at every step boundary, so deltas
 * for the next step must start a FRESH block — with the old id kept, the
 * first post-boundary delta (offset 0) would rewrite the finalized text.
 */
function finalizeStreaming(blocks: readonly Block[], tag: string): Block[] {
  let changed = false;
  const next = blocks.map((block) => {
    if ((block.kind === 'assistant' || block.kind === 'thinking') && block.streaming) {
      changed = true;
      return { ...block, streaming: false, id: `${block.id}-final-${tag}` };
    }
    return block;
  });
  return changed ? next : [...blocks];
}

function extractTodosFromDisplay(display: ToolInputDisplay): readonly TodoItem[] | undefined {
  if (display.kind === 'todo_list') return display.items;
  return undefined;
}

function extractTodosFromOutput(output: unknown): readonly TodoItem[] | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const candidate = output as { kind?: unknown; items?: unknown };
  if (candidate.kind !== 'todo_list' || !Array.isArray(candidate.items)) return undefined;
  const items: TodoItem[] = [];
  for (const raw of candidate.items as unknown[]) {
    if (typeof raw === 'object' && raw !== null) {
      const item = raw as { title?: unknown; status?: unknown };
      if (typeof item.title === 'string' && typeof item.status === 'string') {
        items.push({ title: item.title, status: item.status });
      }
    }
  }
  return items;
}

function taskInfoToTask(info: TaskInfo, sessionId: string): Task {
  return {
    id: info.taskId,
    session_id: sessionId,
    kind: info.kind === 'agent' ? 'subagent' : info.kind === 'process' ? 'bash' : 'tool',
    description: info.description,
    status:
      info.status === 'running'
        ? 'running'
        : info.status === 'completed'
          ? 'completed'
          : info.status === 'killed'
            ? 'cancelled'
            : 'failed',
    created_at: new Date(info.startedAt).toISOString(),
    started_at: new Date(info.startedAt).toISOString(),
    completed_at: info.endedAt !== null ? new Date(info.endedAt).toISOString() : undefined,
  };
}

function isSubagentLifecycle(type: string): boolean {
  return type.startsWith('subagent.');
}

function createUnknownSubagent(agentId: string, timestamp: string): SubagentBlock {
  return {
    kind: 'subagent',
    id: `subagent-${agentId}`,
    subagentId: agentId,
    parentToolCallId: undefined,
    name: agentId,
    description: undefined,
    model: undefined,
    thinkingEffort: undefined,
    status: 'running',
    summary: undefined,
    error: undefined,
    startedAt: timestamp,
    endedAt: undefined,
    toolCallCount: 0,
    transcript: [],
  };
}

export function applyFrame(state: SessionViewState, frame: SessionEventFrame): ApplyResult {
  return applyFrameInternal(state, frame, true);
}

function applyFrameInternal(
  state: SessionViewState,
  frame: SessionEventFrame,
  routeSubagentEvents: boolean,
): ApplyResult {
  const payload = frame.payload;
  let next = state;
  let gap = false;

  const evolve = (partial: Partial<SessionViewState>) => {
    next = { ...next, ...partial, version: next.version + 1 };
  };

  // Durable frames advance the cursor; duplicates (replay overlap) are dropped.
  const durable = frame.volatile !== true;
  if (durable) {
    if (frame.seq <= state.cursor.seq) return { state, gapDetected: false };
    const epoch = frame.epoch ?? state.cursor.epoch;
    next = {
      ...next,
      cursor: { seq: frame.seq, epoch },
      version: next.version + 1,
    };
  }

  const emittingAgentId = (payload as { agentId?: string }).agentId;
  if (
    routeSubagentEvents &&
    emittingAgentId !== undefined &&
    emittingAgentId !== 'main' &&
    !isSubagentLifecycle(payload.type)
  ) {
    const key = `subagent-${emittingAgentId}`;
    const existing =
      (next.blocks.find((block) => block.id === key) as SubagentBlock | undefined) ??
      createUnknownSubagent(emittingAgentId, frame.timestamp);
    const childState: SessionViewState = {
      ...createViewState(next.sessionId),
      loaded: true,
      blocks: existing.transcript,
      cursor: durable
        ? { seq: Math.max(0, frame.seq - 1), epoch: frame.epoch }
        : { seq: 0, epoch: frame.epoch },
    };
    const childResult = applyFrameInternal(childState, frame, false);
    const countedTool =
      payload.type === 'tool.call.started' &&
      !existing.transcript.some(
        (block) => block.kind === 'tool' && block.toolCallId === payload.toolCallId,
      );
    const updated: SubagentBlock = {
      ...existing,
      transcript: childResult.state.blocks,
      toolCallCount: existing.toolCallCount + (countedTool ? 1 : 0),
    };
    return {
      state: {
        ...next,
        version: next.version + 1,
        blocks: replaceBlock(next.blocks, updated),
      },
      gapDetected: childResult.gapDetected,
    };
  }

  switch (payload.type) {
    case 'assistant.delta': {
      const key = `assistant-live-${payload.turnId}`;
      const existing = next.blocks.find((b) => b.id === key) as AssistantBlock | undefined;
      const result = applyDelta(existing?.text ?? '', payload.delta, frame.offset);
      if (result.gap) {
        gap = true;
        break;
      }
      const block: AssistantBlock = {
        kind: 'assistant',
        id: key,
        text: result.text,
        streaming: true,
        createdAt: existing?.createdAt ?? frame.timestamp,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'thinking.delta': {
      const key = `thinking-live-${payload.turnId}`;
      const existing = next.blocks.find((b) => b.id === key) as ThinkingBlock | undefined;
      const result = applyDelta(existing?.text ?? '', payload.delta, frame.offset);
      if (result.gap) {
        gap = true;
        break;
      }
      const block: ThinkingBlock = {
        kind: 'thinking',
        id: key,
        text: result.text,
        streaming: true,
        createdAt: existing?.createdAt ?? frame.timestamp,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'turn.started': {
      // v2 publishes this before the prompt REST reply and currently does not
      // publish prompt.submitted. Create an unidentified placeholder only when
      // no block is already tied to the active prompt's stable daemon id.
      if (typeof payload.prompt === 'string' && payload.prompt.trim() !== '') {
        const key = `user-turn-${payload.turnId}-prompt`;
        const exists = next.blocks.some((block) => block.id === key);
        const associatedByPromptId =
          next.activePromptId !== undefined &&
          next.blocks.some(
            (block): block is UserBlock =>
              block.kind === 'user' && block.promptId === next.activePromptId,
          );
        if (!exists && !associatedByPromptId) {
          evolve({
            blocks: [
              ...next.blocks,
              {
                kind: 'user',
                id: key,
                text: payload.prompt,
                createdAt: frame.timestamp,
              } satisfies UserBlock,
            ],
          });
        }
      }
      evolve({ busy: true });
      break;
    }
    case 'turn.step.started':
    case 'turn.ended': {
      let blocks = finalizeStreaming(
        next.blocks,
        payload.type === 'turn.step.started' ? `s${payload.step}` : 'end',
      );
      if (payload.type === 'turn.ended') {
        if (payload.reason === 'failed') {
          blocks = [
            ...blocks,
            {
              kind: 'notice',
              id: nextNoticeId('turn-failed'),
              text: payload.error?.message ?? 'Turn failed',
              tone: 'danger' as const,
            },
          ];
        }
        evolve({
          blocks,
          busy: payload.reason === 'completed' ? false : next.busy,
          activePromptId: undefined,
        });
      } else {
        evolve({ blocks });
      }
      break;
    }
    case 'tool.call.delta': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      const block: ToolBlock = {
        kind: 'tool',
        id: key,
        toolCallId: payload.toolCallId,
        name: payload.name ?? existing?.name ?? 'tool',
        argsText: (existing?.argsText ?? '') + (payload.argumentsPart ?? ''),
        args: existing?.args,
        display: existing?.display,
        description: existing?.description,
        status: 'running',
        output: undefined,
        isError: undefined,
        startedAt: existing?.startedAt ?? Date.now(),
        durationMs: undefined,
        progressText: existing?.progressText,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'tool.call.started': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      const block: ToolBlock = {
        kind: 'tool',
        id: key,
        toolCallId: payload.toolCallId,
        name: payload.name,
        argsText: existing?.argsText ?? '',
        args: payload.args,
        display: payload.display,
        description: payload.description,
        status: 'running',
        output: undefined,
        isError: undefined,
        startedAt: Date.now(),
        durationMs: undefined,
        progressText: existing?.progressText,
      };
      const todos =
        payload.display !== undefined ? extractTodosFromDisplay(payload.display) : undefined;
      evolve({
        blocks: replaceBlock(next.blocks, block),
        ...(todos !== undefined ? { todos } : {}),
      });
      break;
    }
    case 'tool.progress': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      if (existing === undefined) break;
      const text = payload.update.text;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          progressText: text !== undefined ? text : existing.progressText,
        }),
      });
      break;
    }
    case 'tool.result': {
      const key = `tool-${payload.toolCallId}`;
      const existing = next.blocks.find((b) => b.id === key) as ToolBlock | undefined;
      if (existing === undefined) break;
      const todos = extractTodosFromOutput(payload.output);
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: payload.isError === true ? 'error' : 'done',
          output: payload.output,
          isError: payload.isError,
          durationMs: existing.startedAt > 0 ? Date.now() - existing.startedAt : undefined,
        }),
        ...(todos !== undefined ? { todos } : {}),
      });
      break;
    }
    case 'shell.started': {
      const block: ShellBlock = {
        kind: 'shell',
        id: `shell-${payload.commandId}`,
        commandId: payload.commandId,
        output: '',
        done: false,
        isError: undefined,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'shell.output': {
      const key = `shell-${payload.commandId}`;
      const existing = next.blocks.find((b) => b.id === key) as ShellBlock | undefined;
      const text = payload.update.text ?? '';
      const block: ShellBlock = {
        kind: 'shell',
        id: key,
        commandId: payload.commandId,
        output: (existing?.output ?? '') + text,
        done: false,
        isError: undefined,
      };
      evolve({ blocks: replaceBlock(next.blocks, block) });
      break;
    }
    case 'shell.completed': {
      const key = `shell-${payload.commandId}`;
      const existing = next.blocks.find((b) => b.id === key) as ShellBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, { ...existing, done: true, isError: payload.isError }),
      });
      break;
    }
    case 'subagent.spawned': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((block) => block.id === key) as SubagentBlock | undefined;
      const block: SubagentBlock = {
        kind: 'subagent',
        id: key,
        subagentId: payload.subagentId,
        parentToolCallId: payload.parentToolCallId,
        name: payload.subagentName,
        description: payload.description,
        model: payload.model,
        thinkingEffort: payload.thinkingEffort,
        status: 'running',
        summary: existing?.summary,
        error: undefined,
        startedAt: existing?.startedAt ?? frame.timestamp,
        endedAt: undefined,
        toolCallCount: existing?.toolCallCount ?? 0,
        transcript: existing?.transcript ?? [],
      };
      const parentIndex = next.blocks.findIndex(
        (candidate) => candidate.kind === 'tool' && candidate.toolCallId === payload.parentToolCallId,
      );
      const withoutParentAndOldBubble = next.blocks.filter(
        (candidate) =>
          candidate.id !== key &&
          !(candidate.kind === 'tool' && candidate.toolCallId === payload.parentToolCallId),
      );
      const insertionIndex = parentIndex >= 0 ? Math.min(parentIndex, withoutParentAndOldBubble.length) : withoutParentAndOldBubble.length;
      const blocks = withoutParentAndOldBubble.slice();
      blocks.splice(insertionIndex, 0, block);
      evolve({ blocks });
      break;
    }
    case 'subagent.started': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: 'running',
          startedAt: existing.startedAt || frame.timestamp,
        }),
      });
      break;
    }
    case 'subagent.suspended': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, { ...existing, status: 'suspended', error: payload.reason }),
      });
      break;
    }
    case 'subagent.completed': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: 'completed',
          summary: payload.resultSummary,
          endedAt: frame.timestamp,
        }),
      });
      break;
    }
    case 'subagent.failed': {
      const key = `subagent-${payload.subagentId}`;
      const existing = next.blocks.find((b) => b.id === key) as SubagentBlock | undefined;
      if (existing === undefined) break;
      evolve({
        blocks: replaceBlock(next.blocks, {
          ...existing,
          status: 'failed',
          error: payload.error,
          endedAt: frame.timestamp,
        }),
      });
      break;
    }
    case 'compaction.started': {
      const notice: NoticeBlock = {
        kind: 'notice',
        id: nextNoticeId('compaction'),
        text: 'Compacting context…',
        tone: 'neutral',
      };
      evolve({ blocks: [...next.blocks, notice] });
      break;
    }
    case 'compaction.completed': {
      const notice: NoticeBlock = {
        kind: 'notice',
        id: nextNoticeId('compaction'),
        text: `Context compacted — ${payload.result.tokensBefore.toLocaleString()} → ${payload.result.tokensAfter.toLocaleString()} tokens`,
        tone: 'neutral',
      };
      evolve({ blocks: [...next.blocks, notice] });
      break;
    }
    case 'prompt.submitted': {
      const key = `user-${payload.userMessageId}`;
      const text = textOfContent(payload.content as Message['content']);
      if (text.trim() === '') break;
      let blocks = next.blocks;
      const stableIndex = blocks.findIndex(
        (block): block is UserBlock =>
          block.kind === 'user' &&
          (block.userMessageId === payload.userMessageId || block.promptId === payload.promptId),
      );
      if (stableIndex < 0) {
        const placeholderIndex = blocks.findIndex(
          (block): block is UserBlock =>
            block.kind === 'user' &&
            block.userMessageId === undefined &&
            block.promptId === undefined &&
            block.text === text,
        );
        const userBlock: UserBlock = {
          kind: 'user',
          id: key,
          text,
          createdAt: payload.createdAt,
          promptId: payload.promptId,
          userMessageId: payload.userMessageId,
        };
        if (placeholderIndex >= 0) {
          const nextBlocks = blocks.slice();
          nextBlocks[placeholderIndex] = userBlock;
          blocks = nextBlocks;
        } else {
          blocks = [...blocks, userBlock];
        }
      }
      const queued =
        payload.status === 'queued'
          ? [...next.queuedPromptIds, payload.promptId]
          : next.queuedPromptIds.filter((id) => id !== payload.promptId);
      evolve({
        blocks,
        queuedPromptIds: queued,
        busy: true,
        activePromptId:
          payload.status === 'running' ? payload.promptId : next.activePromptId,
      });
      break;
    }
    case 'prompt.completed': {
      const blocks = finalizeStreaming(next.blocks, 'end');
      const failed = payload.reason === 'failed' || payload.reason === 'blocked';
      evolve({
        blocks:
          payload.reason === undefined || payload.reason === 'completed'
            ? blocks
            : [
                ...blocks,
                {
                  kind: 'notice',
                  id: nextNoticeId('prompt'),
                  text: failed ? `Prompt ${payload.reason}` : 'Prompt finished',
                  tone: failed ? ('danger' as const) : ('neutral' as const),
                },
              ],
        busy: false,
        activePromptId:
          next.activePromptId === payload.promptId ? undefined : next.activePromptId,
        queuedPromptIds: next.queuedPromptIds.filter((id) => id !== payload.promptId),
      });
      break;
    }
    case 'prompt.aborted': {
      const blocks = finalizeStreaming(next.blocks, 'end');
      evolve({
        blocks: [
          ...blocks,
          {
            kind: 'notice',
            id: nextNoticeId('prompt'),
            text: 'Prompt aborted',
            tone: 'neutral' as const,
          },
        ],
        busy: false,
        activePromptId:
          next.activePromptId === payload.promptId ? undefined : next.activePromptId,
        queuedPromptIds: next.queuedPromptIds.filter((id) => id !== payload.promptId),
      });
      break;
    }
    case 'agent.status.updated': {
      evolve({
        model: payload.model ?? next.model,
        permissionMode: payload.permission ?? next.permissionMode,
        planMode: payload.planMode ?? next.planMode,
        swarmMode: payload.swarmMode ?? next.swarmMode,
        contextTokens: payload.contextTokens ?? next.contextTokens,
        maxContextTokens: payload.maxContextTokens ?? next.maxContextTokens,
        usage: payload.usage ?? next.usage,
      });
      break;
    }
    case 'goal.updated': {
      evolve({ goal: payload.snapshot, goalUpdatedAt: frame.timestamp });
      break;
    }
    case 'event.session.work_changed': {
      const session =
        next.session !== undefined
          ? {
              ...next.session,
              busy: payload.busy,
              pending_interaction: payload.pending_interaction ?? next.session.pending_interaction,
            }
          : next.session;
      evolve({
        session,
        busy: payload.busy,
        pendingInteraction: payload.pending_interaction ?? 'none',
      });
      break;
    }
    case 'session.meta.updated': {
      if (next.session !== undefined && payload.title !== undefined) {
        evolve({ session: { ...next.session, title: payload.title } });
      }
      break;
    }
    case 'event.approval.requested': {
      const request: ApprovalRequest = {
        approval_id: payload.approval_id,
        session_id: payload.session_id,
        turn_id: payload.turn_id,
        tool_call_id: payload.tool_call_id,
        tool_name: payload.tool_name,
        action: payload.action,
        tool_input_display: payload.tool_input_display,
        created_at: payload.created_at,
        expires_at: payload.expires_at,
      };
      const exists = next.blocks.some((b) => b.id === `approval-${request.approval_id}`);
      evolve({
        blocks: exists ? next.blocks : [...next.blocks, approvalBlock(request)],
        pendingInteraction: 'approval',
      });
      break;
    }
    case 'event.approval.resolved': {
      const key = `approval-${payload.approval_id}`;
      const existing = next.blocks.find((b) => b.id === key) as ApprovalBlock | undefined;
      if (existing === undefined) break;
      const blocks = replaceBlock(next.blocks, {
        ...existing,
        resolution: {
          decision: payload.decision ?? 'resolved_elsewhere',
          resolvedAt: payload.resolved_at,
        },
      });
      evolve({
        blocks,
        pendingInteraction: derivePendingInteraction({ ...next, blocks }),
      });
      break;
    }
    case 'event.question.requested': {
      const request: QuestionRequest = {
        question_id: payload.question_id,
        session_id: payload.session_id,
        turn_id: payload.turn_id,
        tool_call_id: payload.tool_call_id,
        questions: payload.questions,
        created_at: payload.created_at,
      };
      const exists = next.blocks.some((b) => b.id === `question-${request.question_id}`);
      evolve({
        blocks: exists ? next.blocks : [...next.blocks, questionBlock(request)],
        pendingInteraction: 'question',
      });
      break;
    }
    case 'event.question.answered': {
      const key = `question-${payload.question_id}`;
      const existing = next.blocks.find((b) => b.id === key) as QuestionBlock | undefined;
      if (existing === undefined) break;
      const blocks = replaceBlock(next.blocks, {
        ...existing,
        outcome: { kind: 'answered', at: payload.resolved_at },
      });
      evolve({
        blocks,
        pendingInteraction: derivePendingInteraction({ ...next, blocks }),
      });
      break;
    }
    case 'event.question.dismissed': {
      const key = `question-${payload.question_id}`;
      const existing = next.blocks.find((b) => b.id === key) as QuestionBlock | undefined;
      if (existing === undefined) break;
      const blocks = replaceBlock(next.blocks, {
        ...existing,
        outcome: { kind: 'dismissed', at: payload.dismissed_at },
      });
      evolve({
        blocks,
        pendingInteraction: derivePendingInteraction({ ...next, blocks }),
      });
      break;
    }
    case 'task.started':
    case 'background.task.started': {
      const task = taskInfoToTask(payload.info, next.sessionId);
      const without = next.tasks.filter((t) => t.id !== task.id);
      evolve({ tasks: [...without, task] });
      break;
    }
    case 'task.terminated':
    case 'background.task.terminated': {
      const task = taskInfoToTask(payload.info, next.sessionId);
      const without = next.tasks.filter((t) => t.id !== task.id);
      evolve({ tasks: [...without, task] });
      break;
    }
    case 'error': {
      const notice: NoticeBlock = {
        kind: 'notice',
        id: nextNoticeId('error'),
        text: payload.message,
        tone: 'danger',
      };
      evolve({ blocks: [...next.blocks, notice] });
      break;
    }
    default:
      break;
  }

  return { state: next, gapDetected: gap };
}

/** Local echo of the user's own prompt (from the REST submit result). */
export function appendLocalUserMessage(
  state: SessionViewState,
  input: { userMessageId: string; promptId: string; text: string; createdAt: string; queued: boolean },
): SessionViewState {
  const key = `user-${input.userMessageId}`;
  const stableIndex = state.blocks.findIndex(
    (block): block is UserBlock =>
      block.kind === 'user' &&
      (block.id === key ||
        block.userMessageId === input.userMessageId ||
        block.promptId === input.promptId),
  );
  const placeholderIndex = state.blocks.findLastIndex(
    (block): block is UserBlock =>
      block.kind === 'user' &&
      block.userMessageId === undefined &&
      block.promptId === undefined &&
      block.text === input.text,
  );
  const userBlock: UserBlock = {
    kind: 'user',
    id: key,
    text: input.text,
    createdAt: input.createdAt,
    promptId: input.promptId,
    userMessageId: input.userMessageId,
  };
  let blocks = state.blocks;
  if (stableIndex < 0 && placeholderIndex >= 0) {
    const replaced = blocks.slice();
    replaced[placeholderIndex] = userBlock;
    blocks = replaced;
  } else if (stableIndex < 0) {
    blocks = [...blocks, userBlock];
  }
  return {
    ...state,
    version: state.version + 1,
    busy: true,
    activePromptId: input.queued ? state.activePromptId : input.promptId,
    queuedPromptIds: input.queued
      ? state.queuedPromptIds.includes(input.promptId)
        ? state.queuedPromptIds
        : [...state.queuedPromptIds, input.promptId]
      : state.queuedPromptIds,
    blocks,
  };
}

/** Mark an approval block resolved from the local REST answer path. */
export function markApprovalResolved(
  state: SessionViewState,
  approvalId: string,
  resolution: ApprovalResolution,
): SessionViewState {
  const key = `approval-${approvalId}`;
  const existing = state.blocks.find((b) => b.id === key) as ApprovalBlock | undefined;
  if (existing === undefined) return state;
  const blocks = replaceBlock(state.blocks, { ...existing, resolution });
  return {
    ...state,
    version: state.version + 1,
    pendingInteraction: derivePendingInteraction({ ...state, blocks }),
    blocks,
  };
}

export function markQuestionOutcome(
  state: SessionViewState,
  questionId: string,
  outcome: QuestionOutcome,
): SessionViewState {
  const key = `question-${questionId}`;
  const existing = state.blocks.find((b) => b.id === key) as QuestionBlock | undefined;
  if (existing === undefined) return state;
  const blocks = replaceBlock(state.blocks, { ...existing, outcome });
  return {
    ...state,
    version: state.version + 1,
    pendingInteraction: derivePendingInteraction({ ...state, blocks }),
    blocks,
  };
}

export function setTasks(state: SessionViewState, tasks: readonly Task[]): SessionViewState {
  return { ...state, version: state.version + 1, tasks };
}

/** Snapshot/resync cannot reconstruct finished child history. Preserve events
 * this client already observed, while letting the fresh snapshot own live
 * status and roster metadata for agents it still reports. */
export function preserveCapturedSubagents(
  rebuilt: SessionViewState,
  previous: SessionViewState,
): SessionViewState {
  const captured = previous.blocks.filter(
    (block): block is SubagentBlock => block.kind === 'subagent',
  );
  if (captured.length === 0) return rebuilt;
  const capturedById = new Map(captured.map((block) => [block.subagentId, block]));
  const seen = new Set<string>();
  const blocks = rebuilt.blocks.map((block) => {
    if (block.kind !== 'subagent') return block;
    seen.add(block.subagentId);
    const prior = capturedById.get(block.subagentId);
    if (prior === undefined) return block;
    return {
      ...prior,
      ...block,
      model: block.model ?? prior.model,
      thinkingEffort: block.thinkingEffort ?? prior.thinkingEffort,
      toolCallCount: Math.max(block.toolCallCount, prior.toolCallCount),
      transcript: prior.transcript,
      summary: block.summary ?? prior.summary,
      error: block.error ?? prior.error,
    } satisfies SubagentBlock;
  });
  for (const prior of captured) {
    if (!seen.has(prior.subagentId)) blocks.push(prior);
  }
  return { ...rebuilt, version: rebuilt.version + 1, blocks };
}

export function setGoal(
  state: SessionViewState,
  goal: GoalSnapshot | null,
  updatedAt?: string,
): SessionViewState {
  return {
    ...state,
    version: state.version + 1,
    goal,
    goalUpdatedAt: updatedAt ?? state.goalUpdatedAt,
  };
}

export function setSessionRecord(state: SessionViewState, session: Session): SessionViewState {
  return {
    ...state,
    version: state.version + 1,
    session,
    busy: session.busy,
    pendingInteraction: session.pending_interaction ?? 'none',
  };
}

export function setResyncing(state: SessionViewState, resyncing: boolean): SessionViewState {
  if (state.resyncing === resyncing) return state;
  return { ...state, version: state.version + 1, resyncing };
}

export function setResyncFailed(
  state: SessionViewState,
  failed: boolean,
  attempt: number,
): SessionViewState {
  if (state.resyncFailed === failed && state.resyncAttempt === attempt) return state;
  return {
    ...state,
    version: state.version + 1,
    resyncFailed: failed,
    resyncAttempt: attempt,
  };
}

export function setLoadError(
  state: SessionViewState,
  error: string | undefined,
): SessionViewState {
  if (state.loadError === error) return state;
  return {
    ...state,
    version: state.version + 1,
    loadError: error,
    loaded: error === undefined ? state.loaded : false,
  };
}

export function pendingApprovalCount(state: SessionViewState): number {
  return state.blocks.filter((b) => b.kind === 'approval' && b.resolution === undefined).length;
}

export function pendingQuestionCount(state: SessionViewState): number {
  return state.blocks.filter((b) => b.kind === 'question' && b.outcome === undefined).length;
}

/** Recompute the aggregate pending-interaction fact from unresolved blocks. */
export function derivePendingInteraction(state: SessionViewState): SessionPendingInteraction {
  if (pendingApprovalCount(state) > 0) return 'approval';
  if (pendingQuestionCount(state) > 0) return 'question';
  return 'none';
}

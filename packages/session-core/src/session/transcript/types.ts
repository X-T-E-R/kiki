import type {
  ApprovalDecision,
  ApprovalRequest,
  DeferredAppendTiming,
  GoalSnapshot,
  Message,
  PermissionMode,
  PromptStatus,
  QuestionRequest,
  Session,
  SessionPendingInteraction,
  SnapshotSubagent,
  Task,
  TokenUsage,
  ToolInputDisplay,
  UsageStatus,
} from '@kiki/protocol';
import type { TranscriptGlobalCoverage, TranscriptTodoNotes, TranscriptTodoNotesMeta, TranscriptTodoNotesStatus } from '@kiki/transcript';

import type { I18nKey, I18nParams } from '../../i18n/locale';
import type { MediaRef } from '../../composer/media';
import type { ContextBreakdown, WireTokenUsage } from '../../wire';

export interface UserBlock {
  readonly kind: 'user';
  readonly contentSource?: import('@kiki/transcript').ContentSource;
  readonly id: string;
  readonly text: string;
  readonly media?: readonly MediaRef[];
  readonly queuedContent?: Message['content'];
  readonly createdAt: string;
  readonly turnId?: string;
  readonly promptId?: string;
  readonly userMessageId?: string;
  readonly clientRequestId?: string;
  readonly optimisticStatus?: 'sending' | 'slow';
  /**
   * "Send now" (steer) lifecycle of a message sent into a running turn:
   * `sending` until the server accepts it, `waiting` while it sits between
   * acceptance and the next step boundary that puts it in the model's
   * context. Absent once delivered — the bubble is then an ordinary message.
   */
  readonly steerStatus?: 'sending' | 'waiting';
  readonly promptStatus?: PromptStatus;
  /**
   * Terminal outcome of the prompt behind this message when it did not
   * complete. The bubble carries it; there is no separate timeline row.
   */
  readonly promptOutcome?: PromptOutcome;
  readonly agentMessage?: {
    readonly senderAgentId?: string;
    readonly senderTaskName?: string;
  };
  readonly bridgedPeer?: {
    readonly source?: { readonly hostId?: string; readonly workspaceId?: string; readonly sessionId?: string };
    readonly sourceHomeId?: string;
    readonly targetHomeId?: string;
    readonly bridgeId?: string;
    readonly revision?: number;
    readonly location?: 'local' | 'network';
    readonly messageId?: string;
  };
  readonly peerThread?: {
    readonly sessionId?: string;
    readonly personaId?: string;
    readonly senderName?: string;
    readonly messageId?: string;
  };
}

export interface PromptOutcome {
  readonly status: 'failed' | 'aborted';
  /** When the prompt settled (`finishedAt`). */
  readonly at?: string;
  /** Terminal error of the turn it opened, when one is known. */
  readonly error?: string;
  /** True when the message reached a turn; false when it never started. */
  readonly delivered: boolean;
}

/** A settled prompt whose message is outside the loaded window. */
export interface EarlierPromptOutcome {
  readonly promptId: string;
  readonly userMessageId?: string;
  readonly status: PromptOutcome['status'];
  readonly at?: string;
  /** Opening of the message text, for the expanded list. */
  readonly text?: string;
}

export interface SystemReminderBlock {
  readonly kind: 'system-reminder';
  readonly id: string;
  readonly text: string;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
  readonly variant?: string;
  readonly disclosure?: unknown;
  /** The reminder's category and trigger facts, when its disclosure carries a known kind. */
  readonly category?: ReminderCategory;
}

export type ReminderCategoryKind = 'directive' | 'renew' | 'rebuild' | 'history' | 'progress';

export interface ReminderCategory {
  readonly kind: ReminderCategoryKind;
  readonly triggers: readonly string[];
  readonly epoch?: number;
  readonly userTurn?: string;
}

export type SystemVariant =
  | 'injection'
  | 'system_trigger'
  | 'compaction_summary'
  | 'hook_result'
  | 'cron_job'
  | 'cron_missed'
  | 'task'
  | 'retry'
  | 'agent_message'
  | 'system';

export interface SystemBlock {
  readonly kind: 'system';
  readonly id: string;
  readonly variant: SystemVariant;
  readonly text: string;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
  readonly source?: string;
  /** Task notifications: the background task the note is about. */
  readonly taskId?: string;
  /** Hook results: the event that produced it (`kiki:<harness>:<event>` for Kiki's own hooks). */
  readonly hookEvent?: string;
}

export interface SkillBlock {
  readonly kind: 'skill';
  readonly id: string;
  readonly source: 'skill' | 'plugin';
  readonly name: string;
  readonly args: string | undefined;
  readonly text: string;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
}

export interface AssistantBlock {
  readonly kind: 'assistant';
  readonly frameId?: string;
  readonly stepId?: string;
  readonly id: string;
  readonly text: string;
  readonly media?: readonly MediaRef[];
  readonly streaming: boolean;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
  readonly stopped?: boolean;
  readonly messageId?: string;
}

export interface ThinkingBlock {
  readonly kind: 'thinking';
  readonly frameId?: string;
  readonly stepId?: string;
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
}

export type ToolStatus = 'running' | 'done' | 'error' | 'stopped';

export interface ToolAgentRef {
  readonly agentId: string;
  readonly role?: 'child';
}

export interface ToolBlock {
  readonly frameId?: string;
  readonly stepId?: string;
  readonly kind: 'tool';
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly argsText: string;
  readonly args: unknown;
  readonly display: ToolInputDisplay | undefined;
  readonly description: string | undefined;
  readonly status: ToolStatus;
  readonly output: unknown;
  readonly isError: boolean | undefined;
  /** Stable reason for a failure the engine reported, e.g. `codex_mcp_approval_denied`. */
  readonly errorCode?: string;
  /**
   * Epoch ms when the call started, taken from the tool frame's real
   * `startedAt` only — never from step/turn boundaries. `undefined` means the
   * timing is genuinely unknown (e.g. cold replay without frame timestamps) —
   * never a sentinel like 0, which would render as a fake 0ms duration.
   */
  readonly startedAt?: number;
  /**
   * Wall-clock duration. When `durationSource` is `'frame'` this is the real
   * per-tool duration computed from the frame's start/end timestamps; when it
   * is `'turn'` this is the enclosing turn's `durationMs` fallback and must
   * not be presented as the tool's own duration. `undefined` when nothing is
   * known.
   */
  readonly durationMs: number | undefined;
  /** Where `durationMs` came from: real frame endpoints or a turn-level fallback. */
  readonly durationSource?: 'frame' | 'turn';
  readonly progressText: string | undefined;
  readonly agentRefs?: readonly ToolAgentRef[];
  readonly turnId?: string;
}

/** A SendMessage invocation projected as speech, never ordinary assistant prose. */
export interface MessageBlock {
  readonly kind: 'message';
  readonly id: string;
  readonly toolCallId?: string;
  readonly messageId?: string;
  readonly origin: 'send_message' | 'persona_greeting';
  readonly status: 'sending' | 'sent' | 'failed' | 'cancelled';
  readonly text: string;
  readonly to?: string;
  readonly replyTo?: string;
  readonly attachments: readonly MessageAttachment[];
  readonly deliveredTo: readonly string[];
  readonly personaId?: string;
  readonly senderName?: string;
  readonly sourceSessionId?: string;
  readonly handoff?: {
    readonly targetPersonaId: string;
    readonly targetSessionId: string;
    readonly targetName: string;
    readonly messageId?: string;
  };
  readonly startedAt?: number;
  readonly turnId?: string;
  /** The original call remains available for process inspection and streaming argsText. */
  readonly sourceTool?: ToolBlock;
}

export interface MessageAttachment {
  readonly blobId: string;
  readonly path: string;
  readonly title?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

/** A contiguous, same-turn stretch of internal activity; members retain original order. */
export interface ActivitySummary {
  readonly kind: 'activity-summary';
  readonly id: string;
  readonly turnId?: string;
  readonly members: readonly Block[];
  readonly counts: {
    readonly tools: number;
    readonly reads: number;
    readonly commands: number;
    readonly thinking: number;
    readonly subagents: number;
    readonly memories: number;
  };
  readonly running: boolean;
  readonly failed: number;
  /** Only measured tool-frame durations; turn-level fallbacks are not added repeatedly. */
  readonly durationMs?: number;
}

export interface ShellBlock {
  readonly frameId?: string;
  readonly stepId?: string;
  readonly outputTaskId?: string;
  readonly kind: 'shell';
  readonly id: string;
  readonly commandId: string;
  readonly command: string | undefined;
  readonly output: string;
  /**
   * Set when `output` is only the tail of a longer task output; the full
   * body is read on demand through the transcript detail route.
   */
  readonly outputDetail?: { readonly agentId: string; readonly taskId: string };
  readonly done: boolean;
  readonly isError: boolean | undefined;
  readonly startedAt?: number;
  readonly turnId?: string;
}

export interface SubagentBlock {
  readonly kind: 'subagent';
  readonly id: string;
  readonly subagentId: string;
  readonly parentAgentId: string | undefined;
  readonly parentToolCallId: string | undefined;
  readonly parentToolCallUuid?: string;
  readonly parentTurnId?: string;
  readonly name: string;
  readonly label?: string;
  readonly description: string | undefined;
  readonly instruction?: string;
  readonly model: string | undefined;
  readonly thinkingEffort: string | undefined;
  readonly status: 'unknown' | 'idle' | 'lost' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  readonly summary: string | undefined;
  readonly error: string | undefined;
  readonly usage?: TokenUsage;
  /**
   * ISO start time from the task / tool-frame contract. `undefined` means the
   * start time is unknown — consumers must render "unknown" rather than
   * parsing an empty string into a NaN → fake 0ms duration.
   */
  readonly startedAt?: string;
  readonly endedAt: string | undefined;
  readonly toolCallCount: number;
  /** False means the numeric count is a placeholder, not evidence of zero tool calls. */
  readonly toolCallCountKnown?: boolean;
  readonly transcript: readonly Block[];
  readonly orphaned?: boolean;
}

export type SubagentLifecycleEvent =
  | 'spawned'
  | 'resumed'
  | 'sent'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Compact one-line lifecycle entry for a subagent (G-4 dual-form timeline):
 * status dot + name + event + time, click jumps to the agent page. Each
 * lifecycle event lands in place at its own timestamp; the full SubagentBlock
 * card coexists for the currently active run and collapses to its own compact
 * form once terminal. GUI-local model — the wire contract only carries task
 * entities, taskrefs, and tool-frame agentRefs; events are derived at
 * projection time.
 */
export interface SubagentEventBlock {
  readonly kind: 'subagent-event';
  readonly id: string;
  readonly subagentId: string;
  readonly parentAgentId: string | undefined;
  readonly name: string;
  readonly event: SubagentLifecycleEvent;
  readonly status: SubagentBlock['status'];
  readonly at: string | undefined;
  readonly turnId?: string;
  readonly error?: string;
  readonly message?: string;
  readonly messageId?: string;
  readonly delivery?: 'queued' | 'delivered';
  readonly deliveredAt?: string;
  /**
   * Tool call that triggered this entry (sent/resumed). When the triggering
   * ToolBlock is on the page, the entry anchors right after it instead of
   * racing the timeline sort (equal timestamps would otherwise order
   * `subagent-event-…` before `tool-…`, inverting cause and effect).
   */
  readonly anchorToolCallId?: string;
}

export interface NoticeBlock {
  readonly modelSwitch?: {
    readonly operationId: string;
    readonly mode: 'direct' | 'compact' | 'fresh';
    readonly state: 'pending' | 'preparing' | 'completed' | 'failed' | 'cancelled';
    readonly from: string;
    readonly to: string;
    readonly summaryGenerated?: boolean;
    readonly windowEpoch?: number;
    readonly error?: { readonly code: string; readonly message: string };
  };
  readonly kind: 'notice';
  readonly id: string;
  readonly text: string;
  readonly tone: 'neutral' | 'danger';
  readonly createdAt?: string;
  readonly turnId?: string;
  readonly i18n?: { readonly key: I18nKey; readonly params?: I18nParams };
  readonly reasonCodes?: readonly string[];
  readonly markerRepeatCount?: number;
  /** External-engine runtime fact the GUI renders as a quiet in-turn note, not a divider. */
  readonly executor?: ExecutorNote;
  /**
   * Set on the single `notice-prompt-outcomes-earlier` row: settled prompts
   * whose messages sit in history pages that are not loaded yet.
   */
  readonly earlierPromptOutcomes?: readonly EarlierPromptOutcome[];
}

/**
 * External-engine records carried by a notice: a prompt-delivery status
 * (`executor.prompt.delivery`), an engine compaction, a whole-turn diff, or an
 * update Kiki could not map. `queued` is not delivered and never shown as such.
 */
export type ExecutorNote =
  | {
      readonly kind: 'hint';
      readonly method: 'native_steer' | 'next_turn_preamble' | 'undelivered';
      readonly status: 'delivered' | 'queued' | 'undelivered';
      readonly origin?: string;
    }
  | { readonly kind: 'compaction' }
  | { readonly kind: 'diff'; readonly diff: string }
  | { readonly kind: 'unknown'; readonly updateType?: string };

export interface ApprovalResolution {
  readonly decision: ApprovalDecision | 'expired' | 'resolved_elsewhere';
  readonly resolvedAt: string;
  /** Set when an automatic reviewer (Approve-for-me mode) made the decision. */
  readonly reviewer?: ApprovalReviewer;
}

export interface ApprovalReviewer {
  readonly backend: 'model' | 'jev';
  readonly reason: string;
  readonly confidence: number;
}

export interface ApprovalBlock {
  readonly kind: 'approval';
  readonly id: string;
  readonly request: ApprovalRequest;
  readonly resolution: ApprovalResolution | undefined;
  readonly originAgentId?: string;
  readonly originUnknown?: boolean;
}

export type QuestionOutcome =
  | { readonly kind: 'answered'; readonly at: string; readonly answers?: Readonly<Record<string, string>> }
  | { readonly kind: 'dismissed'; readonly at: string }
  | { readonly kind: 'cancelled'; readonly at: string; readonly reason?: string }
  | { readonly kind: 'resolvedElsewhere'; readonly at: string }
  | { readonly kind: 'unavailable'; readonly at: string }
  | { readonly kind: 'expired' };

export interface QuestionBlock {
  readonly kind: 'question';
  readonly id: string;
  readonly request: QuestionRequest;
  readonly outcome: QuestionOutcome | undefined;
  readonly originAgentId?: string;
  readonly originUnknown?: boolean;
}

export type Block =
  | UserBlock
  | SystemReminderBlock
  | SystemBlock
  | SkillBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | MessageBlock
  | ShellBlock
  | SubagentBlock
  | SubagentEventBlock
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

export interface TurnTailInfo {
  readonly turnId: string;
  readonly state?: string;
  /**
   * Why a `cancelled` turn ended: `user` (an explicit stop), `aborted`,
   * `recovery` (found unfinished after a restart), or `unknown` (older
   * records without provenance). Absent on other states.
   */
  readonly cancellation?: 'user' | 'aborted' | 'recovery' | 'unknown';
  readonly error?: string;
  readonly endedAt: string;
  readonly durationMs: number | undefined;
  readonly ttftMs: number | undefined;
  readonly usage: WireTokenUsage | undefined;
  readonly tokensPerSecond: number | undefined;
}

/**
 * External-executor provenance of one turn, projected from the supplemental
 * `executor.turn.metadata` wire record onto `TranscriptTurn.execution`
 * (design: analyses/systems/2026-08-28-kiki-external-harness-engine-design.md
 * §8). GUI-local structural type — the transcript contract lands in
 * `packages/transcript` separately; fields are validated at projection time.
 */
export interface TurnExecutionInfo {
  readonly executorId: string;
  readonly protocol: string;
  readonly resumeMode: string | undefined;
  /** How the profile instructions reached the engine (`first_prompt_preamble`, `system_prompt_override`, …). */
  readonly profileDelivery?: string;
  readonly fidelity: 'full' | 'degraded';
  /** Stable loss codes (e.g. `tool_output_summary_only`); open set. */
  readonly losses: readonly string[];
}

/**
 * A provider retry in flight on the live turn's running step. Present only
 * while the engine is backing off between attempts; cleared by the step's
 * next upsert (progress or terminal), so the status line can name the wait
 * instead of showing minutes of unexplained silence.
 */
export interface TurnRetryInfo {
  readonly failedAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName?: string;
  readonly statusCode?: number;
}

/** Kind of a windowed global entity whose full body is read on demand. */
export type TranscriptDetailKind = 'task' | 'attachment' | 'prompt';

/** Load state of one on-demand detail read (absent = not requested). */
export type TranscriptDetailStatus =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string };

/** `${kind}:${id}` — the key of {@link SessionViewState.detailLoads}. */
export function transcriptDetailKey(kind: TranscriptDetailKind, id: string): string {
  return `${kind}:${id}`;
}

export interface SessionViewState {
  readonly contentRefs?: readonly import('@kiki/transcript').ContentRef[];
  readonly version: number;
  readonly transcriptResetVersion: number;
  readonly sessionId: string;
  readonly session: Session | undefined;
  readonly blocks: readonly Block[];
  readonly cursor: SessionCursorState;
  readonly busy: boolean;
  readonly turnStartedAt: number | undefined;
  readonly turnFirstTokenAt: number | undefined;
  readonly turnTail: TurnTailInfo | undefined;
  readonly turnRetry: TurnRetryInfo | undefined;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly activePromptId: string | undefined;
  /** Running engine prompt, independent of whether its origin has a visible prompt row. */
  readonly abortablePromptId: string | undefined;
  /** Running main-agent turn, including steps admitted without a prompt record. */
  readonly abortableTurnId: number | undefined;
  readonly queuedPromptIds: readonly string[];
  readonly promptQueueHold: { readonly reason: 'recovery'; readonly count: number } | undefined;
  /**
   * Per-queued-prompt scheduling state (effective `append_timing` plus the
   * scheduling `revision` used as the optimistic-concurrency token for
   * `:timing`). Keyed by promptId; entries only exist while the prompt is
   * queued.
   */
  readonly queuedPromptMeta: Readonly<Record<string, QueuedPromptMeta>>;
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly thinkingEffort: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly planMode: boolean;
  readonly goal: GoalSnapshot | null | undefined;
  readonly goalUpdatedAt: string | undefined;
  readonly contextTokens: number | undefined;
  readonly maxContextTokens: number | undefined;
  readonly contextBreakdown: ContextBreakdown | undefined;
  readonly usage: UsageStatus | undefined;
  /** turnId → external-executor provenance for turns that ran off-kiki. */
  readonly turnExecutions: Readonly<Record<string, TurnExecutionInfo>>;
  readonly todos: readonly TodoItem[];
  readonly todoNotes: TranscriptTodoNotes | undefined;
  readonly todoNotesMeta: TranscriptTodoNotesMeta | undefined;
  readonly todoNotesStatus: TranscriptTodoNotesStatus | undefined;
  readonly tasks: readonly Task[];
  /**
   * Compact REST snapshot roster (`snapshot.subagents`). Display fallback for
   * inline cards / Agent Tree when the child transcript is not folded on cold
   * open. Never used to invent cards that are not on the current page.
   */
  readonly snapshotSubagents: readonly SnapshotSubagent[];
  readonly agentCounts?: import('@kiki/protocol').SessionAgentCounts;
  /**
   * How much of each global collection the last windowed reset carried.
   * Undefined for servers that send the full collections.
   */
  readonly globalCoverage: TranscriptGlobalCoverage | undefined;
  /** On-demand detail reads in flight or failed, keyed by {@link transcriptDetailKey}. */
  readonly detailLoads: Readonly<Record<string, TranscriptDetailStatus>>;
  readonly resyncing: boolean;
  readonly resyncFailed: boolean;
  readonly resyncAttempt: number;
  readonly resyncError?: {
    readonly message: string;
    readonly code?: number;
    readonly requestId?: string;
    readonly retryable: boolean;
  };
  readonly loaded: boolean;
  /**
   * The main agent transcript has projected at least one snapshot/reset. The
   * session shell (`applyTranscriptShell`) flips `loaded` without any
   * transcript data, so consumers that reason about transcript-carried state
   * (queue contents, goal meta) must gate on this instead.
   */
  readonly transcriptReady: boolean;
  readonly loadError: string | undefined;
  readonly hasMoreHistory: boolean;
  readonly historyCoverageKind: 'full' | 'tail' | 'unknown' | undefined;
  readonly oldestMessageId: string | undefined;
  readonly loadingOlder: boolean;
  readonly fetchedOlder: boolean;
  readonly olderError: string | undefined;
}

export function createViewState(sessionId: string): SessionViewState {
  return {
    version: 0,
    transcriptResetVersion: 0,
    sessionId,
    session: undefined,
    blocks: [],
    cursor: { seq: 0, epoch: undefined },
    busy: false,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    turnTail: undefined,
    turnRetry: undefined,
    pendingInteraction: 'none',
    activePromptId: undefined,
    abortablePromptId: undefined,
    abortableTurnId: undefined,
    queuedPromptIds: [],
    promptQueueHold: undefined,
    queuedPromptMeta: {},
    model: undefined,
    profile: undefined,
    thinkingEffort: undefined,
    permissionMode: undefined,
    planMode: false,
    goal: undefined,
    goalUpdatedAt: undefined,
    contextTokens: undefined,
    maxContextTokens: undefined,
    contextBreakdown: undefined,
    usage: undefined,
    turnExecutions: {},
    todos: [],
    todoNotes: undefined,
    todoNotesMeta: undefined,
    todoNotesStatus: undefined,
    tasks: [],
    snapshotSubagents: [],
    globalCoverage: undefined,
    detailLoads: {},
    resyncing: false,
    resyncFailed: false,
    resyncAttempt: 0,
    loaded: false,
    transcriptReady: false,
    loadError: undefined,
    hasMoreHistory: false,
    historyCoverageKind: undefined,
    oldestMessageId: undefined,
    loadingOlder: false,
    fetchedOlder: false,
    olderError: undefined,
  };
}

export interface FloorEntry {
  readonly blockId: string;
  readonly preview: string;
}

export interface QueuedPromptMeta {
  readonly appendTiming: DeferredAppendTiming;
  readonly revision?: number;
  /**
   * The engine's shared queue-order slot (model-switch control items occupy
   * slots in the same sequence). Absent for locally echoed prompts that the
   * server has not parked yet.
   */
  readonly queuePosition?: number;
}

export interface QueuedPromptPreview {
  readonly promptId: string;
  readonly text: string;
  readonly media?: readonly MediaRef[];
  readonly content?: Message['content'];
  /** Effective append timing; absent on older servers, displays as agent_idle. */
  readonly appendTiming?: DeferredAppendTiming;
  readonly revision?: number;
  /** Shared queue-order slot, when the server has parked the prompt. */
  readonly queuePosition?: number;
}

export interface SpawnInstruction {
  readonly text: string;
  readonly source: 'transcript' | 'spawn-call';
  readonly turnId?: string;
  readonly duplicateBlockIds: readonly string[];
}

export function bump(state: SessionViewState, patch: Partial<SessionViewState>): SessionViewState {
  return { ...state, ...patch, version: state.version + 1 };
}

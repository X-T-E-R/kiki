import type {
  ApprovalDecision,
  ApprovalRequest,
  GoalSnapshot,
  PermissionMode,
  PromptStatus,
  QuestionRequest,
  Session,
  SessionPendingInteraction,
  Task,
  TokenUsage,
  ToolInputDisplay,
  UsageStatus,
} from '@moonshot-ai/protocol';

import type { I18nKey, I18nParams } from '../../i18n/locale';
import type { ContextBreakdown, WireTokenUsage } from '../../lib/types';
import type { MediaRef } from '../../lib/media';

export interface UserBlock {
  readonly kind: 'user';
  readonly id: string;
  readonly text: string;
  readonly media?: readonly MediaRef[];
  readonly createdAt: string;
  readonly turnId?: string;
  readonly promptId?: string;
  readonly userMessageId?: string;
  readonly clientRequestId?: string;
  readonly promptStatus?: PromptStatus;
}

export interface SystemReminderBlock {
  readonly kind: 'system-reminder';
  readonly id: string;
  readonly text: string;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
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

export interface SteerBlock {
  readonly kind: 'steer';
  readonly id: string;
  readonly text: string;
  readonly media?: readonly MediaRef[];
  readonly createdAt: string;
  readonly promptId?: string;
  readonly userMessageId?: string;
  readonly activePromptId?: string;
}

export interface AssistantBlock {
  readonly kind: 'assistant';
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
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string | undefined;
  readonly turnId?: string;
}

export type ToolStatus = 'running' | 'done' | 'error' | 'stopped';

export interface ToolAgentRef {
  readonly agentId: string;
  readonly role?: 'child' | 'member';
}

export interface ToolBlock {
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
  readonly startedAt: number;
  readonly durationMs: number | undefined;
  readonly progressText: string | undefined;
  readonly agentRefs?: readonly ToolAgentRef[];
  readonly turnId?: string;
}

export interface ShellBlock {
  readonly kind: 'shell';
  readonly id: string;
  readonly commandId: string;
  readonly output: string;
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
  readonly status: 'unknown' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  readonly summary: string | undefined;
  readonly error: string | undefined;
  readonly usage?: TokenUsage;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly toolCallCount: number;
  readonly transcript: readonly Block[];
  readonly orphaned?: boolean;
}

export interface NoticeBlock {
  readonly kind: 'notice';
  readonly id: string;
  readonly text: string;
  readonly tone: 'neutral' | 'danger';
  readonly i18n?: { readonly key: I18nKey; readonly params?: I18nParams };
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
  readonly originAgentId?: string;
  readonly originUnknown?: boolean;
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
  readonly originAgentId?: string;
  readonly originUnknown?: boolean;
}

export type Block =
  | UserBlock
  | SystemReminderBlock
  | SystemBlock
  | SkillBlock
  | SteerBlock
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

export interface TurnTailInfo {
  readonly turnId: string;
  readonly endedAt: string;
  readonly durationMs: number | undefined;
  readonly ttftMs: number | undefined;
  readonly usage: WireTokenUsage | undefined;
  readonly tokensPerSecond: number | undefined;
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

export interface SessionViewState {
  readonly version: number;
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
  readonly queuedPromptIds: readonly string[];
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly thinkingEffort: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly planMode: boolean;
  readonly swarmMode: boolean;
  readonly goal: GoalSnapshot | null | undefined;
  readonly goalUpdatedAt: string | undefined;
  readonly contextTokens: number | undefined;
  readonly maxContextTokens: number | undefined;
  readonly contextBreakdown: ContextBreakdown | undefined;
  readonly usage: UsageStatus | undefined;
  readonly todos: readonly TodoItem[];
  readonly tasks: readonly Task[];
  readonly resyncing: boolean;
  readonly resyncFailed: boolean;
  readonly resyncAttempt: number;
  readonly loaded: boolean;
  readonly loadError: string | undefined;
  readonly hasMoreHistory: boolean;
  readonly oldestMessageId: string | undefined;
  readonly loadingOlder: boolean;
  readonly fetchedOlder: boolean;
  readonly olderError: string | undefined;
}

export function createViewState(sessionId: string): SessionViewState {
  return {
    version: 0,
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
    queuedPromptIds: [],
    model: undefined,
    profile: undefined,
    thinkingEffort: undefined,
    permissionMode: undefined,
    planMode: false,
    swarmMode: false,
    goal: undefined,
    goalUpdatedAt: undefined,
    contextTokens: undefined,
    maxContextTokens: undefined,
    contextBreakdown: undefined,
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
    olderError: undefined,
  };
}

export interface FloorEntry {
  readonly blockId: string;
  readonly preview: string;
}

export interface QueuedPromptPreview {
  readonly promptId: string;
  readonly text: string;
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

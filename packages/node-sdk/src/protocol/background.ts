/**
 * Background-task info as the SDK reports it. The engine models tasks as
 * `process` / `agent` / `question` kinds over one shared base; hosts render
 * the union.
 */

export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  /**
   * `false` means a tool call is still waiting on this task in the
   * foreground. Omitted legacy records should be treated as detached.
   */
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Human-readable reason for the terminal status, when available. */
  readonly stopReason?: string;
  /** Suppress automatic terminal notifications/reminders for this task. */
  readonly terminalNotificationSuppressed?: boolean;
  /** Deadline supplied at registration; surfaced via task info. */
  readonly timeoutMs?: number;
}

export interface ProcessBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  /** Subagent identifier accepted by a resume. */
  readonly agentId?: string;
  /** Subagent profile name. */
  readonly profile?: string;
  /** Display-normalized bound model alias. */
  readonly model?: string;
  /** The subagent's effective thinking effort at spawn. */
  readonly thinkingEffort?: string;
  readonly collaborationTaskName?: string;
  readonly collaborationAgentType?: string;
}

export interface QuestionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;

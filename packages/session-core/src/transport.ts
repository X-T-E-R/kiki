import type {
  ApprovalResolveRequest,
  ApprovalResolveResult,
  CancelTaskQuery,
  ConfigResponse,
  DeferredAppendTiming,
  MessageContent,
  PageResponse,
  PatchConfigRequest,
  PermissionMode,
  PromptAbortResponse,
  PromptMoveRequest,
  PromptMoveResult,
  PromptPlanGate,
  PromptReplaceRequest,
  PromptReplaceResult,
  PromptSteerResult,
  PromptSubmission,
  PromptSubmitResult,
  PromptTimingRequest,
  PromptTimingResult,
  QuestionDismissResult,
  QuestionResolveRequest,
  QuestionResolveResult,
  RequestIdentityPolicyWire,
  Session,
  SessionSnapshotResponse,
} from '@kiki/protocol';
import type { TranscriptCursor, TranscriptGradeSpec } from '@kiki/transcript';

export class ApiError extends Error {
  readonly code: number;
  readonly requestId: string | undefined;
  readonly data: unknown;

  constructor(envelope: { code: number; msg: string; data: unknown; request_id?: string }) {
    super(`${envelope.msg} (code ${envelope.code})`);
    this.name = 'ApiError';
    this.code = envelope.code;
    this.data = envelope.data;
    this.requestId = envelope.request_id;
  }
}

export const API_CODES = {
  INVALID_RESPONSE: -3,
  TIMEOUT: -2,
  SUCCESS: 0,
  REQUEST_INVALID: 40001,
  UNAUTHORIZED: 40101,
  SESSION_NOT_FOUND: 40401,
  PROMPT_NOT_FOUND: 40402,
  SKILL_NOT_FOUND: 40415,
  SESSION_BUSY: 40901,
  APPROVAL_ALREADY_RESOLVED: 40902,
  PROMPT_ALREADY_COMPLETED: 40903,
  TASK_ALREADY_FINISHED: 40904,
  QUESTION_DISMISSED: 40909,
  COMPACTION_UNABLE: 40910,
  SESSION_UNDO_UNAVAILABLE: 40911,
  SKILL_NOT_ACTIVATABLE: 40912,
  APPROVAL_EXPIRED: 41001,
  QUESTION_EXPIRED: 41002,
  TERMINAL_NOT_FOUND: 40414,
  MESSAGE_ACTION_UNAVAILABLE: 40936,
  SESSION_CURSOR_MISMATCH: 40937,
  SESSION_INDEX_BUILDING: 40939,
} as const;

export const DEFAULT_TRANSCRIPT_GRADES: TranscriptGradeSpec = {
  '*': 'turn',
  main: 'delta',
};

export function transcriptGradesForFocus(focusedAgentId: string | undefined): TranscriptGradeSpec {
  if (focusedAgentId === undefined || focusedAgentId === 'main') return DEFAULT_TRANSCRIPT_GRADES;
  return { '*': 'turn', main: 'delta', [focusedAgentId]: 'delta' };
}

export interface SearchMessageHit {
  session_id: string;
  workspace_id: string;
  session_title: string;
  agent_id: string;
  role: 'user' | 'assistant' | 'title';
  snippet: string;
  time: number;
  turn?: number;
  step_id?: string;
  score: number;
}

export interface SessionCursor {
  readonly seq: number;
  readonly epoch?: string;
}

export interface MessageRunOverrides {
  readonly model?: string;
  readonly thinking?: string;
  readonly permission_mode?: PermissionMode;
  readonly plan_gate?: PromptPlanGate;
  readonly plan_mode?: boolean;
  readonly swarm_mode?: boolean;
}

export interface EditMessageRequest extends MessageRunOverrides {
  readonly content: MessageContent[];
  readonly expected_cursor: SessionCursor;
}

export interface RegenerateMessageRequest extends MessageRunOverrides {
  readonly expected_cursor: SessionCursor;
}

export interface KikiForkSessionRequest {
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly through_message_id?: string;
  readonly expected_cursor?: SessionCursor;
}

export interface RuntimeConfigProjection {
  readonly cron?: {
    readonly debug: boolean;
    readonly noJitter: boolean;
    readonly noStale: boolean;
    readonly disabled: boolean;
    readonly manualTick: boolean;
    readonly clock?: string;
    readonly pollIntervalMs?: number | null;
  };
  readonly thread_communication?: { readonly enabled: boolean };
  readonly token_counting?: { readonly strategy: 'measured+estimated' | 'measured' | 'estimated' };
  readonly workspace_instance?: { readonly idleTtlMs?: number };
  readonly image?: { readonly maxEdgePx?: number; readonly readByteBudget?: number };
  readonly task?: {
    readonly maxRunningTasks?: number;
    readonly keepAliveOnExit?: boolean;
    readonly bashAutoBackgroundOnTimeout?: boolean;
    readonly bashTaskTimeoutS?: number;
    readonly killGracePeriodMs?: number;
    readonly printWaitCeilingS?: number;
    readonly printBackgroundMode?: 'exit' | 'drain' | 'steer';
    readonly printMaxTurns?: number;
  };
  readonly identity?: { readonly name?: string; readonly slug?: string };
  readonly extra_agent_dirs?: string[];
  readonly disabled_builtin_profiles?: string[];
  readonly disabled_named_profiles?: string[];
  readonly mcp?: { readonly startupTimeoutMs?: number; readonly toolTimeoutMs?: number };
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
  readonly agents?: { readonly enabled?: boolean; readonly notify_parent?: boolean };
}

export type KikiConfigResponse = Omit<ConfigResponse, 'subagent'> & RuntimeConfigProjection & {
  readonly subagent?: NonNullable<ConfigResponse['subagent']> & {
    readonly denyModels?: string[];
  };
};

export interface RuntimeConfigPatch {
  readonly cron?: {
    readonly debug: boolean;
    readonly no_jitter: boolean;
    readonly no_stale: boolean;
    readonly disabled: boolean;
    readonly manual_tick: boolean;
    readonly clock?: string;
    readonly poll_interval_ms?: number | null;
  };
  readonly thread_communication?: { readonly enabled: boolean };
  readonly token_counting?: { readonly strategy: 'measured+estimated' | 'measured' | 'estimated' };
  readonly workspace_instance?: { readonly idle_ttl_ms?: number };
  readonly image?: { readonly max_edge_px?: number; readonly read_byte_budget?: number };
  readonly task?: {
    readonly max_running_tasks?: number;
    readonly keep_alive_on_exit?: boolean;
    readonly bash_auto_background_on_timeout?: boolean;
    readonly bash_task_timeout_s?: number;
    readonly kill_grace_period_ms?: number;
    readonly print_wait_ceiling_s?: number;
    readonly print_background_mode?: 'exit' | 'drain' | 'steer';
    readonly print_max_turns?: number;
  };
  readonly identity?: { readonly name?: string; readonly slug?: string };
  readonly extra_agent_dirs?: string[];
  readonly disabled_builtin_profiles?: string[];
  readonly disabled_named_profiles?: string[];
  readonly mcp?: { readonly startup_timeout_ms?: number; readonly tool_timeout_ms?: number };
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
  readonly agents?: { readonly enabled?: boolean; readonly notify_parent?: boolean };
}

export type KikiConfigPatch = Omit<
  PatchConfigRequest,
  'subagent' | 'replace_domains' | 'request_identity'
> & RuntimeConfigPatch & {
  readonly request_identity?: RequestIdentityPolicyWire | null;
  readonly subagent?: NonNullable<PatchConfigRequest['subagent']> & {
    readonly deny_models?: string[];
  };
  readonly replace_domains?: readonly string[];
};

export type McpTransport = 'stdio' | 'http' | 'sse';

interface McpCommonConfig {
  readonly enabled?: boolean;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabledTools?: readonly string[];
  readonly disabledTools?: readonly string[];
}

export type McpServerConfig =
  | (McpCommonConfig & {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
      readonly executor?: 'local' | 'kaos';
      readonly runtime_id?: string;
    })
  | (McpCommonConfig & {
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly auth?: 'oauth';
      readonly bearerTokenEnvVar?: string;
    });

export type McpServerConfigView =
  | (Omit<Extract<McpServerConfig, { readonly transport: 'stdio' }>, 'env'> & {
      readonly envKeys?: readonly string[];
    })
  | (Omit<Exclude<McpServerConfig, { readonly transport: 'stdio' }>, 'headers'> & {
      readonly headerKeys?: readonly string[];
    });

export type McpManagedServerConfig = McpServerConfig | McpServerConfigView;

export interface McpManagedServer {
  readonly name: string;
  readonly config: McpManagedServerConfig;
  readonly source: 'global' | 'plugin' | 'caller';
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: { readonly id: string; readonly name: string };
}

export type AgentTranscriptFrame =
  | {
      kind: 'text';
      frameId: string;
      role: 'assistant' | 'user';
      text: string;
      taskId?: string;
      origin?: unknown;
    }
  | { kind: 'thinking'; frameId: string; text: string }
  | {
      kind: 'tool';
      frameId: string;
      toolCallId: string;
      name: string;
      state: 'running' | 'done' | 'error' | 'interrupted';
      input?: unknown;
      output?: unknown;
      display?: unknown;
      error?: string;
      inputText?: string;
      startedAt?: string;
      endedAt?: string;
      progress?: { text?: string };
      agentRefs?: readonly { readonly agentId: string; readonly role?: 'child' | 'member' }[];
    }
  | { kind: 'notice'; frameId: string; level: 'error' | 'warning' | 'info'; message: string };

export interface AgentTranscriptTurn {
  readonly kind: 'turn';
  readonly turnId: string;
  readonly prompt?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly execution?: unknown;
  readonly steps: readonly {
    stepId: string;
    startedAt?: string;
    endedAt?: string;
    frames: readonly AgentTranscriptFrame[];
  }[];
}

export interface AgentTranscriptInteraction {
  readonly interactionId: string;
  readonly interactionKind: 'approval' | 'question';
  readonly toolCallId?: string;
  readonly origin?: unknown;
  readonly anchor?: unknown;
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  readonly request?: unknown;
  readonly response?: unknown;
}

export interface AgentTranscriptAgent {
  readonly agentId: string;
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string;
  readonly delegator?:
    | { readonly kind: 'agent'; readonly agentId: string }
    | { readonly kind: 'external'; readonly delegationId: string };
  readonly label?: string;
  readonly createdAt?: string;
  readonly disposedAt?: string;
}

export interface AgentTranscriptStepUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface AgentTranscriptTask {
  readonly taskId: string;
  readonly kind: 'shell' | 'subagent' | 'tool' | 'other';
  readonly state: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  readonly detached: boolean;
  readonly name?: string;
  readonly subagentName?: string;
  readonly description?: string;
  readonly agentId?: string;
  readonly outputTail: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly stateReason?: string;
  readonly usage?: AgentTranscriptStepUsage;
}

export interface AgentTranscriptAttachment {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly name?: string;
  readonly size?: number;
  readonly source?:
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'file'; readonly fileId: string }
    | { readonly kind: 'session_media'; readonly fileId: string };
  readonly placeholder?: string;
}

export interface AgentTranscriptTodo {
  readonly todoId: string;
  readonly items: readonly {
    readonly title: string;
    readonly status: 'pending' | 'in_progress' | 'done';
  }[];
  readonly updatedAt?: string;
}

export interface AgentTranscriptPrompt {
  readonly promptId: string;
  readonly status: 'running' | 'queued' | 'blocked' | 'completed' | 'failed' | 'aborted';
  readonly userMessageId?: string;
  readonly content?: unknown;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly queuePosition?: number;
  readonly abortedBeforeStart?: boolean;
  readonly steeredAt?: string;
  readonly appendTiming?: DeferredAppendTiming;
  readonly revision?: number;
}

export interface AgentTranscriptMeta {
  readonly goal?: {
    readonly objective: string;
    readonly status: 'active' | 'paused' | 'blocked' | 'complete';
    readonly completionCriterion?: string;
    readonly budgetUsed?: number;
    readonly budgetLimit?: number;
    readonly followUpTiming?: 'subagents_done' | 'tasks_done';
    readonly controlRevision?: number;
  };
  readonly modes?: {
    readonly plan?: { readonly reviewPath?: string; readonly version?: number };
    readonly swarm?: { readonly trigger?: string };
  };
  readonly activity?: 'idle' | 'turn' | 'disposing' | 'unknown';
  readonly promptQueueHold?: {
    readonly reason: 'recovery';
    readonly count: number;
  };
  readonly agent?: {
    readonly model?: string;
    readonly thinkingEffort?: string;
    readonly usage?: {
      readonly byModel?: Readonly<Record<string, AgentTranscriptStepUsage>>;
      readonly currentTurn?: AgentTranscriptStepUsage;
      readonly total?: AgentTranscriptStepUsage;
    };
    readonly contextTokens?: number;
    readonly maxContextTokens?: number;
    readonly contextUsage?: number;
    readonly permission?: 'manual' | 'yolo' | 'auto';
    readonly phase?: { readonly kind: string; readonly [key: string]: unknown };
  };
}

export interface AgentTranscriptResponse {
  readonly agent_id: string;
  readonly items: readonly (
    | AgentTranscriptTurn
    | { kind: 'marker'; markerId: string; marker: string; at?: string }
    | { kind: 'taskref'; refId: string; taskId: string; at?: string }
  )[];
  readonly has_more: boolean;
  readonly tool_call_count?: number;
  readonly cursor?: { readonly seq: number; readonly epoch?: string };
  readonly interactions?: readonly AgentTranscriptInteraction[];
  readonly agents?: readonly AgentTranscriptAgent[];
  readonly tasks?: readonly AgentTranscriptTask[];
  readonly todos?: readonly AgentTranscriptTodo[];
  readonly prompts?: readonly AgentTranscriptPrompt[];
  readonly meta?: AgentTranscriptMeta;
  readonly pending_interactions?: readonly string[];
  readonly seq?: number;
  readonly attachments?: readonly AgentTranscriptAttachment[];
  readonly origin?: unknown;
  readonly anchor?: unknown;
}

export interface SessionTransport {
  getSession(sessionId: string): Promise<Session>;
  submitPrompt(sessionId: string, body: PromptSubmission): Promise<PromptSubmitResult>;
  editMessage(sessionId: string, messageId: string, body: EditMessageRequest): Promise<PromptSubmitResult>;
  regenerateMessage(sessionId: string, messageId: string, body: RegenerateMessageRequest): Promise<PromptSubmitResult>;
  forkSession(sessionId: string, body: KikiForkSessionRequest): Promise<Session>;
  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse>;
  movePrompt(sessionId: string, promptId: string, body: PromptMoveRequest): Promise<PromptMoveResult>;
  replacePrompt(sessionId: string, promptId: string, body: PromptReplaceRequest): Promise<PromptReplaceResult>;
  timingPrompt(sessionId: string, promptId: string, body: PromptTimingRequest): Promise<PromptTimingResult>;
  steerPrompt(sessionId: string, promptId: string): Promise<PromptSteerResult>;
  resolveApproval(
    sessionId: string,
    approvalId: string,
    body: ApprovalResolveRequest & { readonly selected_option_id?: string },
  ): Promise<ApprovalResolveResult>;
  resolveQuestion(
    sessionId: string,
    questionId: string,
    body: QuestionResolveRequest,
  ): Promise<QuestionResolveResult>;
  dismissQuestion(sessionId: string, questionId: string): Promise<QuestionDismissResult>;
  cancelTask(
    sessionId: string,
    taskId: string,
    query?: CancelTaskQuery,
  ): Promise<{ cancelled: boolean }>;
}

export interface SessionListTransport {
  listSessions(query?: { readonly page_size?: number; readonly before_id?: string }): Promise<PageResponse<Session>>;
}

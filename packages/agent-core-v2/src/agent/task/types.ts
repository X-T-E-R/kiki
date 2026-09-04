export type AgentTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);
export type AgentTaskSettlementStatus = 'completed' | 'failed' | 'timed_out' | 'killed';

export interface AgentTaskSettlement {
  readonly status: AgentTaskSettlementStatus;
  readonly stopReason?: string;
}

export interface AgentTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface SubagentTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly profile?: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly collaborationTaskName?: string;
  readonly collaborationAgentType?: string;
}

export interface QuestionTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export interface AgentTaskInfoByKind {
  readonly process: ProcessTaskInfo;
  readonly agent: SubagentTaskInfo;
  readonly question: QuestionTaskInfo;
}

export type AgentTaskKind = keyof AgentTaskInfoByKind;

export type AgentTaskInfo = AgentTaskInfoByKind[AgentTaskKind];

export interface AgentTaskSink {
  readonly signal: AbortSignal;
  appendOutput(chunk: string): void;
  settle(settlement: AgentTaskSettlement): Promise<boolean>;
}

export interface AgentTask {
  readonly idPrefix: string;
  readonly kind: AgentTaskKind;
  readonly description: string;
  readonly timeoutMs?: number;

  start(sink: AgentTaskSink): void | Promise<void>;
  onDetach?(): void;
  forceStop?(): Promise<void>;
  toInfo(base: AgentTaskInfoBase): AgentTaskInfo;
}

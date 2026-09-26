import type { AgentId, TaskId } from './ids';
import type { StepUsage } from './turn';

export type TaskKind = 'shell' | 'subagent' | 'tool' | 'other';

export type TaskState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface TranscriptTaskReceipt {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentState: 'final' | 'unavailable';
  readonly committedAt: string;
  readonly sourceTurnId?: number;
}

export interface TranscriptTask {
  readonly taskId: TaskId;
  readonly kind: TaskKind;
  readonly state: TaskState;
  /** Foreground→background transition: `!shell` detach, task tool backgrounding. */
  readonly detached: boolean;
  readonly lifetime?: 'finite' | 'service';
  readonly ownerAgentId?: AgentId;
  readonly ownerTurnId?: number;
  readonly goalId?: string;
  readonly receipt?: TranscriptTaskReceipt;
  readonly receiptVerification?: 'verified' | 'legacy_unverified' | 'invalid';
  readonly name?: string;
  readonly subagentName?: string;
  /** Human-readable one-liner (command line, agent description, …). */
  readonly description?: string;
  /** For kind 'subagent' / swarm members: the spawned agent's transcript to subscribe. */
  readonly agentId?: AgentId;
  /** Tail of captured output; appended via `append { target: 'task' }`. */
  readonly outputTail: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** One-line result summary (`subagent.completed`). */
  readonly resultSummary?: string;
  /** Failure message (`subagent.failed`). */
  readonly error?: string;
  /** Why the task entered its current state (`subagent.suspended` reason). */
  readonly stateReason?: string;
  /** Token usage of the finished run (`subagent.completed`). */
  readonly usage?: StepUsage;
}

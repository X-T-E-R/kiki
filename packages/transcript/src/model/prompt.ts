import type { ContentWindow } from '../contract/content';
import type { PromptId } from './ids';

export type TranscriptPromptStatus =
  | 'running'
  | 'queued'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted';

export type TranscriptPromptAppendTiming = 'agent_idle' | 'subagents_done' | 'tasks_done';

export interface TranscriptPromptDetailRef {
  readonly kind: 'prompt';
  readonly promptId: PromptId;
}

export interface TranscriptPrompt extends ContentWindow {
  readonly promptId: PromptId;
  readonly status: TranscriptPromptStatus;
  /** The user message this prompt materialized as, when it did. */
  readonly userMessageId?: string;
  /** Open content envelope (the engine's message content parts). */
  readonly content?: unknown;
  readonly originKind?: 'cron_job';
  /** Scheduled origin's delivery mode; absent on records admitted without one. */
  readonly originDeliveryMode?: 'queue' | 'steer' | 'idle';
  readonly createdAt: string;
  readonly finishedAt?: string;
  /** Zero-based position while the prompt is queued. */
  readonly queuePosition?: number;
  /** True when the prompt was aborted before it ever started. */
  readonly abortedBeforeStart?: boolean;
  /** Set when the prompt was rerouted by a steer. */
  readonly steeredAt?: string;
  /** Effective deferred-append timing; absent on older projections. */
  readonly appendTiming?: TranscriptPromptAppendTiming;
  /** Scheduling revision; absent on older projections. */
  readonly revision?: number;
  readonly detailRef?: TranscriptPromptDetailRef;
}

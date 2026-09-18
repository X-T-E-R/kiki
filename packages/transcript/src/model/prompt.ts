import type { PromptId } from './ids';

export type TranscriptPromptStatus =
  | 'running'
  | 'queued'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface TranscriptPrompt {
  readonly promptId: PromptId;
  readonly status: TranscriptPromptStatus;
  /** The user message this prompt materialized as, when it did. */
  readonly userMessageId?: string;
  /** Open content envelope (the engine's message content parts). */
  readonly content?: unknown;
  readonly createdAt: string;
  readonly finishedAt?: string;
  /** Zero-based position while the prompt is queued. */
  readonly queuePosition?: number;
  /** True when the prompt was aborted before it ever started. */
  readonly abortedBeforeStart?: boolean;
  /** Set when the prompt was rerouted by a steer. */
  readonly steeredAt?: string;
}

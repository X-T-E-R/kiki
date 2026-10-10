import type { ContentWindow } from '../contract/content';

export type ExternalActivityPhase = 'started' | 'completed' | 'failed' | 'cancelled';

export interface ExternalClientSource {
  readonly connectionId: string;
  readonly clientName: string;
  readonly sessionRef: string;
  readonly driver: 'external';
}

export interface ExternalActivityRecord extends ContentWindow {
  readonly activityId: string;
  readonly phase: ExternalActivityPhase;
  readonly operationId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly source: ExternalClientSource;
  readonly input?: unknown;
  readonly error?: string;
  readonly turnId: number;
}

export interface ExternalTextRecord extends ContentWindow {
  readonly recordId: string;
  readonly turnId: number;
  readonly text: string;
  readonly kind: 'note' | 'user_excerpt' | 'assistant_excerpt' | 'handoff';
  readonly title?: string;
  readonly relatedOperationIds?: readonly string[];
  readonly sourceUrl?: string;
  readonly clientTime?: string;
  readonly source: ExternalClientSource;
}

/**
 * `threadCommunication` domain — local peer-thread coordination contract.
 *
 * Defines host-qualified Thread references, bounded list/read/wait views,
 * durable send receipts, and workspace override management. A Thread is an
 * existing Session; Agent identities never enter the addressing contract.
 * Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ThreadRef {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface ThreadSummary {
  readonly ref: ThreadRef;
  readonly title?: string;
  readonly updatedAt: number;
  readonly createdAt: number;
  readonly state: 'cold' | 'idle' | 'running';
}

export interface ListThreadsInput {
  readonly workspaceId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListThreadsResult {
  readonly threads: readonly ThreadSummary[];
  readonly nextCursor?: string;
}

export interface ThreadTurn {
  readonly turnId: number;
  readonly startedAt?: number;
  readonly endedAt: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly origin: 'user' | 'peer';
  readonly peer?: {
    readonly source: ThreadRef;
    readonly messageId: string;
  };
  readonly input: string;
  readonly output: string;
}

export interface ReadThreadInput {
  readonly thread: ThreadRef;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReadThreadResult {
  readonly thread: ThreadRef;
  readonly turns: readonly ThreadTurn[];
  readonly nextCursor?: string;
}

export interface SendThreadMessageInput {
  readonly target: ThreadRef;
  readonly content: string;
  readonly idempotencyKey: string;
}

export interface SendThreadMessageResult {
  readonly messageId: string;
  readonly targetSeq: number;
  readonly acceptedAt: number;
  readonly deduplicated: boolean;
  readonly delivery: 'pending' | 'delivered' | 'undeliverable';
}

export type ThreadActivityKind = 'terminal' | 'attention' | 'lifecycle' | 'message_undeliverable';

export interface ThreadActivity {
  readonly ref: ThreadRef;
  readonly seq: number;
  readonly kind: ThreadActivityKind;
  readonly at: number;
  readonly reason: string;
  readonly turnId?: number;
  readonly messageId?: string;
}

export interface WaitThreadInput {
  readonly thread: ThreadRef;
  readonly cursor?: string;
}

export interface WaitThreadsInput {
  readonly threads: readonly WaitThreadInput[];
  readonly timeoutMs?: number;
}

export interface WaitThreadResult {
  readonly thread: ThreadRef;
  readonly cursor: string;
  readonly activities: readonly ThreadActivity[];
}

export interface WaitThreadsResult {
  readonly threads: readonly WaitThreadResult[];
  readonly timedOut: boolean;
}

export interface IThreadCommunicationService {
  readonly _serviceBrand: undefined;
  readonly hostId: string;

  listThreads(input?: ListThreadsInput): Promise<ListThreadsResult>;
  readThread(input: ReadThreadInput): Promise<ReadThreadResult>;
  sendMessage(input: SendThreadMessageInput): Promise<SendThreadMessageResult>;
  waitThreads(input: WaitThreadsInput): Promise<WaitThreadsResult>;

  getWorkspaceOverride(workspaceId: string): Promise<boolean | undefined>;
  setWorkspaceOverride(workspaceId: string, enabled: boolean): Promise<void>;
  clearWorkspaceOverride(workspaceId: string): Promise<void>;
  isWorkspaceEnabled(workspaceId: string): Promise<boolean>;
}

export const IThreadCommunicationService: ServiceIdentifier<IThreadCommunicationService> =
  createDecorator<IThreadCommunicationService>('threadCommunicationService');

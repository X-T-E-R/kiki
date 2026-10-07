import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ThreadRef {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly personaId?: string;
  readonly name?: string;
  readonly bridgeId?: string;
  readonly connectionId?: string;
}

export interface ThreadSummary {
  readonly ref: ThreadRef;
  readonly title?: string;
  readonly updatedAt: number;
  readonly createdAt: number;
  readonly state: 'cold' | 'idle' | 'running';
}

export interface ThreadCaller {
  readonly sessionId: string;
  readonly workspaceId: string;
}

export interface ListThreadsInput {
  readonly bridgeId?: string;
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
  readonly caller?: ThreadCaller;
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
  readonly origin: 'user' | 'peer' | 'bridged_peer' | 'external' | 'mixed' | 'unknown' | 'thread_created';
  readonly bridgedPeer?: import('./threadMailboxStore').BridgedThreadMetadata & { readonly messageId: string };
  readonly peer?: {
    readonly source: ThreadRef;
    readonly messageId: string;
  };
  readonly input: string;
  readonly output: string;
}

export interface ReadThreadInput {
  readonly signal?: AbortSignal;
  readonly contentRef?: import('@kiki/protocol').BridgeContentRef;
  readonly caller?: ThreadCaller;
  readonly thread: ThreadRef;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReadThreadResult {
  readonly thread: ThreadRef;
  readonly turns: readonly ThreadTurn[];
  readonly nextCursor?: string;
  readonly view?: import('@kiki/protocol').BridgeReadView;
}

export interface SendThreadMessageInput {
  readonly caller?: ThreadCaller;
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

export interface SendRoomMessageInput {
  readonly target: ThreadRef;
  readonly roomId: string;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly targeted: boolean;
  readonly generation?: number;
  readonly queueWhenBusy?: boolean;
  readonly requireCommunication?: boolean;
}

export interface CancelRoomDeliveriesInput {
  readonly roomId: string;
  readonly generation?: number;
}

export interface WaitRoomDeliveryInput {
  readonly target: ThreadRef;
  readonly messageId: string;
  readonly signal?: AbortSignal;
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
  readonly signal?: AbortSignal;
  readonly caller?: ThreadCaller;
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

/** `threadCommunication` domain — local peer-thread coordination contract (App scope). Defines
 *  host-qualified Thread references, bounded list/read/wait views, durable send receipts, and
 *  workspace override management. A Thread is an existing Session, and agent identities never
 *  enter the addressing contract. */
export interface IThreadCommunicationService {
  readonly _serviceBrand: undefined;
  readonly hostId: string;

  listMessages(input?: ListThreadMessagesInput): Promise<ListThreadMessagesResult>;
  listThreads(input?: ListThreadsInput): Promise<ListThreadsResult>;
  readThread(input: ReadThreadInput): Promise<ReadThreadResult>;
  sendMessage(input: SendThreadMessageInput): Promise<SendThreadMessageResult>;
  sendRoomMessage(input: SendRoomMessageInput): Promise<SendThreadMessageResult>;
  cancelRoomDeliveries(input: CancelRoomDeliveriesInput): Promise<void>;
  waitRoomDelivery(input: WaitRoomDeliveryInput): Promise<void>;
  waitThreads(input: WaitThreadsInput): Promise<WaitThreadsResult>;
  shutdown(): Promise<void>;

  getWorkspaceOverride(workspaceId: string): Promise<boolean | undefined>;
  setWorkspaceOverride(workspaceId: string, enabled: boolean): Promise<void>;
  clearWorkspaceOverride(workspaceId: string): Promise<void>;
  isWorkspaceEnabled(workspaceId: string, caller?: ThreadCaller): Promise<boolean>;
}

export const IThreadCommunicationService: ServiceIdentifier<IThreadCommunicationService> =
  createDecorator<IThreadCommunicationService>('threadCommunicationService');

export interface ThreadMessageEndpoint {
  readonly ref: ThreadRef;
  readonly title?: string;
  readonly deleted: boolean;
  readonly archived: boolean;
}

export type ThreadMessageSource =
  | { readonly kind: 'thread'; readonly thread: ThreadMessageEndpoint }
  | { readonly kind: 'room'; readonly roomId: string };

export const THREAD_DELIVERY_REASON_CODES = [
  'thread_not_found', 'thread_archived', 'communication_disabled', 'cross_host',
  'prompt_rejected', 'session_unavailable', 'workspace_unavailable', 'executor_unavailable',
  'cancelled', 'delivery_failed',
] as const;

export type ThreadDeliveryReasonCode = typeof THREAD_DELIVERY_REASON_CODES[number];

export interface ThreadCommunicationMessage {
  /** Stable recipient main-agent prompt id and user-message id, including steered delivery and retries.
   * Only delivered records are navigation targets; targetSeq is never a transcript turn id. */
  readonly messageId: string;
  readonly source: ThreadMessageSource;
  readonly target: ThreadMessageEndpoint;
  readonly content: string;
  readonly acceptedAt: number;
  readonly targetSeq: number;
  readonly delivery: 'pending' | 'delivered' | 'undeliverable';
  readonly reasonCode?: ThreadDeliveryReasonCode;
  readonly reasonDetail?: string;
  readonly reason?: string;
}

/** Read-only communication history, including archived threads. Workspace filters match either
 * surviving endpoint; a session selects both directions, and peerSessionId narrows that pair.
 * Cursor conditions are immutable. Scan-budget pages may be empty but still have a nextCursor. */
export interface ListThreadMessagesInput {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly peerSessionId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ThreadHistoryCoverage {
  readonly generation: string;
  readonly state: 'complete' | 'preparing' | 'error';
  readonly processedMessages: number;
  readonly completedShards: number;
  readonly totalShards: number;
  readonly pending?: 'room' | 'all';
  readonly error?: string;
}

export interface ListThreadMessagesResult {
  readonly items: readonly ThreadCommunicationMessage[];
  readonly nextCursor?: string;
  readonly incomplete?: 'scan_budget' | 'history_preparing';
  readonly history?: ThreadHistoryCoverage;
}

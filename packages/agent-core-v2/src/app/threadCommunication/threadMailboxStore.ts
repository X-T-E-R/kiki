import { createHash } from 'node:crypto';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ThreadActivityKind, ThreadDeliveryReasonCode, ThreadHistoryCoverage, ThreadRef } from './threadCommunication';

export interface ThreadMessageSender {
  readonly personaId?: string;
  readonly name?: string;
  readonly sessionId: string;
}

export interface BridgedThreadMetadata {
  readonly source: ThreadRef;
  readonly sourceHomeId: string;
  readonly targetHomeId: string;
  readonly bridgeId: string;
  readonly revision: number;
  readonly location: 'local' | 'network';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly sourceSeq: number;
  readonly causeId: string;
  readonly hop: number;
}

export type ThreadMessageProducer =
  | ({ readonly kind: 'bridged_peer' } & BridgedThreadMetadata)
  | { readonly kind: 'peer_thread'; readonly source: ThreadRef; readonly sender?: ThreadMessageSender; readonly allowWhenDisabled?: boolean }
  | { readonly kind: 'room'; readonly roomId: string; readonly targeted?: boolean; readonly generation?: number; readonly sender?: ThreadMessageSender; readonly queueWhenBusy?: boolean; readonly requireCommunication?: boolean }
  | { readonly kind: 'external_client' };

export interface AcceptedThreadMessage {
  readonly messageId: string;
  readonly producer: ThreadMessageProducer;
  readonly target: ThreadRef;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: number;
  readonly targetSeq: number;
}

export interface ThreadMessageAcceptance {
  readonly message: AcceptedThreadMessage;
  readonly deduplicated: boolean;
  readonly delivery: 'pending' | 'delivered' | 'undeliverable';
  readonly payloadConflict: boolean;
}

export interface ThreadDeliveryAttempt {
  readonly message: AcceptedThreadMessage;
  readonly attemptId: string;
  readonly attempt: number;
}

export interface ThreadDeliveryClaim {
  readonly message: AcceptedThreadMessage;
  readonly consumerId: string;
  readonly fence: number;
  readonly leaseUntil: number;
  readonly hostEpoch: number;
}

export interface ThreadMailboxMutationOptions {
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export function threadMailboxClaimRequestId(operation: string, claim: ThreadDeliveryClaim): string {
  const digest = createHash('sha256').update(JSON.stringify({
    messageId: claim.message.messageId,
    consumerId: claim.consumerId,
    fence: claim.fence,
    leaseUntil: claim.leaseUntil,
    hostEpoch: claim.hostEpoch,
  })).digest('base64url');
  return `mailbox-${operation}-${digest}`;
}

export interface StoredThreadActivity {
  readonly seq: number;
  readonly epoch: string;
  readonly kind: ThreadActivityKind;
  readonly at: number;
  readonly reason: string;
  readonly turnId?: number;
  readonly messageId?: string;
}

export interface ThreadActivityPage {
  readonly epoch: string;
  readonly latestSeq: number;
  readonly activities: readonly StoredThreadActivity[];
}

export interface IThreadMailboxStore {
  readonly _serviceBrand: undefined;

  readMessages(input: ReadMailboxMessagesInput, options?: ThreadMailboxMutationOptions): Promise<MailboxMessagesPage>;

  acceptMessage(input: {
    readonly producer: ThreadMessageProducer;
    readonly target: ThreadRef;
    readonly content: string;
    readonly idempotencyKey: string;
    readonly pendingLimit?: number;
    readonly rateLimit?: { readonly key: string; readonly count: number; readonly windowMs: number };
  }, options?: ThreadMailboxMutationOptions): Promise<ThreadMessageAcceptance>;

  claimNext(input: {
    readonly target: ThreadRef;
    readonly consumerId: string;
    readonly leaseMs: number;
  }, options?: ThreadMailboxMutationOptions): Promise<ThreadDeliveryClaim | undefined>;

  acknowledgeDelivery(
    claim: ThreadDeliveryClaim,
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean>;

  markUndeliverable(
    claim: ThreadDeliveryClaim,
    reason: string | { readonly code: ThreadDeliveryReasonCode; readonly detail: string },
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean>;

  cancelProducer(
    producer: Extract<ThreadMessageProducer, { readonly kind: 'room' }>,
    options?: ThreadMailboxMutationOptions,
  ): Promise<number>;

  listPendingTargets(options?: ThreadMailboxMutationOptions & { readonly targets?: readonly ThreadRef[] }): Promise<readonly ThreadRef[]>;

  appendActivity(input: {
    readonly target: ThreadRef;
    readonly kind: ThreadActivityKind;
    readonly reason: string;
    readonly turnId?: number;
    readonly messageId?: string;
  }, options?: ThreadMailboxMutationOptions): Promise<StoredThreadActivity>;
  readActivity(
    target: ThreadRef,
    afterSeq: number,
    limit: number,
    options?: ThreadMailboxMutationOptions,
  ): Promise<ThreadActivityPage>;

  getWorkspaceOverride(
    workspaceId: string,
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean | undefined>;
  setWorkspaceOverride(
    workspaceId: string,
    enabled: boolean,
    options?: ThreadMailboxMutationOptions,
  ): Promise<void>;
  clearWorkspaceOverride(workspaceId: string, options?: ThreadMailboxMutationOptions): Promise<void>;

  close(): Promise<void>;
}

export const IThreadMailboxStore: ServiceIdentifier<IThreadMailboxStore> =
  createDecorator<IThreadMailboxStore>('threadMailboxStore');

export interface ReadMailboxMessagesInput {
  readonly group: string;
  readonly before?: string;
  readonly limit: number;
  readonly peerOnly?: boolean;
  readonly generation?: string;
}

export interface MailboxMessageRecord {
  readonly message: AcceptedThreadMessage;
  readonly delivery: 'pending' | 'delivered' | 'undeliverable';
  readonly reason?: string;
  readonly reasonCode?: ThreadDeliveryReasonCode;
  readonly order: string;
}

export interface MailboxMessagesPage {
  readonly items: readonly MailboxMessageRecord[];
  readonly nextBefore?: string;
  readonly history?: ThreadHistoryCoverage;
  readonly cursorExpired?: boolean;
}

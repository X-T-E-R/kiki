import { createHash } from 'node:crypto';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ThreadActivityKind, ThreadRef } from './threadCommunication';

export type ThreadMessageProducer =
  | { readonly kind: 'peer_thread'; readonly source: ThreadRef }
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

  acceptMessage(input: {
    readonly producer: ThreadMessageProducer;
    readonly target: ThreadRef;
    readonly content: string;
    readonly idempotencyKey: string;
    readonly pendingLimit?: number;
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
    reason: string,
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean>;

  listPendingTargets(options?: ThreadMailboxMutationOptions): Promise<readonly ThreadRef[]>;

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
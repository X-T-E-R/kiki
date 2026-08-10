/**
 * `threadCommunication` domain — durable mailbox Store contract.
 *
 * Owns backend-neutral idempotent message acceptance, per-target sequencing,
 * fenced delivery attempts, activity sequencing, and persisted workspace
 * overrides. Bound at App scope.
 */

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
  }): Promise<ThreadMessageAcceptance>;
  beginDelivery(messageId: string): Promise<ThreadDeliveryAttempt | undefined>;
  acknowledgeDelivery(messageId: string, attemptId: string): Promise<boolean>;
  markUndeliverable(messageId: string, attemptId: string, reason: string): Promise<boolean>;
  listPendingDeliveries(): Promise<readonly AcceptedThreadMessage[]>;

  appendActivity(input: {
    readonly target: ThreadRef;
    readonly kind: ThreadActivityKind;
    readonly reason: string;
    readonly turnId?: number;
    readonly messageId?: string;
  }): Promise<StoredThreadActivity>;
  readActivity(target: ThreadRef, afterSeq: number, limit: number): Promise<ThreadActivityPage>;

  getWorkspaceOverride(workspaceId: string): Promise<boolean | undefined>;
  setWorkspaceOverride(workspaceId: string, enabled: boolean): Promise<void>;
  clearWorkspaceOverride(workspaceId: string): Promise<void>;
}

export const IThreadMailboxStore: ServiceIdentifier<IThreadMailboxStore> =
  createDecorator<IThreadMailboxStore>('threadMailboxStore');

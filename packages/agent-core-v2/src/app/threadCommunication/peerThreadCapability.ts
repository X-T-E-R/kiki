import type {
  IThreadCommunicationService,
  SendThreadMessageResult,
  ThreadRef,
} from './threadCommunication';
import type { AcceptedThreadMessage, ThreadMessageProducer, ThreadMessageSender } from './threadMailboxStore';
import type { ListThreadsInput, ListThreadsResult, ReadThreadInput, ReadThreadResult, WaitThreadsInput, WaitThreadsResult } from './threadCommunication';

export const RECHECK_BRIDGED_THREADS: unique symbol = Symbol('recheckBridgedThreads');
export const SPACE_THREAD_ROUTER: unique symbol = Symbol('spaceThreadRouter');
export const ACCEPT_BRIDGED_THREAD_MESSAGE: unique symbol = Symbol('acceptBridgedThreadMessage');

export interface SpaceThreadConnector {
  list(input: ListThreadsInput): Promise<ListThreadsResult>;
  read(input: ReadThreadInput): Promise<ReadThreadResult>;
  send(input: SendPeerThreadMessageInput): Promise<SendThreadMessageResult>;
  wait(input: WaitThreadsInput): Promise<WaitThreadsResult>;
  beforeDelivery(message: AcceptedThreadMessage): Promise<'deliver' | 'pending'>;
}

export interface SpaceThreadCapability {
  [RECHECK_BRIDGED_THREADS](targets: readonly ThreadRef[]): Promise<void>;
  [SPACE_THREAD_ROUTER](connector: SpaceThreadConnector | undefined): void;
  [ACCEPT_BRIDGED_THREAD_MESSAGE](input: {
    producer: Extract<ThreadMessageProducer, { kind: 'bridged_peer' }>;
    target: ThreadRef;
    content: string;
    idempotencyKey: string;
  }): Promise<SendThreadMessageResult>;
}

export function spaceThreadCapability(service: IThreadCommunicationService): SpaceThreadCapability {
  if (!(SPACE_THREAD_ROUTER in service) || !(ACCEPT_BRIDGED_THREAD_MESSAGE in service)) throw new Error('Space thread capability unavailable.');
  return service as IThreadCommunicationService & SpaceThreadCapability;
}

export const SEND_PEER_THREAD_MESSAGE: unique symbol = Symbol('sendPeerThreadMessage');

export interface SendPeerThreadMessageInput {
  readonly signal?: AbortSignal;
  readonly cause?: { readonly causeId: string; readonly hop: number };
  readonly source: ThreadRef;
  readonly target: ThreadRef;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly sender?: ThreadMessageSender;
  readonly allowWhenDisabled?: boolean;
}

/** `threadCommunication` domain — non-reflective peer-send capability. The symbol-keyed method is
 *  consumed only by the main-agent tool adapter, so string-addressable local clients cannot claim
 *  peer provenance. */
export interface IThreadPeerSendCapability {
  [SEND_PEER_THREAD_MESSAGE](input: SendPeerThreadMessageInput): Promise<SendThreadMessageResult>;
}

export function peerSendCapability(
  service: IThreadCommunicationService,
): IThreadPeerSendCapability {
  if (!(SEND_PEER_THREAD_MESSAGE in service)) {
    throw new Error('Thread communication service does not provide peer-send capability.');
  }
  return service as IThreadCommunicationService & IThreadPeerSendCapability;
}

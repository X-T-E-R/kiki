/**
 * `threadCommunication` domain — non-reflective peer-send capability.
 *
 * The symbol-keyed method is consumed only by the main-agent tool adapter;
 * string-addressable local clients cannot claim peer provenance.
 */

import type {
  IThreadCommunicationService,
  SendThreadMessageResult,
  ThreadRef,
} from './threadCommunication';

export const SEND_PEER_THREAD_MESSAGE: unique symbol = Symbol('sendPeerThreadMessage');

export interface SendPeerThreadMessageInput {
  readonly source: ThreadRef;
  readonly target: ThreadRef;
  readonly content: string;
  readonly idempotencyKey: string;
}

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

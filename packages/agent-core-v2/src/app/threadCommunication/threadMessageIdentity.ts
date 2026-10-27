import { createHash } from 'node:crypto';

import type { ThreadRef } from './threadCommunication';
import type { ThreadMessageProducer, ThreadMessageSender } from './threadMailboxStore';

export function threadMessageIdempotencyKey(partition: string, input: {
  readonly producer: ThreadMessageProducer;
  readonly target: ThreadRef;
  readonly idempotencyKey: string;
}): string {
  const producer = producerIdentity(input.producer);
  const target = threadIdentity(input.target);
  const digest = createHash('sha256').update(JSON.stringify({ producer, target, key: input.idempotencyKey })).digest('base64url');
  return `${partition}/idempotency/${digest}`;
}

function producerIdentity(producer: ThreadMessageProducer): object {
  switch (producer.kind) {
    case 'external_client': return { kind: producer.kind };
    case 'bridged_peer': return { kind: producer.kind, bridgeId: producer.bridgeId,
      sourceHomeId: producer.sourceHomeId, source: threadIdentity(producer.source) };
    case 'peer_thread': return { kind: producer.kind, source: threadIdentity(producer.source),
      sender: senderIdentity(producer.sender), allowWhenDisabled: producer.allowWhenDisabled === true };
    case 'room': return { kind: producer.kind, roomId: producer.roomId, targeted: producer.targeted,
      queueWhenBusy: producer.queueWhenBusy, requireCommunication: producer.requireCommunication,
      generation: producer.generation, sender: senderIdentity(producer.sender) };
  }
}

function threadIdentity(ref: ThreadRef): ThreadRef {
  return { hostId: ref.hostId, workspaceId: ref.workspaceId, sessionId: ref.sessionId,
    personaId: ref.personaId, name: ref.name };
}

function senderIdentity(sender: ThreadMessageSender | undefined): ThreadMessageSender | undefined {
  return sender === undefined || sender.sessionId.length === 0 ? undefined
    : { sessionId: sender.sessionId, personaId: sender.personaId, name: sender.name };
}

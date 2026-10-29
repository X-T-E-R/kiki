import type { ContextMessage } from '#/agent/contextMemory/types';

export function hasMailboxMessageInContext(messages: readonly ContextMessage[], message: ContextMessage): boolean {
  if (message.id === undefined) return false;
  const origin = message.origin;
  return messages.some((entry) => entry.id === message.id && (
    origin?.kind === 'agent_message'
      ? entry.origin?.kind === 'agent_message' && entry.origin.messageId === origin.messageId &&
        entry.origin.senderAgentId === origin.senderAgentId
      : origin?.kind === 'user' && entry.origin?.kind === 'user'
  ));
}

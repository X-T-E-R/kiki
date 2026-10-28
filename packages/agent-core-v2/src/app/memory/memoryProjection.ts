import type { ContextMessage } from '#/agent/contextMemory/types';

function range(message: ContextMessage): { start: number; length: number } | undefined {
  if (message.origin?.kind !== 'injection' || message.origin.variant !== 'runtime_snapshot') return undefined;
  const value = (message.origin.disclosure as { memoryRange?: { start?: number; length?: number } } | undefined)?.memoryRange;
  if (value === undefined || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.length) || value.start! < 0 || value.length! < 0) return undefined;
  return { start: value.start!, length: value.length! };
}
export function withoutMemoryProjection(message: ContextMessage): ContextMessage {
  const memory = range(message);
  if (memory === undefined || message.content.length !== 1 || message.content[0]?.type !== 'text') return message;
  const text = message.content[0].text;
  if (!text.slice(memory.start, memory.start + memory.length).startsWith('## Scoped memory — ')) return message;
  return { ...message, content: [{ type: 'text', text: text.slice(0, memory.start) + text.slice(memory.start + memory.length) }] };
}
export function withoutMemoryWorkset(message: ContextMessage): ContextMessage {
  const memory = range(message);
  if (memory === undefined || message.content[0]?.type !== 'text' || !message.content[0].text.slice(memory.start, memory.start + memory.length).includes('\n<memory-workset ')) return message;
  return withoutMemoryProjection(message);
}
export function projectCurrentMemory(messages: readonly ContextMessage[]): readonly ContextMessage[] {
  const latest = messages.findLastIndex((message) => range(message) !== undefined);
  if (latest < 0) return messages;
  return messages.map((message, index) => index >= latest ? message : withoutMemoryProjection(message));
}

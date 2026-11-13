import type { ContextMessage } from './types';

export function trimToSettledContextMessages(messages: readonly ContextMessage[]): ContextMessage[] {
  const out = [...messages];
  while (out.length > 0) {
    const tail = out[out.length - 1]!;
    if (tail.role === 'assistant' && tail.partial === true) {
      out.pop();
      continue;
    }
    if (tail.role === 'tool') {
      let assistantIndex = out.length - 1;
      while (assistantIndex >= 0 && out[assistantIndex]!.role === 'tool') {
        assistantIndex--;
      }
      const assistant = assistantIndex >= 0 ? out[assistantIndex] : undefined;
      if (assistant === undefined || assistant.role !== 'assistant' || assistant.partial === true) {
        out.splice(Math.max(0, assistantIndex));
        continue;
      }
      const settledIds = new Set<string>();
      for (let i = assistantIndex + 1; i < out.length; i++) {
        const id = out[i]!.toolCallId;
        if (id !== undefined) settledIds.add(id);
      }
      if (assistant.toolCalls.some((call) => !settledIds.has(call.id))) {
        out.splice(assistantIndex);
        continue;
      }
      break;
    }
    if (tail.role === 'assistant' && tail.toolCalls.length > 0) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

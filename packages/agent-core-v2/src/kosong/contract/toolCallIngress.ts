import { isToolCall, isToolCallPart, mergeInPlace, type StreamedMessagePart, type ToolCall } from './message';

export async function* toolCallIngress(stream: AsyncIterable<StreamedMessagePart>,
  scrub: ((call: ToolCall) => ToolCall) | undefined): AsyncIterable<StreamedMessagePart> {
  if (scrub === undefined) { yield* stream; return; }
  const calls: ToolCall[] = [];
  const indexes = new Map<number | string, ToolCall>();
  let latest: ToolCall | undefined;
  for await (const part of stream) {
    if (isToolCall(part)) {
      if (part.name !== 'AgentRun' && part.name !== 'CallTool') {
        latest = undefined;
        yield part;
        continue;
      }
      const call = { ...part };
      latest = call;
      calls.push(call);
      if (call._streamIndex !== undefined) indexes.set(call._streamIndex, call);
    } else if (isToolCallPart(part)) {
      const call = part.index === undefined ? latest : indexes.get(part.index);
      if (call !== undefined) mergeInPlace(call, part);
      else yield part;
    } else {
      yield part;
    }
  }
  for (const call of calls) yield scrub(call);
}

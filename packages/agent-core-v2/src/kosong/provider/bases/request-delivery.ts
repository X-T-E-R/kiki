import { ambiguousRequestDelivery, isAbortError } from '#/kosong/contract/errors';
import type { StreamedMessage } from '#/kosong/contract/provider';

export function guardRequestDelivery(stream: StreamedMessage, enabled: boolean): StreamedMessage {
  if (!enabled) return stream;
  return {
    get id() { return stream.id; },
    get usage() { return stream.usage; },
    get finishReason() { return stream.finishReason; },
    get rawFinishReason() { return stream.rawFinishReason; },
    get traceId() { return stream.traceId; },
    get diagnostics() { return stream.diagnostics; },
    async *[Symbol.asyncIterator]() {
      try {
        yield* stream;
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw ambiguousRequestDelivery(error);
      }
    },
  };
}

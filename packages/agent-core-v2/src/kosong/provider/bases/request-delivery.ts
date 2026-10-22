import {
  ambiguousRequestDelivery,
  isAbortError,
  noteExecutedRequestDelivery,
  requestDeliveryProvenance,
} from '#/kosong/contract/errors';
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
    commitMessage(message) { stream.commitMessage?.(message); },
    async *[Symbol.asyncIterator]() {
      let yielded = false;
      try {
        for await (const part of stream) {
          yielded = true;
          yield part;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (requestDeliveryProvenance(error) === 'unknown') throw error;
        if (requestDeliveryProvenance(error) === 'executed' || yielded || stream.id !== null) {
          noteExecutedRequestDelivery(error);
          throw error;
        }
        throw ambiguousRequestDelivery(error);
      }
    },
  };
}

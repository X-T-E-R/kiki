import {
  ambiguousRequestDelivery,
  isAbortError,
  noteExecutedRequestDelivery,
  requestDeliveryProvenance,
} from '#/kosong/contract/errors';
import type { StreamedMessage } from '#/kosong/contract/provider';
import { isContentPart, isToolCall, isToolCallPart, isVacuousContentPart } from '#/kosong/contract/message';
import { isError2, readAttachedErrorDetails } from '#/_base/errors/errors';

export function guardRequestDelivery(stream: StreamedMessage, enabled: boolean): StreamedMessage {
  if (!enabled) return stream;
  return {
    get id() { return stream.id; },
    get usage() { return stream.usage; },
    get finishReason() { return stream.finishReason; },
    get rawFinishReason() { return stream.rawFinishReason; },
    get traceId() { return stream.traceId; },
    get diagnostics() { return stream.diagnostics; },
    get completionAuthority() { return stream.completionAuthority; },
    get thinkingOnlyRecoveryBlocked() { return stream.thinkingOnlyRecoveryBlocked; },
    commitMessage(message) { stream.commitMessage?.(message); },
    cancel() { return stream.cancel?.(); },
    async *[Symbol.asyncIterator]() {
      let yielded = false;
      try {
        for await (const part of stream) {
          yielded ||= isToolCall(part) || isToolCallPart(part) || (isContentPart(part) && !isVacuousContentPart(part));
          yield part;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (requestDeliveryProvenance(error) === 'executed' || yielded) {
          noteExecutedRequestDelivery(error);
          throw error;
        }
        const attached = typeof error === 'object' && error !== null ? readAttachedErrorDetails(error) : undefined;
        const source = attached?.['errorSource'] ?? (isError2(error) ? error.details?.['errorSource'] : undefined);
        if (source === 'provider_event' || source === 'provider_stream' || source === 'provider_http' || requestDeliveryProvenance(error) === 'unknown') throw error;
        throw ambiguousRequestDelivery(error);
      }
    },
  };
}

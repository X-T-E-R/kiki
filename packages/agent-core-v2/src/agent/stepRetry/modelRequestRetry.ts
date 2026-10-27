import { DEFAULT_MAX_RETRY_ATTEMPTS, readRetryAfterMs, retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import { unwrapErrorCause } from '#/errors';
import { isContentPart, isVacuousContentPart, type StreamedMessagePart } from '#/kosong/contract/message';
import type { ModelRequester, ModelRequestEvent, ModelRequestInput } from '#/kosong/model/modelRequester';
import type { RetryConfig } from './configSection';
import { resolveRetryPolicy } from './retryPolicy';

/** Reuses the step retry policy, five-attempt default, backoff and Retry-After for direct model requests. Output observation is monotonic across discarded attempts; cancellation, safety vetoes and retry: 'never' prevent replay. */
export async function* requestModelWithRetry(
  requester: ModelRequester,
  input: ModelRequestInput,
  signal: AbortSignal,
  params: Parameters<ModelRequester['request']>[2],
  retryConfig: () => RetryConfig | undefined,
): AsyncGenerator<ModelRequestEvent> {
  let observedOutput = false;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      for await (const event of requester.request(input, signal, params)) {
        signal.throwIfAborted();
        if (event.type === 'part') observedOutput ||= hasObservedOutput(event.part);
        if (event.type === 'finish') {
          observedOutput ||= event.message.toolCalls.length > 0 || event.message.content.some(hasObservedOutput);
        }
        yield event;
      }
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (observedOutput || params.retry === 'never') throw error;
      const config = retryConfig();
      const decision = resolveRetryPolicy(config, error, { model: requester.model.id, provider: requester.model.providerName });
      if (!decision.retry || attempt >= (decision.maxAttempts ?? config?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS)) throw error;
      await sleepForRetry(readRetryAfterMs(unwrapErrorCause(error)) ?? decision.backoffMs ?? retryBackoffDelay(attempt - 1, 2_000), signal);
    }
  }
}

function hasObservedOutput(part: StreamedMessagePart): boolean {
  return !isContentPart(part) || !isVacuousContentPart(part) ||
    (part.type === 'text' && part.text.length > 0) || (part.type === 'think' && part.think.length > 0);
}

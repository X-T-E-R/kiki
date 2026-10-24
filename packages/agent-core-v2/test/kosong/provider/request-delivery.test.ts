import { describe, expect, it } from 'vitest';

import { attachErrorDetails, unwrapErrorCause } from '#/errors';
import {
  APIConnectionError,
  APIStatusError,
  ChatProviderError,
  createAbortError,
  requestDeliveryProvenance,
} from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type { StreamedMessage } from '#/kosong/contract/provider';
import { guardRequestDelivery } from '#/kosong/provider/bases/request-delivery';

describe('guardRequestDelivery', () => {
  it('forwards commitMessage and leaves a disabled guard untouched', () => {
    const inner = deliveryStream(new APIConnectionError('terminated'));
    const message = { role: 'assistant', content: [], toolCalls: [] } as Message;
    const guarded = guardRequestDelivery(inner, true);
    guarded.commitMessage?.(message);
    expect(inner.committed).toEqual([message]);
    expect(guardRequestDelivery(inner, false)).toBe(inner);
  });

  it('marks a connection drop or early EOF unknown only before any response or output', async () => {
    const dropped = await catchDelivery(deliveryStream(new APIConnectionError('terminated')));
    const eof = await catchDelivery(deliveryStream(new ChatProviderError('stream ended before a terminal response event.')));
    for (const error of [dropped, eof]) {
      expect(requestDeliveryProvenance(error)).toBe('unknown');
      expect(requestDeliveryProvenance(unwrapErrorCause(error))).toBe('unknown');
      expect((error as Error).message).toBe('The provider request ended without an observed outcome.');
    }
    expect(unwrapErrorCause(dropped)).toMatchObject({ message: 'terminated' });
  });

  it('keeps a parsed or partially delivered failure and does not call it unknown', async () => {
    const parsed = attachErrorDetails(new APIStatusError(401, 'unauthorized', 'req-auth'), {
      errorSource: 'provider_event',
    });
    const afterOutput = await catchDelivery(deliveryStream(new APIConnectionError('terminated'), {
      parts: [{ type: 'text', text: 'partial' }],
    }));
    const afterResponse = await catchDelivery(deliveryStream(parsed, { id: 'resp_1' }));
    const parsedFirst = await catchDelivery(deliveryStream(parsed));

    expect(afterOutput).toBeInstanceOf(APIConnectionError);
    expect(afterOutput).toMatchObject({ message: 'terminated' });
    expect(requestDeliveryProvenance(afterOutput)).toBe('executed');
    expect(afterResponse).toBe(parsed);
    expect(parsedFirst).toBe(parsed);
    expect(parsed).toMatchObject({ statusCode: 401, message: 'unauthorized', requestId: 'req-auth' });
    expect(requestDeliveryProvenance(parsed)).toBeUndefined();
    expect((parsed as { details?: { request_delivery?: unknown } }).details?.['request_delivery']).not.toBe('ambiguous');
  });

  it('rethrows abort without a delivery mark', async () => {
    const abort = createAbortError();
    const caught = await catchDelivery(deliveryStream(abort));
    expect(caught).toBe(abort);
    expect(requestDeliveryProvenance(caught)).toBeUndefined();
  });
});

function deliveryStream(
  error: unknown,
  options?: { readonly id?: string | null; readonly parts?: ReadonlyArray<{ readonly type: 'text'; readonly text: string }> },
): StreamedMessage & { readonly committed: Message[] } {
  const committed: Message[] = [];
  const parts = options?.parts ?? [];
  return {
    committed,
    id: options?.id ?? null,
    usage: null,
    finishReason: null,
    rawFinishReason: null,
    commitMessage(message) { committed.push(message); },
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
      throw error;
    },
  };
}

async function catchDelivery(stream: StreamedMessage): Promise<unknown> {
  const guarded = guardRequestDelivery(stream, true);
  try {
    for await (const _part of guarded) {
    }
  } catch (error) {
    return error;
  }
  throw new Error('expected the guarded stream to fail');
}

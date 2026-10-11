import type { RawResponseObserver } from '#/kosong/contract/provider';

export function observeResponseFetch(fetchImpl: typeof fetch, observer: RawResponseObserver): typeof fetch {
  const notify = (action: () => void): void => { try { action(); } catch {} };
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      notify(() => observer.end('fetch-error'));
      throw error;
    }
    const contentType = response.headers.get('content-type');
    notify(() => observer.start({ status: response.status, contentType,
      requestId: response.headers.get('request-id'), alternateRequestId: response.headers.get('x-request-id'), traceId: response.headers.get('x-trace-id') }));
    if (response.body === null || !response.ok || !contentType?.toLowerCase().startsWith('text/event-stream')) {
      notify(() => observer.end('not-sse'));
      return response;
    }
    const reader = response.body.getReader();
    let ended = false;
    const end = (outcome: string): void => {
      if (ended) return;
      ended = true;
      notify(() => observer.end(outcome));
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            end('eof');
            controller.close();
          } else {
            notify(() => observer.chunk(next.value));
            controller.enqueue(next.value);
          }
        } catch (error) {
          end('stream-error');
          controller.error(error);
        }
      },
      async cancel(reason) {
        end('cancelled');
        await reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(observed, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } });
    return observed;
  };
}

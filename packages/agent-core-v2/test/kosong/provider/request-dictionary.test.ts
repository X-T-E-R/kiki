import { createHash } from 'node:crypto';
import { zstdDecompress } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  dictionaryProcessBudgetAccounting,
  RequestDictionaryTransport,
  testingUseDictionaryBudget,
} from '#/kosong/provider/bases/request-dictionary';

const DCZ_MAGIC = Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]);

interface CapturedRequest {
  readonly encoding: string | null;
  readonly headers: Headers;
  readonly body: Buffer;
  readonly decoded: Buffer;
}

function body(model: string, suffix: string): Buffer {
  return Buffer.from(JSON.stringify({
    model,
    input: `${'system: preserve the complete request history and tool context.\n'.repeat(600)}${suffix}`,
  }));
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decompress(bytes: Buffer, dictionary?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zstdDecompress(bytes, { dictionary }, (error, output) => {
      if (error !== null) reject(error);
      else resolve(Buffer.from(output));
    });
  });
}

function fixtureFetch(status = 200): {
  readonly calls: CapturedRequest[];
  readonly fetch: typeof fetch;
} {
  const dictionaries = new Map<string, Buffer>();
  const calls: CapturedRequest[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const wire = Buffer.from(await request.arrayBuffer());
      const encoding = request.headers.get('content-encoding');
      let decoded: Buffer;
      if (encoding === 'dcz') {
        expect(wire.subarray(0, 8)).toEqual(DCZ_MAGIC);
        const dictionaryHash = wire.subarray(8, 40).toString('hex');
        const dictionary = dictionaries.get(dictionaryHash);
        if (dictionary === undefined) {
          return new Response(null, {
            status: 412,
            headers: { 'x-dict-miss': '1', 'x-portway-decode-error': '1' },
          });
        }
        decoded = await decompress(wire.subarray(40), dictionary);
      } else if (encoding === 'zstd') {
        decoded = await decompress(wire);
      } else {
        decoded = wire;
      }
      calls.push({ encoding, headers: request.headers, body: wire, decoded });
      if (request.headers.get('x-dict-store') === '1') {
        const immutable = Buffer.from(decoded);
        dictionaries.set(digest(immutable), immutable);
      }
      const responseHeaders = request.headers.get('x-dict-store') === '1'
        ? { 'x-dict-stored': digest(decoded) }
        : undefined;
      return new Response(status === 500 ? 'application failed' : 'ok', { status, headers: responseHeaders });
    },
  };
}

function requestInit(headers: Record<string, string> = {}, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    signal,
  };
}

describe('RequestDictionaryTransport', () => {
  it('round-trips exact bytes through a checksum-bearing DCZ fixture', async () => {
    const transport = new RequestDictionaryTransport({ dictionary: true });
    const server = fixtureFetch();
    const first = body('model-a', 'first request');
    const second = body('model-a', 'second request');

    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer example' }), first);
    const response = await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer example' }), second);

    expect(response.status).toBe(200);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]?.encoding).toBe('zstd');
    expect(server.calls[1]?.encoding).toBe('dcz');
    expect(server.calls[1]?.body.subarray(0, 8)).toEqual(DCZ_MAGIC);
    expect(server.calls[1]?.body.subarray(8, 40).toString('hex')).toBe(digest(first));
    expect(server.calls[1]?.decoded).toEqual(second);
  });

  it('isolates target and authentication scopes while allowing model changes to reuse a base', async () => {
    const transport = new RequestDictionaryTransport({ dictionary: true });
    const server = fixtureFetch();
    const first = body('model-a', 'first request');
    const second = body('model-a', 'second request');
    const third = body('model-b', 'third request');

    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
    await transport.fetch(server.fetch, 'https://other.example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);
    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer two' }), second);
    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), third);

    expect(server.calls.map((call) => call.encoding)).toEqual(['zstd', 'zstd', 'zstd', 'dcz']);
  });

  it('retains an acknowledged immutable base independently of application status', async () => {
    const transport = new RequestDictionaryTransport({ dictionary: true });
    const server = fixtureFetch(500);
    const first = body('model-a', 'first request');
    const second = body('model-a', 'second request');

    const failure = await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ 'x-api-key': 'key-one' }), first);
    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ 'x-api-key': 'key-one' }), second);

    expect(failure.status).toBe(500);
    expect(server.calls.map((call) => call.encoding)).toEqual(['zstd', 'dcz']);
  });

  it('requires an exact lowercase body hash acknowledgement', async () => {
    const transport = new RequestDictionaryTransport({ dictionary: true });
    const first = body('model-a', 'first request');
    const second = body('model-a', 'second request');
    const encodings: Array<string | null> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      encodings.push(request.headers.get('content-encoding'));
      return new Response(null, { status: 500, headers: { 'x-dict-stored': digest(first).toUpperCase() } });
    };

    await transport.fetch(fetchImpl, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
    await transport.fetch(fetchImpl, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);

    expect(encodings).toEqual(['zstd', 'zstd']);
  });

  it('expires and bounds acknowledged dictionaries', async () => {
    const first = body('model-a', 'first request');
    const second = body('model-a', 'second request');
    const expiredTransport = new RequestDictionaryTransport({ dictionary: true, ttlMs: 1 });
    const expiredServer = fixtureFetch();
    await expiredTransport.fetch(expiredServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expiredTransport.fetch(expiredServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);
    expect(expiredServer.calls.map((call) => call.encoding)).toEqual(['zstd', 'zstd']);

    const boundedTransport = new RequestDictionaryTransport({ dictionary: true, maxDictionaryBytes: first.length - 1 });
    const boundedServer = fixtureFetch();
    await boundedTransport.fetch(boundedServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
    await boundedTransport.fetch(boundedServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);
    expect(boundedServer.calls.map((call) => call.encoding)).toEqual(['zstd', 'zstd']);

    const memoryTransport = new RequestDictionaryTransport({ dictionary: true, maxMemoryBytes: first.length - 1 });
    const memoryServer = fixtureFetch();
    await memoryTransport.fetch(memoryServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
    await memoryTransport.fetch(memoryServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);
    expect(memoryServer.calls.map((call) => call.encoding)).toEqual(['zstd', 'zstd']);
  });

  it('evicts to the per-scope entry bound while retaining the newest base', async () => {
    const transport = new RequestDictionaryTransport({ dictionary: true, maxEntriesPerScope: 1 });
    const server = fixtureFetch();
    const first = body('model-a', 'first request');
    const second = body('model-a', 'second request');
    const third = body('model-a', 'third request');

    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);
    await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), third);

    expect(server.calls.map((call) => call.encoding)).toEqual(['zstd', 'dcz', 'dcz']);
    expect(server.calls[2]?.body.subarray(8, 40).toString('hex')).toBe(digest(second));
  });

  it('retries marked decoder rejections at most three times and releases their bodies', async () => {
    const transport = new RequestDictionaryTransport({ dictionary: true });
    const primer = fixtureFetch();
    const first = body('model-a', 'first request');
    const second = body('model-a', 'second request');
    const headers = requestInit({ authorization: 'Bearer one' });
    await transport.fetch(primer.fetch, 'https://example.test/v1/responses', headers, first);

    const encodings: Array<string | null> = [];
    let cancellationCount = 0;
    const decoderResponse = (status: number, responseHeaders: Record<string, string>): Response => {
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      }), { status, headers: responseHeaders });
      const body = response.body!;
      const cancel = body.cancel.bind(body);
      vi.spyOn(body, 'cancel').mockImplementation(async (reason) => {
        cancellationCount += 1;
        return cancel(reason);
      });
      return response;
    };
    const retryFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      encodings.push(request.headers.get('content-encoding'));
      if (encodings.length === 1) {
        return decoderResponse(412, { 'x-dict-miss': '1', 'x-portway-decode-error': '1' });
      }
      if (encodings.length === 2) {
        return decoderResponse(415, { 'x-portway-decode-error': '1' });
      }
      return new Response('accepted', { status: 201 });
    };
    const response = await transport.fetch(retryFetch, 'https://example.test/v1/responses', headers, second);

    expect(response.status).toBe(201);
    expect(encodings).toEqual(['dcz', 'zstd', null]);
    expect(cancellationCount).toBe(2);
  });

  it('falls back from a marked plain zstd 415 to identity', async () => {
    const transport = new RequestDictionaryTransport();
    const request = body('model-a', 'identity fallback');
    const encodings: Array<string | null> = [];
    const bodies: Buffer[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const current = new Request(input, init);
      encodings.push(current.headers.get('content-encoding'));
      bodies.push(Buffer.from(await current.arrayBuffer()));
      return encodings.length === 1
        ? new Response(null, { status: 415, headers: { 'x-portway-decode-error': '1' } })
        : new Response('accepted', { status: 200 });
    };

    await transport.fetch(fetchImpl, 'https://example.test/v1/responses', requestInit(), request);

    expect(encodings).toEqual(['zstd', null]);
    expect(bodies[1]).toEqual(request);
  });

  it('does not retry unmarked rejection or network failure', async () => {
    const request = body('model-a', 'no retry');
    const unmarked = new RequestDictionaryTransport();
    let unmarkedCalls = 0;
    const unmarkedFetch: typeof fetch = async () => {
      unmarkedCalls += 1;
      return new Response(null, { status: 415 });
    };
    const unmarkedResponse = await unmarked.fetch(unmarkedFetch, 'https://example.test/v1/responses', requestInit(), request);
    expect(unmarkedResponse.status).toBe(415);
    expect(unmarkedCalls).toBe(1);

    const missing = new RequestDictionaryTransport({ dictionary: true });
    let missingCalls = 0;
    const missingFetch: typeof fetch = async () => {
      missingCalls += 1;
      return new Response(null, { status: 412, headers: { 'x-portway-decode-error': '1' } });
    };
    const missingResponse = await missing.fetch(missingFetch, 'https://example.test/v1/responses', requestInit(), request);
    expect(missingResponse.status).toBe(412);
    expect(missingCalls).toBe(1);

    const failed = new RequestDictionaryTransport();
    let failedCalls = 0;
    const failure = new Error('network');
    const failedFetch: typeof fetch = async () => {
      failedCalls += 1;
      throw failure;
    };
    await expect(failed.fetch(failedFetch, 'https://example.test/v1/responses', requestInit(), request)).rejects.toBe(failure);
    expect(failedCalls).toBe(1);
  });

  it('does not send when aborted before or during native encoding', async () => {
    const transport = new RequestDictionaryTransport({ dictionary: true });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('unexpected');
    };
    await expect(transport.fetch(
      fetchImpl,
      'https://example.test/v1/responses',
      requestInit({}, controller.signal),
      body('model-a', 'cancelled'),
    )).rejects.toBe(reason);
    expect(calls).toBe(0);

    const duringTransport = new RequestDictionaryTransport();
    const duringController = new AbortController();
    const during = duringTransport.fetch(
      fetchImpl,
      'https://example.test/v1/responses',
      requestInit({}, duringController.signal),
      Buffer.from(JSON.stringify({ model: 'model-a', input: 'x'.repeat(2_000_000) })),
    );
    duringController.abort(reason);
    await expect(during).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  it('keeps one 64MiB process ceiling and does not reuse another encoder dictionary', async () => {
    expect(dictionaryProcessBudgetAccounting().maxBytes).toBe(64 * 1024 * 1024);
    const before = dictionaryProcessBudgetAccounting().retainedBytes;
    const left = new RequestDictionaryTransport({ dictionary: true });
    const right = new RequestDictionaryTransport({ dictionary: true });
    const leftServer = fixtureFetch();
    const rightServer = fixtureFetch();
    const first = body('model-a', 'left encoder');
    const second = body('model-a', 'right encoder');
    const third = body('model-a', 'left follows');

    await left.fetch(leftServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
    await right.fetch(rightServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);
    await right.fetch(rightServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer two' }), second);
    const follow = await left.fetch(leftServer.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), third);

    expect(follow.status).toBe(200);
    expect(rightServer.calls.map((call) => call.encoding)).toEqual(['zstd', 'zstd']);
    expect(leftServer.calls.map((call) => call.encoding)).toEqual(['zstd', 'dcz']);
    expect(leftServer.calls[1]?.body.subarray(8, 40).toString('hex')).toBe(digest(first));
    expect(dictionaryProcessBudgetAccounting().retainedBytes - before).toBe(left.retainedBytes() + right.retainedBytes());
    expect(left.retainedBytes()).toBeGreaterThan(0);
    expect(right.retainedBytes()).toBeGreaterThan(0);
  });

  it('evicts the least recently used encoder when the shared ceiling cannot hold both', async () => {
    const older = body('model-a', 'budget-a1');
    const newer = body('model-a', 'budget-b1');
    const touched = body('model-a', 'budget-a2');
    const challenger = body('model-a', 'budget-b2');
    const probeLeft = body('model-a', 'budget-a3');
    const probeRight = body('model-a', 'budget-b3');
    expect(new Set([older, newer, touched, challenger, probeLeft, probeRight].map((value) => value.length)).size).toBe(1);
    const budget = testingUseDictionaryBudget(older.length * 2);
    try {
      const left = new RequestDictionaryTransport({ dictionary: true });
      const right = new RequestDictionaryTransport({ dictionary: true });
      const leftServer = fixtureFetch();
      const rightServer = fixtureFetch();
      const shared = requestInit({ authorization: 'Bearer shared' });
      const other = requestInit({ authorization: 'Bearer other' });
      await left.fetch(leftServer.fetch, 'https://example.test/v1/responses', shared, older);
      await right.fetch(rightServer.fetch, 'https://example.test/v1/responses', shared, newer);
      const probes: Array<{ encoding: string | null; hash: string | undefined }> = [];
      const probeFetch: typeof fetch = async (input, requestInitValue) => {
        const request = new Request(input, requestInitValue);
        const wire = Buffer.from(await request.arrayBuffer());
        const encoding = request.headers.get('content-encoding');
        probes.push({
          encoding,
          hash: encoding === 'dcz' ? wire.subarray(8, 40).toString('hex') : undefined,
        });
        return new Response('ok', { status: 200 });
      };
      await left.fetch(probeFetch, 'https://example.test/v1/responses', shared, touched);
      await right.fetch(rightServer.fetch, 'https://example.test/v1/responses', other, challenger);
      await left.fetch(probeFetch, 'https://example.test/v1/responses', shared, probeLeft);
      await right.fetch(probeFetch, 'https://example.test/v1/responses', shared, probeRight);
      await right.fetch(probeFetch, 'https://example.test/v1/responses', other, probeRight);

      expect(probes.map((probe) => probe.encoding)).toEqual(['dcz', 'dcz', 'zstd', 'dcz']);
      expect(probes[0]?.hash).toBe(digest(older));
      expect(probes[1]?.hash).toBe(digest(older));
      expect(probes[3]?.hash).toBe(digest(challenger));
      expect(leftServer.calls.map((call) => call.encoding)).toEqual(['zstd']);
      expect(rightServer.calls.map((call) => call.encoding)).toEqual(['zstd', 'zstd']);
      expect(budget.retainedBytes()).toBe(older.length * 2);
      expect(left.retainedBytes()).toBe(older.length);
      expect(right.retainedBytes()).toBe(challenger.length);
    } finally {
      budget.restore();
    }
  });

  it('releases an acknowledged dictionary when its timer fires without another fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const budget = testingUseDictionaryBudget(8 * 1024 * 1024);
    try {
      const transport = new RequestDictionaryTransport({ dictionary: true, ttlMs: 5_000 });
      const server = fixtureFetch();
      const first = body('model-a', 'idle expiry');
      const second = body('model-a', 'after idle');
      await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), first);
      expect(transport.retainedBytes()).toBe(first.length);
      expect(budget.retainedBytes()).toBe(first.length);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(transport.retainedBytes()).toBe(0);
      expect(budget.retainedBytes()).toBe(0);
      await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), second);
      expect(server.calls.map((call) => call.encoding)).toEqual(['zstd', 'zstd']);
    } finally {
      budget.restore();
      vi.useRealTimers();
    }
  });

  it('rearms expiry on a repeated acknowledgement and ignores the stale timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const budget = testingUseDictionaryBudget(8 * 1024 * 1024);
    try {
      const transport = new RequestDictionaryTransport({ dictionary: true, ttlMs: 10_000 });
      const server = fixtureFetch();
      const first = body('model-a', 'refresh-me');
      const second = body('model-a', 'still-there');
      const init = requestInit({ authorization: 'Bearer one' });
      await transport.fetch(server.fetch, 'https://example.test/v1/responses', init, first);
      await vi.advanceTimersByTimeAsync(4_000);
      await transport.fetch(server.fetch, 'https://example.test/v1/responses', init, first);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(transport.retainedBytes()).toBe(first.length);
      expect(budget.retainedBytes()).toBe(first.length);
      await transport.fetch(server.fetch, 'https://example.test/v1/responses', init, second);
      expect(server.calls.at(-1)?.encoding).toBe('dcz');
      expect(server.calls.at(-1)?.body.subarray(8, 40).toString('hex')).toBe(digest(first));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(transport.retainedBytes()).toBe(second.length);
      expect(budget.retainedBytes()).toBe(second.length);
    } finally {
      budget.restore();
      vi.useRealTimers();
    }
  });

  it('does not let an evicted timer delete a dictionary stored again under the same hash', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = body('model-a', 'same-hash');
    const second = body('model-a', 'other-row');
    const budget = testingUseDictionaryBudget(first.length);
    try {
      const left = new RequestDictionaryTransport({ dictionary: true, ttlMs: 10_000 });
      const right = new RequestDictionaryTransport({ dictionary: true, ttlMs: 10_000 });
      const leftServer = fixtureFetch();
      const rightServer = fixtureFetch();
      const init = requestInit({ authorization: 'Bearer one' });
      await left.fetch(leftServer.fetch, 'https://example.test/v1/responses', init, first);
      await vi.advanceTimersByTimeAsync(4_000);
      await right.fetch(rightServer.fetch, 'https://example.test/v1/responses', init, second);
      expect(left.retainedBytes()).toBe(0);
      await left.fetch(leftServer.fetch, 'https://example.test/v1/responses', init, first);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(left.retainedBytes()).toBe(first.length);
      expect(right.retainedBytes()).toBe(0);
      expect(budget.retainedBytes()).toBe(first.length);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(left.retainedBytes()).toBe(0);
      expect(budget.retainedBytes()).toBe(0);
    } finally {
      budget.restore();
      vi.useRealTimers();
    }
  });

  it('unrefs the expiry timer so an idle dictionary does not hold the process open', async () => {
    const probe = setTimeout(() => {}, 60_000);
    const unref = vi.spyOn(Object.getPrototypeOf(probe) as { unref: () => void }, 'unref');
    clearTimeout(probe);
    const budget = testingUseDictionaryBudget(8 * 1024 * 1024);
    try {
      const transport = new RequestDictionaryTransport({ dictionary: true, ttlMs: 60_000 });
      const server = fixtureFetch();
      await transport.fetch(server.fetch, 'https://example.test/v1/responses', requestInit({ authorization: 'Bearer one' }), body('model-a', 'unref'));
      expect(unref).toHaveBeenCalled();
      expect(transport.retainedBytes()).toBeGreaterThan(0);
    } finally {
      unref.mockRestore();
      budget.restore();
    }
  });
});

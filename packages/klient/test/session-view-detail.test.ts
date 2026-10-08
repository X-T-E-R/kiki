import { describe, expect, it, vi } from 'vitest';
import { TRANSCRIPT_COVERAGE_VERSION } from '@kiki/transcript';

import { createKlient } from '../src/transports/http/index.js';
import { KlientValidationError } from '../src/core/validation.js';

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data, request_id: 'r1' }), { headers: { 'content-type': 'application/json' } });
}

const task = {
  taskId: 'task-1', kind: 'shell', state: 'completed', outputTail: 'full output', description: 'build', detached: false,
};

describe('session view transcript detail', () => {
  it('preserves structured stale page and entity responses through HTTP validation', async () => {
    const read = { source: 'cold', readiness: 'partial', reason: 'source_changed', stale: { reason: 'source_changed', retry: 'authoritative' } };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      return envelope(url.pathname.endsWith('/details')
        ? { session_id: 's1', agent_id: 'main', kind: 'task', items: [], has_more: true, read }
        : { session_id: 's1', agent_id: 'main', items: [], tasks: [], meta: {}, agents: [], pending_interactions: [], has_more: true,
          coverage: { kind: 'unknown', hasMoreOlder: true }, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION, read });
    });
    const klient = createKlient({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      const transcript = klient.session('s1').view.transcript;
      await expect(transcript.page({ agentId: 'main', beforeItem: 'source-bound' })).resolves.toMatchObject({ items: [], has_more: true, read });
      await expect(transcript.entities!({ agentId: 'main', kind: 'task', cursor: 'source-bound' })).resolves.toMatchObject({ items: [], has_more: true, read });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await klient.close(); }
  });
  it('reads one entity through the authenticated session detail route', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/sessions/s%201/transcript/detail');
      expect(Object.fromEntries(url.searchParams)).toEqual({ agent_id: 'main', kind: 'task', id: 'task-1' });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return envelope({ session_id: 's 1', agent_id: 'main', kind: 'task', task });
    });
    const klient = createKlient({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      const detail = klient.session('s 1').view.transcript.detail;
      expect(detail).toBeTypeOf('function');
      await expect(detail!({ agentId: 'main', kind: 'task', id: 'task-1' })).resolves.toMatchObject({
        kind: 'task', task: { taskId: 'task-1', outputTail: 'full output' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await klient.close();
    }
  });

  it('rejects a path-like agent id before sending and a malformed body after', async () => {
    const fetchMock = vi.fn(async () => envelope({ session_id: 's1', agent_id: 'main', kind: 'task', task: { taskId: 'x' } }));
    const klient = createKlient({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      const detail = klient.session('s1').view.transcript.detail!;
      await expect(detail({ agentId: '../main', kind: 'task', id: 'x' })).rejects.toBeInstanceOf(KlientValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(detail({ agentId: 'main', kind: 'task', id: 'x' })).rejects.toBeInstanceOf(KlientValidationError);
    } finally {
      await klient.close();
    }
  });
});


describe('session history page lifecycle', () => {
  it('waits beyond the ordinary request deadline by default and samples a new reading deadline on the same client', async () => {
    let readingTimeout = 0;
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 45);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
      });
      return envelope({ session_id: 's1', agent_id: 'main', epoch: 'epoch-1', through_seq: 1, complete: true, batches: [] });
    });
    const klient = createKlient({ endpoint: 'http://example.test', timeoutMs: 5,
      readingTimeoutMs: () => readingTimeout, fetch: fetchMock as typeof fetch });
    try {
      await expect(klient.session('s1').view.transcript.catchUp({ agentId: 'main', since: { seq: 0 } })).resolves.toMatchObject({ complete: true });
      readingTimeout = 10;
      await expect(klient.session('s1').view.transcript.catchUp({ agentId: 'main', since: { seq: 0 } })).rejects.toThrow('call timed out after 10ms');
      readingTimeout = 0;
      await expect(klient.session('s1').view.transcript.catchUp({ agentId: 'main', since: { seq: 0 } })).resolves.toMatchObject({ complete: true });
      await expect(klient.session('s1').status()).rejects.toThrow('call timed out after 5ms');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally { await klient.close(); }
  });
  it.each(['page', 'catchUp'] as const)('forwards %s cancellation through body consumption without putting the signal in wire input', async (kind) => {
    let receivedSignal: AbortSignal | undefined;
    let requestedUrl: URL | undefined;
    let bodyStarted = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requestedUrl = new URL(String(input));
      receivedSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"code":0,"msg":"success","data":'));
          bodyStarted = true;
          receivedSignal?.addEventListener('abort', () => controller.error(new DOMException('Cancelled', 'AbortError')), { once: true });
        },
      }));
    });
    const klient = createKlient({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    const controller = new AbortController();
    try {
      const transcript = klient.session('s1').view.transcript;
      const pending = kind === 'page'
        ? transcript.page({ agentId: 'main', beforeItem: 'cursor-1', pageSize: 100 }, { signal: controller.signal })
        : transcript.catchUp({ agentId: 'main', since: { seq: 4, epoch: 'epoch-1' } }, { signal: controller.signal });
      const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(bodyStarted).toBe(true);
      expect(receivedSignal?.aborted).toBe(false);
      expect(requestedUrl?.searchParams.has('signal')).toBe(false);
      controller.abort();
      await failure;
      expect(receivedSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await klient.close(); }
  });

  it('still rejects malformed JSON and invalid UTF-8 on uncapped history pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{invalid json'))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xfe])));
    const klient = createKlient({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(klient.session('s1').view.transcript.page({ agentId: 'main' })).rejects.toThrow('non-JSON response');
      await expect(klient.session('s1').view.transcript.page({ agentId: 'main' })).rejects.toThrow();
    } finally { await klient.close(); }
  });
});

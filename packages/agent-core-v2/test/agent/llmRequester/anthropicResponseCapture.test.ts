import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicResponseCapture } from '#/agent/llmRequester/anthropicResponseCapture';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';
import { observeResponseFetch } from '#/kosong/provider/bases/observe-response';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';

const filter = () => ({ sessionId: 'example-session', agentId: 'example-agent', providerId: 'example-provider', model: 'example-model', thinkingEffort: 'medium', expiresAt: Date.now() + 3_600_000, maxResponses: 20 });
const match = { providerId: 'example-provider', model: 'example-model', thinkingEffort: 'medium', protocol: 'anthropic', turnId: 7, step: 3, cacheKey: 'example-session' };
const encoder = new TextEncoder();
function fixture(fail = false) {
  const records: Record<string, unknown>[] = [];
  const logs = { append: (_scope: string, _key: string, record: Record<string, unknown>) => { if (fail) throw new Error('disk'); records.push(record); }, flush: async () => {} } as unknown as IAppendLogStore;
  const capture = new AnthropicResponseCapture(logs, 'logs', filter());
  return { capture, records };
}
afterEach(() => vi.restoreAllMocks());

describe('scoped Anthropic raw response capture', () => {
  it('preserves actual SDK thinking-only SSE bytes and IDs without observing auth or rewriting finish', async () => {
    const { capture, records } = fixture();
    const raw = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"response-example","role":"assistant","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"reason"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const chunks = [encoder.encode(raw.slice(0, 61)), encoder.encode(raw.slice(61))];
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(controller) {
      const chunk = chunks[reads++]; if (chunk === undefined) controller.close(); else controller.enqueue(chunk);
    } }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'request-example', authorization: 'SECRET', 'set-cookie': 'SECRET' } })));
    try {
      const provider = new AnthropicChatProvider({ model: 'example-model', apiKey: 'SECRET', baseUrl: 'https://example.test' });
      const stream = await provider.generate('system', [], [{ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] }], { rawResponseObserver: capture.observe(match) });
      const parts = []; for await (const part of stream) parts.push(part);
      expect(parts).toEqual([{ type: 'think', think: 'reason' }]);
      expect(stream.id).toBe('response-example'); expect(stream.rawFinishReason).toBe('end_turn');
      const saved = Buffer.concat(records.filter((record) => record['type'] === 'response.chunk').map((record) => Buffer.from(record['base64'] as string, 'base64'))).toString();
      expect(saved).toBe(raw); expect(reads).toBe(3);
      expect(records.find((record) => record['type'] === 'response.start')).toMatchObject({ requestId: 'request-example', status: 200 });
      expect(records.find((record) => record['type'] === 'response.end')).toMatchObject({ outcome: 'eof' });
      expect(JSON.stringify(records)).not.toContain('SECRET');
      expect((await capture.flush()).flushed).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('returns the first chunk before EOF, consumes once, and propagates cancellation', async () => {
    const { capture, records } = fixture();
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('first')); }, cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } });
    const fetchImpl = vi.fn(async () => response);
    const observed = await observeResponseFetch(fetchImpl, capture.observe(match)! )('https://example.test');
    const reader = observed.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    expect(records.filter((record) => record['type'] === 'response.chunk')).toHaveLength(1);
    await reader.cancel('operator'); expect(cancelled).toHaveBeenCalledWith('operator');
    expect(records.find((record) => record['type'] === 'response.end')).toMatchObject({ outcome: 'cancelled' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps original stream errors and successful model bytes when the diagnostic sink fails', async () => {
    const failed = fixture(true);
    expect(failed.capture.status()).toMatchObject({ enabled: false, storageFailed: true, closedReason: 'storage-failed' });
    const throwing = { start: () => { throw new Error('sink'); }, chunk: () => { throw new Error('sink'); }, end: () => { throw new Error('sink'); } };
    const fetchImpl = async () => new Response('actual', { headers: { 'content-type': 'text/event-stream' } });
    expect(await (await observeResponseFetch(fetchImpl, throwing)('https://example.test')).text()).toBe('actual');
    const { capture, records } = fixture();
    const error = new Error('original transport failure');
    const broken = async () => new Response(new ReadableStream({ pull(controller) { controller.error(error); } }), { headers: { 'content-type': 'text/event-stream' } });
    await expect((await observeResponseFetch(broken, capture.observe(match)! )('https://example.test')).text()).rejects.toBe(error);
    expect(records.find((record) => record['type'] === 'response.end')).toMatchObject({ outcome: 'stream-error' });
  });

  it('matches exact provider/model/effort only and closes on stop, expiry and response limit', () => {
    const { capture, records } = fixture();
    for (const mismatched of [{ providerId: 'other' }, { model: 'other' }, { thinkingEffort: 'high' }, { protocol: 'openai' }]) expect(capture.observe({ ...match, ...mismatched })).toBeUndefined();
    const observer = capture.observe(match)!; capture.stop();
    const count = records.length; observer.chunk(encoder.encode('late')); observer.end('eof');
    expect(records).toHaveLength(count); expect(capture.observe(match)).toBeUndefined();
    const expired = fixture(); vi.spyOn(Date, 'now').mockReturnValue(expired.capture.status().filter.expiresAt + 1);
    expect(expired.capture.observe(match)).toBeUndefined(); expect(expired.capture.status().closedReason).toBe('expired');
    vi.restoreAllMocks();
    const once = new AnthropicResponseCapture({ append: () => {}, flush: async () => {} } as unknown as IAppendLogStore, 'logs', { ...filter(), maxResponses: 1 });
    once.observe(match)!.end('eof'); expect(once.status()).toMatchObject({ enabled: false, responses: 1, completed: 1, closedReason: 'response-limit' });
  });

  it('marks byte truncation and asynchronous append failures without treating them as full responses', () => {
    const { capture, records } = fixture();
    capture.observe(match)!.chunk(new Uint8Array(8 * 1024 * 1024 + 1));
    expect(capture.status()).toMatchObject({ enabled: false, bytes: 0, closedReason: 'byte-limit' });
    expect(records.find((record) => record['type'] === 'response.end')).toMatchObject({ outcome: 'byte-limit' });
    let onError: (() => void) | undefined;
    const logs = { append: (_scope: string, _key: string, _record: unknown, options: { onError: () => void }) => { onError = options.onError; }, flush: async () => {} } as unknown as IAppendLogStore;
    const failed = new AnthropicResponseCapture(logs, 'logs', filter());
    const observer = failed.observe(match)!;
    onError!(); observer.chunk(encoder.encode('late'));
    expect(failed.status()).toMatchObject({ enabled: false, storageFailed: true, bytes: 0, closedReason: 'storage-failed' });
  });

  it('records non-SSE status without consuming a JSON error body or pretending raw SSE coverage', async () => {
    const { capture, records } = fixture();
    const response = new Response('{"error":"unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } });
    expect(await observeResponseFetch(async () => response, capture.observe(match)! )('https://example.test')).toBe(response);
    expect(response.bodyUsed).toBe(false); expect(records.find((record) => record['type'] === 'response.end')).toMatchObject({ outcome: 'not-sse' });
    expect(records.some((record) => record['type'] === 'response.chunk')).toBe(false);
  });
});

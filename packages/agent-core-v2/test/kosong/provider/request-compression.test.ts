import { createServer } from 'node:http';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ProviderConfigSchema, providersFromToml, providersToToml } from '#/app/kosongConfig/configSection';
import { generate } from '#/kosong/contract/generate';
import { isRetryableGenerateError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import { createRequestCompressionFetch } from '#/kosong/provider/bases/request-compression';
import { OpenAILegacyChatProvider } from '#/kosong/provider/bases/openai/openai-legacy';
import { OpenAIResponsesChatProvider } from '#/kosong/provider/bases/openai/openai-responses';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';

const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: '合成请求：preserve exact bytes.\n'.repeat(400) }], toolCalls: [] }];

function sse(value: Record<string, unknown>): string {
  const event = typeof value['type'] === 'string' ? `event: ${value['type']}\n` : '';
  return `${event}data: ${JSON.stringify(value)}\n\n`;
}
function responseBody(path: string): string {
  if (path.endsWith('/responses')) return sse({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } }) +
    sse({ type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'ok' }) +
    sse({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  if (path.endsWith('/messages')) return sse({ type: 'message_start', message: { id: 'msg_fixture', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }) +
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
    sse({ type: 'content_block_stop', index: 0 }) + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) + sse({ type: 'message_stop' });
  return sse({ id: 'chat_fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) +
    sse({ id: 'chat_fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
}

describe('request compression', () => {
  it.each(['gzip', 'zstd'] as const)('round-trips real SDK Responses, Messages and Chat HTTP bytes using %s', async (encoding) => {
    const captured: Array<{ path: string; encoding: string | undefined; bytes: Buffer; decoded: Buffer }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const coding = request.headers['content-encoding'];
        const decoded = coding === 'gzip' ? gunzipSync(bytes) : coding === 'zstd' ? zstdDecompressSync(bytes) : bytes;
        captured.push({ path: request.url!, encoding: typeof coding === 'string' ? coding : undefined, bytes, decoded });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(responseBody(request.url!));
      })().catch(() => { response.destroy(); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No local server');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      for (const Provider of [OpenAILegacyChatProvider, OpenAIResponsesChatProvider, AnthropicChatProvider]) {
        for (const requestCompression of [undefined, { encoding, targets: [baseUrl] }]) {
          const provider = new Provider({ model: 'fixture-model', apiKey: 'synthetic-key', baseUrl, requestCompression });
          const result = await generate(provider, 'Synthetic instruction', [], history);
          expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
        }
      }
      expect(captured).toHaveLength(6);
      for (let index = 0; index < captured.length; index += 2) {
        const plain = captured[index]!;
        const encoded = captured[index + 1]!;
        expect(encoded.path).toBe(plain.path);
        expect(encoded.encoding).toBe(encoding);
        expect(encoded.decoded).toEqual(plain.bytes);
        expect(encoded.bytes.length).toBeLessThan(plain.bytes.length);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    }
  });

  it('round-trips schema and TOML without silently enabling retention', () => {
    const raw = { synthetic: { request_compression: { encoding: 'zstd', targets: ['https://example.test/v1'], min_bytes: 2048 } } };
    const config = providersFromToml(raw);
    expect(config).toEqual({ synthetic: { requestCompression: { encoding: 'zstd', targets: ['https://example.test/v1'], minBytes: 2048 } } });
    expect(providersToToml(config, {})).toEqual(raw);
    expect(ProviderConfigSchema.parse({ requestCompression: { encoding: 'off' } }).requestCompression).toEqual({ encoding: 'off' });
    for (const target of ['ftp://example.test', 'https://user:password@example.test', 'https://example.test/v1?token=example']) {
      expect(ProviderConfigSchema.safeParse({ requestCompression: { encoding: 'gzip', targets: [target] } }).success).toBe(false);
    }
    expect(ProviderConfigSchema.safeParse({ requestCompression: { encoding: 'gzip', targets: [] } }).success).toBe(false);
  });

  it('preserves disabled, small, empty, streaming, encoded and unsupported-target requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('ok'));
    const compressed = createRequestCompressionFetch({ encoding: 'gzip', targets: ['https://example.test/v1'], minBytes: 1024 })(fetchImpl);
    const body = 'x'.repeat(4096);
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    for (const url of ['https://other.example.test/v1/messages', 'https://example.test/v10/messages']) await compressed(url, init);
    for (const small of ['', 'small']) await compressed('https://example.test/v1/messages', { ...init, body: small });
    await compressed('https://example.test/v1/messages', { ...init, headers: { ...init.headers, 'content-encoding': 'gzip' } });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } });
    await compressed('https://example.test/v1/messages', { ...init, body: stream });
    await createRequestCompressionFetch({ encoding: 'off' })(fetchImpl)('https://example.test/v1/messages', init);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(fetchImpl.mock.calls[0]?.[1]).toBe(init);
    expect(fetchImpl.mock.calls[4]?.[1]?.body).toBe(body);
    expect(fetchImpl.mock.calls[5]?.[1]?.body).toBe(stream);
    expect(fetchImpl.mock.calls[6]?.[1]).toBe(init);
  });

  it('honors the exact threshold and replaces stale content length', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('ok'));
    const body = 'x'.repeat(1024);
    await createRequestCompressionFetch({ encoding: 'gzip', targets: ['https://example.test/v1'] })(fetchImpl)(
      'https://example.test/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1024' }, body });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('content-encoding')).toBe('gzip');
    const wire = Buffer.from(await new Response(init?.body).arrayBuffer());
    expect(new Headers(init?.headers).get('content-length')).toBe(String(wire.length));
    expect(gunzipSync(wire).toString()).toBe(body);
  });

  it('does not send aborted compression or retry rejected/ambiguous generation', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 415 }));
    const compress = createRequestCompressionFetch({ encoding: 'gzip', targets: ['https://example.test'] })(fetchImpl);
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(8 * 1024 * 1024), signal: controller.signal };
    const pending = compress('https://example.test/messages', init);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const result = await compress('https://example.test/messages', { ...init, body: 'x'.repeat(2048), signal: undefined });
    expect(result.status).toBe(415);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockRejectedValueOnce(new TypeError('synthetic disconnect'));
    const failure = await compress('https://example.test/messages', { ...init, body: 'x'.repeat(2048), signal: undefined }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ details: { request_delivery: 'ambiguous' } });
    expect(isRetryableGenerateError(failure)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

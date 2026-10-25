import { APIError as OpenAIAPIError } from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/bases/anthropic/index';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import {
  APIProviderQuotaExhaustedError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { ProtocolTrait, TraitContext } from '#/kosong/protocol/protocolTrait';
import { KimiFiles } from '#/kosong/provider/providers/kimi/kimi-files';
import {
  convertKimiTool,
  kimiAnthropicTrait,
  kimiImageFilesBaseUrl,
  kimiOpenAITrait,
} from '#/kosong/provider/providers/kimi/kimi.contrib';

afterEach(() => vi.unstubAllGlobals());

const context: TraitContext = {
  config: { protocol: 'openai', providerType: 'kimi', modelName: 'kimi-k2' },
  providerId: 'kimi',
};

function call<T>(hook: ((...args: never[]) => T) | undefined, ...args: unknown[]): T | undefined {
  return hook === undefined ? undefined : hook(...(args as never[]));
}

describe('kimiOpenAITrait.convertTool', () => {
  it('converts $-prefixed tools to builtin_function declarations', () => {
    const tool: Tool = { name: '$web_search', description: 'search', parameters: {} };
    expect(call(kimiOpenAITrait.convertTool, tool, context)).toEqual({
      type: 'builtin_function',
      function: { name: '$web_search' },
    });
  });

  it('normalizes the schema dialect of regular tools', () => {
    const tool: Tool = {
      name: 'read_file',
      description: 'read',
      parameters: {
        $defs: { path: { type: 'string' } },
        properties: { path: { $ref: '#/$defs/path' } },
      },
    };
    expect(convertKimiTool(tool)).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'read',
        parameters: { properties: { path: { type: 'string' } } },
      },
    });
  });
});

describe('kimiOpenAITrait.convertMessage', () => {
  const assistantToolMessage: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: '   ' }],
    toolCalls: [
      { type: 'function', id: 'call_1', name: 'read_file', arguments: '{}', extras: { a: 1 } },
      { type: 'function', id: 'call_2', name: 'write_file', arguments: null },
    ],
  };

  it('deletes effectively-empty content on assistant tool messages', () => {
    const converted: Record<string, unknown> = {
      role: 'assistant',
      content: '   ',
      tool_calls: [
        { type: 'function', id: 'call_1', function: { name: 'read_file', arguments: '{}' } },
        { type: 'function', id: 'call_2', function: { name: 'write_file', arguments: null } },
      ],
    };
    const out = call(kimiOpenAITrait.convertMessage, assistantToolMessage, converted, context);
    expect(out).not.toHaveProperty('content');
  });

  it('round-trips tool_calls extras by index', () => {
    const converted: Record<string, unknown> = {
      role: 'assistant',
      tool_calls: [
        { type: 'function', id: 'call_1', function: { name: 'read_file', arguments: '{}' } },
        { type: 'function', id: 'call_2', function: { name: 'write_file', arguments: null } },
      ],
    };
    const out = call(
      kimiOpenAITrait.convertMessage,
      assistantToolMessage,
      converted,
      context,
    ) as Record<string, unknown>;
    const toolCalls = out['tool_calls'] as Record<string, unknown>[];
    expect(toolCalls[0]?.['extras']).toEqual({ a: 1 });
    expect(toolCalls[1]).not.toHaveProperty('extras');
  });

  it('keeps non-empty content untouched', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'working on it' }],
      toolCalls: [{ type: 'function', id: 'c', name: 't', arguments: null }],
    };
    const converted: Record<string, unknown> = { role: 'assistant', content: 'working on it' };
    const out = call(kimiOpenAITrait.convertMessage, message, converted, context);
    expect(out).toHaveProperty('content', 'working on it');
  });

  it('embeds message-level tools', () => {
    const message: Message = {
      role: 'assistant',
      content: [],
      toolCalls: [],
      tools: [{ name: '$web_search', description: '', parameters: {} }],
    };
    const converted: Record<string, unknown> = { role: 'assistant' };
    const out = call(kimiOpenAITrait.convertMessage, message, converted, context);
    expect(out?.['tools']).toEqual([
      { type: 'builtin_function', function: { name: '$web_search' } },
    ]);
  });
});

describe('kimiOpenAITrait reasoning hooks', () => {
  it('does not pin a reasoning field — the base detects the endpoint dialect', () => {
    expect(kimiOpenAITrait.reasoningKey).toBeUndefined();
  });

  it('force-replays reasoning only in keep:all sessions with thinking enabled', () => {
    const keepAll = {
      extra_body: { thinking: { type: 'enabled', keep: 'all' } },
    };
    expect(call(kimiOpenAITrait.preserveThinking, keepAll, context)).toBe(true);

    const keepAllDisabled = {
      extra_body: { thinking: { type: 'disabled', keep: 'all' } },
    };
    expect(call(kimiOpenAITrait.preserveThinking, keepAllDisabled, context)).toBeUndefined();

    const keepSome = {
      extra_body: { thinking: { type: 'enabled', keep: 'some' } },
    };
    expect(call(kimiOpenAITrait.preserveThinking, keepSome, context)).toBeUndefined();
    expect(call(kimiOpenAITrait.preserveThinking, {}, context)).toBeUndefined();
  });
});

describe('kimiOpenAITrait.extractUsage', () => {
  it('finds usage at the top level', () => {
    const usage = { prompt_tokens: 10, completion_tokens: 2 };
    expect(call(kimiOpenAITrait.extractUsage, { usage }, context)).toBe(usage);
  });

  it('finds usage inside choices[0].usage', () => {
    const usage = { prompt_tokens: 5, completion_tokens: 1 };
    expect(call(kimiOpenAITrait.extractUsage, { choices: [{ usage }] }, context)).toBe(usage);
  });

  it('defers to the base default when the chunk carries no usage', () => {
    expect(call(kimiOpenAITrait.extractUsage, { choices: [] }, context)).toBeUndefined();
    expect(call(kimiOpenAITrait.extractUsage, { choices: [{}] }, context)).toBeUndefined();
  });
});

describe('kimiOpenAITrait request params', () => {
  it('declares the KIMI_API_KEY / KIMI_BASE_URL fallback chain and default base URL', () => {
    expect(call(kimiOpenAITrait.endpoint, context)).toEqual({
      apiKeyEnv: 'KIMI_API_KEY',
      baseUrlEnv: 'KIMI_BASE_URL',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
    });
  });

  it('encodes the cache key as prompt_cache_key', () => {
    expect(call(kimiOpenAITrait.cacheKey, 'session-1', context)).toEqual({
      prompt_cache_key: 'session-1',
    });
  });

  it('encodes thinking into extra_body.thinking, carrying keep', () => {
    expect(call(kimiOpenAITrait.withThinking, 'high', {}, {}, context)).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'high' } },
    });
    expect(call(kimiOpenAITrait.withThinking, 'on', {}, {}, context)).toEqual({
      extra_body: { thinking: { type: 'enabled' } },
    });
    expect(call(kimiOpenAITrait.withThinking, 'off', {}, {}, context)).toEqual({
      extra_body: { thinking: { type: 'disabled' } },
    });
    expect(call(kimiOpenAITrait.withThinking, 'high', { keep: 'all' }, {}, context)).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'high', keep: 'all' } },
    });
  });

  it('applies no 128k ceiling in withMaxCompletionTokens', () => {
    expect(call(kimiOpenAITrait.withMaxCompletionTokens, 200_000, context)).toEqual({
      max_completion_tokens: 200_000,
    });
  });

  it('buildParams backfills max_completion_tokens, drops max_tokens, expands extra_body last', () => {
    const out = call(
      kimiOpenAITrait.buildParams,
      {
        model: 'kimi-k2',
        max_tokens: 4096,
        extra_body: { thinking: { type: 'enabled', effort: 'high' }, custom_flag: true },
      },
      context,
    );
    expect(out).toEqual({
      model: 'kimi-k2',
      max_completion_tokens: 4096,
      thinking: { type: 'enabled', effort: 'high' },
      custom_flag: true,
    });
  });

  it('buildParams keeps explicit top-level values over extra_body defaults', () => {
    const out = call(
      kimiOpenAITrait.buildParams,
      {
        max_tokens: 1024,
        max_completion_tokens: 2048,
        temperature: 0.5,
        extra_body: { temperature: 0.9 },
      },
      context,
    );
    expect(out).toEqual({ max_completion_tokens: 2048, temperature: 0.5 });
  });
});

describe('kimiAnthropicTrait (the (kimi, anthropic) registration)', () => {
  const seeded = { betaFeatures: ['interleaved-thinking-2025-05-14', 'other-beta'] };

  it('encodes thinking:{type:enabled} + output_config.effort and strips the interleaved beta', () => {
    const out = call(kimiAnthropicTrait.withThinking, 'high', {}, seeded, context);
    expect(out).toEqual({
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      betaFeatures: ['other-beta'],
    });
  });

  it('omits output_config for on', () => {
    expect(call(kimiAnthropicTrait.withThinking, 'on', {}, seeded, context)).toEqual({
      thinking: { type: 'enabled' },
      output_config: undefined,
      betaFeatures: ['other-beta'],
    });
  });

  it('encodes off as disabled', () => {
    expect(call(kimiAnthropicTrait.withThinking, 'off', {}, seeded, context)).toEqual({
      thinking: { type: 'disabled' },
      output_config: undefined,
      betaFeatures: ['other-beta'],
    });
  });
});

describe('trait objects are plain declarations', () => {
  it('exposes exactly the hooks appendix A assigns to them, plus metadata markers', () => {
    const hookNames = (trait: ProtocolTrait): string[] => Object.keys(trait);
    expect(hookNames(kimiOpenAITrait).toSorted()).toEqual([
      'buildParams',
      'cacheKey',
      'convertError',
      'convertMessage',
      'convertTool',
      'endpoint',
      'extractUsage',
      'preserveThinking',
      'strictThinkingValidation',
      'uploadImage',
      'uploadVideo',
      'withMaxCompletionTokens',
      'withRequestParams',
      'withThinking',
    ]);
    expect(hookNames(kimiAnthropicTrait).toSorted()).toEqual(['convertError', 'uploadImage', 'withThinking']);
  });

  it('marks only the native-transport thinking trait as strict-validation (v1 parity)', () => {
    expect(kimiOpenAITrait.strictThinkingValidation).toBe(true);
    expect(kimiAnthropicTrait.strictThinkingValidation).toBeUndefined();
  });
});

describe('Kimi image files', () => {
  it.each(['openai', 'anthropic'] as const)('uploads and encodes a file reference through the production %s provider', async (protocol) => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === 'data:,') return new Response('');
      requests.push(request);
      if (new URL(request.url).pathname === '/coding/v1/files') {
        return new Response(JSON.stringify({ id: 'file-fixture', purpose: 'image' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }));
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol, providerType: 'kimi', modelName: 'kimi-for-coding',
      baseUrl: protocol === 'anthropic' ? 'https://api.kimi.com/coding/' : 'https://api.kimi.com/coding/v1',
      apiKey: '', defaultHeaders: { 'X-Request-Identity': 'fixture-identity' },
    });
    const auth = { apiKey: 'fixture-current-token' };
    const headers = { 'x-kiki-internal-suppress-request-identity': '1', 'User-Agent': 'stale-fixture', 'X-Msh-Device-Id': 'stale-device' };
    const part = await provider.uploadImage!({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', filename: 'original.png' }, { auth, headers });
    expect(part).toEqual({ type: 'image_url', imageUrl: { url: 'ms://file-fixture', id: 'file-fixture' } });
    const stream = await provider.generate('', [], [{ role: 'user', content: [part!], toolCalls: [] }], { auth });
    for await (const _part of stream) {}
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST https://api.kimi.com/coding/v1/files',
      `POST https://api.kimi.com/coding/${protocol === 'openai' ? 'v1/chat/completions' : 'v1/messages'}`,
    ]);
    expect(requests[0]?.url).toBe('https://api.kimi.com/coding/v1/files');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer fixture-current-token');
    expect(requests[0]?.headers.get('x-request-identity')).toBe('fixture-identity');
    expect(requests[0]?.headers.has('user-agent')).toBe(false);
    expect(requests[0]?.headers.has('x-msh-device-id')).toBe(false);
    expect(requests[0]?.headers.has('x-kiki-internal-suppress-request-identity')).toBe(false);
    const upload = await requests[0]!.formData();
    expect(upload.get('purpose')).toBe('image');
    expect(new Uint8Array(await (upload.get('file') as File).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const body = await requests[1]!.json() as { messages: { content: unknown }[] };
    expect(JSON.stringify(body.messages)).toContain('ms://file-fixture');
  });

  it('limits automatic image uploads to known Kimi endpoints and restores the Anthropic files route', async () => {
    expect(kimiImageFilesBaseUrl('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding/v1');
    expect(kimiImageFilesBaseUrl('https://api.moonshot.cn/v1/')).toBe('https://api.moonshot.cn/v1');
    for (const endpoint of ['https://gateway.example.test/v1', 'https://api.kimi.com.example.test/coding/v1', 'http://api.kimi.com/coding/v1', 'https://api.kimi.com/coding/v1?token=fixture']) {
      expect(kimiImageFilesBaseUrl(endpoint)).toBeUndefined();
      expect(await kimiOpenAITrait.uploadImage!({ data: new Uint8Array([1]), mimeType: 'image/png' }, undefined, { ...context, config: { ...context.config, baseUrl: endpoint } })).toBeUndefined();
    }
  });

  it.each(['valid', 'expired', 'deleted'] as const)('validates a %s cached image with current auth before reuse', async (state) => {
    const retrieve = vi.fn(async () => {
      if (state === 'deleted') throw new OpenAIAPIError(404, {}, 'missing', new Headers());
      return { id: 'file-cached', purpose: 'image', status: 'processed', expires_at: state === 'expired' ? 1 : Math.floor(Date.now() / 1000) + 60 };
    });
    const create = vi.fn(async (_input: { file: File; purpose: string }, _options: { signal?: AbortSignal }) => ({ id: 'file-new' }));
    const factory = vi.fn(() => ({ files: { create, retrieve } }) as never);
    const files = new KimiFiles({ baseUrl: 'https://example.test/v1', clientFactory: factory });
    const data = new Uint8Array([1, 2, 3]);
    const signal = new AbortController().signal;
    const auth = { apiKey: 'fixture-token', headers: { 'X-Request-Identity': 'fixture-identity' } };
    const result = await files.uploadImage({ data, mimeType: 'image/png', filename: 'original.png' }, { auth, signal, cachedFileId: 'file-cached' });
    const id = state === 'valid' ? 'file-cached' : 'file-new';
    expect(result).toEqual({ type: 'image_url', imageUrl: { url: `ms://${id}`, id } });
    expect(factory).toHaveBeenCalledWith(auth);
    expect(retrieve).toHaveBeenCalledWith('file-cached', { signal });
    if (state === 'valid') expect(create).not.toHaveBeenCalled();
    else {
      expect(create).toHaveBeenCalledWith({ file: expect.any(File), purpose: 'image' }, { signal });
      const uploaded = create.mock.calls[0]?.[0] as unknown as { file: File };
      expect(new Uint8Array(await uploaded.file.arrayBuffer())).toEqual(data);
      expect(uploaded.file.name).toBe('original.png');
    }
  });

  it('keeps an authorization rejection out of the stale-file reupload path', async () => {
    const create = vi.fn();
    const files = new KimiFiles({ baseUrl: 'https://example.test/v1', clientFactory: () => ({ files: { create, retrieve: vi.fn().mockRejectedValue(new OpenAIAPIError(401, {}, 'unauthorized', new Headers())) } }) as never });
    await expect(files.uploadImage({ data: new Uint8Array([1]), mimeType: 'image/png' }, { cachedFileId: 'file-cached' })).rejects.toMatchObject({ statusCode: 401 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('KimiFiles upload error conversion', () => {
  it('fails fast on a Moonshot quota-exhausted 429 from the files API', async () => {
    const quotaError = new OpenAIAPIError(
      429,
      {
        message: 'Your account is suspended due to insufficient balance, please recharge',
        type: 'exceeded_current_quota_error',
      },
      '429 quota exhausted',
      new Headers(),
    );
    const files = new KimiFiles({
      baseUrl: 'https://api.example/v1',
      clientFactory: () => ({ files: { create: vi.fn().mockRejectedValue(quotaError) } }) as never,
    });

    const caught = await files
      .uploadVideo(
        { data: Buffer.from([1, 2, 3]), mimeType: 'video/mp4' },
        { auth: { apiKey: 'request-token' } },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(caught).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(caught)).toBe(false);
  });
});

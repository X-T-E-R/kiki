import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIStatusError,
  ChatProviderError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import { GoogleGenAIChatProvider } from '#/kosong/provider/bases/google-genai/google-genai';

const KEY = 'gk-local-fixture';
const SENTENCE = 'Requests ending with a model turn are not supported.';
const THINK_SIGNATURE = 'sig-thought';
const CALL_SIGNATURE = 'sig-call';
const SECOND_CALL_SIGNATURE = 'sig-second';

type SeenRequest = {
  readonly url: string;
  readonly body: string | undefined;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('google-genai trailing model turn', () => {
  it('refuses a signed think-only tail on gemini-4 before fetch and keeps history', async () => {
    const history = [user('Hi'), assistantThink('earlier reasoning', THINK_SIGNATURE)];
    const seen = installFetch(okSse);
    const caught = await captureGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(0);
    expectLocalRefusal(caught, 'model_prefill', ['thought_signature', 'thought', 'thought_text']);
    expect(history).toEqual([user('Hi'), assistantThink('earlier reasoning', THINK_SIGNATURE)]);
  });

  it('refuses a text prefill tail on gemini-4 and on later publisher resource ids', async () => {
    const history = [user('Hi'), assistantText('Translation:')];
    const direct = installFetch(okSse);
    expectLocalRefusal(await captureGenerate('gemini-4-argon', history), 'model_prefill', ['text']);
    expect(direct).toHaveLength(0);
    vi.unstubAllGlobals();
    const published = installFetch(okSse);
    expectLocalRefusal(
      await captureGenerate('projects/example/locations/global/publishers/google/models/gemini-4-argon', history),
      'model_prefill',
      ['text'],
    );
    expect(published).toHaveLength(0);
    expect(history[1]).toEqual(assistantText('Translation:'));
  });

  it('still sends a text prefill on gemini-2.5 and surfaces a real HTTP 400', async () => {
    const history = [user('Hi'), assistantText('Translation:')];
    const allowed = installFetch(okSse);
    await drainGenerate('gemini-2.5-flash', history);
    expect(allowed).toHaveLength(1);
    expect(lastRole(allowed[0]!)).toBe('model');
    expect(allowed[0]!.url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
    vi.unstubAllGlobals();
    const rejected = installFetch(modelTurn400);
    const caught = await captureGenerate('gemini-2.5-flash', history);
    expect(rejected).toHaveLength(1);
    expect(caught).toBeInstanceOf(APIStatusError);
    expect(caught).toMatchObject({ statusCode: 400 });
    expect((caught as Error).message).toContain(SENTENCE);
    expect((caught as ChatProviderError).details?.['google_content_tail']).toBeUndefined();
    expect(isRecoverableRequestStructureError(caught)).toBe(false);
    expect(isRetryableGenerateError(caught)).toBe(false);
  });

  it('keeps a user functionResponse tail, call order, and thought signatures', async () => {
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'plan', encrypted: THINK_SIGNATURE }],
        toolCalls: [
          call('alpha_1', 'alpha', CALL_SIGNATURE),
          call('beta_1', 'beta', SECOND_CALL_SIGNATURE),
        ],
      },
      tool('beta_1', 'b-out'),
      tool('alpha_1', 'a-out'),
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(1);
    const contents = contentsOf(seen[0]!);
    expect(contents.at(-1)?.['role']).toBe('user');
    const model = contents.find((content) => content['role'] === 'model');
    const parts = partsOf(model);
    expect(parts.map((part) => functionName(part, 'functionCall'))).toEqual([undefined, 'alpha', 'beta']);
    expect(parts[0]).toMatchObject({ thought: true, thoughtSignature: THINK_SIGNATURE });
    expect(parts[1]?.['thoughtSignature']).toBe(CALL_SIGNATURE);
    expect(parts[2]?.['thoughtSignature']).toBe(SECOND_CALL_SIGNATURE);
    expect(partsOf(contents.at(-1)).map((part) => responseOf(part))).toEqual([
      { name: 'alpha', output: 'a-out' },
      { name: 'beta', output: 'b-out' },
    ]);
    expect(history[2]).toMatchObject({ toolCallId: 'beta_1' });
    expect(history[3]).toMatchObject({ toolCallId: 'alpha_1' });
  });

  it('refuses a function-call tail that has no function response', async () => {
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [call('alpha_1', 'alpha', CALL_SIGNATURE)],
      },
    ] satisfies Message[];
    const seen = installFetch(okSse);
    const caught = await captureGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(0);
    expectLocalRefusal(caught, 'model_function_call', ['function_call', 'thought_signature']);
    expect(history[1]?.toolCalls[0]?.extras).toEqual({ thought_signature_b64: CALL_SIGNATURE });
  });

  it('sends a signed think that is followed by a user turn', async () => {
    const history = [assistantThink('earlier reasoning', THINK_SIGNATURE), user('Hi')];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(1);
    const contents = contentsOf(seen[0]!);
    expect(contents[0]).toMatchObject({
      role: 'model',
      parts: [{ text: 'earlier reasoning', thought: true, thoughtSignature: THINK_SIGNATURE }],
    });
    expect(contents.at(-1)?.['role']).toBe('user');
  });

  it('refuses a compaction-like summary followed by an assistant tail', async () => {
    const history = [user('summary of the previous turn'), assistantText('still answering')];
    const seen = installFetch(okSse);
    expectLocalRefusal(await captureGenerate('gemini-3.6-flash', history), 'model_prefill', ['text']);
    expect(seen).toHaveLength(0);
    expect(history).toHaveLength(2);
  });

  it('omits an empty model envelope from the wire and still sends the user tail', async () => {
    const history = [user('Hi'), assistantText('   ')];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(1);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user']);
    expect(history[1]).toEqual(assistantText('   '));
  });

  it('treats a signature-only think tail as a non-empty model turn', async () => {
    const history = [user('Hi'), assistantThink('', THINK_SIGNATURE)];
    const seen = installFetch(okSse);
    expectLocalRefusal(await captureGenerate('gemini-4-argon', history), 'model_prefill', ['thought_signature', 'thought']);
    expect(seen).toHaveLength(0);
    expect(history[1]?.content[0]).toMatchObject({ type: 'think', encrypted: THINK_SIGNATURE });
  });

  it('refuses gemini-3.5-flash-lite and still allows gemini-3.5-flash and gemini-3-pro prefills', async () => {
    const history = [user('Hi'), assistantText('Translation:')];
    const lite = installFetch(okSse);
    expectLocalRefusal(await captureGenerate('gemini-3.5-flash-lite', history), 'model_prefill', ['text']);
    expect(lite).toHaveLength(0);
    vi.unstubAllGlobals();
    const flash = installFetch(okSse);
    await drainGenerate('gemini-3.5-flash', history);
    expect(lastRole(flash[0]!)).toBe('model');
    vi.unstubAllGlobals();
    const pro = installFetch(okSse);
    await drainGenerate('gemini-3-pro', history);
    expect(lastRole(pro[0]!)).toBe('model');
  });

  it('refuses a media-only model tail instead of dropping it', async () => {
    const history = [
      user('Hi'),
      {
        role: 'assistant',
        content: [{ type: 'image_url', imageUrl: { url: 'https://example.test/a.png' } }],
        toolCalls: [],
      },
    ] satisfies Message[];
    const seen = installFetch(okSse);
    expectLocalRefusal(await captureGenerate('gemini-4-argon', history), 'model_prefill', ['media']);
    expect(seen).toHaveLength(0);
    expect(history[1]?.content[0]).toMatchObject({ type: 'image_url' });
  });
});

function expectLocalRefusal(error: unknown, tail: string, kinds: readonly string[]): void {
  expect(error).toBeInstanceOf(ChatProviderError);
  expect(error).not.toBeInstanceOf(APIStatusError);
  const providerError = error as ChatProviderError;
  expect(providerError.message.startsWith('Native Gemini request refused locally')).toBe(true);
  expect(providerError.message).toContain(SENTENCE);
  expect(providerError.message.startsWith('GoogleGenAI error:')).toBe(false);
  expect(providerError.details).toMatchObject({
    google_content_tail: tail,
    tail_role: 'model',
    tail_part_kinds: kinds,
  });
  expect(typeof providerError.details?.['content_count']).toBe('number');
  expect(isRecoverableRequestStructureError(error)).toBe(false);
  expect(isRetryableGenerateError(error)).toBe(false);
}

async function captureGenerate(model: string, history: Message[]): Promise<unknown> {
  try {
    await drainGenerate(model, history);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function drainGenerate(model: string, history: Message[]): Promise<void> {
  const provider = new GoogleGenAIChatProvider({ model, apiKey: KEY, stream: true });
  const stream = await provider.generate('system instructions', [], history, { auth: { apiKey: KEY } });
  for await (const part of stream) void part;
}

function installFetch(response: () => Response): SeenRequest[] {
  const seen: SeenRequest[] = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = await readBody(input, init);
    seen.push({ url, body });
    return response();
  });
  return seen;
}

async function readBody(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<string | undefined> {
  if (input instanceof Request) return input.clone().text();
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return undefined;
}

function okSse(): Response {
  const body = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function modelTurn400(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 400,
        message: SENTENCE,
        status: 'INVALID_ARGUMENT',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function contentsOf(request: SeenRequest): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(request.body ?? '');
  const contents = (parsed as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) throw new Error('fetch body has no contents array');
  return contents.filter((content): content is Record<string, unknown> => typeof content === 'object' && content !== null);
}

function partsOf(content: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const parts = content?.['parts'];
  if (!Array.isArray(parts)) return [];
  return parts.filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null);
}

function lastRole(request: SeenRequest): unknown {
  return contentsOf(request).at(-1)?.['role'];
}

function functionName(part: Record<string, unknown>, key: 'functionCall' | 'functionResponse'): string | undefined {
  const value = part[key];
  if (typeof value !== 'object' || value === null) return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function responseOf(part: Record<string, unknown>): { name: string | undefined; output: unknown } {
  const value = part['functionResponse'];
  const response = typeof value === 'object' && value !== null ? (value as { name?: unknown; response?: { output?: unknown } }) : undefined;
  return { name: typeof response?.name === 'string' ? response.name : undefined, output: response?.response?.output };
}

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantThink(think: string, encrypted: string): Message {
  return { role: 'assistant', content: [{ type: 'think', think, encrypted }], toolCalls: [] };
}

function call(id: string, name: string, signature: string): Message['toolCalls'][number] {
  return { type: 'function', id, name, arguments: '{}', extras: { thought_signature_b64: signature } };
}

function tool(toolCallId: string, text: string): Message {
  return { role: 'tool', toolCallId, content: [{ type: 'text', text }], toolCalls: [] };
}

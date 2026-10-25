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
  it('refuses a signed think-only tail on gemini-4', async () => {
    const history = [user('Hi'), assistantThink('earlier reasoning', THINK_SIGNATURE)];
    const seen = installFetch(okSse);
    expectLocalRefusal(
      await captureGenerate('gemini-4-argon', history),
      'model_prefill',
      ['thought_signature', 'thought', 'thought_text'],
    );
    expect(seen).toHaveLength(0);
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

  it('keeps parallel function responses together and puts later user text in a new turn', async () => {
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'plan', encrypted: THINK_SIGNATURE }],
        toolCalls: [
          call('alpha_1', 'alpha', CALL_SIGNATURE),
          unsignedCall('beta_1', 'beta'),
        ],
      },
      tool('beta_1', 'b-out'),
      tool('alpha_1', 'a-out'),
      user('Thanks'),
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(1);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user', 'model', 'user', 'user']);
    expect(partKinds(contents[2])).toEqual(['function_response', 'function_response']);
    expect(partsOf(contents[2]).map((part) => responseOf(part))).toEqual([
      { name: 'alpha', output: 'a-out' },
      { name: 'beta', output: 'b-out' },
    ]);
    expect(partKinds(contents[3])).toEqual(['text']);
    expect(mixedUserContents(contents)).toEqual([]);
    const calls = partsOf(contents[1]);
    expect(calls[1]?.['thoughtSignature']).toBe(CALL_SIGNATURE);
    expect(calls[2]?.['thoughtSignature']).toBeUndefined();
    expect(history.at(-1)).toEqual(user('Thanks'));
  });

  it('does not merge a user note that arrives before a function response', async () => {
    const history = [
      user('Hi'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [call('alpha_1', 'alpha', CALL_SIGNATURE)],
      },
      user('note'),
      tool('alpha_1', 'a-out'),
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user', 'model', 'user', 'user']);
    expect(partKinds(contents[2])).toEqual(['text']);
    expect(partKinds(contents[3])).toEqual(['function_response']);
    expect(mixedUserContents(contents)).toEqual([]);
    expect(partsOf(contents[1])[0]?.['thoughtSignature']).toBe(CALL_SIGNATURE);
    expect(history[2]).toEqual(user('note'));
  });

  it('keeps sequential function responses separate from each other and from the next user text', async () => {
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [call('alpha_1', 'alpha', CALL_SIGNATURE)],
      },
      tool('alpha_1', 'a-out'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [call('beta_1', 'beta', SECOND_CALL_SIGNATURE)],
      },
      tool('beta_1', 'b-out'),
      user('Thanks'),
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user', 'model', 'user', 'model', 'user', 'user']);
    expect(partKinds(contents[2])).toEqual(['function_response']);
    expect(partKinds(contents[4])).toEqual(['function_response']);
    expect(partKinds(contents[5])).toEqual(['text']);
    expect(partsOf(contents[1])[0]?.['thoughtSignature']).toBe(CALL_SIGNATURE);
    expect(partsOf(contents[3])[0]?.['thoughtSignature']).toBe(SECOND_CALL_SIGNATURE);
    expect(mixedUserContents(contents)).toEqual([]);
  });

  it('places three parallel tool images inside their function responses', async () => {
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          call('ReadMediaFile_a', 'ReadMediaFile', CALL_SIGNATURE),
          unsignedCall('ReadMediaFile_b', 'ReadMediaFile'),
          unsignedCall('ReadMediaFile_c', 'ReadMediaFile'),
        ],
      },
      readMediaResult('ReadMediaFile_c', 'fig-c.png', 'tradeoff'),
      readMediaResult('ReadMediaFile_a', 'fig-a.png', 'simple'),
      readMediaResult('ReadMediaFile_b', 'fig-b.png', 'path'),
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(1);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user', 'model', 'user']);
    expect(partKinds(contents[2])).toEqual(['function_response', 'function_response', 'function_response']);
    expect(partsOf(contents[2]).some((part) => part['inlineData'] !== undefined || part['text'] !== undefined)).toBe(false);
    expect(partsOf(contents[2]).map((part) => responseMedia(part))).toEqual([
      {
        name: 'ReadMediaFile',
        output: '<image path="fig-a.png"></image>Read image file.',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'simple' } }],
      },
      {
        name: 'ReadMediaFile',
        output: '<image path="fig-b.png"></image>Read image file.',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'path' } }],
      },
      {
        name: 'ReadMediaFile',
        output: '<image path="fig-c.png"></image>Read image file.',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'tradeoff' } }],
      },
    ]);
    const calls = partsOf(contents[1]);
    expect(calls[0]?.['thoughtSignature']).toBe(CALL_SIGNATURE);
    expect(calls[1]?.['thoughtSignature']).toBeUndefined();
    expect(calls[2]?.['thoughtSignature']).toBeUndefined();
    expect(mixedUserContents(contents)).toEqual([]);
    expect(history[2]?.content[1]).toMatchObject({ type: 'image_url' });
  });

  it('nests one gemini-4 tool image and its note text inside the function response', async () => {
    const image = readMediaResult('ReadMediaFile_a', 'fig-a.png', 'simple');
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [call('ReadMediaFile_a', 'ReadMediaFile', CALL_SIGNATURE)],
      },
      {
        ...image,
        content: [...image.content, { type: 'text' as const, text: 'note-fixture' }],
      },
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    expect(seen).toHaveLength(1);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user', 'model', 'user']);
    expect(partKinds(contents[2])).toEqual(['function_response']);
    expect(partsOf(contents[2]).some((part) => part['inlineData'] !== undefined || part['text'] !== undefined)).toBe(false);
    expect(responseMedia(partsOf(contents[2])[0]!)).toEqual({
      name: 'ReadMediaFile',
      output: '<image path="fig-a.png"></image>Read image file.note-fixture',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'simple' } }],
    });
    const response = partsOf(contents[2])[0]?.['functionResponse'] as { id?: unknown; parts?: Array<{ inlineData?: { displayName?: unknown } }> };
    expect(response.id).toBeUndefined();
    expect(response.parts?.[0]?.inlineData?.displayName).toBeUndefined();
    expect(partsOf(contents[1])[0]?.['thoughtSignature']).toBe(CALL_SIGNATURE);
    expect(mixedUserContents(contents)).toEqual([]);
    expect(history[2]?.content[1]).toMatchObject({ type: 'image_url' });
  });

  it('keeps gemini-2.5 tool images beside the function response', async () => {
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [call('ReadMediaFile_a', 'ReadMediaFile', CALL_SIGNATURE)],
      },
      readMediaResult('ReadMediaFile_a', 'fig-a.png', 'simple'),
      user('Continue in text.'),
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-2.5-flash', history);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user', 'model', 'user', 'user']);
    expect(partKinds(contents[2])).toEqual(['function_response', 'media']);
    expect(responseMedia(partsOf(contents[2])[0]!).parts).toEqual([]);
    expect(partsOf(contents[2])[1]).toMatchObject({ inlineData: { mimeType: 'image/png', data: 'simple' } });
    expect(partKinds(contents[3])).toEqual(['text']);
    expect(mixedUserContents(contents)).toEqual([]);
    vi.unstubAllGlobals();
    const nested = installFetch(okSse);
    await drainGenerate('gemini-3-flash-preview', history);
    const nestedContents = contentsOf(nested[0]!);
    expect(partKinds(nestedContents[2])).toEqual(['function_response']);
    expect(responseMedia(partsOf(nestedContents[2])[0]!).parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'simple' } },
    ]);
    expect(partKinds(nestedContents[3])).toEqual(['text']);
  });

  it('keeps CONTINUATION off the STOP completion reason', async () => {
    installFetch(() => new Response(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]},"finishReason":"CONTINUATION"}]}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    const provider = new GoogleGenAIChatProvider({ model: 'gemini-4-argon', apiKey: KEY, stream: true });
    const stream = await provider.generate('system', [], [user('Hi')], { auth: { apiKey: KEY } });
    for await (const part of stream) void part;
    expect(stream.finishReason).toBe('other');
    expect(stream.rawFinishReason).toBe('CONTINUATION');
  });

  it('uses the SDK continuation token with the same request and accumulates the response', async () => {
    const seen = installFetchSequence([
      () => responseSse({
        candidates: [{
          content: { role: 'model', parts: [{ thought: true, text: 'partial thought', thoughtSignature: THINK_SIGNATURE }] },
          finishReason: 'CONTINUATION',
          continuationToken: 'token-fixture',
        }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      }),
      () => responseSse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'final answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
      }),
    ]);
    const provider = new GoogleGenAIChatProvider({ model: 'gemini-4-argon', apiKey: KEY, stream: true });
    const stream = await provider.generate(
      'system instructions',
      [{ name: 'fixture', description: 'fixture tool', parameters: { type: 'object' } }],
      [user('Hi')],
      { auth: { apiKey: KEY }, maxCompletionTokens: 7 },
    );
    const parts = [];
    for await (const part of stream) parts.push(part);

    expect(seen).toHaveLength(2);
    const first = JSON.parse(seen[0]!.body ?? '') as Record<string, unknown>;
    const second = JSON.parse(seen[1]!.body ?? '') as Record<string, unknown>;
    expect(second['contents']).toEqual(first['contents']);
    expect(second['systemInstruction']).toEqual(first['systemInstruction']);
    expect(second['tools']).toEqual(first['tools']);
    expect(second['generationConfig']).toEqual(first['generationConfig']);
    expect(second['continuationToken']).toBe('token-fixture');
    expect((first['generationConfig'] as Record<string, unknown>)['maxOutputTokens']).toBe(7);
    expect(parts).toEqual([
      { type: 'think', think: 'partial thought', encrypted: THINK_SIGNATURE },
      { type: 'text', text: 'final answer' },
    ]);
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('STOP');
    expect(stream.usage).toMatchObject({ inputOther: 8, output: 5 });
  });

  it('does not continue MAX_TOKENS or change the explicit output budget', async () => {
    const seen = installFetch(() => responseSse({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'bounded' }] },
        finishReason: 'MAX_TOKENS',
        continuationToken: 'token-ignore',
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 7 },
    }));
    const provider = new GoogleGenAIChatProvider({ model: 'gemini-4-argon', apiKey: KEY, stream: true });
    const stream = await provider.generate('system', [], [user('Hi')], {
      auth: { apiKey: KEY },
      maxCompletionTokens: 7,
    });
    for await (const part of stream) void part;
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.body ?? '') as Record<string, unknown>;
    expect((body['generationConfig'] as Record<string, unknown>)['maxOutputTokens']).toBe(7);
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('MAX_TOKENS');
  });

  it('keeps an ordinary user continuation as the last turn after parallel tool images', async () => {
    const imageTail = [
      user('go'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          call('ReadMediaFile_a', 'ReadMediaFile', CALL_SIGNATURE),
          unsignedCall('ReadMediaFile_b', 'ReadMediaFile'),
          unsignedCall('ReadMediaFile_c', 'ReadMediaFile'),
        ],
      },
      readMediaResult('ReadMediaFile_c', 'fig-c.png', 'tradeoff'),
      readMediaResult('ReadMediaFile_a', 'fig-a.png', 'simple'),
      readMediaResult('ReadMediaFile_b', 'fig-b.png', 'path'),
    ] satisfies Message[];
    const continued = [...imageTail, user('Continue in text.')];
    const imageSeen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', imageTail);
    vi.unstubAllGlobals();
    const continuedSeen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', continued);
    const imageContents = contentsOf(imageSeen[0]!);
    const continuedContents = contentsOf(continuedSeen[0]!);
    expect(imageContents.map((content) => content['role'])).toEqual(['user', 'model', 'user']);
    expect(partKinds(imageContents[2])).toEqual(['function_response', 'function_response', 'function_response']);
    expect(continuedContents.map((content) => content['role'])).toEqual(['user', 'model', 'user', 'user']);
    expect(partsOf(continuedContents[2]).map((part) => responseMedia(part))).toEqual(
      partsOf(imageContents[2]).map((part) => responseMedia(part)),
    );
    expect(partKinds(continuedContents[3])).toEqual(['text']);
    expect(partsOf(continuedContents[3])).toEqual([{ text: 'Continue in text.' }]);
    expect(mixedUserContents(imageContents)).toEqual([]);
    expect(mixedUserContents(continuedContents)).toEqual([]);
    expect(continued.at(-1)).toEqual(user('Continue in text.'));
    expect(continued[2]?.content[1]).toEqual(imageTail[2]?.content[1]);
  });

  it('does not fold tool media into the following user text', async () => {
    const history = [
      user('go'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [call('alpha_1', 'alpha', CALL_SIGNATURE)],
      },
      toolWithImage('alpha_1', 'a-out'),
      user('Thanks'),
    ] satisfies Message[];
    const seen = installFetch(okSse);
    await drainGenerate('gemini-4-argon', history);
    const contents = contentsOf(seen[0]!);
    expect(contents.map((content) => content['role'])).toEqual(['user', 'model', 'user', 'user']);
    expect(partKinds(contents[2])).toEqual(['function_response']);
    expect(responseMedia(partsOf(contents[2])[0]!)).toEqual({
      name: 'alpha',
      output: 'a-out',
      parts: [{ fileData: { fileUri: 'https://example.test/a.png', mimeType: 'image/png' } }],
    });
    expect(partKinds(contents[3])).toEqual(['text']);
    expect(mixedUserContents(contents)).toEqual([]);
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

  it('refuses a signature-only think tail on gemini-4', async () => {
    const history = [user('Hi'), assistantThink('', THINK_SIGNATURE)];
    const seen = installFetch(okSse);
    expectLocalRefusal(
      await captureGenerate('gemini-4-argon', history),
      'model_prefill',
      ['thought_signature', 'thought'],
    );
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

function installFetchSequence(responses: readonly (() => Response)[]): SeenRequest[] {
  let index = 0;
  return installFetch(() => {
    const response = responses[index++];
    if (response === undefined) throw new Error(`unexpected fetch call ${index}`);
    return response();
  });
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

function responseSse(payload: Record<string, unknown>): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
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

function signaturesOfRequest(request: SeenRequest): string[] {
  const signatures: string[] = [];
  for (const content of contentsOf(request)) {
    for (const part of partsOf(content)) {
      const signature = part['thoughtSignature'];
      if (typeof signature === 'string') signatures.push(signature);
    }
  }
  return signatures;
}

function lastRole(request: SeenRequest): unknown {
  return contentsOf(request).at(-1)?.['role'];
}

function partKinds(content: Record<string, unknown> | undefined): string[] {
  const kinds: string[] = [];
  for (const part of partsOf(content)) {
    if (part['functionCall'] !== undefined) kinds.push('function_call');
    else if (part['functionResponse'] !== undefined) kinds.push('function_response');
    else if (part['fileData'] !== undefined || part['inlineData'] !== undefined) kinds.push('media');
    else if (part['thought'] === true) kinds.push('thought');
    else if (typeof part['text'] === 'string' && part['text'].trim().length > 0) kinds.push('text');
  }
  return kinds;
}

function mixedUserContents(contents: ReadonlyArray<Record<string, unknown>>): number[] {
  const mixed: number[] = [];
  contents.forEach((content, index) => {
    if (content['role'] !== 'user') return;
    const kinds = partKinds(content);
    if (kinds.includes('function_response') && kinds.includes('text')) mixed.push(index);
  });
  return mixed;
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

function unsignedCall(id: string, name: string): Message['toolCalls'][number] {
  return { type: 'function', id, name, arguments: '{}' };
}

function tool(toolCallId: string, text: string): Message {
  return { role: 'tool', toolCallId, content: [{ type: 'text', text }], toolCalls: [] };
}

function responseMedia(part: Record<string, unknown>): {
  name: string | undefined;
  output: unknown;
  parts: unknown;
} {
  const value = part['functionResponse'];
  const response = typeof value === 'object' && value !== null
    ? value as { name?: unknown; response?: { output?: unknown }; parts?: unknown }
    : undefined;
  return {
    name: typeof response?.name === 'string' ? response.name : undefined,
    output: response?.response?.output,
    parts: response?.parts,
  };
}

function readMediaResult(toolCallId: string, fileName: string, payload: string): Message {
  return {
    role: 'tool',
    toolCallId,
    content: [
      { type: 'text', text: `<image path="${fileName}">` },
      { type: 'image_url', imageUrl: { url: `data:image/png;base64,${payload}` } },
      { type: 'text', text: '</image>' },
      { type: 'text', text: 'Read image file.' },
    ],
    toolCalls: [],
  };
}

function toolWithImage(toolCallId: string, text: string): Message {
  return {
    role: 'tool',
    toolCallId,
    content: [
      { type: 'text', text },
      { type: 'image_url', imageUrl: { url: 'https://example.test/a.png' } },
    ],
    toolCalls: [],
  };
}

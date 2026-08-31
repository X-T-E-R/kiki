import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient, CodexClientError, CodexRemoteError } from '../src/index';
import { NodeProcessService } from './nodeProcessService';

const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));

function client(mode = 'standard', options: ConstructorParameters<typeof CodexAppServerClient>[2] = {}) {
  return new CodexAppServerClient(
    new NodeProcessService(),
    {
      id: 'fixture',
      command: process.execPath,
      commandArgsPrefix: [fixture, mode],
      startupTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownGraceMs: 1_000,
    },
    options,
  );
}

async function thoughtTexts(mode: string): Promise<readonly string[]> {
  const app = client(mode);
  await app.connect();
  const thread = await app.startThread({ model: 'gpt-test' });
  const handle = await app.startTurn(
    { threadId: thread.thread.id, input: [] },
    new AbortController().signal,
  );
  const texts: string[] = [];
  for await (const event of handle.events) {
    if (event.type === 'thought.delta' && event.content.type === 'text') {
      texts.push(event.content.text);
    }
  }
  await handle.completion;
  await app.shutdown();
  return texts;
}

describe('CodexAppServerClient process integration', () => {
  it('handshakes, lists models, streams a turn, and retains usage', async () => {
    const frames: string[] = [];
    const app = client('standard', { onFrame: (frame) => frames.push(frame.raw) });
    await app.connect();
    expect(await app.listModels()).toMatchObject({ data: [{ id: 'gpt-test' }] });
    const thread = await app.startThread({ model: 'gpt-test' });
    const handle = await app.startTurn({
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'hello' }],
    }, new AbortController().signal);
    const events = [];
    for await (const event of handle.events) events.push(event);
    await expect(handle.completion).resolves.toMatchObject({
      status: 'completed',
      usage: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 1, contextWindow: 100 },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message.delta' }),
      expect.objectContaining({ type: 'usage' }),
    ]));
    expect(frames.some((frame) => frame.includes('"jsonrpc"'))).toBe(false);
    await app.shutdown();
  }, 15_000);

  it('round-trips the exact approval decision', async () => {
    const handler = vi.fn(async (request, responder) => {
      expect(request.params['availableDecisions']).toContain('accept');
      await responder.respond({ decision: 'accept' });
    });
    const app = client('approval', { onServerRequest: handler });
    await app.connect();
    const thread = await app.startThread({ model: 'gpt-test' });
    const handle = await app.startTurn({ threadId: thread.thread.id, input: [] }, new AbortController().signal);
    for await (const _event of handle.events) {}
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
    expect(handler).toHaveBeenCalledOnce();
    await app.shutdown();
  }, 15_000);

  it('uses completed reasoning summaries only when no summary delta was streamed', async () => {
    await expect(thoughtTexts('reasoning-stream')).resolves.toEqual(['summary', 'raw']);
    await expect(thoughtTexts('reasoning-completed')).resolves.toEqual(['summary']);
    await expect(thoughtTexts('reasoning-raw')).resolves.toEqual(['raw', 'summary']);
  }, 15_000);

  it('deduplicates completed summaries independently for each reasoning item', async () => {
    const app = client('reasoning-multiple');
    await app.connect();
    const thread = await app.startThread({ model: 'gpt-test' });
    const handle = await app.startTurn(
      { threadId: thread.thread.id, input: [] },
      new AbortController().signal,
    );
    const thoughts: Array<{ readonly messageId: string | undefined; readonly text: string }> = [];
    for await (const event of handle.events) {
      if (event.type === 'thought.delta' && event.content.type === 'text') {
        thoughts.push({ messageId: event.messageId, text: event.content.text });
      }
    }
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
    expect(thoughts).toEqual([
      { messageId: 'reasoning-1', text: 'first summary' },
      { messageId: 'reasoning-2', text: 'second summary' },
    ]);
    await app.shutdown();
  }, 15_000);

  it('exposes protocol resume errors without classifying transport exits as protocol errors', async () => {
    const protocol = client('resume-protocol-error');
    await protocol.connect();
    await expect(protocol.resumeThread({ threadId: 'missing' })).rejects.toBeInstanceOf(CodexRemoteError);
    await protocol.shutdown();

    const transport = client('resume-crash');
    await transport.connect();
    await expect(transport.resumeThread({ threadId: 'missing' })).rejects.toMatchObject({
      code: 'closed',
    });
    await transport.shutdown();
  }, 15_000);

  it('interrupts a hanging turn and fails closed on malformed JSONL', async () => {
    const hanging = client('hang-turn');
    await hanging.connect();
    const thread = await hanging.startThread({ model: 'gpt-test' });
    const controller = new AbortController();
    const pending = hanging.startTurn({ threadId: thread.thread.id, input: [] }, controller.signal);
    void pending.catch(() => undefined);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CodexClientError);
    await hanging.shutdown();

    const malformed = client('malformed');
    await malformed.connect();
    const malformedThread = await malformed.startThread({ model: 'gpt-test' });
    await expect(malformed.startTurn({ threadId: malformedThread.thread.id, input: [] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'protocol' });
    await malformed.shutdown();
  }, 15_000);
});

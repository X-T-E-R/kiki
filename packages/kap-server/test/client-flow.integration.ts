import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IAgentExecutionService, IAgentLifecycleService, IAgentTaskService, IFileService, getLiveSessionById } from '@kiki/agent-core-v2';
import { SessionController } from '../../session-core/src/session/sessionController';
import { applyTranscriptShell, projectAgentTranscriptView } from '../../session-core/src/session/transcript/project';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface ModelRequest {
  model: string;
  messages: { role: string; content: unknown }[];
}

describe('GUI shared client against an isolated KAP host', () => {
  let host: RunningServer;
  let client: KikiClient;
  let home: string;
  let endpoint: string;
  let hold = false;
  const held = new Set<ServerResponse>();
  const requests: ModelRequest[] = [];
  const responseFacts: (() => unknown)[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest);
      if (hold) {
        held.add(response);
        response.once('close', () => held.delete(response));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        id: 'local-response',
        choices: [{ index: 0, delta: { content: 'local model completed' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      })}\n\ndata: [DONE]\n\n`);
    })();
  });

  beforeEach(async () => {
    requests.length = 0;
    hold = false;
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('missing provider address');
    home = await mkdtemp(join(tmpdir(), 'kiki-client-flow-'));
    await mkdir(join(home, 'workspace'));
    await writeFile(join(home, 'config.toml'), [
      'default_model = "unavailable"',
      '[providers.local]', 'type = "openai"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`, 'api_key = "test-only"',
      '[providers."managed:kimi-code"]', 'type = "kimi"',
      '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
      '[models.unavailable]', 'provider = "managed:kimi-code"', 'model = "unavailable"', 'max_context_size = 100000',
      ...['first', 'second'].flatMap((model) => [
        `[models.${model}]`, 'provider = "local"', `model = "${model}"`,
        'max_context_size = 100000', 'capabilities = ["image_in"]',
      ]),
      '',
    ].join('\n'));
    host = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, instancesDir: join(home, 'instances'), host: '127.0.0.1', port: 0, logLevel: 'silent' });
    responseFacts.length = 0;
    host.app.server.on('request', (request, response) => {
      const socket = request.socket;
      responseFacts.push(() => ({
        url: request.url, method: request.method, complete: request.complete,
        ended: response.writableEnded, finished: response.writableFinished,
        responseDestroyed: response.destroyed, socketDestroyed: socket.destroyed,
        localPort: socket.localPort, remotePort: socket.remotePort,
      }));
    });
    endpoint = `http://127.0.0.1:${host.port}`;
    client = new KikiClient({ baseUrl: endpoint, token: host.authTokenService.getToken() });
  });

  afterEach(async () => {
    await client?.klient.close();
    for (const response of held) response.destroy();
    held.clear();
    provider.closeAllConnections();
    const initialResponses = responseFacts.map((read) => read());
    const serverClose = vi.spyOn(host.app.server, 'close');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = host.close();
    const naturallyClosed = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    try {
      if (!naturallyClosed) {
        throw new Error(`Host did not close naturally within 2000ms: ${JSON.stringify({ initialResponses, serverCloseCalled: serverClose.mock.calls.length, responses: responseFacts.map((read) => read()) })}`);
      }
    } finally {
      if (!naturallyClosed) host.app.server.closeAllConnections();
      await closing;
      serverClose.mockRestore();
      await new Promise<void>((resolve, reject) => provider.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
      if (home) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  async function session(): Promise<string> {
    return (await client.createSession({
      metadata: { cwd: join(home, 'workspace') },
      agent_config: { permission_mode: 'manual' },
    })).id;
  }

  async function settled(id: string, count: number): Promise<void> {
    await vi.waitFor(() => expect(requests).toHaveLength(count), { timeout: 10000 });
    await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10000 });
  }

  it.each(['EOF', 'remaining bytes'] as const)('waits for media %s then naturally releases its newly idle connection during close', async (waitFor) => {
    const id = await session();
    const bytes = new Uint8Array([65, 66, 67]);
    const uploaded = await client.uploadFile(new File([bytes], 'delayed.bin'));
    const files = host.core.accessor.get(IFileService);
    const stored = await files.get(uploaded.id);
    let releaseEof!: () => void;
    const eof = new Promise<void>((resolve) => { releaseEof = resolve; });
    let released = false;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const read = vi.spyOn(files, 'get').mockResolvedValueOnce({
      ...stored,
      stream: () => Readable.from((async function* () {
        try {
          yield waitFor === 'EOF' ? bytes : bytes.slice(0, 1);
          notifyStarted();
          await eof;
          if (waitFor === 'remaining bytes') yield bytes.slice(1);
        } finally {
          released = true;
        }
      })()),
    });
    let closing: Promise<void> | undefined;
    let naturallyClosed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const downloading = client.readSessionMediaBytes(id, uploaded.id);
    try {
      await started;
      if (waitFor === 'EOF') expect((await downloading).bytes).toEqual(bytes);
      expect(released).toBe(false);
      closing = host.close().then(() => { naturallyClosed = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(naturallyClosed).toBe(false);
      releaseEof();
      expect((await downloading).bytes).toEqual(bytes);
      await Promise.race([
        closing,
        new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 2000); }),
      ]);
      expect(released).toBe(true);
      expect(naturallyClosed).toBe(true);
    } finally {
      releaseEof();
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      if (closing !== undefined && !naturallyClosed) host.app.server.closeAllConnections();
      await closing;
      read.mockRestore();
    }
  });

  it('naturally closes immediately after three completed media downloads', async () => {
    const id = await session();
    const bytes = new Uint8Array(600 * 1024).fill(65);
    const uploaded = await Promise.all([0, 1, 2].map((index) => client.uploadFile(new File([bytes], `attachment-${index}.bin`))));
    for (const file of uploaded) {
      const downloaded = await client.readSessionMediaBytes(id, file.id);
      expect(downloaded.bytes).toEqual(bytes);
    }
  });

  it('keeps the composer binding after reopening and restarting a bound session with a credentialless server default', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'persist this binding' }] });
    await settled(id, 1);
    await client.klient.close();
    await host.close();
    host = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, instancesDir: join(home, 'instances'), host: '127.0.0.1', port: 0, logLevel: 'silent' });
    endpoint = `http://127.0.0.1:${host.port}`;
    client = new KikiClient({ baseUrl: endpoint, token: host.authTokenService.getToken() });
    for (const reopen of [0, 1]) {
      const actual = client.klient.session(id).view;
      const shell = await actual.snapshot();
      expect(shell.session.agent_config.model).toBe('first');
      let ready = false;
      let projected = applyTranscriptShell(id, shell);
      let resets = 0;
      const subscription = actual.subscribe({ sessionCursor: { seq: shell.as_of_seq, epoch: shell.epoch }, transcriptGrades: { main: 'delta' } }, (signal) => {
        if (signal.type === 'transcript' && signal.event.type === 'transcript.reset' && signal.event.agent_id === 'main') {
          projected = projectAgentTranscriptView(projected, 'main', signal.event.snapshot);
          resets += 1;
        }
        if (signal.type === 'ready') ready = true;
      });
      try {
        await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10000 });
        expect(resets).toBeGreaterThan(0);
        expect(projected.model, `reopen ${reopen}`).toBe('first');
        await client.submitPrompt(id, { content: [{ type: 'text', text: `GUI continuation ${reopen}` }], model: projected.model ?? 'unavailable' });
        await settled(id, reopen + 2);
        expect(requests[reopen + 1]?.model).toBe('first');
      } finally {
        subscription.close();
      }
    }
  }, 40000);

  it.each(['live', 'cold'] as const)('publishes child prompt restarts and terminal states through the %s GUI view', async (mode) => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'establish parent' }] });
    await settled(id, 1);
    const live = getLiveSessionById(host.core.accessor, id)!;
    const child = await live.accessor.get(IAgentLifecycleService).create({
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'agent', model: 'first' },
    });
    await client.sendAgentMessage(id, child.id, 'initial child prompt');
    await child.accessor.get(IAgentExecutionService).settled();
    if (mode === 'cold') {
      await client.klient.close();
      await host.close();
      host = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, instancesDir: join(home, 'instances'), host: '127.0.0.1', port: 0, logLevel: 'silent' });
      endpoint = `http://127.0.0.1:${host.port}`;
      client = new KikiClient({ baseUrl: endpoint, token: host.authTokenService.getToken() });
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
      const response = await fetch(`${endpoint}/api/sessions/${id}/transcript?agent_id=main`, {
        headers: { authorization: `Bearer ${host.authTokenService.getToken()}` },
      });
      const cold = await response.json() as { code: number; data: { tasks: { agentId?: string; state: string }[] } };
      expect(cold.code).toBe(0);
      expect(cold.data.tasks.find((task) => task.agentId === child.id)?.state).toBe('completed');
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    }
    const controller = new SessionController(client.sessions, client.sessionView(id), id);
    const mainChanges = vi.fn();
    const childChanges = vi.fn();
    const offMain = controller.subscribe(mainChanges);
    const offChild = controller.subscribeAgent(child.id, childChanges);
    try {
      await controller.open();
      await vi.waitFor(() => {
        controller.flushFrames();
        expect(controller.getForest()?.byId[child.id]?.status).toBe('completed');
      });
      for (const ending of ['completed', 'failed', 'cancelled'] as const) {
        hold = true;
        mainChanges.mockClear();
        childChanges.mockClear();
        const beforeRequests = requests.length;
        await client.sendAgentMessage(id, child.id, `follow-up ${ending}`);
        await vi.waitFor(() => expect(requests).toHaveLength(beforeRequests + 1), { timeout: 10000 });
        await vi.waitFor(() => {
          controller.flushFrames();
          expect(controller.getForest()?.byId[child.id]?.status).toBe('background');
          expect(controller.getState().tasks.some((task) => task.agent_id === child.id && task.status === 'running')).toBe(true);
          expect(controller.getAgentState(child.id).busy).toBe(true);
        });
        expect(mainChanges).toHaveBeenCalled();
        expect(childChanges).toHaveBeenCalled();
        if (ending === 'cancelled') {
          const current = getLiveSessionById(host.core.accessor, id)!;
          const tasks = current.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentTaskService);
          const task = tasks.list(true).find((task) => task.kind === 'agent' && task.agentId === child.id)!;
          expect(task.taskId).not.toBe(child.id);
          await client.klient.session(id).agent('main').stopTask({ taskId: task.taskId });
        } else {
          for (const response of held) {
            if (ending === 'failed') {
              response.writeHead(400, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ error: { message: 'Synthetic provider failure', type: 'invalid_request_error' } }));
            } else {
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'follow-up complete' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
            }
          }
          held.clear();
        }
        await vi.waitFor(() => {
          controller.flushFrames();
          expect(controller.getForest()?.byId[child.id]?.status).toBe(ending);
          expect(controller.getAgentState(child.id).busy).toBe(false);
        }, { timeout: 10000 });
      }
    } finally {
      offMain();
      offChild();
      controller.close();
    }
  }, 40000);

  it('sends, switches model, rejects an unauthenticated override without rebinding, and cancels', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'first turn' }] });
    await settled(id, 1);
    expect(requests[0]?.model).toBe('first');
    await client.submitPrompt(id, { model: 'second', content: [{ type: 'text', text: 'switch model' }] });
    await settled(id, 2);
    expect(requests[1]?.model).toBe('second');
    await expect(client.submitPrompt(id, { model: 'unavailable', content: [{ type: 'text', text: 'must reject' }] })).rejects.toMatchObject({ code: 40111 });
    await client.submitPrompt(id, { content: [{ type: 'text', text: 'keep the bound model' }] });
    await settled(id, 3);
    expect(requests[2]?.model).toBe('second');
    expect(JSON.stringify(requests[2])).not.toContain('must reject');
    hold = true;
    const pending = await client.submitPrompt(id, { content: [{ type: 'text', text: 'cancel this turn' }] });
    await vi.waitFor(() => expect(requests).toHaveLength(4), { timeout: 10000 });
    await client.abortPrompt(id, pending.prompt_id);
    await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10000 });
    for (const path of ['/api/v1/healthz', '/api/v2/sessions', '/api/v1/sessions']) {
      const response = await fetch(endpoint + path, { headers: { authorization: `Bearer ${host.authTokenService.getToken()}` } });
      expect(response.status, path).toBe(404);
      await response.arrayBuffer();
    }
  }, 40000);

  it('recovers ordered transcript delivery after the actual event socket is severed', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'before disconnect' }] });
    await settled(id, 1);
    const sockets = new Set<import('node:stream').Duplex>();
    host.app.server.on('upgrade', (_request, socket) => sockets.add(socket));
    const signals: import('@kiki/klient').SessionViewSignal[] = [];
    const view = client.klient.session(id).view.subscribe({ sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } }, (signal) => signals.push(signal));
    try {
      await vi.waitFor(() => expect(signals.some((signal) => signal.type === 'ready')).toBe(true), { timeout: 10000 });
      const initialGeneration = signals.find((signal) => signal.type === 'ready')!.generation;
      expect(sockets.size).toBe(1);
      for (const socket of sockets) socket.destroy();
      await vi.waitFor(() => expect(signals.some((signal) => signal.type === 'status' && signal.status === 'closed')).toBe(true));
      await client.submitPrompt(id, { content: [{ type: 'text', text: 'sent while the view reconnects' }] });
      await settled(id, 2);
      await vi.waitFor(() => expect(signals.some((signal) => signal.type === 'ready' && signal.reconnected && signal.generation > initialGeneration)).toBe(true), { timeout: 10000 });
      await vi.waitFor(() => expect(JSON.stringify(signals.filter((signal) => signal.type === 'transcript' && signal.generation > initialGeneration))).toContain('sent while the view reconnects'), { timeout: 10000 });
      expect(signals.filter((signal) => signal.type === 'protocolError')).toEqual([]);
      expect(sockets.size).toBe(2);
    } finally {
      view.close();
      for (const socket of sockets) socket.destroy();
    }
  }, 40000);

  it('accepts three uploaded and three inline images through the GUI adapter and downloads session media', async () => {
    const id = await session();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const image = Buffer.concat([png, Buffer.alloc(600 * 1024)]);
    const uploaded = await Promise.all([0, 1, 2].map((index) => client.uploadFile(new File([image], `image-${index}.png`, { type: 'image/png' }))));
    const submission = {
      model: 'first',
      content: uploaded.map((file) => ({ type: 'image' as const, source: { kind: 'file' as const, file_id: file.id } })),
    };
    expect(Buffer.byteLength(JSON.stringify(submission))).toBeLessThan(1024);
    await client.submitPrompt(id, submission);
    await settled(id, 1);
    const user = requests[0]?.messages.findLast((message) => message.role === 'user');
    expect(JSON.stringify(user).match(/data:image\/png;base64,/g)).toHaveLength(3);
    for (const file of uploaded) {
      const downloaded = await client.readSessionMediaBytes(id, file.id);
      expect(downloaded.mime, new TextDecoder().decode(downloaded.bytes.slice(0, 200))).toBe('image/png');
      expect(Buffer.from(downloaded.bytes)).toEqual(image);
    }
    const inline = {
      content: [0, 1, 2].map(() => ({
        type: 'image' as const,
        source: { kind: 'base64' as const, media_type: 'image/png', data: image.toString('base64') },
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeGreaterThan(2 * 1024 * 1024);
    await client.submitPrompt(id, inline);
    await settled(id, 2);
    const inlineUser = requests[1]?.messages.findLast((message) => message.role === 'user');
    expect(JSON.stringify(inlineUser).match(/data:image\/png;base64,/g)).toHaveLength(3);
    expect(requests[1]?.model).toBe('first');
    const failedStorage = vi.spyOn(host.core.accessor.get(IFileService), 'get')
      .mockRejectedValueOnce(new Error('synthetic media storage failure'));
    try {
      await expect(client.readSessionMediaBytes(id, 'missing-file')).rejects.toMatchObject({ code: 50001 });
    } finally {
      failedStorage.mockRestore();
    }
  }, 40000);

  it('rejects a request above the HTTP budget without enqueueing it or changing the selected model', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'establish model' }] });
    await settled(id, 1);
    const draft = { model: 'second', content: [{ type: 'text' as const, text: 'x'.repeat(12 * 1024 * 1024) }] };
    await expect(client.submitPrompt(id, draft)).rejects.toMatchObject({ code: 40001, message: expect.stringContaining('size limit') });
    expect(draft.content[0]?.text.length).toBe(12 * 1024 * 1024);
    expect(draft.model).toBe('second');
    await client.submitPrompt(id, { content: [{ type: 'text', text: 'retry with a small draft' }] });
    await settled(id, 2);
    expect(requests[1]?.model).toBe('first');
    expect(JSON.stringify(requests[1]).length).toBeLessThan(1024 * 1024);
  }, 40000);
});

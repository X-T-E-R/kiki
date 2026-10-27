import { chmod, mkdir, readFile, realpath } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { paddedPng, pngDimensions, solidPng } from './helpers/png';
import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IBootstrapService,
  IFileService,
  IModelCatalogMutationService,
  getLiveSessionById,
} from '@kiki/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';
import { type RunningServer } from '../src/start';
import { PROMPT_BODY_LIMIT_BYTES } from '../src/routes/prompts';
import { authHeaders } from './helpers/auth';
import {
  type Envelope,
  type PromptItemWire,
  type PromptContentPart,
  PROMPT_TOML,
  readFileEventually,
  sessionMediaDir,
  expectSessionMedia,
  writeConfigToml,
  avifBytes,
  heicBytes,
  attachedPathFrom,
  usePromptFixture,
} from './helpers/promptFixture';

vi.mock('../../../apps/kiki-gui/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../apps/kiki-gui/src/components/preview/DocumentTabView', () => ({ DocumentTabView: () => null }));

describe('server-v2 /api prompts', () => {
  const fixture = usePromptFixture();
  const { call, createSession, createMainAgent, uploadFile } = fixture;

  it('rejects a stale file reference without creating the agent or mutating the model', async () => {
    const id = await createSession(fixture.home as string, false);
    const session = getLiveSessionById(fixture.server!.core.accessor, id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'look' },
        { type: 'video', source: { kind: 'file', file_id: 'f_does_not_exist' } },
      ],
    });
    expect(body.code).toBe(40407);

    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('rejects a mis-kinded file reference without creating the agent', async () => {
    const id = await createSession(fixture.home as string, false);
    const session = getLiveSessionById(fixture.server!.core.accessor, id);

    const form = new FormData();
    form.set('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'spec.pdf');
    const uploadRes = await fetch(`${fixture.base}/api/files`, {
      method: 'POST',
      headers: authHeaders(fixture.server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'watch this' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(body.code).toBe(40001);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('carries an uploaded video into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const videoBytes = Buffer.from('tiny fake mp4 bytes');
    const form = new FormData();
    form.set('file', new Blob([videoBytes], { type: 'video/mp4' }), 'clip.mp4');
    const uploadRes = await fetch(`${fixture.base}/api/files`, {
      method: 'POST',
      headers: authHeaders(fixture.server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'what happens in this video?' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'what happens in this video?' });
    expect(content[1]).toEqual({
      type: 'video',
      source: { kind: 'session_media', file_id: uploaded.data.id },
      name: 'clip.mp4',
    });

    await expectSessionMedia(fixture.server!, id, `${uploaded.data.id}.mp4`, videoBytes);
  });

  it('carries a compressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);
    const uploaded = await uploadFile(bigPng, 'image/png', 'big.png');
    expect(uploaded.size).toBe(bigPng.length);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    const caption = content[0] as { type: string; text: string };
    expect(caption.type).toBe('text');
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('3600x1800');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!.replaceAll('\\', '/')).toContain('/media-originals/');
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1] as { type: string; source: { kind: string; file_id: string } };
    expect(image.type).toBe('image');
    expect(image.source.kind).toBe('session_media');
    const finalFileId = image.source.file_id;
    expect(finalFileId).not.toBe(uploaded.id);

    const mediaPath = join(sessionMediaDir(fixture.server!, id), `${finalFileId}.png`);
    expect(pngDimensions(await readFileEventually(mediaPath))).toEqual({ width: 2000, height: 1000 });
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    const original = await fixture.server!.core.accessor.get(IFileService).get(uploaded.id);
    expect(original.meta.size).toBe(bigPng.length);

    const files = fixture.server!.core.accessor.get(IFileService);
    await vi.waitFor(async () => {
      const result = await files.get(finalFileId).catch((error: unknown) => error);
      expect(result).toMatchObject({ code: 'file.not_found' });
    });

    expect(JSON.stringify(content)).not.toContain('kimi-file://');

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    const memory = main.accessor.get(IAgentContextMemoryService).get();
    const reminder = memory.find((m) => m.origin?.kind === 'injection');
    const reminderText = reminder?.content[0];
    expect(reminderText?.type).toBe('text');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('<system-reminder>');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('Image compressed');
  });

  it('rolls back a compressed upload when a later prompt part fails to resolve', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const first = await uploadFile(solidPng(3600, 1800), 'image/png', 'big.png');
    const second = await uploadFile(solidPng(10, 10), 'image/png', 'small.png');
    const files = fixture.server!.core.accessor.get(IFileService);
    const originalGet = files.get.bind(files);
    const originalSave = files.save.bind(files);
    let compressedFileId: string | undefined;
    let lateFailureInjected = false;
    const getSpy = vi.spyOn(files, 'get').mockImplementation(async (fileId) => {
      if (fileId === second.id && compressedFileId !== undefined) {
        lateFailureInjected = true;
        throw new Error('injected second-part failure');
      }
      return originalGet(fileId);
    });
    const saveSpy = vi.spyOn(files, 'save').mockImplementation(async (...args) => {
      const saved = await originalSave(...args);
      compressedFileId = saved.id;
      return saved;
    });

    try {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [
          { type: 'image', source: { kind: 'file', file_id: first.id } },
          { type: 'image', source: { kind: 'file', file_id: second.id } },
        ],
      });

      expect(submitted.body.code).not.toBe(0);
      expect(lateFailureInjected).toBe(true);
      expect(compressedFileId).toBeDefined();
      if (compressedFileId === undefined) throw new Error('expected a compressed upload');
      await expect(originalGet(compressedFileId)).rejects.toMatchObject({
        code: 'file.not_found',
      });
      expect((await originalGet(first.id)).meta.id).toBe(first.id);
      expect((await originalGet(second.id)).meta.id).toBe(second.id);
    } finally {
      getSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });

  it('carries an uncompressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id }, name: 'small.png' },
    ]);

    const mediaPath = await expectSessionMedia(fixture.server!, id, `${uploaded.id}.png`, smallPng);
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    expect(JSON.stringify(content)).not.toContain('kimi-file://');
  });

  it('resolves a queued uploaded image to a data URL when its provider turn starts', async () => {
    const requests: unknown[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider = createHttpServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.length === 0) return;
        requests.push(JSON.parse(body) as unknown);
        if (requests.length === 1) await firstGate;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            id: `chatcmpl-${String(requests.length)}`,
            choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`,
        );
      })();
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');

    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${String(address.port)}/v1` });
      for (const model of ['stub', 'stub-alt']) {
        await mutations.updateModel(model, { max_context_size: 100000, capabilities: ['thinking', 'image_in'] });
      }
      const id = await createSession(fixture.home as string);
      const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'active turn' }],
        model: 'stub',
      });
      expect(active.body.data.status).toBe('running');
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5_000 });

      const image = solidPng(10, 10);
      const uploaded = await uploadFile(image, 'image/png', 'queued.png');
      const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
      });
      expect(queued.body.data.status).toBe('queued');
      await expect(fixture.server!.core.accessor.get(IFileService).get(uploaded.id)).resolves.toBeDefined();

      releaseFirst();
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5_000 });
      expect(JSON.stringify(requests[1])).toContain(
        `data:image/png;base64,${image.toString('base64')}`,
      );
    } finally {
      releaseFirst();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it('accepts a stored session-media reference after the transient upload is deleted', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(first.body.code).toBe(0);
    await expectSessionMedia(fixture.server!, id, `${uploaded.id}.png`, smallPng);
    await fixture.server!.core.accessor.get(IFileService).delete(uploaded.id);

    const replayed = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'replay the stored image' },
        { type: 'image', source: { kind: 'session_media', file_id: uploaded.id } },
      ],
    });

    expect(replayed.body.code).toBe(0);
    expect(replayed.body.data.content).toEqual([
      { type: 'text', text: 'replay the stored image' },
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id }, name: 'small.png' },
    ]);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    await vi.waitFor(() => {
      const replayedMessage = main.accessor
        .get(IAgentContextMemoryService)
        .get()
        .find(
          (message) =>
            message.role === 'user' &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'replay the stored image',
            ),
        );
      expect(replayedMessage).toBeDefined();
      expect(replayedMessage!.content).toContainEqual({
        type: 'image_url',
        imageUrl: {
          url: `kimi-file://${uploaded.id}`,
          id: uploaded.id,
          name: 'small.png',
        },
      });
    });
  });

  it('keeps the upload-backed reference when the session media dir is not writable', async () => {
    if (process.getuid?.() === 0) return;
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const mediaDir = sessionMediaDir(fixture.server!, id);
    await mkdir(mediaDir, { recursive: true });
    await chmod(mediaDir, 0o555);
    try {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
      });
      expect(submitted.body.code).toBe(0);

      const session = getLiveSessionById(fixture.server!.core.accessor, id);
      const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
      await vi.waitFor(() => {
        const message = main.accessor
          .get(IAgentContextMemoryService)
          .get()
          .find((m) => m.role === 'user' && m.content.some((part) => part.type === 'image_url'));
        expect(message).toBeDefined();
        expect(message!.content).toContainEqual({
          type: 'image_url',
          imageUrl: { url: `kimi-file://${uploaded.id}`, name: 'small.png' },
        });
      });

      const cacheDir = fixture.server!.core.accessor.get(IBootstrapService).cacheDir;
      await expect(readFile(join(cacheDir, `${uploaded.id}.png`))).rejects.toThrow();
    } finally {
      await chmod(mediaDir, 0o755);
    }
  });

  it('accepts three inline images whose JSON exceeds Fastify default bodyLimit and keeps all attachments', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const images = [1, 2, 3].map((marker) => paddedPng(300 * 1024, marker));
    const content = images.map((image) => ({
      type: 'image' as const,
      source: { kind: 'base64' as const, media_type: 'image/png', data: image.toString('base64') },
    }));
    expect(Buffer.byteLength(JSON.stringify({ content }), 'utf8')).toBeGreaterThan(1 << 20);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, { content });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    const returned = submitted.body.data.content as Array<{ type: string }>;
    expect(returned.filter((part) => part.type === 'image')).toHaveLength(3);

    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    await vi.waitFor(() => {
      const message = main.accessor.get(IAgentContextMemoryService).get()
        .find((item) => item.role === 'user' && item.content.filter((part) => part.type === 'image_url').length === 3);
      expect(message).toBeDefined();
    });
  });

  it('reports an oversized prompt body as a validation error without creating a prompt', async () => {
    const id = await createSession(fixture.home as string);
    const payload = JSON.stringify({
      content: [{ type: 'text', text: 'x'.repeat(PROMPT_BODY_LIMIT_BYTES) }],
    });
    const response = await fixture.server!.app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/prompts`,
      headers: authHeaders(fixture.server as RunningServer, { 'content-type': 'application/json' }),
      payload,
    });
    const submitted = JSON.parse(response.body) as Envelope<PromptItemWire>;
    expect(response.statusCode).toBe(413);
    expect(submitted.code).toBe(40001);
    expect(submitted.msg).toContain('request body exceeds');
    const listed = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.active).toBeNull();
    expect(listed.body.data.queued).toHaveLength(0);
  });

  it('compresses inline base64 image prompts into session media-originals', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: bigPng.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(2);
    const caption = content[0];
    if (caption?.type !== 'text') throw new Error('expected compression caption');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!.replaceAll('\\', '/')).toContain('/media-originals/');
    expect((await realpath(pathMatch![1]!)).startsWith(await realpath(fixture.home as string))).toBe(true);
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1];
    if (image?.type !== 'image' || image.source.kind !== 'base64') {
      throw new Error('expected resolved base64 image');
    }
    expect(pngDimensions(Buffer.from(image.source.data, 'base64'))).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  it('materializes an unsupported inline image as a model-independent file reference', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: avifBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('accepts a HEIC image against the configured default model before any model binds', async () => {
    await writeConfigToml(fixture.home as string, PROMPT_TOML.replace('default_model = "stub"', 'default_model = "stub-kimi"') + [
      '', '[providers.kimi-stub]', 'type = "kimi"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "stub"',
      '', '[models.stub-kimi]', 'provider = "kimi-stub"', 'model = "kimi-k2"', 'max_context_size = 100000',
      'capabilities = ["thinking", "image_in"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"', '',
    ].join('\n'));
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/heic',
            data: heicBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('image');
  });

  it('materializes HEIC when the default model does not accept it directly', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/heic',
            data: heicBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('preserves an uploaded unsupported image as a file reference', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(avifBytes())], { type: 'image/avif' }), 'photo.avif');
    const uploadRes = await fetch(`${fixture.base}/api/files`, {
      method: 'POST',
      headers: authHeaders(fixture.server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.data.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
      name: 'photo.avif',
    });
  });

  it('preserves a remote image URL for request-time policy handling', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'url', url: 'https://example.com/pic.avif' } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: 'image',
      source: { kind: 'url', url: 'https://example.com/pic.avif' },
    });
  });

  it('materializes an arbitrary file attachment into the session attachments dir', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf bytes');
    const uploaded = await uploadFile(pdfBytes, 'application/pdf', 'report.pdf');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'summarize this' },
        { type: 'file', file_id: uploaded.id, name: 'report.pdf', media_type: 'application/pdf', size: pdfBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'summarize this' });
    const notice = content[1];
    expect(notice?.type).toBe('text');
    expect(notice?.text).toContain('Attached file "report.pdf"');
    expect(notice?.text).toContain('application/pdf');
    expect(notice?.text).toContain(`${pdfBytes.length} bytes`);
    const attachedPath = attachedPathFrom(notice?.text ?? '');
    expect(attachedPath.replaceAll('\\', '/')).toContain('/attachments/');
    expect(attachedPath.endsWith(`${uploaded.id}-report.pdf`)).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(fixture.home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(pdfBytes);
  });

  it('preserves an uploaded SVG image as a file reference', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const uploaded = await uploadFile(svgBytes, 'image/svg+xml', 'vector.svg');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
      name: 'vector.svg',
    });
  });

  it('persists an unsupported inline image as a file reference', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const data = avifBytes();

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/avif',
            data: data.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('sanitizes an attachment file name before materializing it', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const scriptBytes = Buffer.from('#!/bin/sh\necho hi');
    const uploaded = await uploadFile(scriptBytes, 'text/plain', '../../etc/evil.sh');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'file', file_id: uploaded.id, name: '../../etc/evil.sh', media_type: 'text/plain', size: scriptBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    const attachedPath = attachedPathFrom(content[0]?.text ?? '');
    expect(dirname(attachedPath).replaceAll('\\', '/').endsWith('/attachments')).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(fixture.home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(scriptBytes);
  });
});

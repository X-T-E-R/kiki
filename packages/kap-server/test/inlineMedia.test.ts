import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'node:http';
import * as sessionOperation from '../src/lib/sessionOperationLease';
import { installErrorHandler } from '../src/error-handler';
import Fastify from 'fastify';
import { createKlient } from '@kiki/klient/http';
import { AgentTranscript, contentOriginalFileId, jsonBytes, type TranscriptAttachment, transcriptTurnSchema } from '@kiki/transcript';
import { boundedEntity, readContentSegment } from '../src/transport/klient/boundedContent';
import type { Scope } from '@kiki/agent-core-v2';
import { registerSessionMediaRoutes } from '../src/routes/sessionMedia';
import type { TranscriptService } from '../src/services/transcript/transcriptService';
import { boundedTranscriptOps, boundedTranscriptSnapshot } from '../src/transport/klient/boundedTranscript';
import { inlineMediaFile } from '../src/services/inlineMedia';

function bitmap(): Buffer {
  const bytes = Buffer.alloc(54 + 800 * 3 * 600);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(800, 18); bytes.writeInt32LE(600, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  return bytes;
}

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

describe('canonical inline media original', () => {
  it('closes a cancelled session preview source and releases its operation without affecting the next download', async () => {
    const app = Fastify(); servers.push(app);
    installErrorHandler(app);
    app.addHook('onSend', async (_req, _reply, payload) => payload);
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    let sourceClosed!: () => void;
    const closed = new Promise<void>((resolve) => { sourceClosed = resolve; });
    let released!: () => void;
    const disposed = new Promise<void>((resolve) => { released = resolve; });
    let slow = true;
    const bytes = new Uint8Array(1024);
    const dispose = vi.fn(async () => { released(); });
    const file = { name: 'fixture.png', mediaType: 'image/png', size: bytes.byteLength,
      stream: async function* (range?: { start: number; end: number }) {
        try {
          if (slow) { started(); await gate; }
          yield range === undefined ? bytes : bytes.subarray(range.start, range.end + 1);
        } finally { sourceClosed(); }
      },
    };
    const acquire = vi.spyOn(sessionOperation, 'acquireSessionOperation').mockResolvedValue({
      handle: { accessor: { get: () => ({ open: async () => file }) } }, dispose,
    } as unknown as sessionOperation.SessionOperationLease);
    await app.register(async (router) => { registerSessionMediaRoutes(router as unknown as Parameters<typeof registerSessionMediaRoutes>[0], {} as Scope); }, { prefix: '/api' });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const disconnected = new Promise<void>((resolve) => { app.server.once('request', (_req, response) => { response.once('close', resolve); }); });
    const request = get(`${base}/api/sessions/fixture/media/file/preview`);
    request.on('error', () => {});
    try {
      await reading;
      request.destroy();
      await disconnected;
      proceed();
      await closed;
      await disposed;
      expect(dispose).toHaveBeenCalledTimes(1);
      slow = false;
      const normal = await fetch(`${base}/api/sessions/fixture/media/file`, { headers: { range: 'bytes=0-15' } });
      expect(normal.status).toBe(206);
      expect(new Uint8Array(await normal.arrayBuffer())).toEqual(bytes.subarray(0, 16));
      await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(2); });
      expect(app.server.listening).toBe(true);
    } finally {
      proceed();
      request.destroy();
      acquire.mockRestore();
    }
  });
  it('keeps delivered prompt images whole in baseline, live operations and content continuations without resuming a cold session', async () => {
    const fixture = new URL('../../../apps/kiki-gui/fixtures/sent-images.scenario.mjs', import.meta.url).href;
    const { pictures } = await import(fixture);
    const original: Buffer = pictures[1].bytes;
    const prompt = { promptId: 'image-prompt', userMessageId: 'image-prompt', status: 'completed' as const, createdAt: '2026-01-01T00:00:00.000Z',
      content: [{ type: 'text' as const, text: 'Example feedback' }, { type: 'image' as const, source: { kind: 'base64' as const, media_type: 'image/png', data: original.toString('base64') } }] };
    const transcript = new AgentTranscript('child');
    transcript.apply([{ op: 'reset', agentId: 'child', snapshot: { items: [], tasks: [], attachments: [], prompts: [prompt], interactions: [], todos: [], meta: {} } }]);
    const snapshot = boundedTranscriptSnapshot(transcript.snapshot(), 'child');
    const media = (snapshot.prompts[0]!.content as { type: string; source: { kind: string; file_id: string } }[])[1]!;
    expect(media).toMatchObject({ type: 'image', source: { kind: 'session_media' } });
    const op = boundedTranscriptOps([{ op: 'prompt.upsert', prompt }], transcript)[0]!;
    expect(op).toMatchObject({ op: 'prompt.upsert', prompt: { content: [prompt.content[0], media] } });
    const preview = boundedEntity(prompt, { kind: 'prompt', id: prompt.promptId }, 512);
    const ref = preview.contentRefs!.find((ref) => ref.path.length === 1 && ref.path[0] === 'content')!;
    const continuation = readContentSegment(prompt, ref, false, 'child');
    expect(continuation.value).toEqual([prompt.content[0], media]);
    expect(continuation.contentRefs).toEqual([]);
    expect(prompt.content[1]!.source?.data).toBe(original.toString('base64'));
    const queued = { ...prompt, status: 'queued' as const };
    const queuedPreview = boundedEntity(queued, { kind: 'prompt', id: queued.promptId }, 512, 'child');
    const queuedRef = queuedPreview.contentRefs!.find((ref) => ref.path.length === 1 && ref.path[0] === 'content')!;
    const queuedSegment = readContentSegment(queued, queuedRef, false, 'child');
    expect(queuedSegment.value).toMatchObject([prompt.content[0], { type: 'image', source: { kind: 'base64' } }]);
    expect(queuedSegment.contentRefs).toContainEqual(expect.objectContaining({ path: ['content', 1, 'source', 'data'], total: original.toString('base64').length }));
    let changed = false;
    const service = { forSessionLive: () => undefined, readColdSnapshot: async (session: string, agent: string) =>
      session === 'fixture-session' && agent === 'child' ? { ...transcript.snapshot(), prompts: changed ? [] : [prompt] } : undefined,
    } as unknown as TranscriptService;
    const app = Fastify(); servers.push(app);
    await app.register(async (router) => { registerSessionMediaRoutes(router as unknown as Parameters<typeof registerSessionMediaRoutes>[0], {} as Scope, service); }, { prefix: '/api' });
    const path = `/api/sessions/fixture-session/media/${encodeURIComponent(media.source.file_id)}`;
    expect((await app.inject({ url: path })).rawPayload).toEqual(original);
    expect((await app.inject({ url: `${path}/preview` })).statusCode).toBe(200);
    expect((await app.inject({ url: path.replace('fixture-session', 'wrong-session') })).statusCode).toBe(404);
    expect((await app.inject({ url: path.replace('child', 'other') })).statusCode).toBe(404);
    const address = JSON.parse(Buffer.from(media.source.file_id.split(':')[2]!, 'base64url').toString('utf8'));
    address.path = ['content', 1, 'source'];
    const forged = `inline-content:child:${Buffer.from(JSON.stringify(address)).toString('base64url')}:${media.source.file_id.split(':')[3]}`;
    expect((await app.inject({ url: `/api/sessions/fixture-session/media/${encodeURIComponent(forged)}` })).statusCode).toBe(404);
    changed = true;
    expect((await app.inject({ url: path })).statusCode).toBe(404);
  });

  it('projects large recorded tool images to exact revision-bound HTTP media instead of truncated data URLs', async () => {
    const fixture = new URL('../../../apps/kiki-gui/fixtures/sent-images.scenario.mjs', import.meta.url).href;
    const { pictures } = await import(fixture);
    const original: Buffer = pictures[1].bytes;
    expect(original.length).toBeGreaterThan(64 * 1024);
    const output = [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${original.toString('base64')}` } }];
    const turn = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', turnId: 't1', stepId: 's1', ordinal: 1, state: 'completed', frames: [{ kind: 'tool', frameId: 'f1', name: 'ReadMediaFile', toolCallId: 'call1', state: 'done', output }] }] });
    const transcript = new AgentTranscript('child');
    transcript.apply([{ op: 'reset', agentId: 'child', snapshot: { items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} } }]);
    const frame = turn.steps[0]!.frames[0]!;
    const snapshot = boundedTranscriptSnapshot(transcript.snapshot(), 'child');
    const projectedTurn = snapshot.items[0]!;
    if (projectedTurn.kind !== 'turn') throw new Error('Expected turn');
    const media = (projectedTurn.steps[0]!.frames[0] as { output: { type: string; source: { kind: string; file_id: string } }[] }).output[0]!;
    expect(media.type).toBe('image'); expect(media.source.kind).toBe('session_media');
    const fileId = media.source.file_id;
    expect(fileId).toMatch(/^inline-content:child:/u);
    expect(jsonBytes(snapshot)).toBeLessThan(16 * 1024);
    expect(projectedTurn.contentRefs).toBeUndefined();
    const op = boundedTranscriptOps([{ op: 'frame.upsert', turnId: 't1', stepId: 's1', frame }], transcript)[0]!;
    if (op.op !== 'frame.upsert' || op.frame.kind !== 'tool' || frame.kind !== 'tool') throw new Error('Expected tool frame');
    expect(op.frame.output).toEqual([media]);
    expect(frame.output).toEqual(output);
    const laterFrame = { ...frame, output: [...Array.from({ length: 4 }, () => ({ type: 'text', text: 'before media' })), ...output] };
    const source = { kind: 'frame' as const, id: frame.frameId, turnId: 't1', stepId: 's1' };
    const preview = boundedEntity(laterFrame, source, undefined, 'child');
    const ref = preview.contentRefs?.find((candidate) => candidate.path.length === 1 && candidate.path[0] === 'output');
    expect(ref).toBeDefined();
    if (ref === undefined) throw new Error('Expected array continuation');
    const continuation = readContentSegment(laterFrame, ref, false, 'child');
    const laterMedia = (continuation.value as { type: string; source: { file_id: string } }[])[0]!;
    expect(laterMedia.type).toBe('image');
    expect(laterMedia.source.file_id).toMatch(/^inline-content:child:/u);
    expect(continuation.contentRefs).toEqual([]);
    expect(continuation.next).toBeUndefined();
    let changed = false;
    const service = { readCanonicalEntity: async (session: string, agent: string, source: { id: string; turnId?: string; stepId?: string }) =>
      session === 'fixture-session' && agent === 'child' && source.id === 'f1' && source.turnId === 't1' && source.stepId === 's1'
        ? changed ? { ...frame, output: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } }] } : frame : undefined,
    } as unknown as TranscriptService;
    const app = Fastify(); servers.push(app);
    await app.register(async (router) => { registerSessionMediaRoutes(router as unknown as Parameters<typeof registerSessionMediaRoutes>[0], {} as Scope, service); }, { prefix: '/api' });
    const client = createKlient({ endpoint: await app.listen({ host: '127.0.0.1', port: 0 }) });
    try {
      const bytes: Uint8Array[] = [];
      await client.rest!.sessions.downloadMedia('fixture-session', fileId, (chunk) => { bytes.push(chunk.slice()); });
      expect(Buffer.concat(bytes)).toEqual(original);
      expect((await client.rest!.sessions.media('fixture-session', fileId, { range: 'bytes=0-63' })).bytes).toEqual(new Uint8Array(original.subarray(0, 64)));
      await expect(client.rest!.sessions.media('wrong-session', fileId)).rejects.toThrow();
      await expect(client.rest!.sessions.media('fixture-session', fileId.replace('child:', 'other:'))).rejects.toThrow();
      await expect(client.rest!.sessions.media('fixture-session', 'inline-content:child:invalid:bad')).rejects.toThrow();
      changed = true;
      await expect(client.rest!.sessions.media('fixture-session', fileId)).rejects.toThrow();
    } finally { await client.close(); }
  });

  it('reads the complete 70-KiB-key tool original as a real HTTP file without rebuilding an object in the GUI, and rejects a changed revision', async () => {
    const output = { ['key'.repeat(Math.ceil(70 * 1024 / 3))]: { text: 'Original 正文😀' } };
    const turn = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', turnId: 't1', stepId: 's1', ordinal: 1, state: 'completed', frames: [{ kind: 'tool', frameId: 'f1', name: 'Read', toolCallId: 'call1', state: 'done', output }] }] });
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot: { items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} } }]);
    const service = { forSessionLive: (id: string) => id === 'fixture-session' ? { getAgent: () => transcript } : undefined, whenReady: async () => {}, ensureAgentHistory: async () => transcript, readColdSnapshot: async () => undefined,
      readCanonicalEntity: async (id: string, agent: string, source: { id: string; turnId?: string; stepId?: string }) => id === 'fixture-session' && agent === 'main'
        ? transcript.getTurn(source.turnId ?? '')?.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id) : undefined,
    } as unknown as TranscriptService;
    const frame = turn.steps[0]!.frames[0]!;
    const preview = boundedEntity(frame, { kind: 'frame', id: 'f1', turnId: 't1', stepId: 's1' });
    const ref = preview.contentRefs![0]!;
    const fileId = contentOriginalFileId('main', ref)!;
    expect(fileId.length).toBeLessThan(400);
    expect(contentOriginalFileId('main', { ...ref, path: ['internal', 'arbitrary'] })).toBeUndefined();
    const app = Fastify();
    servers.push(app);
    await app.register(async (router) => { registerSessionMediaRoutes(router as unknown as Parameters<typeof registerSessionMediaRoutes>[0], {} as Scope, service); }, { prefix: '/api' });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = createKlient({ endpoint: address });
    try {
      const chunks: Uint8Array[] = [];
      const receipt = await client.rest!.sessions.downloadMedia('fixture-session', fileId, (chunk) => { chunks.push(chunk.slice()); });
      expect(Buffer.concat(chunks).toString('utf8')).toBe(JSON.stringify(output));
      expect(receipt.bytes).toBe(Buffer.byteLength(JSON.stringify(output)));
      transcript.apply([{ op: 'frame.upsert', turnId: 't1', stepId: 's1', frame: { ...frame, output: { changed: true } } as typeof frame }]);
      await expect(client.rest!.sessions.downloadMedia('fixture-session', fileId, () => {})).rejects.toMatchObject({ code: 40922 });
    } finally { await client.close(); }
  });
  it('projects a canonical data URI to a bounded session media handle, generates the preview at source, and reads every original byte through typed HTTP', async () => {
    const original = bitmap();
    const attachment: TranscriptAttachment = { attachmentId: 't1.att1', name: 'inline.bmp', mediaType: 'image/bmp', source: { kind: 'url', url: `data:image/bmp;charset=binary;base64,${original.toString('base64')}` } };
    const transcript = new AgentTranscript('child');
    transcript.apply([{ op: 'reset', agentId: 'child', snapshot: { items: [], tasks: [], attachments: [attachment], prompts: [], interactions: [], todos: [], meta: {} } }]);
    const service = {
      forSessionLive: (id: string) => id === 'fixture-session' ? { getAgent: (id: string) => id === 'child' ? transcript : undefined } : undefined,
      whenReady: async () => {}, ensureAgentHistory: async () => transcript, readColdSnapshot: async () => undefined,
    } as unknown as TranscriptService;
    const window = boundedTranscriptSnapshot(transcript.snapshot(), 'child');
    expect(jsonBytes(window)).toBeLessThan(64 * 1024);
    expect(window.attachments[0]?.source?.kind).toBe('session_media');
    const source = window.attachments[0]!.source!;
    if (source.kind !== 'session_media') throw new Error('Expected canonical media handle');
    expect(source.fileId).toContain('inline:child:');
    expect(transcript.getAttachment('t1.att1')!.source).toEqual(attachment.source);
    const app = Fastify();
    servers.push(app);
    await app.register(async (router) => { registerSessionMediaRoutes(router as unknown as Parameters<typeof registerSessionMediaRoutes>[0], {} as Scope, service); }, { prefix: '/api' });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = createKlient({ endpoint: address });
    try {
      const preview = await client.rest!.sessions.mediaPreview('fixture-session', source.fileId);
      expect(preview.mime).toBe('image/jpeg');
      expect(preview.bytes.byteLength).toBeLessThan(64 * 1024);
      const bytes: Uint8Array[] = [];
      const receipt = await client.rest!.sessions.downloadMedia('fixture-session', source.fileId, (chunk) => { bytes.push(chunk.slice()); });
      expect(receipt.bytes).toBe(original.byteLength);
      expect(Buffer.concat(bytes)).toEqual(original);
      const range = await client.rest!.sessions.media('fixture-session', source.fileId, { range: 'bytes=0-63' });
      expect(range.bytes).toEqual(new Uint8Array(original.subarray(0, 64)));
      await expect(client.rest!.sessions.media('wrong-session', source.fileId)).rejects.toThrow();
      const changed = { ...attachment, source: { kind: 'url' as const, url: 'data:image/bmp;base64,AAAA' } };
      transcript.apply([{ op: 'attachment.upsert', attachment: changed }]);
      await expect(client.rest!.sessions.media('fixture-session', source.fileId)).rejects.toThrow();
    } finally { await client.close(); }
  });

  it('preserves percent-encoded binary data, UTF-8 text, whitespace/unpadded base64, and malformed-source failure', async () => {
    for (const [url, expected] of [
      ['data:application/octet-stream,%89PNG%0D%0A%1A%0A', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ['data:text/plain;charset=utf-8,中文%20text', Buffer.from('中文 text')],
      ['data:application/octet-stream;base64,Z m\n8', Buffer.from('fo')],
      ['data:application/octet-stream;base64,Zg%3D%3D', Buffer.from('f')],
    ] as const) {
      const file = (await inlineMediaFile({ attachmentId: 'isolated', mediaType: 'application/octet-stream', source: { kind: 'url', url } }))!;
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.stream()) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(expected);
      expect(file.size).toBe(expected.byteLength);
    }
    expect(await inlineMediaFile({ attachmentId: 'invalid', mediaType: 'image/png', source: { kind: 'url', url: 'data:image/png;base64,invalid!' } })).toBeUndefined();
  });

  it('rejects the 1044-character truncated PNG while preserving complete unpadded PNG and JPEG original bytes', async () => {
    const fixture = new URL('../../../apps/kiki-gui/fixtures/sent-images.scenario.mjs', import.meta.url).href;
    const { pictures } = await import(fixture);
    const png: Buffer = pictures[1].bytes;
    const bad = `data:image/png;base64,${png.toString('base64').slice(0, 1022)}`;
    expect(bad.length).toBe(1044);
    expect(await inlineMediaFile({ attachmentId: 'bad', mediaType: 'image/png', source: { kind: 'url', url: bad } })).toBeUndefined();
    const { compressImageForModel } = await import('@kiki/agent-core-v2/agent/media/image-compress');
    const jpeg = Buffer.from((await compressImageForModel(png, 'image/png', { maxEdge: 128, byteBudget: 16 * 1024, outputMimes: new Set(['image/jpeg']) })).data);
    for (const [mime, bytes] of [['image/png', png], ['image/jpeg', jpeg]] as const) {
      const file = await inlineMediaFile({ attachmentId: mime, mediaType: mime, source: { kind: 'url', url: `data:${mime};base64,${bytes.toString('base64').replace(/=+$/u, '')}` } });
      expect(file).toBeDefined();
      const chunks: Uint8Array[] = [];
      for await (const chunk of file!.stream()) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(file!.size).toBe(bytes.length);
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createKlient } from '@kiki/klient/http';
import { AgentTranscript, contentOriginalFileId, jsonBytes, type TranscriptAttachment, transcriptTurnSchema } from '@kiki/transcript';
import { boundedEntity } from '../src/transport/klient/boundedContent';
import type { Scope } from '@kiki/agent-core-v2';
import { registerSessionMediaRoutes } from '../src/routes/sessionMedia';
import type { TranscriptService } from '../src/services/transcript/transcriptService';
import { boundedTranscriptSnapshot } from '../src/transport/klient/boundedTranscript';
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
  it('reads the complete 70-KiB-key tool original as a real HTTP file without rebuilding an object in the GUI, and rejects a changed revision', async () => {
    const output = { ['key'.repeat(Math.ceil(70 * 1024 / 3))]: { text: 'Original 正文😀' } };
    const turn = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', turnId: 't1', stepId: 's1', ordinal: 1, state: 'completed', frames: [{ kind: 'tool', frameId: 'f1', name: 'Read', toolCallId: 'call1', state: 'done', output }] }] });
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot: { items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} } }]);
    const service = { forSessionLive: (id: string) => id === 'fixture-session' ? { getAgent: () => transcript } : undefined, whenReady: async () => {}, ensureAgentHistory: async () => transcript, readColdSnapshot: async () => undefined } as unknown as TranscriptService;
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
      ['data:image/png,%89PNG%0D%0A%1A%0A', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ['data:text/plain;charset=utf-8,中文%20text', Buffer.from('中文 text')],
      ['data:application/octet-stream;base64,Z m\n8', Buffer.from('fo')],
      ['data:application/octet-stream;base64,Zg%3D%3D', Buffer.from('f')],
    ] as const) {
      const file = inlineMediaFile({ attachmentId: 'isolated', mediaType: 'application/octet-stream', source: { kind: 'url', url } })!;
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.stream()) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(expected);
      expect(file.size).toBe(expected.byteLength);
    }
    expect(inlineMediaFile({ attachmentId: 'invalid', mediaType: 'image/png', source: { kind: 'url', url: 'data:image/png;base64,invalid!' } })).toBeUndefined();
  });
});

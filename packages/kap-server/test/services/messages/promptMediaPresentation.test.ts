import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { expect, it, vi } from 'vitest';

import type { FileMeta, GetResult, IFileService, SaveOptions } from '@kiki/agent-core-v2/app/file/fileService';
import type { ISessionMediaStore } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { projectPresentedText } from '@kiki/transcript';
import { prepareThreadRefContext } from '../../../../session-core/src/composer/threadRefs';
import { projectMessageContent } from '../../../../session-core/src/session/transcript/classify';

import type { PromptSubmission } from '../../../src/protocol/rest-prompt';
import { contentToCoreParts, resolvePromptMediaFiles } from '../../../src/lib/promptMedia';
import { projectPromptContentParts } from '../../../src/services/messages/messageProjection';

type StoredFile = { readonly meta: FileMeta; readonly bytes: Buffer };

function testWav(sampleRate: number, channels: number): Buffer {
  const dataBytes = channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let channel = 0; channel < channels; channel++) wav.writeInt16LE(4096, 44 + channel * 2);
  return wav;
}

function mockFileService(): IFileService {
  const files = new Map<string, StoredFile>();
  let nextId = 0;
  return {
    _serviceBrand: undefined,
    async save(source: Readable, filename: string, input: SaveOptions | (() => SaveOptions) = {}): Promise<FileMeta> {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array));
      const bytes = Buffer.concat(chunks);
      const options = typeof input === 'function' ? input() : input;
      const meta: FileMeta = {
        id: `f_prompt_${nextId++}`,
        name: options.name ?? filename,
        media_type: options.mimeType ?? 'application/octet-stream',
        size: bytes.length,
        created_at: new Date(0).toISOString(),
      };
      files.set(meta.id, { meta, bytes });
      return meta;
    },
    async get(fileId: string): Promise<GetResult> {
      const stored = files.get(fileId);
      if (stored === undefined) throw new Error(`missing mock upload: ${fileId}`);
      return { meta: stored.meta, stream: () => Readable.from(stored.bytes) };
    },
    async delete(fileId: string): Promise<void> {
      files.delete(fileId);
    },
  };
}

it('resolves an uploaded video without a session media store', async () => {
  const files = mockFileService();
  const upload = await files.save(Readable.from(Buffer.from('video bytes')), 'clip.mp4', { mimeType: 'video/mp4' });
  const prepared = await resolvePromptMediaFiles([
    { type: 'video', source: { kind: 'file', file_id: upload.id } },
  ], files, '.unused');
  expect(prepared.content).toEqual([
    expect.objectContaining({ type: 'text', text: `Attached file "clip.mp4" (video/mp4, 11 bytes): .unused\\${upload.id}-clip.mp4 — open it with the Read tool` }),
    { type: 'video', source: { kind: 'url', url: `kimi-file://${upload.id}` }, name: 'clip.mp4' },
  ]);
  await prepared.discard();
  expect((await files.get(upload.id)).meta).toEqual(upload);
});

it('keeps canonical audio playback and resolves one original plus one WAV note for duplicate references', async () => {
  const candidateRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const scratchRoot = join(candidateRoot, '.tmp');
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, 'prompt-audio-presentation-'));
  const fileId = 'f_voice';
  const bytes = Buffer.from('canonical audio bytes');
  const wavBytes = testWav(16_000, 1);
  const wavPath = join(tempDir, `${fileId}.wav`);
  await writeFile(wavPath, wavBytes);
  const media: ISessionMediaStore = {
    _serviceBrand: undefined,
    pathFor: () => undefined,
    resolveDisplayPath: async () => undefined,
    read: async () => undefined,
    open: vi.fn(async () => ({
      name: '../voice note.ogg',
      mediaType: 'application/octet-stream',
      size: bytes.byteLength,
      stream: async function* () { yield bytes; },
    })),
    materialize: vi.fn(async () => undefined),
  };
  let prepared: Awaited<ReturnType<typeof resolvePromptMediaFiles>> | undefined;
  try {
    const input = [
      { type: 'audio', source: { kind: 'session_media', file_id: fileId } },
      { type: 'audio', source: { kind: 'session_media', file_id: fileId } },
    ] satisfies PromptSubmission['content'];
    prepared = await resolvePromptMediaFiles(input, mockFileService(), tempDir, {
      sessionMedia: media,
      resolveAttachmentsDir: async () => tempDir,
    });
    const attachedPath = wavPath;
    const originalPath = join(tempDir, `${fileId}-_voice note.ogg`);
    expect(prepared.content.map((part) => part.type)).toEqual(['text', 'text', 'audio', 'audio']);
    expect(prepared.content[0]).toMatchObject({ type: 'text', text: `Attached audio "_voice note.ogg" (application/octet-stream, ${bytes.byteLength} bytes): ${originalPath} — listen with an audio-capable tool or use this path` });
    expect(prepared.content[1]).toMatchObject({ type: 'text', text: `Attached audio "_voice note.wav" (16 kHz mono 16-bit PCM WAV, ${wavBytes.byteLength} bytes): ${attachedPath} — listen with an audio-capable tool or use this path` });
    expect(prepared.content.slice(2)).toEqual([
      { type: 'audio', name: '_voice note.ogg', source: { kind: 'session_media', file_id: fileId } },
      { type: 'audio', name: '_voice note.ogg', source: { kind: 'session_media', file_id: fileId } },
    ]);
    expect(await readFile(originalPath)).toEqual(bytes);
    expect(await readFile(attachedPath)).toEqual(wavBytes);
    expect(media.open).toHaveBeenCalledTimes(1);
    expect(media.materialize).not.toHaveBeenCalled();
  } finally {
    await prepared?.discard();
    await rm(tempDir, { recursive: true, force: true });
  }
});

it('describes a valid but unconverted WAV derivative without claiming normalized ASR format', async () => {
  const candidateRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const scratchRoot = join(candidateRoot, '.tmp');
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, 'prompt-wav-fallback-'));
  const fileId = 'f_unconverted';
  const wav = testWav(44_100, 2);
  const wavPath = join(tempDir, `${fileId}.wav`);
  await writeFile(wavPath, wav);
  const media: ISessionMediaStore = {
    _serviceBrand: undefined,
    pathFor: () => undefined,
    resolveDisplayPath: async () => undefined,
    read: async () => undefined,
    open: async () => ({
      name: 'source.opus',
      mediaType: 'application/octet-stream',
      size: wav.byteLength,
      stream: async function* () { yield wav; },
    }),
    materialize: vi.fn(async () => undefined),
  };
  let prepared: Awaited<ReturnType<typeof resolvePromptMediaFiles>> | undefined;
  try {
    prepared = await resolvePromptMediaFiles([
      { type: 'audio', source: { kind: 'session_media', file_id: fileId } },
    ], mockFileService(), tempDir, { sessionMedia: media, resolveAttachmentsDir: async () => tempDir });
    expect(prepared.content[1]).toMatchObject({
      type: 'text',
      text: `Attached audio "source.wav" (unconverted WAV source (44100 Hz, 2 channels, 16-bit PCM; not normalized for ASR), ${wav.byteLength} bytes): ${wavPath} — listen with an audio-capable tool or use this path`,
    });
  } finally {
    await prepared?.discard();
    await rm(tempDir, { recursive: true, force: true });
  }
});

it('keeps staged audio MIME validation strict even when a matching derivative exists', async () => {
  const candidateRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const scratchRoot = join(candidateRoot, '.tmp');
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, 'prompt-staged-audio-mime-'));
  try {
    const files = mockFileService();
    const upload = await files.save(Readable.from(Buffer.from('opaque audio')), 'recording.bin');
    await writeFile(join(tempDir, `${upload.id}.wav`), testWav(16_000, 1));
    await expect(resolvePromptMediaFiles([
      { type: 'audio', source: { kind: 'file', file_id: upload.id } },
    ], files, '.unused', { resolveAttachmentsDir: async () => tempDir })).rejects.toThrow('not audio');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

it('copies canonical image and video media once to safe deterministic attachment paths while retaining playable references', async () => {
  const candidateRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const scratchRoot = join(candidateRoot, '.tmp');
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, 'prompt-canonical-media-'));
  const records = new Map([
    ['f_image', { name: '../chart.png', mediaType: 'image/png', bytes: Buffer.from('image bytes') }],
    ['f_video', { name: 'clip?.mp4', mediaType: 'video/mp4', bytes: Buffer.from('video bytes') }],
  ]);
  const media: ISessionMediaStore = {
    _serviceBrand: undefined,
    pathFor: () => undefined,
    resolveDisplayPath: async () => undefined,
    read: async () => undefined,
    open: vi.fn(async (fileId: string) => {
      const file = records.get(fileId);
      return file === undefined ? undefined : {
        name: file.name,
        mediaType: file.mediaType,
        size: file.bytes.byteLength,
        stream: async function* () { yield file.bytes; },
      };
    }),
    materialize: vi.fn(async () => undefined),
  };
  let prepared: Awaited<ReturnType<typeof resolvePromptMediaFiles>> | undefined;
  try {
    const input = [
      { type: 'image', source: { kind: 'session_media', file_id: 'f_image' } },
      { type: 'image', source: { kind: 'session_media', file_id: 'f_image' } },
      { type: 'video', source: { kind: 'session_media', file_id: 'f_video' } },
    ] satisfies PromptSubmission['content'];
    prepared = await resolvePromptMediaFiles(input, mockFileService(), tempDir, { sessionMedia: media, resolveAttachmentsDir: async () => tempDir });
    const imagePath = join(tempDir, 'f_image-_chart.png');
    const videoPath = join(tempDir, 'f_video-clip_.mp4');
    expect(prepared.content.map((part) => part.type)).toEqual(['text', 'image', 'image', 'text', 'video']);
    expect(prepared.content[0]).toMatchObject({ type: 'text', text: `Attached file "_chart.png" (image/png, 11 bytes): ${imagePath} — open it with the Read tool` });
    expect(prepared.content[3]).toMatchObject({ type: 'text', text: `Attached file "clip_.mp4" (video/mp4, 11 bytes): ${videoPath} — open it with the Read tool` });
    expect(prepared.content.slice(1, 3)).toEqual([
      { type: 'image', source: { kind: 'session_media', file_id: 'f_image' }, name: '_chart.png' },
      { type: 'image', source: { kind: 'session_media', file_id: 'f_image' }, name: '_chart.png' },
    ]);
    expect(prepared.content[4]).toEqual({ type: 'video', source: { kind: 'session_media', file_id: 'f_video' }, name: 'clip_.mp4' });
    expect(await readFile(imagePath)).toEqual(records.get('f_image')?.bytes);
    expect(await readFile(videoPath)).toEqual(records.get('f_video')?.bytes);
    expect(media.open).toHaveBeenCalledTimes(2);
    expect(media.materialize).not.toHaveBeenCalled();
  } finally {
    await prepared?.discard();
    await rm(tempDir, { recursive: true, force: true });
  }
});

const REF_ID = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const REF_INFO = {
  sessionId: REF_ID,
  hostId: 'host-example',
  title: 'Prompt display proof',
  workspaceId: 'workspace-example',
  workspaceName: 'kiki',
  cwd: 'C:/workspace/kiki',
  status: 'idle' as const,
  updatedAt: '2026-01-01T12:00:00.000Z',
};

it('keeps generated prompt context and attachment notices hidden while preserving their media metadata', async () => {
  const candidateRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const scratchRoot = join(candidateRoot, '.tmp');
  let tempDir: string | undefined;
  let preparedMedia: Awaited<ReturnType<typeof resolvePromptMediaFiles>> | undefined;
  try {
    await mkdir(scratchRoot, { recursive: true });
    tempDir = await mkdtemp(join(scratchRoot, 'prompt-media-presentation-'));
    const fileBytes = Buffer.from('%PDF-1.4 mock report bytes');
    const files = mockFileService();
    const upload = await files.save(Readable.from(fileBytes), 'report.pdf', { mimeType: 'application/pdf' });
    const body = `Compare this with /s/${REF_ID}`;
    const preparedText = prepareThreadRefContext(body, () => REF_INFO);
    const input = [
      { type: 'text', text: preparedText.text, presentation: preparedText.presentation },
      { type: 'file', file_id: upload.id, name: upload.name, media_type: upload.media_type, size: upload.size },
    ] satisfies PromptSubmission['content'];

    preparedMedia = await resolvePromptMediaFiles(input, files, tempDir);
    const preparedReferenceSpan = { start: body.length, end: preparedText.text.length, kind: 'context' as const };
    expect(preparedText.presentation).toEqual({ spans: [preparedReferenceSpan] });
    expect(preparedMedia.content[0]).toEqual({ type: 'text', text: preparedText.text, presentation: { spans: [preparedReferenceSpan] } });

    const preparedNotice = preparedMedia.content[1];
    expect(preparedNotice?.type).toBe('text');
    if (preparedNotice?.type !== 'text') throw new Error('resolvePromptMediaFiles did not produce an attachment notice');
    const attachedPath = join(tempDir, `${upload.id}-${upload.name}`);
    const expectedNotice = `Attached file "${upload.name}" (${upload.media_type}, ${upload.size} bytes): ${attachedPath} — open it with the Read tool`;
    const expectedAttachment = { path: attachedPath, name: upload.name, mime: upload.media_type, size: upload.size };
    expect(preparedNotice.text).toBe(expectedNotice);
    expect(preparedNotice.text).toContain('open it with the Read tool');
    expect(preparedNotice.presentation).toEqual({ spans: [{ start: 0, end: expectedNotice.length, kind: 'attachment', attachment: expectedAttachment }] });

    const coreParts = contentToCoreParts(preparedMedia.content);
    expect(coreParts[0]).toEqual({ type: 'text', text: preparedText.text, presentation: { spans: [preparedReferenceSpan] } });
    expect(coreParts[1]).toEqual({ type: 'text', text: expectedNotice, presentation: { spans: [{ start: 0, end: expectedNotice.length, kind: 'attachment', attachment: expectedAttachment }] } });
    expect(coreParts[1]?.type === 'text' ? coreParts[1].text : '').toContain('open it with the Read tool');

    const projectedContent = projectPromptContentParts(coreParts);
    expect(projectedContent[0]).toEqual({ type: 'text', text: preparedText.text, presentation: { spans: [preparedReferenceSpan] } });
    expect(projectedContent[1]).toEqual({ type: 'text', text: expectedNotice, presentation: { spans: [{ start: 0, end: expectedNotice.length, kind: 'attachment', attachment: expectedAttachment }] } });

    const projected = projectMessageContent(projectedContent);
    expect(projected.presentation?.spans[0]).toEqual(preparedReferenceSpan);
    expect(projected.presentation?.spans[1]).toEqual({ start: preparedText.text.length + 1, end: preparedText.text.length + 1 + expectedNotice.length, kind: 'attachment', attachment: expectedAttachment });
    expect(projected.media).toEqual([{ kind: 'file', path: attachedPath, name: upload.name, mime: upload.media_type, size: upload.size }]);
    expect(projectPresentedText(projected.text, projected.presentation)).toBe(`${body}\n`);
    expect(projectPresentedText(projected.text, projected.presentation)).not.toContain(expectedNotice);
    expect(projected.text).toContain('open it with the Read tool');

    const userReadNotice = 'Attached file "report.pdf" (application/pdf, 25 bytes): C:/user/report.pdf — open it with the Read tool';
    const authoredXml = `${body}\n\n<thread_refs>\nuser-authored note\n</thread_refs>`;
    for (const authored of [userReadNotice, authoredXml]) {
      const rawProjection = projectMessageContent([{ type: 'text', text: authored }]);
      expect(rawProjection.presentation).toBeUndefined();
      expect(projectPresentedText(rawProjection.text, rawProjection.presentation)).toBe(authored);
    }
  } finally {
    await preparedMedia?.discard();
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
  }
});

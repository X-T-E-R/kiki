import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { buildDaemonFileUrl } from '@kiki/agent-core-v2/agent/media/mediaRef';
import { buildImageCompressionCaption, compressBase64ForModel, compressImageForModel, validateImageDataUrl, type ImageCompressionTelemetry } from '@kiki/agent-core-v2/agent/media/image-compress';
import { decodeBase64Prefix, isModelAcceptedImageMime, normalizeImageMime, resolveEffectiveImageMime } from '@kiki/agent-core-v2/agent/media/image-format-policy';
import { persistOriginalImage } from '@kiki/agent-core-v2/agent/media/image-originals';
import { fileNotFoundError, type FileMeta, type GetResult, type IFileService, type SaveOptions } from '@kiki/agent-core-v2/app/file/fileService';
import type { ISessionMediaStore, SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import type { ContentPart } from '@kiki/agent-core-v2/kosong/contract/message';
import type { ITelemetryService } from '@kiki/agent-core-v2/app/telemetry/telemetry';
import { Error2 } from '@kiki/agent-core-v2/errors';
import type { PromptSubmission } from '../protocol/rest-prompt';
import type { PublishedMediaReader } from '../services/publishedMedia';
import { audioWavAttachmentPath, inspectWav, type WavAudioFormat } from './ffmpegAudio';

type WireContent = PromptSubmission['content'];

/**
 * The prompt-media file view of one session: a `file_id` resolves to the
 * session's canonical media first and falls back to the global staged
 * upload. Accepted prompts keep their media under the same id the upload
 * had, so a queued or historical message stays editable after its staged
 * upload expired or was deleted. Canonical media of another session is not
 * visible here. Saves and deletes stay on the staged store.
 */
export function sessionPromptFiles(staged: IFileService, media: ISessionMediaStore): IFileService {
  function save(source: Readable, name: string, options?: SaveOptions): Promise<FileMeta>;
  function save(source: Readable, name: string, options: () => SaveOptions): Promise<FileMeta>;
  function save(
    source: Readable,
    name: string,
    options?: SaveOptions | (() => SaveOptions),
  ): Promise<FileMeta> {
    if (typeof options === 'function') return staged.save(source, name, options);
    return staged.save(source, name, options);
  }
  return {
    _serviceBrand: undefined,
    save,
    delete: (fileId) => staged.delete(fileId),
    get: async (fileId) => {
      const file = await media.open(fileId);
      if (file === undefined) return staged.get(fileId);
      return {
        meta: { id: fileId, name: file.name, media_type: file.mediaType, size: file.size, created_at: new Date(0).toISOString() },
        stream: (range) => Readable.from(file.stream(range)),
      };
    },
  };
}

async function materializeSessionMedia(media: ISessionMediaStore, file: GetResult): Promise<SessionMediaFile> {
  await media.materialize({
    fileId: file.meta.id,
    size: file.meta.size,
    name: file.meta.name,
    mimeType: file.meta.media_type,
    stream: () => file.stream(),
  });
  const retained = await media.open(file.meta.id);
  if (retained === undefined) {
    throw new Error2('storage.io_failed', 'Failed to save the message attachment. Retry the request.');
  }
  return retained;
}

async function retainSessionMedia(media: ISessionMediaStore | undefined, file: GetResult): Promise<void> {
  if (media === undefined || await media.open(file.meta.id) !== undefined) return;
  await materializeSessionMedia(media, file);
}

/**
 * Fail fast on stale or mis-kinded file references before anything
 * session-scoped happens: a bad `file_id` (unknown, or a real file used with
 * the wrong media kind, e.g. a PDF submitted as a video) must reject the
 * request without creating the prompt agent and without touching the
 * session's model/thinking/permission.
 */
export async function assertPromptFileRefs(content: WireContent, store: IFileService): Promise<void> {
  for (const part of content) {
    if (part.type === 'file') {
      await store.get(part.file_id);
    } else if ((part.type === 'image' || part.type === 'video') && part.source.kind === 'file') {
      const file = await store.get(part.source.file_id);
      assertMediaFile(file, part.type);
    }
  }
}

/**
 * Fail fast on stale `session_media` references: a file id with no canonical
 * copy in this session must reject the request before anything is resolved
 * or mutated. A reference whose canonical copy is not written yet (a queued
 * prompt's upload) resolves through the staged upload and is retained as
 * this session's canonical media. A resolvable reference also backfills the
 * caller's original filename when the request omitted it, so re-sent stored
 * media keeps its name instead of degrading to a synthesized one.
 */
export async function resolvePromptSessionMediaRefs(
  content: WireContent,
  store: ISessionMediaStore,
  readPublishedMedia?: PublishedMediaReader,
  staged?: IFileService,
): Promise<WireContent> {
  const resolved: WireContent = [];
  let changed = false;
  for (const part of content) {
    if (
      (part.type !== 'image' && part.type !== 'video') ||
      part.source.kind !== 'session_media'
    ) {
      resolved.push(part);
      continue;
    }
    const fileId = part.source.file_id;
    const published = fileId.startsWith('inline:') || fileId.startsWith('inline-content:');
    let file = published ? await readPublishedMedia?.(fileId) : await store.open(fileId);
    if (file === undefined && !published && staged !== undefined) {
      const upload = await staged.get(fileId);
      assertMediaFile(upload, part.type);
      file = await materializeSessionMedia(store, upload);
    }
    if (file === undefined) throw fileNotFoundError(fileId);
    if (published) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of file.stream()) { chunks.push(chunk); size += chunk.byteLength; }
      if (size !== file.size || !file.mediaType.startsWith(`${part.type}/`)) {
        throw new Error2('validation.failed', 'The original media attachment is invalid. Reattach the original file and retry.');
      }
      const data = Buffer.concat(chunks).toString('base64');
      if (part.type === 'image' && await validateImageDataUrl(`data:${file.mediaType};base64,${data}`) === null) {
        throw new Error2('validation.failed', 'The original image attachment is invalid. Reattach the original image and retry.');
      }
      resolved.push({ ...part, name: part.name ?? file.name, source: { kind: 'base64', media_type: file.mediaType, data } });
      changed = true;
      continue;
    }
    if (part.name === undefined) {
      resolved.push({ ...part, name: file.name });
      changed = true;
    } else {
      resolved.push(part);
    }
  }
  return changed ? resolved : content;
}

export function contentToCoreParts(content: WireContent): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text, presentation: part.presentation });
    else if (part.type === 'image' && part.source.kind === 'url') parts.push({ type: 'image_url', imageUrl: { url: part.source.url, id: part.source.id, name: part.name } });
    else if (part.type === 'image' && part.source.kind === 'base64') parts.push({ type: 'image_url', imageUrl: { url: `data:${part.source.media_type};base64,${part.source.data}`, name: part.name } });
    else if (part.type === 'image' && part.source.kind === 'session_media') parts.push({ type: 'image_url', imageUrl: { url: buildDaemonFileUrl(part.source.file_id), id: part.source.file_id, name: part.name } });
    else if (part.type === 'video' && part.source.kind === 'url') parts.push({ type: 'video_url', videoUrl: { url: part.source.url, id: part.source.id, name: part.name } });
    else if (part.type === 'video' && part.source.kind === 'base64') parts.push({ type: 'video_url', videoUrl: { url: `data:${part.source.media_type};base64,${part.source.data}`, name: part.name } });
    else if (part.type === 'video' && part.source.kind === 'session_media') parts.push({ type: 'video_url', videoUrl: { url: buildDaemonFileUrl(part.source.file_id), id: part.source.file_id, name: part.name } });
    else if (part.type === 'audio' && part.source.kind === 'url') parts.push({ type: 'audio_url', audioUrl: { url: part.source.url, id: part.source.id, name: part.name } });
    else if (part.type === 'audio' && part.source.kind === 'base64') parts.push({ type: 'audio_url', audioUrl: { url: `data:${part.source.media_type};base64,${part.source.data}`, name: part.name } });
    else if (part.type === 'audio' && (part.source.kind === 'session_media' || part.source.kind === 'file')) parts.push({ type: 'audio_url', audioUrl: { url: buildDaemonFileUrl(part.source.file_id), id: part.source.file_id, name: part.name } });
  }
  return parts;
}

export interface ResolvePromptMediaOptions {
  /**
   * Lazily resolve the session's media-originals dir for persisting the
   * pre-compression bytes of inline base64 images. Only invoked when an image
   * was actually compressed; a failure or undefined result falls back to the
   * shared temp-dir cache.
   */
  readonly resolveOriginalsDir?: () => Promise<string | undefined>;
  /**
   * Lazily resolve the session's attachments dir for materializing arbitrary
   * file uploads into a path the model can open with the Read tool. A failure
   * or undefined result falls back to the shared cache dir.
   */
  readonly resolveAttachmentsDir?: () => Promise<string | undefined>;
  /** Report an `image_compress` event per compressed prompt image. */
  readonly telemetry?: ITelemetryService;
  /**
   * Provider type of the model this request resolves to (`providers.<n>.type`,
   * e.g. `kimi`). Unset falls back to the baseline accepted-format set.
   */
  readonly providerType?: string;
  /**
   * The target session's canonical media store. Every image/video reference
   * the preparation emits is retained there under its file id when the
   * request is accepted, so the message no longer depends on the staged
   * upload while it waits in the queue or after it ran.
   */
  readonly sessionMedia?: ISessionMediaStore;
}

export interface PromptMediaPreparation {
  readonly content: WireContent;
  /** Output spans keyed by the original non-text input slot, including inserted captions and file notices. */
  readonly sourceRanges: readonly { index: number; start: number; end: number }[];
  /**
   * Delete the transient daemon uploads this preparation created (the
   * compressed re-save). Call on failure, or after the engine has either
   * materialized the Session-owned copy or terminally rejected the prompt.
   */
  readonly discard: () => Promise<void>;
}

/**
 * Resolve a wire content list's media/file references into their final wire
 * form: uploaded files materialize to a session-local path notice, supported
 * images retain the existing compression path, unsupported originals remain
 * machine-readable media references, and image/video uploads enter context as
 * bare internal `kimi-file://` references. The preparation's `content` is the
 * input array unchanged when nothing needed resolving; `discard` rolls back
 * or releases the daemon uploads the preparation created after intake.
 */
export async function resolvePromptMediaFiles(
  input: WireContent,
  store: IFileService,
  cacheDir: string,
  options: ResolvePromptMediaOptions = {},
): Promise<PromptMediaPreparation> {
  const files = options.sessionMedia === undefined ? store : sessionPromptFiles(store, options.sessionMedia);
  const resolvedFiles = new Map<string, Promise<GetResult>>();
  const attachmentPaths = new Map<string, Promise<string>>();
  const attachmentNotes = new Set<string>();
  const getFile = (fileId: string): Promise<GetResult> => {
    let pending = resolvedFiles.get(fileId);
    if (pending === undefined) {
      pending = files.get(fileId);
      resolvedFiles.set(fileId, pending);
    }
    return pending;
  };
  const materialize = (file: GetResult, dir: string): Promise<string> => {
    let pending = attachmentPaths.get(file.meta.id);
    if (pending === undefined) {
      pending = materializeAttachmentToDir(file, dir);
      attachmentPaths.set(file.meta.id, pending);
    }
    return pending;
  };
  const ownedFileIds = new Set<string>();
  let discarded = false;
  const discard = async (): Promise<void> => {
    if (discarded) return;
    discarded = true;
    await Promise.all(
      [...ownedFileIds].map((fileId) => store.delete(fileId).catch(() => undefined)),
    );
  };
  let changed = false;
  let originalsDir: string | undefined;
  let originalsDirResolved = false;
  const resolveOriginalsDir = async (): Promise<string | undefined> => {
    if (!originalsDirResolved) {
      originalsDirResolved = true;
      originalsDir = await options.resolveOriginalsDir?.().catch(() => undefined);
    }
    return originalsDir;
  };
  let attachmentsDir: string | undefined;
  let attachmentsDirResolved = false;
  const resolveAttachmentsDir = async (): Promise<string> => {
    if (!attachmentsDirResolved) {
      attachmentsDirResolved = true;
      attachmentsDir = await options.resolveAttachmentsDir?.().catch(() => undefined);
    }
    return attachmentsDir ?? cacheDir;
  };
  const telemetryFor = (source: string): ImageCompressionTelemetry | undefined =>
    options.telemetry === undefined ? undefined : { client: options.telemetry, source };
  const content: WireContent = [];
  const addAttachmentNote = (input: { readonly path: string; readonly name: string; readonly mediaType: string; readonly size: number; readonly kind: 'audio' | 'file'; readonly audioFormat?: string }): void => {
    if (attachmentNotes.has(input.path)) return;
    attachmentNotes.add(input.path);
    const name = sanitizeAttachmentName(input.name);
    const text = input.kind === 'audio'
      ? buildAttachedAudioNotice(name, input.audioFormat ?? input.mediaType, input.size, input.path)
      : buildAttachedFileNotice(name, input.mediaType, input.size, input.path);
    content.push({
      type: 'text', text,
      presentation: { spans: [{ start: 0, end: text.length, kind: 'attachment', attachment: { path: input.path, name, mime: input.mediaType, size: input.size } }] },
    });
  };
  const sourceStarts: number[] = [];
  try {
    for (const part of input) {
      sourceStarts.push(content.length);
      if (part.type === 'image' && part.source.kind === 'base64') {
        const effectiveMime = resolveEffectiveImageMime(
          part.source.media_type,
          decodeBase64Prefix(part.source.data),
        );
        const canonicalMime = normalizeImageMime(effectiveMime);
        if (!isModelAcceptedImageMime(canonicalMime, options.providerType)) {
          const bytes = Buffer.from(part.source.data, 'base64');
          const saved = await store.save(
            Readable.from(bytes),
            part.name ?? `image.${imageExtensionForMime(canonicalMime)}`,
            { mimeType: canonicalMime },
          );
          ownedFileIds.add(saved.id);
          await retainSessionMedia(options.sessionMedia, await store.get(saved.id));
          content.push({
            type: 'image',
            source: { kind: 'url', url: buildDaemonFileUrl(saved.id) },
            name: part.name,
          });
          changed = true;
          continue;
        }
        const compressed = await compressBase64ForModel(part.source.data, canonicalMime, {
          telemetry: telemetryFor('prompt_inline'),
        });
        if (compressed.changed) {
          const dir = await resolveOriginalsDir();
          const originalPath = await persistOriginalImage(
            Buffer.from(part.source.data, 'base64'),
            part.source.media_type,
            { dir },
          );
          const text = buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: part.source.media_type,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          });
          content.push({
            type: 'text',
            text,
            presentation: { spans: [{ start: 0, end: text.length, kind: 'image_compression' }] },
          });
          content.push({
            type: 'image',
            source: { kind: 'base64', media_type: compressed.mimeType, data: compressed.base64 },
            name: part.name,
          });
          changed = true;
        } else {
          content.push(part);
        }
        continue;
      }

      if (part.type === 'image' && part.source.kind === 'url') {
        content.push(part);
        continue;
      }

      if ((part.type === 'image' || part.type === 'video') && part.source.kind === 'session_media') {
        const file = await getFile(part.source.file_id);
        assertMediaFile(file, part.type);
        const attachedPath = await materialize(file, await resolveAttachmentsDir());
        addAttachmentNote({ path: attachedPath, name: file.meta.name, mediaType: file.meta.media_type, size: file.meta.size, kind: 'file' });
        content.push({ ...part, name: sanitizeAttachmentName(part.name ?? file.meta.name) });
        changed = true;
        continue;
      }

      if (part.type === 'audio' && (part.source.kind === 'file' || part.source.kind === 'session_media')) {
        const fileId = part.source.file_id;
        const file = await getFile(fileId);
        if (part.source.kind === 'file' && options.sessionMedia !== undefined) await retainSessionMedia(options.sessionMedia, file);
        const dir = await resolveAttachmentsDir();
        const wavPath = audioWavAttachmentPath(dir, file.meta.id);
        const wavFormat = await inspectWav(wavPath);
        const wav = wavFormat !== undefined;
        if (part.source.kind === 'file') assertAudioFile(file, false);
        else if (!wav) assertAudioFile(file, true);
        const originalPath = await materialize(file, dir);
        addAttachmentNote({ path: originalPath, name: file.meta.name, mediaType: file.meta.media_type, size: file.meta.size, kind: 'audio' });
        const wavName = `${file.meta.name.replace(/\.[^./\\]*$/u, '')}.wav`;
        const name = sanitizeAttachmentName(wav ? wavName : file.meta.name);
        const mediaType = wav ? 'audio/wav' : file.meta.media_type;
        const attachedPath = wav ? wavPath : originalPath;
        const size = wav ? (await stat(wavPath)).size : file.meta.size;
        const audioFormat = wavFormat === undefined ? undefined : describeWavFormat(wavFormat);
        if (wav) addAttachmentNote({ path: attachedPath, name, mediaType, size, kind: 'audio', audioFormat });
        content.push({ ...part, name: sanitizeAttachmentName(part.name ?? file.meta.name),
          source: part.source.kind === 'file' && options.sessionMedia !== undefined ? { kind: 'session_media', file_id: fileId } : part.source });
        changed = true;
        continue;
      }

      if (part.type === 'file') {
        const file = await getFile(part.file_id);
        const attachedPath = await materialize(file, await resolveAttachmentsDir());
        addAttachmentNote({ path: attachedPath, name: file.meta.name, mediaType: file.meta.media_type, size: file.meta.size, kind: 'file' });
        changed = true;
        continue;
      }

      if ((part.type !== 'image' && part.type !== 'video') || (part.source.kind !== 'file' && part.source.kind !== 'session_media')) {
        content.push(part);
        continue;
      }

      const file = await getFile(part.source.file_id);
      assertMediaFile(file, part.type);
      if (part.source.kind === 'file' && options.sessionMedia !== undefined) await retainSessionMedia(options.sessionMedia, file);
      const attachedPath = await materialize(file, await resolveAttachmentsDir());
      addAttachmentNote({ path: attachedPath, name: file.meta.name, mediaType: file.meta.media_type, size: file.meta.size, kind: 'file' });
      if (part.type === 'image') {
        const data = await readFileOrStream(file);
        let mediaType = file.meta.media_type;
        mediaType = resolveEffectiveImageMime(mediaType, data);
        mediaType = normalizeImageMime(mediaType);
        const compressed = await compressImageForModel(data, mediaType, {
          telemetry: telemetryFor('prompt_file'),
        });
        if (compressed.changed) {
          const dir = await resolveOriginalsDir();
          const originalPath = await persistOriginalImage(data, mediaType, { dir });
          const text = buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: mediaType,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          });
          content.push({
            type: 'text',
            text,
            presentation: { spans: [{ start: 0, end: text.length, kind: 'image_compression' }] },
          });
        }
        let finalFile = file;
        if (compressed.changed) {
          const saved = await store.save(
            Readable.from(Buffer.from(compressed.data)),
            compressedUploadName(file.meta.name, compressed.mimeType),
            { mimeType: compressed.mimeType },
          );
          ownedFileIds.add(saved.id);
          finalFile = await store.get(saved.id);
        }
        await retainSessionMedia(options.sessionMedia, finalFile);
        content.push({
          type: 'image',
          source: { kind: 'url', url: buildDaemonFileUrl(finalFile.meta.id) },
          name: sanitizeAttachmentName(part.name ?? file.meta.name),
        });
        changed = true;
        continue;
      }

      await retainSessionMedia(options.sessionMedia, file);
      content.push({
        type: 'video',
        source: { kind: 'url', url: buildDaemonFileUrl(file.meta.id) },
        name: part.name ?? file.meta.name,
      });
      changed = true;
    }
    const sourceRanges = input.flatMap((part, index) => part.type === 'text' ? [] : [{
      index, start: sourceStarts[index]!, end: sourceStarts[index + 1] ?? content.length,
    }]);
    return { content: changed ? content : input, sourceRanges, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

function compressedUploadName(originalName: string, mimeType: string): string {
  const base = originalName.replace(/\.[^./\\]*$/, '');
  return `${base.length > 0 ? base : 'image'}.${imageExtensionForMime(mimeType)}`;
}

const ATTACHMENT_NAME_MAX = 100;

export function sanitizeAttachmentName(name: string): string {
  let cleaned = name
    .replaceAll(/[\\/:*?"<>|]/g, '_')
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[ .]+$/u, '')
    .slice(0, ATTACHMENT_NAME_MAX);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.length > 0 ? cleaned : 'attachment';
}

async function materializeAttachmentToDir(file: GetResult, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

function imageExtensionForMime(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.toLowerCase().split('+')[0] ?? '';
  const ext = subtype.replaceAll(/[^a-z0-9-]/g, '');
  return ext.length > 0 ? ext : 'img';
}

function buildAttachedFileNotice(name: string, mediaType: string, size: number, path: string): string {
  return `Attached file "${name}" (${mediaType}, ${size} bytes): ${path} — open it with the Read tool`;
}

function describeWavFormat(format: WavAudioFormat): string {
  if (format.audioFormat === 1 && format.channels === 1 && format.sampleRate === 16_000 && format.bitsPerSample === 16) {
    return '16 kHz mono 16-bit PCM WAV';
  }
  const channels = `${format.channels} channel${format.channels === 1 ? '' : 's'}`;
  const codec = format.audioFormat === 1 ? 'PCM' : `format ${format.audioFormat}`;
  return `unconverted WAV source (${format.sampleRate} Hz, ${channels}, ${format.bitsPerSample}-bit ${codec}; not normalized for ASR)`;
}

function buildAttachedAudioNotice(name: string, mediaType: string, size: number, path: string): string {
  return `Attached audio "${name}" (${mediaType}, ${size} bytes): ${path} — listen with an audio-capable tool or use this path`;
}

async function readFileOrStream(file: GetResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream()) {
    chunks.push(Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}

function assertMediaFile(file: GetResult, expected: 'image' | 'video'): void {
  const prefix = expected === 'video' ? 'video/' : 'image/';
  if (file.meta.media_type.toLowerCase().startsWith(prefix)) return;
  throw new Error2(
    'validation.failed',
    `file ${file.meta.id} is ${file.meta.media_type}, not ${expected === 'video' ? 'a video' : 'an image'}`,
  );
}

function assertAudioFile(file: GetResult, canonical: boolean): void {
  const mediaType = file.meta.media_type.toLowerCase();
  if (mediaType.startsWith('audio/') || canonical && mediaType === 'application/octet-stream') return;
  throw new Error2('validation.failed', `file ${file.meta.id} is ${file.meta.media_type}, not audio`);
}

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { compressImageForModel, MAX_IMAGE_DECODE_BYTES } from '@kiki/agent-core-v2/agent/media/image-compress';
import { sniffMediaFromMagic } from '@kiki/agent-core-v2/agent/media/file-type';
import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';

import { MEDIA_PREVIEW_MAX_BYTES } from '@kiki/protocol';

export const MEDIA_PREVIEW_BYTES = MEDIA_PREVIEW_MAX_BYTES;
export const MEDIA_PREVIEW_EDGE = 768;

export class MediaPreviewUnavailableError extends Error {}

export async function createMediaPreview(file: SessionMediaFile, mediaType: string | undefined, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
  signal.throwIfAborted();
  if (file.size === 0) throw new MediaPreviewUnavailableError('This media is empty. Open or download the original.');
  let mime = file.mediaType === 'application/octet-stream' ? mediaType : file.mediaType;
  if (mime === undefined || mime === 'application/octet-stream') {
    for await (const chunk of file.stream({ start: 0, end: Math.min(511, file.size - 1) })) {
      signal.throwIfAborted();
      mime = sniffMediaFromMagic(chunk)?.mimeType;
      break;
    }
  }
  if (mime?.startsWith('video/')) return { bytes: await videoPoster(file, signal), mime: 'image/jpeg' };
  if (!mime?.startsWith('image/')) throw new MediaPreviewUnavailableError('This media has no image preview. Open or download the original.');
  if (file.size > MAX_IMAGE_DECODE_BYTES) throw new MediaPreviewUnavailableError('This image is too large to decode as a preview. Open or download the original.');
  const bytes = await readPreviewSource(file, signal);
  const sourceMime = sniffMediaFromMagic(bytes)?.mimeType ?? mime;
  const image = await compressImageForModel(bytes, sourceMime, { maxEdge: MEDIA_PREVIEW_EDGE, byteBudget: MEDIA_PREVIEW_BYTES, maxDecodeBytes: MAX_IMAGE_DECODE_BYTES, outputMimes: new Set(['image/jpeg']), acceptedMimes: new Set(['image/png', 'image/jpeg']) });
  signal.throwIfAborted();
  if (image.data.byteLength > MEDIA_PREVIEW_BYTES || image.width <= 0 || image.height <= 0 || image.width > MEDIA_PREVIEW_EDGE || image.height > MEDIA_PREVIEW_EDGE) throw new MediaPreviewUnavailableError('This image could not be reduced to a small preview. Open or download the original.');
  return { bytes: image.data, mime: image.mimeType };
}

async function readPreviewSource(file: SessionMediaFile, signal: AbortSignal): Promise<Uint8Array> {
  const input = Readable.from(file.stream());
  const onAbort = () => input.destroy(new Error('Media preview cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const value of input) {
      signal.throwIfAborted();
      const chunk = value as Uint8Array;
      size += chunk.byteLength;
      if (size > MAX_IMAGE_DECODE_BYTES) throw new MediaPreviewUnavailableError('Image preview decode limit exceeded. Open or download the original.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', onAbort);
    input.destroy();
  }
}

function videoPoster(file: SessionMediaFile, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=384:384:force_original_aspect_ratio=decrease', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '8', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const source = Readable.from(file.stream());
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      source.destroy();
      child.stdin.destroy();
      if (error !== undefined) { child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks, size));
    };
    const onAbort = () => finish(new Error('Media preview cancelled'));
    const timer = setTimeout(() => finish(new MediaPreviewUnavailableError('Video preview timed out. Open or download the original.')), 10_000);
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(new MediaPreviewUnavailableError('Video previews require ffmpeg. Open or download the original.')));
    child.stdout.on('data', (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > MEDIA_PREVIEW_BYTES) finish(new MediaPreviewUnavailableError('Video preview exceeded its size budget. Open or download the original.'));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => source.destroy());
    source.on('error', () => finish(new MediaPreviewUnavailableError('Video source could not be read. Open or download the original.')));
    child.on('close', (code) => finish(code === 0 && size > 0 ? undefined : new MediaPreviewUnavailableError('Video preview could not be decoded. Open or download the original.')));
    if (signal.aborted) onAbort();
    else source.pipe(child.stdin);
  });
}

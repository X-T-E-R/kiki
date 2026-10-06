import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { sniffImageDimensions } from '@kiki/agent-core-v2/agent/media/file-type';
import { createMediaPreview, MEDIA_PREVIEW_BYTES, MEDIA_PREVIEW_EDGE } from '../src/services/mediaPreview';

function bitmap(width: number, height: number): Uint8Array {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34);
  for (let offset = 54; offset < bytes.length; offset += 3) bytes[offset + 2] = 255;
  return bytes;
}

describe('source-generated media preview', () => {
  it('creates a small video poster using the installed ffmpeg source pipeline', async () => {
    const video = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=800x600:d=0.1', '-c:v', 'mpeg4', '-f', 'matroska', 'pipe:1'], { windowsHide: true });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`fixture ffmpeg failed: ${code}`)));
    });
    const poster = await createMediaPreview({ name: 'isolated.mkv', mediaType: 'video/x-matroska', size: video.byteLength, stream: async function* () { yield video; } }, undefined, new AbortController().signal);
    expect(poster.mime).toBe('image/jpeg');
    expect(poster.bytes.byteLength).toBeLessThanOrEqual(MEDIA_PREVIEW_BYTES);
    expect(sniffImageDimensions(poster.bytes)?.width).toBeLessThanOrEqual(MEDIA_PREVIEW_EDGE);
    expect(sniffImageDimensions(poster.bytes)?.height).toBeLessThanOrEqual(MEDIA_PREVIEW_EDGE);
  });

  it('does not report invalid encoded image data as a successful preview', async () => {
    await expect(createMediaPreview({ name: 'invalid.png', mediaType: 'image/png', size: 4, stream: async function* () { yield new Uint8Array([1, 2, 3, 4]); } }, undefined, new AbortController().signal)).rejects.toThrow();
  });
  it('preserves the exact PNG bytes above the old 64 KiB gate without recoding, using magic rather than an incorrect MIME hint', async () => {
    const fixture = new URL('../../../apps/kiki-gui/fixtures/sent-images.scenario.mjs', import.meta.url).href;
    const { pictures } = await import(fixture);
    const original: Buffer = pictures[1].bytes;
    expect(original.byteLength).toBeGreaterThan(64 * 1024);
    expect(original.byteLength).toBeLessThanOrEqual(MEDIA_PREVIEW_BYTES);
    const preview = await createMediaPreview({ name: 'example.bin', mediaType: 'image/jpeg', size: original.byteLength, stream: async function* () { yield original; } }, undefined, new AbortController().signal);
    expect(preview.mime).toBe('image/png');
    expect(preview.bytes).toEqual(original);
  });

  it('compresses the source image to a small preview before any client original read', async () => {
    const original = bitmap(800, 600);
    let reads = 0;
    const preview = await createMediaPreview({ name: 'isolated.bmp', mediaType: 'image/bmp', size: original.byteLength, stream: async function* () { reads += 1; yield original; } }, undefined, new AbortController().signal);
    expect(reads).toBe(1);
    expect(original.byteLength).toBeGreaterThan(1024 * 1024);
    expect(preview.bytes.byteLength).toBeLessThanOrEqual(MEDIA_PREVIEW_BYTES);
    expect(preview.mime).toBe('image/jpeg');
    const dimensions = sniffImageDimensions(preview.bytes);
    expect(dimensions?.width).toBeLessThanOrEqual(MEDIA_PREVIEW_EDGE);
    expect(dimensions?.height).toBeLessThanOrEqual(MEDIA_PREVIEW_EDGE);
  });

  it('does not read a 300 MiB source image merely to attempt a thumbnail', async () => {
    let read = false;
    await expect(createMediaPreview({ name: 'large.png', mediaType: 'image/png', size: 300 * 1024 * 1024, stream: async function* () { read = true; yield new Uint8Array(1); } }, undefined, new AbortController().signal)).rejects.toThrow('Open or download the original');
    expect(read).toBe(false);
  });

  it.skipIf(process.env['KIKI_SENT_IMAGE_PROOF'] !== '1')('decodes sent images through real HTTP routes in the full GUI and cold-reloads them', async () => {
    const proof = new URL('../../../apps/kiki-gui/scripts/sent-image-proof.mts', import.meta.url).href;
    await import(proof);
  }, 180_000);

  it('aborts the source iterator while a preview body is being read', async () => {
    const abort = new AbortController();
    let closed = false;
    await expect(createMediaPreview({ name: 'isolated.png', mediaType: 'image/png', size: 1024, stream: async function* () { try { yield new Uint8Array(512); abort.abort(); yield new Uint8Array(512); } finally { closed = true; } } }, undefined, abort.signal)).rejects.toThrow();
    expect(closed).toBe(true);
  });
});

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, checksum]);
}

function encodePng(width, height, rgba) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

export async function installPrerequisite({ consent, destination }) {
  if (consent !== true) throw new Error('Consent required');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, 'pinned fixture binary', { flag: 'wx' });
  return destination;
}

export function handlePanelRequest(action, args, context) {
  if (action !== 'echo') throw new Error('Unsupported panel action');
  return { args, settings: context.settings };
}

export function register(api) {
  api.registerTool({
    schemaVersion: 1,
    name: 'fixture_echo',
    description: 'Echo a value',
    parameters: { type: 'object', properties: { value: { type: 'string' }, large: { type: 'boolean' } } },
    accesses: [{ kind: 'all' }],
  }, async (args, ctx) => {
    ctx.progress({ kind: 'progress', percent: 50, text: 'Halfway' });
    if (args.crash) process.exit(7);
    if (args.cacheDir) return { output: process.env.KIKI_CACHE_DIR ?? '' };
    if (args.kikiHome) return { output: JSON.stringify({ env: process.env.KIKI_HOME, context: ctx.kikiHome }) };
    if (args.context) return { output: JSON.stringify({ workspaceRoot: ctx.workspaceRoot, approvedPaths: ctx.approvedPaths, imageIn: ctx.imageIn, settings: ctx.settings }) };
    if (args.output !== undefined) return { output: args.output };
    if (args.image) return { output: [{ type: 'text', text: 'preview' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } }] };
    if (args.invalidImage) return { output: [{ type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } }] };
    if (args.large) return { output: `${'x'.repeat(16 * 1024 * 1024)}😀tail` };
    if (args.largeImage) {
      const data = Buffer.alloc(1536 * 1536 * 4);
      let state = 0x12345678;
      for (let i = 0; i < data.length; i += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        data[i] = state & 255;
      }
      const png = encodePng(1536, 1536, data);
      return { output: [{ type: 'text', text: `original_sha256: ${createHash('sha256').update(png).digest('hex')}` },
        { type: 'image_url', imageUrl: { url: `data:image/png;base64,${png.toString('base64')}` } }] };
    }

    if (args.wait) await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 30_000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new Error('cancelled')); }, { once: true });
    });
    return { output: String(args.value ?? 'ok') };
  });
}

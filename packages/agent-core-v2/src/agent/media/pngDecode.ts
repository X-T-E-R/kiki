import { crc32, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PIXEL_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const MAX_RECOVERY_PIXELS = 100_000_000;
const MAX_RECOVERY_PIXEL_BYTES = MAX_RECOVERY_PIXELS * 9;
const COLOR_TYPES: Readonly<Record<number, { readonly depths: readonly number[]; readonly channels: number }>> = {
  0: { depths: [1, 2, 4, 8, 16], channels: 1 },
  2: { depths: [8, 16], channels: 3 },
  3: { depths: [1, 2, 4, 8], channels: 1 },
  4: { depths: [8, 16], channels: 2 },
  6: { depths: [8, 16], channels: 4 },
};
const ADAM7_PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

export function pngWithoutAncillaryChunks(bytes: Buffer): Buffer | undefined {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  const chunks = [bytes.subarray(0, 8)];
  const dataChunks: Buffer[] = [];
  let expectedPixelBytes = 0;
  let offset = 8;
  let hasHeader = false;
  let hasData = false;
  let dataEnded = false;
  let removed = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (length > 0x7fffffff || end > bytes.length) return undefined;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/u.test(type)) return undefined;
    const isPixelChunk = PIXEL_CHUNKS.has(type);
    if (isPixelChunk && crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      return undefined;
    }
    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13) return undefined;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      const color = COLOR_TYPES[bytes[offset + 17]!];
      const depth = bytes[offset + 16]!;
      const interlace = bytes[offset + 20]!;
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff ||
        width * height > MAX_RECOVERY_PIXELS ||
        color === undefined || !color.depths.includes(depth) ||
        bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || interlace > 1) return undefined;
      const passes = interlace === 1 ? ADAM7_PASSES : [[0, 0, 1, 1] as const];
      for (const [x, y, dx, dy] of passes) {
        const passWidth = Math.ceil((width - x) / dx);
        const passHeight = Math.ceil((height - y) / dy);
        if (passWidth > 0 && passHeight > 0) {
          expectedPixelBytes += passHeight * (1 + Math.ceil(passWidth * color.channels * depth / 8));
        }
      }
      if (expectedPixelBytes > MAX_RECOVERY_PIXEL_BYTES) return undefined;
      hasHeader = true;
    } else if (type === 'IHDR') return undefined;
    if (type === 'IDAT') {
      if (dataEnded) return undefined;
      hasData ||= length > 0;
      dataChunks.push(bytes.subarray(offset + 8, end - 4));
    } else if (hasData) {
      dataEnded = true;
      if (type === 'PLTE' || type === 'tRNS') return undefined;
    }
    if (isPixelChunk) {
      chunks.push(bytes.subarray(offset, end));
    } else {
      if ((bytes[offset + 4]! & 0x20) === 0) return undefined;
      removed = true;
    }
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || !hasData || !removed) return undefined;
      const pixels = inflateSync(Buffer.concat(dataChunks), { maxOutputLength: expectedPixelBytes });
      if (pixels.length !== expectedPixelBytes) throw new Error('Incomplete PNG pixel data');
      return Buffer.concat(chunks);
    }
    offset = end;
  }
  return undefined;
}

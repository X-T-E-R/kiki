import { crc32, inflateSync } from 'node:zlib';
import { decodeWebp } from './webp-decode';
import { pngWithoutAncillaryChunks } from './pngDecode';

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function tryFastDecodePng(bytes: Uint8Array): { data: Buffer; width: number; height: number } | undefined {
  if (bytes.length < 33) return undefined;
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIG[i]) return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatChunks: Uint8Array[] = [];
  let offset = 8;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = view.getUint32(offset + 4, false);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return undefined;
    const expectedCrc = view.getUint32(dataEnd, false);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd)) >>> 0;
    if (actualCrc !== expectedCrc) return undefined;
    if (type === 0x49484452) {
      if (length !== 13) return undefined;
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      const bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      const compression = bytes[dataStart + 10]!;
      const filter = bytes[dataStart + 11]!;
      const interlace = bytes[dataStart + 12]!;
      if (
        width <= 0 ||
        height <= 0 ||
        width * height > 100_000_000 ||
        bitDepth !== 8 ||
        (colorType !== 2 && colorType !== 6) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        return undefined;
      }
    } else if (type === 0x74524e53) {
      return undefined;
    } else if (type === 0x49444154) {
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 0x49454e44) {
      sawIend = true;
      break;
    } else if ((bytes[offset + 4]! & 0x20) === 0) {
      return undefined;
    }
    offset = dataEnd + 4;
  }
  if (!sawIend || width <= 0 || height <= 0 || idatChunks.length === 0) return undefined;
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const expectedRawLen = height * (stride + 1);
  let raw: Buffer;
  try {
    const joined = idatChunks.length === 1 ? idatChunks[0]! : Buffer.concat(idatChunks);
    raw = inflateSync(joined, { maxOutputLength: expectedRawLen + 1024 });
  } catch {
    return undefined;
  }
  if (raw.length !== expectedRawLen) return undefined;
  const rgba = Buffer.from(new Uint8Array(width * height * 4).buffer);
  const prevRow = new Uint8Array(stride);
  const curRow = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * (stride + 1);
    const filterType = raw[rowOff]!;
    const srcStart = rowOff + 1;
    if (filterType === 0) {
      for (let i = 0; i < stride; i += 1) curRow[i] = raw[srcStart + i]!;
    } else if (filterType === 1) {
      for (let i = 0; i < bpp; i += 1) curRow[i] = raw[srcStart + i]!;
      for (let i = bpp; i < stride; i += 1) curRow[i] = (raw[srcStart + i]! + curRow[i - bpp]!) & 0xff;
    } else if (filterType === 2) {
      for (let i = 0; i < stride; i += 1) curRow[i] = (raw[srcStart + i]! + prevRow[i]!) & 0xff;
    } else if (filterType === 3) {
      for (let i = 0; i < bpp; i += 1) curRow[i] = (raw[srcStart + i]! + (prevRow[i]! >>> 1)) & 0xff;
      for (let i = bpp; i < stride; i += 1) curRow[i] = (raw[srcStart + i]! + ((curRow[i - bpp]! + prevRow[i]!) >>> 1)) & 0xff;
    } else if (filterType === 4) {
      for (let i = 0; i < bpp; i += 1) curRow[i] = (raw[srcStart + i]! + prevRow[i]!) & 0xff;
      for (let i = bpp; i < stride; i += 1) {
        curRow[i] = (raw[srcStart + i]! + paethPredictor(curRow[i - bpp]!, prevRow[i]!, prevRow[i - bpp]!)) & 0xff;
      }
    } else {
      return undefined;
    }
    const dstRowOff = y * width * 4;
    if (bpp === 4) {
      rgba.set(curRow, dstRowOff);
    } else {
      let s = 0;
      let d = dstRowOff;
      for (let x = 0; x < width; x += 1) {
        rgba[d] = curRow[s]!;
        rgba[d + 1] = curRow[s + 1]!;
        rgba[d + 2] = curRow[s + 2]!;
        rgba[d + 3] = 255;
        s += 3;
        d += 4;
      }
    }
    prevRow.set(curRow);
  }
  return { data: rgba, width, height };
}

export async function decodeToJimp(bytes: Uint8Array, normalizedMime: string): Promise<JimpImage> {
  const { Jimp } = await import('jimp');
  if (normalizedMime === 'image/webp') {
    const decoded = await decodeWebp(bytes);
    return Jimp.fromBitmap({
      data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height,
    });
  }
  if (normalizedMime === 'image/png') {
    const fast = tryFastDecodePng(bytes);
    if (fast !== undefined) {
      return Jimp.fromBitmap(fast);
    }
  }
  const buffer = Buffer.from(bytes);
  try {
    return await Jimp.fromBuffer(buffer);
  } catch (error) {
    if (normalizedMime !== 'image/png') throw error;
    const stripped = pngWithoutAncillaryChunks(buffer);
    if (stripped === undefined) throw error;
    return Jimp.fromBuffer(stripped);
  }
}

export async function decodeImageVerdict(bytes: Uint8Array, mimeType: string): Promise<boolean> {
  try { await decodeToJimp(bytes, mimeType); return true; }
  catch { return false; }
}

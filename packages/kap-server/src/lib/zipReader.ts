import { inflateRawSync } from 'node:zlib';

/** One file read out of an archive. */
export interface ZipFileEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** Ceilings the reader enforces before any byte is inflated. */
export interface ZipReadLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: (name: string) => number;
}

/** A structural or policy refusal; the message is safe to show a user. */
export class ZipReadError extends Error {}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const floor = Math.max(0, buffer.byteLength - 22 - 0xffff);
  for (let index = buffer.byteLength - 22; index >= floor; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new ZipReadError('not a zip archive');
}

/**
 * Read every regular file of a zip held in memory. Stored and deflated entries
 * only; encrypted, zip64 and multi-disk archives are refused. Directory entries
 * are skipped. Declared sizes are checked against the limits before inflating,
 * and inflation itself is capped, so a lying header cannot become a bomb.
 */
export function readZipEntries(buffer: Buffer, limits: ZipReadLimits): ZipFileEntry[] {
  if (buffer.byteLength < 22) throw new ZipReadError('not a zip archive');
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || count === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipReadError('multi-disk and zip64 archives are not supported');
  }
  if (count > limits.maxEntries) throw new ZipReadError(`archive has more than ${limits.maxEntries} entries`);
  if (centralOffset + centralSize > end) throw new ZipReadError('corrupt zip central directory');

  const entries: ZipFileEntry[] = [];
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new ZipReadError('corrupt zip central directory');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf-8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if ((flags & 0x1) !== 0) throw new ZipReadError(`${name}: encrypted entries are not supported`);
    if (method !== 0 && method !== 8) throw new ZipReadError(`${name}: unsupported compression`);
    if (size === 0xffffffff || compressed === 0xffffffff) throw new ZipReadError('zip64 archives are not supported');
    if (size > limits.maxEntryBytes(name)) throw new ZipReadError(`${name}: file is too large`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipReadError('archive contents are too large');

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipReadError(`${name}: corrupt local header`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    if (raw.byteLength !== compressed) throw new ZipReadError(`${name}: truncated entry`);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    } catch {
      throw new ZipReadError(`${name}: could not decompress`);
    }
    if (data.byteLength !== size) throw new ZipReadError(`${name}: size does not match its header`);
    entries.push({ name, data });
  }
  return entries;
}

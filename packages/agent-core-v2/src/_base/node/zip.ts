import { crc32, inflateRawSync } from 'node:zlib';

import { ZipFile } from 'yazl';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

/** One file to place in an archive. */
export interface ZipBufferEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** One file to place in a stored (uncompressed) zip archive. */
export interface StoredZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** One file read out of an archive. */
export interface ZipFileEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** Ceilings the in-memory zip reader enforces before any byte is inflated. */
export interface ZipReadLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: (name: string) => number;
}

/** Ceilings the bounded yauzl buffer reader enforces while reading entries. */
export interface YauzlBufferLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
  readonly maxEntryBytes?: number;
  readonly rejectSymlinks?: boolean;
  readonly normalizeBackslashes?: boolean;
}

/** A structural or policy refusal; the message is safe to show a user. */
export class ZipReadError extends Error {}

/** Check that a ZIP entry name cannot escape an extraction root (Zip-Slip guard). */
export function isSafeZipEntryPath(name: string): boolean {
  if (name.length === 0 || name.includes('\0')) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((segment) => segment === '..');
}

function dosDateTime(date: Date): { time: number; day: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Build a zip whose entries are stored without compression. Already-compressed
 * media pays no deflate CPU cost while staying dependency-free via `node:zlib` CRC32.
 */
export function buildStoredZip(entries: readonly StoredZipEntry[], now: Date = new Date()): Buffer {
  const { time, day } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const checksum = crc32(entry.data) >>> 0;
    const size = entry.data.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + size;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const floor = Math.max(0, buffer.byteLength - 22 - 0xffff);
  for (let index = buffer.byteLength - 22; index >= floor; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new ZipReadError('not a zip archive');
}

/**
 * Read every regular file of a zip held in memory. Stored and deflated entries
 * only; encrypted, zip64, multi-disk, and unsafe Zip-Slip paths are refused.
 * Directory entries are skipped. Declared sizes are checked against the limits
 * before inflating, and inflation itself is capped so a lying header cannot bomb.
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
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ZipReadError('corrupt zip central directory');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (nextCursor > end) throw new ZipReadError('corrupt zip central directory');
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf-8');
    cursor = nextCursor;

    if (!isSafeZipEntryPath(name)) throw new ZipReadError(`${name}: unsafe archive path`);
    if (name.endsWith('/')) continue;
    if ((flags & 0x1) !== 0) throw new ZipReadError(`${name}: encrypted entries are not supported`);
    if (method !== 0 && method !== 8) throw new ZipReadError(`${name}: unsupported compression`);
    if (size === 0xffffffff || compressed === 0xffffffff) throw new ZipReadError('zip64 archives are not supported');
    if (size > limits.maxEntryBytes(name)) throw new ZipReadError(`${name}: file is too large`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipReadError('archive contents are too large');

    if (localOffset + 30 > buffer.byteLength || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipReadError(`${name}: corrupt local header`);
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressed > buffer.byteLength) throw new ZipReadError(`${name}: truncated entry`);
    const raw = buffer.subarray(dataStart, dataStart + compressed);
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

/** Build a compressed zip buffer in memory using `yazl`. */
export async function buildZipBuffer(entries: readonly ZipBufferEntry[]): Promise<Uint8Array> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const stream = zip.outputStream;
  const output = new Promise<Uint8Array>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(Uint8Array.from(Buffer.concat(chunks))));
  });
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.name);
  zip.end();
  return output;
}

/** Read a zip archive from memory via `yauzl` with Zip-Slip and expanded-size limits. */
export async function readZipBuffer(
  bytes: Uint8Array,
  limits: YauzlBufferLimits,
): Promise<Map<string, Uint8Array>> {
  const maxEntryBytes = limits.maxEntryBytes ?? limits.maxUncompressedBytes;
  return new Promise((resolve, reject) => {
    const result = new Map<string, Uint8Array>();
    let count = 0;
    let total = 0;
    let settled = false;
    yauzlFromBuffer(Buffer.from(bytes), { lazyEntries: true }, (openError, zipfile) => {
      if (openError !== null || zipfile === undefined) {
        reject(new ZipReadError(openError?.message ?? 'Unable to open zip archive', { cause: openError ?? undefined }));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error instanceof Error ? error : new ZipReadError(String(error)));
      };
      zipfile.on('error', fail);
      zipfile.on('entry', (entry: Entry) => {
        if (settled) return;
        count += 1;
        if (count > limits.maxEntries) {
          fail(new ZipReadError(`Archive exceeds the ${limits.maxEntries}-entry limit`));
          return;
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          fail(new ZipReadError(`Encrypted zip entry is not supported: ${entry.fileName}`));
          return;
        }
        if (limits.rejectSymlinks !== false && ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
          fail(new ZipReadError(`Archive contains a symbolic link: ${entry.fileName}`));
          return;
        }
        if (!isSafeZipEntryPath(entry.fileName)) {
          fail(new ZipReadError(`Archive contains an unsafe path: ${entry.fileName}`));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        if (entry.uncompressedSize > maxEntryBytes) {
          fail(new ZipReadError(`Archive entry exceeds size limit: ${entry.fileName}`));
          return;
        }
        if (total + entry.uncompressedSize > limits.maxUncompressedBytes) {
          fail(new ZipReadError('Archive exceeds its expanded-size limit'));
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            fail(streamError ?? new ZipReadError(`Unable to read ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          let entryBytes = 0;
          stream.on('data', (chunk: Buffer) => {
            if (settled) return;
            entryBytes += chunk.byteLength;
            total += chunk.byteLength;
            if (entryBytes > maxEntryBytes || total > limits.maxUncompressedBytes) {
              stream.destroy();
              fail(new ZipReadError('Archive exceeds its expanded-size limit'));
              return;
            }
            chunks.push(chunk);
          });
          stream.once('error', fail);
          stream.once('end', () => {
            if (settled) return;
            const key = limits.normalizeBackslashes === false
              ? entry.fileName
              : entry.fileName.replaceAll('\\', '/');
            result.set(key, Uint8Array.from(Buffer.concat(chunks)));
            zipfile.readEntry();
          });
        });
      });
      zipfile.once('end', () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      });
      zipfile.readEntry();
    });
  });
}

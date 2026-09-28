import { open, stat } from 'node:fs/promises';
import { OfficeError } from './paths.mjs';

const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const MAX_PARTS = 10_000;
const KNOWN_BINARY = /\.(?:png|jpe?g|gif|bmp|tiff?|svg|emf|wmf|webp|mp3|mp4|wav)$/i;
const TEXT_PART = /\.(?:xml|rels|vml|txt|json)$/i;

export async function guardPackage(file) {
  const size = (await stat(file)).size;
  if (size > MAX_ARCHIVE) throw new OfficeError('PACKAGE_LIMIT', 'Office document exceeds 256 MiB.', 'Choose a smaller document.');
  const handle = await open(file, 'r');
  try {
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let end = -1;
    for (let index = tailSize - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tailSize) { end = index; break; }
    }
    if (end < 0) throw new OfficeError('PACKAGE_INVALID', 'Office document has no valid ZIP central directory.', 'Use an uncorrupted Office document.');
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff || count > MAX_PARTS || directorySize > 2 * 1024 * 1024 || offset + directorySize > size) {
      throw new OfficeError('PACKAGE_LIMIT', 'Office document ZIP directory exceeds safe limits or uses ZIP64.', 'Choose a smaller Office document.');
    }
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, offset);
    let position = 0;
    let total = 0;
    const names = new Set();
    for (let index = 0; index < count; index++) {
      if (position + 46 > directorySize || directory.readUInt32LE(position) !== 0x02014b50) throw new OfficeError('PACKAGE_INVALID', 'Malformed Office ZIP directory.', 'Use an uncorrupted Office document.');
      const flags = directory.readUInt16LE(position + 8);
      const compression = directory.readUInt16LE(position + 10);
      const compressed = directory.readUInt32LE(position + 20);
      const expanded = directory.readUInt32LE(position + 24);
      const nameLength = directory.readUInt16LE(position + 28);
      const extraLength = directory.readUInt16LE(position + 30);
      const commentLength = directory.readUInt16LE(position + 32);
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (next > directorySize) throw new OfficeError('PACKAGE_INVALID', 'Malformed Office ZIP part.', 'Use an uncorrupted Office document.');
      const name = directory.subarray(position + 46, position + 46 + nameLength).toString('utf8');
      if (flags & 1 || ![0, 8].includes(compression) || !name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || names.has(name)) {
        throw new OfficeError('PACKAGE_UNSAFE', `Unsafe Office part: ${name}`, 'Use a document without encrypted, duplicated or traversal ZIP parts.');
      }
      names.add(name);
      total += expanded;
      if (expanded > MAX_PART || total > MAX_ARCHIVE || (compressed === 0 ? expanded > 0 : expanded / compressed > 200)) {
        throw new OfficeError('PACKAGE_LIMIT', `Office part exceeds decompression limits: ${name}`, 'Use a smaller document; avoid extreme ZIP compression ratios.');
      }
      if (!name.endsWith('/') && name !== '[Content_Types].xml' && !TEXT_PART.test(name) && !KNOWN_BINARY.test(name)) {
        throw new OfficeError('UNKNOWN_BINARY_PART', `Unknown Office package part: ${name}`, 'Do not edit this document with Office tools; inspect its embedded parts first.');
      }
      if (name.toLowerCase().endsWith('.bin') || name.startsWith('customXml/') || name.startsWith('word/embeddings/') || name.startsWith('ppt/embeddings/') || name.startsWith('xl/embeddings/')) {
        throw new OfficeError('UNKNOWN_BINARY_PART', `Unsupported embedded Office part: ${name}`, 'Inspect this embedded content in another application before editing.');
      }
      position = next;
    }
    if (position !== directorySize) throw new OfficeError('PACKAGE_INVALID', 'Office ZIP directory has unexpected trailing data.', 'Use an uncorrupted Office document.');
  } finally {
    await handle.close();
  }
}

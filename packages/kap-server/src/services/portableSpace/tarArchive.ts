import { constants as bufferConstants } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;
const MAX_PATH_BYTES = 4096;
const MAX_PAX_BYTES = 1024 * 1024;
const USTAR_MAGIC = 'ustar\0';
const USTAR_VERSION = '00';
const GNU_MAGIC = 'ustar  \0';
const RESERVED_DEVICE_NAMES = new Set([
  'AUX',
  'CLOCK$',
  'CON',
  'CONIN$',
  'CONOUT$',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'NUL',
  'PRN',
]);

/** Canonicalizes a portable archive path and rejects paths that are unsafe on POSIX or Windows. */
export function safePortablePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_BYTES) {
    throw invalidArchiveInput();
  }
  assertWellFormedPath(path);
  const normalized = path.replaceAll('\\', '/').normalize('NFC');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    throw invalidArchiveInput();
  }
  const segments = normalized.split('/');
  const canonical: string[] = [];
  for (const segment of segments) {
    if (segment === '.') {
      continue;
    }
    if (segment.length === 0 || segment === '..') {
      throw invalidArchiveInput();
    }
    assertPortableSegment(segment);
    canonical.push(segment);
  }
  if (canonical.length === 0) {
    throw invalidArchiveInput();
  }
  const result = canonical.join('/');
  if (Buffer.byteLength(result, 'utf8') > MAX_PATH_BYTES) {
    throw invalidArchiveInput();
  }
  return result;
}

/** Packs portable files into deterministic gzip-compressed POSIX ustar bytes. */
export function packTarGz(files: ReadonlyMap<string, Buffer>): Buffer {
  const entries: { readonly path: string; readonly bytes: Buffer }[] = [];
  const seen = new Set<string>();
  let contentBytes = 0;
  for (const [rawPath, value] of files.entries()) {
    const path = safePortablePath(rawPath);
    const alias = path.toLowerCase();
    if (seen.has(alias) || !Buffer.isBuffer(value)) {
      throw invalidArchiveInput();
    }
    seen.add(alias);
    contentBytes += value.byteLength;
    if (!Number.isSafeInteger(contentBytes) || contentBytes > bufferConstants.MAX_LENGTH) {
      throw invalidArchiveInput();
    }
    entries.push({ path, bytes: value });
  }
  assertNoPathOverlap(seen);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
  const chunks: Buffer[] = [];
  let extendedHeaderIndex = 0;
  for (const entry of entries) {
    if (needsPaxPath(entry.path)) {
      const paxBody = encodePaxPath(entry.path);
      const paxHeader = createHeader(`PaxHeaders.0/${extendedHeaderIndex}`, 0o644, paxBody.byteLength, 'x');
      chunks.push(paxHeader, paxBody, zeroPadding(paxBody.byteLength));
      extendedHeaderIndex += 1;
    }
    const headerPath = needsPaxPath(entry.path) ? `file-${extendedHeaderIndex - 1}` : entry.path;
    chunks.push(
      createHeader(headerPath, credentialMode(entry.path), entry.bytes.byteLength, '0'),
      entry.bytes,
      zeroPadding(entry.bytes.byteLength),
    );
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!Number.isSafeInteger(size) || size > bufferConstants.MAX_LENGTH) throw invalidArchiveInput();
  const tar = Buffer.concat(chunks, size);
  const gzip = gzipSync(tar, { level: 9 });
  gzip[4] = 0;
  gzip[5] = 0;
  gzip[6] = 0;
  gzip[7] = 0;
  gzip[8] = 0;
  gzip[9] = 255;
  return gzip;
}

/** Unpacks deterministic or standard gzip-compressed POSIX ustar bytes into portable files. */
export function unpackTarGz(bytes: Buffer): Map<string, Buffer> {
  if (!Buffer.isBuffer(bytes)) {
    throw invalidArchiveInput();
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes);
  } catch {
    throw invalidArchiveInput();
  }
  if (tar.byteLength < BLOCK_SIZE * 2 || tar.byteLength % BLOCK_SIZE !== 0) {
    throw invalidArchiveInput();
  }
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  let offset = 0;
  let contentBytes = 0;
  let pendingPax: { readonly path?: string } | undefined;
  let pendingLongPath: string | undefined;
  let zeroBlocks = 0;
  while (offset + BLOCK_SIZE <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) {
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0 || !validHeaderChecksum(header)) {
      throw invalidArchiveInput();
    }
    const size = readOctal(header, 124, 12);
    if (size > MAX_PAX_BYTES && (header[156] === 76 || header[156] === 120)) {
      throw invalidArchiveInput();
    }
    if (size > tar.byteLength - offset) {
      throw invalidArchiveInput();
    }
    const body = tar.subarray(offset, offset + size);
    const paddedSize = alignBlock(size);
    if (paddedSize > tar.byteLength - offset) {
      throw invalidArchiveInput();
    }
    offset += paddedSize;
    const type = header[156] === 0 ? '0' : String.fromCodePoint(header[156]!);
    if (type === 'x') {
      if (pendingPax !== undefined || pendingLongPath !== undefined) {
        throw invalidArchiveInput();
      }
      pendingPax = parsePax(body);
      continue;
    }
    if (type === 'L') {
      if (pendingPax !== undefined || pendingLongPath !== undefined) {
        throw invalidArchiveInput();
      }
      pendingLongPath = parseGnuLongPath(body);
      continue;
    }
    if (type !== '0' && type !== '5') {
      throw invalidArchiveInput();
    }
    const mode = readOctal(header, 100, 8);
    const fileType = mode & 0o170000;
    const rawPath = pendingLongPath ?? pendingPax?.path ?? readHeaderPath(header);
    pendingPax = undefined;
    pendingLongPath = undefined;
    if (type === '5') {
      if (size !== 0 || (fileType !== 0 && fileType !== 0o040000)) throw invalidArchiveInput();
      if (rawPath !== '.' && rawPath !== './') safePortablePath(rawPath.replace(/\/$/, ''));
      continue;
    }
    if (fileType !== 0 && fileType !== 0o100000) throw invalidArchiveInput();
    const path = safePortablePath(rawPath);
    const alias = path.toLowerCase();
    if (seen.has(alias)) throw invalidArchiveInput();
    seen.add(alias);
    contentBytes += size;
    if (!Number.isSafeInteger(contentBytes) || contentBytes > bufferConstants.MAX_LENGTH) {
      throw invalidArchiveInput();
    }
    files.set(path, Buffer.from(body));
  }
  if (zeroBlocks < 2 || pendingPax !== undefined || pendingLongPath !== undefined) {
    throw invalidArchiveInput();
  }
  for (; offset < tar.byteLength; offset += BLOCK_SIZE) {
    if (!isZeroBlock(tar.subarray(offset, offset + BLOCK_SIZE))) {
      throw invalidArchiveInput();
    }
  }
  assertNoPathOverlap(seen);
  return files;
}

function assertNoPathOverlap(paths: Set<string>): void {
  for (const path of paths) {
    let end = path.lastIndexOf('/');
    while (end > 0) {
      if (paths.has(path.slice(0, end))) throw invalidArchiveInput();
      end = path.lastIndexOf('/', end - 1);
    }
  }
}

function invalidArchiveInput(): Error {
  return new Error('Invalid portable archive');
}

function assertWellFormedPath(value: string): void {
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index)!;
    if ((code >= 0xd800 && code <= 0xdfff) || code < 0x20 || code === 0x7f) {
      throw invalidArchiveInput();
    }
    index += code > 0xffff ? 2 : 1;
  }
}

function assertPortableSegment(segment: string): void {
  if (segment.length === 0 || segment.endsWith('.') || segment.endsWith(' ')) {
    throw invalidArchiveInput();
  }
  if (/[<>:"|?*]/u.test(segment)) {
    throw invalidArchiveInput();
  }
  const portabilityName = segment.normalize('NFKC');
  if (/[<>:"|?*]/u.test(portabilityName)) {
    throw invalidArchiveInput();
  }
  const deviceName = portabilityName.split('.')[0]!.replace(/[. ]+$/u, '').toUpperCase();
  if (
    RESERVED_DEVICE_NAMES.has(deviceName) ||
    /^COM[1-9¹²³]$/u.test(deviceName) ||
    /^LPT[1-9¹²³]$/u.test(deviceName)
  ) {
    throw invalidArchiveInput();
  }
}

function needsPaxPath(path: string): boolean {
  const bytes = Buffer.from(path, 'utf8');
  return bytes.byteLength > 100 || bytes.some((byte) => byte > 0x7f);
}

function credentialMode(path: string): number {
  const segments = path.split('/').map((segment) => segment.toLowerCase());
  if (
    segments.some((segment) =>
      segment === 'credential' ||
      segment === 'credentials' ||
      segment === 'secret' ||
      segment === 'secrets' ||
      segment === 'auth' ||
      segment === 'token' ||
      segment === 'tokens' ||
      /^\.env(?:\.|$)/u.test(segment) ||
      /(?:credential|secret|private[_-]?key|access[_-]?token|auth(?:entication)?)/u.test(segment),
    )
  ) {
    return 0o600;
  }
  if (/\.(?:age|key|pem|p12|pfx|jks|kdbx|keystore|cookie|cookies|session)$/u.test(segments.at(-1)!)) {
    return 0o600;
  }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(segments.at(-1)!)) {
    return 0o600;
  }
  return 0o644;
}

function encodePaxPath(path: string): Buffer {
  const payload = Buffer.from(`path=${path}\n`, 'utf8');
  let length = payload.byteLength + 2;
  for (;;) {
    const next = Buffer.byteLength(String(length), 'ascii') + 1 + payload.byteLength;
    if (next === length) {
      return Buffer.concat([Buffer.from(`${length} `, 'ascii'), payload]);
    }
    length = next;
  }
}

function createHeader(path: string, mode: number, size: number, type: '0' | 'x'): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeField(header, 0, 100, path);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header[156] = type.codePointAt(0)!;
  writeField(header, 257, 6, USTAR_MAGIC);
  writeField(header, 263, 2, USTAR_VERSION);
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeField(header, 148, 8, `${checksumText}\0 `);
  return header;
}

function writeField(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length) {
    throw invalidArchiveInput();
  }
  bytes.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidArchiveInput();
  }
  const digits = value.toString(8);
  if (digits.length + 1 > length) {
    throw invalidArchiveInput();
  }
  writeField(target, offset, length, `${digits.padStart(length - 1, '0')}\0`);
}

function zeroPadding(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

function alignBlock(size: number): number {
  return size + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);
}

function isZeroBlock(block: Buffer): boolean {
  if (block.byteLength !== BLOCK_SIZE) return false;
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function validHeaderChecksum(header: Buffer): boolean {
  const magic = header.toString('ascii', 257, 265);
  if (magic !== `${USTAR_MAGIC}${USTAR_VERSION}` && magic !== GNU_MAGIC) {
    return false;
  }
  let checksum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  try {
    return readOctal(header, 148, 8) === checksum;
  } catch {
    return false;
  }
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const raw = header.subarray(offset, offset + length).toString('ascii').replace(/[\0 ]+$/u, '');
  if (raw.length === 0 || !/^[0-7]+$/u.test(raw)) {
    throw invalidArchiveInput();
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidArchiveInput();
  }
  return value;
}

function readHeaderPath(header: Buffer): string {
  const name = readTextField(header, 0, 100);
  if (header.toString('ascii', 257, 265) !== `${USTAR_MAGIC}${USTAR_VERSION}`) return name;
  const prefix = readTextField(header, 345, 155);
  return prefix.length === 0 ? name : `${prefix}/${name}`;
}

function readTextField(source: Buffer, offset: number, length: number): string {
  const field = source.subarray(offset, offset + length);
  const end = field.indexOf(0);
  const bytes = end === -1 ? field : field.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidArchiveInput();
  }
}

function parseGnuLongPath(body: Buffer): string {
  if (body.byteLength === 0 || body[body.byteLength - 1] !== 0) {
    throw invalidArchiveInput();
  }
  for (let index = 0; index < body.byteLength - 1; index += 1) {
    if (body[index] === 0) throw invalidArchiveInput();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, body.byteLength - 1));
  } catch {
    throw invalidArchiveInput();
  }
}

function parsePax(body: Buffer): { readonly path?: string } {
  let offset = 0;
  let path: string | undefined;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    if (space <= offset) {
      throw invalidArchiveInput();
    }
    const lengthText = body.subarray(offset, space).toString('ascii');
    if (!/^[0-9]+$/u.test(lengthText)) {
      throw invalidArchiveInput();
    }
    const recordLength = Number(lengthText);
    if (!Number.isSafeInteger(recordLength) || recordLength < space - offset + 2 || recordLength > body.byteLength - offset) {
      throw invalidArchiveInput();
    }
    const record = body.subarray(offset, offset + recordLength);
    if (record[record.byteLength - 1] !== 0x0a) {
      throw invalidArchiveInput();
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(space - offset + 1, record.byteLength - 1));
    const equals = content.indexOf('=');
    if (equals <= 0) {
      throw invalidArchiveInput();
    }
    const key = content.slice(0, equals);
    if (key === 'path') {
      if (path !== undefined) {
        throw invalidArchiveInput();
      }
      path = content.slice(equals + 1);
    }
    offset += recordLength;
  }
  return path === undefined ? {} : { path };
}

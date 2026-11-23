import { randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream, type WriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { openPinnedLogicalRead, readPinnedRange } from '@kiki/agent-core-v2';
import type { PortableSpaceSessionSelection } from '@kiki/protocol';
import {
  collectCanonicalSessionSources,
  commitStagedSessionDirectory,
  isAllowedSessionRelativePath,
  refreshSessionIndexAfterImport,
  type CanonicalSessionFileSource,
  type SessionImportRemap,
  type SessionLiveServices,
} from '../portableSpace/liveSpace';
import { checkedPath } from '../portableSpace/spaceFiles';
import { safePortablePath } from '../portableSpace/tarArchive';

const TAR_BLOCK = 512;
const MAX_TAR_LONG_NAME_BYTES = 4096;
const MAX_TAR_PAX_BYTES = 1024 * 1024;
const PINNED_READ_CHUNK_BYTES = 256 * 1024;
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;

function writeOctalField(header: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8);
  const field = `${octal.padStart(length - 1, '0')}\0`;
  header.write(field, offset, length, 'ascii');
}

function writeTarSize(header: Buffer, size: number): void {
  if (size < 0o77777777777) {
    writeOctalField(header, 124, 12, size);
    return;
  }
  header[124] = 0x80;
  let remaining = BigInt(size);
  for (let i = 135; i >= 125; i -= 1) {
    header[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function parseTarSize(header: Buffer): number {
  const first = header[124] ?? 0;
  if ((first & 0x80) !== 0) {
    let total = 0n;
    for (let i = 125; i <= 135; i += 1) {
      total = (total << 8n) | BigInt(header[i] ?? 0);
    }
    const numeric = Number(total);
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      throw new Error('Invalid tar binary size header');
    }
    return numeric;
  }
  const raw = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
  const parsed = raw === '' ? 0 : Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid tar octal size header');
  }
  return parsed;
}

function buildTarHeader(name: string, size: number, typeFlag: string): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  let base = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100 && typeFlag === '0') {
    const splitAt = name.lastIndexOf('/', 155);
    if (splitAt > 0 && Buffer.byteLength(name.slice(0, splitAt)) <= 155 && Buffer.byteLength(name.slice(splitAt + 1)) <= 100) {
      prefix = name.slice(0, splitAt);
      base = name.slice(splitAt + 1);
    } else {
      throw new Error(`Tar entry name too long for ustar header: ${name}`);
    }
  }
  header.write(base, 0, 100, 'utf8');
  writeOctalField(header, 100, 8, 0o644);
  writeOctalField(header, 108, 8, 0);
  writeOctalField(header, 116, 8, 0);
  writeTarSize(header, size);
  writeOctalField(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header.write(typeFlag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix.length > 0) header.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) checksum += header[i]!;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function encodeEntryHeaders(archivePath: string, size: number): Buffer[] {
  const pathBytes = Buffer.from(archivePath, 'utf8');
  if (pathBytes.byteLength <= 100) {
    return [buildTarHeader(archivePath, size, '0')];
  }
  const splitAt = archivePath.lastIndexOf('/', 155);
  if (
    splitAt > 0 &&
    Buffer.byteLength(archivePath.slice(0, splitAt)) <= 155 &&
    Buffer.byteLength(archivePath.slice(splitAt + 1)) <= 100
  ) {
    return [buildTarHeader(archivePath, size, '0')];
  }
  const longNamePayload = Buffer.concat([pathBytes, Buffer.from([0])]);
  const longHeader = buildTarHeader('././@LongLink', longNamePayload.byteLength, 'L');
  const padLen = (TAR_BLOCK - (longNamePayload.byteLength % TAR_BLOCK)) % TAR_BLOCK;
  const fallbackName = archivePath.slice(0, 100);
  return [
    longHeader,
    longNamePayload,
    ...(padLen > 0 ? [Buffer.alloc(padLen)] : []),
    buildTarHeader(fallbackName, size, '0'),
  ];
}

async function writeChunk(stream: PassThrough, chunk: Buffer): Promise<void> {
  if (stream.destroyed) throw new Error('Session archive stream closed');
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Session archive stream closed'));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        stream.off('drain', onDrain);
        stream.off('close', onClose);
        stream.off('error', onError);
      };
      stream.once('drain', onDrain);
      stream.once('close', onClose);
      stream.once('error', onError);
    });
  }
}

async function writeSourcePayload(
  live: SessionLiveServices,
  source: CanonicalSessionFileSource,
  out: PassThrough,
): Promise<number> {
  if (source.bytes !== undefined) {
    await writeChunk(out, source.bytes);
    return source.bytes.byteLength;
  }
  if (source.wireScope !== undefined && live.storage !== undefined) {
    const pinned = await openPinnedLogicalRead(live.storage, source.wireScope, 'wire.jsonl');
    let written = 0;
    try {
      let offset = 0;
      while (offset < source.size) {
        const len = Math.min(PINNED_READ_CHUNK_BYTES, source.size - offset);
        const slice = await readPinnedRange(pinned, offset, len);
        if (slice.byteLength === 0) break;
        await writeChunk(out, Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
        written += slice.byteLength;
        offset += slice.byteLength;
      }
    } finally {
      pinned.close();
    }
    return written;
  }
  if (source.filePath !== undefined) {
    let written = 0;
    const reader = createReadStream(source.filePath);
    const onOutClosed = () => {
      if (!reader.destroyed) reader.destroy();
    };
    out.once('close', onOutClosed);
    out.once('error', onOutClosed);
    try {
      for await (const rawChunk of reader) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as string);
        const remaining = source.size - written;
        if (remaining <= 0) break;
        const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        await writeChunk(out, slice);
        written += slice.byteLength;
      }
    } finally {
      out.off('close', onOutClosed);
      out.off('error', onOutClosed);
      reader.on('error', () => {});
      if (!reader.destroyed) reader.destroy();
    }
    return written;
  }
  return 0;
}

/** Streams selected canonical session files directly into a gzip-compressed tar archive with no fixed size cap. */
export async function exportSessionsTarGzStream(
  live: SessionLiveServices,
  selection: PortableSpaceSessionSelection,
): Promise<Readable> {
  const sources = await collectCanonicalSessionSources(live, selection);
  const tarStream = new PassThrough();
  const gzip = createGzip();
  tarStream.once('error', (err) => {
    if (!gzip.destroyed) gzip.destroy(err);
  });
  gzip.once('close', () => {
    if (!tarStream.destroyed) tarStream.destroy();
  });
  tarStream.pipe(gzip);

  void (async () => {
    try {
      for (const source of sources) {
        for (const block of encodeEntryHeaders(source.archivePath, source.size)) {
          await writeChunk(tarStream, block);
        }
        const written = await writeSourcePayload(live, source, tarStream);
        if (written !== source.size) {
          throw new Error(`Session file size changed during stream export: ${source.archivePath}`);
        }
        const pad = (TAR_BLOCK - (source.size % TAR_BLOCK)) % TAR_BLOCK;
        if (pad > 0) await writeChunk(tarStream, Buffer.alloc(pad));
      }
      await writeChunk(tarStream, Buffer.alloc(TAR_BLOCK * 2));
      tarStream.end();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!tarStream.destroyed) tarStream.destroy(err);
      if (!gzip.destroyed) gzip.destroy(err);
    }
  })();

  return gzip;
}

function parsePaxPath(payload: Buffer): string | undefined {
  let offset = 0;
  let pathValue: string | undefined;
  while (offset < payload.byteLength) {
    const space = payload.indexOf(0x20, offset);
    if (space <= offset) throw new Error('Invalid PAX extended header');
    const recordLength = Number.parseInt(payload.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(recordLength) || recordLength <= space - offset + 1 || offset + recordLength > payload.byteLength) {
      throw new Error('Invalid PAX record length');
    }
    const record = payload.subarray(space + 1, offset + recordLength).toString('utf8');
    if (record.startsWith('path=') && record.endsWith('\n')) {
      pathValue = record.slice('path='.length, -1);
    }
    offset += recordLength;
  }
  return pathValue;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.byteLength; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function verifyTarHeader(header: Buffer): { readonly name: string; readonly size: number; readonly typeFlag: string } {
  const magic = header.subarray(257, 263).toString('ascii');
  if (magic !== 'ustar\0' && magic !== 'ustar ') {
    throw new Error('Invalid ustar archive header');
  }
  const storedRaw = header.subarray(148, 156).toString('ascii').replace(/\0.*$/u, '').trim();
  const stored = Number.parseInt(storedRaw, 8);
  let computed = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    computed += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }
  if (!Number.isFinite(stored) || stored !== computed) {
    throw new Error('Invalid tar header checksum');
  }
  const base = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
  const name = prefix.length > 0 ? `${prefix}/${base}` : base;
  const typeFlag = header.subarray(156, 157).toString('ascii') || '0';
  return { name, size: parseTarSize(header), typeFlag };
}

export interface SessionStreamImportFilter {
  readonly allowedSessionIds?: ReadonlySet<string>;
  readonly maxSessions?: number;
}

/** Streams a gzip-compressed tar archive of canonical sessions directly to staged disk directories and commits updates atomically. */
export async function importSessionsTarGzStream(
  live: SessionLiveServices,
  gzipInput: Readable,
  remap?: SessionImportRemap,
  filter?: SessionStreamImportFilter,
): Promise<{ readonly sessionsApplied: number; readonly sessionsSkipped: number }> {
  const stagingParent = join(dirname(live.bootstrap.sessionsDir), '.sync-staging');
  await mkdir(stagingParent, { recursive: true });
  const stageRoot = join(stagingParent, `stream-${randomBytes(8).toString('hex')}`);
  await mkdir(stageRoot, { recursive: true });
  const stagedSessions = new Map<string, { readonly dir: string; readonly files: { relativePath: string; size: number }[] }>();
  const acceptedSessionOrder: string[] = [];

  try {
    const gunzip = createGunzip();
    const onInputError = (err: Error) => { gunzip.destroy(err); };
    gzipInput.once('error', onInputError);
    gzipInput.pipe(gunzip);

    let mode: 'header' | 'data' | 'pad' | 'longname' | 'pax' = 'header';
    let headerBuf: Buffer = Buffer.alloc(0);
    let remainingData = 0;
    let remainingPad = 0;
    let consecutiveZeroBlocks = 0;
    let sawEndOfArchive = false;
    let pendingLongName: string | undefined;
    let longNameBytes = 0;
    let longNameChunks: Buffer[] = [];
    let paxBytes = 0;
    let paxChunks: Buffer[] = [];
    let currentWriter: WriteStream | undefined;

    const closeWriter = async (): Promise<void> => {
      const writer = currentWriter;
      currentWriter = undefined;
      if (writer === undefined) return;
      await new Promise<void>((resolve, reject) => {
        const onClose = () => {
          writer.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          writer.off('close', onClose);
          reject(err);
        };
        writer.once('close', onClose);
        writer.once('error', onError);
        writer.end();
      });
    };

    const writeToCurrentFile = async (slice: Buffer): Promise<void> => {
      if (currentWriter === undefined) return;
      if (!currentWriter.write(slice)) {
        await new Promise<void>((resolve, reject) => {
          const w = currentWriter!;
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (err: Error) => { cleanup(); reject(err); };
          const cleanup = () => { w.off('drain', onDrain); w.off('error', onError); };
          w.once('drain', onDrain);
          w.once('error', onError);
        });
      }
    };

    try {
      for await (const rawChunk of gunzip) {
        let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as string);
        while (chunk.byteLength > 0) {
          if (mode === 'header') {
            const need = TAR_BLOCK - headerBuf.byteLength;
            const take = Math.min(need, chunk.byteLength);
            headerBuf = headerBuf.byteLength === 0 ? chunk.subarray(0, take) : Buffer.concat([headerBuf, chunk.subarray(0, take)]);
            chunk = chunk.subarray(take);
            if (headerBuf.byteLength < TAR_BLOCK) continue;

            const block = headerBuf;
            headerBuf = Buffer.alloc(0);
            if (isZeroBlock(block)) {
              consecutiveZeroBlocks += 1;
              if (consecutiveZeroBlocks >= 2) sawEndOfArchive = true;
              continue;
            }
            if (consecutiveZeroBlocks > 0) {
              throw new Error('Malformed session tar archive: unexpected block after zero trailer');
            }

            const parsed = verifyTarHeader(block);
            const entryName = pendingLongName ?? parsed.name;
            pendingLongName = undefined;
            remainingPad = (TAR_BLOCK - (parsed.size % TAR_BLOCK)) % TAR_BLOCK;

            if (parsed.typeFlag === 'L') {
              if (parsed.size > MAX_TAR_LONG_NAME_BYTES) {
                throw new Error('Session tar long-name header exceeds path limit');
              }
              remainingData = parsed.size;
              longNameBytes = 0;
              longNameChunks = [];
              mode = remainingData > 0 ? 'longname' : (remainingPad > 0 ? 'pad' : 'header');
              continue;
            }
            if (parsed.typeFlag === 'x') {
              if (parsed.size > MAX_TAR_PAX_BYTES) {
                throw new Error('Session tar PAX header exceeds size limit');
              }
              remainingData = parsed.size;
              paxBytes = 0;
              paxChunks = [];
              mode = remainingData > 0 ? 'pax' : (remainingPad > 0 ? 'pad' : 'header');
              continue;
            }
            if (parsed.typeFlag !== '0' && parsed.typeFlag !== '\0') {
              remainingData = parsed.size;
              mode = remainingData > 0 ? 'data' : (remainingPad > 0 ? 'pad' : 'header');
              continue;
            }

            const safePath = safePortablePath(entryName);
            const parts = safePath.split('/');
            if (parts.length >= 3 && parts[0] === 'sessions') {
              const sessionId = safePortablePath(parts[1]!);
              const relPath = safePortablePath(parts.slice(2).join('/'));
              const sessionAllowed =
                !sessionId.includes('/') &&
                isAllowedSessionRelativePath(relPath) &&
                (filter?.allowedSessionIds === undefined || filter.allowedSessionIds.has(sessionId)) &&
                (filter?.maxSessions === undefined ||
                  stagedSessions.has(sessionId) ||
                  acceptedSessionOrder.length < filter.maxSessions);

              if (sessionAllowed) {
                let bucket = stagedSessions.get(sessionId);
                if (bucket === undefined) {
                  const dir = join(stageRoot, sessionId);
                  await mkdir(dir, { recursive: true });
                  bucket = { dir, files: [] };
                  stagedSessions.set(sessionId, bucket);
                  acceptedSessionOrder.push(sessionId);
                }
                const destPath = await checkedPath(bucket.dir, relPath);
                await mkdir(dirname(destPath), { recursive: true });
                const fileHandle = await open(destPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG, 0o644);
                currentWriter = fileHandle.createWriteStream({ autoClose: true });
                bucket.files.push({ relativePath: relPath, size: parsed.size });
              }
            }

            remainingData = parsed.size;
            if (remainingData === 0) {
              await closeWriter();
              mode = remainingPad > 0 ? 'pad' : 'header';
            } else {
              mode = 'data';
            }
          } else if (mode === 'longname') {
            const take = Math.min(remainingData, chunk.byteLength);
            longNameBytes += take;
            if (longNameBytes > MAX_TAR_LONG_NAME_BYTES) {
              throw new Error('Session tar long-name header exceeds path limit');
            }
            longNameChunks.push(Buffer.from(chunk.subarray(0, take)));
            chunk = chunk.subarray(take);
            remainingData -= take;
            if (remainingData === 0) {
              pendingLongName = Buffer.concat(longNameChunks).toString('utf8').replace(/\0.*$/u, '');
              longNameChunks = [];
              longNameBytes = 0;
              mode = remainingPad > 0 ? 'pad' : 'header';
            }
          } else if (mode === 'pax') {
            const take = Math.min(remainingData, chunk.byteLength);
            paxBytes += take;
            if (paxBytes > MAX_TAR_PAX_BYTES) {
              throw new Error('Session tar PAX header exceeds size limit');
            }
            paxChunks.push(Buffer.from(chunk.subarray(0, take)));
            chunk = chunk.subarray(take);
            remainingData -= take;
            if (remainingData === 0) {
              const paxPath = parsePaxPath(Buffer.concat(paxChunks));
              if (paxPath !== undefined) pendingLongName = paxPath;
              paxChunks = [];
              paxBytes = 0;
              mode = remainingPad > 0 ? 'pad' : 'header';
            }
          } else if (mode === 'data') {
            const take = Math.min(remainingData, chunk.byteLength);
            await writeToCurrentFile(chunk.subarray(0, take));
            chunk = chunk.subarray(take);
            remainingData -= take;
            if (remainingData === 0) {
              await closeWriter();
              mode = remainingPad > 0 ? 'pad' : 'header';
            }
          } else {
            const take = Math.min(remainingPad, chunk.byteLength);
            chunk = chunk.subarray(take);
            remainingPad -= take;
            if (remainingPad === 0) mode = 'header';
          }
        }
      }
    } finally {
      await closeWriter().catch(() => {});
    }

    if (
      !sawEndOfArchive ||
      pendingLongName !== undefined ||
      mode !== 'header' ||
      headerBuf.byteLength !== 0 ||
      remainingData !== 0 ||
      remainingPad !== 0
    ) {
      throw new Error('Truncated session tar archive stream');
    }

    let sessionsApplied = 0;
    let sessionsSkipped = 0;
    for (const [sessionId, bucket] of stagedSessions) {
      const outcome = await commitStagedSessionDirectory(live, {
        sessionId,
        stageDir: bucket.dir,
        files: bucket.files,
        remap,
      });
      if (outcome === 'applied') sessionsApplied += 1;
      else sessionsSkipped += 1;
    }
    if (sessionsApplied > 0) {
      await refreshSessionIndexAfterImport(live.index);
    }
    return { sessionsApplied, sessionsSkipped };
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

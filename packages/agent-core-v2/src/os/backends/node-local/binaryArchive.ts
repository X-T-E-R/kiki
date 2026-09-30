import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';

const ARCHIVE_LIMIT = 1024 * 1024 * 1024;
const EXTRACTED_LIMIT = 4 * ARCHIVE_LIMIT;

export interface BinaryArchiveInstall {
  readonly url: string;
  readonly directory: string;
  readonly entry: string;
  readonly requiredSibling: string;
}

export async function installBinaryArchive(options: BinaryArchiveInstall): Promise<string> {
  const staging = `${options.directory}.install-${randomUUID()}`;
  const archive = `${staging}.zip`;
  await mkdir(dirname(staging), { recursive: true });
  try {
    const response = await fetch(options.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || response.body === null) throw new Error(`Binary download failed (HTTP ${response.status})`);
    const source = new URL(response.url);
    if (source.protocol !== 'https:' || source.hostname !== 'dl.google.com') throw new Error('Unexpected binary download origin');
    const hash = createHash('sha256');
    let downloaded = 0;
    await pipeline(Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > ARCHIVE_LIMIT) { callback(new Error('Binary archive exceeds the download limit')); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(archive, { flags: 'wx' }));
    await mkdir(staging);
    await extractBinaryZip(archive, staging);
    for (const name of [options.entry, options.requiredSibling]) {
      const path = join(staging, name);
      if (!(await stat(path)).isFile()) throw new Error(`Binary archive is missing ${name}`);
      if (process.platform !== 'win32') await chmod(path, 0o755);
    }
    for (const name of ['node', 'localharness']) {
      const path = join(staging, name);
      if (process.platform !== 'win32' && await stat(path).then((value) => value.isFile(), () => false)) await chmod(path, 0o755);
    }
    await rename(staging, options.directory);
    return hash.digest('hex');
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
}

export async function extractBinaryZip(archive: string, destination: string): Promise<void> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    openZip(archive, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, value) => {
        if (error !== null || value === undefined) reject(error ?? new Error('Invalid ZIP'));
        else resolve(value);
      });
  });
  let total = 0;
  const names = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          const name = entry.fileName;
          const mode = entry.externalFileAttributes >>> 16;
          if (name.length === 0 || /[\\\x00:]/.test(name) || name.startsWith('/') ||
              name.split('/').some((part) => part === '..' || part === '.') || names.has(name.toLowerCase()) ||
              (mode & 0xf000) === 0xa000 || (entry.generalPurposeBitFlag & 1) !== 0) throw new Error('Unsafe ZIP entry');
          names.add(name.toLowerCase());
          const path = join(destination, name);
          if (name.endsWith('/')) await mkdir(path, { recursive: true });
          else {
            total += entry.uncompressedSize;
            if (entry.uncompressedSize > ARCHIVE_LIMIT || total > EXTRACTED_LIMIT) throw new Error('Binary ZIP exceeds the extraction limit');
            await mkdir(dirname(path), { recursive: true });
            const stream = await new Promise<Readable>((done, fail) => {
              zip.openReadStream(entry, (error, value) => {
                if (error !== null || value === undefined) fail(error ?? new Error('Invalid ZIP stream'));
                else done(value);
              });
            });
            await pipeline(stream, createWriteStream(path, { flags: 'wx' }));
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

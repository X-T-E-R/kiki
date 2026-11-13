import { copyFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { isFfmpegCleanupUnconfirmed, runManagedFfmpeg, type IHostProcessService } from '@kiki/agent-core-v2';

export interface WavAudioFormat {
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
}

let wingetPackageFfmpeg: Promise<string | undefined> | undefined;

export function audioWavAttachmentPath(dir: string, fileId: string): string {
  const id = fileId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 120) || 'media';
  return join(dir, `${id}.wav`);
}

function ffmpegCandidates(binary: string): string[] {
  const candidates = [binary, ...(binary === 'ffmpeg' ? [] : ['ffmpeg'])];
  const links = process.platform === 'win32' && process.env['LOCALAPPDATA'] !== undefined
    ? join(process.env['LOCALAPPDATA'], 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')
    : undefined;
  if (links !== undefined) candidates.push(links);
  return [...new Set(candidates)];
}

export function findWingetPackageFfmpeg(): Promise<string | undefined> {
  wingetPackageFfmpeg ??= discoverWingetPackageFfmpeg();
  return wingetPackageFfmpeg;
}

async function discoverWingetPackageFfmpeg(): Promise<string | undefined> {
  const localAppData = process.platform === 'win32' ? process.env['LOCALAPPDATA'] : undefined;
  if (localAppData === undefined) return undefined;
  const root = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  const top = await readdir(root, { withFileTypes: true }).catch(() => []);
  const queue = top.filter((entry) => entry.isDirectory() && /ffmpeg/iu.test(entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ path: join(root, entry.name), depth: 0 }));
  let scanned = 0;
  while (queue.length > 0 && scanned < 512) {
    const current = queue.shift()!;
    scanned++;
    const entries = await readdir(current.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') return path;
      if (entry.isDirectory() && current.depth < 5 && queue.length < 512) queue.push({ path, depth: current.depth + 1 });
    }
  }
  return undefined;
}

export async function inspectWav(path: string): Promise<WavAudioFormat | undefined> {
  let file: import('node:fs/promises').FileHandle | undefined;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    if (size < 44) return undefined;
    const container = Buffer.alloc(12);
    if ((await file.read(container, 0, container.byteLength, 0)).bytesRead !== container.byteLength) return undefined;
    if (container.toString('ascii', 0, 4) !== 'RIFF' || container.toString('ascii', 8, 12) !== 'WAVE') return undefined;
    if (container.readUInt32LE(4) + 8 > size) return undefined;

    let format: WavAudioFormat | undefined;
    let hasData = false;
    let offset = 12;
    let chunks = 0;
    while (offset + 8 <= size && chunks < 64) {
      const chunkHeader = Buffer.alloc(8);
      if ((await file.read(chunkHeader, 0, chunkHeader.byteLength, offset)).bytesRead !== chunkHeader.byteLength) return undefined;
      const chunkName = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const bodyOffset = offset + chunkHeader.byteLength;
      if (chunkSize > size - bodyOffset || chunkSize % 2 === 1 && bodyOffset + chunkSize >= size) return undefined;
      if (chunkName === 'fmt ') {
        if (chunkSize < 16) return undefined;
        const body = Buffer.alloc(16);
        if ((await file.read(body, 0, body.byteLength, bodyOffset)).bytesRead !== body.byteLength) return undefined;
        format = {
          audioFormat: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitsPerSample: body.readUInt16LE(14),
        };
        if (format.channels === 0 || format.sampleRate === 0 || format.bitsPerSample === 0) return undefined;
      } else if (chunkName === 'data' && chunkSize > 0) {
        hasData = true;
      }
      offset = bodyOffset + chunkSize + (chunkSize % 2);
      chunks++;
    }
    return hasData ? format : undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

async function validateWav(path: string): Promise<WavAudioFormat> {
  const format = await inspectWav(path);
  if (format === undefined) throw new Error('Audio conversion produced invalid WAV data');
  const output = await stat(path);
  if (!output.isFile() || output.size < 44) throw new Error('Audio conversion produced no WAV data');
  return format;
}

export async function convertAudioToWav(inputPath: string, outputPath: string, signal: AbortSignal, processService: Pick<IHostProcessService, 'spawn'>, binary = 'ffmpeg', timeoutMs = 30_000): Promise<string> {
  signal.throwIfAborted();
  if (inputPath === outputPath || extname(outputPath).toLowerCase() !== '.wav') throw new Error('Invalid WAV output path');
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', temporaryPath,
    ];
    let result: Awaited<ReturnType<typeof runManagedFfmpeg>> | undefined;
    for (const candidate of ffmpegCandidates(binary)) {
      result = await runManagedFfmpeg(candidate, args, signal, timeoutMs, processService);
      if (result.spawnError !== 'ENOENT') break;
    }
    if (result?.spawnError === 'ENOENT') {
      const cached = await findWingetPackageFfmpeg();
      if (cached !== undefined) result = await runManagedFfmpeg(cached, args, signal, timeoutMs, processService);
    }
    signal.throwIfAborted();
    if (result === undefined || result.code !== 0) throw new Error('Audio conversion failed');
    await validateWav(temporaryPath);
    signal.throwIfAborted();
    await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    const cleanupUnconfirmed = isFfmpegCleanupUnconfirmed(error);
    if (!cleanupUnconfirmed) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (cleanupUnconfirmed || signal.aborted) throw error;
    const fallbackPath = `${outputPath}.${randomUUID()}.source.tmp`;
    try {
      if (await inspectWav(inputPath) === undefined) throw error;
      await copyFile(inputPath, fallbackPath);
      await validateWav(fallbackPath);
      signal.throwIfAborted();
      await rename(fallbackPath, outputPath);
      return outputPath;
    } catch {
      await rm(fallbackPath, { force: true }).catch(() => undefined);
      if (signal.aborted) signal.throwIfAborted();
      throw error;
    }
  }
}

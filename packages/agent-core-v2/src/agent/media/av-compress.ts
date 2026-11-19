import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAbortError, isAbortError } from '#/kosong/contract/errors';

import { mediaExtensionForMime } from './mediaRef';

export const AV_INLINE_BYTE_BUDGET = 12 * 1024 * 1024;

const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;
const DEFAULT_FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const VIDEO_PASS1_MAX_FPS = 2;
const VIDEO_PASS2_MAX_FPS = 1;
const MIN_VIDEO_FPS = 0.1;
const MAX_PROBED_FPS = 240;
const VIDEO_PASS2_FS_HEADROOM = 256 * 1024;
const AUDIO_PASS2_FS_HEADROOM = 128 * 1024;
const MIN_FS_CAP_BYTES = 256 * 1024;

export type AvCompressRunner = (
  command: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface CompressAvOptions {
  readonly byteBudget?: number;
  readonly signal?: AbortSignal;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly timeoutMs?: number;
  readonly runner?: AvCompressRunner;
}

export interface CompressAvResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

let configuredAvRunner: AvCompressRunner | undefined;
let configuredAvByteBudget: number | undefined;

export function setConfiguredAvCompressRunner(runner: AvCompressRunner | undefined): void {
  configuredAvRunner = runner;
}

export function setConfiguredAvInlineByteBudget(budget: number | undefined): void {
  configuredAvByteBudget =
    budget !== undefined && Number.isInteger(budget) && budget > 0 ? budget : undefined;
}

export function resolveAvInlineByteBudget(): number {
  return configuredAvByteBudget ?? AV_INLINE_BYTE_BUDGET;
}

const defaultRunner: AvCompressRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        shell: false,
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: FFMPEG_MAX_BUFFER_BYTES,
        signal: options.signal,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

function resolveFfmpegPath(explicit: string | undefined): string {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  const envPath = process.env['KIKI_FFMPEG_PATH']?.trim();
  if (envPath !== undefined && envPath.length > 0) return envPath;
  return 'ffmpeg';
}

function resolveFfprobePath(explicit: string | undefined, ffmpegPath: string): string {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  const envPath = process.env['KIKI_FFPROBE_PATH']?.trim();
  if (envPath !== undefined && envPath.length > 0) return envPath;
  if (/ffmpeg(\.exe)?$/iu.test(ffmpegPath)) {
    return ffmpegPath.replace(/ffmpeg(\.exe)?$/iu, 'ffprobe$1');
  }
  return 'ffprobe';
}

function passthroughResult(bytes: Uint8Array, mimeType: string): CompressAvResult {
  return {
    data: bytes,
    mimeType,
    changed: false,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  };
}

function parseFrameRate(raw: string): number | undefined {
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed === '0/0' || trimmed === 'N/A') continue;
    const parts = trimmed.split('/', 2);
    const num = Number(parts[0]);
    const den = parts.length === 2 ? Number(parts[1]) : 1;
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) continue;
    const fps = num / den;
    if (Number.isFinite(fps) && fps > 0 && fps <= MAX_PROBED_FPS) return fps;
  }
  return undefined;
}

function formatFps(fps: number): string {
  return String(Number(fps.toFixed(3)));
}

async function probeVideoFps(
  inputPath: string,
  ffprobePath: string,
  runner: AvCompressRunner,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  try {
    const { stdout } = await runner(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=avg_frame_rate,r_frame_rate',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      { signal, timeoutMs: DEFAULT_FFPROBE_TIMEOUT_MS },
    );
    return parseFrameRate(stdout);
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw createAbortError();
    return undefined;
  }
}

async function readNonEmptyFile(path: string): Promise<Uint8Array | undefined> {
  try {
    const buf = await readFile(path);
    return buf.length > 0 ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compresses inline video bytes with local ffmpeg when they exceed the inline byte budget.
 * Files at or below budget pass through untouched without spawning ffmpeg.
 */
export async function compressVideoForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressAvOptions = {},
): Promise<CompressAvResult> {
  options.signal?.throwIfAborted();
  const byteBudget = options.byteBudget ?? resolveAvInlineByteBudget();
  if (bytes.length === 0 || bytes.length <= byteBudget) {
    return passthroughResult(bytes, mimeType);
  }

  const runner = options.runner ?? configuredAvRunner ?? defaultRunner;
  const ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
  const ffprobePath = resolveFfprobePath(options.ffprobePath, ffmpegPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  const inputExt = mediaExtensionForMime(mimeType) ?? '.bin';
  const workDir = await mkdtemp(join(tmpdir(), 'kiki-av-'));
  const inputPath = join(workDir, `input${inputExt}`);
  const pass1Path = join(workDir, 'out-pass1.mp4');
  const pass2Path = join(workDir, 'out-pass2.mp4');

  try {
    await writeFile(inputPath, bytes);
    options.signal?.throwIfAborted();

    const sourceFps = await probeVideoFps(inputPath, ffprobePath, runner, options.signal);
    const pass1Fps =
      sourceFps === undefined ? VIDEO_PASS1_MAX_FPS : Math.max(MIN_VIDEO_FPS, Math.min(sourceFps, VIDEO_PASS1_MAX_FPS));
    const pass2Fps =
      sourceFps === undefined ? VIDEO_PASS2_MAX_FPS : Math.max(MIN_VIDEO_FPS, Math.min(sourceFps, VIDEO_PASS2_MAX_FPS));

    let best: Uint8Array | undefined;
    await runner(
      ffmpegPath,
      [
        '-nostdin',
        '-y',
        '-i',
        inputPath,
        '-vf',
        `fps=fps=${formatFps(pass1Fps)}:round=near,scale='trunc(min(1280,iw)/2)*2':-2:flags=lanczos`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        pass1Path,
      ],
      { signal: options.signal, timeoutMs },
    );
    options.signal?.throwIfAborted();

    const pass1Bytes = await readNonEmptyFile(pass1Path);
    if (pass1Bytes !== undefined) {
      best = pass1Bytes;
      if (pass1Bytes.length <= byteBudget) {
        if (pass1Bytes.length < bytes.length) {
          return {
            data: pass1Bytes,
            mimeType: 'video/mp4',
            changed: true,
            originalByteLength: bytes.length,
            finalByteLength: pass1Bytes.length,
          };
        }
        return passthroughResult(bytes, mimeType);
      }
    }

    const fsCap = Math.max(MIN_FS_CAP_BYTES, byteBudget - VIDEO_PASS2_FS_HEADROOM);
    try {
      await runner(
        ffmpegPath,
        [
          '-nostdin',
          '-y',
          '-i',
          inputPath,
          '-vf',
          `fps=fps=${formatFps(pass2Fps)}:round=near,scale='trunc(min(960,iw)/2)*2':-2:flags=lanczos`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '32',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'aac',
          '-b:a',
          '24k',
          '-fs',
          String(fsCap),
          pass2Path,
        ],
        { signal: options.signal, timeoutMs },
      );
      options.signal?.throwIfAborted();
      const pass2Bytes = await readNonEmptyFile(pass2Path);
      if (pass2Bytes !== undefined && (best === undefined || pass2Bytes.length < best.length)) {
        best = pass2Bytes;
      }
    } catch (error) {
      if (options.signal?.aborted === true || isAbortError(error)) throw createAbortError();
    }

    if (best !== undefined && best.length < bytes.length) {
      return {
        data: best,
        mimeType: 'video/mp4',
        changed: true,
        originalByteLength: bytes.length,
        finalByteLength: best.length,
      };
    }
    return passthroughResult(bytes, mimeType);
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw createAbortError();
    return passthroughResult(bytes, mimeType);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Compresses inline audio bytes with local ffmpeg when they exceed the inline byte budget.
 * Files at or below budget pass through untouched without spawning ffmpeg.
 */
export async function compressAudioForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressAvOptions = {},
): Promise<CompressAvResult> {
  options.signal?.throwIfAborted();
  const byteBudget = options.byteBudget ?? resolveAvInlineByteBudget();
  if (bytes.length === 0 || bytes.length <= byteBudget) {
    return passthroughResult(bytes, mimeType);
  }

  const runner = options.runner ?? configuredAvRunner ?? defaultRunner;
  const ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  const inputExt = mediaExtensionForMime(mimeType) ?? '.bin';
  const workDir = await mkdtemp(join(tmpdir(), 'kiki-av-'));
  const inputPath = join(workDir, `input${inputExt}`);
  const mp3Pass1Path = join(workDir, 'out-pass1.mp3');
  const mp3Pass2Path = join(workDir, 'out-pass2.mp3');
  const aacPass1Path = join(workDir, 'out-pass1.m4a');

  try {
    await writeFile(inputPath, bytes);
    options.signal?.throwIfAborted();

    let best: { readonly data: Uint8Array; readonly mimeType: string } | undefined;
    let codec: 'libmp3lame' | 'aac' = 'libmp3lame';

    try {
      await runner(
        ffmpegPath,
        [
          '-nostdin',
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '32k',
          mp3Pass1Path,
        ],
        { signal: options.signal, timeoutMs },
      );
      options.signal?.throwIfAborted();
      const pass1Bytes = await readNonEmptyFile(mp3Pass1Path);
      if (pass1Bytes !== undefined) {
        best = { data: pass1Bytes, mimeType: 'audio/mpeg' };
      }
    } catch (error) {
      if (options.signal?.aborted === true || isAbortError(error)) throw createAbortError();
      codec = 'aac';
      await runner(
        ffmpegPath,
        [
          '-nostdin',
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'aac',
          '-b:a',
          '32k',
          aacPass1Path,
        ],
        { signal: options.signal, timeoutMs },
      );
      options.signal?.throwIfAborted();
      const aacBytes = await readNonEmptyFile(aacPass1Path);
      if (aacBytes !== undefined) {
        best = { data: aacBytes, mimeType: 'audio/mp4' };
      }
    }

    if (best !== undefined && best.data.length <= byteBudget) {
      if (best.data.length < bytes.length) {
        return {
          data: best.data,
          mimeType: best.mimeType,
          changed: true,
          originalByteLength: bytes.length,
          finalByteLength: best.data.length,
        };
      }
      return passthroughResult(bytes, mimeType);
    }

    const fsCap = Math.max(MIN_FS_CAP_BYTES, byteBudget - AUDIO_PASS2_FS_HEADROOM);
    const pass2OutPath = codec === 'libmp3lame' ? mp3Pass2Path : join(workDir, 'out-pass2.m4a');
    const pass2Mime = codec === 'libmp3lame' ? 'audio/mpeg' : 'audio/mp4';
    try {
      await runner(
        ffmpegPath,
        [
          '-nostdin',
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          codec,
          '-b:a',
          '16k',
          '-fs',
          String(fsCap),
          pass2OutPath,
        ],
        { signal: options.signal, timeoutMs },
      );
      options.signal?.throwIfAborted();
      const pass2Bytes = await readNonEmptyFile(pass2OutPath);
      if (pass2Bytes !== undefined && (best === undefined || pass2Bytes.length < best.data.length)) {
        best = { data: pass2Bytes, mimeType: pass2Mime };
      }
    } catch (error) {
      if (options.signal?.aborted === true || isAbortError(error)) throw createAbortError();
    }

    if (best !== undefined && best.data.length < bytes.length) {
      return {
        data: best.data,
        mimeType: best.mimeType,
        changed: true,
        originalByteLength: bytes.length,
        finalByteLength: best.data.length,
      };
    }
    return passthroughResult(bytes, mimeType);
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw createAbortError();
    return passthroughResult(bytes, mimeType);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

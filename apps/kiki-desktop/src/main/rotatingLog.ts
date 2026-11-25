import { mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'pathe';
import type { DesktopLogInfo, DesktopLogLevel } from '#/shared/types';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUPS = 3;
const DEFAULT_TAIL_LINES = 100;
const DEFAULT_TAIL_BYTES = 64 * 1024;

export function desktopLogDirectory(homeDir: string): string {
  return join(homeDir, 'logs');
}

export function desktopBackendLogPath(homeDir: string): string {
  return join(desktopLogDirectory(homeDir), 'desktop-backend.log');
}

export function buildDesktopLogInfo(homeDir: string, logLevel: DesktopLogLevel): DesktopLogInfo {
  return {
    directory: desktopLogDirectory(homeDir),
    backendLogPath: desktopBackendLogPath(homeDir),
    maxBytes: LOG_MAX_BYTES,
    backups: LOG_BACKUPS,
    logLevel,
    appliesOnNextLaunch: true,
  };
}

function rotateFiles(logPath: string, backups: number): void {
  if (backups <= 0) return;
  rmSync(`${logPath}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Rotate `<home>/logs/desktop-backend.log` before handing an append file descriptor
 * directly to a detached `kiki-server` daemon so daemon output survives Electron exit
 * without broken-pipe (EPIPE) hazards.
 */
export function openDetachedBackendLogFd(
  homeDir: string,
  maxBytes: number = LOG_MAX_BYTES,
  backups: number = LOG_BACKUPS,
): { readonly path: string; readonly fd: number } {
  const logPath = desktopBackendLogPath(homeDir);
  mkdirSync(dirname(logPath), { recursive: true });
  try {
    const info = statSync(logPath);
    if (info.size >= maxBytes) {
      rotateFiles(logPath, backups);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fd = openSync(logPath, 'a', 0o600);
  return { path: logPath, fd };
}

/**
 * Reads the last `maxLines` lines from `<home>/logs/desktop-backend.log` bounded to
 * `maxBytes`, decoding UTF-8 via standard `TextDecoder` without manual byte bit-masks.
 */
export async function readBackendLogTail(
  homeDir: string,
  maxLines: number = DEFAULT_TAIL_LINES,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): Promise<string[]> {
  const logPath = desktopBackendLogPath(homeDir);
  let handle;
  try {
    handle = await open(logPath, 'r');
  } catch {
    return [];
  }
  try {
    const info = await handle.stat();
    if (info.size <= 0) return [];
    const readBytes = Math.min(info.size, Math.max(1, maxBytes));
    const startOffset = info.size - readBytes;
    const buffer = new Uint8Array(readBytes);
    const { bytesRead } = await handle.read(buffer, 0, readBytes, startOffset);
    const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
    let decoded = decoder.decode(buffer.subarray(0, bytesRead));
    if (startOffset > 0) {
      decoded = decoded.replace(/^\uFFFD+/, '');
      const firstNewline = decoded.indexOf('\n');
      if (firstNewline !== -1) {
        decoded = decoded.slice(firstNewline + 1);
      }
    }
    const lines = decoded
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    return lines.slice(-Math.max(1, maxLines));
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

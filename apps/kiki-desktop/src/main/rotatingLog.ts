import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'pathe';
import type { DesktopLogInfo, DesktopLogLevel } from '#/shared/types';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUPS = 3;

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

export class RotatingLog {
  private fd: number | null;
  private size: number;

  constructor(
    readonly filePath: string,
    readonly limit: number = LOG_MAX_BYTES,
    readonly backups: number = LOG_BACKUPS,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.fd = openSync(filePath, 'a', 0o600);
    this.size = statSync(filePath).size;
    if (this.size >= this.limit) {
      this.rotate();
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    rotateFiles(this.filePath, this.backups);
    this.fd = openSync(this.filePath, 'w', 0o600);
    this.size = 0;
  }

  writeLine(line: string): void {
    if (this.fd === null) throw new Error('log file is closed');
    const maxLineBytes = Math.max(0, this.limit - 1);
    let buf = Buffer.from(line, 'utf8');
    if (buf.byteLength > maxLineBytes) {
      let start = buf.byteLength - maxLineBytes;
      while (start < buf.byteLength && (buf[start]! & 0xc0) === 0x80) {
        start += 1;
      }
      buf = buf.subarray(start);
    }
    const lineBytes = buf.byteLength + 1;
    if (this.size + lineBytes > this.limit) {
      this.rotate();
    }
    writeSync(this.fd, buf);
    writeSync(this.fd, '\n');
    this.size += lineBytes;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

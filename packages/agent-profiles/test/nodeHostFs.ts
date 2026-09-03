import {
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';

import type { HostFs } from '#/hostFs';

export const nodeHostFs: HostFs = {
  readFile: (path) => readFile(path, 'utf8'),
  readdir: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  stat: async (path) => {
    const value = await stat(path);
    return {
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
      isSymbolicLink: value.isSymbolicLink(),
      size: value.size,
      mtimeMs: value.mtimeMs,
      ino: value.ino,
    };
  },
  realpath,
};

export const OsFsErrors = {
  codes: {
    OS_FS_NOT_FOUND: 'os.fs.not_found',
    OS_FS_NOT_DIRECTORY: 'os.fs.not_directory',
    OS_FS_PERMISSION_DENIED: 'os.fs.permission_denied',
    OS_FS_UNAVAILABLE: 'os.fs.unavailable',
  },
} as const;

export class HostFsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HostFsError';
  }
}

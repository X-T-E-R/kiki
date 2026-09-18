import { resolve } from 'node:path';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export class NbSearchLocalFileError extends Error {
  constructor(readonly issue: 'LOCAL_CONFIG_BUSY' | 'LOCAL_CREDENTIALS_UNREADABLE' | 'LOCAL_CONFIG_CHANGED') {
    super(issue);
    this.name = 'NbSearchLocalFileError';
  }
}

/** Read-only, non-reflective helper for nb-search CLI credential file reads. */
export class NbSearchCredentialFileStore {
  constructor(private readonly fs: IHostFileSystem) {}

  async read(path: string): Promise<string | undefined> {
    try {
      const stat = await this.statIfPresent(path);
      if (stat === undefined) return undefined;
      if (!stat.isFile || stat.size > MAX_FILE_BYTES) throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNREADABLE');
      const bytes = await this.fs.readBytes(path, MAX_FILE_BYTES + 1);
      if (bytes.length > MAX_FILE_BYTES) throw new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNREADABLE');
      const after = await this.fs.lstat(path);
      if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
        throw new NbSearchLocalFileError('LOCAL_CONFIG_CHANGED');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch (error) {
      throw error instanceof NbSearchLocalFileError ? error : new NbSearchLocalFileError('LOCAL_CREDENTIALS_UNREADABLE');
    }
  }

  async assertUnlocked(home: string): Promise<void> {
    try {
      if (await this.statIfPresent(resolve(home, '.config-access.lock')) !== undefined) {
        throw new NbSearchLocalFileError('LOCAL_CONFIG_BUSY');
      }
    } catch (error) {
      throw error instanceof NbSearchLocalFileError ? error : new NbSearchLocalFileError('LOCAL_CONFIG_BUSY');
    }
  }

  private async statIfPresent(path: string) {
    try {
      return await this.fs.lstat(path);
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'os.fs.not_found') return undefined;
      throw error;
    }
  }
}

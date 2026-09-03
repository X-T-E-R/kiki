export interface HostFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
}

export interface HostDirEntry {
  readonly name: string;
  readonly isFile?: boolean;
  readonly isDirectory?: boolean;
  readonly isSymbolicLink?: boolean;
}

export interface HostFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<readonly HostDirEntry[]>;
  stat(path: string): Promise<HostFileStat>;
  realpath(path: string): Promise<string>;
}

export function hostFsErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { readonly code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isHostFsUnavailable(error: unknown): boolean {
  return hostFsErrorCode(error) === 'os.fs.unavailable';
}

export function isHostFsMissing(error: unknown): boolean {
  const code = hostFsErrorCode(error);
  return code === 'os.fs.not_found' || code === 'os.fs.not_directory' || code === 'ENOENT' || code === 'ENOTDIR';
}

import { isAbsolute, join, resolve } from 'pathe';

import type { HostFs } from './hostFs';
import { isHostFsMissing } from './hostFs';

export function resolveAgentPath(path: string, baseDir: string, osHomeDir: string): string {
  if (path === '~') return osHomeDir;
  if (path.startsWith('~/')) return join(osHomeDir, path.slice(2));
  if (isAbsolute(path)) return path;
  return resolve(baseDir, path);
}

export async function isDirectoryPath(fs: HostFs, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isDirectory;
  } catch (error) {
    if (isHostFsMissing(error)) return false;
    throw error;
  }
}

export async function isFilePath(fs: HostFs, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isFile;
  } catch (error) {
    if (isHostFsMissing(error)) return false;
    throw error;
  }
}

export async function pathExists(fs: HostFs, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (error) {
    if (isHostFsMissing(error)) return false;
    throw error;
  }
}

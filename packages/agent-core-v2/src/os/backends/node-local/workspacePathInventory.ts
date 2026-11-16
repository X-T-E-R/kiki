import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fdir } from 'fdir';
import ignore, { type Ignore } from 'ignore';
import { isSensitiveFile } from '#/_base/security/sensitiveFile';

export interface WorkspacePathEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly ino: number;
}

export interface WorkspacePathInventory {
  readonly entries: readonly WorkspacePathEntry[];
  readonly overflow: boolean;
}

const VCS = new Set(['.git', '.hg', '.svn', '.jj', '.bzr', '.sl']);
const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'];

export function workspacePathInventory(root: string, limit: number): WorkspacePathInventory {
  root = resolve(root);
  const rules = new Map<string, readonly (Ignore | undefined)[]>();
  const matchers = (directory: string): readonly (Ignore | undefined)[] => {
    const cached = rules.get(directory);
    if (cached !== undefined) return cached;
    const loaded: Array<Ignore | undefined> = [];
    for (const name of IGNORE_FILES) {
      try {
        loaded.push(ignore().add(readFileSync(join(directory, name), 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        loaded.push(undefined);
      }
    }
    rules.set(directory, loaded);
    return loaded;
  };
  const ignored = (path: string, directory: boolean): boolean => {
    const parents: string[] = [];
    let parent = dirname(path);
    while (parent === root || parent.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
      parents.push(parent);
      if (parent === root) break;
      parent = dirname(parent);
    }
    let excluded = false;
    for (let kind = 0; kind < IGNORE_FILES.length; kind++) {
      for (let index = parents.length - 1; index >= 0; index--) {
        const directoryPath = parents[index]!;
        const local = relative(directoryPath, path).replaceAll('\\', '/') + (directory ? '/' : '');
        const result = matchers(directoryPath)[kind]?.test(local);
        if (result?.ignored) excluded = true;
        if (result?.unignored) excluded = false;
      }
    }
    return excluded;
  };
  const paths = new fdir({ excludeSymlinks: false }).withFullPaths().withDirs().withErrors()
    .withMaxFiles(limit + 1)
    .exclude((name, path) => VCS.has(name) || isSensitiveFile(path) || ignored(path, true))
    .filter((path, directory) => relative(root, path) !== '' && !VCS.has(basename(path)) && !isSensitiveFile(path) && !ignored(path, directory))
    .crawl(root).sync();
  const entries: WorkspacePathEntry[] = [];
  let files = 0;
  for (const path of paths) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) continue;
    if (stat.isFile() && ++files > limit || entries.length >= limit) return { entries: [], overflow: true };
    const local = relative(root, path).replaceAll('\\', '/').replace(/\/$/u, '');
    if (local === '') continue;
    entries.push({ path: local, name: basename(path), kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino });
  }
  return { entries, overflow: false };
}

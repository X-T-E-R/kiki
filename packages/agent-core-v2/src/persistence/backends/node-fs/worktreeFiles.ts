import { lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

export async function assertUnlinkedAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`linked path is not a worktree boundary: ${current}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function createWorktreeParent(path: string): Promise<void> {
  await assertUnlinkedAncestors(path);
  if (await pathExists(path)) throw new Error(`worktree path already exists: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await assertUnlinkedAncestors(dirname(path));
}

export async function readWorktreePointer(path: string): Promise<string | undefined> {
  const marker = join(path, '.git');
  const stat = await lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  const pointer = /^gitdir:\s*(.+)\s*$/im.exec(await readFile(marker, 'utf8'))?.[1]?.trim();
  return pointer === undefined ? undefined : resolve(path, pointer);
}

export async function writeOwnerMarker(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
}

export async function readOwnerMarker(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('worktree owner marker is not a regular file');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function canonicalPath(path: string): Promise<string> {
  return realpath(path);
}

export function pathKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function insidePath(path: string, root: string): boolean {
  const probe = pathKey(path);
  const base = pathKey(root);
  return probe === base || probe.startsWith(base + sep);
}

export async function severLinksAndRemove(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('worktree removal requires an absolute path');
  await assertUnlinkedAncestors(path);
  const walk = async (directory: string, sever: boolean): Promise<boolean> => {
    let found = false;
    for (const entry of await readdir(directory)) {
      const child = join(directory, entry);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        found = true;
        if (sever) await unlink(child);
      } else if (stat.isDirectory()) {
        if (await walk(child, sever)) found = true;
      }
    }
    return found;
  };
  await walk(path, true);
  if (await walk(path, false)) throw new Error(`worktree still contains links: ${path}`);
  for (let attempt = 0; attempt < 18; attempt++) {
    try { await rm(path, { recursive: true, force: false }); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '') || attempt === 17) throw error;
      await new Promise((done) => setTimeout(done, Math.min(50 * 2 ** attempt, 500)));
    }
  }
}

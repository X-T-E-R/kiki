import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
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
  readonly sensitive?: boolean;
}

export interface WorkspacePathInventory {
  readonly entries: readonly WorkspacePathEntry[];
  readonly overflow: boolean;
}

const VCS = new Set(['.git', '.hg', '.svn', '.jj', '.bzr', '.sl']);
const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'];
const SKIPPABLE = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

class PathRules {
  private readonly rules = new Map<string, readonly (Ignore | undefined)[]>();
  private readonly parents: string[] = [];
  private readonly exclude?: Ignore;
  constructor(private readonly root: string) {
    let parent = root;
    for (;;) {
      this.parents.unshift(parent);
      const git = join(parent, '.git');
      if (existsSync(git)) {
        let gitDir = git;
        if (lstatSync(git).isFile()) gitDir = resolve(parent, readFileSync(git, 'utf8').trim().replace(/^gitdir: /u, ''));
        if (existsSync(join(gitDir, 'commondir'))) gitDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
        this.exclude = this.load(join(gitDir, 'info', 'exclude'), parent);
        break;
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  private load(path: string, directory: string): Ignore | undefined {
    try {
      const matcher = ignore().add(readFileSync(path, 'utf8'));
      const route = relative(directory, this.root).replaceAll('\\', '/');
      if (route !== '' && !route.startsWith('../')) {
        const parts = route.split('/');
        matcher.add(parts.map((_part, index) => `!/${parts.slice(0, index + 1).join('/')}/`));
      }
      return matcher;
    } catch (error) {
      if (SKIPPABLE.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
      throw error;
    }
  }
  ignored(path: string, directory: boolean): boolean {
    const parents = [...this.parents];
    const local = relative(this.root, dirname(path));
    if (local !== '') {
      let current = this.root;
      for (const part of local.split(/[\\/]/u)) { current = join(current, part); parents.push(current); }
    }
    let excluded = false;
    const apply = (matcher: Ignore, parent: string): void => {
      const result = matcher.test(relative(parent, path).replaceAll('\\', '/') + (directory ? '/' : ''));
      if (result.ignored) excluded = true;
      if (result.unignored) excluded = false;
    };
    if (this.exclude !== undefined) apply(this.exclude, this.parents[0]!);
    for (let kind = 0; kind < IGNORE_FILES.length; kind++) {
      for (const parent of parents) {
        let matchers = this.rules.get(parent);
        if (matchers === undefined) {
          matchers = IGNORE_FILES.map(name => this.load(join(parent, name), parent));
          this.rules.set(parent, matchers);
        }
        const matcher = matchers[kind];
        if (matcher !== undefined) apply(matcher, parent);
      }
    }
    return excluded;
  }
}

function pathEntry(root: string, path: string): WorkspacePathEntry | undefined {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (SKIPPABLE.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
  if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) return undefined;
  return { path: relative(root, path).replaceAll('\\', '/'), name: basename(path),
    kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino, sensitive: isSensitiveFile(path) };
}

export function workspacePathEntry(root: string, path: string): WorkspacePathEntry | undefined {
  const local = relative(root, path);
  if (local === '' || local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local) ||
      local.split(/[\\/]/u).some(part => VCS.has(part.toLowerCase()))) return undefined;
  const entry = pathEntry(root, path);
  return entry === undefined || new PathRules(root).ignored(path, entry.kind === 'directory') ? undefined : entry;
}

export function workspacePathFilter(root: string, paths: readonly string[]): readonly string[] {
  const rules = new PathRules(root);
  return paths.filter(path => !rules.ignored(path, false));
}

export function workspacePathInventory(root: string, limit: number): WorkspacePathInventory {
  root = resolve(root);
  const rules = new PathRules(root);
  const entries: WorkspacePathEntry[] = [];
  const stack: Array<{ readonly path: string; entries?: readonly Dirent[]; index: number }> = [{ path: root, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.entries === undefined) {
      try { frame.entries = readdirSync(frame.path, { withFileTypes: true }); }
      catch (error) {
        stack.pop();
        if (SKIPPABLE.has((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
    }
    const dirent = frame.entries[frame.index++];
    if (dirent === undefined) { stack.pop(); continue; }
    const path = join(frame.path, dirent.name);
    if (dirent.isDirectory()) {
      if (VCS.has(dirent.name.toLowerCase()) || rules.ignored(path, true)) continue;
      const entry = pathEntry(root, path);
      if (entry === undefined) continue;
      entries.push(entry);
      if (entries.length > limit) return { entries: [], overflow: true };
      stack.push({ path, index: 0 });
      continue;
    }
    if (VCS.has(dirent.name.toLowerCase()) || rules.ignored(path, false)) continue;
    const entry = pathEntry(root, path);
    if (entry === undefined) continue;
    entries.push(entry);
    if (entries.length > limit) return { entries: [], overflow: true };
  }
  return { entries, overflow: false };
}

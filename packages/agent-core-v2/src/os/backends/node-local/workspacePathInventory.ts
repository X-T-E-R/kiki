import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
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

const ALWAYS_IGNORED_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.jj',
  '.bzr',
  '.sl',
  'deriveddata',
  '.swiftpm',
  'xcuserdata',
  '.ds_store',
]);

/** Returns true when a path segment belongs to VCS metadata or Apple/Xcode build-artifact bundles that must never be indexed or watched. */
export function isAlwaysIgnoredPathSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return ALWAYS_IGNORED_SEGMENTS.has(lower) || lower.endsWith('.xcresult');
}
const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'];
const SKIPPABLE = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);
const MAX_PARSED_IGNORE_CACHE_ENTRIES = 512;
const MAX_TEXT_FILE_CACHE_ENTRIES = 64;

interface FileStamp {
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly size: bigint;
  readonly ino: bigint;
}

interface CachedIgnoreEntry extends FileStamp {
  readonly matcher: Ignore;
}

interface CachedTextEntry extends FileStamp {
  readonly text: string;
}

const parsedIgnoreCache = new Map<string, CachedIgnoreEntry>();
const cachedTextFileCache = new Map<string, CachedTextEntry>();

function sameFileStamp(left: FileStamp, right: FileStamp): boolean {
  return left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.size === right.size
    && left.ino === right.ino;
}

function lruSet<V>(cache: Map<string, V>, key: string, value: V, maxEntries: number): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

function statFileStamp(path: string): FileStamp | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) return undefined;
    return {
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      size: stat.size,
      ino: stat.ino,
    };
  } catch (error) {
    if (SKIPPABLE.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

function readCachedTextFile(path: string): string | undefined {
  const stamp = statFileStamp(path);
  if (stamp === undefined) {
    cachedTextFileCache.delete(path);
    return undefined;
  }
  const cached = cachedTextFileCache.get(path);
  if (cached !== undefined && sameFileStamp(cached, stamp)) {
    cachedTextFileCache.delete(path);
    cachedTextFileCache.set(path, cached);
    return cached.text;
  }
  try {
    const text = readFileSync(path, 'utf8');
    lruSet(cachedTextFileCache, path, { ...stamp, text }, MAX_TEXT_FILE_CACHE_ENTRIES);
    return text;
  } catch (error) {
    if (SKIPPABLE.has((error as NodeJS.ErrnoException).code ?? '')) {
      cachedTextFileCache.delete(path);
      return undefined;
    }
    throw error;
  }
}

class PathRules {
  private readonly rules = new Map<string, readonly (Ignore | undefined)[]>();
  private readonly dirChainCache = new Map<string, readonly { readonly matcher: Ignore; readonly parent: string }[]>();
  private readonly parents: string[] = [];
  private readonly exclude?: Ignore;
  constructor(private readonly root: string, private readonly signal?: AbortSignal) {
    let parent = root;
    for (;;) {
      this.signal?.throwIfAborted();
      this.parents.unshift(parent);
      const git = join(parent, '.git');
      if (existsSync(git)) {
        let gitDir = git;
        if (lstatSync(git).isFile()) {
          const pointer = readCachedTextFile(git);
          if (pointer !== undefined) gitDir = resolve(parent, pointer.trim().replace(/^gitdir: /u, ''));
        }
        const commonDirPath = join(gitDir, 'commondir');
        if (existsSync(commonDirPath)) {
          const commonDir = readCachedTextFile(commonDirPath);
          if (commonDir !== undefined) gitDir = resolve(gitDir, commonDir.trim());
        }
        this.exclude = this.load(join(gitDir, 'info', 'exclude'), parent);
        break;
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  private load(path: string, directory: string): Ignore | undefined {
    this.signal?.throwIfAborted();
    const route = relative(directory, this.root).replaceAll('\\', '/');
    const cacheKey = `${path}\0${route}`;
    const stamp = statFileStamp(path);
    if (stamp === undefined) {
      parsedIgnoreCache.delete(cacheKey);
      return undefined;
    }
    const cached = parsedIgnoreCache.get(cacheKey);
    if (cached !== undefined && sameFileStamp(cached, stamp)) {
      parsedIgnoreCache.delete(cacheKey);
      parsedIgnoreCache.set(cacheKey, cached);
      return cached.matcher;
    }
    try {
      const matcher = ignore().add(readFileSync(path, 'utf8'));
      if (route !== '' && !route.startsWith('../')) {
        const parts = route.split('/');
        matcher.add(parts.map((_part, index) => `!/${parts.slice(0, index + 1).join('/')}/`));
      }
      lruSet(parsedIgnoreCache, cacheKey, { ...stamp, matcher }, MAX_PARSED_IGNORE_CACHE_ENTRIES);
      return matcher;
    } catch (error) {
      if (SKIPPABLE.has((error as NodeJS.ErrnoException).code ?? '')) {
        parsedIgnoreCache.delete(cacheKey);
        return undefined;
      }
      throw error;
    }
  }
  private activeRulesForDir(dir: string): readonly { readonly matcher: Ignore; readonly parent: string }[] {
    const cached = this.dirChainCache.get(dir);
    if (cached !== undefined) return cached;
    const parents = [...this.parents];
    const local = relative(this.root, dir);
    if (local !== '' && !local.startsWith('..') && !isAbsolute(local)) {
      let current = this.root;
      for (const part of local.split(/[\\/]/u)) { current = join(current, part); parents.push(current); }
    }
    const active: { readonly matcher: Ignore; readonly parent: string }[] = [];
    if (this.exclude !== undefined) active.push({ matcher: this.exclude, parent: this.parents[0]! });
    for (let kind = 0; kind < IGNORE_FILES.length; kind++) {
      for (const parent of parents) {
        this.signal?.throwIfAborted();
        let matchers = this.rules.get(parent);
        if (matchers === undefined) {
          matchers = IGNORE_FILES.map(name => this.load(join(parent, name), parent));
          this.rules.set(parent, matchers);
        }
        const matcher = matchers[kind];
        if (matcher !== undefined) active.push({ matcher, parent });
      }
    }
    this.dirChainCache.set(dir, active);
    return active;
  }
  ignored(path: string, directory: boolean): boolean {
    this.signal?.throwIfAborted();
    const active = this.activeRulesForDir(dirname(path));
    if (active.length === 0) return false;
    let excluded = false;
    for (const { matcher, parent } of active) {
      const result = matcher.test(relative(parent, path).replaceAll('\\', '/') + (directory ? '/' : ''));
      if (result.ignored) excluded = true;
      if (result.unignored) excluded = false;
    }
    return excluded;
  }
}

function pathEntry(root: string, path: string, signal?: AbortSignal): WorkspacePathEntry | undefined {
  signal?.throwIfAborted();
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

export function workspacePathEntry(root: string, path: string, signal?: AbortSignal): WorkspacePathEntry | undefined {
  signal?.throwIfAborted();
  const local = relative(root, path);
  if (local === '' || local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local) ||
      local.split(/[\\/]/u).some(isAlwaysIgnoredPathSegment)) return undefined;
  const entry = pathEntry(root, path, signal);
  return entry === undefined || new PathRules(root, signal).ignored(path, entry.kind === 'directory') ? undefined : entry;
}

export function workspacePathFilter(root: string, paths: readonly string[], signal?: AbortSignal): readonly string[] {
  signal?.throwIfAborted();
  const rules = new PathRules(root, signal);
  const filtered: string[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    if (!rules.ignored(path, false)) filtered.push(path);
  }
  return filtered;
}

export function workspacePathFilterPacked(root: string, pathsText: string, signal?: AbortSignal): string | null {
  signal?.throwIfAborted();
  if (pathsText.length === 0) return null;
  const rules = new PathRules(root, signal);
  const paths = pathsText.split('\n');
  let removed = false;
  const filtered: string[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    if ((i & 511) === 0) signal?.throwIfAborted();
    const path = paths[i]!;
    if (!rules.ignored(path, false)) filtered.push(path);
    else removed = true;
  }
  return removed ? filtered.join('\n') : null;
}

export function workspacePathInventory(root: string, limit: number, signal?: AbortSignal): WorkspacePathInventory {
  signal?.throwIfAborted();
  root = resolve(root);
  const rules = new PathRules(root, signal);
  const entries: WorkspacePathEntry[] = [];
  const stack: Array<{ readonly path: string; entries?: readonly Dirent[]; index: number }> = [{ path: root, index: 0 }];
  while (stack.length > 0) {
    signal?.throwIfAborted();
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
      if (isAlwaysIgnoredPathSegment(dirent.name) || rules.ignored(path, true)) continue;
      const entry = pathEntry(root, path, signal);
      if (entry === undefined) continue;
      entries.push(entry);
      if (entries.length > limit) return { entries: [], overflow: true };
      stack.push({ path, index: 0 });
      continue;
    }
    if (isAlwaysIgnoredPathSegment(dirent.name) || rules.ignored(path, false)) continue;
    const entry = pathEntry(root, path, signal);
    if (entry === undefined) continue;
    entries.push(entry);
    if (entries.length > limit) return { entries: [], overflow: true };
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries, overflow: false };
}

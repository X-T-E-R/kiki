import nodePath from 'node:path';

import { isAbsolute, normalize, resolve } from 'pathe';

import { workspaceRootKey } from './workdir-slug';

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

export function hostAwareResolve(
  path: { readonly sep: string; resolve(...paths: string[]): string },
  ...paths: string[]
): string {
  if (path.sep === '/') {
    for (let i = paths.length - 1; i >= 0; i--) {
      const segment = paths[i];
      if (segment !== undefined && isWindowsAbsolutePath(segment)) {
        return nodePath.win32.resolve(...paths.slice(i)).replaceAll('\\', '/');
      }
    }
  }
  return path.resolve(...paths);
}

export function resolvePath(base: string, value: string): string {
  if (isWindowsAbsolutePath(base)) {
    return nodePath.win32.resolve(base, value).replaceAll('\\', '/');
  }
  if (isWindowsAbsolutePath(value)) {
    return nodePath.win32.resolve(value).replaceAll('\\', '/');
  }
  return isAbsolute(value) ? normalize(value) : resolve(base, value);
}

export function canonicalWorkspaceRoot(cwd: string): string {
  const resolved = isWindowsAbsolutePath(cwd)
    ? nodePath.win32.resolve(cwd).replaceAll('\\', '/')
    : resolve(cwd);
  return workspaceRootKey(resolved) || resolved;
}

export interface UpwardRootPathApi {
  resolve(dir: string): string;
  dirname(dir: string): string;
  join(...segments: string[]): string;
}

export async function findUpwardRoot(
  workDir: string,
  markerName: string,
  hasMarker: (markerPath: string) => Promise<boolean>,
  pathApi: UpwardRootPathApi = nodePath,
): Promise<string> {
  const start = pathApi.resolve(workDir);
  let current = start;
  while (true) {
    if (await hasMarker(pathApi.join(current, markerName))) return normalizeSlashes(current);
    const parent = pathApi.dirname(current);
    if (parent === current) return normalizeSlashes(start);
    current = parent;
  }
}

export interface SubtreeWatchFilterOptions {
  readonly maxDepth?: number;
  readonly skipEntry?: (entryName: string) => boolean;
  readonly keepEntryFile?: string;
  readonly scannedDirectories?: readonly string[];
}

/**
 * Watch-path predicate produced by `subtreeWatchFilter`. `subtree(path)` is the
 * structural verdict: `true` means the path is neither a candidate, nor inside
 * one, nor an ancestor of one, so nothing below it can ever pass the filter.
 */
export interface SubtreeWatchFilter {
  (path: string): boolean;
  readonly subtree: (path: string) => boolean;
}

export function subtreeWatchFilter(
  root: string,
  candidates: readonly string[],
  options?: SubtreeWatchFilterOptions,
): SubtreeWatchFilter {
  const normRoot = normalizeSlashes(root);
  const normCandidates = candidates.map(normalizeSlashes);
  const normScannedDirectories =
    options?.scannedDirectories === undefined
      ? undefined
      : new Set([...normCandidates, ...options.scannedDirectories.map(normalizeSlashes)]);
  const subtree = (p: string): boolean => {
    const norm = normalizeSlashes(p);
    if (norm === normRoot) return false;
    for (const candidate of normCandidates) {
      if (norm === candidate) return false;
      if (norm.startsWith(`${candidate}/`)) return false;
      if (candidate.startsWith(`${norm}/`)) return false;
    }
    return true;
  };
  const filter = (p: string): boolean => {
    const norm = normalizeSlashes(p);
    if (norm === normRoot) return false;
    for (const candidate of normCandidates) {
      if (norm === candidate) return false;
      if (norm.startsWith(`${candidate}/`)) {
        return isPrunedBelowCandidate(
          norm,
          norm.slice(candidate.length + 1),
          options,
          normScannedDirectories,
        );
      }
      if (candidate.startsWith(`${norm}/`)) return false;
    }
    return true;
  };
  return Object.assign(filter, { subtree });
}

function isPrunedBelowCandidate(
  normPath: string,
  rel: string,
  options: SubtreeWatchFilterOptions | undefined,
  scannedDirectories: ReadonlySet<string> | undefined,
): boolean {
  if (options === undefined) return false;
  const segments = rel.split('/');
  if (options.maxDepth !== undefined && segments.length > options.maxDepth) return true;
  if (options.skipEntry !== undefined) {
    const excludedAt = segments.findIndex(options.skipEntry);
    if (excludedAt !== -1) {
      if (segments.length <= excludedAt + 1) return false;
      return !(
        options.keepEntryFile !== undefined &&
        segments.length === excludedAt + 2 &&
        segments.at(-1) === options.keepEntryFile
      );
    }
  }
  if (scannedDirectories !== undefined) {
    return !isScannerVisiblePath(normPath, scannedDirectories, options.keepEntryFile);
  }
  return false;
}

function isScannerVisiblePath(
  normPath: string,
  scannedDirectories: ReadonlySet<string>,
  keepEntryFile: string | undefined,
): boolean {
  if (scannedDirectories.has(normPath)) return true;
  const separatorAt = normPath.lastIndexOf('/');
  if (separatorAt === -1) return false;
  const parent = normPath.slice(0, separatorAt);
  if (scannedDirectories.has(parent)) return true;
  if (
    keepEntryFile === undefined ||
    normPath.slice(separatorAt + 1) !== keepEntryFile
  ) {
    return false;
  }
  const parentSeparatorAt = parent.lastIndexOf('/');
  if (parentSeparatorAt === -1) return false;
  return scannedDirectories.has(parent.slice(0, parentSeparatorAt));
}

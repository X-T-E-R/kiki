import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

const MAX_WORKDIR_SLUG_LENGTH = 40;
const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;
const WORKDIR_ID_PATTERN = /^wd_[a-z0-9._-]+_[0-9a-f]{12}$/;
const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = workspaceRootKey(workDir);
  return encodeNormalizedWorkDirKey(normalized);
}

export function encodeLegacyWorkDirKey(workDir: string): string {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '');
  return encodeNormalizedWorkDirKey(normalized);
}

export function workDirKeyAliases(workDir: string): readonly string[] {
  const canonical = encodeWorkDirKey(workDir);
  const legacy = encodeLegacyWorkDirKey(workDir);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

export function isWorkDirKeyForRoot(id: string, root: string): boolean {
  return workDirKeyAliases(root).includes(id);
}

export function workspaceIdFromSessionDir(sessionDir: string): string | undefined {
  const parts = sessionDir.replaceAll('\\', '/').split('/').filter((part) => part !== '');
  const candidate = parts.at(-2);
  return candidate !== undefined && WORKDIR_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function workspaceRootKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  if (WIN_SHAPED.test(slashed)) {
    return stripTrailingSeparators(win32.normalize(slashed).replaceAll('\\', '/')).toLowerCase();
  }
  return stripTrailingSeparators(posix.normalize(root));
}

function encodeNormalizedWorkDirKey(normalized: string): string {
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

function stripTrailingSeparators(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

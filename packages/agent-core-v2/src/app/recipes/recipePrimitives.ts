import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { Error2, ErrorCodes } from '#/errors';

export function recipeFailure(message: string, source?: string, path?: string): never {
  throw new Error2(ErrorCodes.VALIDATION_FAILED, message, { details: { source, path } });
}
function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}
function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value);
}
export function isRecipeFileReference(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === 'off' || trimmed.startsWith('installation:') || hasUrlScheme(trimmed)) return false;
  const expanded = expandHome(trimmed);
  return path.isAbsolute(expanded) || trimmed.startsWith('.') || trimmed.startsWith('~') || /[\\/]/.test(trimmed) || trimmed.toLowerCase().endsWith('.toml');
}
export function resolveRecipeFileLocator(value: string, baseDir?: string): string {
  const trimmed = value.trim();
  const expanded = expandHome(trimmed);
  if (!path.isAbsolute(expanded) && (baseDir === undefined || baseDir.trim().length === 0)) recipeFailure('Recipe file path is relative and has no profile directory', trimmed);
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir!, expanded);
  return path.normalize(absolute).replaceAll('\\', '/');
}
export function recipePackageDirectory(locator: string): string | undefined {
  if (hasUrlScheme(locator) || locator.startsWith('installation:')) return undefined;
  return path.dirname(locator);
}
export function validateRecipePath(file: string): string {
  if (/[\\:<>|"*?\u0000-\u001F]/u.test(file) || file.startsWith('/') || file.split('/').some((part) => part === '..' || part === '.' || part.length === 0 || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) recipeFailure('Recipe file must be a relative path inside its package', undefined, file);
  return file;
}
export function recipeDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

import { createHash } from 'node:crypto';
import { Error2, ErrorCodes } from '#/errors';

export function recipeFailure(message: string, source?: string, path?: string): never {
  throw new Error2(ErrorCodes.VALIDATION_FAILED, message, { details: { source, path } });
}
export function validateRecipePath(file: string): string {
  if (/[\\:<>|"*?\u0000-\u001F]/u.test(file) || file.startsWith('/') || file.split('/').some((part) => part === '..' || part === '.' || part.length === 0 || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) recipeFailure('Recipe file must be a relative path inside its package', undefined, file);
  return file;
}
export function recipeDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

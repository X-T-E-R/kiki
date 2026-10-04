import { homedir } from 'node:os';

/** Display alias only: compare both separator shapes without rewriting the path. */
export function homeAlias(path: string, home = homedir()): string {
  const normalizedPath = path.replaceAll('\\', '/');
  const normalizedHome = home.replaceAll('\\', '/');
  if (normalizedHome !== '' && (
    normalizedPath === normalizedHome || normalizedPath.startsWith(`${normalizedHome}/`)
  )) {
    return '~' + path.slice(home.length);
  }
  return path;
}

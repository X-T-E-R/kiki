import { sliceByColumn, visibleWidth } from '@kiki/pi-tui';

/**
 * Shortens a path to at most `maxWidth` terminal cells by dropping whole
 * middle segments, so it is never cut inside a directory or file name:
 * `apps/kimi-code/src/tui/daemon/transcript-renderer.ts` at 36 cells becomes
 * `apps/…/daemon/transcript-renderer.ts`. The first segment (or leading POSIX
 * `/<root>` segment) is kept when it fits, then as many trailing segments as
 * fit. Only a file name wider than the whole budget is cut, keeping its tail.
 */
export function ellipsizePathMiddle(path: string, maxWidth: number): string {
  if (visibleWidth(path) <= maxWidth) return path;
  if (maxWidth <= 1) return '…';

  const normalized = path.includes('/') && path.includes('\\') ? path.replaceAll('\\', '/') : path;
  const sep = !normalized.includes('/') && normalized.includes('\\') ? '\\' : '/';
  const segments = normalized.split(sep);
  const last = segments.length - 1;
  const fileName = segments[last] ?? '';
  const head = segments[0] ?? '';

  const fit = (prefix: string, minDropIndex: number): string | undefined => {
    let tailStart = last;
    let best: string | undefined;
    while (tailStart >= minDropIndex) {
      const candidate = `${prefix}…${sep}${segments.slice(tailStart).join(sep)}`;
      if (visibleWidth(candidate) > maxWidth) break;
      best = candidate;
      if (tailStart === minDropIndex) break;
      tailStart--;
    }
    return best;
  };

  if (last >= 2 && head.length > 0) {
    const withHead = fit(`${head}${sep}`, 2);
    if (withHead !== undefined) return withHead;
  } else if (head === '' && last >= 3 && (segments[1]?.length ?? 0) > 0) {
    const withPosixRoot = fit(`${sep}${segments[1]}${sep}`, 3);
    if (withPosixRoot !== undefined) return withPosixRoot;
  }
  if (last >= 1) {
    const withoutHead = fit('', head === '' ? 2 : 1);
    if (withoutHead !== undefined) return withoutHead;
  }
  const keep = maxWidth - 1;
  const width = visibleWidth(fileName);
  return width <= keep
    ? `…${fileName}`
    : `…${sliceByColumn(fileName, width - keep, keep, true)}`;
}

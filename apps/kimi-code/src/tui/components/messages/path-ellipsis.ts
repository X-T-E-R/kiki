import { sliceByColumn, visibleWidth } from '@kiki/pi-tui';

/**
 * Shortens a path to at most `maxWidth` terminal cells by dropping whole
 * middle segments, so it is never cut inside a directory or file name:
 * `apps/kimi-code/src/tui/daemon/transcript-renderer.ts` at 36 cells becomes
 * `apps/…/daemon/transcript-renderer.ts`. The first segment is kept when it
 * fits, then as many trailing segments as fit. Only a file name wider than
 * the whole budget is cut, keeping its tail.
 */
export function ellipsizePathMiddle(path: string, maxWidth: number): string {
  if (visibleWidth(path) <= maxWidth) return path;
  if (maxWidth <= 1) return '…';

  const sep = !path.includes('/') && path.includes('\\') ? '\\' : '/';
  const segments = path.split(sep);
  const last = segments.length - 1;
  const fileName = segments[last] ?? '';
  const head = segments[0] ?? '';

  const fit = (prefix: string): string | undefined => {
    let tailStart = last;
    let best: string | undefined;
    // Never let the tail reach segment 1: the middle must drop something.
    while (tailStart >= 1) {
      const candidate = `${prefix}…${sep}${segments.slice(tailStart).join(sep)}`;
      if (visibleWidth(candidate) > maxWidth) break;
      best = candidate;
      if (tailStart === 1 || (prefix.length > 0 && tailStart === 2)) break;
      tailStart--;
    }
    return best;
  };

  if (last >= 2 && head.length > 0) {
    const withHead = fit(`${head}${sep}`);
    if (withHead !== undefined) return withHead;
  }
  if (last >= 1) {
    const withoutHead = fit('');
    if (withoutHead !== undefined) return withoutHead;
  }
  const keep = maxWidth - 1;
  const width = visibleWidth(fileName);
  return width <= keep
    ? `…${fileName}`
    : `…${sliceByColumn(fileName, width - keep, keep, true)}`;
}

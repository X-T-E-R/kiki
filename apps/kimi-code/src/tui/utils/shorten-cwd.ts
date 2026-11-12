import { homeAlias } from '#/tui/utils/home-alias';

const DEFAULT_MAX_CWD_SEGMENTS = 3;

export function shortenCwd(path: string, maxSegments = DEFAULT_MAX_CWD_SEGMENTS): string {
  if (!path) return path;
  const work = homeAlias(path);
  const segments = work.split(/[\\/]/u).filter((segment) => segment.length > 0);
  const segmentLimit = Math.max(1, Math.trunc(maxSegments));
  if (segments.length <= segmentLimit) return work;
  return `…/${segments.slice(-segmentLimit).join('/')}`;
}

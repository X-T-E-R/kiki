import { visibleWidth } from '@kiki/pi-tui';

/** Greedily packs complete hint segments onto lines, wrapping only at segment boundaries. */
export function layoutHintLines(parts: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';

  for (const part of parts) {
    const candidate = current.length === 0 ? part : `${current} · ${part}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = part;
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

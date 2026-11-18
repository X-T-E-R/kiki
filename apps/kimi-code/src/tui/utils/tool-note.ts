export interface ParsedToolNote {
  readonly actionableLines: readonly string[];
  readonly systemLines: readonly string[];
}

const SYSTEM_TAG_RE = /<system>([\s\S]*?)<\/system>/giu;

/**
 * Split a tool result's side-channel `note` into actionable warnings (such as
 * stale-read edit notices or clamped timeout notes, visible in both collapsed
 * and expanded views) and `<system>...</system>` metadata lines (shown when
 * expanded via Ctrl+O without raw XML tags).
 */
export function parseToolSideChannelNote(note: string | undefined): ParsedToolNote {
  if (note === undefined || note.trim().length === 0) {
    return { actionableLines: [], systemLines: [] };
  }
  const systemLines: string[] = [];
  const remainder = note.replace(SYSTEM_TAG_RE, (_match, inner: string) => {
    for (const line of inner.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) systemLines.push(trimmed);
    }
    return '\n';
  });
  const actionableLines = remainder
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { actionableLines, systemLines };
}

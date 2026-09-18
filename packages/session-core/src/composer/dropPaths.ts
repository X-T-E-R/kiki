/**
 * Dropped-file path insertion for the composer draft.
 *
 * Dropping OS files onto the composer is a text gesture: the draft gains each
 * file's path at the caret — no attachment chip, no upload. A path containing
 * whitespace is wrapped in double quotes so it survives as one token, and
 * several dropped files join with single spaces. Separating whitespace is
 * added only where the surrounding draft text needs it.
 */

/** Wrap a dropped path in quotes when it would otherwise split into tokens. */
export function quoteDroppedPath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/**
 * Insert dropped file paths into `text` at `selection` (a collapsed caret is
 * the common case; a range is replaced, matching native text-drop behavior).
 * Returns the next draft text plus the caret position right after the
 * insertion. Blank paths are skipped; an empty usable list leaves the draft
 * untouched.
 */
export function insertDroppedPaths(
  text: string,
  selection: { readonly start: number; readonly end: number },
  paths: readonly string[],
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(Math.min(selection.start, selection.end), text.length));
  const end = Math.max(0, Math.min(Math.max(selection.start, selection.end), text.length));
  const usable = paths.filter((path) => path.trim() !== '');
  if (usable.length === 0) return { text, cursor: start };
  const joined = usable.map(quoteDroppedPath).join(' ');
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const suffix = after !== '' && !/^\s/.test(after) ? ' ' : '';
  const inserted = `${prefix}${joined}${suffix}`;
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}

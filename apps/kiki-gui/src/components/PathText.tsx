/**
 * PathText — a file path on one line that keeps its file name.
 *
 * A path cut from the right (`C:/fixture/worksho…`) loses the one part that
 * tells two files apart. This renders the directory and the file name as two
 * parts: the directory shrinks first and is cut on its LEFT (`…kshop/`), the
 * file name keeps its width; only when the name alone does not fit is it cut,
 * in its middle, so the extension stays readable (`Interac…s.test.tsx`).
 *
 * Callers pass the structured path (a display payload's `path`), never text
 * parsed out of a server description. The whole path is the hover title.
 *
 * Layout contract: the root is `inline-flex max-w-full min-w-0`, so it fits a
 * container whose width is set. When other text precedes it on the same line,
 * put both in a flex row (the label `shrink-0`) — `max-w-full` alone would
 * size it to the whole line and push its end past the clip.
 */

export interface PathParts {
  /** Everything up to and including the last separator; '' for a bare name. */
  readonly dir: string;
  /** The last segment (a trailing separator stays with it). */
  readonly name: string;
}

/** Splits a path into its directory and its last segment, on `/` or `\`. */
export function splitPath(path: string): PathParts {
  // A trailing separator (a directory path) belongs to the last segment.
  const end = path.replace(/[\\/]+$/, '').length;
  if (end === 0) return { dir: '', name: path };
  const cut = Math.max(path.lastIndexOf('/', end - 1), path.lastIndexOf('\\', end - 1));
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/**
 * Where a name that does not fit is cut: the tail (up to 12 characters, never
 * more than half) always shows, the head gives way with an ellipsis.
 */
function nameTail(name: string): number {
  return Math.min(Math.floor(name.length / 2), 12);
}

export function PathText({ path, className }: { path: string; className?: string }) {
  const { dir, name } = splitPath(path);
  const tail = nameTail(name);
  return (
    <span data-path-text title={path} className={`inline-flex max-w-full min-w-0 align-bottom ${className ?? ''}`}>
      {dir === '' ? null : (
        // Right-to-left so the overflow and its ellipsis fall on the left; the
        // isolate keeps the path itself reading left to right (a leading `/`
        // or `C:` would otherwise be reordered to the far end).
        <span data-path-dir className="min-w-0 truncate [direction:rtl]">
          <bdi dir="ltr">{dir}</bdi>
        </span>
      )}
      {/* Never wider than the whole line: past that its head is cut instead. */}
      <span data-path-name className="flex max-w-full min-w-0 shrink-0">
        <span className="min-w-0 truncate">{name.slice(0, name.length - tail)}</span>
        <span className="shrink-0 whitespace-pre">{name.slice(name.length - tail)}</span>
      </span>
    </span>
  );
}

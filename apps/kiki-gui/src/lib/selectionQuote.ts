/**
 * Selection-to-quote support: pure helpers behind the transcript's floating
 * "quote" button. Kept DOM-light so the containment/geometry rules are unit
 * testable under jsdom; the React component (`SelectionQuoteButton`) only
 * wires listeners to these.
 */

/**
 * Formats a quoted selection as a Markdown blockquote prefix for the outgoing
 * prompt text: every line becomes `> …` (blank lines collapse to `>`), and a
 * blank line separates the quote from the typed text that follows.
 */
export function buildQuotePrefix(quote: string): string {
  const lines = quote.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const body = lines
    .map((line) => {
      const trimmed = line.trimEnd();
      return trimmed === '' ? '>' : `> ${trimmed}`;
    })
    .join('\n');
  return `${body}\n\n`;
}

/**
 * The selection's trimmed text when it lives entirely inside `container`
 * (both anchor and focus), else null. Collapsed/whitespace-only selections
 * return null — there is nothing to quote.
 */
export function selectionTextWithin(container: Node, selection: Selection): string | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (anchorNode === null || focusNode === null) return null;
  if (!container.contains(anchorNode) || !container.contains(focusNode)) return null;
  const text = selection.toString().trim();
  return text === '' ? null : text;
}

/**
 * Bounding rect of the selection's first range — the floating button anchors
 * above it. Zero-size rects (e.g. detached ranges) return null.
 */
export function selectionAnchorRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  // Non-browser hosts (jsdom) lack range geometry entirely.
  if (typeof range.getBoundingClientRect !== 'function') return null;
  const rect = range.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/**
 * Touch devices get no floating quote button: mobile text selection is
 * handle-driven and a hover-style popover fights the native callout bar.
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

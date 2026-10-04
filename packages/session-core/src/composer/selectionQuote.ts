/**
 * Selection-to-quote support: pure helpers behind the transcript's floating
 * "quote" button. Kept DOM-light so the containment/geometry rules are unit
 * testable under jsdom; the React component (`SelectionQuoteButton`) only
 * wires listeners to these.
 */

/** Message version and offsets in whitespace-canonical rendered text, never raw Markdown. */
export interface SelectionSourceAnchor {
  readonly blockId: string;
  readonly version: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Source selection plus the user's comment; null source explicitly means no valid anchor. */
export interface SelectionAnnotation {
  readonly id: string;
  readonly quote: string;
  readonly comment: string;
  readonly source?: SelectionSourceAnchor | null;
}

/** Whitespace differs between streaming paragraphs and a whole-document parse. */
export function canonicalSelectionText(text: string): string {
  return text.replaceAll(/\s/gu, '');
}

export function sourceTextVersion(text: string): string {
  let hash = 2166136261;
  for (const character of text) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  }
  const unsigned = hash < 0 ? hash + 0x1_0000_0000 : hash;
  return `${text.length}-${unsigned.toString(16)}`;
}

/** Capture the actual message and rendered occurrence, before focus collapses selection. */
export function selectionSourceAnchor(selection: Selection): SelectionSourceAnchor | null {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const element = range.startContainer.nodeType === 1
    ? range.startContainer as Element : range.startContainer.parentElement;
  const source = element?.closest<HTMLElement>('[data-source-block-id]');
  if (source === undefined || source === null || !source.contains(range.endContainer)) return null;
  const blockId = source.dataset['sourceBlockId'];
  const version = source.dataset['sourceVersion'];
  if (blockId === undefined || version === undefined) return null;
  const walker = source.ownerDocument.createTreeWalker(source, 4);
  let prefix = '';
  let selected = '';
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    if (node.parentElement?.closest('button, [data-source-ignore], .kiki-cb-tools, [data-streamdown="code-block-header"]') !== null) continue;
    const value = node.textContent ?? '';
    const length = value.length;
    const start = range.comparePoint(node, 0);
    const end = range.comparePoint(node, length);
    if (end === -1) prefix += value;
    else if (start !== 1) {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : length;
      prefix += value.slice(0, from);
      selected += value.slice(from, to);
    }
  }
  const start = canonicalSelectionText(prefix).length;
  const text = canonicalSelectionText(selected);
  return text === '' ? null : { blockId, version, start, end: start + text.length, text };
}

export function buildSourceAnchorPrefix(source?: SelectionSourceAnchor | null): string {
  return source === undefined ? '' : `<!-- kiki-source:${encodeURIComponent(JSON.stringify(source))} -->\n\n`;
}

/** Invalid explicit anchors stay invalid; never guess another message from their quote. */
export function parseSourceAnchor(line: string): SelectionSourceAnchor | null {
  if (!line.startsWith('<!-- kiki-source:') || !line.endsWith(' -->')) return null;
  try {
    const value = JSON.parse(decodeURIComponent(line.slice('<!-- kiki-source:'.length, -' -->'.length))) as SelectionSourceAnchor;
    if (value !== null && typeof value.blockId === 'string' && typeof value.version === 'string'
      && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
      && value.start >= 0 && value.end > value.start && typeof value.text === 'string'
      && value.text.length === value.end - value.start) return value;
  } catch { /* malformed history is not an anchor */ }
  return null;
}

/** Resolve only the captured rendered occurrence, without quote searching. */
export function anchoredSelectionRange(text: string, source: SelectionSourceAnchor): { start: number; end: number } | null {
  const offsets: number[] = [];
  let canonical = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (/\s/u.test(character)) continue;
    offsets.push(index);
    canonical += character;
  }
  if (canonical.slice(source.start, source.end) !== source.text) return null;
  const start = offsets[source.start];
  const last = offsets[source.end - 1];
  return start === undefined || last === undefined ? null : { start, end: last + 1 };
}

let annotationSeq = 0;

/** Creates an annotation with a session-unique id (counter is test-stable). */
export function createAnnotation(quote: string, comment: string, source?: SelectionSourceAnchor | null): SelectionAnnotation {
  annotationSeq += 1;
  return source === undefined ? { id: `annotation-${annotationSeq}`, quote, comment }
    : { id: `annotation-${annotationSeq}`, quote, comment, source };
}

/** Appends a new annotation — selections accumulate, they never overwrite. */
export function addAnnotation(
  list: readonly SelectionAnnotation[],
  quote: string,
  comment: string,
  source?: SelectionSourceAnchor | null,
): SelectionAnnotation[] {
  return [...list, createAnnotation(quote, comment, source)];
}

/** Removes one annotation by id, leaving the rest in order. */
export function removeAnnotation(
  list: readonly SelectionAnnotation[],
  id: string,
): SelectionAnnotation[] {
  return list.filter((annotation) => annotation.id !== id);
}

/**
 * Formats a quoted selection as a Markdown blockquote prefix for the outgoing
 * prompt text: every line becomes `> …` (blank lines collapse to `>`), and a
 * blank line separates the quote from the typed text that follows.
 */
export function buildQuotePrefix(quote: string, source?: SelectionSourceAnchor | null): string {
  const lines = quote.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const body = lines
    .map((line) => {
      const trimmed = line.trimEnd();
      return trimmed === '' ? '>' : `> ${trimmed}`;
    })
    .join('\n');
  return `${body}\n\n${buildSourceAnchorPrefix(source)}`;
}

/**
 * Formats one annotation as a structured prompt segment: the source text as a
 * Markdown blockquote immediately followed by the comment on its own line,
 * then a blank separator. The transcript renders this back as a quote block
 * plus a plain comment line — no protocol change, plain text only.
 */
export function buildAnnotationBlock(annotation: { quote: string; comment: string; source?: SelectionSourceAnchor | null }): string {
  const comment = annotation.comment.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  return `${buildQuotePrefix(annotation.quote, annotation.source)}Comment: ${comment}\n\n`;
}

/**
 * Concatenates every annotation segment in order (empty list → empty string).
 * Prepended before the plain quote prefix so annotations lead the prompt.
 */
export function buildAnnotationsPrefix(
  annotations: readonly { quote: string; comment: string; source?: SelectionSourceAnchor | null }[],
): string {
  return annotations.map((annotation) => buildAnnotationBlock(annotation)).join('');
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

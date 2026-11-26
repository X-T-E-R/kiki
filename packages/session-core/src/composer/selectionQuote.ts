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

/** Quoted source selection without comment; accumulates alongside annotations. */
export interface SelectionQuote {
  readonly id: string;
  readonly quote: string;
  readonly source?: SelectionSourceAnchor | null;
}

const MAX_VERSION_CACHE = 128;
const sourceVersionCache = new Map<string, string>();

const MAX_CANONICAL_INDEX_CACHE = 16;

interface CanonicalTextIndex {
  readonly canonical: string;
  readonly offsets: Int32Array;
}

const canonicalIndexCache = new Map<string, CanonicalTextIndex>();

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c;
}

function getCanonicalTextIndex(text: string): CanonicalTextIndex {
  const cached = canonicalIndexCache.get(text);
  if (cached !== undefined) {
    canonicalIndexCache.delete(text);
    canonicalIndexCache.set(text, cached);
    return cached;
  }
  const length = text.length;
  const canonical = canonicalSelectionText(text);
  const offsets = new Int32Array(canonical.length);
  let kept = 0;
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x20) {
      if (isAsciiWhitespace(code)) continue;
    } else if (code >= 0x80 && /\s/u.test(text[index]!)) {
      continue;
    }
    offsets[kept] = index;
    kept += 1;
  }
  const entry: CanonicalTextIndex = {
    canonical,
    offsets: kept === offsets.length ? offsets : offsets.subarray(0, kept),
  };
  if (canonicalIndexCache.size >= MAX_CANONICAL_INDEX_CACHE) {
    const oldest = canonicalIndexCache.keys().next().value;
    if (oldest !== undefined) canonicalIndexCache.delete(oldest);
  }
  canonicalIndexCache.set(text, entry);
  return entry;
}

/** Whitespace differs between streaming paragraphs and a whole-document parse. */
export function canonicalSelectionText(text: string): string {
  return text.replaceAll(/\s/gu, '');
}

export function sourceTextVersion(text: string): string {
  if (typeof text === 'string') {
    const cached = sourceVersionCache.get(text);
    if (cached !== undefined) {
      sourceVersionCache.delete(text);
      sourceVersionCache.set(text, cached);
      return cached;
    }
    let hash = 2166136261;
    const length = text.length;
    for (let index = 0; index < length; ) {
      const cp = text.codePointAt(index)!;
      hash = Math.imul(hash ^ cp, 16777619);
      index += cp > 0xffff ? 2 : 1;
    }
    const unsigned = hash < 0 ? hash + 0x1_0000_0000 : hash;
    const version = `${length}-${unsigned.toString(16)}`;
    if (sourceVersionCache.size >= MAX_VERSION_CACHE) {
      const oldest = sourceVersionCache.keys().next().value;
      if (oldest !== undefined) sourceVersionCache.delete(oldest);
    }
    sourceVersionCache.set(text, version);
    return version;
  }
  const iterable = text as unknown as Iterable<string> & { readonly length: number };
  let hash = 2166136261;
  for (const character of iterable) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  }
  const unsigned = hash < 0 ? hash + 0x1_0000_0000 : hash;
  return `${iterable.length}-${unsigned.toString(16)}`;
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
  let prefix = '';
  let selected = '';
  let hasCanonicalSelected = false;
  let omittedBefore = 0;
  let pendingOmittedGap = false;
  let crossedOmittedGap = false;
  const visit = (parent: Node): void => {
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const value = child.textContent ?? '';
        const length = value.length;
        const start = range.comparePoint(child, 0);
        const end = range.comparePoint(child, length);
        if (end === -1) prefix += value;
        else if (start !== 1) {
          const from = child === range.startContainer ? range.startOffset : 0;
          const to = child === range.endContainer ? range.endOffset : length;
          prefix += value.slice(0, from);
          const slice = value.slice(from, to);
          if (canonicalSelectionText(slice) !== '') {
            if (pendingOmittedGap) crossedOmittedGap = true;
            hasCanonicalSelected = true;
          }
          selected += slice;
        }
        continue;
      }
      if (child.nodeType === 1) {
        const el = child as Element;
        if (el.matches('button, [data-source-ignore], .kiki-cb-tools, [data-streamdown="code-block-header"]')) continue;
        visit(el);
        const omittedRaw = el.getAttribute('data-source-omitted-canonical-chars');
        if (omittedRaw !== null) {
          const omitted = Number(omittedRaw);
          if (Number.isSafeInteger(omitted) && omitted > 0) {
            const gapPos = range.comparePoint(el, el.childNodes.length);
            if (gapPos === -1 || (gapPos === 0 && !hasCanonicalSelected)) {
              omittedBefore += omitted;
            } else if (gapPos === 0) {
              pendingOmittedGap = true;
            }
          }
        }
      }
    }
  };
  visit(source);
  if (crossedOmittedGap) return null;
  const start = canonicalSelectionText(prefix).length + omittedBefore;
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
  if (source.start < 0 || source.end <= source.start) return null;
  const indexed = getCanonicalTextIndex(text);
  if (source.end > indexed.canonical.length) return null;
  if (!indexed.canonical.startsWith(source.text, source.start)) return null;
  const start = indexed.offsets[source.start];
  const last = indexed.offsets[source.end - 1];
  return start === undefined || last === undefined ? null : { start, end: last + 1 };
}

let quoteSeq = 0;

/** Creates a quote item with a session-unique id. */
export function createQuote(quote: string, source?: SelectionSourceAnchor | null): SelectionQuote {
  quoteSeq += 1;
  return source === undefined ? { id: `quote-${quoteSeq}`, quote }
    : { id: `quote-${quoteSeq}`, quote, source };
}

/** Appends a new quote — quotes accumulate in selection order. */
export function addQuote(
  list: readonly SelectionQuote[],
  quote: string,
  source?: SelectionSourceAnchor | null,
): SelectionQuote[] {
  return [...list, createQuote(quote, source)];
}

/** Removes one quote by id, leaving the rest in order. */
export function removeQuote(
  list: readonly SelectionQuote[],
  id: string,
): SelectionQuote[] {
  return list.filter((item) => item.id !== id);
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
  const quote = buildQuotePrefix(annotation.quote, annotation.source);
  return comment === '' ? quote : `${quote}Comment: ${comment}\n\n`;
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

const NON_QUOTABLE_ANCESTOR_SELECTOR =
  '[data-history-fold], [data-system-reminder], [data-system-message], [data-hook-row], [data-tool-row], [data-thinking-row], [data-composer-root]';

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
 * Trimmed selection text when both endpoints live inside a single user or
 * assistant `[data-source-block-id]` message body within `container` and
 * outside internal system/process/fold chrome.
 */
export function selectionQuotableTextWithin(container: Node, selection: Selection): string | null {
  const text = selectionTextWithin(container, selection);
  if (text === null || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const startEl = range.startContainer.nodeType === 1
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  const endEl = range.endContainer.nodeType === 1
    ? range.endContainer as Element
    : range.endContainer.parentElement;
  if (startEl === null || endEl === null) return null;
  const startSource = startEl.closest<HTMLElement>('[data-source-block-id]');
  const endSource = endEl.closest<HTMLElement>('[data-source-block-id]');
  if (startSource === null || startSource !== endSource || !container.contains(startSource)) return null;
  const blockId = startSource.dataset['sourceBlockId'];
  if (blockId === undefined || blockId === '') return null;
  if (
    startEl.closest(NON_QUOTABLE_ANCESTOR_SELECTOR) !== null ||
    endEl.closest(NON_QUOTABLE_ANCESTOR_SELECTOR) !== null
  ) {
    return null;
  }
  return text;
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

export function selectionCarryoverPresentation(
  annotations: readonly { quote: string; comment: string; source?: SelectionSourceAnchor | null }[],
  quoteOrQuotes: string | null | readonly { quote: string; source?: SelectionSourceAnchor | null }[],
  quoteSource?: SelectionSourceAnchor | null,
): { prefix: string; presentation: import('@kiki/transcript').TextPresentation } {
  let prefix = '';
  const spans: import('@kiki/transcript').TextPresentationSpan[] = [];
  for (const annotation of annotations) {
    const start = prefix.length;
    prefix += buildAnnotationBlock(annotation);
    const comment = annotation.comment.trim();
    spans.push({ start, end: prefix.length, kind: 'selection', quote: annotation.quote, comment: comment === '' ? undefined : annotation.comment, source: annotation.source });
  }
  const quotesList = Array.isArray(quoteOrQuotes)
    ? quoteOrQuotes
    : (quoteOrQuotes !== null ? [{ quote: quoteOrQuotes, source: quoteSource }] : []);

  for (const item of quotesList) {
    const start = prefix.length;
    prefix += buildQuotePrefix(item.quote, item.source);
    spans.push({ start, end: prefix.length, kind: 'selection', quote: item.quote, source: item.source });
  }
  return { prefix, presentation: { spans } };
}

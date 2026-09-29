/**
 * Timeline find — Ctrl/⌘+F "find in this conversation".
 *
 * Matching runs over the projected blocks (the data model), not the DOM: the
 * timeline is virtualized and folds settled work, so most matches are never
 * mounted. A match names a leaf block and an occurrence inside it; landing on
 * one goes through the locate entry (paging, fold opening) and the leaf's own
 * disclosure, then the mounted text is painted with the CSS Custom Highlight
 * API — no marks are inserted, so markdown and code rendering are untouched.
 *
 * This module owns the pure parts (pattern, counting, DOM ranges, highlight
 * registry) and the tiny host registry the app-level shortcut opens.
 */

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false };

/** Queries longer than this are cut: a pasted paragraph is not a search. */
export const FIND_QUERY_MAX = 200;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The query as a global regex, or null for an empty query. Whole-word uses
 * Unicode letter/number boundaries (`\b` is ASCII-only and never fires
 * between CJK characters).
 */
export function buildFindPattern(query: string, options: FindOptions): RegExp | null {
  if (query === '') return null;
  const body = escapeRegExp(query);
  const source = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(source, options.caseSensitive ? 'gu' : 'giu');
}

/** Every [start, end) occurrence of the pattern in the text. */
export function matchOffsets(text: string, pattern: RegExp): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    out.push([match.index, match.index + match[0].length]);
  }
  return out;
}

/** One searchable leaf of the displayed timeline, in display order. */
export interface FindItem {
  /** The leaf block id: the locate target and the DOM scope. */
  readonly blockId: string;
  /** Disclosures to open (outermost first) so the leaf's text is on screen. */
  readonly reveal: readonly string[];
  /** Tool leaves have no `data-block-id` of their own; they scope by call id. */
  readonly toolCallId?: string;
  /** `t12` style turn of the leaf, when it has one. */
  readonly turnId?: string;
  readonly text: string;
}

export interface FindMatch {
  readonly item: FindItem;
  /** Index of this occurrence among the item's own matches. */
  readonly occurrence: number;
  /** Offset in `item.text` (ordering / tests). */
  readonly start: number;
}

export function collectMatches(items: readonly FindItem[], pattern: RegExp | null): FindMatch[] {
  if (pattern === null) return [];
  const out: FindMatch[] = [];
  for (const item of items) {
    matchOffsets(item.text, pattern).forEach(([start], occurrence) => {
      out.push({ item, occurrence, start });
    });
  }
  return out;
}

/** `t12` / `12` → 12; undefined when the id carries no ordinal. */
export function turnOrdinal(turnId: string | undefined): number | undefined {
  if (turnId === undefined) return undefined;
  const match = /^t?(\d+)$/.exec(turnId);
  return match === null ? undefined : Number(match[1]);
}

/** Markdown source → roughly the text the reader sees (links, emphasis, fences). */
export function markdownVisibleText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, ''),
    )
    .join('\n');
}

// ---- DOM side: text ranges and painting ----------------------------------

/** Text nodes under `root` in document order, skipping hidden subtrees. */
function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[aria-hidden="true"], [hidden], [data-find-skip]') !== null) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) out.push(node as Text);
  return out;
}

/** Every rendered occurrence of the pattern under `root`, as DOM ranges. */
export function findRanges(root: Node, pattern: RegExp): Range[] {
  const nodes = textNodes(root);
  if (nodes.length === 0) return [];
  const starts: number[] = [];
  let text = '';
  for (const node of nodes) {
    starts.push(text.length);
    text += node.data;
  }
  const doc = root.ownerDocument ?? document;
  const locateOffset = (offset: number): [Text, number] => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return [nodes[low]!, offset - starts[low]!];
  };
  return matchOffsets(text, pattern).map(([start, end]) => {
    const range = doc.createRange();
    const [startNode, startOffset] = locateOffset(start);
    const [endNode, endOffset] = locateOffset(end - 1);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset + 1);
    return range;
  });
}

export const FIND_HIGHLIGHT = 'kiki-find';
export const FIND_HIGHLIGHT_CURRENT = 'kiki-find-current';

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { registry: HighlightRegistry; make: (ranges: Range[]) => unknown } | undefined {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (css?.highlights === undefined || Ctor === undefined) return undefined;
  return { registry: css.highlights, make: (ranges) => new Ctor(...ranges) };
}

const painted = new Map<symbol, { ranges: Range[]; current: Range | undefined }>();

function repaint(): void {
  const api = highlightApi();
  if (api === undefined) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const entry of painted.values()) {
    for (const range of entry.ranges) if (range !== entry.current) all.push(range);
    if (entry.current !== undefined) current.push(entry.current);
  }
  if (all.length === 0) api.registry.delete(FIND_HIGHLIGHT);
  else api.registry.set(FIND_HIGHLIGHT, api.make(all));
  if (current.length === 0) api.registry.delete(FIND_HIGHLIGHT_CURRENT);
  else api.registry.set(FIND_HIGHLIGHT_CURRENT, api.make(current));
}

/** Paint one owner's matches; `ranges` empty clears that owner. */
export function paintFindHighlights(owner: symbol, ranges: Range[], current: Range | undefined): void {
  if (ranges.length === 0 && current === undefined) painted.delete(owner);
  else painted.set(owner, { ranges, current });
  repaint();
}

/** True when the rendered range sits under an element clamped shut. */
export function rangeIsClipped(range: Range): boolean {
  const start = range.startContainer.parentElement;
  const clamp = start?.closest<HTMLElement>('[data-collapsible-content]');
  if (clamp === null || clamp === undefined || typeof range.getBoundingClientRect !== 'function') return false;
  const box = clamp.getBoundingClientRect();
  const rect = range.getBoundingClientRect();
  return box.height > 0 && rect.bottom > box.bottom + 1;
}

// ---- host registry: which mounted timeline Ctrl+F opens ------------------

export interface FindHost {
  /** The timeline's own box (hidden tabs report false). */
  readonly isVisible: () => boolean;
  /** The timeline's scroll box. */
  readonly root: () => HTMLElement | null;
  readonly open: (request: { readonly prefill?: string; readonly returnFocus: HTMLElement | null }) => void;
  /** F3 / Shift+F3: step, opening the bar first when it is closed. */
  readonly step: (direction: 1 | -1, returnFocus: HTMLElement | null) => void;
  /** Last time the reader pointed at or focused inside this timeline. */
  lastUsedAt: number;
}

/** The preview workspace a node sits in (null = the routed session view). */
function regionOf(node: Element | null): Element | null {
  return node?.closest('[data-preview-workspace]') ?? null;
}

const hosts: FindHost[] = [];

export function registerFindHost(host: FindHost): () => void {
  hosts.push(host);
  return () => {
    const index = hosts.indexOf(host);
    if (index !== -1) hosts.splice(index, 1);
  };
}

/**
 * The timeline Ctrl+F belongs to: the visible one that holds focus, else the
 * one the reader touched last (a preview tab beside the main timeline), else
 * the newest visible mount.
 */
export function activeFindHost(active: Element | null = document.activeElement): FindHost | undefined {
  const visible = hosts.filter((host) => host.isVisible());
  if (visible.length <= 1) return visible[0];
  if (active !== null && active !== document.body) {
    const holder = visible.find((host) => host.root()?.contains(active) === true);
    if (holder !== undefined) return holder;
    // Focus in chrome around a timeline (its composer, its tab header): the
    // timeline in the same region — the preview workspace or the routed view.
    const region = regionOf(active);
    const sameRegion = visible.filter((host) => regionOf(host.root()) === region);
    if (sameRegion.length > 0) {
      return sameRegion.reduce((best, host) => (host.lastUsedAt >= best.lastUsedAt ? host : best));
    }
  }
  return visible.reduce((best, host) => (host.lastUsedAt >= best.lastUsedAt ? host : best));
}

/**
 * Text to seed the query with: a short single-line selection, from a text
 * field's own selection or the page selection.
 */
export function selectionPrefill(target: EventTarget | null): string | undefined {
  let text = '';
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, value } = target;
    if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
      text = value.slice(selectionStart, selectionEnd);
    }
  } else {
    text = document.getSelection()?.toString() ?? '';
  }
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.includes('\n')) return undefined;
  return trimmed.slice(0, FIND_QUERY_MAX);
}

export type FindRoute = 'session' | 'settings' | 'other';

/**
 * The app-level Ctrl+F / F3 decision. A session route opens (or steps) the
 * find bar of the timeline on screen; settings hands Ctrl+F to its own
 * search; every other route — the new-session page included — leaves the
 * key alone. Returns true when the key was taken (default prevented).
 */
export function handleFindShortcut(
  event: KeyboardEvent,
  route: FindRoute,
  handlers: { readonly overlayOpen: () => boolean; readonly focusSettingsSearch: () => void },
): boolean {
  const find = isFindShortcut(event);
  const stepKey = event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey;
  if ((!find && !stepKey) || route === 'other' || handlers.overlayOpen()) return false;
  if (route === 'settings') {
    if (!find) return false;
    event.preventDefault();
    handlers.focusSettingsSearch();
    return true;
  }
  const host = activeFindHost();
  if (host === undefined) return false;
  event.preventDefault();
  const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
  if (find) host.open({ prefill: selectionPrefill(event.target), returnFocus: focused });
  else host.step(event.shiftKey ? -1 : 1, focused);
  return true;
}

/** An attribute selector value, quoted (ids carry `:` and `/`). */
export function attrSelector(name: string, value: string): string {
  return `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
}

/** Ctrl+F / ⌘F (no Shift/Alt). */
export function isFindShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f';
}

/** App-level request to open the quick switcher's content search on a query. */
export const QUICK_SWITCHER_EVENT = 'kiki:open-quick-switcher';

export function requestQuickSwitcherSearch(query: string): void {
  window.dispatchEvent(new CustomEvent<{ query: string }>(QUICK_SWITCHER_EVENT, { detail: { query } }));
}

/**
 * Bring a range into view inside `outer`: every scrolling ancestor between
 * them (a clamped output well, then the timeline) centres it, but only when
 * it is not already comfortably visible.
 */
export function scrollRangeIntoView(range: Range, outer: HTMLElement): void {
  if (typeof range.getBoundingClientRect !== 'function') return;
  let node: HTMLElement | null = range.startContainer.parentElement;
  const chain: HTMLElement[] = [];
  while (node !== null && node !== outer) {
    if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) chain.push(node);
    node = node.parentElement;
  }
  chain.push(outer);
  for (const scroller of chain) {
    const rect = range.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) return;
    const margin = Math.min(64, box.height / 4);
    if (rect.top >= box.top + margin && rect.bottom <= box.bottom - margin) continue;
    scroller.scrollTop += rect.top - (box.top + box.height / 2) + rect.height / 2;
  }
}

/** Test-only. */
export function resetFindHostsForTests(): void {
  hosts.length = 0;
  painted.clear();
}

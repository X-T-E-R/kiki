/**
 * Timeline annotation derivation — the second half of the selection-carry-over
 * flow. `selectionQuote.ts` writes annotations into the outgoing prompt as
 * plain-text segments (`> quote` + `Comment: …`); this module is the inverse:
 * it parses those segments back out of settled user blocks and anchors each
 * quote to the nearest PRECEDING block whose text contains it, so the
 * transcript can mark the annotated passage in place and reopen the comment.
 *
 * The derivation is purely transcript-driven — no wire change, no extra
 * persistence: the local echo and the reloaded history carry the same text,
 * so markers reappear identically after a restart. The only stored state is
 * the user's local overlay on top of a derived annotation (an edited comment
 * or a removed marker), keyed by the carrying message identity, segment order,
 * original quote, and comment, then persisted with the composer drafts (the
 * same draftPersistence gate). Overrides are presentation-local: the sent
 * prompt text never changes.
 */

import { readSettings } from '../settings/settings';

/** One derived timeline marker; `comment: null` is a plain quote (no comment). */
export interface TimelineAnnotation {
  /** Stable segment id shared by the local echo and canonical history. */
  readonly id: string;
  /** The selected source text (newlines normalized, line ends trimmed). */
  readonly quote: string;
  readonly comment: string | null;
}

/** The minimal block shape the derivation needs — structural on purpose. */
export interface TimelineBlockLike {
  readonly id: string;
  readonly kind: string;
  readonly text?: string;
}

/** Local overlay for one derived annotation: a replacement comment or a removal. */
export interface AnnotationOverride {
  readonly comment?: string;
  readonly deleted?: boolean;
}

/**
 * Stable hash id for one carry-over segment. The source block and ordinal keep
 * identical annotations independently editable while preserving ids across the
 * optimistic echo and canonical history reload.
 */
export function annotationOverrideId(
  quote: string,
  comment: string,
  sourceBlockId = '',
  ordinal = 0,
): string {
  const input = `${sourceBlockId}\n${ordinal}\n${quote}\n${comment}`;
  let hash = 5381;
  for (const character of input) {
    hash = Math.imul(hash, 33) ^ (character.codePointAt(0) ?? 0);
  }
  const unsigned = hash < 0 ? hash + 0x1_0000_0000 : hash;
  return `ta-${unsigned.toString(16)}`;
}

/** Reconstructed selection carry-overs from one user message's text. */
export interface SelectionCarryovers {
  readonly annotations: readonly { quote: string; comment: string }[];
  readonly quote: string | null;
  /** The typed remainder after the carry-over prefix. */
  readonly body: string;
}

/**
 * Inverse of `buildAnnotationsPrefix` + `buildQuotePrefix`. The constructed
 * layout is annotation segments first (blockquote lines, a blank line, then a
 * single `Comment: ` line, then a blank line), at most one plain quote
 * (blockquote lines + a blank line), then the typed text. Parsing stops at the
 * first non-conforming line, which becomes the body — a hand-typed blockquote
 * degrades to "plain quote + body", a benign false positive.
 */
export function parseSelectionCarryovers(text: string): SelectionCarryovers {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const annotations: { quote: string; comment: string }[] = [];
  let quote: string | null = null;
  let index = 0;
  const readQuoteLines = (): string[] => {
    const collected: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? '';
      if (line === '>') {
        collected.push('');
      } else if (line.startsWith('> ')) {
        collected.push(line.slice(2));
      } else {
        break;
      }
      index += 1;
    }
    return collected;
  };
  const skipBlankLines = () => {
    while (index < lines.length && lines[index] === '') index += 1;
  };
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line !== '>' && !line.startsWith('> ')) break;
    const quoteLines = readQuoteLines();
    const quoteText = quoteLines.join('\n');
    skipBlankLines();
    const next = lines[index];
    if (next !== undefined && next.startsWith('Comment: ')) {
      annotations.push({ quote: quoteText, comment: next.slice('Comment: '.length) });
      index += 1;
      skipBlankLines();
      continue;
    }
    // A blockquote run with no Comment line is the plain quote chip; whatever
    // follows is the typed body.
    quote = quoteText;
    break;
  }
  return { annotations, quote, body: lines.slice(index).join('\n') };
}

/**
 * Match a rendered selection back to message text. Exact containment wins so
 * punctuation and whitespace remain inside the visual marker. Raw assistant
 * blocks still contain Markdown syntax, so a letter/number skeleton is the
 * fallback: its index map projects the rendered match back to raw offsets.
 * First occurrence wins. The scan is array-based (not `String.indexOf`) so
 * astral kept chars never shift the code-unit bookkeeping. Pure-decoration
 * fallback quotes carry no anchor characters and match nothing.
 */
export function findQuoteRange(
  haystack: string,
  quote: string,
): { readonly start: number; readonly end: number } | null {
  const exact = haystack.indexOf(quote);
  if (exact !== -1) return { start: exact, end: exact + quote.length };
  const KEEP = /[\p{L}\p{N}]/u;
  const keptChars = (text: string): string[] => {
    const kept: string[] = [];
    for (const char of text) {
      if (KEEP.test(char)) kept.push(char);
    }
    return kept;
  };
  const needle = keptChars(quote);
  if (needle.length === 0) return null;
  const hayChars = keptChars(haystack);
  // indexMap[k] = code-unit offset of the k-th kept char; units[k] = its
  // code-unit length (2 for astral chars, which `for…of` yields as one char).
  const indexMap: number[] = [];
  const units: number[] = [];
  let position = 0;
  let kept = 0;
  for (const char of haystack) {
    if (KEEP.test(char)) {
      indexMap.push(position);
      units.push(char.length);
      kept += 1;
    }
    position += char.length;
  }
  if (kept !== hayChars.length || needle.length > hayChars.length) return null;
  outer: for (let i = 0; i + needle.length <= hayChars.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hayChars[i + j] !== needle[j]) continue outer;
    }
    const start = indexMap[i];
    const last = indexMap[i + needle.length - 1];
    const lastUnits = units[i + needle.length - 1];
    if (start === undefined || last === undefined || lastUnits === undefined) return null;
    return { start, end: last + lastUnits };
  }
  return null;
}

/** Block kinds eligible as annotation anchors: message text only. */
const ANCHORABLE_KINDS = new Set(['user', 'assistant']);

/**
 * Derive every timeline marker from the visible blocks. Each settled user
 * block's carry-over segments anchor to the NEAREST preceding block that
 * contains the quote (the passage the user just read), never to the carrying
 * block itself. Segments that match nothing simply get no marker.
 */
export function collectTimelineAnnotations(
  blocks: readonly TimelineBlockLike[],
): ReadonlyMap<string, readonly TimelineAnnotation[]> {
  const targets = new Map<string, TimelineAnnotation[]>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined || block.kind !== 'user' || block.text === undefined) continue;
    const carry = parseSelectionCarryovers(block.text);
    const segments: readonly { quote: string; comment: string | null }[] = [
      ...carry.annotations,
      ...(carry.quote !== null ? [{ quote: carry.quote, comment: null }] : []),
    ];
    for (const [ordinal, segment] of segments.entries()) {
      if (segment.quote.trim() === '') continue;
      for (let back = index - 1; back >= 0; back -= 1) {
        const candidate = blocks[back];
        if (
          candidate === undefined ||
          !ANCHORABLE_KINDS.has(candidate.kind) ||
          candidate.text === undefined
        ) {
          continue;
        }
        if (findQuoteRange(candidate.text, segment.quote) === null) continue;
        const annotation: TimelineAnnotation = {
          id: annotationOverrideId(segment.quote, segment.comment ?? '', block.id, ordinal),
          quote: segment.quote,
          comment: segment.comment,
        };
        const list = targets.get(candidate.id);
        if (list === undefined) targets.set(candidate.id, [annotation]);
        else list.push(annotation);
        break;
      }
    }
  }
  return targets;
}

/** Apply local overlays: drop removed markers, swap in edited comments. */
export function applyAnnotationOverrides(
  targets: ReadonlyMap<string, readonly TimelineAnnotation[]>,
  overrides: Readonly<Record<string, AnnotationOverride>>,
): ReadonlyMap<string, readonly TimelineAnnotation[]> {
  if (Object.keys(overrides).length === 0) return targets;
  const next = new Map<string, readonly TimelineAnnotation[]>();
  for (const [blockId, list] of targets) {
    const resolved = list.flatMap((annotation) => {
      const override = overrides[annotation.id];
      if (override?.deleted === true) return [];
      if (override?.comment !== undefined) {
        return [{ ...annotation, comment: override.comment }];
      }
      return [annotation];
    });
    if (resolved.length > 0) next.set(blockId, resolved);
  }
  return next;
}

// ---- local override store (memory + optional localStorage mirror) ----

const STORAGE_KEY = 'kiki.annotationOverrides';

const memory = new Map<string, AnnotationOverride>();
let hydratedFromDisk = false;
/** Frozen snapshot for useSyncExternalStore; identity changes only on writes. */
let snapshot: Readonly<Record<string, AnnotationOverride>> = Object.freeze({});
const listeners = new Set<() => void>();

function overridesEnabled(): boolean {
  return readSettings().draftPersistence;
}

function readAllStored(): Record<string, AnnotationOverride> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, AnnotationOverride> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const override: AnnotationOverride = {
        comment: typeof record['comment'] === 'string' ? record['comment'] : undefined,
        deleted: record['deleted'] === true ? true : undefined,
      };
      if (override.comment !== undefined || override.deleted !== undefined) {
        Object.defineProperty(result, id, { value: override, enumerable: true, configurable: true, writable: true });
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistAll(): void {
  if (!overridesEnabled()) return;
  const all = Object.fromEntries(memory);
  try {
    if (memory.size === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // storage full / unavailable — overrides are a convenience
  }
}

function rebuildSnapshot(): void {
  snapshot = Object.freeze(Object.fromEntries(memory));
}

function hydrateFromDiskIfNeeded(): void {
  if (hydratedFromDisk) return;
  hydratedFromDisk = true;
  if (!overridesEnabled()) return;
  for (const [id, override] of Object.entries(readAllStored())) memory.set(id, override);
  rebuildSnapshot();
}

/** Current overrides as one frozen object (stable identity between writes). */
export function getAnnotationOverridesSnapshot(): Readonly<Record<string, AnnotationOverride>> {
  hydrateFromDiskIfNeeded();
  return snapshot;
}

/**
 * Write (or clear, with `null`) one annotation's local overlay. Patches merge:
 * editing a comment keeps a prior deletion flag from silently resurrecting —
 * though the UI never produces that combination, the store stays total.
 */
export function writeAnnotationOverride(id: string, override: AnnotationOverride | null): void {
  hydrateFromDiskIfNeeded();
  if (override === null || (override.comment === undefined && override.deleted === undefined)) {
    memory.delete(id);
  } else {
    memory.set(id, override);
  }
  persistAll();
  rebuildSnapshot();
  for (const listener of listeners) listener();
}

/** Subscribe to override writes; returns the unsubscribe. */
export function subscribeAnnotationOverrides(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget this-process memory as if the module were freshly imported. */
export function resetAnnotationOverridesForTests(): void {
  memory.clear();
  hydratedFromDisk = false;
  snapshot = Object.freeze({});
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

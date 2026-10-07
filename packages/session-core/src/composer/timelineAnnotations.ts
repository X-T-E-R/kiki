/**
 * Timeline annotations derive from explicit selection presentation spans.
 * Source anchors bind a particular message version and rendered occurrence;
 * unanchored generated quotes mark only an unambiguous preceding message.
 * User-authored quote-shaped text without metadata remains ordinary text.
 *
 * Source marks and sent-note bubbles share an editable presentation overlay,
 * keyed by the carrying message identity, segment order, quote, and comment.
 * Overrides persist with composer drafts but never change the sent prompt.
 */

import { readSettings } from '../settings/settings';
import { spaceStorage } from '../storage/spaceStorage';
import { projectPresentedText } from '@kiki/transcript';
import { sourceTextVersion, type SelectionSourceAnchor } from './selectionQuote';

/** One derived timeline marker; `comment: null` is a plain quote (no comment). */
export interface TimelineAnnotation {
  /** Stable segment id shared by the local echo and canonical history. */
  readonly id: string;
  /** The selected source text (newlines normalized, line ends trimmed). */
  readonly quote: string;
  readonly comment: string | null;
  readonly source?: SelectionSourceAnchor | null;
}

/** The minimal block shape the derivation needs — structural on purpose. */
export interface TimelineBlockLike {
  readonly id: string;
  readonly kind: string;
  readonly text?: string;
  readonly presentation?: import('@kiki/transcript').TextPresentation;
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
  readonly annotations: readonly { quote: string; comment: string; source?: SelectionSourceAnchor | null }[];
  readonly quote: string | null;
  readonly quoteSource?: SelectionSourceAnchor | null;
  /** The typed remainder after the carry-over prefix. */
  readonly body: string;
}

/**
 * Read generated selection objects and project their marked raw-text spans.
 * Comments may contain multiple lines; text without presentation is unchanged.
 */
export function parseSelectionCarryovers(text: string, presentation?: import('@kiki/transcript').TextPresentation): SelectionCarryovers {
  const selections = presentation?.spans.filter((span) => span.kind === 'selection' && span.quote !== undefined) ?? [];
  const annotations = selections.flatMap((span) => span.comment === undefined ? [] : [{ quote: span.quote!, comment: span.comment, source: span.source }]);
  const quoted = selections.find((span) => span.comment === undefined);
  return { annotations, quote: quoted?.quote ?? null, quoteSource: quoted?.source, body: projectPresentedText(text, presentation) };
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

/** Resolve an explicit source, or a unique legacy quote; ambiguity draws nothing. */
function annotationSource(
  blocks: readonly TimelineBlockLike[],
  quote: string,
  source?: SelectionSourceAnchor | null,
): TimelineBlockLike | undefined {
  if (quote.trim() === '' || source === null) return undefined;
  const candidates = blocks.filter((block) => ANCHORABLE_KINDS.has(block.kind) && block.text !== undefined);
  if (source !== undefined) {
    return candidates.find((block) => block.id === source.blockId && sourceTextVersion(block.text!) === source.version);
  }
  const matches = candidates.filter((block) => findQuoteRange(block.text!, quote) !== null);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Sent markers derive from the same carrying text in local echoes and cold history. */
export function collectTimelineAnnotations(
  blocks: readonly TimelineBlockLike[],
): ReadonlyMap<string, readonly TimelineAnnotation[]> {
  const targets = new Map<string, TimelineAnnotation[]>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined || block.kind !== 'user' || block.text === undefined) continue;
    const carry = parseSelectionCarryovers(block.text, block.presentation);
    const segments: readonly { quote: string; comment: string | null; source?: SelectionSourceAnchor | null }[] = [
      ...carry.annotations,
      ...(carry.quote !== null ? [{ quote: carry.quote, comment: null, source: carry.quoteSource }] : []),
    ];
    for (const [ordinal, segment] of segments.entries()) {
      const candidate = annotationSource(blocks.slice(0, index), segment.quote, segment.source);
      if (candidate === undefined) continue;
      const base = { id: annotationOverrideId(segment.quote, segment.comment ?? '', block.id, ordinal), quote: segment.quote, comment: segment.comment };
      const annotation = segment.source === undefined ? base : { ...base, source: segment.source };
      targets.set(candidate.id, [...(targets.get(candidate.id) ?? []), annotation]);
    }
  }
  return targets;
}

/** Draft markers keep their own ids so edits return to the composer. */
export function collectDraftAnnotationTargets(
  blocks: readonly TimelineBlockLike[],
  drafts: readonly TimelineAnnotation[],
): ReadonlyMap<string, readonly TimelineAnnotation[]> {
  const targets = new Map<string, TimelineAnnotation[]>();
  for (const draft of drafts) {
    const candidate = annotationSource(blocks, draft.quote, draft.source);
    if (candidate === undefined) continue;
    targets.set(candidate.id, [...(targets.get(candidate.id) ?? []), draft]);
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
    const raw = spaceStorage.getItem(STORAGE_KEY);
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
    if (memory.size === 0) spaceStorage.removeItem(STORAGE_KEY);
    else spaceStorage.setItem(STORAGE_KEY, JSON.stringify(all));
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
    spaceStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

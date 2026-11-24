/**
 * Imperative DOM annotation mark reconciler for rendered Markdown blocks.
 *
 * Applies `<mark data-annotation-ref>` and the trailing monochrome SVG speech
 * bubble directly onto the rendered DOM without remounting Streamdown or
 * re-parsing Markdown. Uses the exact same text-node ignore selector as
 * `selectionSourceAnchor` so captured canonical offsets align 1:1.
 */

import type { TimelineAnnotation } from '@kiki/session-core/composer';

import {
  ANNOTATION_BUBBLE_CLASS,
  ANNOTATION_MARK_CLASS,
  resolveMarkRanges,
  type MarkRange,
} from './annotationMarks';

const DOM_MARK_ATTR = 'data-kiki-dom-mark';
const DOM_BUBBLE_ATTR = 'data-kiki-dom-bubble';
const SVG_NS = 'http://www.w3.org/2000/svg';
const BUBBLE_PATH_D =
  'M3 3.5h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H8.2L5 13.8v-2.3H3c-.6 0-1-.4-1-1v-6c0-.6.4-1 1-1z';

const markedRoots = new Set<HTMLElement>();
const codeBlockBodiesByCode = new Map<string, Set<HTMLElement>>();
const highlightedCodeBodies = new WeakSet<HTMLElement>();
const pendingRefocusByRoot = new WeakMap<HTMLElement, string>();

function owningMarkedRoot(container: ParentNode): HTMLElement | null {
  if (container instanceof HTMLElement && markedRoots.has(container)) return container;
  for (const root of markedRoots) {
    if (root.contains(container)) return root;
  }
  return null;
}

function captureFocusedMarkBeforeUnwrap(container: ParentNode): void {
  const doc = container.ownerDocument;
  const active = doc?.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return;
  const annotationId = active.closest<HTMLElement>('[data-annotation-ref]')?.getAttribute('data-annotation-ref');
  if (annotationId === undefined || annotationId === null) return;
  const owner = owningMarkedRoot(container);
  if (owner !== null) pendingRefocusByRoot.set(owner, annotationId);
}

function hasShikiHighlightedTokens(body: HTMLElement): boolean {
  return body.querySelector('code span[style]') !== null;
}

/** Structural mark signature; intentionally omits `comment` because marks never render comment prose. */
export function annotationMarkSignature(
  targets: readonly TimelineAnnotation[] | undefined,
): string {
  if (targets === undefined || targets.length === 0) return '';
  let result = '';
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    if (index > 0) result += '\x1f';
    const source = target.source;
    if (source === undefined) {
      result += `${target.id}\0${target.quote}\0u`;
    } else if (source === null) {
      result += `${target.id}\0${target.quote}\0n`;
    } else {
      result += `${target.id}\0${target.quote}\0${source.blockId}:${source.version}:${source.start}:${source.end}:${source.text}`;
    }
  }
  return result;
}

/** Remove all DOM-injected annotation marks and bubbles inside `container`, merging split text nodes back. */
export function unwrapDomAnnotationMarks(container: ParentNode): boolean {
  const bubbles = container.querySelectorAll(`[${DOM_BUBBLE_ATTR}]`);
  const marks = container.querySelectorAll(`mark[${DOM_MARK_ATTR}]`);
  if (bubbles.length === 0 && marks.length === 0) return false;
  captureFocusedMarkBeforeUnwrap(container);
  for (let index = 0; index < bubbles.length; index += 1) {
    bubbles[index]!.remove();
  }
  const touchedParents = new Set<Node>();
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index]!;
    const parent = mark.parentNode;
    if (parent === null) continue;
    touchedParents.add(parent);
    while (mark.firstChild !== null) {
      parent.insertBefore(mark.firstChild, mark);
    }
    mark.remove();
  }
  for (const parent of touchedParents) {
    parent.normalize();
  }
  return true;
}

/** Register a live code-block body waiting on Shiki so async highlighting only unwraps its own matching body. */
export function registerCodeBlockBody(code: string, body: HTMLElement): () => void {
  highlightedCodeBodies.delete(body);
  let set = codeBlockBodiesByCode.get(code);
  if (set === undefined) {
    set = new Set<HTMLElement>();
    codeBlockBodiesByCode.set(code, set);
  }
  set.add(body);
  return () => {
    highlightedCodeBodies.delete(body);
    const current = codeBlockBodiesByCode.get(code);
    if (current === undefined) return;
    current.delete(body);
    if (current.size === 0) codeBlockBodiesByCode.delete(code);
  };
}

/**
 * Unwrap DOM marks inside code blocks before async Shiki highlighting reconciles `<code>` children.
 * When `code` is supplied, only matching unhighlighted `.kiki-cb-body` elements are touched so
 * sibling timelines (e.g. main beside a newly opened subagent) keep their marks and focus intact.
 */
export function unwrapDomMarksInCodeBlocks(code?: string, scopeRoot?: HTMLElement | null): void {
  if (scopeRoot === null) return;
  if (scopeRoot !== undefined) {
    if (!scopeRoot.isConnected) return;
    if (code !== undefined) {
      const bodies = codeBlockBodiesByCode.get(code);
      if (bodies !== undefined && bodies.size > 0) {
        let matched = false;
        for (const body of bodies) {
          if (!body.isConnected) {
            bodies.delete(body);
            highlightedCodeBodies.delete(body);
            continue;
          }
          if (!scopeRoot.contains(body)) continue;
          matched = true;
          if (highlightedCodeBodies.has(body) || hasShikiHighlightedTokens(body)) {
            highlightedCodeBodies.add(body);
            continue;
          }
          highlightedCodeBodies.add(body);
          unwrapDomAnnotationMarks(body);
        }
        if (bodies.size === 0) codeBlockBodiesByCode.delete(code);
        if (matched) return;
      }
    }
    const codeBodies = scopeRoot.querySelectorAll<HTMLElement>('.kiki-cb-body');
    for (let index = 0; index < codeBodies.length; index += 1) {
      const body = codeBodies[index]!;
      if (highlightedCodeBodies.has(body) || hasShikiHighlightedTokens(body)) {
        highlightedCodeBodies.add(body);
        continue;
      }
      if (code === undefined || (body.textContent ?? '').replace(/\n$/, '') === code) {
        highlightedCodeBodies.add(body);
        unwrapDomAnnotationMarks(body);
      }
    }
    return;
  }
  if (code !== undefined) {
    const bodies = codeBlockBodiesByCode.get(code);
    if (bodies === undefined || bodies.size === 0) return;
    for (const body of bodies) {
      if (!body.isConnected) {
        bodies.delete(body);
        highlightedCodeBodies.delete(body);
        continue;
      }
      if (highlightedCodeBodies.has(body) || hasShikiHighlightedTokens(body)) {
        highlightedCodeBodies.add(body);
        continue;
      }
      highlightedCodeBodies.add(body);
      unwrapDomAnnotationMarks(body);
    }
    if (bodies.size === 0) codeBlockBodiesByCode.delete(code);
    return;
  }
  if (markedRoots.size === 0) return;
  for (const root of markedRoots) {
    if (!root.isConnected) {
      markedRoots.delete(root);
      continue;
    }
    const codeBodies = root.querySelectorAll<HTMLElement>('.kiki-cb-body');
    for (let index = 0; index < codeBodies.length; index += 1) {
      unwrapDomAnnotationMarks(codeBodies[index]!);
    }
  }
}

export function unregisterMarkedRoot(root: HTMLElement): void {
  markedRoots.delete(root);
  pendingRefocusByRoot.delete(root);
}

function createMarkElement(
  doc: Document,
  annotationId: string,
  value: string,
  interactive: boolean,
): HTMLElement {
  const mark = doc.createElement('mark');
  mark.className = ANNOTATION_MARK_CLASS;
  mark.setAttribute('data-annotation-ref', annotationId);
  mark.setAttribute(DOM_MARK_ATTR, '');
  if (interactive) {
    mark.setAttribute('role', 'button');
    mark.setAttribute('tabindex', '0');
    mark.setAttribute('aria-haspopup', 'dialog');
  }
  mark.textContent = value;
  return mark;
}

function createBubbleElement(doc: Document, annotationId: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = ANNOTATION_BUBBLE_CLASS;
  span.setAttribute('data-annotation-ref', annotationId);
  span.setAttribute('data-annotation-bubble', '');
  span.setAttribute('data-source-ignore', 'true');
  span.setAttribute(DOM_BUBBLE_ATTR, '');
  span.setAttribute('aria-hidden', 'true');

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'h-3 w-3');

  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', BUBBLE_PATH_D);
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

function isEscapableInlineWrapper(element: Element): boolean {
  const tag = element.tagName;
  if (tag === 'A' || tag === 'KBD') return true;
  if (tag === 'CODE') {
    return element.parentElement?.tagName !== 'PRE';
  }
  return false;
}

function domBubbleEscapeTarget(textNode: Text, root: HTMLElement): Element | null {
  let target: Element | null = null;
  let current: Element | null = textNode.parentElement;
  while (current !== null && current !== root) {
    if (isEscapableInlineWrapper(current)) {
      target = current;
    } else if (target !== null) {
      break;
    }
    current = current.parentElement;
  }
  return target;
}

interface CollectedDomText {
  readonly node: Text;
  readonly value: string;
  readonly offset: number;
  readonly end: number;
}

function isIgnoredElement(element: Element): boolean {
  const tag = element.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BUTTON') return true;
  if (element.hasAttribute('data-source-ignore')) return true;
  if (element.classList.contains('kiki-cb-tools')) return true;
  if (element.getAttribute('data-streamdown') === 'code-block-header') return true;
  return false;
}

function collectDomTextNodes(root: HTMLElement): {
  readonly texts: CollectedDomText[];
  readonly fullText: string;
} {
  const texts: CollectedDomText[] = [];
  const chunks: string[] = [];
  let offset = 0;
  const visit = (parent: Node): void => {
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      const nodeType = child.nodeType;
      if (nodeType === 3) {
        const textNode = child as Text;
        const value = textNode.nodeValue;
        if (value !== null && value.length > 0) {
          texts.push({ node: textNode, value, offset, end: offset + value.length });
          chunks.push(value);
          offset += value.length;
        }
        continue;
      }
      if (nodeType === 1) {
        const element = child as Element;
        if (isIgnoredElement(element)) continue;
        visit(element);
        const omittedRaw = element.getAttribute('data-source-omitted-canonical-chars');
        if (omittedRaw !== null) {
          const omitted = Number(omittedRaw);
          if (Number.isSafeInteger(omitted) && omitted > 0) {
            chunks.push('\u0000'.repeat(omitted));
            offset += omitted;
          }
        }
      }
    }
  };
  visit(root);
  return { texts, fullText: chunks.join('') };
}

/**
 * Reconcile DOM marks inside `root` for `targets`. Returns true when at least
 * one DOM mark is currently mounted inside `root`.
 */
export function syncDomAnnotationMarks(
  root: HTMLElement,
  targets: readonly TimelineAnnotation[] | undefined,
): boolean {
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  const directFocusedId =
    active instanceof HTMLElement && root.contains(active)
      ? active.closest<HTMLElement>('[data-annotation-ref]')?.getAttribute('data-annotation-ref') ?? null
      : null;
  const pendingFocusedId =
    directFocusedId === null && (active === null || active === doc.body)
      ? pendingRefocusByRoot.get(root) ?? null
      : null;
  const focusedAnnotationId = directFocusedId ?? pendingFocusedId;
  pendingRefocusByRoot.delete(root);

  unwrapDomAnnotationMarks(root);
  pendingRefocusByRoot.delete(root);
  if (targets === undefined || targets.length === 0) {
    markedRoots.delete(root);
    return false;
  }

  const { texts, fullText } = collectDomTextNodes(root);
  if (texts.length === 0) {
    markedRoots.delete(root);
    return false;
  }

  const ranges = resolveMarkRanges(fullText, targets);
  if (ranges.length === 0) {
    markedRoots.delete(root);
    return false;
  }

  // Two-pointer sweep matches every non-whitespace text node against sorted,
  // non-overlapping ranges in O(texts + ranges) time.
  const hitsByTextIndex = new Map<number, MarkRange[]>();
  const firstTextIndexByAnnotation = new Map<string, number>();
  const lastTextIndexByAnnotation = new Map<string, number>();

  let rangeCursor = 0;
  for (let textIndex = 0; textIndex < texts.length; textIndex += 1) {
    const entry = texts[textIndex]!;
    while (rangeCursor < ranges.length && ranges[rangeCursor]!.end <= entry.offset) {
      rangeCursor += 1;
    }
    if (rangeCursor >= ranges.length) break;
    if (entry.value.trim() === '') continue;

    let r = rangeCursor;
    let hits: MarkRange[] | undefined;
    while (r < ranges.length && ranges[r]!.start < entry.end) {
      const range = ranges[r]!;
      if (hits === undefined) {
        hits = [];
        hitsByTextIndex.set(textIndex, hits);
      }
      hits.push(range);
      if (!firstTextIndexByAnnotation.has(range.annotationId)) {
        firstTextIndexByAnnotation.set(range.annotationId, textIndex);
      }
      lastTextIndexByAnnotation.set(range.annotationId, textIndex);
      if (range.end <= entry.end) {
        r += 1;
      } else {
        break;
      }
    }
  }

  if (hitsByTextIndex.size === 0) {
    markedRoots.delete(root);
    return false;
  }

  const escapedBubbles: Array<{ readonly target: Element; readonly bubble: HTMLElement }> = [];
  const hitIndices = [...hitsByTextIndex.keys()];

  for (let i = hitIndices.length - 1; i >= 0; i -= 1) {
    const textIndex = hitIndices[i]!;
    const entry = texts[textIndex]!;
    const parent = entry.node.parentNode;
    if (parent === null) continue;
    const hits = hitsByTextIndex.get(textIndex)!;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (let h = 0; h < hits.length; h += 1) {
      const range = hits[h]!;
      const start = Math.max(0, range.start - entry.offset);
      const end = Math.min(entry.value.length, range.end - entry.offset);
      if (start > cursor) {
        fragment.appendChild(doc.createTextNode(entry.value.slice(cursor, start)));
      }
      const interactive = firstTextIndexByAnnotation.get(range.annotationId) === textIndex;
      fragment.appendChild(
        createMarkElement(doc, range.annotationId, entry.value.slice(start, end), interactive),
      );
      if (lastTextIndexByAnnotation.get(range.annotationId) === textIndex) {
        const bubble = createBubbleElement(doc, range.annotationId);
        const escapeTarget = domBubbleEscapeTarget(entry.node, root);
        if (escapeTarget !== null) {
          escapedBubbles.push({ target: escapeTarget, bubble });
        } else {
          fragment.appendChild(bubble);
        }
      }
      cursor = end;
    }
    if (cursor < entry.value.length) {
      fragment.appendChild(doc.createTextNode(entry.value.slice(cursor)));
    }
    parent.replaceChild(fragment, entry.node);
  }

  for (let i = escapedBubbles.length - 1; i >= 0; i -= 1) {
    const { target, bubble } = escapedBubbles[i]!;
    const parent = target.parentNode;
    if (parent !== null) {
      parent.insertBefore(bubble, target.nextSibling);
    }
  }

  markedRoots.add(root);
  if (focusedAnnotationId !== null) {
    const focusTarget = [...root.querySelectorAll<HTMLElement>(`mark[${DOM_MARK_ATTR}][tabindex="0"]`)].find(
      (mark) => mark.getAttribute('data-annotation-ref') === focusedAnnotationId,
    );
    focusTarget?.focus({ preventScroll: true });
  }
  return true;
}

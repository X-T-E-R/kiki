/**
 * Annotation mark rendering — wraps the annotated passage of a message in a
 * `<mark data-annotation-ref>` so the transcript can style it and anchor the
 * reopen popover. Plain text is projected as JSX; Markdown is transformed at
 * the hast layer after Streamdown's default sanitize/harden plugins.
 */

import { Fragment, type ReactNode } from 'react';

import { anchoredSelectionRange, canonicalSelectionText, findQuoteRange, type TimelineAnnotation } from '@kiki/session-core/composer';

/** Shared mark styling: a quiet neutral wash plus a restrained underline. */
export const ANNOTATION_MARK_CLASS =
  'box-decoration-clone cursor-pointer rounded-[2px] bg-ink/[0.06] px-px [color:inherit] underline decoration-accent/45 decoration-1 underline-offset-[3px] outline-none transition-colors hover:bg-ink/[0.1] hover:decoration-accent/75 focus-visible:bg-ink/[0.1] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:ring-offset-1';

/**
 * Speech-bubble icon shown right after an annotated passage. Purely visual
 * discovery aid: the span carries the same `data-annotation-ref` as the mark
 * (the transcript's delegated click opens the same popover), but is
 * `aria-hidden` and not focusable — the mark itself stays the single keyboard
 * / screen-reader entry point for the annotation.
 */
export const ANNOTATION_BUBBLE_CLASS =
  'ml-0.5 inline-flex h-3 w-3 shrink-0 cursor-pointer select-none items-center justify-center align-middle text-accent/80 transition-colors hover:text-accent';

const ANNOTATION_BUBBLE_PATH_D =
  'M3 3.5h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H8.2L5 13.8v-2.3H3c-.6 0-1-.4-1-1v-6c0-.6.4-1 1-1z';

export interface MarkRange {
  readonly start: number;
  readonly end: number;
  readonly annotationId: string;
}

/** Locate every target quote, dropping unmatchable and overlapping ranges. */
export function resolveMarkRanges(
  text: string,
  targets: readonly TimelineAnnotation[],
): MarkRange[] {
  const found: MarkRange[] = [];
  for (const target of targets) {
    if (target.source !== undefined && target.source !== null && canonicalSelectionText(target.quote) !== target.source.text) continue;
    const range = target.source === null ? null : target.source === undefined
      ? findQuoteRange(text, target.quote) : anchoredSelectionRange(text, target.source);
    if (range !== null) {
      if (target.source === undefined && findQuoteRange(text.slice(range.end), target.quote) !== null) continue;
      found.push({ ...range, annotationId: target.id });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: MarkRange[] = [];
  let lastEnd = -1;
  for (const range of found) {
    if (range.start < lastEnd) continue;
    accepted.push(range);
    lastEnd = range.end;
  }
  return accepted;
}

/** The small monochrome SVG speech-bubble element shape (hast variant). */
function bubbleProperties(annotationId: string): Record<string, unknown> {
  return {
    className: ANNOTATION_BUBBLE_CLASS.split(' '),
    dataAnnotationRef: annotationId,
    dataAnnotationBubble: '',
    dataSourceIgnore: 'true',
    ariaHidden: true,
  };
}

function bubbleElement(annotationId: string): HastElementLike {
  return {
    type: 'element',
    tagName: 'span',
    properties: bubbleProperties(annotationId),
    children: [
      {
        type: 'element',
        tagName: 'svg',
        properties: {
          ariaHidden: true,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: ['h-3', 'w-3'],
        },
        children: [
          {
            type: 'element',
            tagName: 'path',
            properties: { d: ANNOTATION_BUBBLE_PATH_D },
            children: [],
          },
        ],
      },
    ],
  };
}

/**
 * Plain-text projection: marked ranges with the surrounding text passed
 * through `projectSegment` (the user bubble's `@chip` decorator rides along).
 * Each mark is followed by a small speech-bubble glyph carrying the same
 * `data-annotation-ref`, so the popover stays one click away from the bubble.
 */
export function projectTextWithAnnotationMarks(
  text: string,
  targets: readonly TimelineAnnotation[],
  projectSegment: (segment: string) => ReactNode = (segment) => segment,
): ReactNode {
  const ranges = resolveMarkRanges(text, targets);
  if (ranges.length === 0) return projectSegment(text);
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      parts.push(
        <Fragment key={`t-${index}`}>{projectSegment(text.slice(cursor, range.start))}</Fragment>,
      );
    }
    parts.push(
      <mark
        key={`m-${index}`}
        data-annotation-ref={range.annotationId}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        className={ANNOTATION_MARK_CLASS}
      >
        {projectSegment(text.slice(range.start, range.end))}
      </mark>,
      <span
        key={`b-${index}`}
        data-annotation-ref={range.annotationId}
        data-annotation-bubble=""
        data-source-ignore="true"
        aria-hidden="true"
        className={ANNOTATION_BUBBLE_CLASS}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3"
        >
          <path d={ANNOTATION_BUBBLE_PATH_D} />
        </svg>
      </span>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) {
    parts.push(<Fragment key="t-tail">{projectSegment(text.slice(cursor))}</Fragment>);
  }
  return <>{parts}</>;
}

interface HastTextLike {
  type: 'text';
  value: string;
}

interface HastElementLike {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNodeLike[];
}

interface HastRootLike {
  type: string;
  children?: HastNodeLike[];
}

type HastNodeLike = HastTextLike | HastElementLike | HastRootLike;

const SKIP_TAGS = new Set(['script', 'style']);

interface AncestorLink {
  readonly node: HastElementLike;
  readonly parent: HastElementLike | HastRootLike;
}

interface CollectedText {
  readonly node: HastTextLike;
  readonly parent: HastElementLike | HastRootLike;
  readonly childIndex: number;
  readonly offset: number;
  readonly ancestors: readonly AncestorLink[];
}

function collectTextNodes(root: HastRootLike): CollectedText[] {
  const collected: CollectedText[] = [];
  let offset = 0;
  const walk = (
    parent: HastRootLike | HastElementLike,
    skipping: boolean,
    ancestors: readonly AncestorLink[],
  ) => {
    parent.children?.forEach((child, childIndex) => {
      if (child.type === 'text') {
        if (!skipping) {
          collected.push({ node: child as HastTextLike, parent, childIndex, offset, ancestors });
          offset += (child as HastTextLike).value.length;
        }
        return;
      }
      const element = child as HastElementLike;
      walk(
        element,
        skipping || SKIP_TAGS.has(element.tagName),
        [...ancestors, { node: element, parent }],
      );
    });
  };
  walk(root, false, []);
  return collected;
}

function isEscapableInlineWrapper(link: AncestorLink): boolean {
  const tag = link.node.tagName;
  if (tag === 'a' || tag === 'kbd') return true;
  if (tag === 'code') {
    const parentTag = link.parent.type === 'element' ? (link.parent as HastElementLike).tagName : undefined;
    return parentTag !== 'pre';
  }
  return false;
}

function bubbleEscapeTarget(ancestors: readonly AncestorLink[]): AncestorLink | undefined {
  let target: AncestorLink | undefined;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const link = ancestors[i]!;
    if (isEscapableInlineWrapper(link)) {
      target = link;
    } else if (target !== undefined) {
      break;
    }
  }
  return target;
}

function markElement(
  annotationId: string,
  value: string,
  interactive: boolean,
): HastElementLike {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      className: ANNOTATION_MARK_CLASS.split(' '),
      dataAnnotationRef: annotationId,
      role: interactive ? 'button' : undefined,
      tabIndex: interactive ? 0 : undefined,
      ariaHasPopup: interactive ? 'dialog' : undefined,
    },
    children: [{ type: 'text', value }],
  };
}

/**
 * Rehype plugin pre-bound with a block's targets. Every intersected text node
 * is split around the match. When inline formatting splits one annotation into
 * several marks, only the first mark enters the keyboard tab order; the
 * speech-bubble glyph rides the last split node (the visual end of the
 * annotated passage).
 */
export function rehypeAnnotationMarks(targets: readonly TimelineAnnotation[]) {
  const attacher = function annotationMarksAttacher() {
    return function transform(tree: HastRootLike) {
      const texts = collectTextNodes(tree);
      const ranges = resolveMarkRanges(texts.map((entry) => entry.node.value).join(''), targets);
      const started = new Set<string>();
      for (const entry of texts.toReversed()) {
        if (entry.node.value.trim() === '') continue;
        const hits = ranges.filter((range) => entry.offset < range.end && entry.offset + entry.node.value.length > range.start);
        if (hits.length === 0) continue;
        const replacement: HastNodeLike[] = [];
        const escapedBubbles: Array<{ readonly target: AncestorLink; readonly bubble: HastElementLike }> = [];
        let cursor = 0;
        for (const range of hits) {
          const start = Math.max(0, range.start - entry.offset);
          const end = Math.min(entry.node.value.length, range.end - entry.offset);
          if (start > cursor) replacement.push({ type: 'text', value: entry.node.value.slice(cursor, start) });
          const first = !texts.some((other) => other.offset < entry.offset && other.offset + other.node.value.length > range.start);
          replacement.push(markElement(range.annotationId, entry.node.value.slice(start, end), first));
          if (!started.has(range.annotationId)) {
            started.add(range.annotationId);
            const bubble = bubbleElement(range.annotationId);
            const escapeTarget = bubbleEscapeTarget(entry.ancestors);
            if (escapeTarget !== undefined) {
              escapedBubbles.push({ target: escapeTarget, bubble });
            } else {
              replacement.push(bubble);
            }
          }
          cursor = end;
        }
        if (cursor < entry.node.value.length) replacement.push({ type: 'text', value: entry.node.value.slice(cursor) });
        entry.parent.children?.splice(entry.childIndex, 1, ...replacement);
        for (const { target, bubble } of escapedBubbles.toReversed()) {
          const siblings = target.parent.children;
          if (siblings === undefined) continue;
          const wrapperIndex = siblings.indexOf(target.node);
          if (wrapperIndex !== -1) siblings.splice(wrapperIndex + 1, 0, bubble);
        }
      }
    };
  };
  // Streamdown's processor cache keys plugins by function name, not identity.
  Object.defineProperty(attacher, 'name', { value: `annotationMarks:${JSON.stringify(targets)}` });
  return attacher;
}

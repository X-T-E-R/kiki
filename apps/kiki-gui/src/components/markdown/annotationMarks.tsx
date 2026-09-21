/**
 * Annotation mark rendering — wraps the annotated passage of a message in a
 * `<mark data-annotation-ref>` so the transcript can style it and anchor the
 * reopen popover. Plain text is projected as JSX; Markdown is transformed at
 * the hast layer after Streamdown's default sanitize/harden plugins.
 */

import { Fragment, type ReactNode } from 'react';

import { findQuoteRange, type TimelineAnnotation } from '@kiki/session-core/composer';

/** Shared mark styling: a quiet accent wash plus a restrained underline. */
export const ANNOTATION_MARK_CLASS =
  'box-decoration-clone cursor-pointer rounded-[2px] bg-accent-soft/80 px-px [color:inherit] underline decoration-accent/45 decoration-1 underline-offset-[3px] outline-none transition-colors hover:bg-accent-soft hover:decoration-accent/75 focus-visible:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1';

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
    const range = findQuoteRange(text, target.quote);
    if (range !== null) found.push({ ...range, annotationId: target.id });
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

/**
 * Plain-text projection: marked ranges with the surrounding text passed
 * through `projectSegment` (the user bubble's `@chip` decorator rides along).
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

const SKIP_TAGS = new Set(['pre', 'code', 'script', 'style', 'mark']);

interface CollectedText {
  readonly node: HastTextLike;
  readonly parent: HastElementLike | HastRootLike;
  readonly childIndex: number;
  readonly offset: number;
}

function collectTextNodes(root: HastRootLike): CollectedText[] {
  const collected: CollectedText[] = [];
  let offset = 0;
  const walk = (parent: HastRootLike | HastElementLike, skipping: boolean) => {
    parent.children?.forEach((child, childIndex) => {
      if (child.type === 'text') {
        if (!skipping) {
          collected.push({ node: child as HastTextLike, parent, childIndex, offset });
          offset += (child as HastTextLike).value.length;
        }
        return;
      }
      const element = child as HastElementLike;
      walk(element, skipping || SKIP_TAGS.has(element.tagName));
    });
  };
  walk(root, false);
  return collected;
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
 * several marks, only the first mark enters the keyboard tab order.
 */
export function rehypeAnnotationMarks(targets: readonly TimelineAnnotation[]) {
  return function annotationMarksAttacher() {
    return function transform(tree: HastRootLike) {
      for (const target of targets) {
        const texts = collectTextNodes(tree);
        if (texts.length === 0) return;
        const concatenated = texts.map((entry) => entry.node.value).join('');
        const range = findQuoteRange(concatenated, target.quote);
        if (range === null) continue;
        const intersected = texts.filter(
          (entry) =>
            entry.offset < range.end && entry.offset + entry.node.value.length > range.start,
        );
        const first = intersected[0];
        for (const entry of intersected.toReversed()) {
          const localStart = Math.max(0, range.start - entry.offset);
          const localEnd = Math.min(entry.node.value.length, range.end - entry.offset);
          const before = entry.node.value.slice(0, localStart);
          const middle = entry.node.value.slice(localStart, localEnd);
          const after = entry.node.value.slice(localEnd);
          if (middle === '') continue;
          const replacement: HastNodeLike[] = [];
          if (before !== '') replacement.push({ type: 'text', value: before });
          replacement.push(markElement(target.id, middle, entry === first));
          if (after !== '') replacement.push({ type: 'text', value: after });
          entry.parent.children?.splice(entry.childIndex, 1, ...replacement);
        }
      }
    };
  };
}
